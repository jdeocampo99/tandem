import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { WorkerJob } from "../../src/workers/jobs.ts";
import {
  idleAfterResult,
  isBackgroundResultWake,
  planAbortWithReason,
  reviewShellRefusal,
  reviewSummary,
  submittedReportText,
  turnStalled,
  userInterruptedTurn,
  workerPaneStatus,
  workerToolRefusal,
} from "../../src/workers/terminal-extension.ts";

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

test("only a finished background command's wake-up counts as a background wake", () => {
  const assistant = { role: "assistant", content: [], timestamp: 1 } as unknown as AgentMessage;
  const backgroundResult = {
    role: "custom",
    customType: "async-result",
    content: "bg_1 finished",
    display: true,
    timestamp: 2,
  } as unknown as AgentMessage;
  const typed = { role: "user", content: "one more thing", timestamp: 3 } as AgentMessage;
  const inbox = { ...typed, synthetic: true } as AgentMessage;

  expect(isBackgroundResultWake([assistant, backgroundResult])).toBe(true);
  // Tandem's inbox rendering is appended as a synthetic message and is not a new request.
  expect(isBackgroundResultWake([assistant, backgroundResult, inbox])).toBe(true);
  expect(isBackgroundResultWake([assistant, backgroundResult, typed])).toBe(false);
  expect(isBackgroundResultWake([assistant, inbox])).toBe(false);
  expect(isBackgroundResultWake([])).toBe(false);
});

test("a submitted worker OMP keeps idle for the grace period is done despite willContinue", () => {
  // The settings stall: submit_report, then agent_end with willContinue because a backgrounded
  // dev server was still running, then OMP idle with nothing queued from then on.
  const stalled = {
    completed: true,
    phase: "busy" as const,
    ompIdle: true,
    pendingMessages: false,
  };
  const first = idleAfterResult({ ...stalled, idleSince: undefined, now: 0 });
  expect(first).toEqual({ idleSince: 0, settle: false });
  expect(idleAfterResult({ ...stalled, idleSince: 0, now: 29_999 }).settle).toBe(false);
  expect(idleAfterResult({ ...stalled, idleSince: 0, now: 30_000 })).toEqual({
    idleSince: undefined,
    settle: true,
  });
});

test("idle-after-result never settles an unsubmitted, working, or messaged worker", () => {
  const base = { completed: true, phase: "busy" as const, ompIdle: true, pendingMessages: false };
  const later = { idleSince: 0, now: 60_000 };
  const cases = [
    { ...base, completed: false },
    { ...base, phase: "idle" as const },
    { ...base, ompIdle: false },
    { ...base, pendingMessages: true },
  ];
  for (const input of cases) {
    expect(idleAfterResult({ ...input, ...later })).toEqual({
      idleSince: undefined,
      settle: false,
    });
  }
});

test("a submitted review reads as its round, verdict, and one line per finding by severity", () => {
  const summary = reviewSummary(
    {
      lens: "review",
      head: "21260599aae29357e2d6f2ca3bd06ab2d43eeb2e",
      generation: 1,
      pass: false,
      summary: "Long reviewer notes that stay in the durable result.",
      findings: [
        {
          id: "review/tablet",
          severity: "P2",
          verdict: "plausible",
          description: "Tablet-width navigation stacks above the section. More detail follows.",
        },
        {
          id: "review/entrance",
          severity: "P1",
          verdict: "confirmed",
          file: "src/components/motion/page-transition.tsx",
          line: 188,
          description: `Referrals content enters at zero opacity ${"x".repeat(200)}`,
        },
      ],
    },
    2,
  );
  const lines = summary.split("\n");
  expect(lines[0]).toBe("Review round 2: changes needed, 2 findings");
  expect(lines[1]).toStartWith("- P1 Referrals content enters at zero opacity");
  expect(lines[1]).toContain("…");
  expect(lines[1]).toEndWith("(src/components/motion/page-transition.tsx:188)");
  expect(lines[2]).toBe("- P2 Tablet-width navigation stacks above the section. [unconfirmed]");
  expect(summary).not.toContain("21260599");
  expect(summary).not.toContain("generation");
});

