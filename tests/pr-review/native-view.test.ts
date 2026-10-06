import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { NativeViewsReader } from "../../src/board/native-read.ts";
import { nativePrFile } from "../../src/board/native-views.ts";
import { boardView } from "../../src/board/view.ts";
import { publishViews, viewDetailPath } from "../../src/native/store.ts";
import {
  type CachedPullRequest,
  prMarkdownBlocks,
  prPaneView,
} from "../../src/pr-review/native-view.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { state } from "../board/fixtures.ts";
import { withScenario } from "../evals/scenario.ts";

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
  const view = prPaneView({ cached });
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
  expect(view.checks[0]).toMatchObject({ startedAtMs: Date.parse("2030-01-01T11:58:43Z") });
  expect(view.checks[1]).toMatchObject({ duration: "9s" });
  expect(view).not.toHaveProperty("clockAt");
  expect(view.checks[0]).not.toHaveProperty("elapsedMs");
  expect(view.commentDestination).toBe("read-only");
  expect(view.readOnlyReason).toContain("no Tandem task");
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
  const view = prPaneView({ cached: { ...cached, tour: [] }, review });
  expect(view.tabs).toEqual(["Description", "Diff"]);
  expect(view.commentDestination).toBe("review");
  expect(view.review).toEqual(review);
  expect(view.header.next).toBe("Waiting on you: choose comments and post your review");
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

test("publication clock advances leave running CI detail bytes, inode and mtime unchanged", async () => {
  await withScenario({}, async (world) => {
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run: world.run,
      terminal: terminalBackend(world.run),
    });
    const file = nativePrFile(cached.repo, cached.number);
    const path = viewDetailPath(world.home, world.repoPath, file);
    const publish = async (pr: CachedPullRequest) => {
      const publication = await reader.read(
        {
          version: 1,
          writtenAt: world.clock(),
          board: boardView(state({ projects: [world.repoPath] }), world.clock()),
          coordinators: [],
        },
        world.repoPath,
      );
      const model = prPaneView({ cached: pr });
      await publishViews(world.home, world.repoPath, async () => ({
        bundle: {
          ...publication.bundle,
          pullRequests: {
            [`${pr.repo}#${pr.number}`]: {
              header: model.header,
              readAt: model.readAt,
              detailFile: file,
            },
          },
        },
        details: [{ file, view: { version: 1, project: world.repoPath, kind: "pr", data: model } }],
      }));
    };
    try {
      await publish(cached);
      const before = await readFile(path, "utf8");
      const metadata = await stat(path);
      world.advanceClock(60);
      await publish(cached);
      expect(await readFile(path, "utf8")).toBe(before);
      expect((await stat(path)).ino).toBe(metadata.ino);
      expect((await stat(path)).mtimeMs).toBe(metadata.mtimeMs);
      const complete: CachedPullRequest = {
        ...cached,
        checks: cached.checks.map((check) =>
          check.state === "running"
            ? { ...check, state: "passed", completedAt: "2030-01-01T12:01:00Z" }
            : check,
        ),
      };
      await publish(complete);
      expect(await readFile(path, "utf8")).not.toBe(before);
      expect((await stat(path)).ino).not.toBe(metadata.ino);
      const completedBytes = await readFile(path, "utf8");
      const completedMetadata = await stat(path);
      world.advanceClock(60);
      await publish(complete);
      expect(await readFile(path, "utf8")).toBe(completedBytes);
      expect((await stat(path)).ino).toBe(completedMetadata.ino);
      expect((await stat(path)).mtimeMs).toBe(completedMetadata.mtimeMs);
    } finally {
      await reader.settle();
    }
  });
});
