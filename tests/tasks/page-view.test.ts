import { expect, test } from "bun:test";
import type { TaskRecord } from "../../src/contracts.ts";
import type { TaskInspection } from "../../src/tasks/inspection.ts";
import { taskPageView } from "../../src/tasks/page-view.ts";
import type { StoredTimelineEvent } from "../../src/tasks/timeline.ts";
import { task } from "../session/fixtures.ts";

function inspection(record: TaskRecord): TaskInspection {
  return {
    taskId: record.id,
    stage: record.stage,
    generation: record.generation,
    reviewRound: 1,
    codeFixRounds: { used: 1, remaining: 1, max: 2 },
    review: { exactHead: false, clean: true, unmerged: false },
    repository: { recordedPath: record.repoPath, identity: "proven" },
    branch: "tandem/tern-adapter",
    worktree: { preserved: true },
    lease: { state: "none" },
    endpoints: [],
    jobs: [],
    artifacts: [],
    reservations: [],
    operations: [],
    blocked: record.stage === "blocked",
    safetyReasons: [],
  };
}
const now = "2030-01-02T03:16:05.000Z";
const events: StoredTimelineEvent[] = [
  {
    taskId: "task-1",
    seq: 1,
    at: "2030-01-02T03:04:05.000Z",
    type: "created",
    stage: "implementing",
  },
  {
    taskId: "task-1",
    seq: 2,
    at: "2030-01-02T03:07:05.000Z",
    type: "stage-changed",
    from: "implementing",
    to: "validating",
  },
  {
    taskId: "task-1",
    seq: 3,
    at: "2030-01-02T03:10:05.000Z",
    type: "stage-changed",
    from: "validating",
    to: "reviewing",
  },
  {
    taskId: "task-1",
    seq: 4,
    at: "2030-01-02T03:12:05.000Z",
    type: "stage-changed",
    from: "reviewing",
    to: "awaiting-fixes",
  },
  {
    taskId: "task-1",
    seq: 5,
    at: "2030-01-02T03:12:05.000Z",
    type: "fix-round",
    round: 1,
    generation: 0,
    findingIds: ["finding-1"],
  },
  {
    taskId: "task-1",
    seq: 6,
    at: "2030-01-02T03:15:05.000Z",
    type: "steered",
    messageId: "message-1",
  },
];

test("task page puts to-dos only in Overview and shows the real fix round, live activity and recent events", () => {
  const record = task({ stage: "awaiting-fixes", reviewRound: 1 });
  const view = taskPageView({
    task: record,
    inspection: inspection(record),
    timeline: events,
    unreadableEvents: 2,
    now,
    model: "claude-code/opus",
    activity: {
      tool: "edit",
      toolTarget: "tern/adapter.ts",
      toolStartedAt: "2030-01-02T03:16:01.000Z",
      todos: [
        { content: "Fix close guard", status: "in_progress" },
        { content: "Port", status: "completed" },
      ],
    },
  });
  expect(view.header).toMatchObject({
    model: "claude-code/opus",
    elapsed: "12m",
    branch: "tandem/tern-adapter",
  });
  expect(view.rightNow).toMatchObject({ text: "edit tern/adapter.ts", age: "4s" });
  expect(view.stageTrack.find((step) => step.stage === "awaiting-fixes")).toMatchObject({
    state: "current",
    round: { used: 1, max: 2 },
  });
  expect(view.overview).toMatchObject({ done: 1, total: 2 });
  expect(view.overview.recent).toHaveLength(5);
  expect(view.overview.recent[0]?.type).toBe("steered");
  expect(view.progress.unreadableEvents).toBe(2);
  expect(JSON.stringify(view.header)).not.toContain("Fix close guard");
});

test("a blocked task exposes a plain reason and recovery actions while refusing mismatched inspection", () => {
  const record = task({
    stage: "blocked",
    previousStage: "awaiting-fixes",
    blockReason: "same two problems twice",
  });
  const input = {
    task: record,
    inspection: inspection(record),
    timeline: events,
    unreadableEvents: 0,
    now,
  };
  expect(taskPageView(input).stuck).toEqual({
    reason: "same two problems twice",
    actions: ["restart", "steer"],
  });
  expect(() =>
    taskPageView({ ...input, inspection: { ...input.inspection, generation: 2 } }),
  ).toThrow("match");
});
