import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TaskCommunication, WorkerReceipt } from "../../src/contracts.ts";
import { readWorkerReceipt, writeTaskInbox } from "../../src/tasks/communication-persistence.ts";
import {
  appendTaskMessage,
  formatTaskMessages,
  taskInbox,
} from "../../src/tasks/communication-protocol.ts";
import workerControlExtension, { WORKER_CONTROL_ENV } from "../../src/worker-control.ts";
import {
  atLeastAsNewBatch,
  contextWithTaskMessages,
  inboxMessageBatch,
  newestTaskMarker,
  touchedReceipt,
} from "../../src/workers/control-protocol.ts";
import { readWorkerTerminal, WORKER_JOB_PATH_ENV } from "../../src/workers/terminal.ts";

type Handler = (event: unknown, context: unknown) => unknown | Promise<unknown>;

type TestContext = {
  readonly intervals: Array<() => void>;
  readonly context: {
    readonly setInterval: (callback: (...args: unknown[]) => void, milliseconds?: number) => object;
    readonly abort: () => void;
  };
  readonly handlers: Map<string, Handler>;
  readonly wakeCalls: string[];
};

function makeTestContext(): TestContext {
  const intervals: Array<() => void> = [];
  const context = {
    setInterval(callback: (..._args: unknown[]) => void, _milliseconds?: number): object {
      intervals.push(callback as () => void);
      return {};
    },
    abort(): void {},
  };
  return { intervals, context, handlers: new Map(), wakeCalls: [] };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function markerCount(messages: readonly unknown[]): number {
  return JSON.stringify(messages).split("TANDEM_TASK_COMMUNICATION_V1").length - 1;
}

test("poll observes receipts without model wakes, context applies one bounded batch, and session_stop resumes late updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-control-"));
  const previousEnvironment = process.env[WORKER_CONTROL_ENV];
  const taskId = "task-control";
  const jobId = "job-control";
  const inboxPath = join(root, "inbox.json");
  const receiptPath = join(root, "communication.json");
  try {
    let communication: TaskCommunication | undefined;
    communication = appendTaskMessage(communication, {
      id: "direction-1",
      kind: "instruction",
      text: "Keep the approved scope.",
      createdAt: "2030-01-02T03:04:05.000Z",
    });
    if (communication === undefined) throw new Error("failed to create initial communication");
    const firstCommunication = communication;
    await writeTaskInbox(inboxPath, taskInbox(taskId, communication));
    process.env[WORKER_CONTROL_ENV] = JSON.stringify({
      schemaVersion: 1,
      jobId,
      taskId,
      generation: 1,
      inboxPath,
      receiptPath,
      initialRevision: 0,
    });

    const fixture = makeTestContext();
    const pi = {
      on(event: string, handler: Handler): void {
        fixture.handlers.set(event, handler);
      },
      sendUserMessage(content: string): void {
        fixture.wakeCalls.push(content);
      },
    };
    await workerControlExtension(pi as never);
    const sessionStart = fixture.handlers.get("session_start");
    const context = fixture.handlers.get("context");
    const sessionStop = fixture.handlers.get("session_stop");
    if (sessionStart === undefined || context === undefined || sessionStop === undefined) {
      throw new Error("missing worker hooks");
    }

    await sessionStart({ type: "session_start" }, fixture.context);
    fixture.intervals[0]?.();
    await settleMicrotasks();
    expect(fixture.wakeCalls).toHaveLength(0);
    let receipt = await readWorkerReceipt(receiptPath, { jobId, taskId, generation: 1 });
    expect(receipt?.receivedRevision).toBe(1);
    expect(receipt?.appliedRevision).toBe(0);

    const firstInbox = taskInbox(taskId, communication);
    const firstMarker = formatTaskMessages(taskId, firstInbox.revision, firstInbox.messages);
    const history = [
      {
        role: "user",
        content: `Keep this user note.\n${firstMarker}\nKeep this note too.`,
        timestamp: 1,
      },
      {
        role: "user",
        content: [
          { type: "image", data: "preserve-image" },
          { type: "text", text: firstMarker },
        ],
        timestamp: 2,
      },
    ];
    const firstContext = (await context(
      { type: "context", messages: history },
      fixture.context,
    )) as {
      readonly messages: readonly unknown[];
    };
    expect(markerCount(firstContext.messages)).toBe(1);
    expect(JSON.stringify(firstContext.messages)).toContain("Keep this user note.");
    expect(JSON.stringify(firstContext.messages)).toContain("preserve-image");
    receipt = await readWorkerReceipt(receiptPath, { jobId, taskId, generation: 1 });
    expect(receipt?.appliedRevision).toBe(1);

    const repeatedContext = (await context(
      { type: "context", messages: firstContext.messages },
      fixture.context,
    )) as { readonly messages: readonly unknown[] };
    expect(markerCount(repeatedContext.messages)).toBe(1);

    communication = appendTaskMessage(communication, {
      id: "direction-2",
      kind: "instruction",
      text: "Use the approved implementation path.",
      createdAt: "2030-01-02T03:04:06.000Z",
    });
    if (communication === undefined) throw new Error("failed to create revision-two communication");
    const revisionTwoMessages = communication.messages;
    await writeTaskInbox(inboxPath, taskInbox(taskId, communication));
    const lateStop = (await sessionStop(
      { type: "session_stop", signal: new AbortController().signal },
      fixture.context,
    )) as { readonly continue?: boolean; readonly additionalContext?: string };
    expect(lateStop.continue).toBe(true);
    expect(lateStop.additionalContext).toBeString();
    expect(fixture.wakeCalls).toHaveLength(0);

    const resumedContext = (await context(
      {
        type: "context",
        messages: [{ role: "user", content: lateStop.additionalContext, timestamp: 3 }],
      },
      fixture.context,
    )) as { readonly messages: readonly unknown[] };
    expect(markerCount(resumedContext.messages)).toBe(1);
    const subsetMarker = formatTaskMessages(
      taskId,
      2,
      revisionTwoMessages.filter((message) => message.id === "direction-2"),
    );
    await writeTaskInbox(inboxPath, taskInbox(taskId, firstCommunication));
    const regressedContext = (await context(
      { type: "context", messages: [{ role: "user", content: subsetMarker, timestamp: 4 }] },
      fixture.context,
    )) as { readonly messages: readonly unknown[] };
    expect(markerCount(regressedContext.messages)).toBe(1);
    expect(JSON.stringify(regressedContext.messages)).toContain("direction-1");
    expect(JSON.stringify(regressedContext.messages)).toContain("direction-2");
    receipt = await readWorkerReceipt(receiptPath, { jobId, taskId, generation: 1 });
    expect(receipt?.appliedRevision).toBe(2);

    await rm(inboxPath, { force: true });
    const missingContext = (await context(
      { type: "context", messages: [{ role: "user", content: "unrelated", timestamp: 5 }] },
      fixture.context,
    )) as { readonly messages: readonly unknown[] };
    expect(markerCount(missingContext.messages)).toBe(1);
    expect(JSON.stringify(missingContext.messages)).toContain("direction-2");
    receipt = await readWorkerReceipt(receiptPath, { jobId, taskId, generation: 1 });
    expect(receipt?.appliedRevision).toBe(2);

    const finished = await sessionStop(
      { type: "session_stop", signal: new AbortController().signal },
      fixture.context,
    );
    expect(finished).toBeUndefined();
    expect(fixture.wakeCalls).toHaveLength(0);
  } finally {
    if (previousEnvironment === undefined) delete process.env[WORKER_CONTROL_ENV];
    else process.env[WORKER_CONTROL_ENV] = previousEnvironment;
    await rm(root, { recursive: true, force: true });
  }
});

