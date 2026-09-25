import { expect, test } from "bun:test";
import type { TaskRecord } from "../../src/contracts.ts";
import {
  atCompactionBoundary,
  coordinatorCompactTokens,
  DEFAULT_COORDINATOR_COMPACT_TOKENS,
  finishedTaskIds,
} from "../../src/session/compaction.ts";

function task(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-1",
    kind: "implementation",
    stage: "implementing",
    notifications: [],
    ...overrides,
  } as TaskRecord;
}

test("the compaction threshold defaults to 128k, accepts 0 to turn it off, and ignores junk", () => {
  expect(coordinatorCompactTokens({})).toBe(DEFAULT_COORDINATOR_COMPACT_TOKENS);
  expect(coordinatorCompactTokens({ TANDEM_COORDINATOR_COMPACT_TOKENS: " 90000 " })).toBe(90_000);
  expect(coordinatorCompactTokens({ TANDEM_COORDINATOR_COMPACT_TOKENS: "0" })).toBe(0);
  expect(coordinatorCompactTokens({ TANDEM_COORDINATOR_COMPACT_TOKENS: "-5" })).toBe(128_000);
  expect(coordinatorCompactTokens({ TANDEM_COORDINATOR_COMPACT_TOKENS: "lots" })).toBe(128_000);
});

test("only finished implementation tasks count as finished", () => {
  const ids = finishedTaskIds([
    task({ id: "done", stage: "completed" }),
    task({ id: "merged", stage: "merged" }),
    task({ id: "running", stage: "reviewing" }),
    task({ id: "pr-ready", stage: "ready" }),
    task({ id: "scout", kind: "scout", stage: "completed" }),
  ]);
  expect([...ids].sort()).toEqual(["done", "merged"]);
});

test("the boundary needs a finished task and an idle coordinator, and allows running tasks", () => {
  const running = [task({ stage: "implementing" }), task({ id: "t2", stage: "validating" })];
  expect(atCompactionBoundary(running, { taskFinished: true, idle: true })).toBe(true);
  expect(atCompactionBoundary(running, { taskFinished: false, idle: true })).toBe(false);
  expect(atCompactionBoundary(running, { taskFinished: true, idle: false })).toBe(false);
});

test("any task waiting on the user holds compaction back", () => {
  for (const stage of ["blocked", "paused", "awaiting-approval", "ready"] as const) {
    expect(atCompactionBoundary([task({ stage })], { taskFinished: true, idle: true })).toBe(false);
  }
  const unread = task({
    notifications: [{ id: "n1", message: "report ready", acknowledged: false }],
  } as Partial<TaskRecord>);
  expect(atCompactionBoundary([unread], { taskFinished: true, idle: true })).toBe(false);
});
