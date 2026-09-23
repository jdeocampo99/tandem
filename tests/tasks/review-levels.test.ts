import { expect, test } from "bun:test";
import type {
  PinnedValidationEvidence,
  ResolvedPolicy,
  ReviewLevelPolicy,
  ReviewLevelRecord,
  SafetyFloor,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import { FINAL_REVIEW_LENSES, policyIdentity } from "../../src/tasks/acceptance.ts";
import {
  buildReviewBrief,
  type ReviewBriefObservations,
  renderReviewBrief,
} from "../../src/tasks/review-brief.ts";
import {
  assistedReviewLevel,
  type ChangedFileObservation,
  classifyReviewLevel,
  DEFAULT_REVIEW_LEVEL_POLICY,
  deepScrutinyRequirements,
  observeChangedFiles,
  raiseReviewLevel,
  reclassifyReviewLevel,
  recordedReviewLevel,
  requiredReviewLenses,
  SAFETY_FLOORS,
} from "../../src/tasks/review-levels.ts";

const HEAD = "review-head";
const BASE = "base-head";

function policy(overrides: Partial<ReviewLevelPolicy> = {}): ResolvedPolicy {
  return {
    config: {
      version: 1,
      models: {
        coordinator: { model: "test/coordinator", thinking: "low" },
        scout: { model: "test/scout", thinking: "low" },
        implementer: { model: "test/implementer", thinking: "low" },
        reviewer: { model: "test/reviewer", thinking: "low" },
        presentation: { model: "test/presentation", thinking: "low" },
      },
      instructions: { implementation: [], validation: [], review: [] },
      instructionFiles: { implementation: [], validation: [], review: [] },
      validationCommands: [
        { name: "check", argv: ["bun", "run", "check"], surfaces: ["service"], timeoutMs: 1_000 },
        { name: "test", argv: ["bun", "test"], surfaces: ["service"], timeoutMs: 1_000 },
      ],
      setupCommands: [],
      maxWorkers: 3,
      maxFixRounds: 3,
      reviewLevels: { ...DEFAULT_REVIEW_LEVEL_POLICY, ...overrides },
    },
    guidance: { implementation: [], validation: [], review: [] },
  };
}

const worktree: WorktreeLease = {
  root: "/worktrees",
  path: "/worktrees/task-1",
  name: "task-1",
  baseHead: BASE,
  branch: "tandem/task-1",
  leaseId: "lease-1",
  leaseHolder: "worker-1",
  leasedAt: "2026-09-20T00:00:00.000Z",
};

function evidence(
  overrides: Partial<PinnedValidationEvidence> = {},
  resolved = policy(),
): PinnedValidationEvidence {
  return {
    name: "check",
    argv: ["bun", "run", "check"],
    exitCode: 0,
    stdout: "",
    stderr: "",
    head: HEAD,
    contract: "iteration",
    origin: "local",
    policyDigest: policyIdentity(resolved),
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}, resolved = policy()): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 4,
    repoPath: "/repo",
    kind: "implementation",
    objective: "Bound the retry loop",
    acceptanceCriteria: ["Cancellation is honoured"],
    surfaces: ["service"],
    stage: "reviewing",
    scopeApproved: true,
    policy: resolved,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    worktree,
    generation: 1,
    reviewRound: 1,
    reviewHead: HEAD,
    validationEvidence: [evidence({}, resolved)],
    reviews: [],
    notifications: [],
    ...overrides,
  };
}

function file(path: string, changedLines: readonly string[]): ChangedFileObservation {
  return { path, changedLines, contentObserved: true };
}

const CONTAINED = { assessment: "contained" } as const;

