import { expect, test } from "bun:test";
import {
  blockCause,
  type Endpoint,
  type Finding,
  type InstructionChannels,
  type PinnedValidationEvidence,
  type RepoPolicy,
  type ResearchContinuation,
  type ResolvedPolicy,
  type ReviewResult,
  type TaskRecord,
  type WorktreeLease,
} from "../../src/contracts.ts";
import { finalAcceptanceStatus, policyIdentity } from "../../src/tasks/acceptance.ts";
import { ledgerBlockers } from "../../src/tasks/findings.ts";
import {
  ALL_REVIEW_LENSES,
  createTask,
  isActiveTask,
  notificationDigest,
  pendingNotifications,
  type TaskInput,
  type TaskTransitionContext,
  TaskTransitionError,
  transitionTask,
} from "../../src/tasks/lifecycle.ts";
import { decideRequiredStages, pullRequestPublished } from "../../src/tasks/required-stages.ts";

const models: RepoPolicy["models"] = {
  coordinator: { model: "coordinator-model", thinking: "high" },
  scout: { model: "scout-model", thinking: "medium" },
  implementer: { model: "implementer-model", thinking: "max" },
  reviewer: { model: "reviewer-model", thinking: "max" },
  presentation: { model: "presentation-model", thinking: "low" },
};

const channels: InstructionChannels = {
  implementation: [],
  validation: [],
  review: [],
};

const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models,
    instructions: channels,
    instructionFiles: channels,
    validationCommands: [
      { name: "check", argv: ["bun", "run", "check"], surfaces: ["service"], timeoutMs: 10_000 },
    ],
    setupCommands: [],
    maxFixRounds: 1,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: {
    implementation: [],
    validation: [],
    review: [],
  },
};

const implementationInput: TaskInput = {
  id: "implementation-task",
  repoPath: "/repo",
  kind: "implementation",
  objective: "Implement the requested behavior",
  acceptanceCriteria: ["The behavior is durable"],
  surfaces: ["service"],
  policy,
};

const worktree: WorktreeLease = {
  root: "/worktrees",
  path: "/worktrees/implementation-task",
  name: "implementation-task",
  baseHead: "base-head",
  branch: "tandem/implementation-task",
  leaseId: "lease-1",
  leaseHolder: "worker-1",
  leasedAt: "2026-09-15T00:00:00.000Z",
};

function endpoint(generation: number): Endpoint {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: `pane-${generation}`,
    role: "implementer",
    generation,
  };
}

let contextSequence = 0;
function context(): TaskTransitionContext {
  contextSequence += 1;
  return {
    now: `2026-09-15T00:00:${String(contextSequence).padStart(2, "0")}.000Z`,
    notificationId: `notification-${contextSequence}`,
  };
}

function startImplementation(): TaskRecord {
  let task = createTask(implementationInput, "2026-09-15T00:00:00.000Z");
  task = transitionTask(task, { type: "approve" }, context());
  return transitionTask(
    task,
    { type: "start", worktree, endpoints: [endpoint(task.generation)] },
    context(),
  );
}

const policyDigest = policyIdentity(policy);

function evidence(
  head: string,
  contract: PinnedValidationEvidence["contract"],
  exitCode = 0,
  name = "check",
): PinnedValidationEvidence {
  return {
    name,
    argv: ["bun", "run", "check"],
    exitCode,
    stdout: exitCode === 0 ? "ok" : "",
    stderr: exitCode === 0 ? "" : "failure",
    head,
    contract,
    origin: "local",
    policyDigest,
  };
}

function implementationToReviewing(
  head = "head-1",
  contract: PinnedValidationEvidence["contract"] = "final",
): TaskRecord {
  let task = startImplementation();
  task = transitionTask(
    task,
    { type: "implementation-complete", head, generation: task.generation },
    context(),
  );
  return transitionTask(
    task,
    {
      type: "validation-succeeded",
      head,
      generation: task.generation,
      contract,
      policyDigest,
      evidence: [evidence(head, contract)],
    },
    context(),
  );
}

function review(
  lens: ReviewResult["lens"],
  pass = true,
  head = "head-1",
  generation = 0,
): ReviewResult {
  return {
    lens,
    head,
    generation,
    pass,
    findings: pass
      ? []
      : [{ id: "finding-1", severity: "P1", verdict: "confirmed", description: "A defect" }],
    summary: pass ? `${lens} review passed` : `${lens} review found work`,
  };
}

