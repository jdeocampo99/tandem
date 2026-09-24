import { expect, test } from "bun:test";
import type { TaskRecord, TaskStage } from "../../src/contracts.ts";
import { type PoolMaintenanceResult, poolNotificationMessage } from "../../src/pool/policy.ts";
import type { RuntimeTaskState } from "../../src/runtime/schema.ts";
import {
  runtimeWithPoolAdmission,
  taskWithPoolAdmission,
} from "../../src/service/pool-admission.ts";
import { DEFAULT_REVIEW_LEVEL_POLICY } from "../../src/tasks/review-levels.ts";

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
  const notified = taskWithPoolAdmission(task("queued"), undefined, full, stamp);
  expect(notified.revision).toBe(2);
  expect(notified.notifications).toHaveLength(1);
  expect(notified.notifications[0]?.id).toBe("notification-1");
  expect(taskWithPoolAdmission(notified, undefined, full, stamp)).toBe(notified);
  const sameKey = task("queued");
  expect(taskWithPoolAdmission(sameKey, "capacity-insufficient", full, stamp)).toBe(sameKey);
  const running = task("implementing");
  expect(taskWithPoolAdmission(running, undefined, full, stamp)).toBe(running);
});

test("an allowed allocation withdraws pool notices and leaves a clean task untouched", () => {
  const notice = poolNotificationMessage("capacity-unknown", "unknown");
  const withNotice = task("queued", [{ id: "n", message: notice, acknowledged: false }]);
  const withdrawn = taskWithPoolAdmission(withNotice, "capacity-unknown", allowed, stamp);
  expect(withdrawn.notifications).toEqual([]);
  expect(withdrawn.revision).toBe(2);
  const clean = task("queued");
  expect(taskWithPoolAdmission(clean, undefined, allowed, stamp)).toBe(clean);
});
