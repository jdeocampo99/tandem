import { expect, setSystemTime, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkerJob } from "../../src/worker.ts";
import type { WorkerJob, WorkerResult } from "../../src/workers/jobs.ts";
import {
  parseWorkerJob,
  parseWorkerResult,
  persistWorkerResult,
  readWorkerResult,
} from "../../src/workers/jobs.ts";
import type { SubmittedReport } from "../../src/workers/protocol.ts";
import {
  readWorkerTerminal,
  requestWorkerTerminalCommand,
  type WorkerTerminalJob,
} from "../../src/workers/terminal.ts";
import { registerWorkerTerminalExtension } from "../../src/workers/terminal-extension.ts";
import { validationCommandLine } from "../../src/workers/validation-commands.ts";

const MODEL = { provider: "openai-codex", id: "gpt-5.6-luna" };

type Handler = (event: unknown, context: unknown) => unknown | Promise<unknown>;
type SubmitReport = (
  toolCallId: string,
  params: SubmittedReport,
  signal: undefined,
  onUpdate: undefined,
  context: unknown,
) => Promise<unknown>;

type Fixture = {
  readonly handlers: Map<string, Handler>;
  readonly tools: Map<string, SubmitReport>;
  readonly intervals: Array<() => void>;
  readonly timeouts: Array<() => void>;
  readonly inputs: Array<(data: string) => unknown>;
  readonly state: { idle: boolean; aborts: number };
  readonly context: {
    readonly mode: "tui";
    readonly model: typeof MODEL;
    readonly ui: {
      readonly getEditorText: () => string;
      readonly onTerminalInput: (handler: (data: string) => unknown) => () => void;
    };
    readonly setInterval: (callback: (...args: unknown[]) => void, milliseconds?: number) => object;
    readonly setTimeout: (callback: (...args: unknown[]) => void, milliseconds?: number) => object;
    readonly clearTimer: (timer: object) => void;
    readonly isIdle: () => boolean;
    readonly hasPendingMessages: () => boolean;
    readonly sessionManager: {
      readonly getSessionFile: () => string | undefined;
      readonly getLeafId: () => string | null;
    };
    readonly abort: () => void;
    readonly shutdown: () => void;
  };
};

function fixture(): Fixture {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, SubmitReport>();
  const intervals: Array<() => void> = [];
  const timeouts: Array<() => void> = [];
  const inputs: Array<(data: string) => unknown> = [];
  const state = { idle: true, aborts: 0 };
  const context = {
    mode: "tui" as const,
    model: MODEL,
    ui: {
      getEditorText: () => "",
      onTerminalInput: (handler: (data: string) => unknown) => {
        inputs.push(handler);
        return () => {};
      },
    },
    setInterval(callback: (..._args: unknown[]) => void): object {
      intervals.push(callback as () => void);
      return {};
    },
    setTimeout(callback: (..._args: unknown[]) => void): object {
      timeouts.push(callback as () => void);
      return {};
    },
    clearTimer(_timer: object): void {},
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionFile: () => "/sessions/task-1/conversation.jsonl",
      getLeafId: () => "entry-7",
    },
    abort: () => {
      state.aborts += 1;
    },
    shutdown: () => undefined,
  };
  return { handlers, tools, intervals, timeouts, inputs, state, context };
}

function makeJob(root: string, role: WorkerJob["role"] = "implementer"): WorkerJob {
  const base = {
    schemaVersion: 1 as const,
    id: "job-1",
    taskId: "task-1",
    generation: 3,
    role,
    cwd: root,
    model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" as const },
    prompt: "Complete the approved worker brief.",
    resultPath: join(root, "result.json"),
  };
  return role === "reviewer"
    ? { ...base, review: { head: "abc123", lens: "review" as const } }
    : base;
}

function agentEnd(text: string, willContinue?: boolean): unknown {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        content: [{ type: "text", text }],
        stopReason: "stop",
      },
    ],
    ...(willContinue === undefined ? {} : { willContinue }),
  };
}