test("pins a complete resolved policy snapshot when creating a task", () => {
  const implementerModel = { ...models.implementer };
  const sourceModels = { ...models, implementer: implementerModel };
  const sourceImplementationInstructions = ["inline implementation"];
  const sourceValidationInstructions = ["inline validation"];
  const sourceReviewInstructions = ["inline review"];
  const sourceInstructions: InstructionChannels = {
    implementation: sourceImplementationInstructions,
    validation: sourceValidationInstructions,
    review: sourceReviewInstructions,
  };
  const sourceImplementationFiles = ["implementation.md"];
  const sourceValidationFiles = ["validation.md"];
  const sourceReviewFiles = ["review.md"];
  const sourceInstructionFiles: InstructionChannels = {
    implementation: sourceImplementationFiles,
    validation: sourceValidationFiles,
    review: sourceReviewFiles,
  };
  const sourceCommands = [
    { name: "check", argv: ["bun", "run", "check"], surfaces: ["source"], timeoutMs: 10_000 },
  ];
  const sourceImplementationGuidance = [
    {
      text: "implementation guidance",
      provenance: { channel: "implementation" as const, source: "implementation-source" },
    },
  ];
  const sourceValidationGuidance = [
    {
      text: "validation guidance",
      provenance: { channel: "validation" as const, source: "validation-source" },
    },
  ];
  const sourceReviewGuidance = [
    {
      text: "review guidance",
      provenance: { channel: "review" as const, source: "review-source" },
    },
  ];
  const sourcePolicy: ResolvedPolicy = {
    config: {
      ...policy.config,
      models: sourceModels,
      instructions: sourceInstructions,
      instructionFiles: sourceInstructionFiles,
      validationCommands: sourceCommands,
    },
    guidance: {
      implementation: sourceImplementationGuidance,
      validation: sourceValidationGuidance,
      review: sourceReviewGuidance,
    },
  };

  const task = createTask(
    { ...implementationInput, id: "policy-snapshot", policy: sourcePolicy },
    "2026-09-15T00:00:00.000Z",
  );

  implementerModel.model = "mutated-model";
  sourceImplementationInstructions.push("mutated instruction");
  sourceValidationFiles.push("mutated validation file");
  const [sourceCommand] = sourceCommands;
  const [implementationGuidance] = sourceImplementationGuidance;
  const [validationGuidance] = sourceValidationGuidance;
  if (
    sourceCommand === undefined ||
    implementationGuidance === undefined ||
    validationGuidance === undefined
  ) {
    throw new Error("policy snapshot fixture is missing its nested mutation inputs");
  }
  sourceCommand.argv.push("mutated-argument");
  sourceCommand.surfaces.push("mutated-surface");
  implementationGuidance.provenance.source = "mutated-source";
  validationGuidance.text = "mutated guidance";

  expect(task.policy.config.models.implementer.model).toBe("implementer-model");
  expect(task.policy.config.instructions.implementation).toEqual(["inline implementation"]);
  expect(task.policy.config.instructionFiles.validation).toEqual(["validation.md"]);
  expect(task.policy.config.validationCommands[0]?.argv).toEqual(["bun", "run", "check"]);
  expect(task.policy.config.validationCommands[0]?.surfaces).toEqual(["source"]);
  expect(task.policy.guidance.implementation[0]?.provenance.source).toBe("implementation-source");
  expect(task.policy.guidance.validation[0]?.text).toBe("validation guidance");
});

const pinnedSkill = {
  name: "refactor-functions",
  origin: "repository",
  directory: "/repo/.claude/skills/refactor-functions",
  instructions: "Apply the five function-review principles.",
} as const;

test("pins the skills a task was created with and rejects malformed ones", () => {
  const withoutSkills = createTask(implementationInput, "2026-09-15T00:00:00.000Z");
  expect(withoutSkills.skills).toBeUndefined();

  const withSkills = createTask(
    { ...implementationInput, id: "skill-task", skills: [pinnedSkill] },
    "2026-09-15T00:00:00.000Z",
  );
  expect(withSkills.skills).toEqual([pinnedSkill]);

  const invalidSkill = {
    ...implementationInput,
    skills: [{ ...pinnedSkill, name: "" }],
  } as unknown as TaskInput;
  expect(() => createTask(invalidSkill, "2026-09-15T00:00:00.000Z")).toThrow(TypeError);

  const unexpectedField = {
    ...implementationInput,
    skills: [{ ...pinnedSkill, scope: "everything" }],
  } as unknown as TaskInput;
  expect(() => createTask(unexpectedField, "2026-09-15T00:00:00.000Z")).toThrow(TypeError);
});

test("pinned skills survive approval, a fix round, and evidence invalidation", () => {
  const skills = [pinnedSkill];
  const created = createTask(
    { ...implementationInput, id: "skill-lifecycle", skills },
    "2026-09-15T00:00:00.000Z",
  );
  const approved = transitionTask(created, { type: "approve" }, context());
  const started = transitionTask(
    approved,
    { type: "start", worktree, endpoints: [endpoint(approved.generation)] },
    context(),
  );
  expect(started.skills).toEqual(skills);

  const afterImplementation = transitionTask(
    started,
    { type: "implementation-complete", head: "head-1", generation: started.generation },
    context(),
  );
  const awaitingFixes = transitionTask(
    afterImplementation,
    {
      type: "validation-failed",
      head: "head-1",
      generation: started.generation,
      contract: "final",
      policyDigest,
      evidence: [evidence("head-1", "final", 1)],
    },
    context(),
  );
  expect(awaitingFixes.skills).toEqual(skills);

  const fixing = transitionTask(
    awaitingFixes,
    { type: "begin-fixes", head: "head-1", generation: started.generation },
    context(),
  );
  expect(fixing.skills).toEqual(skills);
  expect(fixing.generation).toBe(started.generation + 1);

  const afterSecondImplementation = transitionTask(
    fixing,
    { type: "implementation-complete", head: "head-2", generation: fixing.generation },
    context(),
  );
  const reviewing = transitionTask(
    afterSecondImplementation,
    {
      type: "validation-succeeded",
      head: "head-2",
      generation: fixing.generation,
      contract: "iteration",
      policyDigest,
      evidence: [evidence("head-2", "iteration")],
    },
    context(),
  );
  const invalidated = transitionTask(
    reviewing,
    { type: "invalidate-evidence", head: "head-2", generation: fixing.generation },
    context(),
  );
  expect(invalidated.skills).toEqual(skills);
});

