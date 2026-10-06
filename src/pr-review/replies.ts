import type { PrThread } from "./native-view.ts";
import type { PrReview, ReviewReply } from "./review.ts";

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