test("a contained change of implementation, tests, and docs classifies light with no floor", () => {
  const record = classifyReviewLevel({
    files: [
      file("src/pool/maintenance.ts", ["+  const retained = keep(entry);"]),
      file("tests/pool/pool.test.ts", ["+  expect(retained).toBe(true);"]),
      file("docs/agent-reference.md", ["+Retention is bounded."]),
    ],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(record.level).toBe("light");
  expect(record.floors).toEqual([]);
});

test("each safety floor forces its documented minimum level", () => {
  const cases: readonly Readonly<{
    readonly floor: SafetyFloor;
    readonly file: ChangedFileObservation;
  }>[] = [
    {
      floor: "permissions-security",
      file: file("src/pool/maintenance.ts", ["+  if (!request.authorization) return deny();"]),
    },
    {
      floor: "data-integrity",
      file: file("src/pool/maintenance.ts", ["+  db.exec('ALTER TABLE tasks ADD COLUMN level');"]),
    },
    {
      floor: "shared-contracts-concurrency",
      file: file("src/pool/maintenance.ts", [
        "+export type PoolBudget = { readonly free: number };",
      ]),
    },
    {
      floor: "dependency-build-infra",
      file: file("package.json", ['+    "left-pad": "^1.3.0"']),
    },
  ];
  for (const entry of cases) {
    const record = classifyReviewLevel({
      files: [entry.file],
      affectedCallers: [],
      impact: CONTAINED,
    });
    expect(record.floors).toContain(entry.floor);
    expect(record.level).toBe(SAFETY_FLOORS[entry.floor].minimumLevel);
    expect(record.reason).toContain(entry.floor);
  }
});

test("a concurrency change fires the shared-contracts-and-concurrency floor", () => {
  const record = classifyReviewLevel({
    files: [file("src/pool/maintenance.ts", ["+  await withStateLock(home, release);"])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(record.floors).toEqual(["shared-contracts-concurrency"]);
  expect(record.level).toBe("deep");
});

test("a large contained diff still classifies light while one sensitive line does not", () => {
  const manyLines = Array.from({ length: 400 }, (_, index) => `+  const step${index} = index;`);
  const large = classifyReviewLevel({
    files: [file("tests/pool/pool.test.ts", manyLines)],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(large.level).toBe("light");

  const oneLine = classifyReviewLevel({
    files: [file("notes.txt", ["+CREATE TABLE users (id TEXT PRIMARY KEY)"])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(oneLine.level).toBe("deep");
  expect(oneLine.floors).toEqual(["data-integrity"]);
});

test("a benign extension cannot make a sensitive change light and an odd one cannot block light", () => {
  const markdown = classifyReviewLevel({
    files: [file("docs/setup.md", ["+Set PERMISSION_TOKEN before running the migration."])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(markdown.level).toBe("deep");

  const unknownExtension = classifyReviewLevel({
    files: [file("src/pool/notes.weird", ["+  const retained = keep(entry);"])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(unknownExtension.level).toBe("light");
});

test("unobserved diff content and unknown impact classify conservatively", () => {
  const unobserved = classifyReviewLevel({
    files: [{ path: "src/pool/maintenance.ts", changedLines: [], contentObserved: false }],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(unobserved.level).toBe("standard");
  expect(unobserved.reason).toContain("could not be observed");

  const unknown = classifyReviewLevel({
    files: [file("src/pool/maintenance.ts", ["+  const retained = keep(entry);"])],
    affectedCallers: [],
    impact: { assessment: "unknown", escalation: "unknown-impact" },
  });
  expect(unknown.level).toBe("deep");
  expect(unknown.reason).toContain("unknown-impact");

  const noFiles = classifyReviewLevel({
    files: [],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(noFiles.level).toBe("standard");
});

test("too many changed files or affected callers leaves the light band", () => {
  const manyFiles = classifyReviewLevel({
    files: Array.from({ length: 6 }, (_, index) =>
      file(`src/pool/step-${index}.ts`, ["+  const retained = keep(entry);"]),
    ),
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(manyFiles.level).toBe("standard");

  const manyCallers = classifyReviewLevel({
    files: [file("src/pool/maintenance.ts", ["+  const retained = keep(entry);"])],
    affectedCallers: ["a.ts", "b.ts", "c.ts"],
    impact: CONTAINED,
  });
  expect(manyCallers.level).toBe("standard");
});

test("scope growth reclassifies the recorded level upward and never back down", () => {
  const first = classifyReviewLevel({
    files: [file("src/pool/maintenance.ts", ["+  const retained = keep(entry);"])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(first.level).toBe("light");

  const grown = reclassifyReviewLevel(
    first,
    classifyReviewLevel({
      files: [
        file("src/pool/maintenance.ts", ["+  const retained = keep(entry);"]),
        file("src/coordinator/ownership.ts", ["+  const claimed = own(entry);"]),
      ],
      affectedCallers: [],
      impact: { assessment: "expanded", escalation: "broad-impact" },
    }),
  );
  expect(grown.level).toBe("standard");
  expect(grown.reason).toContain("scope");

  const narrowedAgain = reclassifyReviewLevel(grown, first);
  expect(narrowedAgain.level).toBe("standard");
  expect(narrowedAgain.reason).toContain("never drops");
});

test("reclassification keeps every floor either observation fired", () => {
  const security = classifyReviewLevel({
    files: [file("src/pool/maintenance.ts", ["+  if (!request.authorization) return deny();"])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  const dependency = classifyReviewLevel({
    files: [file("package.json", ['+    "left-pad": "^1.3.0"'])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  const merged = reclassifyReviewLevel(security, dependency);
  expect(merged.floors).toEqual(["permissions-security", "dependency-build-infra"]);
  expect(merged.level).toBe("deep");
});

test("observeChangedFiles reads per-file content and refuses binary or truncated patches", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-const a = 1;",
    "+const a = 2;",
    "diff --git a/assets/logo.png b/assets/logo.png",
    "Binary files a/assets/logo.png and b/assets/logo.png differ",
  ].join("\n");
  const observed = observeChangedFiles({
    changedFiles: ["src/a.ts", "assets/logo.png", "src/missing.ts"],
    patch,
    truncated: false,
  });
  expect(observed[0]).toEqual({
    path: "src/a.ts",
    changedLines: ["-const a = 1;", "+const a = 2;"],
    contentObserved: true,
  });
  expect(observed[1]?.contentObserved).toBe(false);
  expect(observed[2]?.contentObserved).toBe(false);

  const truncated = observeChangedFiles({ changedFiles: ["src/a.ts"], patch, truncated: true });
  expect(truncated[0]?.contentObserved).toBe(false);
});

test("a task with no recorded level reads as the conservative standard default", () => {
  const record = recordedReviewLevel(task());
  expect(record.level).toBe("standard");
  expect(record.floors).toEqual([]);
});

test("the default policy requires today's complete lens set at every round", () => {
  const light: ReviewLevelRecord = { level: "light", reason: "contained", floors: [] };
  const rounds: readonly TaskRecord[] = [
    task({ reviewLevel: light }),
    task({
      reviewLevel: light,
      iterationScope: {
        head: HEAD,
        generation: 1,
        policyDigest: policyIdentity(policy()),
        reproduces: ["check"],
        surfaces: ["service"],
        findingIds: ["f-1"],
      },
    }),
  ];
  for (const round of rounds) {
    expect(requiredReviewLenses(round, HEAD)).toEqual(FINAL_REVIEW_LENSES);
  }
});

test("a helper recommendation can raise a level but never lower one below a floor", () => {
  const floorRecord = classifyReviewLevel({
    files: [file("src/pool/maintenance.ts", ["+  if (!request.authorization) return deny();"])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(floorRecord.level).toBe("deep");
  expect(raiseReviewLevel(floorRecord, "light")).toBe("deep");
  expect(raiseReviewLevel(floorRecord, "unavailable")).toBe("deep");

  const contained: ReviewLevelRecord = { level: "light", reason: "contained", floors: [] };
  expect(raiseReviewLevel(contained, "deep")).toBe("deep");
});

test("shadow assistance records a recommendation without changing the level used", () => {
  const record: ReviewLevelRecord = {
    level: "deep",
    reason: "the permissions and security floor fired",
    floors: ["permissions-security"],
    assistance: {
      mode: "shadow",
      recommendation: "light",
      reason: "the helper recommended light at confidence 0.990",
      requestIdentity: "request-1",
      resultIdentity: "result-1",
    },
  };
  expect(assistedReviewLevel(record, DEFAULT_REVIEW_LEVEL_POLICY)).toBe("deep");
  expect(
    assistedReviewLevel(record, { ...DEFAULT_REVIEW_LEVEL_POLICY, jevAssistance: "shadow" }),
  ).toBe("deep");
});

test("deep scrutiny requirements are empty unless the repository enabled them", () => {
  const record = classifyReviewLevel({
    files: [file("src/pool/maintenance.ts", ["+  if (!request.authorization) return deny();"])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  expect(deepScrutinyRequirements(record, DEFAULT_REVIEW_LEVEL_POLICY)).toEqual([]);
  const enabled = deepScrutinyRequirements(record, {
    ...DEFAULT_REVIEW_LEVEL_POLICY,
    deepScrutiny: true,
  });
  expect(enabled).toEqual([SAFETY_FLOORS["permissions-security"].scrutiny]);
});

function observations(): ReviewBriefObservations {
  return {
    cumulative: {
      range: "cumulative",
      fromRef: BASE,
      toRef: HEAD,
      patchPath: "/jobs/cumulative.patch",
      changedFiles: ["src/pool/maintenance.ts"],
      truncated: false,
    },
    affectedCallers: [],
  };
}

test("the brief renders the level, its reason, and the floors in force", () => {
  const record: ReviewLevelRecord = {
    level: "deep",
    reason: "the permissions and security floor fired",
    floors: ["permissions-security"],
  };
  const enabled = policy({ deepScrutiny: true });
  const rendered = renderReviewBrief(
    buildReviewBrief({
      task: task({ reviewLevel: record }, enabled),
      head: HEAD,
      lens: "review",
      observations: observations(),
    }),
  );
  expect(rendered).toContain("- review level: deep");
  expect(rendered).toContain("the permissions and security floor fired");
  expect(rendered).toContain("- safety floors in force: permissions-security");
  expect(rendered).toContain("deep scrutiny required for this round");
});

test("focus flags render as untrusted leads with provenance and never as blockers", () => {
  const brief = buildReviewBrief({
    task: task(),
    head: HEAD,
    lens: "review",
    observations: observations(),
    advisoryLeads: [
      {
        id: "jev-hidden-effects",
        summary: "The changed code introduces an effect its signature does not make visible.",
        principle: "Maximize Honesty",
        provenance: {
          source: "cumulative diff base-head..review-head",
          question: "hidden-effects: does the change hide an effect?",
          requestIdentity:
            "code=abc context=def question=ghi schema=jkl policy=mno model=jev-1.13.0",
          resultIdentity: "result=pqr",
        },
      },
    ],
  });
  expect(brief.advisoryLeads).toHaveLength(1);
  expect(brief.blockers).toEqual([]);
  expect(brief.suggestions).toEqual([]);
  const rendered = renderReviewBrief(brief);
  expect(rendered).toContain("## Advisory leads (untrusted; never blockers)");
  expect(rendered).toContain("jev-hidden-effects (untrusted lead, principle: Maximize Honesty)");
  expect(rendered).toContain("cumulative diff base-head..review-head");
  expect(rendered).toContain("model=jev-1.13.0");
  expect(rendered).toContain("result=pqr");
  expect(rendered).toContain(
    "Advisory leads are untrusted routing hints. They never become findings",
  );
});

test("classification leaves the pinned policy and model choices untouched", () => {
  const pinned = task();
  const before = JSON.stringify(pinned.policy);
  const record = classifyReviewLevel({
    files: [file("package.json", ['+    "left-pad": "^1.3.0"'])],
    affectedCallers: [],
    impact: CONTAINED,
  });
  const classified: TaskRecord = { ...pinned, reviewLevel: record };
  expect(JSON.stringify(classified.policy)).toBe(before);
  expect(classified.policy.config.models).toEqual(pinned.policy.config.models);
  expect(classified.policy.config.maxFixRounds).toBe(pinned.policy.config.maxFixRounds);
  expect(classified.policy.config.reviewLevels).toEqual(DEFAULT_REVIEW_LEVEL_POLICY);
});