test("keeps implementation behind explicit approval and binds starts to a worktree generation", () => {
  const initial = createTask(implementationInput, "2026-09-15T00:00:00.000Z");
  expect(initial.stage).toBe("awaiting-approval");
  expect(() =>
    transitionTask(initial, { type: "start", worktree, endpoints: [endpoint(0)] }, context()),
  ).toThrow(TaskTransitionError);

  const approved = transitionTask(initial, { type: "approve" }, context());
  expect(approved.stage).toBe("queued");
  expect(approved.scopeApproved).toBe(true);
  expect(approved.revision).toBe(initial.revision + 1);
  const started = transitionTask(
    approved,
    { type: "start", worktree, endpoints: [endpoint(approved.generation)] },
    context(),
  );
  expect(started.stage).toBe("implementing");
  expect(started.worktree?.path).toBe(worktree.path);
  expect(started.endpoints?.[0]?.generation).toBe(started.generation);
});

test("relaunch replaces the endpoint set from implementing or scouting without touching stage or worktree", () => {
  const implementing = startImplementation();
  const relaunched = transitionTask(
    implementing,
    {
      type: "relaunch",
      endpoints: [{ ...endpoint(implementing.generation), paneId: "pane-relaunch" }],
      generation: implementing.generation,
    },
    context(),
  );
  expect(relaunched.stage).toBe("implementing");
  expect(relaunched.worktree).toEqual(implementing.worktree);
  expect(relaunched.reviewHead).toBe(implementing.reviewHead);
  expect(relaunched.endpoints).toEqual([
    { ...endpoint(implementing.generation), paneId: "pane-relaunch" },
  ]);
  expect(relaunched.revision).toBe(implementing.revision + 1);

  const scoutApproved = transitionTask(
    createTask(
      { ...implementationInput, id: "scout-task", kind: "scout" },
      "2026-09-15T00:00:00.000Z",
    ),
    {
      type: "start",
      worktree,
      endpoints: [{ ...endpoint(0), role: "scout" }],
    },
    context(),
  );
  expect(scoutApproved.stage).toBe("scouting");
  const scoutRelaunched = transitionTask(
    scoutApproved,
    {
      type: "relaunch",
      endpoints: [{ ...endpoint(0), role: "scout", paneId: "pane-scout-relaunch" }],
      generation: scoutApproved.generation,
    },
    context(),
  );
  expect(scoutRelaunched.stage).toBe("scouting");
  expect(scoutRelaunched.endpoints?.[0]?.paneId).toBe("pane-scout-relaunch");
});

test("relaunch refuses a stale generation and any stage other than implementing or scouting", () => {
  const implementing = startImplementation();
  expect(() =>
    transitionTask(
      implementing,
      {
        type: "relaunch",
        endpoints: [endpoint(implementing.generation)],
        generation: implementing.generation + 1,
      },
      context(),
    ),
  ).toThrow(TaskTransitionError);

  const queued = transitionTask(
    createTask(implementationInput, "2026-09-15T00:00:00.000Z"),
    {
      type: "approve",
    },
    context(),
  );
  expect(() =>
    transitionTask(
      queued,
      { type: "relaunch", endpoints: [endpoint(queued.generation)], generation: queued.generation },
      context(),
    ),
  ).toThrow(TaskTransitionError);
});

test("requires current-head validation and the current-generation review before ready", () => {
  let task = implementationToReviewing();
  expect(task.stage).toBe("reviewing");
  expect(() =>
    transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context()),
  ).toThrow(TaskTransitionError);
  expect(() =>
    transitionTask(
      task,
      { type: "record-review", review: review("review", true, "old-head", 0) },
      context(),
    ),
  ).toThrow(TaskTransitionError);

  // One merged reviewer session per round now covers behavior, design, and coverage together.
  expect(ALL_REVIEW_LENSES).toEqual(["review"]);
  for (const lens of ALL_REVIEW_LENSES) {
    task = transitionTask(task, { type: "record-review", review: review(lens) }, context());
  }
  expect(task.revision).toBe(5);
  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context());
  expect(task.stage).toBe("ready");
  const readyNotification = task.notifications.at(-1);
  expect(readyNotification?.kind).toBe("coordinator");
  expect(readyNotification?.acknowledged).toBe(false);
  expect(readyNotification?.message).toContain("Ready: task");
  expect(readyNotification?.message).toContain(
    "Ready is not publication, merge, or deploy approval",
  );
  expect(isActiveTask(task)).toBe(true);
  expect(() =>
    transitionTask(task, { type: "record-review", review: review("review") }, context()),
  ).toThrow(TaskTransitionError);
});

test("a review with only P2 and P3 findings is ready and lists them as known issues", () => {
  const withKnownIssues: ReviewResult = {
    ...review("review", false),
    findings: [
      { id: "f-2", severity: "P2", verdict: "confirmed", description: "Label says Back." },
      { id: "f-3", severity: "P3", verdict: "confirmed", description: "Stale comment." },
    ],
  };
  let task = transitionTask(
    implementationToReviewing(),
    { type: "record-review", review: withKnownIssues },
    context(),
  );
  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context());
  expect(task.stage).toBe("ready");
  const message = task.notifications.at(-1)?.message ?? "";
  expect(message).toContain("these 2 known issues");
  expect(message).toContain("- P2: Label says Back.");
  expect(message).toContain("- P3: Stale comment.");
});

