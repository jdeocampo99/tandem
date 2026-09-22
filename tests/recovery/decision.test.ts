import { expect, test } from "bun:test";
import { blockCause } from "../../src/contracts.ts";
import {
  blockCauseEvidenceIdentity,
  classifyRecoveryEvidence,
  recoveryEvidenceIdentity,
} from "../../src/recovery/decision.ts";

const NOW = "2030-01-01T00:00:00.000Z";

test("a block cause's evidence identity is stable across a reworded summary", () => {
  const first = blockCauseEvidenceIdentity({
    taskId: "task-1",
    generation: 0,
    kind: "resource-lost",
    jobId: "job-1",
  });
  const second = blockCauseEvidenceIdentity({
    taskId: "task-1",
    generation: 0,
    kind: "resource-lost",
    jobId: "job-1",
  });
  expect(first).toBe(second);
});

test("a block cause's evidence identity changes with kind, job, task, or generation", () => {
  const base = blockCauseEvidenceIdentity({
    taskId: "task-1",
    generation: 0,
    kind: "resource-lost",
    jobId: "job-1",
  });
  expect(
    blockCauseEvidenceIdentity({
      taskId: "task-1",
      generation: 0,
      kind: "allocation-failed",
      jobId: "job-1",
    }),
  ).not.toBe(base);
  expect(
    blockCauseEvidenceIdentity({
      taskId: "task-1",
      generation: 0,
      kind: "resource-lost",
      jobId: "job-2",
    }),
  ).not.toBe(base);
  expect(
    blockCauseEvidenceIdentity({ taskId: "task-2", generation: 0, kind: "resource-lost" }),
  ).not.toBe(base);
  expect(
    blockCauseEvidenceIdentity({ taskId: "task-1", generation: 1, kind: "resource-lost" }),
  ).not.toBe(base);
});

test("classifyRecoveryEvidence keys a typed cause's identity off the cause, not the free-text hash", () => {
  const cause = blockCause("resource-lost", {
    summary: "The task's worktree is missing, so no further work can run against it.",
    detail: "task is implementing but its durable worktree is missing",
    jobId: "job-1",
  });
  const first = classifyRecoveryEvidence({
    taskId: "task-1",
    generation: 0,
    blockers: [cause.summary],
    observedAt: NOW,
    cause,
  });
  // A later rewording of the plain-English summary (e.g. a copy edit at the blocking call site)
  // must not change the durable identity: it is derived from the cause's kind and job, never text.
  const reworded = blockCause("resource-lost", {
    summary: "This task cannot continue: its worktree can no longer be found.",
    detail: "task is implementing but its durable worktree is missing",
    jobId: "job-1",
  });
  const second = classifyRecoveryEvidence({
    taskId: "task-1",
    generation: 0,
    blockers: [reworded.summary],
    observedAt: NOW,
    cause: reworded,
  });
  expect(first?.identity).toBeDefined();
  expect(first?.identity).toBe(second?.identity);
  expect(first?.identity).toBe(
    blockCauseEvidenceIdentity({
      taskId: "task-1",
      generation: 0,
      kind: "resource-lost",
      jobId: "job-1",
    }),
  );
});

test("classifyRecoveryEvidence still hashes free text when no cause is recorded", () => {
  const evidence = classifyRecoveryEvidence({
    taskId: "task-1",
    generation: 0,
    blockers: ["some free-text blocker"],
    observedAt: NOW,
  });
  expect(evidence?.identity).toBe(
    recoveryEvidenceIdentity({
      taskId: "task-1",
      generation: 0,
      kind: "durable-blocker",
      summary: "some free-text blocker",
    }),
  );
});

test("classifyRecoveryEvidence never uses the typed-cause identity for a temporary-availability signal", () => {
  const cause = blockCause("resource-lost", {
    summary: "provider is rate limited, try again later",
    detail: "429 from provider",
    jobId: "job-1",
  });
  const evidence = classifyRecoveryEvidence({
    taskId: "task-1",
    generation: 0,
    blockers: [cause.summary],
    observedAt: NOW,
    cause,
  });
  expect(evidence?.kind).toBe("temporary-availability");
  expect(evidence?.identity).not.toBe(
    blockCauseEvidenceIdentity({
      taskId: "task-1",
      generation: 0,
      kind: "resource-lost",
      jobId: "job-1",
    }),
  );
});
