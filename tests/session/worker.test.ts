import { expect, test } from "bun:test";
import type { ToolCall, ToolKind } from "../../src/session/events.ts";
import {
  idleAfterResult,
  implementerShellRefusal,
  mockupWriteDecision,
  reportlessTurnEnd,
  reviewShellRefusal,
  reviewSummary,
  submittedReportText,
  turnStalled,
  type WorkerDeps,
  WorkerSession,
  workerPaneStatus,
  workerToolRefusal,
} from "../../src/session/worker.ts";
import type { WorkerJob, WorkerResult } from "../../src/workers/jobs.ts";
import type {
  WorkerTerminalCommand,
  WorkerTerminalState,
  WorkerTokenTally,
} from "../../src/workers/terminal.ts";
import { VALIDATION_COMMAND_REFUSAL } from "../../src/workers/validation-commands.ts";
import { fakeSessionTime, recordingSessionHost } from "../evals/scenario.ts";

function job(overrides: Partial<WorkerJob> = {}): WorkerJob {
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
    ...overrides,
  } as WorkerJob;
}

function call(kind: ToolKind, extra: Partial<ToolCall> = {}): ToolCall {
  return { id: "call-1", name: kind, kind, ...extra };
}

/** A worker session over recording fakes; each fake records what the session asked of it. */
function workerSession(
  jobOverrides: Partial<WorkerJob> = {},
  depOverrides: Partial<WorkerDeps> = {},
) {
  const recording = recordingSessionHost({ answers: { selectedModel: "test/model" } });
  const time = fakeSessionTime();
  const states: WorkerTerminalState[] = [];
  const results: WorkerResult[] = [];
  const researchAnswers: { decisionId: string; resultPath: string; answer: string }[] = [];
  const tallies: WorkerTokenTally[] = [];
  const traces: string[] = [];
  const control: {
    command: WorkerTerminalCommand | undefined;
    failStateWrites: number;
    failResultWrites: number;
  } = { command: undefined, failStateWrites: 0, failResultWrites: 0 };
  const deps: WorkerDeps = {
    host: recording.host,
    clock: time.clock,
    timers: time.timers,
    status: undefined,
    job: job(jobOverrides),
    pid: 4242,
    terminal: {
      readCommand: async () => control.command,
      writeState: async (state) => {
        if (control.failStateWrites > 0) {
          control.failStateWrites -= 1;
          throw new Error("ENOSPC");
        }
        states.push(state);
      },
      writeTokenTally: async (tally) => {
        tallies.push(tally);
      },
    },
    persistResult: async (result) => {
      if (control.failResultWrites > 0) {
        control.failResultWrites -= 1;
        throw new Error("EIO");
      }
      results.push(result);
    },
    readReceipt: async () => undefined,
    gitStatus: async () => "",
    readFile: async (path) => `contents of ${path}`,
    copyAsset: async (input) => `${input.artifactDir}/${input.name}`,
    submitResearchFollowUp: async (answer) => {
      researchAnswers.push(answer);
    },
    trace: (event) => traces.push(event),
    ...depOverrides,
  };
  const session = new WorkerSession(deps);
  const aborts = () => recording.effects.filter((effect) => effect.type === "abort").length;
  return {
    session,
    recording,
    time,
    states,
    results,
    tallies,
    traces,
    control,
    researchAnswers,
    aborts,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test("a submitted worker whose pane stays idle for the grace period is done despite willContinue", () => {
  // The settings stall: submit_report, then agent_end with willContinue because a backgrounded
  // dev server was still running, then an idle pane with nothing queued from then on.
  const stalled = {
    completed: true,
    phase: "busy" as const,
    paneIdle: true,
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
  const base = { completed: true, phase: "busy" as const, paneIdle: true, pendingMessages: false };
  const later = { idleSince: 0, now: 60_000 };
  const cases = [
    { ...base, completed: false },
    { ...base, phase: "idle" as const },
    { ...base, paneIdle: false },
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

test("only read-only tools and the to-do list run once the worker is settled, timed out, paused, or completed", () => {
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
    for (const kind of ["read", "search", "web-search", "todo"] as const) {
      expect(workerToolRefusal(closed, kind)).toBeUndefined();
    }
    for (const kind of ["edit", "write", "shell", "mcp", "subagent", "other"] as const) {
      expect(workerToolRefusal(closed, kind)).toBe(
        "worker terminal is paused or completed; mutating tools are disabled",
      );
    }
  }
});

test("a PR reviewer's shell is limited to read-only commands; other workers are not", () => {
  const bash = (command?: string) =>
    call("shell", { name: "bash", ...(command === undefined ? {} : { command }) });
  expect(reviewShellRefusal(true, bash("git diff"))).toBeUndefined();
  expect(reviewShellRefusal(true, bash("rm -rf src"))).toBeString();
  expect(reviewShellRefusal(true, bash())).toBe("bash needs a command");
  expect(reviewShellRefusal(false, bash("rm -rf src"))).toBeUndefined();
  expect(reviewShellRefusal(true, call("read"))).toBeUndefined();
});

test("an implementer may not run a pinned validation command; other shell calls still run", () => {
  const bash = (command: string) => call("shell", { name: "bash", command });
  const pinned = ["bun run check", "bun test", "bun run lint"];
  for (const command of [
    "bun test",
    "bun run check && bun test && bun run lint",
    "env -u NO_COLOR -u TANDEM_WORKER_JOB_PATH bun test",
    "cd /tmp/worktree && CI=1  bun run lint 2>&1 | tail -20",
  ]) {
    expect(implementerShellRefusal(pinned, bash(command))).toBe(VALIDATION_COMMAND_REFUSAL);
  }
  for (const command of [
    "bun test tests/session/worker.test.ts",
    "bun run lint --write src/a.ts",
    "git status --short",
    "grep -rn test src",
  ]) {
    expect(implementerShellRefusal(pinned, bash(command))).toBeUndefined();
  }
  expect(implementerShellRefusal(undefined, bash("bun test"))).toBeUndefined();
  expect(implementerShellRefusal(pinned, call("read"))).toBeUndefined();
});

test("a multi-step validation command is refused only when run whole", () => {
  const bash = (command: string) => call("shell", { name: "bash", command });
  const pinned = ["cd app && npm test"];
  expect(implementerShellRefusal(pinned, bash("cd app && npm test"))).toBeString();
  expect(implementerShellRefusal(pinned, bash("cd app && ls"))).toBeUndefined();
});

test("an implementer session refuses its pinned validation commands through the tool guard", () => {
  const worker = workerSession({ validationCommands: ["bun test"] });
  expect(
    worker.session.guardToolCall(call("shell", { name: "bash", command: "bun test" })),
  ).toEqual({ block: true, reason: VALIDATION_COMMAND_REFUSAL });
  expect(
    worker.session.guardToolCall(call("shell", { name: "bash", command: "git diff" })),
  ).toEqual({ block: false });
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

test("a scout writes only inside the mockup folder it was asked to draw in", () => {
  const base = { role: "scout", cwd: "/tmp/worktree" } as const;
  const artifactDir = "/tmp/presentations/p-1";
  const write = (path: string) => call("write", { path });
  expect(mockupWriteDecision({ ...base, call: call("read"), artifactDir: undefined })).toBe(
    undefined,
  );
  expect(
    mockupWriteDecision({
      ...base,
      call: write(`${artifactDir}/artifact.html`),
      artifactDir: undefined,
    }),
  ).toMatchObject({ block: true });
  expect(
    mockupWriteDecision({ ...base, call: write(`${artifactDir}/artifact.html`), artifactDir }),
  ).toEqual({ block: false });
  for (const path of ["src/app.ts", "/tmp/presentations/p-10/artifact.html", "xd://mcp__tool"]) {
    expect(
      mockupWriteDecision({ ...base, call: call("edit", { path }), artifactDir }),
    ).toMatchObject({ block: true });
  }
  expect(mockupWriteDecision({ ...base, call: call("edit"), artifactDir })).toEqual({
    block: true,
    reason: "edit needs a path",
  });
  expect(mockupWriteDecision({ ...base, call: call("copy-asset"), artifactDir })).toEqual({
    block: false,
  });
  expect(
    mockupWriteDecision({
      role: "implementer",
      cwd: "/tmp/worktree",
      call: write("src/app.ts"),
      artifactDir: undefined,
    }),
  ).toBeUndefined();
});

test("a failed heartbeat publishes its real reason exactly once, then aborts", async () => {
  const worker = workerSession();
  await worker.session.onSessionStart();
  worker.control.failStateWrites = 2;
  // Two heartbeats fail back to back; only the first may publish a result.
  worker.time.advance(2_000);
  await settle();
  expect(worker.results).toHaveLength(1);
  expect(worker.results[0]?.status).toBe("failed");
  expect(worker.results[0]?.error).toBe(
    "interactive worker heartbeat could not be persisted: ENOSPC",
  );
  expect(worker.aborts()).toBe(2);
  worker.control.failStateWrites = 1;
  worker.time.advance(1_000);
  await settle();
  expect(worker.results).toHaveLength(1);
});

test("a heartbeat failure after the report was submitted aborts without a second result", async () => {
  const worker = workerSession();
  await worker.session.onSessionStart();
  expect(
    (await worker.session.submitReport({ outcome: "implemented", report: "Done." })).isError,
  ).toBe(false);
  worker.control.failStateWrites = 1;
  worker.time.advance(1_000);
  await settle();
  expect(worker.results.map((result) => result.status)).toEqual(["completed"]);
  expect(worker.aborts()).toBe(1);
});

test("an Esc the session did not request hands the worker to the person, not a failure", async () => {
  const worker = workerSession();
  await worker.session.onSessionStart();
  await worker.session.onAgentEnd({ willContinue: false, interrupted: true, failure: "aborted" });
  expect(worker.results).toHaveLength(0);
  expect(worker.states.at(-1)).toMatchObject({ phase: "idle", completed: false });
});

test("a failed turn end the session did not interrupt settles the job as failed", async () => {
  const worker = workerSession();
  await worker.session.onSessionStart();
  await worker.session.onAgentEnd({ willContinue: false, interrupted: false, failure: "429" });
  expect(worker.results[0]).toMatchObject({ status: "failed", error: "429" });
  expect(worker.states.at(-1)).toMatchObject({ phase: "idle", completed: true });
});

test("a timeout aborts a busy pane and settles failed once the aborted turn ends", async () => {
  const worker = workerSession({ timeoutMs: 100 });
  await worker.session.onSessionStart();
  worker.recording.answers.paneState = { idle: false, pendingMessages: false, draft: false };
  worker.time.advance(100);
  expect(worker.aborts()).toBe(1);
  expect(worker.session.guardToolCall(call("write", { path: "a.ts" }))).toMatchObject({
    block: true,
  });
  expect(worker.results).toHaveLength(0);
  await worker.session.onAgentEnd({ willContinue: false, interrupted: true });
  expect(worker.results[0]).toMatchObject({
    status: "failed",
    error: "worker timed out after 100ms",
  });
});

test("a stalled turn is stopped with a reminder, and a second stall fails the job", async () => {
  const worker = workerSession();
  await worker.session.onSessionStart();
  worker.session.onTurnStart();
  worker.time.advance(4 * 60_000);
  worker.session.onStreaming();
  worker.time.advance(4 * 60_000);
  expect(worker.aborts()).toBe(0);
  worker.time.advance(60_000);
  expect(worker.aborts()).toBe(1);
  // The watchdog's own abort resumes the worker with the reminder, not a failure.
  await worker.session.onAgentEnd({ willContinue: false, interrupted: true });
  expect(worker.results).toHaveLength(0);
  expect(worker.recording.effects.at(-1)).toMatchObject({
    type: "deliver",
    source: "stall-reminder",
    timing: "nextTurn",
    triggerTurn: true,
  });
  worker.session.onTurnStart();
  worker.time.advance(5 * 60_000);
  await settle();
  expect(worker.results[0]?.error).toBe(
    "worker stalled: no tool call for 5 minutes, again after a reminder",
  );
});

test("a turn Tandem started that ends without a report is reminded once, then fails", () => {
  expect(reportlessTurnEnd({ humanTurn: false, reminded: false })).toBe("remind");
  expect(reportlessTurnEnd({ humanTurn: false, reminded: true })).toBe("fail");
  expect(reportlessTurnEnd({ humanTurn: true, reminded: false })).toBe("conversation");
  expect(reportlessTurnEnd({ humanTurn: true, reminded: true })).toBe("conversation");
});

test("a scout that ends its turn without a report is reminded, then failed, never left idle", async () => {
  // The farewell-email scout: it read its prior report, said it was already submitted, and
  // stopped, leaving the task "researching" for hours with no result.
  const worker = workerSession({ role: "scout" });
  await worker.session.onSessionStart();
  await worker.session.onAgentEnd({ willContinue: false, interrupted: false });
  expect(worker.results).toHaveLength(0);
  expect(worker.recording.effects.at(-1)).toMatchObject({
    type: "deliver",
    source: "report-reminder",
    timing: "nextTurn",
    triggerTurn: true,
  });
  await worker.session.onAgentEnd({ willContinue: false, interrupted: false });
  expect(worker.results[0]).toMatchObject({
    status: "failed",
    error: "worker ended its turn without calling submit_report, again after a reminder",
  });
});

test("a reply to the person at the pane is conversation, not a missing report", async () => {
  const worker = workerSession({ role: "scout" });
  await worker.session.onSessionStart();
  for (let turn = 0; turn < 3; turn += 1) {
    worker.session.onHumanInput();
    await worker.session.onAgentEnd({ willContinue: false, interrupted: false });
  }
  expect(worker.results).toHaveLength(0);
  expect(worker.recording.effects.filter((effect) => effect.type === "deliver")).toEqual([]);
  expect(worker.states.at(-1)).toMatchObject({ phase: "idle", completed: false });
});

test("a background result waking a submitted worker is stopped, and the stop is no failure", async () => {
  const worker = workerSession();
  await worker.session.onSessionStart();
  worker.session.onContextBuild(true);
  expect(worker.aborts()).toBe(0);
  await worker.session.submitReport({ outcome: "implemented", report: "Done." });
  worker.session.onContextBuild(false);
  expect(worker.aborts()).toBe(0);
  worker.session.onContextBuild(true);
  expect(worker.aborts()).toBe(1);
});

test("terminal state writes land in the order the session made them", async () => {
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { session } = workerSession(
    {},
    {
      terminal: {
        readCommand: async () => undefined,
        writeState: async (state) => {
          if (order.length === 0) {
            order.push(`start ${state.phase}`);
            await firstWrite;
          }
          order.push(`wrote ${state.phase}`);
        },
        writeTokenTally: async () => {},
      },
    },
  );
  const started = session.onSessionStart();
  session.onTurnEnd(undefined);
  await settle();
  expect(order).toEqual(["start busy"]);
  releaseFirst();
  await started;
  await settle();
  expect(order).toEqual(["start busy", "wrote busy", "wrote idle"]);
});

test("a subagent's usage is tallied under the worker's own provider and model", async () => {
  const worker = workerSession();
  const counts = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 };
  worker.session.onTurnEnd({ provider: "openai", model: "luna", ...counts });
  worker.session.onToolEnd({ call: call("subagent"), subagentUsage: counts });
  worker.session.onToolEnd({ call: call("read") });
  await settle();
  expect(worker.tallies.at(-1)).toMatchObject({
    provider: "openai",
    model: "luna",
    inputTokens: 20,
    replies: 2,
  });
});

test("an ask tool shows the pane waiting for an answer until it ends", () => {
  const reports: string[] = [];
  const { session } = workerSession(
    {},
    {
      status: {
        report: async (state, message) => {
          reports.push(`${state} ${message ?? ""}`.trim());
        },
        release: async () => {},
      },
    },
  );
  session.onToolStart(call("ask", { id: "ask-1" }));
  session.onToolEnd({ call: call("ask", { id: "ask-1" }) });
  expect(reports).toEqual(["blocked Waiting for your answer", "working"]);
});

test("a submission from the wrong model settles failed; a rejection goes back to the worker", async () => {
  const worker = workerSession();
  worker.recording.answers.selectedModel = "test/other";
  expect(await worker.session.submitReport({ outcome: "implemented", report: "Done." })).toEqual({
    text: "Report submitted with status failed: selected test/other, expected test/model",
    isError: false,
  });

  const rejecting = workerSession();
  const rejected = await rejecting.session.submitReport({ outcome: "completed", report: "Done." });
  expect(rejected.isError).toBe(true);
  expect(rejected.text).toStartWith("Report rejected: outcome must be one of implemented");
  expect(rejecting.results).toHaveLength(0);
});

test("copy_asset works only while a scout draws a mockup", async () => {
  const worker = workerSession({ role: "scout" });
  await worker.session.onSessionStart();
  expect(await worker.session.copyAsset("public/a.webp", "a.webp")).toEqual({
    text: "copy_asset only works while drawing a mockup.",
    isError: true,
  });
  await worker.session.submitReport({ outcome: "completed", report: "Findings." });
  await worker.session.onAgentEnd({ willContinue: false, interrupted: false });
  worker.control.command = {
    schemaVersion: 1,
    id: "mockup-1",
    jobId: "job-1",
    taskId: "task-1",
    generation: 0,
    action: "mockup",
    expiresAt: "2030-01-01T00:10:00.000Z",
    mockup: { briefPath: "/tmp/brief.md", artifactDir: "/tmp/p-1" },
  };
  worker.time.advance(250);
  await settle();
  expect(worker.recording.effects.at(-1)).toEqual({
    type: "promptAsUser",
    text: "contents of /tmp/brief.md",
  });
  expect(await worker.session.copyAsset("public/a.webp", "a.webp")).toEqual({
    text: "Copied to /tmp/p-1/a.webp; reference it as ./a.webp.",
    isError: false,
  });
  expect(worker.session.guardToolCall(call("write", { path: "/tmp/p-1/index.html" }))).toEqual({
    block: false,
  });
  expect(worker.session.guardToolCall(call("write", { path: "src/app.ts" }))).toMatchObject({
    block: true,
  });
});

test("an implementer cannot report done while a playbook step is open in its to-do list", async () => {
  const worker = workerSession({ playbookSteps: ["Reproduce the bug", "Add a regression test"] });
  worker.session.onToolEnd({
    call: call("todo"),
    todos: [
      { content: "Reproduce the bug", status: "completed" },
      { content: "Add a regression test", status: "in_progress" },
    ],
  });
  const rejected = await worker.session.submitReport({ outcome: "implemented", report: "Done." });
  expect(rejected.isError).toBe(true);
  expect(rejected.text).toContain("still open in your to-do list: Add a regression test.");
  expect(worker.results).toHaveLength(0);

  worker.session.onToolEnd({
    call: call("todo"),
    todos: [
      { content: "Reproduce the bug", status: "completed" },
      { content: "Add a regression test", status: "abandoned" },
    ],
  });
  const accepted = await worker.session.submitReport({ outcome: "implemented", report: "Done." });
  expect(accepted.isError).toBe(false);
});
test("a completed scout answers a focused question in the same read-only session", async () => {
  const worker = workerSession({ role: "scout", generation: 2 });
  await worker.session.onSessionStart();
  await worker.session.submitReport({ outcome: "completed", report: "Original findings." });
  await worker.session.onAgentEnd({ willContinue: false, interrupted: false });
  expect(worker.results).toHaveLength(1);
  expect(worker.session.guardToolCall(call("research-follow-up"))).toMatchObject({ block: true });

  worker.control.command = {
    schemaVersion: 1,
    id: "decision-1",
    jobId: "job-1",
    taskId: "task-1",
    generation: 2,
    action: "research-follow-up",
    expiresAt: "2030-01-01T00:10:00.000Z",
    researchFollowUp: {
      decisionId: "decision-1",
      briefPath: "/tmp/job-1/research-brief.txt",
      resultPath: "/tmp/job-1/research-result.json",
    },
  };
  worker.time.advance(250);
  await settle();

  expect(worker.recording.effects.at(-1)).toEqual({
    type: "promptAsUser",
    text: "contents of /tmp/job-1/research-brief.txt",
  });
  expect(worker.session.guardToolCall(call("research-follow-up"))).toEqual({ block: false });
  expect(worker.session.guardToolCall(call("write", { path: "src/app.ts" }))).toMatchObject({
    block: true,
  });
  expect(await worker.session.submitResearchFollowUp("Keep the source workspace unchanged.")).toEqual({
    text: "Research follow-up answer submitted.",
    isError: false,
  });
  await worker.session.onAgentEnd({ willContinue: false, interrupted: false });

  expect(worker.researchAnswers).toEqual([
    {
      decisionId: "decision-1",
      resultPath: "/tmp/job-1/research-result.json",
      answer: "Keep the source workspace unchanged.",
    },
  ]);
  expect(worker.results).toHaveLength(1);
  expect(worker.states.at(-1)).toMatchObject({
    phase: "idle",
    completed: true,
    settledCommandId: "decision-1",
  });
  expect(worker.session.guardToolCall(call("research-follow-up"))).toMatchObject({ block: true });

  worker.time.advance(250);
  await settle();
  expect(worker.recording.effects.filter((effect) => effect.type === "promptAsUser")).toHaveLength(1);
});