async function submitReport(
  f: Fixture,
  report: SubmittedReport,
  context: unknown = f.context,
): Promise<{ readonly isError?: boolean; readonly content: readonly { readonly text: string }[] }> {
  const execute = f.tools.get("submit_report");
  if (execute === undefined) throw new Error("missing submit_report tool");
  return (await execute("call-1", report, undefined, undefined, context)) as {
    readonly isError?: boolean;
    readonly content: readonly { readonly text: string }[];
  };
}

const IMPLEMENTED: SubmittedReport = { outcome: "implemented", report: "Committed the change." };

function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { findings: [], summary: "No behavior findings.", ...overrides };
}

function finding(severity: string): Record<string, unknown> {
  return {
    id: `f-${severity}`,
    severity,
    verdict: "confirmed",
    description: "Evidence.",
    category: "correctness",
    catchStage: "validation",
  };
}

async function startExtension(
  root: string,
  job: WorkerJob,
): Promise<{
  readonly fixture: Fixture;
  readonly terminalJob: WorkerTerminalJob;
}> {
  const jobPath = join(root, "job.json");
  await writeFile(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
  process.env.TANDEM_WORKER_JOB_PATH = jobPath;
  const testFixture = fixture();
  const pi = {
    on(event: string, handler: Handler): void {
      testFixture.handlers.set(event, handler);
    },
    registerTool(tool: { name: string; execute: SubmitReport }): void {
      testFixture.tools.set(tool.name, tool.execute);
    },
  };
  await registerWorkerTerminalExtension(pi as never);
  const sessionStart = testFixture.handlers.get("session_start");
  if (sessionStart === undefined) throw new Error("missing session_start handler");
  await sessionStart({ type: "session_start" }, testFixture.context);
  return {
    fixture: testFixture,
    terminalJob: {
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      role: job.role,
      cwd: job.cwd,
      jobPath,
    },
  };
}

test("a subagent's copy of the extension keeps the tool guard but never drives the job", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const job = makeJob(root);
    const { terminalJob } = await startExtension(root, job);
    const before = await readWorkerTerminal(terminalJob);

    // OMP loads a fresh copy into each subagent, in the same process and with the same job.
    const subagent = fixture();
    await registerWorkerTerminalExtension({
      on(event: string, handler: Handler): void {
        subagent.handlers.set(event, handler);
      },
      registerTool(tool: { name: string; execute: SubmitReport }): void {
        subagent.tools.set(tool.name, tool.execute);
      },
    } as never);

    expect([...subagent.handlers.keys()]).toEqual(["tool_call"]);
    expect(subagent.tools.size).toBe(0);
    expect(await readWorkerTerminal(terminalJob)).toEqual(before);
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("persists native result before process shutdown and keeps very large reports intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const job = makeJob(root);
    const { fixture: testFixture, terminalJob } = await startExtension(root, job);
    const body = "x".repeat(4_500_000);
    await submitReport(testFixture, { outcome: "implemented", report: body });
    const persisted = await readWorkerResult(job.resultPath, {
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      role: job.role,
    });
    expect(persisted.status).toBe("completed");
    expect(persisted.text).toBe(`Outcome: implemented\n\n${body}`);
    expect((await readWorkerTerminal(terminalJob))?.completed).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("only submit_report delivers the result; conversation turns before and after never do", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-followup-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const job = makeJob(root);
    const { fixture: testFixture, terminalJob } = await startExtension(root, job);
    const end = testFixture.handlers.get("agent_end");
    const tool = testFixture.handlers.get("tool_call");
    const input = testFixture.handlers.get("input");
    if (end === undefined || tool === undefined || input === undefined) {
      throw new Error("missing worker handlers");
    }
    await end(
      agentEnd("Outcome: implemented\nlooks final but is only a reply", true),
      testFixture.context,
    );
    await input(
      { type: "input", text: "Rename that helper too.", source: "interactive" },
      testFixture.context,
    );
    await end(agentEnd("Sure, I will rename that helper next."), testFixture.context);
    expect(await Bun.file(job.resultPath).exists()).toBe(false);
    expect((await readWorkerTerminal(terminalJob))?.completed).toBe(false);
    expect(await tool({ toolName: "edit" }, testFixture.context)).toBeUndefined();
    await submitReport(testFixture, {
      outcome: "implemented",
      report: "finished delegated report",
    });
    await end(agentEnd("Report submitted."), testFixture.context);
    await end(agentEnd("Happy to explain the change."), testFixture.context);
    expect(await tool({ toolName: "submit_report" }, testFixture.context)).toMatchObject({
      block: true,
    });
    const persisted = await readWorkerResult(job.resultPath, {
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      role: job.role,
    });
    expect(persisted.status).toBe("completed");
    expect(persisted.text).toBe("Outcome: implemented\n\nfinished delegated report");
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed submissions are rejected back to the worker without settling the job", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const cases: readonly {
    readonly role: WorkerJob["role"];
    readonly bad: SubmittedReport;
    readonly rejection: string;
    readonly good: SubmittedReport;
  }[] = [
    {
      role: "implementer",
      bad: { outcome: "needs-decision", report: "Blocked." },
      rejection: "requires a question",
      good: IMPLEMENTED,
    },
    {
      role: "scout",
      bad: { outcome: "completed", report: " " },
      rejection: "report must not be empty",
      good: { outcome: "completed", report: "Findings." },
    },
    {
      role: "scout",
      bad: { outcome: "needs-decision", report: "See.", question: "Which?\nOr this?" },
      rejection: "single line",
      good: { outcome: "completed", report: "Findings." },
    },
    {
      role: "presentation",
      bad: { outcome: "completed", report: "The page is ready." },
      rejection: "absolute artifactPath",
      good: { outcome: "completed", report: "The page is ready.", artifactPath: "/tmp/page.html" },
    },
  ];
  try {
    for (const value of cases) {
      const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-reject-"));
      try {
        const job = makeJob(root, value.role);
        const { fixture: f, terminalJob } = await startExtension(root, job);
        const rejected = await submitReport(f, value.bad);
        expect(rejected.isError).toBe(true);
        expect(rejected.content[0]?.text).toContain(value.rejection);
        expect(await Bun.file(job.resultPath).exists()).toBe(false);
        expect((await readWorkerTerminal(terminalJob))?.completed).toBe(false);
        expect((await submitReport(f, value.good)).isError).toBeUndefined();
        expect((await readWorkerResult(job.resultPath, job)).status).toBe("completed");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
  }
});

test("arguments outside the submit_report schema never reach the report contract", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const cases: readonly { readonly role: WorkerJob["role"]; readonly bad: SubmittedReport }[] = [
    { role: "reviewer", bad: { outcome: "completed", review: { findings: [] } } },
    {
      role: "reviewer",
      bad: {
        outcome: "completed",
        review: {
          findings: [{ id: "f-P1", severity: "P1", verdict: "confirmed", description: "Bug." }],
          summary: "A finding without a category or catch stage.",
        },
      },
    },
    { role: "implementer", bad: { outcome: "completed", report: "Done." } },
    { role: "scout", bad: { outcome: "completed", report: "Done.", artifactPath: "/tmp/a" } },
  ];
  try {
    for (const value of cases) {
      const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-schema-"));
      try {
        const job = makeJob(root, value.role);
        const { fixture: f, terminalJob } = await startExtension(root, job);
        // OMP validates arguments against the same schema before execute is ever called.
        await expect(submitReport(f, value.bad)).rejects.toThrow();
        expect(await Bun.file(job.resultPath).exists()).toBe(false);
        expect((await readWorkerTerminal(terminalJob))?.completed).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
  }
});

test("every worker role submits a structured needs-decision, and reviews submit a structured result", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const roles = ["scout", "implementer", "reviewer", "presentation"] as const;
  try {
    for (const role of roles) {
      const root = await mkdtemp(join(tmpdir(), "tandem-worker-question-"));
      try {
        const job = makeJob(root, role);
        const { fixture: f } = await startExtension(root, job);
        await submitReport(f, {
          outcome: "needs-decision",
          report: "Evidence is in the brief.",
          question: "Which source should be authoritative?",
          recommendation: "Prefer the repository policy.",
        });
        const result = await readWorkerResult(job.resultPath, job);
        expect(result.status).toBe("needs-decision");
        expect(result.question).toEqual({
          text: "Which source should be authoritative?",
          recommendation: "Prefer the repository policy.",
        });
        expect(result.text).toBe(
          "Outcome: needs-decision\nQuestion: Which source should be authoritative?\nRecommendation: Prefer the repository policy.\n\nEvidence is in the brief.",
        );
        expect(result.review).toBeUndefined();
        expect(result.artifactPath).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    const root = await mkdtemp(join(tmpdir(), "tandem-review-json-"));
    try {
      const job = makeJob(root, "reviewer");
      const { fixture: f } = await startExtension(root, job);
      await submitReport(f, { outcome: "completed", review: review() });
      const result = await readWorkerResult(job.resultPath, job);
      expect(result.status).toBe("completed");
      expect(result.review?.lens).toBe("review");
      expect(JSON.parse(result.text)).toEqual({
        lens: "review",
        head: "abc123",
        generation: 3,
        pass: true,
        ...review(),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
  }
});

test("Tandem binds a submitted review to its job and derives pass from the findings", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const cases = [
    { findings: [finding("P2"), finding("P3")], pass: true },
    { findings: [finding("P2"), finding("P1")], pass: false },
    { findings: [finding("P0")], pass: false },
  ] as const;
  try {
    for (const value of cases) {
      const root = await mkdtemp(join(tmpdir(), "tandem-review-derived-"));
      try {
        const job = makeJob(root, "reviewer");
        const { fixture: f } = await startExtension(root, job);
        await submitReport(f, {
          outcome: "completed",
          review: review({ findings: value.findings }),
        });
        const result = await readWorkerResult(job.resultPath, job);
        expect(result.transcript).toEqual({
          file: "/sessions/task-1/conversation.jsonl",
          entryId: "entry-7",
        });
        expect(result.review).toMatchObject({
          lens: "review",
          head: "abc123",
          generation: 3,
          pass: value.pass,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
  }
});

test("an implementer cannot report implemented while its worktree has uncommitted changes", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const root = await mkdtemp(join(tmpdir(), "tandem-uncommitted-"));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", "-C", root, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  try {
    git("init", "--quiet");
    const job = makeJob(root);
    await writeFile(
      join(root, ".gitignore"),
      "job.json\nresult.json\n*.terminal*\n*.tokens*\n*.trace*\n",
    );
    const { fixture: f, terminalJob } = await startExtension(root, job);
    await writeFile(join(root, "change.ts"), "export const changed = true;\n");
    const rejected = await submitReport(f, IMPLEMENTED);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("uncommitted changes (.gitignore, change.ts)");
    expect(await Bun.file(job.resultPath).exists()).toBe(false);
    expect((await readWorkerTerminal(terminalJob))?.completed).toBe(false);

    git("add", "-A");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "change",
    );
    expect((await submitReport(f, IMPLEMENTED)).isError).toBeUndefined();
    expect((await readWorkerResult(job.resultPath, job)).status).toBe("completed");
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("an implementer cannot report implemented while a playbook step is open in its to-do list", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const root = await mkdtemp(join(tmpdir(), "tandem-playbook-"));
  try {
    const job = { ...makeJob(root), playbookSteps: ["Measure a baseline", "Measure again"] };
    const { fixture: f } = await startExtension(root, job);
    const todo = (status: string) => ({
      toolName: "todo",
      toolCallId: `todo-${status}`,
      result: {
        details: {
          op: "done",
          phases: [
            {
              name: "Playbook",
              tasks: [
                { content: "Measure a baseline", status: "completed" },
                { content: "Measure again", status },
              ],
            },
          ],
        },
      },
    });

    const beforeTodo = await submitReport(f, IMPLEMENTED);
    expect(beforeTodo.content[0]?.text).toContain("Measure a baseline; Measure again");

    await f.handlers.get("tool_execution_end")?.(todo("in_progress"), f.context);
    const open = await submitReport(f, IMPLEMENTED);
    expect(open.isError).toBe(true);
    expect(open.content[0]?.text).toContain("still open in your to-do list: Measure again.");
    expect(await Bun.file(job.resultPath).exists()).toBe(false);

    await f.handlers.get("tool_execution_end")?.(todo("abandoned"), f.context);
    expect((await submitReport(f, IMPLEMENTED)).isError).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a reported failure and a native model substitution both settle the job as failed", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const substituted = { provider: MODEL.provider, id: "substituted-model" };
  const cases: readonly {
    readonly settle: (f: Fixture) => unknown;
    readonly error: string;
  }[] = [
    {
      settle: (f) => submitReport(f, { outcome: "failed", report: "The API is gone." }),
      error: "scout reported a failed outcome",
    },
    {
      settle: (f) =>
        submitReport(
          f,
          { outcome: "completed", report: "report" },
          { ...f.context, model: substituted },
        ),
      error: "substituted-model",
    },
    {
      settle: (f) => {
        const end = f.handlers.get("agent_end");
        if (end === undefined) throw new Error("missing agent_end handler");
        return end(
          {
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                provider: MODEL.provider,
                model: substituted.id,
                stopReason: "stop",
                content: [{ type: "text", text: "report" }],
              },
            ],
          },
          f.context,
        );
      },
      error: "substituted-model",
    },
  ];
  try {
    for (const value of cases) {
      const root = await mkdtemp(join(tmpdir(), "tandem-native-contract-"));
      try {
        const job = makeJob(root, "scout");
        const { fixture: f } = await startExtension(root, job);
        await value.settle(f);
        const result = await readWorkerResult(job.resultPath, job);
        expect(result.status).toBe("failed");
        expect(result.error).toContain(value.error);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
  }
});

test("runner records setup and nonzero OMP failures without a console transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-runner-"));
  try {
    const job = {
      ...makeJob(root),
      execution: {
        schemaVersion: 1 as const,
        home: root,
        operationId: "operation-1",
        fencingRevision: 1,
        claimOwner: "test-owner",
      },
    };
    const jobPath = join(root, "job.json");
    await writeFile(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    const result = await runWorkerJob(jobPath, {
      run: async () => 9,
      now: () => "2030-01-02T03:04:05.000Z",
      executionGate: async () => ({ admitted: true }),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("OMP exited with code 9");
    expect(JSON.parse(await Bun.file(job.resultPath).text())).toEqual(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implementer setup runs in the worktree before OMP and a failure stops the launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-setup-"));
  try {
    const setup = [{ name: "install", argv: ["bun", "install"], timeoutMs: 5_000 }];
    const job = {
      ...makeJob(root),
      setup,
      execution: {
        schemaVersion: 1 as const,
        home: root,
        operationId: "operation-1",
        fencingRevision: 1,
        claimOwner: "test-owner",
      },
    };
    const jobPath = join(root, "job.json");
    await writeFile(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    const calls: { argv: readonly string[]; cwd: string; timeoutMs?: number }[] = [];
    const result = await runWorkerJob(jobPath, {
      run: async (request) => {
        calls.push(request);
        return 1;
      },
      now: () => "2030-01-02T03:04:05.000Z",
      executionGate: async () => ({ admitted: true }),
    });
    expect(calls).toEqual([{ argv: ["bun", "install"], cwd: root, timeoutMs: 5_000 }]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain('worktree setup command "install"');
    expect(() => parseWorkerJob({ ...makeJob(root, "scout"), setup })).toThrow(TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only an implementer job carries validation command lines", () => {
  const validationCommands = ["bun run check", "bun test"];
  const job = parseWorkerJob({ ...makeJob("/tmp/worktree"), validationCommands });
  expect(job.validationCommands).toEqual(validationCommands);
  expect(() =>
    parseWorkerJob({ ...makeJob("/tmp/worktree", "scout"), validationCommands }),
  ).toThrow(TypeError);
  expect(() => parseWorkerJob({ ...makeJob("/tmp/worktree"), validationCommands: [""] })).toThrow(
    TypeError,
  );
});

test("a shell-string validation command is matched as typed", () => {
  const command = {
    name: "tests",
    argv: ["/bin/sh", "-c", "bun test"],
    surfaces: [],
    timeoutMs: 1,
  };
  expect(validationCommandLine(command)).toBe("bun test");
  expect(validationCommandLine({ ...command, argv: ["bun", "run", "lint"] })).toBe("bun run lint");
});

test("requires absolute paths and strict result fields at the wire boundary", () => {
  expect(() =>
    parseWorkerJob({
      schemaVersion: 1,
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "scout",
      cwd: "relative/worktree",
      model: { model: "luna", thinking: "max" },
      prompt: "brief",
      resultPath: "/tmp/result.json",
    }),
  ).toThrow(TypeError);
  expect(() =>
    parseWorkerJob({
      ...makeJob(process.cwd(), "scout"),
      model: { model: "luna", thinking: "max" },
    }),
  ).toThrow(TypeError);
  expect(() =>
    parseWorkerResult({
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "reviewer",
      status: "completed",
      text: "{}",
      finishedAt: "2030-01-02T03:04:05.000Z",
    }),
  ).toThrow(TypeError);
  expect(() =>
    parseWorkerResult({
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "scout",
      status: "completed",
      text: "ok",
      artifactPath: "relative/report.html",
      finishedAt: "2030-01-02T03:04:05.000Z",
    }),
  ).toThrow(TypeError);
});

test("atomically writes private results and rejects stale identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jobs-atomic-"));
  try {
    const resultPath = join(root, "nested", "result.json");
    const result: WorkerResult = {
      id: "job-1",
      taskId: "task-1",
      generation: 3,
      role: "scout",
      status: "completed",
      text: "report",
      finishedAt: "2030-01-02T03:04:05.000Z",
    };
    await persistWorkerResult(resultPath, result);
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(result);
    expect(await readWorkerResult(resultPath, { id: "job-1", generation: 3 })).toEqual(result);
    await expect(readWorkerResult(resultPath, { id: "job-1", generation: 2 })).rejects.toThrow();
    await chmod(resultPath, 0o644);
    await persistWorkerResult(resultPath, result);
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows role-scoped session directories for scout and implementer jobs only", () => {
  const root = process.cwd();
  for (const role of ["reviewer", "presentation"] as const) {
    expect(() =>
      parseWorkerJob({
        ...makeJob(root, role),
        sessionDirectory: join(root, "worker-session"),
      }),
    ).toThrow(TypeError);
  }
  expect(() =>
    parseWorkerJob({
      ...makeJob(root, "scout"),
      sessionDirectory: join(root, "scout-session"),
    }),
  ).not.toThrow();
  expect(() =>
    parseWorkerJob({
      ...makeJob(root, "implementer"),
      sessionDirectory: "relative/session",
    }),
  ).toThrow(TypeError);
});

test("a reviewer job may name its review round, which must be a positive integer", () => {
  const root = process.cwd();
  const reviewer = makeJob(root, "reviewer");
  const withRound = (round: unknown) => ({
    ...reviewer,
    review: { head: "abc123", lens: "review", round },
  });
  expect(parseWorkerJob(withRound(2)).review?.round).toBe(2);
  expect(parseWorkerJob(reviewer).review?.round).toBeUndefined();
  expect(() => parseWorkerJob(withRound(0))).toThrow(TypeError);
});

test("completed workers allow read-only conversation but refuse further mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-handoff-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const { fixture: f } = await startExtension(root, makeJob(root));
    const tool = f.handlers.get("tool_call");
    const end = f.handlers.get("agent_end");
    if (tool === undefined || end === undefined)
      throw new Error("worker lifecycle handlers missing");
    expect(await tool({ toolName: "edit" }, f.context)).toBeUndefined();
    await submitReport(f, IMPLEMENTED);
    await end(agentEnd("Outcome: implemented"), f.context);
    expect(await tool({ toolName: "read" }, f.context)).toBeUndefined();
    expect(await tool({ toolName: "edit" }, f.context)).toMatchObject({ block: true });
    expect(await tool({ toolName: "bash" }, f.context)).toMatchObject({ block: true });
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout does not publish completion until the aborted tool turn settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-timeout-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const job = { ...makeJob(root), timeoutMs: 100 };
    const { fixture: f, terminalJob } = await startExtension(root, job);
    f.state.idle = false;
    const end = f.handlers.get("agent_end");
    const tool = f.handlers.get("tool_call");
    if (end === undefined || tool === undefined)
      throw new Error("worker lifecycle handlers missing");
    f.timeouts[0]?.();
    expect(f.state.aborts).toBe(1);
    expect(await tool({ toolName: "write" }, f.context)).toMatchObject({ block: true });
    expect(await Bun.file(job.resultPath).exists()).toBe(false);
    expect((await readWorkerTerminal(terminalJob))?.completed).toBe(false);
    f.state.idle = true;
    await end(agentEnd("Outcome: implemented"), f.context);
    const result = await readWorkerResult(job.resultPath, job);
    expect(result.status).toBe("failed");
    expect((await readWorkerTerminal(terminalJob))?.completed).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("pause acknowledges only after the active turn unwinds and retains the interactive session", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-pause-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const job = makeJob(root);
    const { fixture: f, terminalJob } = await startExtension(root, job);
    f.state.idle = false;
    const pause = requestWorkerTerminalCommand(terminalJob, "pause", 2_000);
    const deadline = Date.now() + 1_000;
    while (f.state.aborts === 0 && Date.now() < deadline) {
      f.intervals[0]?.();
      await Bun.sleep(5);
    }
    expect(f.state.aborts).toBe(1);
    expect((await readWorkerTerminal(terminalJob))?.phase).not.toBe("paused");
    const end = f.handlers.get("agent_end");
    if (end === undefined) throw new Error("worker agent_end handler missing");
    f.state.idle = true;
    await end(agentEnd("interrupted"), f.context);
    await pause;
    expect((await readWorkerTerminal(terminalJob))?.phase).toBe("paused");
    expect(await Bun.file(job.resultPath).exists()).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker streaming a long reply is not stalled; one that stops streaming is", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-stall-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const start = Date.now();
  try {
    const { fixture: f } = await startExtension(root, makeJob(root));
    const turnStart = f.handlers.get("turn_start");
    const update = f.handlers.get("message_update");
    const heartbeat = f.intervals[1];
    if (turnStart === undefined || update === undefined || heartbeat === undefined)
      throw new Error("worker stall handlers missing");
    await turnStart({ type: "turn_start" }, f.context);
    setSystemTime(start + 4 * 60_000);
    await update({ type: "message_update" }, f.context);
    setSystemTime(start + 8 * 60_000);
    heartbeat();
    expect(f.state.aborts).toBe(0);
    setSystemTime(start + 9 * 60_000);
    heartbeat();
    expect(f.state.aborts).toBe(1);
  } finally {
    setSystemTime();
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("closing freezes human input but permits legacy and Kitty exit keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-exit-keys-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const { fixture: f, terminalJob } = await startExtension(root, makeJob(root));
    const end = f.handlers.get("agent_end");
    const input = f.inputs[0];
    if (end === undefined || input === undefined)
      throw new Error("worker lifecycle handlers missing");
    expect(input("human draft")).toBeUndefined();
    await submitReport(f, IMPLEMENTED);
    await end(agentEnd("Outcome: implemented"), f.context);
    const close = requestWorkerTerminalCommand(terminalJob, "close", 1000);
    const deadline = Date.now() + 1000;
    while ((await readWorkerTerminal(terminalJob))?.phase !== "closing" && Date.now() < deadline) {
      f.intervals[0]?.();
      await Bun.sleep(5);
    }
    await close;
    expect(input("human draft")).toEqual({ consume: true });
    expect(input("\u0004")).toBeUndefined();
    expect(input("\u001b[100;5u")).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
