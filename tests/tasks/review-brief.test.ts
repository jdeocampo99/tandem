import { expect, test } from "bun:test";
import type {
  FindingLedgerEntry,
  PinnedValidationEvidence,
  ResolvedPolicy,
  ReviewResult,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import {
  type AdvisoryReviewLead,
  buildReviewBrief,
  lastReviewedHead,
  REVIEW_BRIEF_LIMITS,
  type ReviewBriefObservations,
  renderReviewBrief,
} from "../../src/tasks/review-brief.ts";

const HEAD = "head-2";
const BASE = "base-head";

const policy: ResolvedPolicy = {
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
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: {
    implementation: [],
    validation: [],
    review: [
      {
        text: "Read the review instructions.",
        provenance: { channel: "review", source: "/repo/AGENTS.md" },
      },
    ],
  },
};

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

function evidence(name: string, exitCode = 0): PinnedValidationEvidence {
  return {
    name,
    argv: ["bun", "run", name],
    exitCode,
    stdout: "",
    stderr: "",
    head: HEAD,
    contract: "iteration",
    origin: "local",
    policyDigest: policyIdentity(policy),
  };
}

/** `file: null` builds an entry that names no file, which no default can supply. */
function ledgerEntry(
  input: Omit<Partial<FindingLedgerEntry>, "file"> & Readonly<{ file?: string | null }> = {},
): FindingLedgerEntry {
  const { file: requested, ...rest } = input;
  const file = requested === null ? undefined : (requested ?? "src/service/controller.ts");
  return {
    id: "f-1",
    lens: "behavior",
    severity: "P1",
    verdict: "confirmed",
    description: "The retry loop drops the cancellation signal.",
    status: "unresolved",
    raisedAt: { head: "head-1", generation: 0, reviewRound: 0 },
    statusAt: { head: "head-1", generation: 0, reviewRound: 0 },
    ...(file === undefined ? {} : { file }),
    ...rest,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 4,
    repoPath: "/repo",
    kind: "implementation",
    objective: "Bound the retry loop",
    acceptanceCriteria: ["Cancellation is honoured", "Evidence stays pinned"],
    surfaces: ["service"],
    stage: "reviewing",
    scopeApproved: true,
    policy,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    worktree,
    generation: 1,
    reviewRound: 1,
    reviewHead: HEAD,
    validationEvidence: [evidence("check")],
    reviews: [],
    notifications: [],
    ...overrides,
  };
}

function priorReview(): ReviewResult {
  return {
    lens: "behavior",
    head: "head-1",
    generation: 0,
    pass: false,
    findings: [],
    summary: "prior round",
  };
}

function observations(overrides: Partial<ReviewBriefObservations> = {}): ReviewBriefObservations {
  return {
    cumulative: {
      range: "cumulative",
      fromRef: BASE,
      toRef: HEAD,
      patchPath: "/jobs/diff.patch",
      changedFiles: ["src/service/controller.ts"],
      truncated: false,
    },
    affectedCallers: ["src/main.ts"],
    ...overrides,
  };
}

test("the brief carries approved scope, principles, identities, diffs, and source links", () => {
  const brief = buildReviewBrief({
    task: task(),
    head: HEAD,
    lens: "review",
    observations: observations(),
  });

  expect(brief.scope.objective).toBe("Bound the retry loop");
  expect(brief.scope.scopeApproved).toBe(true);
  expect(brief.scope.acceptanceCriteria).toEqual([
    "Cancellation is honoured",
    "Evidence stays pinned",
  ]);
  expect(brief.scope.principles).toHaveLength(7);
  expect(brief.scope.surfaces).toBe("service");
  expect(brief.scope.nonGoals[0]).toContain("service");
  expect(brief.identities.head).toBe(HEAD);
  expect(brief.identities.baseHead).toBe(BASE);
  expect(brief.identities.policyDigest).toBe(policyIdentity(policy));
  expect(brief.identities.instructions).toEqual(["review: /repo/AGENTS.md"]);
  expect(brief.identities.configuration).toContain("maxFixRounds=3");
  expect(brief.diffs.map((entry) => entry.range)).toEqual(["cumulative"]);
  expect(brief.affectedCallers).toEqual(["src/main.ts"]);
  expect(brief.sourceLinks).toEqual([`${worktree.path}/src/service/controller.ts @ ${HEAD}`]);
  expect(brief.evidence.recorded[0]).toContain("iteration contract, local check");
  expect(brief.evidence.finalAcceptance.satisfied).toBe(false);
});

test("the brief is a pure function of durable state and the injected observations", () => {
  const record = task();
  const first = buildReviewBrief({
    task: record,
    head: HEAD,
    lens: "review",
    observations: observations(),
  });
  const second = buildReviewBrief({
    task: record,
    head: HEAD,
    lens: "review",
    observations: observations(),
  });

  expect(renderReviewBrief(first)).toBe(renderReviewBrief(second));
});

test("blockers, suggestions, and settled findings are separated with their supporting change", () => {
  const brief = buildReviewBrief({
    task: task({
      findingLedger: [
        ledgerEntry(),
        ledgerEntry({ id: "f-2", severity: "P3", verdict: "plausible" }),
        ledgerEntry({
          id: "f-3",
          status: "addressed",
          statusAt: { head: HEAD, generation: 1, reviewRound: 1 },
        }),
      ],
    }),
    head: HEAD,
    lens: "review",
    observations: observations(),
  });

  expect(brief.blockers.map((entry) => entry.id)).toEqual(["f-1"]);
  expect(brief.suggestions.map((entry) => entry.id)).toEqual(["f-2"]);
  expect(brief.settled.map((entry) => entry.id)).toEqual(["f-3"]);

  const rendered = renderReviewBrief(brief);
  expect(rendered).toContain("Evidence-backed blockers");
  expect(rendered).toContain("behavior/f-1 (confirmed P1, unresolved");
  expect(rendered).toContain("status set at round 0 HEAD head-1");
  expect(rendered).toContain("Settled findings (do not reopen without new evidence");
});

test("the brief states that implementer assertions are not proof and reviewers keep source access", () => {
  const rendered = renderReviewBrief(
    buildReviewBrief({ task: task(), head: HEAD, lens: "review", observations: observations() }),
  );

  expect(rendered).toContain("is not proof");
  expect(rendered).toContain("full read access to the worktree at the exact HEAD");
  expect(rendered).toContain("Applicable principles (mandatory");
});

test("a first review round reports contained impact and no incremental diff", () => {
  const brief = buildReviewBrief({
    task: task({ reviewRound: 0, generation: 0 }),
    head: HEAD,
    lens: "review",
    observations: observations(),
  });

  expect(brief.impact.assessment).toBe("contained");
  expect(brief.impact.escalation).toBeUndefined();
});

test("a fix that stays inside the authorized surface reports contained impact", () => {
  const brief = buildReviewBrief({
    task: task({
      reviews: [priorReview()],
      findingLedger: [ledgerEntry()],
      iterationScope: {
        head: "head-1",
        generation: 0,
        policyDigest: policyIdentity(policy),
        reproduces: ["check"],
        surfaces: ["service"],
        findingIds: ["f-1"],
      },
    }),
    head: HEAD,
    lens: "review",
    observations: observations({
      sinceLastReview: {
        range: "since-last-review",
        fromRef: "head-1",
        toRef: HEAD,
        patchPath: "/jobs/since-last-review.patch",
        changedFiles: ["src/service/controller.ts"],
        truncated: false,
      },
    }),
  });

  expect(brief.impact.assessment).toBe("contained");
  expect(brief.diffs.map((entry) => entry.range)).toEqual(["cumulative", "since-last-review"]);

  const rendered = renderReviewBrief(brief);
  expect(rendered).toContain("## Fix-round focus");
  expect(rendered).toContain("This is fix round 1; review the since-last-review diff above");
  expect(rendered).toContain("Confirm each evidence-backed blocker below is resolved");
  expect(rendered).toContain("behavior/f-1");
});

test("a fix reaching outside the authorized surface broadens the review", () => {
  const brief = buildReviewBrief({
    task: task({
      reviews: [priorReview()],
      findingLedger: [ledgerEntry()],
      iterationScope: {
        head: "head-1",
        generation: 0,
        policyDigest: policyIdentity(policy),
        reproduces: ["check"],
        surfaces: ["service"],
        findingIds: ["f-1"],
      },
    }),
    head: HEAD,
    lens: "review",
    observations: observations({
      sinceLastReview: {
        range: "since-last-review",
        fromRef: "head-1",
        toRef: HEAD,
        patchPath: "/jobs/since-last-review.patch",
        changedFiles: ["src/service/controller.ts", "src/config/policy.ts"],
        truncated: false,
      },
    }),
  });

  expect(brief.impact.assessment).toBe("expanded");
  expect(brief.impact.escalation).toBe("broad-impact");
  expect(brief.impact.outsideScopeFiles).toEqual(["src/config/policy.ts"]);
  expect(renderReviewBrief(brief)).toContain("Review the cumulative diff and the affected callers");
});

test("an unbounded fix surface reports unknown impact and escalates", () => {
  const brief = buildReviewBrief({
    task: task({
      reviews: [priorReview()],
      findingLedger: [ledgerEntry({ file: null })],
      iterationScope: {
        head: "head-1",
        generation: 0,
        policyDigest: policyIdentity(policy),
        reproduces: ["check"],
        surfaces: ["service"],
        findingIds: ["f-1"],
      },
    }),
    head: HEAD,
    lens: "review",
    observations: observations({
      sinceLastReview: {
        range: "since-last-review",
        fromRef: "head-1",
        toRef: HEAD,
        patchPath: "/jobs/since-last-review.patch",
        changedFiles: ["src/service/controller.ts"],
        truncated: false,
      },
    }),
  });

  expect(brief.impact.assessment).toBe("unknown");
  expect(brief.impact.escalation).toBe("unknown-impact");
});

test("a truncated incremental patch cannot bound the impact", () => {
  const brief = buildReviewBrief({
    task: task({ reviews: [priorReview()] }),
    head: HEAD,
    lens: "review",
    observations: observations({
      sinceLastReview: {
        range: "since-last-review",
        fromRef: "head-1",
        toRef: HEAD,
        patchPath: "/jobs/since-last-review.patch",
        changedFiles: ["src/service/controller.ts"],
        truncated: true,
      },
    }),
  });

  expect(brief.impact.assessment).toBe("unknown");
  expect(renderReviewBrief(brief)).toContain("truncated");
});

test("an escalated validation contract broadens the review with its recorded reason", () => {
  const brief = buildReviewBrief({
    task: task({
      iterationScope: {
        head: "head-1",
        generation: 0,
        policyDigest: "a-different-policy-digest",
        reproduces: ["check"],
        surfaces: ["service"],
        findingIds: ["f-1"],
      },
    }),
    head: HEAD,
    lens: "review",
    observations: observations(),
  });

  expect(brief.impact.assessment).toBe("expanded");
  expect(brief.impact.escalation).toBe("stale-identity");
});

test("advisory leads are rendered with provenance as untrusted leads", () => {
  const lead: AdvisoryReviewLead = {
    id: "lead-1",
    summary: "The changed function may hide an effect.",
    principle: "Maximize Honesty",
    provenance: {
      source: "/jobs/diff.patch",
      question: "does this change hide an effect?",
      requestIdentity: "request-abc",
      resultIdentity: "result-def",
    },
  };
  const brief = buildReviewBrief({
    task: task(),
    head: HEAD,
    lens: "review",
    observations: observations(),
    advisoryLeads: [lead],
  });

  expect(brief.advisoryLeads).toEqual([lead]);
  const rendered = renderReviewBrief(brief);
  expect(rendered).toContain("Advisory leads (untrusted; never blockers)");
  expect(rendered).toContain("request request-abc");
  expect(rendered).toContain("never become findings");
});

test("the brief bounds its lists and stays within the rendered byte limit", () => {
  const ledger = Array.from({ length: 120 }, (_, index) =>
    ledgerEntry({
      id: `f-${index}`,
      description: "x".repeat(2_000),
      ...(index % 2 === 0 ? {} : { severity: "P3" as const, verdict: "plausible" as const }),
    }),
  );
  const changedFiles = Array.from({ length: 200 }, (_, index) => `src/module-${index}.ts`);
  const brief = buildReviewBrief({
    task: task({ findingLedger: ledger }),
    head: HEAD,
    lens: "review",
    observations: observations({
      cumulative: {
        range: "cumulative",
        fromRef: BASE,
        toRef: HEAD,
        patchPath: "/jobs/diff.patch",
        changedFiles,
        truncated: false,
      },
      affectedCallers: Array.from({ length: 90 }, (_, index) => `src/caller-${index}.ts`),
    }),
  });

  expect(brief.blockers.length + brief.suggestions.length + brief.settled.length).toBe(
    REVIEW_BRIEF_LIMITS.maxFindingEntries,
  );
  expect(brief.blockers).toHaveLength(REVIEW_BRIEF_LIMITS.maxFindingEntries);
  expect(brief.suggestions).toEqual([]);
  expect(brief.affectedCallers).toHaveLength(REVIEW_BRIEF_LIMITS.maxAffectedCallers);
  expect(brief.sourceLinks).toHaveLength(REVIEW_BRIEF_LIMITS.maxSourceLinks);
  expect(brief.elided.findings).toBe(80);

  const rendered = renderReviewBrief(brief);
  expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
    REVIEW_BRIEF_LIMITS.maxBriefBytes,
  );
  expect(rendered).toContain("behavior/f-0");
  expect(rendered).toContain("item(s) were elided");
});

