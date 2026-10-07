import { expect, test } from "bun:test";
import type { TaskRecord } from "../../src/contracts.ts";
import type { PrThread } from "../../src/pr-review/native-view.ts";
import {
  fixRequestStalled,
  type OwnPullRequest,
  prFixRequest,
  taskForPrNumber,
} from "../../src/tasks/pull-request.ts";
import { task } from "../session/fixtures.ts";

const HEAD = "a".repeat(40);
const pullRequest: OwnPullRequest = {
  repository: "owner/repo",
  number: 42,
  state: "draft",
  head: HEAD,
  base: "main",
};
const owned = task({ id: "task-pr", stage: "implementing", pullRequest });

const thread: PrThread = {
  id: "thread-second",
  file: "removed.ts",
  side: "RIGHT",
  resolved: false,
  outdated: true,
  comments: [
    { id: "node-second", databaseId: 22, author: "sam", at: "now", body: "Earlier guard" },
  ],
};
const reply = {
  threadId: thread.id,
  commentId: "node-second",
  replyTo: 22,
  body: "Keep this guard",
};

const noThreads = async (): Promise<never> => {
  throw new Error("No threads should be read");
};

test("comments and a note become one worker fix request with whitespace collapsed", async () => {
  expect(
    await prFixRequest(
      owned,
      {
        text: "Please fix these",
        comments: [
          { file: "src/view.ts", line: 12, text: "Handle an empty list\nbefore rendering" },
        ],
      },
      noThreads,
    ),
  ).toBe("PR fix request: src/view.ts:12: Handle an empty list before rendering Please fix these");
});

test("a thread reply names its thread, root comment and anchor, read at the displayed head", async () => {
  const reads: [OwnPullRequest, string][] = [];
  const readThreads = async (pr: OwnPullRequest, head: string) => {
    reads.push([pr, head]);
    return [thread, { ...thread, id: "anchored", file: "kept.ts", line: 7 }];
  };
  expect(await prFixRequest(owned, { reviewHead: HEAD, replies: [reply] }, readThreads)).toBe(
    "PR fix request: Reply to owner/repo#42 thread thread-second, root comment node-second (GitHub 22), removed.ts (outside current diff): Keep this guard",
  );
  expect(reads).toEqual([[pullRequest, HEAD]]);
  expect(
    await prFixRequest(
      owned,
      { reviewHead: HEAD, replies: [{ ...reply, threadId: "anchored" }] },
      async () => [{ ...thread, id: "anchored", file: "kept.ts", line: 7 }],
    ),
  ).toContain("kept.ts:7: Keep this guard");
});

test("a reply to a moved head or a changed thread is refused before any direction", async () => {
  await expect(
    prFixRequest(owned, { reviewHead: "b".repeat(40), replies: [reply] }, noThreads),
  ).rejects.toThrow("The PR changed; reopen before replying");
  await expect(
    prFixRequest(
      owned,
      { reviewHead: HEAD, replies: [{ ...reply, commentId: "wrong" }] },
      async () => [thread],
    ),
  ).rejects.toThrow("The selected PR thread changed or is unavailable");
  await expect(
    prFixRequest(owned, { reviewHead: HEAD, replies: [{}] }, noThreads),
  ).rejects.toThrow();
});

test("feedback needs text, and a finished worker takes none", async () => {
  await expect(prFixRequest(owned, { text: "   ", comments: [] }, noThreads)).rejects.toThrow(
    "PR feedback must be non-empty text",
  );
  await expect(
    prFixRequest({ ...owned, stage: "completed" }, { text: "Fix this" }, noThreads),
  ).rejects.toThrow("This task's worker has finished");
});

test("only an implementation task's own draft or open PR takes feedback", async () => {
  const refused: TaskRecord[] = [
    task({ stage: "implementing" }),
    { ...owned, kind: "scout" },
    { ...owned, pullRequest: { ...pullRequest, state: "closed" } },
    { ...owned, pullRequest: { ...pullRequest, state: "merged" } },
  ];
  for (const candidate of refused)
    await expect(prFixRequest(candidate, { text: "Fix this" }, noThreads)).rejects.toThrow(
      "This action requires an implementation task with an open Tandem pull request",
    );
  const open = { ...owned, pullRequest: { ...pullRequest, state: "open" as const } };
  expect(await prFixRequest(open, { text: "Fix this" }, noThreads)).toBe(
    "PR fix request: Fix this",
  );
});

test("a fix request stalls when the task blocks or a ready task does not resume implementing", () => {
  expect(fixRequestStalled("implementing", "implementing")).toBe(false);
  expect(fixRequestStalled("ready", "implementing")).toBe(false);
  expect(fixRequestStalled("awaiting-fixes", "awaiting-fixes")).toBe(false);
  expect(fixRequestStalled("implementing", "blocked")).toBe(true);
  expect(fixRequestStalled("ready", "ready")).toBe(true);
});

test("a PR number resolves the project's one task with that own or reviewed PR", async () => {
  const reviewing = task({
    id: "task-review",
    kind: "pr-review",
    prReview: {
      ref: { repo: "acme/app", number: 7 },
      url: "https://github.com/acme/app/pull/7",
      title: "Retry",
      author: "author",
      baseRef: "main",
      checkout: "/checkout",
      remote: "origin",
      lens: { kind: "full" },
      mode: "review",
      rounds: [],
    },
  });
  const elsewhere = { ...owned, id: "task-elsewhere", repoPath: "/other", stage: "ready" as const };
  const tasks = [elsewhere, owned, reviewing];
  expect((await taskForPrNumber(tasks, "/repo", 42))?.id).toBe("task-pr");
  expect((await taskForPrNumber(tasks, "/repo", 7))?.id).toBe("task-review");
  expect(await taskForPrNumber(tasks, "/repo", 8)).toBeUndefined();
  await expect(
    taskForPrNumber([...tasks, { ...owned, id: "task-twin" }], "/repo", 42),
  ).rejects.toThrow("More than one task has pull request #42; open it by task id");
});
