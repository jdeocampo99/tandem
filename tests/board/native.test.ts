import { expect, test } from "bun:test";
import { z } from "zod";
import { nativeBoardView } from "../../src/board/native.ts";
import {
  nativeChangeSignature,
  nativePrFile,
  nativeSummaryProjects,
  nativeViewText,
} from "../../src/board/native-views.ts";
import {
  type NativeTaskSummary,
  nativePanelView,
  nativeProjectSwitcher,
} from "../../src/board/panel.ts";
import type { BoardSnapshot } from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
import { createRequestBriefRecord } from "../../src/requests/brief.ts";
import { task } from "../session/fixtures.ts";
import { content, NOW, state, watch } from "./fixtures.ts";

const PROJECT = "/work/app";

test("native envelope revisions change with model content and stay stable across key order and kinds", () => {
  const schema = z
    .object({ version: z.literal(1), kind: z.string(), revision: z.string(), model: z.unknown() })
    .strict();
  const first = schema.parse(
    JSON.parse(nativeViewText("task", { header: { title: "Before", id: "task-1" }, rows: [1, 2] })),
  );
  const reordered = schema.parse(
    JSON.parse(nativeViewText("task", { rows: [1, 2], header: { id: "task-1", title: "Before" } })),
  );
  expect(reordered).toEqual(first);
  const changed = schema.parse(
    JSON.parse(nativeViewText("task", { header: { title: "After", id: "task-1" }, rows: [1, 2] })),
  );
  expect(changed.revision).not.toBe(first.revision);
  const movedRow = schema.parse(
    JSON.parse(nativeViewText("task", { header: { title: "Before", id: "task-1" }, rows: [2, 1] })),
  );
  expect(movedRow.revision).not.toBe(first.revision);
  for (const kind of ["panel", "task", "brief", "pr"] as const) {
    const file = schema.parse(JSON.parse(nativeViewText(kind, first.model)));
    expect(file.kind).toBe(kind);
    expect(file.revision).toBe(first.revision);
  }
  expect(() => nativeViewText("task", { invalid: Number.NaN })).toThrow("finite JSON");
});

test("published summaries keep stale project counts visible but never expose a stale focus session", () => {
  const summary = {
    terminal: "tern" as const,
    repoPath: PROJECT,
    name: "app",
    writtenAt: NOW,
    running: 2,
    needsYou: 1,
    ready: 0,
    done: 0,
    sessionId: "live-session",
  };
  const fresh = nativeSummaryProjects([summary], PROJECT, NOW)[0];
  expect(fresh).toMatchObject({
    current: true,
    offline: false,
    running: 2,
    needsYou: 1,
    sessionId: "live-session",
  });
  const stale = nativeSummaryProjects(
    [{ ...summary, writtenAt: "2030-01-01T11:59:49.000Z" }],
    PROJECT,
    NOW,
  )[0];
  expect(stale).toMatchObject({ offline: true, running: 2, needsYou: 1, status: "offline" });
  expect(stale).not.toHaveProperty("sessionId");
  expect(nativePrFile("acme/app", 282)).not.toBe(nativePrFile("acme/other", 282));
  expect(nativePrFile("acme/app", 282)).not.toContain("/");
});
const running = task({
  id: "task-running",
  repoPath: PROJECT,
  stage: "implementing",
  title: "Tern adapter",
  createdAt: "2030-01-01T11:48:00Z",
  pullRequest: { repository: "acme/app", number: 283, state: "draft", head: "abc", base: "main" },
});
const ready = task({
  id: "task-ready",
  repoPath: PROJECT,
  stage: "ready",
  title: "Terminal port",
  pullRequest: { repository: "acme/app", number: 281, state: "draft", head: "abc", base: "main" },
});
const stuck = task({
  id: "task-stuck",
  repoPath: PROJECT,
  stage: "blocked",
  previousStage: "reviewing",
  title: "Fix panel width",
  blockReason: "same 2 problems twice",
});
const snapshot: BoardSnapshot = {
  version: 1,
  writtenAt: NOW,
  board: boardView(
    state({
      tasks: [
        running,
        ready,
        stuck,
        task({ id: "task-other", repoPath: "/work/tandem", stage: "awaiting-approval" }),
      ],
      briefs: [
        createRequestBriefRecord(
          { id: "req-brief", repoPath: PROJECT, content: content("Tern backend") },
          NOW,
        ),
      ],
      watches: [
        watch(
          283,
          { color: "yellow", status: "📝 draft", note: "Worker is fixing a failed check" },
          { taskId: running.id, repoPath: PROJECT },
        ),
      ],
      activities: new Map([
        [
          running.id,
          {
            tool: "edit",
            toolTarget: "tern/adapter.ts",
            toolStartedAt: "2030-01-01T11:59:56Z",
            todos: [{ content: "should stay on overview", status: "in_progress" }],
          },
        ],
      ]),
    }),
    NOW,
  ),
  coordinators: [{ repoPath: PROJECT, project: "app", workspaceId: "tab-2", paneId: "pane-2" }],
};
const summaries: readonly NativeTaskSummary[] = [running, ready, stuck].map((task) => ({
  taskId: task.id,
  title: task.title ?? task.objective,
  stage: task.stage,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  ...(task.previousStage === undefined ? {} : { previousStage: task.previousStage }),
  model: "claude-code/opus",
  harness: "claude-code",
  branch: `tandem/${task.id}`,
  unpricedSamples: 0,
  ...(task.pullRequest === undefined
    ? {}
    : {
        pullRequest: {
          repo: task.pullRequest.repository,
          number: task.pullRequest.number,
          url: `https://github.com/acme/app/pull/${task.pullRequest.number}`,
          draft: true,
        },
      }),
}));