test("an oversized brief compacts suggestions and long text but keeps every blocker identity", () => {
  const ledger = [
    ...Array.from({ length: REVIEW_BRIEF_LIMITS.maxFindingEntries }, (_, index) =>
      ledgerEntry({ id: `blocker-${index}`, description: "y".repeat(2_000) }),
    ),
    ledgerEntry({ id: "suggestion-1", severity: "P3", verdict: "plausible" }),
  ];
  const changedFiles = Array.from(
    { length: REVIEW_BRIEF_LIMITS.maxSourceLinks },
    (_, index) => `src/${"deeply-nested-directory/".repeat(20)}module-${index}.ts`,
  );
  const brief = buildReviewBrief({
    task: task({ findingLedger: ledger }),
    head: HEAD,
    lens: "review",
    observations: observations({
      cumulative: {
        range: "cumulative",
        fromRef: BASE,
        toRef: HEAD,
        patchPath: "/jobs/diff.patch",
        changedFiles,
        truncated: false,
      },
    }),
  });

  const rendered = renderReviewBrief(brief);
  expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
    REVIEW_BRIEF_LIMITS.maxBriefBytes,
  );
  for (const entry of brief.blockers) expect(rendered).toContain(`behavior/${entry.id}`);
  expect(rendered).toContain("suggestion(s) recorded; read them with tandem status TASK_ID");
  expect(rendered).not.toContain("y".repeat(REVIEW_BRIEF_LIMITS.maxCompactDescriptionBytes + 1));
});

test("the last reviewed HEAD comes from the newest review of an earlier generation", () => {
  const record = task({
    generation: 3,
    reviews: [
      { ...priorReview(), head: "head-0", generation: 0 },
      { ...priorReview(), head: "head-1", generation: 2 },
      { ...priorReview(), head: HEAD, generation: 3 },
    ],
  });

  expect(lastReviewedHead(record)).toBe("head-1");
  expect(lastReviewedHead(task())).toBeUndefined();
});
