import { expect, test } from "bun:test";
import { panelProject, panelView } from "../../src/board/panel.ts";
import type { BoardSnapshot } from "../../src/board/snapshot.ts";
import { type BoardState, boardView } from "../../src/board/view.ts";
import { createRequestBriefRecord } from "../../src/requests/brief.ts";
import { task } from "../session/fixtures.ts";
import { content, NOW, state, watch } from "./fixtures.ts";

const APP = "/work/app";
const TANDEM = "/work/tandem";

function snapshot(overrides: Partial<BoardState> = {}, writtenAt = NOW): BoardSnapshot {
  return {
    version: 1,
    writtenAt,
    board: boardView(state(overrides), NOW),
    coordinators: [{ repoPath: APP, project: "app", workspaceId: "w2", paneId: "w2:p1" }],
  };
}

const EVERY_KIND = snapshot({
  briefs: [
    createRequestBriefRecord({ id: "req-1", repoPath: APP, content: content("Dark mode") }, NOW),
  ],
  tasks: [
    task({
      id: "task-q",
      repoPath: APP,
      stage: "implementing",
      objective: "Refactor cache",
      communication: {
        revision: 1,
        messages: [],
        question: { id: "q-1", text: "Keep the old order?" },
      },
    }),
    task({
      id: "task-stop",
      repoPath: APP,
      stage: "blocked",
      objective: "Retry research",
      blockReason: "reviewer timed out",
    }),
    task({
      id: "task-impl",
      repoPath: APP,
      stage: "implementing",
      objective: "Fix login",
      createdAt: "2030-01-01T11:48:00.000Z",
    }),
    task({
      id: "task-review",
      repoPath: APP,
      stage: "reviewing",
      objective: "Add cache",
      createdAt: "2030-01-01T11:58:00.000Z",
    }),
    task({ id: "task-queued", repoPath: APP, stage: "queued", objective: "Queued work" }),
    task({ id: "task-paused", repoPath: APP, stage: "paused", objective: "Paused work" }),
    task({ id: "task-pr", repoPath: APP, stage: "implementing", objective: "Has a draft PR" }),
    task({
      id: "task-done",
      repoPath: APP,
      stage: "merged",
      objective: "Shipped",
      updatedAt: "2030-01-01T10:00:00.000Z",
    }),
    task({
      id: "task-elsewhere",
      repoPath: TANDEM,
      stage: "blocked",
      objective: "Stuck in tandem",
    }),
  ],
  workerPanes: new Map([["task-impl", { workspaceId: "w3", paneId: "w3:p2" }]]),
  watches: [
    watch(
      412,
      { color: "yellow", status: "👀 review", note: "waiting on @alice · 2d" },
      { taskId: "task-pr", repoPath: APP },
    ),
    watch(
      409,
      { color: "red", status: "❌ failing", note: "test_cache failed twice" },
      { repoPath: APP },
    ),
  ],
});

test("every row kind lands in its section with its stage, color, second line, and target", () => {
  const view = panelView(EVERY_KIND, { project: APP, query: "", now: NOW, readFailed: false });
  const rows = Object.fromEntries(
    view.sections.map((section) => [
      section.title,
      section.rows.map((row) => [
        row.name,
        row.stage,
        row.color,
        row.lines.join(" / "),
        row.target,
      ]),
    ]),
  );
  expect(rows).toEqual({
    "Needs you": [
      [
        "Dark mode",
        "brief to approve",
        "yellow",
        "brief waiting for approval",
        { kind: "chat", repoPath: APP },
      ],
      [
        "Refactor cache",
        "question",
        "yellow",
        "Keep the old order?",
        { kind: "chat", repoPath: APP },
      ],
      ["Retry research", "stopped", "red", "reviewer timed out", { kind: "chat", repoPath: APP }],
      [
        "acme/app#409 branch-409",
        "PR failing",
        "red",
        "test_cache failed twice",
        { kind: "url", url: "https://github.com/acme/app/pull/409" },
      ],
    ],
    Running: [
      [
        "Fix login",
        "implementing",
        "blue",
        "for 12m",
        { kind: "pane", workspaceId: "w3", paneId: "w3:p2" },
      ],
      ["Add cache", "in review", "magenta", "for 2m", { kind: "none" }],
      [
        "Queued work",
        "waiting to start",
        "yellow",
        "waiting for a free worktree",
        { kind: "none" },
      ],
      ["Paused work", "paused", "yellow", "paused by you", { kind: "none" }],
    ],
    "Pull requests": [
      [
        "#412 branch-412",
        "review",
        "yellow",
        "waiting on @alice · 2d",
        { kind: "url", url: "https://github.com/acme/app/pull/412" },
      ],
    ],
    "Done today": [["Shipped", "done", "green", "merged", { kind: "chat", repoPath: APP }]],
  });
  expect(view.summary).toBe("4 need you · 3 running");
  expect(view.footer).toBeUndefined();
});

test("one chip per project numbers it, counts what needs you, marks the current one, and says offline", () => {
  const view = panelView(EVERY_KIND, { project: APP, query: "", now: NOW, readFailed: false });
  expect(view.chips).toEqual([
    { number: 1, name: "tandem", repoPath: TANDEM, needsYou: 1, current: false, offline: true },
    { number: 2, name: "app", repoPath: APP, needsYou: 4, current: true, offline: false },
  ]);
});

