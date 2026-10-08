import { expect, mock, test } from "bun:test";
import type { BlockCause, Endpoint } from "../../src/contracts.ts";
import type { CentralRecoveryAction } from "../../src/recovery/central.ts";
import type { DurableJob, DurableReservation, RuntimeTaskState } from "../../src/runtime/schema.ts";
import { type LiveTaskDependencies, LiveTaskWorkflow } from "../../src/service/live-task.ts";
import type { LiveTaskStep } from "../../src/service/reconcile-step.ts";
import type { ReservationResult } from "../../src/workers/admission.ts";
import { task } from "../session/fixtures.ts";

const record = task({ stage: "implementing" });
const writer: Endpoint = {
  terminal: "herdr",
  sessionId: "session-1",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
  role: "implementer",
  generation: 0,
};
const runtime: RuntimeTaskState = {
  schemaVersion: 1,
  taskId: record.id,
  taskName: record.id,
  sourceCheckpoint: { head: "head", base: "head", diff: "", dirty: false, unmerged: false },
  endpoints: [writer],
  jobs: [],
  worktree: {
    root: "/pool",
    path: "/pool/task",
    name: "task",
    baseHead: "head",
    branch: "task",
    leaseId: "lease-1",
    leaseHolder: "session-1",
    leasedAt: record.createdAt,
  },
};
const reservation: DurableReservation = {
  schemaVersion: 1,
  id: "reservation-1",
  taskId: record.id,
  ownerSessionId: "session-1",
  phase: "reserved",
  createdAt: record.createdAt,
};
const cause: BlockCause = {
  group: "safety-stop",
  kind: "identity-mismatch",
  summary: "Stopped safely.",
  detail: "mismatch",
};

function fixture() {
  const events: string[] = [];
  const effect = (name: string) =>
    mock(async () => {
      events.push(name);
    });
  const deps = {
    worker: {
      reconcileJob: effect("reconcile-job"),
      reconcileOperation: effect("reconcile-operation"),
      startQueuedTask: effect("start-queued"),
      beginFixes: effect("begin-fixes"),
      startValidation: mock<LiveTaskDependencies["worker"]["startValidation"]>(async () => {
        events.push("validate");
        return undefined;
      }),
      advanceReview: effect("advance-review"),
      reserveTask: mock<LiveTaskDependencies["worker"]["reserveTask"]>(async () => {
        events.push("reserve");
        return { task: record, runtime, reservation };
      }),
      releaseUnlaunchedTaskReservation: effect("release"),
      launchAgent: effect("launch"),
    },
    recovery: {
      recoverStuckWorker: mock<LiveTaskDependencies["recovery"]["recoverStuckWorker"]>(async () => {
        events.push("recover");
        return { taskId: record.id, action: "skipped", reason: "fresh" };
      }),
    },
    cleanupSettledTask: effect("cleanup"),
    quarantineLegacyReservation: effect("quarantine"),
    blockTaskIfReconcileClaim: effect("block-claimed"),
    blockTask: mock<LiveTaskDependencies["blockTask"]>(async () => {
      events.push("block");
      return record;
    }),
  } satisfies LiveTaskDependencies;
  return { deps, events, workflow: new LiveTaskWorkflow(deps) };
}

test("job reconciliation finishes before settled resource cleanup, and failures retain resources", async () => {
  const job: DurableJob = {
    schemaVersion: 1,
    id: "job-1",
    taskId: record.id,
    generation: 0,
    role: "implementer",
    kind: "worker",
    phase: "running",
    cwd: "/pool/task",
    jobPath: "/job.json",
    attempt: 1,
    launchAttempted: true,
    resultPath: "/result.json",
    createdAt: record.createdAt,
  };
  const { deps, events, workflow } = fixture();
  await workflow.run(record, runtime, { kind: "reconcile-job", job });
  expect(deps.worker.reconcileJob).toHaveBeenCalledWith(record, runtime, job);
  expect(deps.cleanupSettledTask).toHaveBeenCalledWith(record.id);
  expect(events).toEqual(["reconcile-job", "cleanup"]);
  const error = new Error("reconciliation failed");
  deps.worker.reconcileJob.mockRejectedValueOnce(error);
  await expect(workflow.run(record, runtime, { kind: "reconcile-job", job })).rejects.toBe(error);
  expect(deps.cleanupSettledTask).toHaveBeenCalledTimes(1);
});

