import { expect, test } from "bun:test";
import type { Endpoint, TaskRecord, TaskStage, WorktreeLease } from "../../src/contracts.ts";
import type { DurableJob, DurableReservation, RuntimeTaskState } from "../../src/runtime/schema.ts";
import { alreadyStopped, heldTaskStep, liveTaskStep } from "../../src/service/reconcile-step.ts";
import { durableOperation, makeDurableJob } from "../../src/service/records.ts";
import { DEFAULT_REVIEW_LEVEL_POLICY } from "../../src/tasks/review-levels.ts";

const NOW = "2026-09-24T00:00:00.000Z";

function task(stage: TaskStage): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 1,
    repoPath: "/repo",
    kind: "implementation",
    objective: "Bound the retry loop",
    acceptanceCriteria: [],
    surfaces: [],
    stage,
    scopeApproved: true,
    policy: {
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
        validationCommands: [],
        setupCommands: [],
        maxWorkers: 1,
        maxFixRounds: 1,
        reviewLevels: DEFAULT_REVIEW_LEVEL_POLICY,
      },
      guidance: { implementation: [], validation: [], review: [] },
    },
    createdAt: NOW,
    updatedAt: NOW,
    generation: 1,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    notifications: [],
  };
}

function runtime(overrides: Partial<RuntimeTaskState> = {}): RuntimeTaskState {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    sourceCheckpoint: { head: "h", base: "h", diff: "", dirty: false, unmerged: false },
    taskName: "task-1",
    endpoints: [],
    jobs: [],
    ...overrides,
  };
}

const worktree: WorktreeLease = {
  root: "/worktrees",
  path: "/worktrees/task-1",
  name: "task-1",
  baseHead: "h",
  branch: "tandem/task-1",
  leaseId: "lease-1",
  leaseHolder: "worker-1",
  leasedAt: NOW,
};

const writer: Endpoint = {
  sessionId: "s",
  workspaceId: "w",
  tabId: "t",
  paneId: "p",
  role: "implementer",
  generation: 1,
};

function reservation(operationId?: string): DurableReservation {
  return {
    schemaVersion: 1,
    id: "reservation-1",
    taskId: "task-1",
    ownerSessionId: "s",
    ...(operationId === undefined ? {} : { operationId }),
    phase: "reserved",
    createdAt: NOW,
  };
}

const operation = durableOperation(
  "operation-1",
  "task-1",
  "implementation",
  "implementer",
  1,
  "h",
  "digest",
  0,
  "job-1",
  "owner",
  NOW,
);

function runningJob(): DurableJob {
  return {
    ...makeDurableJob("task-1", 1, "implementer", "worker", "/w", "/j", "/r", 1, NOW),
    phase: "running",
  };
}

test("a stop request is settled before anything else, carrying its discard approval", () => {
  const stopRequest = {
    schemaVersion: 1,
    action: "cancel",
    generation: 1,
    requestedAt: NOW,
    discard: true,
  } as const;
  expect(heldTaskStep(task("implementing"), runtime({ stopRequest }))).toEqual({
    kind: "settle-stop-request",
    discard: true,
  });
});

test("held tasks: terminal releases resources, paused waits, blocked goes to recovery", () => {
  expect(heldTaskStep(task("merged"), runtime())).toEqual({ kind: "release-terminal-resources" });
  expect(heldTaskStep(task("paused"), runtime())).toEqual({ kind: "wait" });
  expect(heldTaskStep(task("blocked"), runtime())).toEqual({ kind: "recover-blocked" });
  expect(heldTaskStep(task("queued"), runtime())).toBeUndefined();
});

test("an active job is reconciled before the stage is considered", () => {
  const job = runningJob();
  expect(liveTaskStep(task("queued"), runtime({ jobs: [job] }))).toEqual({
    kind: "reconcile-job",
    job,
  });
});

test("a reservation without an operation is quarantined as legacy state", () => {
  const step = liveTaskStep(task("implementing"), runtime({ reservation: reservation() }));
  expect(step.kind).toBe("quarantine-legacy-reservation");
  if (step.kind === "quarantine-legacy-reservation") {
    expect(step.cause.kind).toBe("quarantined-unknown-outcome");
  }
});

test("a reservation that names another operation blocks without launching", () => {
  const step = liveTaskStep(
    task("implementing"),
    runtime({ reservation: reservation("other"), operation }),
  );
  expect(step.kind).toBe("block-claimed");
  if (step.kind === "block-claimed") expect(step.cause.kind).toBe("identity-mismatch");
});

test("a reservation matching its operation reconciles the operation", () => {
  expect(
    liveTaskStep(
      task("implementing"),
      runtime({ reservation: reservation("operation-1"), operation }),
    ),
  ).toEqual({ kind: "reconcile-operation" });
});

test("a released reservation does not hold the stage back", () => {
  const released = { ...reservation("operation-1"), phase: "released" } as const;
  expect(liveTaskStep(task("queued"), runtime({ reservation: released }))).toEqual({
    kind: "start-queued",
  });
});

test("each live stage maps to its scheduler step", () => {
  expect(liveTaskStep(task("awaiting-fixes"), runtime()).kind).toBe("begin-fixes");
  expect(liveTaskStep(task("validating"), runtime()).kind).toBe("validate");
  expect(liveTaskStep(task("reviewing"), runtime()).kind).toBe("advance-review");
  expect(liveTaskStep(task("ready"), runtime()).kind).toBe("wait");
});

test("a writer stage waits on a launch, blocks without a worktree, and recovers without a pane", () => {
  const launching = runtime({
    endpointLaunch: {
      schemaVersion: 1,
      reservationId: "reservation-1",
      sessionId: "s",
      taskName: "task-1",
      workspaceLabel: "task-1",
      cwd: "/worktrees/task-1",
      role: "implementer",
      generation: 1,
      createdAt: NOW,
    },
  });
  expect(liveTaskStep(task("implementing"), launching).kind).toBe("wait");
  const missing = liveTaskStep(task("scouting"), runtime());
  expect(missing.kind).toBe("block");
  if (missing.kind === "block") expect(missing.cause.kind).toBe("resource-lost");
  expect(liveTaskStep(task("implementing"), runtime({ worktree })).kind).toBe(
    "recover-stuck-writer",
  );
  expect(liveTaskStep(task("implementing"), runtime({ worktree, endpoints: [writer] })).kind).toBe(
    "launch-writer",
  );
});

test("terminal, paused, and blocked tasks are already stopped", () => {
  for (const stage of ["cancelled", "completed", "merged", "paused", "blocked"] as const) {
    expect(alreadyStopped(task(stage))).toBe(true);
  }
  expect(alreadyStopped(task("implementing"))).toBe(false);
});