test("the findings decide a review's outcome, not the reviewer's pass flag", () => {
  const withFinding = (severity: "P1" | "P2", pass: boolean): ReviewResult => ({
    ...review("review"),
    pass,
    findings: [{ id: "finding-1", severity, verdict: "confirmed", description: "A defect" }],
  });
  const recorded = (result: ReviewResult) =>
    transitionTask(
      implementationToReviewing(),
      { type: "record-review", review: result },
      context(),
    ).reviews[0]?.pass;
  expect(recorded(withFinding("P1", true))).toBe(false);
  expect(recorded(withFinding("P2", false))).toBe(true);
});

test("rejects duplicate or stale review results", () => {
  let task = implementationToReviewing();
  task = transitionTask(task, { type: "record-review", review: review("review") }, context());
  expect(() =>
    transitionTask(task, { type: "record-review", review: review("review") }, context()),
  ).toThrow(TaskTransitionError);
  expect(() =>
    transitionTask(
      task,
      { type: "record-review", review: review("review", true, "head-1", 99) },
      context(),
    ),
  ).toThrow(TaskTransitionError);
});

test("records failed validation, bounds fix rounds, and invalidates old review acceptance", () => {
  let task = startImplementation();
  task = transitionTask(
    task,
    { type: "implementation-complete", head: "head-1", generation: 0 },
    context(),
  );
  task = transitionTask(
    task,
    {
      type: "validation-failed",
      head: "head-1",
      generation: 0,
      contract: "final",
      policyDigest,
      evidence: [evidence("head-1", "final", 1)],
    },
    context(),
  );
  expect(task.stage).toBe("awaiting-fixes");
  expect(pendingNotifications(task)).toHaveLength(1);

  task = transitionTask(task, { type: "begin-fixes", head: "head-1", generation: 0 }, context());
  expect(task.stage).toBe("implementing");
  expect(task.reviewRound).toBe(1);
  expect(task.generation).toBe(1);
  expect(task.reviewHead).toBeUndefined();
  expect(() =>
    transitionTask(task, { type: "begin-fixes", head: "head-1", generation: 1 }, context()),
  ).toThrow(TaskTransitionError);

  // The failed check never carries forward, even when the round reports the same commit.
  task = transitionTask(
    task,
    { type: "implementation-complete", head: "head-1", generation: 1 },
    context(),
  );
  expect(task.stage).toBe("validating");
  expect(task.validationEvidence).toHaveLength(0);
});

test("a review-only fix round goes straight to review and runs the checks once it passes", () => {
  let task = implementationToReviewing();
  task = transitionTask(
    task,
    { type: "record-review", review: review("review", false) },
    context(),
  );
  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context());
  task = transitionTask(
    task,
    {
      type: "begin-fixes",
      head: "head-1",
      generation: 0,
      iterationScope: {
        head: "head-1",
        generation: 0,
        policyDigest,
        reproduces: [],
        surfaces: [],
        findingIds: ["finding-1"],
      },
    },
    context(),
  );
  task = transitionTask(
    task,
    { type: "implementation-complete", head: "head-2", generation: 1 },
    context(),
  );
  expect(task.stage).toBe("reviewing");
  expect(task.validationEvidence).toHaveLength(0);

  task = transitionTask(
    task,
    { type: "record-review", review: review("review", true, "head-2", 1) },
    context(),
  );
  task = transitionTask(task, { type: "finish-review", head: "head-2", generation: 1 }, context());
  expect(task.stage).toBe("validating");

  task = transitionTask(
    task,
    {
      type: "validation-succeeded",
      head: "head-2",
      generation: 1,
      contract: "final",
      policyDigest,
      evidence: [evidence("head-2", "final")],
    },
    context(),
  );
  task = transitionTask(task, { type: "finish-review", head: "head-2", generation: 1 }, context());
  expect(task.stage).toBe("ready");
});

test("a fix round that reports an already-validated commit skips the checks", () => {
  let task = implementationToReviewing();
  task = transitionTask(
    task,
    { type: "record-review", review: review("review", false) },
    context(),
  );
  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context());
  task = transitionTask(task, { type: "begin-fixes", head: "head-1", generation: 0 }, context());
  task = transitionTask(
    task,
    { type: "implementation-complete", head: "head-1", generation: 1 },
    context(),
  );
  expect(task.stage).toBe("reviewing");
  expect(task.validationEvidence).toEqual([evidence("head-1", "final")]);

  task = transitionTask(
    task,
    { type: "record-review", review: review("review", true, "head-1", 1) },
    context(),
  );
  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 1 }, context());
  expect(task.stage).toBe("ready");
});

