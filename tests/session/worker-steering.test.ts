import { expect, test } from "bun:test";
import type { TaskCommunication, TaskInbox, WorkerReceipt } from "../../src/contracts.ts";
import { WorkerSteering, type WorkerSteeringDeps } from "../../src/session/worker-steering.ts";
import {
  appendTaskMessage,
  formatTaskMessages,
  taskInbox,
} from "../../src/tasks/communication-protocol.ts";
import { inboxMessageBatch } from "../../src/workers/control-protocol.ts";
import { fakeSessionTime, recordingSessionHost } from "../evals/scenario.ts";

const TASK = "task-1";

function inboxWith(count: number, taskId = TASK): TaskInbox {
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
  return taskInbox(taskId, communication);
}

/** A steering session over a fake inbox and receipt file; `writes` holds every receipt written. */
function steeringDeps(overrides: Partial<WorkerSteeringDeps> = {}) {
  const recording = recordingSessionHost();
  const time = fakeSessionTime();
  const state: { inbox: TaskInbox | undefined; failWrites: number } = {
    inbox: undefined,
    failWrites: 0,
  };
  const writes: WorkerReceipt[] = [];
  const deps: WorkerSteeringDeps = {
    host: recording.host,
    clock: time.clock,
    timers: time.timers,
    config: {
      schemaVersion: 1,
      jobId: "job-1",
      taskId: TASK,
      generation: 2,
      inboxPath: "/tmp/inbox.json",
      receiptPath: "/tmp/receipt.json",
      initialRevision: 0,
    },
    readInbox: async () => state.inbox,
    writeReceipt: async (receipt) => {
      if (state.failWrites > 0) {
        state.failWrites -= 1;
        throw new Error("EIO");
      }
      writes.push(receipt);
    },
    writeActivity: async () => {},
    trace: () => {},
    delivery: "context",
    ...overrides,
  };
  const aborts = () => recording.effects.filter((effect) => effect.type === "abort").length;
  return { deps, state, writes, time, aborts, recording };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test("opening checks the inbox belongs to the task and writes the starting receipt", async () => {
  const fixture = steeringDeps();
  await WorkerSteering.open(fixture.deps);
  expect(fixture.writes).toEqual([
    {
      schemaVersion: 1,
      jobId: "job-1",
      taskId: TASK,
      generation: 2,
      receivedRevision: 0,
      appliedRevision: 0,
      heartbeatAt: "2030-01-01T00:00:00.000Z",
      progressAt: "2030-01-01T00:00:00.000Z",
      phase: "starting",
    },
  ]);

  const foreign = steeringDeps();
  foreign.state.inbox = inboxWith(1, "task-other");
  await expect(WorkerSteering.open(foreign.deps)).rejects.toThrow("belongs to a different task");

  const missing = steeringDeps();
  await expect(
    WorkerSteering.open({
      ...missing.deps,
      config: { ...missing.deps.config, initialRevision: 1 },
    }),
  ).rejects.toThrow("missing for a nonzero revision");
  expect(foreign.writes).toHaveLength(0);
});

test("context places the newest batch once and records it as applied", async () => {
  const fixture = steeringDeps();
  fixture.state.inbox = inboxWith(1);
  const steering = await WorkerSteering.open(fixture.deps);

  const first = await steering.onContextBuild(undefined);
  expect(first.taskMessages).toMatchObject({ taskId: TASK, replaceExisting: false });
  expect(first.taskMessages?.batch.revision).toBe(1);
  expect(fixture.writes.at(-1)).toMatchObject({ receivedRevision: 1, appliedRevision: 1 });
  const writesAfterFirst = fixture.writes.length;

  // The batch now in the conversation is replaced in place, and nothing new is written.
  const again = await steering.onContextBuild(first.taskMessages?.batch);
  expect(again.taskMessages).toMatchObject({ replaceExisting: true });
  expect(again.taskMessages?.batch.revision).toBe(1);
  expect(fixture.writes).toHaveLength(writesAfterFirst);

  // An older inbox never displaces a newer batch the conversation already holds.
  const newer = inboxMessageBatch(TASK, inboxWith(2));
  const kept = await steering.onContextBuild(newer);
  expect(kept.taskMessages?.batch).toBe(newer);
  expect(fixture.writes.at(-1)).toMatchObject({ appliedRevision: 2 });
});

test("a stop continues with steering that arrived late, and otherwise finishes", async () => {
  const fixture = steeringDeps();
  fixture.state.inbox = inboxWith(1);
  const steering = await WorkerSteering.open(fixture.deps);
  await steering.onContextBuild(undefined);

  fixture.state.inbox = inboxWith(2);
  const late = await steering.onStopRequested(false);
  const inbox = inboxWith(2);
  expect(late).toEqual({ continueWith: formatTaskMessages(TASK, 2, inbox.messages) });
  expect(fixture.writes.at(-1)).toMatchObject({
    receivedRevision: 2,
    appliedRevision: 1,
    phase: "model",
  });

  expect(await steering.onStopRequested(true)).toEqual({});
  await steering.onContextBuild(undefined);
  expect(await steering.onStopRequested(false)).toEqual({});
  expect(fixture.writes.at(-1)).toMatchObject({ phase: "finished", appliedRevision: 2 });
});

test("a failed receipt write aborts the worker and stops steering", async () => {
  const fixture = steeringDeps();
  fixture.state.inbox = inboxWith(1);
  const steering = await WorkerSteering.open(fixture.deps);
  fixture.state.failWrites = 1;
  expect(await steering.onContextBuild(undefined)).toEqual({});
  expect(fixture.aborts()).toBeGreaterThan(0);
  const writes = fixture.writes.length;
  expect(await steering.onContextBuild(undefined)).toEqual({});
  expect(await steering.onStopRequested(false)).toEqual({});
  steering.recordActivity("tool", { name: "bash" });
  await settle();
  expect(fixture.writes).toHaveLength(writes + 1);
});

test("receipt writes run one at a time, in order, and heartbeats write at most once a second", async () => {
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const fixture = steeringDeps({
    writeReceipt: async (receipt) => {
      order.push(`start ${receipt.phase}`);
      if (order.length === 3) await firstWrite;
      order.push(`end ${receipt.phase}`);
    },
  });
  const steering = await WorkerSteering.open(fixture.deps);
  steering.recordActivity("tool", { name: "bash" });
  steering.recordActivity("idle");
  await settle();
  expect(order).toEqual(["start starting", "end starting", "start idle"]);
  releaseFirst();
  await settle();
  // Each write sends the newest receipt, so the queued second write repeats it.
  expect(order.slice(3)).toEqual(["end idle", "start idle", "end idle"]);

  await steering.onSessionStart();
  const afterStart = order.length;
  // An unchanged phase within the write interval stays in memory until the heartbeat.
  steering.recordActivity("model");
  await settle();
  expect(order).toHaveLength(afterStart);
  fixture.time.advance(10_000);
  await settle();
  expect(order.slice(afterStart)).toEqual(["start model", "end model"]);
});

test("without history rewriting, each newer batch is handed over once after a tool result", async () => {
  const fixture = steeringDeps({ delivery: "messages" });
  fixture.recording.answers.paneState = { idle: false, pendingMessages: false, draft: false };
  const steering = await WorkerSteering.open(fixture.deps);
  expect(await steering.takePending()).toBeUndefined();

  fixture.state.inbox = inboxWith(1);
  expect(await steering.takePending()).toBe(formatTaskMessages(TASK, 1, inboxWith(1).messages));
  expect(fixture.writes.at(-1)).toMatchObject({ receivedRevision: 1, appliedRevision: 1 });
  expect(await steering.takePending()).toBeUndefined();

  fixture.state.inbox = inboxWith(2);
  const late = await steering.onStopRequested(false);
  expect(late).toEqual({ continueWith: formatTaskMessages(TASK, 2, inboxWith(2).messages) });
  expect(fixture.writes.at(-1)).toMatchObject({ receivedRevision: 2, appliedRevision: 2 });
  expect(await steering.takePending()).toBeUndefined();
  expect(fixture.recording.effects).toEqual([]);
});

test("without history rewriting, an idle pane gets a newer batch as its own prompt, once", async () => {
  const fixture = steeringDeps({ delivery: "messages" });
  fixture.recording.answers.paneState = { idle: true, pendingMessages: true, draft: false };
  const steering = await WorkerSteering.open(fixture.deps);
  await steering.onSessionStart();
  fixture.state.inbox = inboxWith(1);
  fixture.time.advance(250);
  await settle();
  // A queued prompt (the brief, not yet started) holds delivery back.
  expect(fixture.recording.effects).toEqual([]);

  fixture.recording.answers.paneState = { idle: true, pendingMessages: false, draft: false };
  fixture.time.advance(250);
  await settle();
  fixture.time.advance(250);
  await settle();
  expect(fixture.recording.effects).toEqual([
    {
      type: "deliver",
      source: "steering",
      text: formatTaskMessages(TASK, 1, inboxWith(1).messages),
      timing: "nextTurn",
      triggerTurn: true,
    },
  ]);
  expect(fixture.writes.at(-1)).toMatchObject({ appliedRevision: 1 });
});

test("with history rewriting, an idle pane is never prompted with steering", async () => {
  const fixture = steeringDeps();
  const steering = await WorkerSteering.open(fixture.deps);
  await steering.onSessionStart();
  fixture.state.inbox = inboxWith(1);
  fixture.time.advance(1_000);
  await settle();
  expect(fixture.recording.effects).toEqual([]);
});

test("the prompt a run begins with applies the newest batch for this task in it", async () => {
  const fixture = steeringDeps({ delivery: "messages" });
  fixture.state.inbox = inboxWith(2);
  const steering = await WorkerSteering.open(fixture.deps);
  const other = formatTaskMessages("task-2", 3, inboxWith(3, "task-2").messages);
  await steering.onPromptSeen(`Implement it.\n\n${other}`);
  expect(fixture.writes.at(-1)).toMatchObject({ appliedRevision: 0 });
  await steering.onPromptSeen(
    `Implement it.\n\n${formatTaskMessages(TASK, 1, inboxWith(1).messages)}\n${formatTaskMessages(TASK, 2, inboxWith(2).messages)}`,
  );
  expect(fixture.writes.at(-1)).toMatchObject({ receivedRevision: 2, appliedRevision: 2 });
  expect(await steering.takePending()).toBeUndefined();
});