test("reservation decisions preserve the captured runtime, reservation, and cause", async () => {
  const { deps, workflow } = fixture();
  await workflow.run(record, runtime, {
    kind: "quarantine-legacy-reservation",
    reservation,
    cause,
  });
  expect(deps.quarantineLegacyReservation).toHaveBeenCalledWith(record, reservation, cause);
  await workflow.run(record, runtime, { kind: "block-claimed", reservation, cause });
  expect(deps.blockTaskIfReconcileClaim).toHaveBeenCalledWith(record, runtime, cause.detail, {
    runtimeError: true,
    reservation,
    cause,
  });
  await workflow.run(record, runtime, { kind: "block", cause });
  expect(deps.blockTask).toHaveBeenCalledWith(record.id, cause.summary, cause);
});

test("ordinary steps perform their selected effect once, and waiting performs none", async () => {
  const { deps, events, workflow } = fixture();
  const steps: readonly LiveTaskStep[] = [
    { kind: "reconcile-operation" },
    { kind: "start-queued" },
    { kind: "begin-fixes" },
    { kind: "recover-stuck-writer" },
    { kind: "wait" },
  ];
  for (const step of steps) await workflow.run(record, runtime, step);
  expect(events).toEqual(["reconcile-operation", "start-queued", "begin-fixes", "recover"]);
  expect(deps.worker.reconcileOperation).toHaveBeenCalledWith(record, runtime);
  expect(deps.worker.startQueuedTask).toHaveBeenCalledWith(record);
  expect(deps.worker.beginFixes).toHaveBeenCalledWith(record);
  expect(deps.recovery.recoverStuckWorker).toHaveBeenCalledWith(record);
});

test("validation and review advance only after central recovery skips re-entry", async () => {
  const actions: readonly CentralRecoveryAction[] = [
    "skipped",
    "relaunched",
    "adopted",
    "resumed",
    "asked",
    "blocked",
    "waiting",
  ];
  const kinds = ["validate", "advance-review"] as const;
  for (const kind of kinds) {
    for (const action of actions) {
      const { deps, events, workflow } = fixture();
      deps.recovery.recoverStuckWorker.mockImplementationOnce(async () => {
        events.push("recover");
        return { taskId: record.id, action, reason: "recovery outcome" };
      });
      await workflow.run(record, runtime, { kind });
      expect(events).toEqual(action === "skipped" ? ["recover", kind] : ["recover"]);
    }
    const { deps, workflow } = fixture();
    const error = new Error("recovery failed");
    deps.recovery.recoverStuckWorker.mockRejectedValueOnce(error);
    await expect(workflow.run(record, runtime, { kind })).rejects.toBe(error);
    expect(deps.worker.startValidation).not.toHaveBeenCalled();
    expect(deps.worker.advanceReview).not.toHaveBeenCalled();
  }
});

test("writer refusal returns without releasing, blocking, or launching", async () => {
  const { deps, events, workflow } = fixture();
  deps.worker.reserveTask.mockImplementationOnce(async () => {
    events.push("reserve");
    return { refusal: "slot-held", summary: "Held.", detail: "held" };
  });
  await workflow.run(record, runtime, { kind: "launch-writer" });
  expect(deps.worker.reserveTask).toHaveBeenCalledWith(record.id, "implementer");
  expect(events).toEqual(["reserve"]);
});

test("missing admitted writer resources release the reservation before reporting the exact block", async () => {
  const { worktree: _worktree, ...withoutWorktree } = runtime;
  for (const admittedRuntime of [withoutWorktree, { ...runtime, endpoints: [] }]) {
    const { deps, events, workflow } = fixture();
    deps.worker.reserveTask.mockImplementationOnce(async () => {
      events.push("reserve");
      return { task: record, runtime: admittedRuntime, reservation };
    });
    await workflow.run(record, runtime, { kind: "launch-writer" });
    expect(events).toEqual(["reserve", "release", "block"]);
    expect(deps.worker.releaseUnlaunchedTaskReservation).toHaveBeenCalledWith(
      record.id,
      reservation.id,
    );
    expect(deps.blockTask).toHaveBeenCalledWith(
      record.id,
      "The worker's terminal and files are gone.",
      {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The worker's terminal and files are gone.",
        detail: "task is implementing but its worker resources are missing",
      },
    );
  }
});

test("writer launch uses the admitted task, runtime, writer, and role", async () => {
  const { deps, events, workflow } = fixture();
  const admitted: ReservationResult = {
    task: task({ kind: "scout", stage: "scouting", generation: 1 }),
    runtime: { ...runtime, endpoints: [{ ...writer, role: "scout", generation: 1 }] },
    reservation,
  };
  deps.worker.reserveTask.mockImplementationOnce(async () => {
    events.push("reserve");
    return admitted;
  });
  await workflow.run(record, runtime, { kind: "launch-writer" });
  expect(events).toEqual(["reserve", "launch"]);
  expect(deps.worker.launchAgent).toHaveBeenCalledWith(
    admitted.task,
    admitted.runtime,
    admitted.runtime.endpoints[0],
    "scout",
  );
});