test("carries finding identities and their status across review rounds", () => {
  const blocker: Finding = {
    id: "finding-1",
    severity: "P1",
    verdict: "confirmed",
    description: "A blocking behavior defect",
    file: "src/service/controller.ts",
  };
  let task = implementationToReviewing();
  task = transitionTask(
    task,
    { type: "record-review", review: { ...review("review", false), findings: [blocker] } },
    context(),
  );
  expect(task.findingLedger).toHaveLength(1);
  expect(task.findingLedger?.[0]?.status).toBe("unresolved");
  expect(ledgerBlockers(task.findingLedger ?? []).map((entry) => entry.id)).toEqual(["finding-1"]);

  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context());
  expect(task.stage).toBe("awaiting-fixes");

  task = transitionTask(task, { type: "begin-fixes", head: "head-1", generation: 0 }, context());
  expect(task.findingLedger?.[0]?.status).toBe("unresolved");

  task = transitionTask(
    task,
    { type: "implementation-complete", head: "head-2", generation: 1 },
    context(),
  );
  task = transitionTask(
    task,
    {
      type: "validation-succeeded",
      head: "head-2",
      generation: 1,
      contract: "iteration",
      policyDigest,
      evidence: [evidence("head-2", "iteration")],
    },
    context(),
  );
  task = transitionTask(
    task,
    { type: "record-review", review: review("review", true, "head-2", 1) },
    context(),
  );

  const settled = task.findingLedger?.[0];
  expect(settled?.status).toBe("addressed");
  expect(settled?.raisedAt).toEqual({ head: "head-1", generation: 0, reviewRound: 0 });
  expect(settled?.statusAt).toEqual({ head: "head-2", generation: 1, reviewRound: 1 });
  expect(ledgerBlockers(task.findingLedger ?? [])).toEqual([]);
});

test("pause, resume, block, cancel, scout completion, and merge remain distinct", () => {
  let task = startImplementation();
  const paused = transitionTask(task, { type: "pause", reason: "waiting for input" }, context());
  expect(paused.stage).toBe("paused");
  expect(() =>
    transitionTask(
      paused,
      { type: "implementation-complete", head: "head-1", generation: 0 },
      context(),
    ),
  ).toThrow(TaskTransitionError);
  task = transitionTask(paused, { type: "resume" }, context());
  expect(task.stage).toBe("implementing");
  const blocked = transitionTask(
    task,
    { type: "block", reason: "dependency unavailable" },
    context(),
  );
  expect(blocked.stage).toBe("blocked");
  expect(blocked.notifications.at(-1)?.kind).toBe("coordinator");
  expect(blocked.blockCause).toBeUndefined();
  task = transitionTask(blocked, { type: "resume" }, context());
  task = transitionTask(task, { type: "cancel", reason: "no longer needed" }, context());
  expect(task.stage).toBe("cancelled");
  expect(task.worktree?.path).toBe(worktree.path);
  expect(isActiveTask(task)).toBe(false);

  let scout = createTask(
    { ...implementationInput, id: "scout-task", kind: "scout" },
    "2026-09-15T00:00:00.000Z",
  );
  scout = transitionTask(
    scout,
    { type: "start", worktree, endpoints: [{ ...endpoint(0), role: "scout" }] },
    context(),
  );
  scout = transitionTask(
    scout,
    { type: "scout-report-complete", reportPath: "/reports/scout.md", generation: 0 },
    context(),
  );
  expect(scout.stage).toBe("completed");
  expect(scout.stage).not.toBe("ready");

  let ready = implementationToReviewing();
  for (const lens of ALL_REVIEW_LENSES) {
    ready = transitionTask(ready, { type: "record-review", review: review(lens) }, context());
  }
  ready = transitionTask(
    ready,
    { type: "finish-review", head: "head-1", generation: 0 },
    context(),
  );
  const merged = transitionTask(
    ready,
    {
      type: "merge",
      approved: true,
      verified: true,
      pullRequest: {
        repository: "org/repo",
        number: 42,
        state: "merged",
        head: "head-1",
        base: "main",
      },
    },
    context(),
  );
  expect(merged.stage).toBe("merged");
});

test("a block event's typed cause is recorded alongside its free-text reason and cleared on resume", () => {
  const task = startImplementation();
  const cause = blockCause("resource-lost", {
    summary: "The task's worktree is missing, so no further work can run against it.",
    detail: "task is implementing but its durable worktree is missing",
    jobId: "job-1",
  });
  const blocked = transitionTask(
    task,
    { type: "block", reason: "task is implementing but its durable worktree is missing", cause },
    context(),
  );
  expect(blocked.stage).toBe("blocked");
  expect(blocked.blockCause?.detail).toBe(
    "task is implementing but its durable worktree is missing",
  );
  expect(blocked.blockCause).toEqual(cause);

  const resumed = transitionTask(blocked, { type: "resume" }, context());
  expect(resumed.blockCause).toBeUndefined();
  expect(resumed.blockReason).toBeUndefined();
});

test("acknowledges notifications through a single revisioned mutation and exposes a digest", () => {
  let task = startImplementation();
  task = transitionTask(task, { type: "pause", reason: "operator requested" }, context());
  expect(notificationDigest(task)).toContain("operator requested");
  const acknowledged = transitionTask(
    task,
    { type: "acknowledge-notification", notificationId: task.notifications[0]?.id ?? "missing" },
    context(),
  );
  expect(pendingNotifications(acknowledged)).toHaveLength(0);
  expect(acknowledged.revision).toBe(task.revision + 1);
  expect(() =>
    transitionTask(
      acknowledged,
      { type: "acknowledge-notification", notificationId: task.notifications[0]?.id ?? "missing" },
      context(),
    ),
  ).toThrow(TaskTransitionError);
});

