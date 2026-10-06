import { expect, test } from "bun:test";
import { parseReviewSubmission } from "../../src/pr-review/page.ts";
import { postThreadReply } from "../../src/pr-review/post.ts";
import { validateThreadReplies } from "../../src/pr-review/replies.ts";
import { parsePrReview } from "../../src/pr-review/review.ts";
import { failed, fakeGh, ok } from "./fake-gh.ts";

const reply = {
  threadId: "thread-2",
  commentId: "node-22",
  replyTo: 22,
  body: "Thanks, why this guard?",
};
const input = {
  ref: { repo: "acme/api", number: 7 },
  cwd: "/tmp",
  head: "abc123",
  reply,
  marker: "<!-- tandem-reply:t:0:0 -->",
};
const COMMENTS = "gh api --paginate --slurp repos/acme/api/pulls/7/comments";
const HEAD = "gh pr view 7 --repo acme/api --json headRefOid";
const POST = "gh api --method POST repos/acme/api/pulls/7/comments";
const receipt = {
  in_reply_to_id: 22,
  html_url: "https://github.com/acme/api/pull/7#discussion_r23",
  body: input.marker,
};

test("submission preserves thread and root identities separately from root comments and in durable review JSON", () => {
  const submission = {
    tandemPrReview: 1 as const,
    verdict: "comment" as const,
    summary: "",
    drafts: [],
    yours: [],
    replies: [reply],
  };
  expect(parseReviewSubmission(JSON.stringify(submission))).toEqual({ ok: true, submission });
  expect(
    parsePrReview({
      head: "abc123",
      intent: "Port",
      tour: [],
      concerns: [],
      comments: [],
      replies: [reply],
    }).replies,
  ).toEqual([reply]);
  expect(
    parseReviewSubmission(JSON.stringify({ ...submission, replies: [{ ...reply, replyTo: "22" }] }))
      .ok,
  ).toBe(false);
});

test("reply validation names the selected root, including outdated threads without a line", () => {
  const thread = {
    id: reply.threadId,
    file: "removed.ts",
    side: "LEFT" as const,
    resolved: false,
    outdated: true,
    comments: [
      {
        id: reply.commentId,
        databaseId: 22,
        author: "sam",
        at: "2030-01-01",
        body: "Earlier guard",
      },
    ],
  };
  expect(() => validateThreadReplies([reply], [thread])).not.toThrow();
  for (const wrong of [
    { ...reply, threadId: "other" },
    { ...reply, commentId: "another" },
    { ...reply, replyTo: 21 },
  ])
    expect(() => validateThreadReplies([wrong], [thread])).toThrow("selected PR thread changed");
});

test("a reply posts in_reply_to under the pinned head, never as a root comment", async () => {
  const { run, calls } = fakeGh({
    [COMMENTS]: ok([[]]),
    [HEAD]: ok("abc123"),
    [POST]: ok(receipt),
  });
  expect(await postThreadReply(run, input)).toMatchObject({ kind: "posted" });
  const sent = calls.find((c) => c.argv.join(" ").startsWith(POST));
  expect(JSON.parse(sent?.stdin ?? "{}")).toEqual({
    commit_id: "abc123",
    in_reply_to: 22,
    body: `${reply.body}\n\n${input.marker}`,
  });
});

for (const mode of ["moved", "unreadable-comments", "unreadable-head"]) {
  test(`reply refuses ${mode} before any POST`, async () => {
    const { run, calls } = fakeGh({
      [COMMENTS]: mode === "unreadable-comments" ? failed("offline") : ok([[]]),
      [HEAD]: mode === "unreadable-head" ? failed("offline") : ok("new-head"),
    });
    expect((await postThreadReply(run, input)).kind).toBe(mode === "moved" ? "moved" : "failed");
    expect(calls.filter((c) => c.argv.includes("POST"))).toHaveLength(0);
  });
}

test("a lost reply receipt reconciles its marker and cannot double post", async () => {
  let landed = false;
  const { run, calls } = fakeGh({
    [COMMENTS]: () => ok([landed ? [receipt] : []]),
    [HEAD]: ok("abc123"),
    [POST]: () => {
      landed = true;
      return failed("lost response");
    },
  });
  expect((await postThreadReply(run, input)).kind).toBe("posted");
  expect((await postThreadReply(run, input)).kind).toBe("already-posted");
  expect(calls.filter((c) => c.argv.includes("POST"))).toHaveLength(1);
});

test("an uncertain reply returns uncertainty without retrying", async () => {
  const { run, calls } = fakeGh({
    [COMMENTS]: ok([[]]),
    [HEAD]: ok("abc123"),
    [POST]: failed("lost response"),
  });
  expect((await postThreadReply(run, input)).kind).toBe("uncertain");
  expect(calls.filter((c) => c.argv.includes("POST"))).toHaveLength(1);
});
