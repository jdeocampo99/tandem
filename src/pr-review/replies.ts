import type { Clock } from "../contracts.ts";
import type { PrThread } from "./native-view.ts";
import type { PostReceiptOutcome, ReviewVerdict } from "./post.ts";
import type { PrReview, ReviewReply } from "./review.ts";
import type { PrReviewRound, ReplyPost } from "./state.ts";

/** One reply a posted round sends; `thread` is set for the user's selected thread replies. */
export type RoundReply = Readonly<{ replyTo: number; body: string; thread?: ReviewReply }>;

/**
 * Every reply of a round in `replyPosts` index order: the selected thread replies first, then the
 * short replies to the user's earlier comments the reviewer marked addressed.
 */
export function roundReplies(review: PrReview): readonly RoundReply[] {
  return [
    ...(review.replies ?? []).map((thread) => ({
      replyTo: thread.replyTo,
      body: thread.body,
      thread,
    })),
    ...review.priorComments.flatMap((prior) =>
      prior.status === "addressed" && prior.reply !== undefined
        ? [{ replyTo: prior.commentId, body: prior.reply }]
        : [],
    ),
  ];
}

/**
 * A reply to an earlier comment on a round whose receipt was saved by an older build, which sent
 * those replies itself with no claim or receipt. Tandem never sends, reports or recovers it again.
 */
export function sentWithoutClaim(round: PrReviewRound, reply: RoundReply): boolean {
  return (
    round.posted !== undefined &&
    round.posted.priorRepliesClaimed !== true &&
    reply.thread === undefined
  );
}

/** A reply names the root of exactly one thread, including outdated or unanchored threads. */
export function validateThreadReplies(
  replies: readonly ReviewReply[],
  threads: readonly PrThread[],
): void {
  for (const reply of replies) {
    const matches = threads.filter((thread) => thread.id === reply.threadId);
    const root = matches[0]?.comments[0];
    if (matches.length !== 1 || root?.id !== reply.commentId || root.databaseId !== reply.replyTo)
      throw new Error("The selected PR thread changed or is unavailable; reopen before replying.");
  }
}

export function validateReplyRecovery(round: PrReviewRound, verdict: ReviewVerdict, index: number) {
  const reply = roundReplies(round.review)[index];
  if (
    round.posted === undefined ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    reply === undefined
  )
    throw new Error("Recovery must name a saved reply on a posted review.");
  if (verdict !== round.posted.verdict)
    throw new Error("Recovery must keep the saved review verdict.");
  if (round.replyPosts?.find((post) => post.index === index)?.kind === "posted")
    throw new Error("This reply already has a posted receipt.");
  if (sentWithoutClaim(round, reply))
    throw new Error(
      "An earlier Tandem version already sent this reply without saving a receipt; there is nothing to recover.",
    );
}

export function replyReceipt(
  attempt: Readonly<{ index: number; send: boolean; pending: ReplyPost | undefined }>,
  outcome: PostReceiptOutcome,
  clock: Clock,
): ReplyPost | undefined {
  const { index, send, pending } = attempt;
  if (outcome.kind === "posted")
    return { index, kind: "posted", url: outcome.url, postedAt: clock() };
  // An absent marker never authorizes another POST or clears the durable warning.
  if (!send) return;
  let message: string;
  if (outcome.kind === "moved") message = `The PR moved to ${outcome.head}.`;
  else if (outcome.kind === "absent") message = "No reply marker found.";
  else message = outcome.message;
  if (pending?.kind === "pending" || pending?.kind === "uncertain")
    return {
      index,
      kind: "uncertain",
      attemptedAt: pending.attemptedAt,
      attemptRevision: pending.attemptRevision,
      message,
    };
  return { index, kind: "failed", message };
}

export function withReplyReceipt(round: PrReviewRound, post: ReplyPost): PrReviewRound {
  return {
    ...round,
    replyPosts: [...(round.replyPosts ?? []).filter((saved) => saved.index !== post.index), post],
  };
}