const scoutInput: TaskInput = {
  id: "scout-task",
  repoPath: "/repo",
  kind: "scout",
  objective: "Investigate the reported defect",
  acceptanceCriteria: ["The findings are durable"],
  surfaces: ["service"],
  policy,
};

function completedScout(continuation?: ResearchContinuation): TaskRecord {
  let task = createTask(
    {
      ...scoutInput,
      ...(continuation === undefined ? {} : { researchContinuation: continuation }),
    },
    "2026-09-15T00:00:00.000Z",
  );
  task = transitionTask(
    task,
    { type: "start", worktree, endpoints: [{ ...endpoint(task.generation), role: "scout" }] },
    context(),
  );
  return transitionTask(
    task,
    { type: "scout-report-complete", reportPath: "/reports/scout.md", generation: task.generation },
    context(),
  );
}

test("creates scouts with the conservative post-research disposition by default", () => {
  const task = createTask(scoutInput, "2026-09-15T00:00:00.000Z");
  expect(task.researchContinuation).toEqual({
    schemaVersion: 1,
    disposition: "ask-intent",
    selectedBy: "deterministic",
  });
});

test("creates scouts with an explicitly supplied disposition and its provenance", () => {
  const task = createTask(
    {
      ...scoutInput,
      researchContinuation: {
        schemaVersion: 1,
        disposition: "implementation-interview",
        selectedBy: "explicit",
      },
    },
    "2026-09-15T00:00:00.000Z",
  );
  expect(task.researchContinuation?.disposition).toBe("implementation-interview");
  expect(task.researchContinuation?.selectedBy).toBe("explicit");
});

test("refuses invalid dispositions, malformed provenance, and non-scout continuations", () => {
  const invalidDisposition = {
    ...scoutInput,
    researchContinuation: {
      schemaVersion: 1,
      disposition: "implement-now",
      selectedBy: "explicit",
    },
  } as unknown as TaskInput;
  expect(() => createTask(invalidDisposition, "2026-09-15T00:00:00.000Z")).toThrow(TypeError);

  const explicitWithClassifier: TaskInput = {
    ...scoutInput,
    researchContinuation: {
      schemaVersion: 1,
      disposition: "report-only",
      selectedBy: "explicit",
      classifierVersion: "continuation-1",
    },
  };
  expect(() => createTask(explicitWithClassifier, "2026-09-15T00:00:00.000Z")).toThrow(TypeError);

  const jevWithoutClassifier: TaskInput = {
    ...scoutInput,
    researchContinuation: { schemaVersion: 1, disposition: "ask-intent", selectedBy: "jev" },
  };
  expect(() => createTask(jevWithoutClassifier, "2026-09-15T00:00:00.000Z")).toThrow(TypeError);

  const implementationContinuation: TaskInput = {
    ...implementationInput,
    researchContinuation: {
      schemaVersion: 1,
      disposition: "implementation-interview",
      selectedBy: "explicit",
    },
  };
  expect(() => createTask(implementationContinuation, "2026-09-15T00:00:00.000Z")).toThrow(
    TypeError,
  );
});

test("an implementation-interview disposition never approves scope or starts implementation", () => {
  const scout = completedScout({
    schemaVersion: 1,
    disposition: "implementation-interview",
    selectedBy: "explicit",
  });
  expect(scout.stage).toBe("completed");
  expect(scout.researchContinuation?.disposition).toBe("implementation-interview");

  const implementation = createTask(
    {
      ...implementationInput,
      id: "interview-follow-up",
      researchHandoffs: [
        {
          scoutTaskId: scout.id,
          scoutRepoPath: scout.repoPath,
          scoutSourceHead: "source-head",
          scoutSourceBase: "source-head",
          reportPath: "/reports/scout.md",
          reportDigest: "b".repeat(64),
          excerpt: "Scout evidence",
        },
      ],
    },
    "2026-09-15T00:00:00.000Z",
  );
  expect(implementation.scopeApproved).toBe(false);
  expect(implementation.stage).toBe("awaiting-approval");
  expect(implementation.researchContinuation).toBeUndefined();
  expect(() =>
    transitionTask(
      implementation,
      { type: "start", worktree, endpoints: [endpoint(implementation.generation)] },
      context(),
    ),
  ).toThrow(TaskTransitionError);
});

test("scout transitions preserve the disposition without touching scope approval", () => {
  const scout = completedScout({
    schemaVersion: 1,
    disposition: "report-only",
    selectedBy: "deterministic",
    classifierVersion: "continuation-rules-1",
  });
  const requeued = transitionTask(scout, { type: "follow-up-research" }, context());
  expect(requeued.stage).toBe("queued");
  expect(requeued.researchContinuation).toEqual(scout.researchContinuation);

  const blocked = transitionTask(requeued, { type: "block", reason: "source moved" }, context());
  expect(blocked.stage).toBe("blocked");
  expect(blocked.researchContinuation).toEqual(scout.researchContinuation);
  expect(blocked.scopeApproved).toBe(scout.scopeApproved);
});

