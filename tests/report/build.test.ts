import { expect, test } from "bun:test";
import type { TaskRecord } from "../../src/contracts.ts";
import {
  buildReportView,
  buildTaskReport,
  formatDuration,
  reportTitle,
} from "../../src/report/build.ts";
import type { ReportTask } from "../../src/report/model.ts";
import {
  REQUEST_USAGE_EVENT_SCHEMA_VERSION,
  type RequestUsageEvent,
  type RequestWorkKind,
  requestUsageEventKey,
} from "../../src/runtime/usage.ts";
import type { RequestUsageReadout } from "../../src/runtime/usage-receipt.ts";
import type { StoredTimelineEvent, TimelineEvent } from "../../src/tasks/timeline.ts";
import { taskCost } from "../../src/tasks/trace.ts";
import { task } from "../session/fixtures.ts";

const TASK_ID = "task-1";
const REQUEST_ID = "req-1";
const CREATED = "2030-01-01T00:00:00.000Z";
const MINUTE = 60_000;

function at(minutes: number): string {
  return new Date(Date.parse(CREATED) + minutes * MINUTE).toISOString();
}

type Facts = TimelineEvent extends infer Event
  ? Event extends TimelineEvent
    ? Omit<Event, "taskId" | "at">
    : never
  : never;

function timeline(...entries: readonly (readonly [number, Facts])[]) {
  const events: StoredTimelineEvent[] = entries.map(([minutes, facts], index) => ({
    ...facts,
    taskId: TASK_ID,
    at: at(minutes),
    seq: index + 1,
  }));
  return { events, unreadableEvents: 0 };
}

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return task({
    id: TASK_ID,
    createdAt: CREATED,
    updatedAt: CREATED,
    stage: "ready",
    ...overrides,
  });
}

function work(
  workKind: RequestWorkKind,
  fromMinutes: number,
  toMinutes: number,
  amountMicros: number | undefined,
  identity: Readonly<{ taskId?: string; role?: string; model?: string; attempt?: number }> = {},
): RequestUsageEvent {
  const fullIdentity = {
    requestId: REQUEST_ID,
    taskId: TASK_ID,
    operationId: `${workKind}-${fromMinutes}`,
    ...identity,
  };
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({
      kind: "work",
      identity: fullIdentity,
      discriminator: "settled",
    }),
    kind: "work",
    workKind,
    identity: fullIdentity,
    startedAt: at(fromMinutes),
    endedAt: at(toMinutes),
    status: "succeeded",
    tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
    charge:
      amountMicros === undefined
        ? { provenance: "unavailable", reason: "no-provider-boundary" }
        : {
            provenance: "actual",
            currency: "USD",
            amountMicros,
            pricingSource: "test",
            pricingVersion: 1,
          },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
  };
}

function stage(from: TaskRecord["stage"], to: TaskRecord["stage"]): Facts {
  return { type: "stage-changed", from, to };
}

test("segments, lanes, and buckets end the window at the first entry into ready", () => {
  const report = buildTaskReport({
    task: record({ stage: "merged" }),
    timeline: timeline(
      [0, { type: "created", stage: "queued" }],
      [2, stage("queued", "implementing")],
      [30, stage("implementing", "validating")],
      [40, stage("validating", "reviewing")],
      [50, stage("reviewing", "ready")],
      [300, stage("ready", "merged")],
    ),
    usage: undefined,
    now: at(1000),
  });
  expect(report.wallMs).toBe(50 * MINUTE);
  expect(report.status).toBe("merged");
  expect(report.segments).toEqual([
    { lane: "queued", stage: "queued", startMs: 0, endMs: 2 * MINUTE },
    { lane: "implement", stage: "implementing", startMs: 2 * MINUTE, endMs: 30 * MINUTE },
    { lane: "validate", stage: "validating", startMs: 30 * MINUTE, endMs: 40 * MINUTE },
    { lane: "review", stage: "reviewing", startMs: 40 * MINUTE, endMs: 50 * MINUTE },
  ]);
  expect(report.buckets).toEqual({
    working: 48 * MINUTE,
    "waiting-on-you": 0,
    "held-up": 2 * MINUTE,
  });
  expect(report.lanes.map((lane) => [lane.lane, lane.durationMs])).toEqual([
    ["implement", 28 * MINUTE],
    ["validate", 10 * MINUTE],
    ["review", 10 * MINUTE],
    ["queued", 2 * MINUTE],
  ]);
  expect(report.choke).toBeUndefined();
  expect(report.lostMs).toBe(2 * MINUTE);
  expect(report.costMicros).toBeUndefined();
  expect(report.unpricedSamples).toBe(0);
});

