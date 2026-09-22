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

const models: RepoPolicy["models"] = {
  coordinator: { model: "coordinator-model", thinking: "high" },
  scout: { model: "scout-model", thinking: "medium" },
  implementer: { model: "implementer-model", thinking: "max" },
  reviewer: { model: "reviewer-model", thinking: "max" },
  verifier: { model: "verifier-model", thinking: "high" },
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
    maxWorkers: 3,
    maxFixRounds: 1,
    reviewLevels: {
      reducedRouting: false,
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
    requestBudget: { capMicros: "unset", operationEstimateMicros: "unset" },
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
    findings: [],
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

test("pins an explicit skill invocation and rejects a malformed one", () => {
  const withoutSkill = createTask(implementationInput, "2026-09-15T00:00:00.000Z");
  expect(withoutSkill.skill).toBeUndefined();

  const withSkill = createTask(
    {
      ...implementationInput,
      id: "skill-task",
      skill: { name: "refactor-functions", context: "Apply the five function-review principles." },
    },
    "2026-09-15T00:00:00.000Z",
  );
  expect(withSkill.skill).toEqual({
    name: "refactor-functions",
    context: "Apply the five function-review principles.",
  });

  const invalidSkill = {
    ...implementationInput,
    skill: { name: "", context: "Apply the five function-review principles." },
  } as unknown as TaskInput;
  expect(() => createTask(invalidSkill, "2026-09-15T00:00:00.000Z")).toThrow(TypeError);

  const unexpectedField = {
    ...implementationInput,
    skill: { name: "refactor-functions", context: "context", scope: "everything" },
  } as unknown as TaskInput;
  expect(() => createTask(unexpectedField, "2026-09-15T00:00:00.000Z")).toThrow(TypeError);
});

test("a pinned skill invocation survives approval, a fix round, and evidence invalidation", () => {
  const skill = {
    name: "refactor-functions",
    context: "Apply the five function-review principles.",
  };
  const created = createTask(
    { ...implementationInput, id: "skill-lifecycle", skill },
    "2026-09-15T00:00:00.000Z",
  );
  const approved = transitionTask(created, { type: "approve" }, context());
  const started = transitionTask(
    approved,
    { type: "start", worktree, endpoints: [endpoint(approved.generation)] },
    context(),
  );
  expect(started.skill).toEqual(skill);

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
  expect(awaitingFixes.skill).toEqual(skill);

  const fixing = transitionTask(
    awaitingFixes,
    { type: "begin-fixes", head: "head-1", generation: started.generation },
    context(),
  );
  expect(fixing.skill).toEqual(skill);
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
  expect(invalidated.skill).toEqual(skill);
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

test("requires current-head validation and all four current-generation lenses before ready", () => {
  let task = implementationToReviewing();
  expect(task.stage).toBe("reviewing");
  expect(() =>
    transitionTask(task, { type: "finish-review", head: "head-1", generation: 0 }, context()),
  ).toThrow(TaskTransitionError);
  expect(() =>
    transitionTask(
      task,
      { type: "record-review", review: review("behavior", true, "old-head", 0) },
      context(),
    ),
  ).toThrow(TaskTransitionError);

  for (const lens of ALL_REVIEW_LENSES) {
    task = transitionTask(task, { type: "record-review", review: review(lens) }, context());
  }
  expect(task.revision).toBe(8);
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
    transitionTask(task, { type: "record-review", review: review("behavior") }, context()),
  ).toThrow(TaskTransitionError);
});

test("rejects duplicate or stale review results and never treats blocking findings as a pass", () => {
  let task = implementationToReviewing();
  const blocking: ReviewResult = {
    ...review("behavior"),
    findings: [
      {
        id: "finding-1",
        severity: "P1",
        verdict: "confirmed",
        description: "A blocking behavior defect",
      },
    ],
  };
  expect(() =>
    transitionTask(task, { type: "record-review", review: blocking }, context()),
  ).toThrow(TaskTransitionError);
  task = transitionTask(task, { type: "record-review", review: review("behavior") }, context());
  expect(() =>
    transitionTask(task, { type: "record-review", review: review("behavior") }, context()),
  ).toThrow(TaskTransitionError);
  expect(() =>
    transitionTask(
      task,
      { type: "record-review", review: review("design", true, "head-1", 99) },
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
  expect(task.validationEvidence).toHaveLength(0);
  expect(() =>
    transitionTask(task, { type: "begin-fixes", head: "head-1", generation: 1 }, context()),
  ).toThrow(TaskTransitionError);
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
    { type: "record-review", review: { ...review("behavior", false), findings: [blocker] } },
    context(),
  );
  expect(task.findingLedger).toHaveLength(1);
  expect(task.findingLedger?.[0]?.status).toBe("unresolved");
  expect(ledgerBlockers(task.findingLedger ?? []).map((entry) => entry.id)).toEqual(["finding-1"]);

  for (const lens of ["design", "coverage", "verification"] as const) {
    task = transitionTask(task, { type: "record-review", review: review(lens, false) }, context());
  }
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
    { type: "record-review", review: review("behavior", true, "head-2", 1) },
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

test("a request pull request merges a member only with proof that it carries its reviewed work", () => {
  const ready = { ...readyImplementation(), requestId: "req-1" };
  const pullRequest = {
    repository: "org/repo",
    number: 42,
    state: "merged" as const,
    head: "integrated-head-1",
    base: "main",
  };

  const merged = transitionTask(
    ready,
    {
      type: "merge",
      approved: true,
      verified: true,
      pullRequest,
      requestDelivery: {
        requestId: "req-1",
        integratedHead: "integrated-head-1",
        memberHead: "head-1",
      },
    },
    context(),
  );

  expect(merged.stage).toBe("merged");
  expect(merged.notifications.at(-1)?.message).toContain("as part of request req-1");
});

test("a request delivery proof that names another member or request is refused", () => {
  const ready = { ...readyImplementation(), requestId: "req-1" };
  const pullRequest = {
    repository: "org/repo",
    number: 42,
    state: "merged" as const,
    head: "integrated-head-1",
    base: "main",
  };

  expect(() =>
    transitionTask(
      ready,
      {
        type: "merge",
        approved: true,
        verified: true,
        pullRequest,
        requestDelivery: {
          requestId: "req-1",
          integratedHead: "integrated-head-1",
          memberHead: "head-2",
        },
      },
      context(),
    ),
  ).toThrow(/does not show that/u);

  expect(() =>
    transitionTask(
      ready,
      {
        type: "merge",
        approved: true,
        verified: true,
        pullRequest,
        requestDelivery: {
          requestId: "req-2",
          integratedHead: "integrated-head-1",
          memberHead: "head-1",
        },
      },
      context(),
    ),
  ).toThrow(/does not show that/u);
});

test("without a request delivery proof a merge still has to be the reviewed head", () => {
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
