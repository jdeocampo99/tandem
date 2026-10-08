import { expect, test } from "bun:test";
import { createReviewReceipts } from "../../src/pr-review/receipts.ts";
import { type PrReviewRound, type PrReviewState, reviewState } from "../../src/pr-review/state.ts";
import { task } from "../session/fixtures.ts";
import { fakeGh, ok } from "./fake-gh.ts";

const at = "2030-01-02T03:04:05Z";
const prUrl = "https://github.com/acme/api/pull/7";

function receiptFixture(effect: "review" | "reply", failure: "claim" | "settle") {
  const round: PrReviewRound = {
    generation: 0,
    head: "abc123",
    from: "base000",
    notes: [],
    review: {
      head: "abc123",
      intent: "Check this change",
      summaryComment: "Saved choices",
      comments: [],
      tour: [],
      concerns: [],
      priorComments:
        effect === "reply" ? [{ commentId: 42, status: "addressed", reply: "Thanks." }] : [],
    },
    ...(effect === "reply"
      ? {
          posted: {
            url: `${prUrl}#pullrequestreview-1`,
            verdict: "comment",
            postedAt: at,
            priorRepliesClaimed: true,
          },
        }
      : {}),
  };
  const state: PrReviewState = {
    ref: { repo: "acme/api", number: 7 },
    url: prUrl,
    title: "A change",
    author: "sam",
    baseRef: "main",
    checkout: "/tmp",
    remote: "origin",
    lens: { kind: "full" },
    mode: "review",
    rounds: [round],
  };
  let record = task({ kind: "pr-review", stage: "completed", prReview: state });
  let fail = true;
  let landed: Record<string, unknown> | undefined;
  const endpoint = `repos/acme/api/pulls/7/${effect === "review" ? "reviews" : "comments"}`;
  const gh = fakeGh({
    [`gh api --paginate --slurp ${endpoint}`]: () => ok([landed === undefined ? [] : [landed]]),
    "gh pr view 7 --repo acme/api --json headRefOid": ok("abc123"),
    [`gh api --method POST ${endpoint}`]: (request) => {
      const saved = reviewState(record).rounds[0];
      if (effect === "review")
        expect(saved?.pendingPost).toEqual({ verdict: "comment", attemptedAt: at });
      else
        expect(saved?.replyPosts).toEqual([
          { index: 0, kind: "pending", attemptedAt: at, attemptRevision: record.revision },
        ]);
      const payload: Record<string, unknown> = JSON.parse(request.stdin ?? "{}");
      landed = {
        body: payload.body,
        html_url: `${prUrl}#${effect === "review" ? "pullrequestreview-2" : "discussion_r43"}`,
        in_reply_to_id: payload.in_reply_to,
      };
      return ok(landed);
    },
  });
  const receipts = createReviewReceipts({
    run: gh.run,
    clock: () => at,
    getTask: async () => record,
    updatePrReview: async (expected, next) => {
      if (fail && failure === "claim") {
        fail = false;
        throw new Error("claim write failed");
      }
      if (record.revision !== expected.revision) throw new Error("stale revision");
      record = { ...record, revision: record.revision + 1, prReview: next };
      return record;
    },
    mutatePrReview: async (_id, update) => {
      if (fail && failure === "settle") {
        fail = false;
        throw new Error("receipt write failed");
      }
      const next = update(record);
      const changed = next !== record.prReview;
      record = { ...record, revision: record.revision + 1, prReview: next };
      return { task: record, changed };
    },
  });
  function context() {
    const live = reviewState(record);
    const current = live.rounds[0];
    if (current === undefined) throw new Error("Missing fixture round");
    return { task: record, state: live, round: current };
  }
  return { receipts, context, posts: () => gh.calls.filter((call) => call.argv.includes("POST")) };
}

for (const effect of ["review", "reply"] as const) {
  test(`receipt publish prevents the ${effect} POST when its exclusive claim cannot be saved`, async () => {
    const fixture = receiptFixture(effect, "claim");
    await expect(fixture.receipts.publish(fixture.context(), "comment")).rejects.toThrow(
      "claim write failed",
    );
    expect(fixture.posts()).toHaveLength(0);
    expect(fixture.context().round.pendingPost).toBeUndefined();
    expect(fixture.context().round.replyPosts).toBeUndefined();
  });

  test(`receipt publish reconciles the ${effect} marker after settlement fails without another POST`, async () => {
    const fixture = receiptFixture(effect, "settle");
    await expect(fixture.receipts.publish(fixture.context(), "comment")).rejects.toThrow(
      "receipt write failed",
    );
    expect(fixture.posts()).toHaveLength(1);
    if (effect === "review") expect(fixture.context().round.pendingPost).toBeDefined();
    else expect(fixture.context().round.replyPosts?.[0]?.kind).toBe("pending");
    expect(await fixture.receipts.publish(fixture.context(), "approve")).toMatchObject({
      kind: "posted",
    });
    expect(fixture.posts()).toHaveLength(1);
    expect(fixture.context().round.pendingPost).toBeUndefined();
    expect(fixture.context().round.posted?.verdict).toBe("comment");
    if (effect === "reply")
      expect(fixture.context().round.replyPosts?.[0]).toMatchObject({
        kind: "posted",
        url: `${prUrl}#discussion_r43`,
      });
  });
}