test("releasing a completed scout's resources keeps its disposition and report evidence", () => {
  const scout = completedScout({
    schemaVersion: 1,
    disposition: "implementation-interview",
    selectedBy: "explicit",
  });
  const released: TaskRecord = {
    ...scout,
    revision: scout.revision + 1,
    endpoints: [],
    cleanup: {
      schemaVersion: 1,
      status: "released",
      reason: "the scout worktree is clean and still on its source commit",
      observedAt: "2026-09-15T01:00:00.000Z",
    },
  };
  expect(released.stage).toBe("completed");
  expect(released.reportPath).toBe("/reports/scout.md");
  expect(released.researchContinuation).toEqual(scout.researchContinuation);
  expect(released.scopeApproved).toBe(scout.scopeApproved);

  const requeued = transitionTask(released, { type: "follow-up-research" }, context());
  expect(requeued.cleanup).toBeUndefined();
  expect(requeued.researchContinuation).toEqual(scout.researchContinuation);
});

test("a passing iteration contract reaches review but never reaches ready on its own", () => {
  let task = implementationToReviewing("head-1", "iteration");
  expect(task.stage).toBe("reviewing");
  for (const lens of ALL_REVIEW_LENSES) {
    task = transitionTask(task, { type: "record-review", review: review(lens) }, context());
  }
  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context());

  expect(task.stage).toBe("validating");
  expect(notificationDigest(task)).toContain("final acceptance manifest");
  expect(finalAcceptanceStatus(task, "head-1").satisfied).toBe(false);
});

test("the complete final manifest at the reviewed head accepts the candidate", () => {
  let task = implementationToReviewing("head-1", "iteration");
  for (const lens of ALL_REVIEW_LENSES) {
    task = transitionTask(task, { type: "record-review", review: review(lens) }, context());
  }
  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context());
  task = transitionTask(
    task,
    {
      type: "validation-succeeded",
      head: "head-1",
      generation: 0,
      contract: "final",
      policyDigest,
      evidence: [evidence("head-1", "final")],
    },
    context(),
  );
  expect(task.stage).toBe("reviewing");

  task = transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context());
  expect(task.stage).toBe("ready");
  expect(task.validationEvidence.map((entry) => entry.contract)).toEqual(["iteration", "final"]);
});

test("evidence produced under another policy identity is refused rather than recorded", () => {
  const task = implementationToReviewing("head-1", "final");
  expect(() =>
    transitionTask(
      task,
      {
        type: "validation-succeeded",
        head: "head-1",
        generation: 0,
        contract: "final",
        policyDigest: "superseded-policy",
        evidence: [{ ...evidence("head-1", "final"), policyDigest: "superseded-policy" }],
      },
      context(),
    ),
  ).toThrow(TaskTransitionError);
});

test("evidence whose contract disagrees with the reported run is refused", () => {
  const task = startImplementation();
  const validating = transitionTask(
    task,
    { type: "implementation-complete", head: "head-1", generation: 0 },
    context(),
  );
  expect(() =>
    transitionTask(
      validating,
      {
        type: "validation-succeeded",
        head: "head-1",
        generation: 0,
        contract: "final",
        policyDigest,
        evidence: [evidence("head-1", "iteration")],
      },
      context(),
    ),
  ).toThrow(TaskTransitionError);
});

test("a fix round records the targeted scope and clears it when evidence is invalidated", () => {
  let task = startImplementation();
  task = transitionTask(
    task,
    { type: "implementation-complete", head: "head-1", generation: 0 },
    context(),
  );
  task = transitionTask(
    task,
    {
      type: "validation-failed",
      head: "head-1",
      generation: 0,
      contract: "final",
      policyDigest,
      evidence: [evidence("head-1", "final", 1)],
    },
    context(),
  );
  const scope = {
    head: "head-1",
    generation: 0,
    policyDigest,
    reproduces: ["check"],
    surfaces: ["service"],
    findingIds: [],
  };
  task = transitionTask(
    task,
    { type: "begin-fixes", head: "head-1", generation: 0, iterationScope: scope },
    context(),
  );
  expect(task.iterationScope).toEqual(scope);

  task = transitionTask(
    task,
    { type: "implementation-complete", head: "head-2", generation: 1 },
    context(),
  );
  task = transitionTask(
    task,
    { type: "invalidate-evidence", head: "head-2", generation: 1 },
    context(),
  );
  expect(task.iterationScope).toBeUndefined();
});

test("a fix scope bound to another head or generation is refused", () => {
  let task = startImplementation();
  task = transitionTask(
    task,
    { type: "implementation-complete", head: "head-1", generation: 0 },
    context(),
  );
  task = transitionTask(
    task,
    {
      type: "validation-failed",
      head: "head-1",
      generation: 0,
      contract: "final",
      policyDigest,
      evidence: [evidence("head-1", "final", 1)],
    },
    context(),
  );
  expect(() =>
    transitionTask(
      task,
      {
        type: "begin-fixes",
        head: "head-1",
        generation: 0,
        iterationScope: {
          head: "head-0",
          generation: 0,
          policyDigest,
          reproduces: ["check"],
          surfaces: ["service"],
          findingIds: [],
        },
      },
      context(),
    ),
  ).toThrow(TaskTransitionError);
});

test("a task carries the request brief it was created under and refuses a task-shaped one", () => {
  const governed = createTask(
    { ...implementationInput, requestId: "req-1" },
    "2026-09-15T00:00:00.000Z",
  );

  expect(governed.requestId).toBe("req-1");
  expect(createTask(implementationInput, "2026-09-15T00:00:00.000Z").requestId).toBeUndefined();
  expect(() =>
    createTask(
      { ...implementationInput, requestId: "implementation-task" },
      "2026-09-15T00:00:00.000Z",
    ),
  ).toThrow(/Unsafe request id/u);
});

