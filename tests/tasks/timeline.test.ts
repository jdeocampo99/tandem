import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockCause,
  type FindingLedgerEntry,
  type InstructionChannels,
  type ResolvedPolicy,
  type TaskRecord,
} from "../../src/contracts.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore, type TaskStore } from "../../src/tasks/store.ts";
import {
  admissionWaitToRecord,
  type TimelineEvent,
  timelineEventsForChange,
} from "../../src/tasks/timeline.ts";
import { readTimeline, recordTimelineEvents } from "../../src/tasks/timeline-store.ts";
import {
  renderTaskTrace,
  renderTraceSummary,
  summarizeRollups,
  taskRollup,
} from "../../src/tasks/trace.ts";

const channels: InstructionChannels = { implementation: [], validation: [], review: [] };
const model = { model: "model", thinking: "high" as const };
const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: model,
      scout: model,
      implementer: model,
      reviewer: model,
      presentation: model,
    },
    instructions: channels,
    instructionFiles: channels,
    validationCommands: [],
    setupCommands: [],
    maxFixRounds: 2,
  },
  guidance: { implementation: [], validation: [], review: [] },
};

let home: string;
let store: TaskStore;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 8, 1, 0, tick++)).toISOString();

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tandem-timeline-"));
  tick = 0;
  let ids = 0;
  store = createTaskStore({
    directory: join(home, "tasks"),
    clock,
    idFactory: () => `id-${ids++}`,
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function createTask(): Promise<TaskRecord> {
  return store.create({
    id: "task-1",
    repoPath: "/repo",
    kind: "implementation",
    objective: "Add the timeline",
    acceptanceCriteria: ["Events are recorded"],
    surfaces: ["tasks"],
    policy,
  });
}

function transition(task: TaskRecord, event: Parameters<typeof transitionTask>[1]): TaskRecord {
  return transitionTask(task, event, { now: clock(), notificationId: `note-${tick}` });
}

function ledgerEntry(status: FindingLedgerEntry["status"], generation: number): FindingLedgerEntry {
  const observation = { head: "abc", generation, reviewRound: generation };
  return {
    id: "f1",
    lens: "review",
    severity: "P1",
    verdict: "confirmed",
    description: "The event is lost on rollback.",
    category: "correctness",
    catchStage: "validation",
    status,
    raisedAt: observation,
    statusAt: observation,
  };
}

test("the store records a task's changes as timeline events in write order", async () => {
  const created = await createTask();
  const approved = await store.update(created.id, created.revision, (task) =>
    transition(task, { type: "approve" }),
  );
  const blocked = await store.update(approved.id, approved.revision, (task) =>
    transition(task, {
      type: "block",
      reason: "worker died",
      cause: blockCause("worker-failed", {
        summary: "The worker stopped without finishing.",
        detail: "exit 1",
      }),
    }),
  );
  await store.update(blocked.id, blocked.revision, (task) => transition(task, { type: "resume" }), {
    cause: "The user restarted it.",
    refs: { commit: "abc123" },
  });

  const timeline = await readTimeline(home, "task-1");
  expect(timeline.unreadableEvents).toBe(0);
  expect(timeline.events.map(({ seq: _seq, at: _at, ...event }) => event)).toEqual([
    { type: "created", stage: "awaiting-approval", taskId: "task-1" },
    { type: "stage-changed", from: "awaiting-approval", to: "queued", taskId: "task-1" },
    {
      type: "blocked",
      from: "queued",
      blockKind: "worker-failed",
      taskId: "task-1",
      cause: "The worker stopped without finishing.",
    },
    {
      type: "unblocked",
      to: "queued",
      taskId: "task-1",
      cause: "The user restarted it.",
      refs: { commit: "abc123" },
    },
  ]);
  expect(timeline.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
});

test("events roll back with the change they describe", async () => {
  const created = await createTask();
  await expect(
    store.exclusive(async (transaction) => {
      await transaction.update(created.id, created.revision, (task) =>
        transition(task, { type: "approve" }),
      );
      throw new Error("later step failed");
    }),
  ).rejects.toThrow("later step failed");

  const timeline = await readTimeline(home, "task-1");
  expect(timeline.events.map((event) => event.type)).toEqual(["created"]);
});

test("findings, fix rounds, questions, answers, and steers become events without their text", () => {
  const base = {
    id: "task-1",
    stage: "reviewing",
    reviewRound: 1,
    generation: 1,
    updatedAt: "2026-09-01T00:00:00.000Z",
    findingLedger: [ledgerEntry("unresolved", 1)],
    communication: {
      revision: 1,
      messages: [],
      question: { id: "q-1", text: "Which API?" },
    },
  } as unknown as TaskRecord;
  const after = {
    ...base,
    stage: "implementing",
    reviewRound: 2,
    generation: 2,
    iterationScope: { findingIds: ["f1"] },
    findingLedger: [
      ledgerEntry("addressed", 2),
      { ...ledgerEntry("unresolved", 2), id: "f2", category: "tests" },
    ],
    communication: {
      revision: 3,
      messages: [
        { id: "m-1", kind: "answer", replyTo: "q-1", text: "The new one." },
        { id: "m-2", kind: "instruction", text: "Keep the old flag." },
      ],
      question: { id: "q-2", text: "Delete the table?" },
    },
  } as unknown as TaskRecord;

  const events = timelineEventsForChange(base, after);
  expect(events.map(({ taskId: _taskId, at: _at, ...event }) => event)).toEqual([
    { type: "stage-changed", from: "reviewing", to: "implementing" },
    { type: "fix-round", round: 2, generation: 2, findingIds: ["f1"] },
    { type: "finding-settled", findingId: "f1" },
    {
      type: "finding-raised",
      finding: {
        id: "f2",
        lens: "review",
        severity: "P1",
        status: "unresolved",
        category: "tests",
        catchStage: "validation",
      },
    },
    { type: "question-answered", questionId: "q-1", messageId: "m-1" },
    { type: "question-asked", questionId: "q-2" },
    { type: "steered", messageId: "m-2" },
  ]);
  expect(JSON.stringify(events)).not.toContain("Keep the old flag");
  expect(JSON.stringify(events)).not.toContain("lost on rollback");
});

test("an admission wait is recorded only for a queued task whose reason is new", () => {
  expect(admissionWaitToRecord("queued", undefined, "worktree-disk-space")).toBe(
    "worktree-disk-space",
  );
  expect(admissionWaitToRecord("queued", "worktree-disk-space", "worktree-capacity-unknown")).toBe(
    "worktree-capacity-unknown",
  );
  expect(
    admissionWaitToRecord("queued", "worktree-disk-space", "worktree-disk-space"),
  ).toBeUndefined();
  expect(admissionWaitToRecord("queued", "routing-question", undefined)).toBeUndefined();
  expect(admissionWaitToRecord("implementing", undefined, "routing-question")).toBeUndefined();

  const before = {
    id: "task-1",
    stage: "queued",
    reviewRound: 0,
    generation: 1,
    updatedAt: "2026-09-01T00:00:00.000Z",
  } as unknown as TaskRecord;
  const after = { ...before, updatedAt: "2026-09-01T00:05:00.000Z" };
  const note = { admissionWait: "worktree-disk-space", cause: "pool is full" } as const;
  expect(timelineEventsForChange(before, after, note)).toEqual([
    {
      type: "admission-waiting",
      reason: "worktree-disk-space",
      taskId: "task-1",
      at: "2026-09-01T00:05:00.000Z",
      cause: "pool is full",
    },
  ]);
  expect(timelineEventsForChange(before, { ...after, stage: "scouting" }, note)).toEqual([
    {
      type: "stage-changed",
      from: "queued",
      to: "scouting",
      taskId: "task-1",
      at: "2026-09-01T00:05:00.000Z",
      cause: "pool is full",
    },
  ]);
});

test("trace names the reason a queued task waited for admission", () => {
  const events = [
    {
      taskId: "task-1",
      at: "2026-09-01T00:00:00.000Z",
      type: "admission-waiting",
      reason: "worktree-disk-space",
      seq: 1,
    },
    {
      taskId: "task-1",
      at: "2026-09-01T00:01:00.000Z",
      type: "admission-waiting",
      reason: "worktree-capacity-unknown",
      seq: 2,
    },
    {
      taskId: "task-1",
      at: "2026-09-01T00:02:00.000Z",
      type: "admission-waiting",
      reason: "routing-question",
      seq: 3,
    },
  ] as const;
  const text = renderTaskTrace({
    events,
    unreadableEvents: 0,
    rollup: taskRollup("task-1", events, "2026-09-01T00:03:00.000Z", undefined),
  });
  expect(text).toContain("waiting for admission (worktree disk space)");
  expect(text).toContain("waiting for admission (worktree capacity unknown)");
  expect(text).toContain("waiting for admission (routing question)");
});

test("a stored admission wait reads back, and one with an unknown reason is unreadable", async () => {
  const created = await createTask();
  const approved = await store.update(created.id, created.revision, (task) =>
    transition(task, { type: "approve" }),
  );
  await store.update(
    approved.id,
    approved.revision,
    (task) => ({ ...task, revision: task.revision + 1, updatedAt: clock() }),
    { admissionWait: "worktree-disk-space" },
  );
  await recordTimelineEvents(home, [
    {
      taskId: "task-1",
      at: clock(),
      type: "admission-waiting",
      reason: "a-free-lunch",
    } as unknown as TimelineEvent,
  ]);

  const timeline = await readTimeline(home, "task-1");
  expect(timeline.unreadableEvents).toBe(1);
  expect(timeline.events.at(-1)).toMatchObject({
    type: "admission-waiting",
    reason: "worktree-disk-space",
  });
});

test("rollups count the first review verdict, fix rounds, blocked time, and cost", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 0, minute)).toISOString();
  const event = { taskId: "task-1" };
  const events = [
    { ...event, at: at(0), type: "stage-changed", from: "reviewing", to: "awaiting-fixes" },
    { ...event, at: at(1), type: "fix-round", round: 1, generation: 2, findingIds: [] },
    { ...event, at: at(2), type: "blocked", from: "implementing" },
    { ...event, at: at(12), type: "unblocked", to: "implementing" },
    { ...event, at: at(20), type: "stage-changed", from: "reviewing", to: "ready" },
    { ...event, at: at(30), type: "blocked", from: "ready" },
  ] as const;
  const cost = {
    currency: "USD" as const,
    amountMicros: 1_500_000,
    actualSamples: 0,
    estimatedSamples: 2,
    unavailableSamples: 1,
  };

  const rollup = taskRollup("task-1", events, at(35), cost);
  expect(rollup).toEqual({
    taskId: "task-1",
    firstPassReview: false,
    fixRounds: 1,
    blockedMs: 15 * 60_000,
    cost,
  });

  const passed = taskRollup(
    "task-2",
    [{ ...event, at: at(0), type: "stage-changed", from: "reviewing", to: "ready" }],
    at(1),
    undefined,
  );
  const unreviewed = taskRollup("task-3", [], at(1), undefined);
  const summary = summarizeRollups([rollup, passed, unreviewed]);
  expect(summary).toMatchObject({
    tasks: 3,
    reviewedTasks: 2,
    firstPassReviews: 1,
    fixRounds: 1,
    blockedMs: 15 * 60_000,
    costMicros: 1_500_000,
    unpricedSamples: 1,
  });
  expect(renderTraceSummary(summary)).toContain("First-pass review rate: 50% (1 of 2)");
  const text = renderTaskTrace({
    events: events.map((entry, seq) => ({ ...entry, seq })),
    unreadableEvents: 0,
    rollup,
  });
  expect(text).toContain("First review: needed fixes");
  expect(text).toContain("Time blocked: 15m");
  expect(text).toContain("Cost: $1.50, 1 samples unpriced");
});
