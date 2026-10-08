import type { TaskRecord } from "../contracts.ts";
import { readNativeThreads } from "../pr-watch/native-cache.ts";
import {
  confirmedReviewUrl,
  findPostedReply,
  findPostedReview,
  type PostedReviewLookup,
  type PostReceiptOutcome,
  type PostReviewOutcome,
  postReview,
  postThreadReply,
  type ReviewVerdict,
  reviewMarker,
} from "./post.ts";
import {
  type RoundReply,
  replyReceipt,
  roundReplies,
  sentWithoutClaim,
  validateReplyRecovery,
  validateThreadReplies,
  withReplyReceipt,
} from "./replies.ts";
import type { PrReviewDependencies, ReceiptResult, ReviewPostRecovery } from "./service.ts";
import {
  findRound,
  type PrReviewRound,
  type PrReviewState,
  postedRound,
  type ReplyPost,
  replaceLatestRound,
  replaceRound,
  reviewState,
  samePr,
} from "./state.ts";

type ReviewedRound = Readonly<{ task: TaskRecord; state: PrReviewState; round: PrReviewRound }>;
type PostAttempt = Readonly<{
  post: (claim: () => Promise<void>) => Promise<PostReviewOutcome>;
  lookup: () => Promise<PostedReviewLookup>;
  claim: () => PrReviewState;
}>;
type ReceiptDependencies = Pick<
  PrReviewDependencies,
  "run" | "clock" | "getTask" | "updatePrReview" | "mutatePrReview"
>;