test("search matches names and kind words across projects, grouped by project, every word required", () => {
  const titles = (query: string) =>
    panelView(EVERY_KIND, { project: APP, query, now: NOW, readFailed: false }).sections.map(
      (section) => [section.title, section.rows.map((row) => row.name)],
    );
  expect(titles("stuck")).toEqual([
    ["tandem", ["Stuck in tandem"]],
    ["app", ["Retry research"]],
  ]);
  expect(titles("stuck tandem")).toEqual([["tandem", ["Stuck in tandem"]]]);
  expect(titles("pr")).toEqual([["app", ["acme/app#409 branch-409", "#412 branch-412"]]]);
  expect(titles("review")).toEqual([["app", ["Add cache", "#412 branch-412"]]]);
  expect(titles("queued")).toEqual([["app", ["Queued work"]]]);
  expect(titles("done")).toEqual([["app", ["Shipped"]]]);
  expect(titles("needs you login")).toEqual([]);
  expect(titles("LOGIN")).toEqual([["app", ["Fix login"]]]);
});

test("a project with nothing needing the user or running is all quiet", () => {
  const view = panelView(snapshot(), { project: APP, query: "", now: NOW, readFailed: false });
  expect(view.quiet).toBe(true);
  expect(view.sections).toEqual([]);
  expect(view.summary).toBe("0 need you · 0 running");
});

test("the footer says why the panel may be out of date", () => {
  const options = { project: APP, query: "", now: NOW };
  expect(panelView(undefined, { ...options, readFailed: false }).footer).toBe("⚠ no status yet");
  expect(panelView(undefined, { ...options, readFailed: true }).footer).toBe(
    "⚠ can't read state, retrying",
  );
  const old = snapshot({}, "2030-01-01T11:59:17.000Z");
  expect(panelView(old, { ...options, readFailed: true }).footer).toBe(
    "⚠ updated 43s ago · can't read state, retrying",
  );
  expect(panelView(old, { ...options, readFailed: false }).footer).toBe(
    "⚠ updated 43s ago · no coordinator running",
  );
  const fresh = snapshot({}, "2030-01-01T11:59:55.000Z");
  expect(panelView(fresh, { ...options, readFailed: false }).footer).toBeUndefined();
});

test("rows are marked when their stage or words changed since the user looked, not as time passes", () => {
  const options = { project: APP, query: "", now: NOW, readFailed: false };
  const seen = new Set(panelView(EVERY_KIND, options).signatures);
  const later = snapshot({
    tasks: [
      task({
        id: "task-impl",
        repoPath: APP,
        stage: "validating",
        objective: "Fix login",
        createdAt: "2030-01-01T11:48:00.000Z",
      }),
      task({
        id: "task-review",
        repoPath: APP,
        stage: "reviewing",
        objective: "Add cache",
        createdAt: "2030-01-01T11:30:00.000Z",
      }),
    ],
  });
  const marked = panelView(later, { ...options, seen });
  expect(
    marked.sections.flatMap((section) => section.rows.map((row) => [row.key, row.changed])),
  ).toEqual([
    ["task:task-impl", true],
    ["task:task-review", false],
  ]);
});

test("what was seen covers every project, so a search or another project marks nothing new", () => {
  const searching = panelView(EVERY_KIND, {
    project: APP,
    query: "stuck",
    now: NOW,
    readFailed: false,
  });
  const seen = new Set(searching.signatures);
  const back = panelView(EVERY_KIND, {
    project: APP,
    query: "",
    now: NOW,
    readFailed: false,
    seen,
  });
  expect(back.sections.flatMap((section) => section.rows.filter((row) => row.changed))).toEqual([]);
});

test("search reads the query's words the way it reads rows, so branches, numbers, and repos match", () => {
  const names = (query: string) =>
    panelView(EVERY_KIND, { project: APP, query, now: NOW, readFailed: false }).sections.flatMap(
      (section) => section.rows.map((row) => row.name),
    );
  expect(names("#412")).toEqual(["#412 branch-412"]);
  expect(names("branch-409")).toEqual(["acme/app#409 branch-409"]);
  expect(names("acme/app review")).toEqual(["#412 branch-412"]);
});

test("a merged task with a finished pull request shows only under Done today", () => {
  const merged = snapshot({
    tasks: [
      task({
        id: "task-merged",
        repoPath: APP,
        stage: "merged",
        objective: "Shipped",
        updatedAt: "2030-01-01T10:00:00.000Z",
      }),
    ],
    watches: [
      watch(
        420,
        { color: "done", status: "✅ merged", note: "" },
        { taskId: "task-merged", repoPath: APP, finishedAt: "2030-01-01T10:00:00.000Z" },
      ),
    ],
  });
  const view = panelView(merged, { project: APP, query: "", now: NOW, readFailed: false });
  expect(
    view.sections.map((section) => [section.title, section.rows.map((row) => row.name)]),
  ).toEqual([["Done today", ["Shipped"]]]);
});

test("the panel's project is the longest project path holding the directory", () => {
  const paths = ["/work/app", "/work/app/packages/ui", "/work/tandem"];
  expect(panelProject(paths, "/work/app/packages/ui/src")).toBe("/work/app/packages/ui");
  expect(panelProject(paths, "/work/app")).toBe("/work/app");
  expect(panelProject(paths, "/work/apple")).toBe("/work/app");
});