test("an open task runs until now, and awaiting-fixes draws in the implement lane", () => {
  const report = buildTaskReport({
    task: record({ stage: "awaiting-fixes" }),
    timeline: timeline(
      [0, { type: "created", stage: "implementing" }],
      [10, stage("implementing", "reviewing")],
      [20, stage("reviewing", "awaiting-fixes")],
    ),
    usage: undefined,
    now: at(25),
  });
  expect(report.status).toBe("in-progress");
  expect(report.wallMs).toBe(25 * MINUTE);
  expect(report.segments.at(-1)).toEqual({
    lane: "implement",
    stage: "awaiting-fixes",
    startMs: 20 * MINUTE,
    endMs: 25 * MINUTE,
  });
  expect(report.lanes.find((lane) => lane.lane === "implement")?.durationMs).toBe(15 * MINUTE);
});

test("a task with no events has no segments and ends at its last write when finished", () => {
  const finished = buildTaskReport({
    task: record({ stage: "completed", updatedAt: at(42) }),
    timeline: { events: [], unreadableEvents: 0 },
    usage: undefined,
    now: at(500),
  });
  expect(finished.segments).toEqual([]);
  expect(finished.wallMs).toBe(42 * MINUTE);
  expect(finished.status).toBe("completed");
  const open = buildTaskReport({
    task: record({ stage: "implementing", updatedAt: at(42) }),
    timeline: { events: [], unreadableEvents: 0 },
    usage: undefined,
    now: at(500),
  });
  expect(open.wallMs).toBe(500 * MINUTE);
});

test("runs, lane costs, and the task's cost come from its own work events", () => {
  const events = [
    work("research", 1, 10, 30_000, { role: "scout", model: "jev" }),
    work("presentation", 8, 10, 20_000),
    work("implementation", 10, 30, 1_000_000, { attempt: 2 }),
    work("validation", 30, 40, undefined),
    work("coordinator", 0, 40, 500_000),
    work("review", 40, 50, 900_000, { taskId: "other-task" }),
  ];
  const usage: RequestUsageReadout = { events, malformedEvents: 0 };
  const report = buildTaskReport({
    task: record({ requestId: REQUEST_ID }),
    timeline: timeline(
      [0, { type: "created", stage: "scouting" }],
      [10, stage("scouting", "implementing")],
      [30, stage("implementing", "validating")],
      [40, stage("validating", "ready")],
    ),
    usage,
    now: at(100),
  });
  expect(report.runs.map((run) => run.workKind)).toEqual([
    "coordinator",
    "research",
    "presentation",
    "implementation",
    "validation",
  ]);
  expect(report.runs[1]).toEqual({
    workKind: "research",
    role: "scout",
    model: "jev",
    startMs: MINUTE,
    endMs: 10 * MINUTE,
    status: "succeeded",
    costMicros: 30_000,
  });
  expect(report.runs[3]?.attempt).toBe(2);
  expect(report.runs[4]?.costMicros).toBeUndefined();
  expect(report.lanes).toEqual([
    { lane: "research", durationMs: 10 * MINUTE, costMicros: 50_000 },
    { lane: "implement", durationMs: 20 * MINUTE, costMicros: 1_000_000 },
    { lane: "validate", durationMs: 10 * MINUTE },
  ]);
  const expected = taskCost(usage, REQUEST_ID, TASK_ID);
  expect(report.costMicros).toBe(expected.amountMicros);
  expect(report.costMicros).toBe(1_550_000);
  expect(report.unpricedSamples).toBe(expected.unavailableSamples);
  expect(report.unpricedSamples).toBe(1);
});