export function createReviewReceipts(deps: ReceiptDependencies) {
  async function publish(
    context: ReviewedRound,
    verdict: ReviewVerdict,
    recovering = false,
  ): Promise<ReceiptResult> {
    const { task, state, round } = context;
    if (round.posted !== undefined) {
      for (const index of roundReplies(round.review).keys())
        await attemptReply(task.id, round, index);
      return { kind: "posted", round, label: "Already posted" };
    }
    if (round.pendingPost === undefined && round.review.replies?.length) {
      validateThreadReplies(
        round.review.replies,
        await readNativeThreads(deps.run, state.ref, state.checkout, round.head),
      );
    }
    const input = {
      ref: state.ref,
      cwd: state.checkout,
      review: round.review,
      verdict: round.pendingPost?.verdict ?? verdict,
      marker: reviewMarker(task.id, round.generation),
    };
    const outcome = await transact(
      task,
      {
        post: (claim) => postReview(deps.run, input, claim),
        lookup: () => findPostedReview(deps.run, input),
        claim: () =>
          replaceLatestRound(state, {
            ...round,
            pendingPost: { verdict, attemptedAt: deps.clock() },
          }),
      },
      round.pendingPost === undefined,
    );
    if (outcome.kind !== "posted") return { kind: "unconfirmed", outcome, recovering };
    const confirmed = postedRound(await settleReview(context, input.verdict, outcome.url), round);
    // The review receipt is durable before any reply can claim its effect.
    for (const index of roundReplies(confirmed.round.review).keys())
      await attemptReply(task.id, confirmed.round, index);
    const count = confirmed.round.review.comments.length;
    return {
      kind: "posted",
      round: confirmed.round,
      label: `Posted ${count} comment${count === 1 ? "" : "s"}`,
    };
  }

  async function recover(
    context: ReviewedRound,
    verdict: ReviewVerdict,
    recovery: ReviewPostRecovery,
  ): Promise<ReceiptResult> {
    const { task, state, round } = context;
    if (!Number.isSafeInteger(recovery.taskRevision) || task.revision !== recovery.taskRevision)
      throw new Error(
        "The review changed since you checked it; inspect it again before confirming recovery.",
      );
    if (recovery.kind === "post-reply-again" || recovery.kind === "mark-reply-posted") {
      validateReplyRecovery(round, verdict, recovery.replyIndex);
      if (recovery.kind === "post-reply-again") {
        await attemptReply(task.id, round, recovery.replyIndex, {
          recoveryRevision: recovery.taskRevision,
        });
      } else {
        const url = confirmedReviewUrl(recovery.url, state, true);
        await deps.updatePrReview(
          task,
          replaceRound(
            state,
            round,
            withReplyReceipt(round, {
              index: recovery.replyIndex,
              kind: "posted",
              url,
              postedAt: deps.clock(),
              confirmedByUser: true,
            }),
          ),
        );
      }
      return { kind: "posted", round, label: "Saved review posted" };
    }
    if (round.pendingPost === undefined)
      throw new Error("This review has no uncertain post to recover.");
    if (verdict !== round.pendingPost.verdict)
      throw new Error("Recovery must keep the saved review verdict and choices.");
    // Keep the saved attempt durable until a confirmed retry passes preflight and claims again.
    const { pendingPost: _pendingPost, ...confirmed } = round;
    if (recovery.kind === "post-again")
      return publish({ ...context, round: confirmed }, verdict, true);
    const url = confirmedReviewUrl(recovery.url, state);
    await deps.updatePrReview(
      task,
      replaceLatestRound(state, {
        ...confirmed,
        posted: {
          url,
          verdict,
          postedAt: deps.clock(),
          confirmedByUser: true,
          priorRepliesClaimed: true,
        },
      }),
    );
    return {
      kind: "posted",
      round,
      label: "Marked your saved review as posted using the link you confirmed",
    };
  }

  async function transact(
    task: TaskRecord,
    attempt: PostAttempt,
    send: boolean,
  ): Promise<PostReceiptOutcome> {
    const outcome = send
      ? await attempt.post(async () => {
          // The revision check is the exclusive claim. A losing caller never reaches POST.
          await deps.updatePrReview(task, attempt.claim());
        })
      : await attempt.lookup();
    return "url" in outcome ? { kind: "posted", url: outcome.url } : outcome;
  }

  async function settleReview(context: ReviewedRound, verdict: ReviewVerdict, url: string) {
    const postedAt = deps.clock();
    const settled = await deps.mutatePrReview(context.task.id, (current) => {
      const live = reviewState(current);
      const saved = findRound(live, context.round);
      if (!samePr(live, context.state) || saved === undefined)
        throw new Error(`The posted review round changed; check the PR: ${url}`);
      if (saved.posted !== undefined) return live;
      const { pendingPost, ...confirmed } = saved;
      return replaceRound(live, saved, {
        ...confirmed,
        posted: {
          url,
          verdict: pendingPost?.verdict ?? verdict,
          postedAt,
          priorRepliesClaimed: true,
        },
      });
    });
    return settled.task;
  }

  async function settleReply(
    context: ReviewedRound,
    target: Readonly<{ index: number; reply: RoundReply; previous: ReplyPost | undefined }>,
    next: ReplyPost,
  ) {
    await deps.mutatePrReview(context.task.id, (current) => {
      const live = postedRound(
        current,
        context.round,
        "The posted review round is unavailable; inspect the task again.",
      );
      if (!samePr(live.state, context.state))
        throw new Error("The reply's PR changed; inspect it again.");
      const saved = live.round.replyPosts?.find((post) => post.index === target.index);
      if (saved?.kind === "posted") return live.state;
      if (JSON.stringify(saved) !== JSON.stringify(target.previous))
        throw new Error("The saved reply attempt changed; inspect it again.");
      if (
        JSON.stringify(roundReplies(live.round.review)[target.index]) !==
        JSON.stringify(target.reply)
      )
        throw new Error("The saved reply changed; inspect it again.");
      return replaceRound(live.state, live.round, withReplyReceipt(live.round, next));
    });
  }

  async function attemptReply(
    taskId: string,
    binding: PrReviewRound,
    index: number,
    options: { recoveryRevision?: number; reconcile?: true } = {},
  ) {
    const { recoveryRevision } = options;
    const task = await deps.getTask(taskId);
    if (recoveryRevision !== undefined && task.revision !== recoveryRevision)
      throw new Error(
        "The reply changed since you checked it; inspect it again before confirming recovery.",
      );
    const context = postedRound(
      task,
      binding,
      "The posted review round is unavailable; inspect the task again.",
    );
    const reply = roundReplies(context.round.review)[index];
    if (reply === undefined) throw new Error("This round has no saved reply at that index.");
    if (sentWithoutClaim(context.round, reply)) return;
    const previous = context.round.replyPosts?.find((post) => post.index === index);
    if (previous?.kind === "posted") return;
    if (previous !== undefined && recoveryRevision === undefined && !options.reconcile) {
      await attemptReply(taskId, binding, index, { reconcile: true });
      return;
    }
    const send = !options.reconcile;
    if (send && recoveryRevision !== undefined && reply.thread !== undefined) {
      validateThreadReplies(
        [reply.thread],
        await readNativeThreads(
          deps.run,
          context.state.ref,
          context.state.checkout,
          context.round.head,
        ),
      );
    }
    const input = {
      ref: context.state.ref,
      cwd: context.state.checkout,
      head: context.round.head,
      reply,
      marker: `<!-- tandem-reply:${taskId}:${context.round.generation}:${index} -->`,
    };
    let claimed: ReplyPost | undefined;
    const outcome = await transact(
      task,
      {
        post: (claim) => postThreadReply(deps.run, input, claim),
        lookup: () => findPostedReply(deps.run, input),
        claim: () => {
          claimed = {
            index,
            kind: "pending",
            attemptedAt: deps.clock(),
            attemptRevision: task.revision + 1,
          };
          return replaceRound(
            context.state,
            context.round,
            withReplyReceipt(context.round, claimed),
          );
        },
      },
      send,
    );
    const next = replyReceipt({ index, send, pending: claimed ?? previous }, outcome, deps.clock);
    if (next !== undefined)
      await settleReply(context, { index, reply, previous: claimed ?? previous }, next);
  }

  return { publish, recover };
}
