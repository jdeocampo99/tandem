import { expect, test } from "bun:test";
import {
  type CachedPullRequest,
  prMarkdownBlocks,
  prPaneView,
} from "../../src/pr-review/native-view.ts";

const now = "2030-01-01T12:00:00Z";
const cached: CachedPullRequest = {
  repo: "acme/app",
  number: 281,
  title: "Terminal port",
  url: "https://github.com/acme/app/pull/281",
  head: "abc",
  draft: true,
  body: "## What\nPort",
  commits: 3,
  additions: 1,
  deletions: 1,
  readAt: now,
  checks: [
    { name: "tests", state: "running", startedAt: "2030-01-01T11:58:43Z" },
    {
      name: "lint",
      state: "passed",
      startedAt: "2030-01-01T11:57:00Z",
      completedAt: "2030-01-01T11:57:09Z",
    },
  ],
  threads: [
    {
      id: "left",
      file: "src/a.ts",
      line: 1,
      side: "LEFT",
      resolved: false,
      outdated: false,
      comments: [{ id: "c1", author: "reviewer", at: now, body: "Keep this" }],
    },
    {
      id: "right",
      file: "src/a.ts",
      line: 1,
      side: "RIGHT",
      resolved: false,
      outdated: false,
      comments: [
        { id: "c2", author: "you", at: now, body: "Typed error?" },
        { id: "c3", author: "worker", at: now, body: "Fixed" },
      ],
    },
    {
      id: "outdated",
      file: "removed.ts",
      side: "RIGHT",
      resolved: true,
      outdated: true,
      comments: [],
    },
  ],
  conversation: [],
  patch:
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n--- old\n+new\n",
  tour: [
    {
      title: "Introduce the port",
      why: "one choice",
      stops: [{ file: "src/a.ts", from: 1, to: 1, title: "Choose backend", body: "Single owner" }],
    },
  ],
};

test("native PR diff anchors both sides and replies while retaining outdated threads", () => {
  const view = prPaneView({ cached, now });
  expect(view.header).toMatchObject({
    unresolved: 2,
    firstThreadId: "left",
    next: "Waiting on you: publish it (draft → ready)",
  });
  expect(view.files[0]?.rows[1]?.row).toEqual({ kind: "del", text: "-- old", old: 1 });
  expect(view.files[0]?.rows[1]?.threads[0]?.id).toBe("left");
  expect(view.files[0]?.rows[2]?.threads[0]?.comments).toHaveLength(2);
  expect(view.unanchoredThreads[0]?.id).toBe("outdated");
  expect(view.tour[0]?.stops[0]?.rowIds).toEqual(["src/a.ts:2"]);
  expect(view.checks[0]).toMatchObject({ elapsedMs: 77000 });
  expect(view.checks[1]).toMatchObject({ duration: "9s" });
  expect(prPaneView({ cached, now: "2030-01-01T13:00:00Z" })).toEqual(view);
  expect(view.commentDestination).toBe("worker");
});

test("PRs without a tour hide its tab and reviews carry the commit and posted binding", () => {
  const review = {
    taskId: "task-review",
    generation: 2,
    head: "abc",
    currentHead: "abc",
    posted: false,
    verdict: "Safe after tests",
    intent: "One backend port",
    summary: "Fix the close guard",
    concerns: [],
    notes: [],
    drafts: [
      {
        id: "draft-1",
        file: "src/a.ts",
        line: 1,
        severity: "blocking" as const,
        body: "Close still busy",
      },
    ],
  };
  const view = prPaneView({ cached: { ...cached, tour: [] }, now, review });
  expect(view.tabs).toEqual(["Description", "Diff"]);
  expect(view.commentDestination).toBe("review");
  expect(view.review).toEqual(review);
  expect(view.files[0]?.rows[2]?.drafts[0]?.id).toBe("draft-1");
});

test("PR Markdown blocks preserve blank lines inside a fence and separate headings", () => {
  expect(
    prMarkdownBlocks(
      "## What\nParagraph\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- first\n- second",
    ),
  ).toEqual([
    "## What",
    "Paragraph",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "- first\n- second",
  ]);
});