function readyImplementation(): TaskRecord {
  let ready = implementationToReviewing();
  for (const lens of ALL_REVIEW_LENSES) {
    ready = transitionTask(ready, { type: "record-review", review: review(lens) }, context());
  }
  return transitionTask(ready, { type: "finish-review", head: "head-1", generation: 0 }, context());
}

function followUpOn(
  state: "draft" | "open",
  stages: (task: TaskRecord) => TaskRecord = (task) => ({
    ...task,
    // What steering records from the pull request's state.
    requiredStages: decideRequiredStages({
      briefSkipsReview: false,
      pullRequestPublished: pullRequestPublished(task),
    }),
  }),
): TaskRecord {
  const published = stages({
    ...readyImplementation(),
    pullRequest: { repository: "org/repo", number: 42, state, head: "head-1", base: "main" },
  });
  const redirected = transitionTask(
    published,
    { type: "invalidate-evidence", head: "head-1", generation: published.generation },
    context(),
  );
  return transitionTask(
    redirected,
    { type: "implementation-complete", head: "head-2", generation: redirected.generation },
    context(),
  );
}

test("a follow-up on an open pull request goes straight back to ready without checks or review", () => {
  const done = followUpOn("open");

  expect(done.stage).toBe("ready");
  expect(done.reviewHead).toBe("head-2");
  expect(done.reviewSkippedHead).toBe("head-2");
  expect(done.notifications.at(-1)?.message).toContain("Tandem pushes it to its pull request");
});

test("a follow-up on a draft pull request still runs checks", () => {
  expect(followUpOn("draft").stage).toBe("validating");
});

test("a task saved before required stages existed derives them from its open pull request", () => {
  const legacy = followUpOn("open", ({ requiredStages: _stages, ...task }) => task);

  expect(legacy.stage).toBe("ready");
  expect(legacy.reviewSkippedHead).toBe("head-2");
});

test("the recorded required stages decide, not the pull request's state", () => {
  const full = followUpOn("open", (task) => ({
    ...task,
    requiredStages: { validation: true, review: true },
  }));

  expect(full.stage).toBe("validating");
});

test("a new implementation task requires validation and review; research requires neither", () => {
  expect(createTask(implementationInput, "2026-09-15T00:00:00.000Z").requiredStages).toEqual({
    validation: true,
    review: true,
  });
  expect(
    createTask(
      { ...implementationInput, requiredStages: { validation: true, review: false } },
      "2026-09-15T00:00:00.000Z",
    ).requiredStages,
  ).toEqual({ validation: true, review: false });
});

test("a merge must land the pull request at the reviewed head", () => {
  expect(() =>
    transitionTask(
      readyImplementation(),
      {
        type: "merge",
        approved: true,
        verified: true,
        pullRequest: {
          repository: "org/repo",
          number: 42,
          state: "merged",
          head: "integrated-head-1",
          base: "main",
        },
      },
      context(),
    ),
  ).toThrow(/must match the reviewed head/u);
});

test("a ready task becomes merged when its own pull request merged on GitHub, at any head", () => {
  let ready = implementationToReviewing();
  for (const lens of ALL_REVIEW_LENSES) {
    ready = transitionTask(ready, { type: "record-review", review: review(lens) }, context());
  }
  ready = transitionTask(
    ready,
    { type: "finish-review", head: "head-1", generation: 0 },
    context(),
  );
  const published: TaskRecord = {
    ...ready,
    pullRequest: {
      repository: "Org/Repo",
      number: 42,
      state: "open",
      head: "head-1",
      base: "main",
    },
  };
  const mergedPullRequest = {
    repository: "org/repo",
    number: 42,
    state: "merged" as const,
    // PR watch updated the branch after review, so the merged head is not the reviewed one.
    head: "head-2",
    base: "main",
  };
  const merged = transitionTask(
    published,
    { type: "merged-on-github", pullRequest: mergedPullRequest },
    context(),
  );
  expect(merged.stage).toBe("merged");
  expect(merged.pullRequest).toEqual(mergedPullRequest);
  expect(merged.notifications).toEqual(published.notifications);

  expect(() =>
    transitionTask(
      published,
      { type: "merged-on-github", pullRequest: { ...mergedPullRequest, number: 43 } },
      context(),
    ),
  ).toThrow(TaskTransitionError);
  expect(() =>
    transitionTask(
      published,
      { type: "merged-on-github", pullRequest: { ...mergedPullRequest, state: "open" } },
      context(),
    ),
  ).toThrow(TaskTransitionError);
  expect(() =>
    transitionTask(
      { ...published, stage: "reviewing" },
      { type: "merged-on-github", pullRequest: mergedPullRequest },
      context(),
    ),
  ).toThrow(TaskTransitionError);
});

test("a task records a valid workstream name and refuses anything else", () => {
  expect(
    createTask({ ...implementationInput, workstream: "billing" }, "2026-09-15T00:00:00.000Z")
      .workstream,
  ).toBe("billing");
  expect(createTask(implementationInput, "2026-09-15T00:00:00.000Z").workstream).toBeUndefined();
  expect(() =>
    createTask({ ...implementationInput, workstream: "../billing" }, "2026-09-15T00:00:00.000Z"),
  ).toThrow("Unsafe workstream name");
});
