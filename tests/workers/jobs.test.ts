import { expect, test } from "bun:test";
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
import {
  readWorkerTerminal,
  requestWorkerTerminalCommand,
  type WorkerTerminalJob,
} from "../../src/workers/terminal.ts";
import { registerWorkerTerminalExtension } from "../../src/workers/terminal-extension.ts";

const MODEL = { provider: "openai-codex", id: "gpt-5.6-luna" };

type Handler = (event: unknown, context: unknown) => unknown | Promise<unknown>;

type Fixture = {
  readonly handlers: Map<string, Handler>;
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
    readonly abort: () => void;
    readonly shutdown: () => void;
  };
};

function fixture(): Fixture {
  const handlers = new Map<string, Handler>();
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
    abort: () => {
      state.aborts += 1;
    },
    shutdown: () => undefined,
  };
  return { handlers, intervals, timeouts, inputs, state, context };
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
  return role === "reviewer" || role === "verifier"
    ? { ...base, review: { head: "abc123", lens: "behavior" as const } }
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

test("persists native result before process shutdown and keeps very large reports intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const job = makeJob(root);
    const { fixture: testFixture, terminalJob } = await startExtension(root, job);
    const end = testFixture.handlers.get("agent_end");
    if (end === undefined) throw new Error("missing agent_end handler");
    const report = `Outcome: implemented\n${"x".repeat(4_500_000)}`;
    await end(agentEnd(report), testFixture.context);
    const persisted = await readWorkerResult(job.resultPath, {
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      role: job.role,
    });
    expect(persisted.status).toBe("completed");
    expect(persisted.text).toBe(report);
    expect((await readWorkerTerminal(terminalJob))?.completed).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores continuing agent_end and never overwrites the delegated result from manual follow-up", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-followup-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const job = makeJob(root);
    const { fixture: testFixture } = await startExtension(root, job);
    const end = testFixture.handlers.get("agent_end");
    if (end === undefined) throw new Error("missing agent_end handler");
    await end(
      agentEnd("Outcome: needs-decision\nQuestion: Need approval", true),
      testFixture.context,
    );
    await expect(
      readWorkerResult(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
      }),
    ).rejects.toThrow();
    const delegated = "Outcome: implemented\nfinished delegated report";
    await end(agentEnd(delegated), testFixture.context);
    await end(agentEnd("Outcome: implemented\nmanual follow-up"), testFixture.context);
    const persisted = await readWorkerResult(job.resultPath, {
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      role: job.role,
    });
    expect(persisted.text).toBe(delegated);
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed review text at the native event boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-strict-"));
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  try {
    const reviewer = makeJob(root, "reviewer");
    const { fixture: testFixture } = await startExtension(root, reviewer);
    const end = testFixture.handlers.get("agent_end");
    if (end === undefined) throw new Error("missing agent_end handler");
    await end(agentEnd("not strict review JSON"), testFixture.context);
    const failed = await readWorkerResult(reviewer.resultPath, {
      id: reviewer.id,
      taskId: reviewer.taskId,
      generation: reviewer.generation,
      role: reviewer.role,
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("strict JSON");
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test("all interactive worker roles persist the shared needs-decision report without changing review JSON success", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const cases: readonly {
    readonly role: WorkerJob["role"];
    readonly text: string;
  }[] = [
    {
      role: "scout",
      text: "Outcome: needs-decision\nQuestion: Which source should be authoritative?\nRecommendation: Prefer the repository policy.",
    },
    {
      role: "implementer",
      text: "Outcome: needs-decision\nQuestion: Should the existing API remain unchanged?",
    },
    {
      role: "reviewer",
      text: "Outcome: needs-decision\nQuestion: The selected review lens needs a decision.",
    },
    {
      role: "verifier",
      text: "Outcome: needs-decision\nQuestion: Validation evidence is ambiguous; which command is authoritative?",
    },
    {
      role: "presentation",
      text: "Outcome: needs-decision\nQuestion: Which visual direction should the artifact follow?",
    },
  ];
  try {
    for (const value of cases) {
      const root = await mkdtemp(join(tmpdir(), "tandem-worker-question-"));
      try {
        const job = makeJob(root, value.role);
        const { fixture: f } = await startExtension(root, job);
        const end = f.handlers.get("agent_end");
        if (end === undefined) throw new Error("missing agent_end handler");
        await end(agentEnd(value.text), f.context);
        const result = await readWorkerResult(job.resultPath, job);
        expect(result.status).toBe("needs-decision");
        expect(result.text).toBe(value.text);
        expect(result.question?.text).toBe(value.text.match(/^Question:\s*(.+)$/m)?.[1]);
        if (value.role === "scout") {
          expect(result.question?.recommendation).toBe("Prefer the repository policy.");
        }
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
      const end = f.handlers.get("agent_end");
      if (end === undefined) throw new Error("missing agent_end handler");
      const review = JSON.stringify({
        lens: "behavior",
        head: "abc123",
        generation: 3,
        pass: true,
        findings: [],
        summary: "No behavior findings.",
      });
      await end(agentEnd(review), f.context);
      const result = await readWorkerResult(job.resultPath, job);
      expect(result.status).toBe("completed");
      expect(result.review?.lens).toBe("behavior");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
    else process.env.TANDEM_WORKER_JOB_PATH = previous;
  }
});

test("rejects native model substitutions and missing role completion markers", async () => {
  const previous = process.env.TANDEM_WORKER_JOB_PATH;
  const cases: readonly {
    role: WorkerJob["role"];
    text: string;
    selectedModel?: typeof MODEL;
    eventModel?: string;
  }[] = [
    {
      role: "scout",
      text: "report",
      selectedModel: { provider: MODEL.provider, id: "substituted-model" },
    },
    { role: "scout", text: "report", eventModel: "substituted-model" },
    { role: "implementer", text: "I changed the requested files." },
    { role: "presentation", text: "The page is ready." },
  ];
  for (const value of cases) {
    const root = await mkdtemp(join(tmpdir(), "tandem-native-contract-"));
    try {
      const job = makeJob(root, value.role);
      const { fixture: f } = await startExtension(root, job);
      const end = f.handlers.get("agent_end");
      if (end === undefined) throw new Error("missing agent_end handler");
      const event =
        value.eventModel === undefined
          ? agentEnd(value.text)
          : {
              type: "agent_end",
              messages: [
                {
                  role: "assistant",
                  provider: MODEL.provider,
                  model: value.eventModel,
                  stopReason: "stop",
                  content: [{ type: "text", text: value.text }],
                },
              ],
            };
      await end(event, { ...f.context, model: value.selectedModel ?? MODEL });
      expect((await readWorkerResult(job.resultPath, job)).status).toBe("failed");
    } finally {
      if (previous === undefined) delete process.env.TANDEM_WORKER_JOB_PATH;
      else process.env.TANDEM_WORKER_JOB_PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("runner records setup and nonzero OMP failures without a console transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-native-worker-runner-"));
  try {
    const job = makeJob(root);
    const jobPath = join(root, "job.json");
    await writeFile(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    const result = await runWorkerJob(jobPath, {
      run: async () => 9,
      now: () => "2030-01-02T03:04:05.000Z",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("OMP exited with code 9");
    expect(JSON.parse(await Bun.file(job.resultPath).text())).toEqual(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  for (const role of ["reviewer", "verifier", "presentation"] as const) {
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
