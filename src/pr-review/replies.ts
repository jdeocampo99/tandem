import type { PrThread } from "./native-view.ts";
import type { ReviewReply } from "./review.ts";

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