test("a stuck stretch names its stage, its cause, and a restart inside it", () => {
  const report = buildTaskReport({
    task: record({ stage: "completed" }),
    timeline: timeline(
      [0, { type: "created", stage: "implementing" }],
      [30, stage("implementing", "validating")],
      [
        52,
        { type: "blocked", from: "validating", cause: "validation timed out on the pane check" },
      ],
      [140, { type: "restarted", role: "validation", attempt: 1 }],
      [149, { type: "unblocked", to: "validating" }],
      [158, stage("validating", "completed")],
    ),
    usage: undefined,
    now: at(500),
  });
  expect(report.choke).toEqual({
    kind: "stuck",
    startMs: 52 * MINUTE,
    endMs: 149 * MINUTE,
    headline: "Stuck 1h 37m in validation",
    explanation: "Validation timed out on the pane check. Resumed after a restart.",
  });
  expect(report.buckets["held-up"]).toBe(97 * MINUTE);
  expect(report.lostMs).toBe(97 * MINUTE);
});

test("a block still open at the window's end runs to now and has no explanation without a cause", () => {
  const report = buildTaskReport({
    task: record({ stage: "blocked" }),
    timeline: timeline(
      [0, { type: "created", stage: "reviewing" }],
      [10, { type: "blocked", from: "reviewing" }],
    ),
    usage: undefined,
    now: at(40),
  });
  expect(report.choke).toEqual({
    kind: "stuck",
    startMs: 10 * MINUTE,
    endMs: 40 * MINUTE,
    headline: "Stuck 30m in review",
  });
});

test("a question wait follows the work before it", () => {
  const report = buildTaskReport({
    task: record({ kind: "scout", stage: "completed" }),
    timeline: timeline(
      [0, { type: "created", stage: "queued" }],
      [1, stage("queued", "scouting")],
      [38, { type: "question-asked", questionId: "q1" }],
      [122, { type: "question-answered", questionId: "q1" }],
      [130, stage("scouting", "completed")],
    ),
    usage: undefined,
    now: at(500),
  });
  expect(report.choke).toEqual({
    kind: "waiting-on-you",
    startMs: 38 * MINUTE,
    endMs: 122 * MINUTE,
    headline: "Waited 1h 24m on your answer",
    explanation: "Research took 37m, then waited 1h 24m for your answer.",
  });
});

test("an approval wait merges with an overlapping pause", () => {
  const report = buildTaskReport({
    task: record({ stage: "implementing" }),
    timeline: timeline(
      [0, { type: "created", stage: "awaiting-approval" }],
      [20, stage("awaiting-approval", "paused")],
      [30, stage("paused", "implementing")],
    ),
    usage: undefined,
    now: at(40),
  });
  expect(report.choke).toEqual({
    kind: "waiting-on-you",
    startMs: 0,
    endMs: 30 * MINUTE,
    headline: "Waited 30m for your approval",
  });
  expect(report.buckets["waiting-on-you"]).toBe(30 * MINUTE);
  expect(report.lostMs).toBe(30 * MINUTE);
});

test("a queued stretch names the work that followed it", () => {
  const report = buildTaskReport({
    task: record({ kind: "pr-review", stage: "completed" }),
    timeline: timeline(
      [0, { type: "created", stage: "queued" }],
      [26, stage("queued", "reviewing")],
      [44, stage("reviewing", "completed")],
    ),
    usage: undefined,
    now: at(500),
  });
  expect(report.choke).toEqual({
    kind: "queued",
    startMs: 0,
    endMs: 26 * MINUTE,
    headline: "Queued 26m",
    explanation: "Queued 26m. The review then took 18m.",
  });
});

