import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskCommunication } from "../../src/contracts.ts";
import { readWorkerReceipt, writeTaskInbox } from "../../src/tasks/communication-persistence.ts";
import {
  appendTaskMessage,
  formatTaskMessages,
  taskInbox,
} from "../../src/tasks/communication-protocol.ts";
import workerControlExtension, { WORKER_CONTROL_ENV } from "../../src/worker-control.ts";

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