test("native panel rounds quota text and preserves the numeric meter", () => {
  for (const remainingPercent of [15.000000000000002, 85.4]) {
    const view = nativePanelView({
      snapshot,
      project: PROJECT,
      now: NOW,
      tasks: summaries,
      bellCount: 0,
      fiveHour: {
        provider: "anthropic",
        account: "fixture",
        window: "five-hour",
        label: "5h",
        remainingPercent,
        resetInMs: 8_040_000,
        fetchedAt: NOW,
      },
    });
    expect(view.header.fiveHourLabel).toBe(
      remainingPercent < 50 ? "5h 85% · 2h 14m" : "5h 15% · 2h 14m",
    );
    expect(view.header.fiveHour?.remainingPercent).toBe(remainingPercent);
  }
});

test("native panel keeps an active task with a draft PR running and shows model and live tool on one dim line", () => {
  const view = nativePanelView({
    snapshot,
    project: PROJECT,
    now: NOW,
    tasks: summaries,
    bellCount: 3,
  });
  expect(view.header.bellCount).toBe(3);
  expect(view.header.fiveHourLabel).toBe("5h unavailable");
  expect(view.header.otherProjectsNeedYou).toBe(1);
  expect(view.sections.map((section) => section.title)).toEqual([
    "Needs you",
    "Running",
    "Ready",
    "Recently done",
  ]);
  const row = view.sections[1]?.rows[0];
  expect(row?.title).toBe("Tern adapter");
  expect(row?.time).toBe("12m");
  expect(row?.secondary).toBe("claude-code/opus · edit tern/adapter.ts · #283 draft");
  expect(row?.target).toEqual({ kind: "task", taskId: running.id });
  expect(view.sections[2]?.rows).toHaveLength(1);
  expect(JSON.stringify(view)).not.toContain("should stay on overview");
  expect(view.sections[0]?.rows.find((row) => row.key === `task:${stuck.id}`)?.detail).toBe(
    "same 2 problems twice",
  );
  expect(view.sections[0]?.rows.find((row) => row.key === "brief:req-brief")?.target).toEqual({
    kind: "brief",
    requestId: "req-brief",
  });
});

test("switcher distinguishes projects by path and reports offline, needs-you, current and shortcuts", () => {
  const rows = nativeProjectSwitcher(
    snapshot,
    PROJECT,
    new Map([[PROJECT, { terminal: "tern", sessionId: "session-2" }]]),
  );
  const current = rows.find((row) => row.current);
  expect(current).toMatchObject({
    terminal: "tern",
    repoPath: PROJECT,
    running: 1,
    needsYou: 3,
    offline: false,
    sessionId: "session-2",
  });
  expect(current?.status).toBe("1 running · 3 needs you");
  expect(rows.find((row) => !row.current)?.offline).toBe(true);
  for (const terminal of ["herdr", "unknown"]) {
    const foreign = nativeProjectSwitcher(
      snapshot,
      PROJECT,
      new Map([[PROJECT, { terminal, sessionId: "session-2" }]]),
    );
    expect(foreign.find((row) => row.current)).not.toHaveProperty("sessionId");
  }
});

test("board is view-only with no duplicate active PR card and preserves review stops and links", () => {
  const view = nativeBoardView(snapshot, PROJECT, summaries, NOW);
  expect(view.viewOnly).toBe(true);
  expect(view.lanes[0]?.cards.map((card) => card.title)).toEqual(["Tern adapter"]);
  expect(view.lanes[2]?.cards[0]).toMatchObject({
    title: "Fix panel width",
    stuck: true,
    branch: "tandem/task-stuck",
  });
  expect(view.lanes[3]?.cards[0]?.pullRequest?.number).toBe(281);
});

test("catch-up signature ignores ordering but detects a task stage change", () => {
  const input = {
    tasks: [
      { id: "a", stage: "implementing", generation: 0, reviewRound: 0 },
      { id: "b", stage: "ready", generation: 0, reviewRound: 0 },
    ],
    briefs: [],
    workstreams: [],
    pullRequests: [],
  };
  expect(nativeChangeSignature(input)).toBe(
    nativeChangeSignature({ ...input, tasks: input.tasks.toReversed() }),
  );
  expect(nativeChangeSignature(input)).not.toBe(
    nativeChangeSignature({
      ...input,
      tasks: [{ id: "a", stage: "blocked", generation: 0, reviewRound: 0 }],
    }),
  );
});