test("a clean review, or one from a job without a round, still reads plainly", () => {
  const clean = {
    lens: "review" as const,
    head: "head",
    generation: 0,
    pass: true,
    summary: "",
    findings: [],
  };
  expect(reviewSummary(clean, 1)).toBe("Review round 1: approved, no findings.");
  expect(reviewSummary(clean, undefined)).toBe("Review: approved, no findings.");
  const knownIssueOnly = {
    ...clean,
    pass: false,
    findings: [
      { id: "f", severity: "P2" as const, verdict: "confirmed" as const, description: "Minor." },
    ],
  };
  expect(reviewSummary(knownIssueOnly, 1)).toBe("Review round 1: approved, 1 finding\n- P2 Minor.");
});

test("a turn with no tool activity for five minutes is stalled", () => {
  const quiet = { turnActive: true, toolsRunning: 0, lastActivityAt: 0 };
  expect(turnStalled({ ...quiet, now: 5 * 60_000 - 1 })).toBe(false);
  expect(turnStalled({ ...quiet, now: 5 * 60_000 })).toBe(true);
});

test("a running tool or a finished turn is never stalled", () => {
  const late = { lastActivityAt: 0, now: 60 * 60_000 };
  expect(turnStalled({ ...late, turnActive: true, toolsRunning: 1 })).toBe(false);
  expect(turnStalled({ ...late, turnActive: false, toolsRunning: 0 })).toBe(false);
});

test("only read-only tools run once the worker is settled, timed out, paused, or completed", () => {
  const open = {
    delegatedSettled: false,
    timeoutRequested: false,
    pauseRequested: false,
    phase: "busy" as const,
    completed: false,
  };
  expect(workerToolRefusal(open, "edit")).toBeUndefined();
  for (const closed of [
    { ...open, delegatedSettled: true },
    { ...open, timeoutRequested: true },
    { ...open, pauseRequested: true },
    { ...open, phase: "paused" as const },
    { ...open, completed: true },
  ]) {
    expect(workerToolRefusal(closed, "read")).toBeUndefined();
    expect(workerToolRefusal(closed, "edit")).toEqual({
      block: true,
      reason: "worker terminal is paused or completed; mutating tools are disabled",
    });
  }
});

test("a PR reviewer's bash is limited to read-only commands; other workers are not", () => {
  const bash = (input: unknown) => ({ toolName: "bash", input });
  expect(reviewShellRefusal(true, bash({ command: "git diff" }))).toBeUndefined();
  expect(reviewShellRefusal(true, bash({ command: "rm -rf src" }))?.block).toBe(true);
  expect(reviewShellRefusal(true, bash({}))).toEqual({
    block: true,
    reason: "bash needs a command",
  });
  expect(reviewShellRefusal(false, bash({ command: "rm -rf src" }))).toBeUndefined();
  expect(reviewShellRefusal(true, { toolName: "read", input: {} })).toBeUndefined();
});

test("the worker pane shows pause, then a pending answer, then work, then the settled outcome", () => {
  const settled = {
    paused: false,
    waitingForAnswer: false,
    agentActive: false,
    settled: "blocked" as const,
    settledMessage: "tests failed",
  };
  expect(workerPaneStatus({ ...settled, paused: true, waitingForAnswer: true })).toEqual({
    state: "blocked",
    message: "Worker paused",
  });
  expect(workerPaneStatus({ ...settled, waitingForAnswer: true, agentActive: true })).toEqual({
    state: "blocked",
    message: "Waiting for your answer",
  });
  expect(workerPaneStatus({ ...settled, agentActive: true })).toEqual({
    state: "working",
    message: undefined,
  });
  expect(workerPaneStatus(settled)).toEqual({ state: "blocked", message: "tests failed" });
});

test("submit_report confirms the status, or for a review, the summary to reply with", () => {
  const base = {
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "implementer" as const,
    text: "",
    finishedAt: "2030-01-01T00:00:00.000Z",
  };
  expect(submittedReportText({ ...base, status: "completed" }, undefined)).toBe(
    "Report submitted with status completed.",
  );
  expect(submittedReportText({ ...base, status: "failed", error: "no tests" }, undefined)).toBe(
    "Report submitted with status failed: no tests",
  );
  const review = { lens: "review" as const, head: "h", generation: 0, pass: true };
  expect(
    submittedReportText(
      {
        ...base,
        role: "reviewer",
        status: "completed",
        review: { ...review, summary: "", findings: [] },
      },
      2,
    ),
  ).toBe(
    "Review round 2: approved, no findings.\n\nEnd your turn by replying with exactly this summary and nothing else.",
  );
});
