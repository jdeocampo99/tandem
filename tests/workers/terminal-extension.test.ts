import { expect, test } from "bun:test";
import type { WorkerJob } from "../../src/workers/jobs.ts";
import { planAbortWithReason, userInterruptedTurn } from "../../src/workers/terminal-extension.ts";

function job(): WorkerJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "implementer",
    cwd: "/tmp/worktree",
    model: { model: "test/model", thinking: "low" },
    prompt: "implement the change",
    resultPath: "/tmp/worktree/result.json",
  };
}

test("planAbortWithReason persists a durable failure carrying the real reason", () => {
  const plan = planAbortWithReason(
    job(),
    { resultPublished: false, delegatedSettled: false },
    "interactive worker heartbeat could not be persisted: ENOSPC",
  );
  expect(plan.shouldPersistResult).toBe(true);
  expect(plan.result?.status).toBe("failed");
  expect(plan.result?.error).toBe("interactive worker heartbeat could not be persisted: ENOSPC");
  expect(plan.result?.id).toBe("job-1");
  expect(plan.result?.taskId).toBe("task-1");
  expect(plan.result?.generation).toBe(0);
  expect(plan.result?.role).toBe("implementer");
});

test("planAbortWithReason never publishes a second result once one is already published", () => {
  const plan = planAbortWithReason(
    job(),
    { resultPublished: true, delegatedSettled: false },
    "interactive worker control polling failed: ECONNRESET",
  );
  expect(plan.shouldPersistResult).toBe(false);
  expect(plan.result).toBeUndefined();
});

test("planAbortWithReason never publishes once a delegated agent-end already settled", () => {
  const plan = planAbortWithReason(
    job(),
    { resultPublished: false, delegatedSettled: true },
    "interactive worker heartbeat could not be persisted: EIO",
  );
  expect(plan.shouldPersistResult).toBe(false);
  expect(plan.result).toBeUndefined();
});

test("planAbortWithReason carries the reason through untouched, not a bare 'aborted'", () => {
  const reason = "interactive worker control polling failed: the pane socket closed unexpectedly";
  const plan = planAbortWithReason(
    job(),
    { resultPublished: false, delegatedSettled: false },
    reason,
  );
  expect(plan.result?.error).toBe(reason);
  expect(plan.result?.error).not.toBe("aborted");
});

function agentEnd(stopReason: string): unknown {
  return { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason }] };
}

test("an Esc the extension did not request hands the worker to the person, not a failure", () => {
  expect(userInterruptedTurn(agentEnd("aborted"), false)).toBe(true);
});

test("an abort the extension requested still settles as a failure", () => {
  expect(userInterruptedTurn(agentEnd("aborted"), true)).toBe(false);
});

test("provider errors and normal turn ends are not user interrupts", () => {
  expect(userInterruptedTurn(agentEnd("error"), false)).toBe(false);
  expect(userInterruptedTurn(agentEnd("stop"), false)).toBe(false);
});
