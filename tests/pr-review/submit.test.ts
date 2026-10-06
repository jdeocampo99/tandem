import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRequest, TaskRecord } from "../../src/contracts.ts";
import type { ReviewSubmission } from "../../src/pr-review/page.ts";
import { createPrReviewWorkflow } from "../../src/pr-review/service.ts";
import { type PrReviewState, prReviewRunDiffPath } from "../../src/pr-review/state.ts";
import { task } from "../session/fixtures.ts";
import { fakeGh, ok } from "./fake-gh.ts";

const REVIEWS = "gh api --paginate --slurp repos/acme/api/pulls/7/reviews";
const HEAD = "gh pr view 7 --repo acme/api --json headRefOid";
const POST = "gh api --method POST repos/acme/api/pulls/7/reviews";
const URL = "https://github.com/acme/api/pull/7#pullrequestreview-1";

const PATCH = `diff --git a/src/upload.ts b/src/upload.ts
--- a/src/upload.ts
+++ b/src/upload.ts
@@ -1,1 +1,3 @@
-send(file);
+retry(send, file);
+log(file);
+close(file);
`;

const state: PrReviewState = {
  ref: { repo: "acme/api", number: 7 },
  url: "https://github.com/acme/api/pull/7",
  title: "Retry uploads",
  author: "sam",
  baseRef: "main",
  checkout: "/tmp",
  remote: "origin",
  lens: { kind: "full" },
  mode: "review",
  rounds: [
    {
      generation: 0,
      head: "abc123",
      from: "base000",
      notes: [],
      review: {
        head: "abc123",
        intent: "Retries uploads.",
        tour: [],
        concerns: [],
        comments: [
          { id: "c1", file: "src/upload.ts", line: 1, body: "Cap it?", severity: "blocking" },
          { id: "c2", file: "src/upload.ts", line: 2, body: "nit: level", severity: "nit" },
          { id: "c3", file: "src/upload.ts", line: 3, body: "Why close?", severity: "question" },
        ],
        summaryComment: "Close.",
        priorComments: [],
      },
    },
  ],
};

const submission: ReviewSubmission = {
  tandemPrReview: 1,
  verdict: "request-changes",
  summary: "One thing before this merges.",
  drafts: [
    { id: "c1", decision: "post", body: "Could we cap retries at 3?" },
    { id: "c2", decision: "drop" },
    { id: "c3", decision: "undecided" },
  ],
  yours: [{ file: "src/upload.ts", line: 3, body: "Is close needed here?" }],
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tandem-submit-"));
  const diff = prReviewRunDiffPath(home, "task-1", 0);
  await mkdir(dirname(diff), { recursive: true });
  await writeFile(diff, PATCH);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function workflow(head: string, overrides: Partial<TaskRecord> = {}) {
  const gh = fakeGh({
    [REVIEWS]: ok([[]]),
    [HEAD]: ok(`${head}\n`),
    [POST]: ok({ html_url: URL }),
  });
  let record: TaskRecord = task({
    kind: "pr-review",
    stage: "completed",
    prReview: state,
    ...overrides,
  });
  const flow = createPrReviewWorkflow({
    home,
    run: gh.run,
    clock: () => "2026-10-05T00:00:00.000Z",
    projectRoots: async () => [],
    listTasks: async () => [record],
    getTask: async () => record,
    createTask: async () => record,
    updatePrReview: async (_task, next) => {
      record = { ...record, prReview: next };
      return record;
    },
    runAgain: async () => undefined,
    settle: async () => undefined,
  });
  return { flow, calls: gh.calls, current: () => record };
}

function posted(calls: readonly CommandRequest[]): readonly Record<string, unknown>[] {
  return calls
    .filter((call) => call.argv.join(" ").startsWith(POST))
    .map((call) => JSON.parse(call.stdin ?? "{}"));
}

test("a page submission posts the chosen drafts and the user's own, with no approval step", async () => {
  const { flow, calls, current } = workflow("abc123");
  expect(await flow.submit("task-1", submission)).toMatchObject({ posted: true, url: URL });
  const [sent] = posted(calls);
  expect(sent).toMatchObject({
    commit_id: "abc123",
    event: "REQUEST_CHANGES",
    body: expect.stringContaining("One thing before this merges."),
  });
  expect(sent?.comments).toEqual([
    { path: "src/upload.ts", line: 1, side: "RIGHT", body: "Could we cap retries at 3?" },
    { path: "src/upload.ts", line: 3, side: "RIGHT", body: "Is close needed here?" },
  ]);
  const round = current().prReview?.rounds[0];
  expect(round?.posted).toMatchObject({ url: URL, verdict: "request-changes" });
  expect(round?.review.comments.map((comment) => comment.id)).toEqual(["c1", "u1"]);
});

test("a second submission after the review is posted is refused and posts nothing", async () => {
  const { flow, calls } = workflow("abc123");
  await flow.submit("task-1", submission);
  await expect(flow.submit("task-1", submission)).rejects.toThrow(
    `This review was already posted at ${URL}.`,
  );
  expect(posted(calls)).toHaveLength(1);
});

test("a submission is refused when the PR moved, and the drafts stay as they were", async () => {
  const { flow, calls, current } = workflow("def456");
  expect(await flow.submit("task-1", submission)).toMatchObject({
    posted: false,
    message: expect.stringContaining("The PR moved to def456"),
  });
  expect(posted(calls)).toHaveLength(0);
  expect(current().prReview).toEqual(state);
});

test("a submission naming a draft the review lacks posts nothing", async () => {
  const { flow, calls } = workflow("abc123");
  await expect(
    flow.submit("task-1", { ...submission, drafts: [{ id: "c9", decision: "post" }] }),
  ).rejects.toThrow("The page sent draft ids this review does not have: c9");
  expect(posted(calls)).toHaveLength(0);
});

for (const changed of ["head", "round-generation", "task-generation"]) {
  test(`a native submission refuses a changed ${changed} even when the new round reuses draft ids`, async () => {
    const previous = state.rounds[0];
    if (previous === undefined) throw new Error("Missing fixture round");
    const head = changed === "head" ? "def456" : previous.head;
    const generation = changed === "head" ? 0 : 1;
    const nextState = {
      ...state,
      rounds: [
        {
          ...previous,
          head,
          generation: changed === "round-generation" ? generation : 0,
          review: { ...previous.review, head },
        },
      ],
    };
    const { flow, calls, current } = workflow(head, { generation, prReview: nextState });
    await expect(
      flow.submit("task-1", submission, { head: previous.head, generation: 0 }),
    ).rejects.toThrow("The displayed PR review is stale; reopen the pane before submitting.");
    expect(calls).toEqual([]);
    expect(current().prReview).toEqual(nextState);
  });
}

test("a native submission matching the displayed round uses the existing pinned posting path", async () => {
  const { flow, calls } = workflow("abc123");
  expect(await flow.submit("task-1", submission, { head: "abc123", generation: 0 })).toMatchObject({
    posted: true,
    url: URL,
  });
  expect(posted(calls)).toHaveLength(1);
  expect(posted(calls)[0]).toMatchObject({ commit_id: "abc123" });
});

test("a finished question follow-up can still submit the same unchanged review round", async () => {
  const { flow, calls } = workflow("abc123", {
    generation: 1,
    prReview: { ...state, mode: "question" },
  });
  expect(await flow.submit("task-1", submission, { head: "abc123", generation: 0 })).toMatchObject({
    posted: true,
  });
  expect(posted(calls)[0]).toMatchObject({ commit_id: "abc123" });
});
