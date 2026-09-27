import { expect, test } from "bun:test";
import type { TaskRecord, TaskStage } from "../../src/contracts.ts";
import { type PoolMaintenanceResult, poolNotificationMessage } from "../../src/pool/policy.ts";
import type { RuntimeTaskState } from "../../src/runtime/schema.ts";
import {
  runtimeWithPoolAdmission,
  taskWithPoolAdmission,
} from "../../src/service/pool-admission.ts";
import { latestAdmissionWait, poolAdmissionWaitReason } from "../../src/workers/admission.ts";

const NOW = "2026-09-24T00:00:00.000Z";
const stamp = { clock: () => NOW, notificationId: () => "notification-1" };

const allowed: PoolMaintenanceResult = {
  canAllocate: true,
  availableBytes: 1_000,
  removedPaths: [],
  retainedPaths: [],
  warnings: [],
};
const full: PoolMaintenanceResult = { ...allowed, canAllocate: false, availableBytes: 10 };

function task(stage: TaskStage, notifications: TaskRecord["notifications"] = []): TaskRecord {
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
        maxFixRounds: 1,
      },
      guidance: { implementation: [], validation: [], review: [] },
    },
    createdAt: NOW,
    updatedAt: NOW,
    generation: 1,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    notifications,
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

test("a blocked allocation records its notice as the runtime's pool notice and last error", () => {
  const next = runtimeWithPoolAdmission(runtime(), full);
  expect(next.poolAdmissionKey).toBe("capacity-insufficient");
  expect(next.poolNotice).toBeString();
  expect(next.lastError).toBe(next.poolNotice);
});

test("an allowed allocation clears the pool notice but keeps an unrelated last error", () => {
  const blocked = runtimeWithPoolAdmission(runtime(), full);
  const cleared = runtimeWithPoolAdmission(blocked, allowed);
  expect(cleared.poolAdmissionKey).toBeUndefined();
  expect(cleared.poolNotice).toBeUndefined();
  expect(cleared.lastError).toBeUndefined();
  const unrelated = runtimeWithPoolAdmission({ ...blocked, lastError: "other" }, allowed);
  expect(unrelated.lastError).toBe("other");
});

test("a queued task is notified once per new blocking reason", () => {
  const notified = taskWithPoolAdmission(task("queued"), undefined, full, stamp).task;
  expect(notified.revision).toBe(2);
  expect(notified.notifications).toHaveLength(1);
  expect(notified.notifications[0]?.id).toBe("notification-1");
  expect(taskWithPoolAdmission(notified, undefined, full, stamp).task).toBe(notified);
  const sameKey = task("queued");
  const keyed = runtime({ poolAdmissionKey: "capacity-insufficient" });
  expect(taskWithPoolAdmission(sameKey, keyed, full, stamp)).toEqual({ task: sameKey });
  const running = task("implementing");
  expect(taskWithPoolAdmission(running, undefined, full, stamp).task).toBe(running);
});

test("an allowed allocation withdraws pool notices and leaves a clean task untouched", () => {
  const notice = poolNotificationMessage("capacity-unknown", "unknown");
  const withNotice = task("queued", [{ id: "n", message: notice, acknowledged: false }]);
  const keyed = runtime({ poolAdmissionKey: "capacity-unknown" });
  const withdrawn = taskWithPoolAdmission(withNotice, keyed, allowed, stamp);
  expect(withdrawn.task.notifications).toEqual([]);
  expect(withdrawn.task.revision).toBe(2);
  expect(withdrawn.note).toBeUndefined();
  const clean = task("queued");
  expect(taskWithPoolAdmission(clean, runtime(), allowed, stamp)).toEqual({ task: clean });
});

test("a queued task's admission wait is noted when its pool reason is new or changes", () => {
  const first = taskWithPoolAdmission(task("queued"), runtime(), full, stamp);
  expect(first.note).toEqual({
    admissionWait: "worktree-disk-space",
    cause: "pool has insufficient free space for a new worktree; free space and retry",
  });
  expect(first.task.notifications).toHaveLength(1);

  // The same reason again is not recorded twice, even across scheduler passes.
  const again = runtimeWithPoolAdmission(runtime(), full);
  expect(taskWithPoolAdmission(first.task, again, full, stamp)).toEqual({ task: first.task });

  // A changed reason is recorded even when its notification already stands.
  const unknown: PoolMaintenanceResult = { ...full, availableBytes: null };
  const notice = poolNotificationMessage("capacity-unknown", "unknown");
  const notified = task("queued", [{ id: "n", message: notice, acknowledged: false }]);
  const changed = taskWithPoolAdmission(notified, again, unknown, stamp);
  expect(changed.note?.admissionWait).toBe("worktree-capacity-unknown");
  expect(changed.task.revision).toBe(2);
  expect(changed.task.notifications).toEqual(notified.notifications);

  // Only a queued task waits for admission, and a task with no runtime record remembers nothing.
  expect(taskWithPoolAdmission(task("implementing"), runtime(), full, stamp).note).toBeUndefined();
  expect(taskWithPoolAdmission(task("queued"), undefined, full, stamp).note).toBeUndefined();
});

test("a routing question standing on the runtime record is the latest admission wait", () => {
  expect(latestAdmissionWait(runtime())).toBeUndefined();
  expect(latestAdmissionWait(runtime({ poolAdmissionKey: "capacity-unknown" }))).toBe(
    "worktree-capacity-unknown",
  );
  expect(poolAdmissionWaitReason("capacity-insufficient")).toBe("worktree-disk-space");
  expect(poolAdmissionWaitReason("something-else")).toBeUndefined();
});
