import { expect, test } from "bun:test";
import type { CommandRequest } from "../../src/contracts.ts";
import { postReview, reviewMarker, reviewRequestBody } from "../../src/pr-review/post.ts";
import type { PrReview } from "../../src/pr-review/review.ts";
import { failed, fakeGh, ok } from "./fake-gh.ts";

const REF = { repo: "acme/api", number: 7 };
const REVIEWS = "gh api --paginate --slurp repos/acme/api/pulls/7/reviews";
const HEAD = "gh pr view 7 --repo acme/api --json headRefOid";
const POST = "gh api --method POST repos/acme/api/pulls/7/reviews";

const review: PrReview = {
  head: "abc123",
  intent: "Retries uploads.",
  tour: [],
  concerns: [],
  comments: [
    {
      id: "c1",
      file: "src/upload.ts",
      line: 12,
      body: "Could we use a `finally`?",
      severity: "blocking",
    },
  ],
  summaryComment: "Looks close, one thing.",
  priorComments: [],
};
const marker = reviewMarker("task-1", 0);
const input = { ref: REF, review, verdict: "request-changes" as const, marker, cwd: "/tmp" };

function posts(calls: readonly CommandRequest[]): number {
  return calls.filter((call) => call.argv.join(" ").startsWith(POST)).length;
}

test("the review is pinned to the reviewed commit and carries a hidden marker", () => {
  expect(reviewRequestBody(input)).toEqual({
    commit_id: "abc123",
    event: "REQUEST_CHANGES",
    body: `Looks close, one thing.\n\n${marker}`,
    comments: [
      { path: "src/upload.ts", line: 12, side: "RIGHT", body: "Could we use a `finally`?" },
    ],
  });
});

test("posts once when the PR is still at the reviewed commit", async () => {
  const { run, calls } = fakeGh({
    [REVIEWS]: ok([[]]),
    [HEAD]: ok("abc123\n"),
    [POST]: ok({ html_url: "https://github.com/acme/api/pull/7#pullrequestreview-1" }),
  });
  expect(await postReview(run, input)).toEqual({
    kind: "posted",
    url: "https://github.com/acme/api/pull/7#pullrequestreview-1",
  });
  expect(posts(calls)).toBe(1);
  const sent = calls.find((call) => call.argv.join(" ").startsWith(POST));
  expect(JSON.parse(sent?.stdin ?? "{}").commit_id).toBe("abc123");
});

test("refuses to post when the author pushed since the review", async () => {
  const { run, calls } = fakeGh({ [REVIEWS]: ok([[]]), [HEAD]: ok("def456\n") });
  expect(await postReview(run, input)).toEqual({ kind: "moved", head: "def456" });
  expect(posts(calls)).toBe(0);
});

test("a retry after an uncertain failure finds the landed review instead of posting twice", async () => {
  let landed = false;
  const { run, calls } = fakeGh({
    [REVIEWS]: () =>
      ok([landed ? [{ body: `x\n\n${marker}`, html_url: "https://github.com/r/1" }] : []]),
    [HEAD]: ok("abc123\n"),
    [POST]: () => {
      landed = true;
      return failed("connection reset");
    },
  });
  expect(await postReview(run, input)).toEqual({ kind: "posted", url: "https://github.com/r/1" });
  expect(await postReview(run, input)).toEqual({
    kind: "already-posted",
    url: "https://github.com/r/1",
  });
  expect(posts(calls)).toBe(1);
});

test("a failure that did not land reports GitHub's reason", async () => {
  const { run } = fakeGh({
    [REVIEWS]: ok([[]]),
    [HEAD]: ok("abc123\n"),
    [POST]: failed("Unprocessable Entity: line must be part of the diff\n"),
  });
  expect(await postReview(run, input)).toEqual({
    kind: "failed",
    message: "Unprocessable Entity: line must be part of the diff",
  });
});