/** An OMP extension API fake that, like OMP, keeps and runs every handler registered for an event. */
function multiHandlerPi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }): void {
      tools.set(tool.name, tool.execute);
    },
  };
  const emit = async (event: string, payload: unknown, context: unknown) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, context));
    return results;
  };
  return { pi, handlers, tools, emit };
}

test("the combined worker extension runs both its steering and terminal handlers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-combined-"));
  const previous = {
    control: process.env[WORKER_CONTROL_ENV],
    job: process.env[WORKER_JOB_PATH_ENV],
  };
  const taskId = "task-combined";
  const jobPath = join(root, "job.json");
  const receiptPath = join(root, "communication.json");
  try {
    const job = {
      schemaVersion: 1,
      id: "job-combined",
      taskId,
      generation: 1,
      role: "scout",
      cwd: root,
      model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
      prompt: "Research.",
      resultPath: join(root, "result.json"),
    };
    await writeFile(jobPath, `${JSON.stringify(job)}\n`);
    await writeTaskInbox(join(root, "inbox.json"), taskInbox(taskId, communicationWith(1)));
    process.env[WORKER_JOB_PATH_ENV] = jobPath;
    process.env[WORKER_CONTROL_ENV] = JSON.stringify({
      schemaVersion: 1,
      jobId: job.id,
      taskId,
      generation: 1,
      inboxPath: join(root, "inbox.json"),
      receiptPath,
      initialRevision: 0,
    });
    const fake = multiHandlerPi();
    let intervals = 0;
    const context = {
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      ui: { getEditorText: () => "", onTerminalInput: () => () => {} },
      setInterval: () => {
        intervals += 1;
        return {};
      },
      setTimeout: () => ({}),
      clearTimer: () => {},
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionFile: () => undefined, getLeafId: () => null },
      abort: () => {},
    };
    await workerControlExtension(fake.pi as never);
    for (const event of ["session_start", "context", "agent_end", "tool_execution_end"]) {
      expect({ event, handlers: fake.handlers.get(event)?.length }).toEqual({ event, handlers: 2 });
    }

    await fake.emit("session_start", { type: "session_start" }, context);
    expect(intervals).toBe(4);
    const identity = { jobId: job.id, taskId, generation: 1 };
    expect((await readWorkerReceipt(receiptPath, identity))?.phase).toBe("model");
    const terminalJob = { ...job, role: "scout" as const, jobPath };
    expect((await readWorkerTerminal(terminalJob))?.phase).toBe("busy");

    const [steered, watched] = await fake.emit(
      "context",
      { type: "context", messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      context,
    );
    expect(markerCount((steered as { messages: unknown[] }).messages)).toBe(1);
    expect(watched).toBeUndefined();
    expect((await readWorkerReceipt(receiptPath, identity))?.appliedRevision).toBe(1);

    const submit = fake.tools.get("submit_report");
    if (submit === undefined) throw new Error("missing submit_report");
    await submit(
      "call-1",
      { outcome: "completed", report: "Findings." },
      undefined,
      undefined,
      context,
    );
    const shell = { toolName: "bash", input: { command: "touch x" } };
    expect(await fake.emit("tool_call", shell, context)).toEqual([
      {
        block: true,
        reason: "worker terminal is paused or completed; mutating tools are disabled",
      },
    ]);
    const trace = await readFile(`${jobPath}.trace.jsonl`, "utf8");
    expect(trace).toContain('"event":"context"');
    expect(trace).toContain('"event":"result_published"');
  } finally {
    for (const [key, value] of [
      [WORKER_CONTROL_ENV, previous.control],
      [WORKER_JOB_PATH_ENV, previous.job],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

function communicationWith(count: number): TaskCommunication {
  let communication: TaskCommunication | undefined;
  for (let index = 1; index <= count; index += 1) {
    communication = appendTaskMessage(communication, {
      id: `direction-${index}`,
      kind: "instruction",
      text: `Direction ${index}.`,
      createdAt: "2030-01-02T03:04:05.000Z",
    });
  }
  if (communication === undefined) throw new Error("no communication");
  return communication;
}

test("an inbox batch replaces the retained one only when at least as new", () => {
  expect(inboxMessageBatch("task-a", undefined)).toBeUndefined();
  const one = inboxMessageBatch("task-a", taskInbox("task-a", communicationWith(1)));
  const two = inboxMessageBatch("task-a", taskInbox("task-a", communicationWith(2)));
  expect(one?.revision).toBe(1);
  expect(atLeastAsNewBatch(one, two)).toBe(two);
  expect(atLeastAsNewBatch(two, one)).toBe(two);
  expect(atLeastAsNewBatch(undefined, one)).toBe(one);
  const sameRevision = inboxMessageBatch("task-a", taskInbox("task-a", communicationWith(2)));
  expect(atLeastAsNewBatch(sameRevision, two)).toBe(sameRevision);
});

test("task messages collapse into one copy at the first marker, or are appended", () => {
  const two = inboxMessageBatch("task-a", taskInbox("task-a", communicationWith(2)));
  if (two === undefined) throw new Error("no batch");
  const marker = (revision: number): string => {
    const inbox = taskInbox("task-a", communicationWith(revision));
    return formatTaskMessages("task-a", inbox.revision, inbox.messages);
  };
  const history = [
    { role: "user", content: `note\n${marker(1)}`, timestamp: 1 },
    { role: "user", content: marker(2), timestamp: 2 },
  ] as AgentMessage[];
  expect(newestTaskMarker(history, "task-a")?.batch.revision).toBe(2);
  expect(newestTaskMarker(history, "task-b")).toBeUndefined();

  const placement = { taskId: "task-a", batch: two };
  const collapsed = contextWithTaskMessages(history, { ...placement, replaceExisting: true }, 9);
  expect(collapsed).toEqual([{ role: "user", content: `note\n${marker(2)}`, timestamp: 1 }]);

  const plain = [{ role: "user", content: "hello", timestamp: 1 }] as AgentMessage[];
  expect(contextWithTaskMessages(plain, { ...placement, replaceExisting: false }, 9)).toEqual([
    ...plain,
    { role: "user", content: marker(2), synthetic: true, attribution: "agent", timestamp: 9 },
  ] as AgentMessage[]);
});

test("a receipt touch writes at once only on a phase or tool change", () => {
  const receipt: WorkerReceipt = {
    schemaVersion: 1,
    jobId: "job",
    taskId: "task-a",
    generation: 0,
    receivedRevision: 0,
    appliedRevision: 0,
    heartbeatAt: "2030-01-01T00:00:00.000Z",
    progressAt: "2030-01-01T00:00:00.000Z",
    phase: "tool",
    tool: "bash",
  };
  const later = "2030-01-01T00:01:00.000Z";
  const heartbeat = touchedReceipt(
    receipt,
    { phase: "tool", tool: "bash", meaningful: false },
    later,
  );
  expect(heartbeat.changed).toBe(false);
  expect(heartbeat.receipt).toEqual({ ...receipt, heartbeatAt: later });
  const nextTool = touchedReceipt(
    receipt,
    { phase: "tool", tool: "read", meaningful: true },
    later,
  );
  expect(nextTool.changed).toBe(true);
  expect(nextTool.receipt).toMatchObject({ tool: "read", progressAt: later });
  const idle = touchedReceipt(receipt, { phase: "idle", tool: "bash", meaningful: true }, later);
  expect(idle.changed).toBe(true);
  expect(idle.receipt.tool).toBeUndefined();
});