test("a review loop spans from the first failed review and names a shared category", () => {
  const report = buildTaskReport({
    task: record({ stage: "ready" }),
    timeline: timeline(
      [0, { type: "created", stage: "implementing" }],
      [20, stage("implementing", "reviewing")],
      [30, stage("reviewing", "awaiting-fixes")],
      [
        30,
        {
          type: "finding-raised",
          finding: {
            id: "F1",
            lens: "review",
            severity: "P1",
            status: "unresolved",
            category: "requirements",
            catchStage: "planning",
          },
        },
      ],
      [31, { type: "fix-round", round: 1, generation: 1, findingIds: ["F1"] }],
      [31, stage("awaiting-fixes", "implementing")],
      [50, stage("implementing", "reviewing")],
      [60, stage("reviewing", "awaiting-fixes")],
      [
        60,
        {
          type: "finding-raised",
          finding: {
            id: "F2",
            lens: "review",
            severity: "P2",
            status: "unresolved",
            category: "requirements",
          },
        },
      ],
      [61, { type: "fix-round", round: 2, generation: 2, findingIds: ["F2"] }],
      [61, stage("awaiting-fixes", "implementing")],
      [80, stage("implementing", "reviewing")],
      [90, stage("reviewing", "ready")],
    ),
    usage: undefined,
    now: at(500),
  });
  expect(report.choke).toEqual({
    kind: "review-loop",
    startMs: 30 * MINUTE,
    endMs: 90 * MINUTE,
    headline: "Review loop: 2 fix rounds on one finding category",
    explanation:
      "Review raised requirements findings across 2 fix rounds. 1 traced back to the brief.",
  });
  expect(report.buckets["held-up"]).toBe(0);
  expect(report.lostMs).toBe(60 * MINUTE);
});

test("stretches under the threshold and a single fix round name no choke", () => {
  const report = buildTaskReport({
    task: record({ stage: "ready" }),
    timeline: timeline(
      [0, { type: "created", stage: "queued" }],
      [4, stage("queued", "implementing")],
      [30, stage("implementing", "reviewing")],
      [40, stage("reviewing", "awaiting-fixes")],
      [41, { type: "fix-round", round: 1, generation: 1, findingIds: [] }],
      [41, stage("awaiting-fixes", "implementing")],
      [50, { type: "blocked", from: "implementing" }],
      [53, { type: "unblocked", to: "implementing" }],
      [60, stage("implementing", "ready")],
    ),
    usage: undefined,
    now: at(500),
  });
  expect(report.choke).toBeUndefined();
  expect(report.lostMs).toBe(7 * MINUTE);
});

test("the view sorts by lost time, newest first on ties", () => {
  const base = buildTaskReport({
    task: record({ stage: "ready" }),
    timeline: { events: [], unreadableEvents: 0 },
    usage: undefined,
    now: at(0),
  });
  const entry = (id: string, lostMs: number, createdAt: string): ReportTask => ({
    ...base,
    id,
    lostMs,
    createdAt,
  });
  const view = buildReportView({
    tasks: [entry("a", 10, at(0)), entry("b", 50, at(0)), entry("c", 10, at(5))],
    generatedAt: at(100),
    scopeLabel: "tandem",
    unreadableEvents: 3,
  });
  expect(view.tasks.map((item) => item.id)).toEqual(["b", "c", "a"]);
  expect(view.since).toBeUndefined();
  expect(view.unreadableEvents).toBe(3);
  expect(view.schemaVersion).toBe(1);
});

test("titles use the objective's first line, bounded", () => {
  expect(reportTitle("\n  Fix   the\tpane  \nmore detail", "id")).toBe("Fix the pane");
  const long = reportTitle("x".repeat(200), "id");
  expect(long).toHaveLength(80);
  expect(long.endsWith("…")).toBe(true);
  expect(reportTitle("   \n ", "task-9")).toBe("task-9");
  expect(
    buildTaskReport({
      task: record({ objective: "Add --json\nto watch" }),
      timeline: { events: [], unreadableEvents: 0 },
      usage: undefined,
      now: at(0),
    }).title,
  ).toBe("Add --json");
});

test("durations read in minutes, then hours with padded minutes", () => {
  expect(formatDuration(0)).toBe("0m");
  expect(formatDuration(59 * MINUTE + 20_000)).toBe("59m");
  expect(formatDuration(59 * MINUTE + 40_000)).toBe("1h 00m");
  expect(formatDuration(97 * MINUTE)).toBe("1h 37m");
  expect(formatDuration(605 * MINUTE)).toBe("10h 05m");
});
