import { expect, test } from "bun:test";
import type { ReviewSubmission } from "../../src/pr-review/page.ts";
import type { PostPrReviewResult, ReviewPageEvent } from "../../src/pr-review/service.ts";
import type { SessionEffect } from "../../src/session/events.ts";
import { ReviewPageListeners } from "../../src/session/review-page.ts";

const submission: ReviewSubmission = {
  tandemPrReview: 1,
  verdict: "approve",
  summary: "Thanks!",
  drafts: [],
  yours: [],
};

/** Runs one listener over scripted page events until the page closes. */
async function listenTo(
  events: readonly ReviewPageEvent[],
  submit: (submission: ReviewSubmission) => Promise<PostPrReviewResult> = async () => ({
    taskId: "task-1",
    posted: true,
    url: "https://github.com/acme/api/pull/7#pullrequestreview-1",
    message: "Posted 0 comments",
  }),
) {
  const effects: SessionEffect[] = [];
  const replies: (string | undefined)[] = [];
  const submitted: ReviewSubmission[] = [];
  const queue = [...events];
  const { promise: closed, resolve: close } = Promise.withResolvers<void>();
  let awaits = 0;
  let listeners!: ReviewPageListeners;
  listeners = new ReviewPageListeners({
    host: {
      perform: async (effect) => {
        effects.push(effect);
        if (effect.type === "promptAsUser") {
          listeners.agentEnd({
            willContinue: false,
            messages: () => [
              { role: "user", content: effect.text },
              { role: "assistant", content: "Because send can throw." },
            ],
          });
        }
      },
    },
    service: () => ({
      reviewPagesOpen: () => ["task-1"],
      awaitReviewPage: async (_taskId, _signal, reply) => {
        awaits += 1;
        replies.push(reply);
        const next = queue.shift() ?? { kind: "closed" };
        if (next.kind === "closed") queueMicrotask(close);
        return next;
      },
      reviewSubmit: async (_taskId, sent) => {
        submitted.push(sent);
        return submit(sent);
      },
    }),
  });
  listeners.afterAction();
  // A second action while the page is open does not start a second listener.
  listeners.afterAction();
  await closed;
  return { effects, replies, submitted, awaits: () => awaits };
}

function asides(effects: readonly SessionEffect[]): readonly string[] {
  return effects.flatMap((effect) =>
    effect.type === "deliver" && effect.timing === "aside" ? [effect.text] : [],
  );
}

test("a Submit posts in code, tells the chat as an aside, and replies in the page", async () => {
  const run = await listenTo([{ kind: "submission", submission, ended: false }]);
  expect(run.submitted).toEqual([submission]);
  const said = "Posted your review: https://github.com/acme/api/pull/7#pullrequestreview-1";
  expect(asides(run.effects)).toEqual([said]);
  expect(run.replies).toEqual([undefined, said]);
  expect(run.effects.some((effect) => effect.type === "promptAsUser")).toBe(false);
});

test("a refused submission reaches the chat and the page, and nothing claims it posted", async () => {
  const run = await listenTo([{ kind: "submission", submission, ended: false }], async () => ({
    taskId: "task-1",
    posted: false,
    message: "The PR moved to def456 since this review.",
  }));
  const said = "Your review was not posted. The PR moved to def456 since this review.";
  expect(asides(run.effects)).toEqual([said]);
  expect(run.replies).toEqual([undefined, said]);
});

test("an unreadable submission sends its problems back and posts nothing", async () => {
  const run = await listenTo([{ kind: "invalid", problems: ["verdict is missing"], ended: false }]);
  expect(run.submitted).toEqual([]);
  expect(run.replies[1]).toContain("- verdict is missing");
  expect(asides(run.effects)[0]).toContain("nothing was posted");
});

test("a plain page comment goes to the coordinator, and its answer goes back to the page", async () => {
  const run = await listenTo([{ kind: "comment", text: "Why is c1 blocking?", ended: false }]);
  expect(run.effects).toContainEqual({
    type: "promptAsUser",
    text: "From the open review page:\nWhy is c1 blocking?",
    deliverAs: "aside",
  });
  expect(run.replies).toEqual([undefined, "Because send can throw."]);
  expect(run.submitted).toEqual([]);
  expect(run.awaits()).toBe(2);
});
