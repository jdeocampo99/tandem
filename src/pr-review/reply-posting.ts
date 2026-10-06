import type { TaskRecord } from "../contracts.ts";
import { readNativeThreads } from "../pr-watch/native-cache.ts";
import { findPostedReply, postThreadReply } from "./post.ts";
import { roundReplies, validateThreadReplies } from "./replies.ts";
import type { PrReviewDependencies } from "./service.ts";
import type { PrReviewRound, PrReviewState, ReplyPost } from "./state.ts";

/** Replies are separate effects with separate claims and receipts from their parent review. */
export function createReplyPosting(
  deps: Pick<
    PrReviewDependencies,
    "run" | "clock" | "getTask" | "updatePrReview" | "mutatePrReview"
  >,
) {
  async function attempt(
    taskId: string,
    binding: PrReviewRound,
    index: number,
    send: boolean,
    recoveryRevision?: number,
  ) {
    const task = await deps.getTask(taskId);
    if (recoveryRevision !== undefined && task.revision !== recoveryRevision)
      throw new Error(
        "The reply changed since you checked it; inspect it again before confirming recovery.",
      );
    const { state, round } = savedRound(task, binding);
    const reply = roundReplies(round.review)[index];
    if (reply === undefined) throw new Error("This round has no saved reply at that index.");
    const previous = round.replyPosts?.find((post) => post.index === index);
    if (previous?.kind === "posted") return;
    if (send && previous !== undefined && recoveryRevision === undefined) {
      await attempt(taskId, binding, index, false);
      return;
    }
    const input = {
      ref: state.ref,
      cwd: state.checkout,
      head: round.head,
      reply,
      marker: `<!-- tandem-reply:${taskId}:${round.generation}:${index} -->`,
    };
    let claimed: ReplyPost | undefined;
    if (send && recoveryRevision !== undefined && reply.thread !== undefined) {
      validateThreadReplies(
        [reply.thread],
        await readNativeThreads(deps.run, state.ref, state.checkout, round.head),
      );
    }
    const outcome = send
      ? await postThreadReply(deps.run, input, async () => {
          claimed = {
            index,
            kind: "pending",
            attemptedAt: deps.clock(),
            attemptRevision: task.revision + 1,
          };
          // The task revision is the exclusive claim, including for a user-confirmed new attempt.
          await deps.updatePrReview(task, replacePost(state, round, claimed));
        })
      : await findPostedReply(deps.run, input);
    let next: ReplyPost;
    if (
      outcome.kind === "found" ||
      outcome.kind === "posted" ||
      outcome.kind === "already-posted"
    ) {
      next = { index, kind: "posted", url: outcome.url, postedAt: deps.clock() };
    } else if (!send) {
      // An absent marker never authorizes another POST. Retain the durable attempt and warning.
      return;
    } else {
      const pending = claimed ?? previous;
      const message =
        outcome.kind === "moved"
          ? `The PR moved to ${outcome.head}.`
          : outcome.kind === "absent"
            ? "No reply marker found."
            : outcome.message;
      next =
        pending?.kind === "pending" || pending?.kind === "uncertain"
          ? {
              index,
              kind: "uncertain",
              attemptedAt: pending.attemptedAt,
              attemptRevision: pending.attemptRevision,
              message,
            }
          : { index, kind: "failed", message };
    }
    await deps.mutatePrReview(taskId, (current) => {
      const live = savedRound(current, binding);
      if (live.state.ref.repo !== state.ref.repo || live.state.ref.number !== state.ref.number)
        throw new Error("The reply's PR changed; inspect it again.");
      const saved = live.round.replyPosts?.find((post) => post.index === index);
      if (saved?.kind === "posted") return live.state;
      if (JSON.stringify(saved) !== JSON.stringify(claimed ?? previous))
        throw new Error("The saved reply attempt changed; inspect it again.");
      if (JSON.stringify(roundReplies(live.round.review)[index]) !== JSON.stringify(reply))
        throw new Error("The saved reply changed; inspect it again.");
      return replacePost(live.state, live.round, next);
    });
  }

  /**
   * Sends every reply of a posted round that has no claim yet and reconciles the rest, so a crash
   * mid-loop loses nothing on re-entry and a claimed reply is never sent twice.
   */
  async function postRemaining(taskId: string, round: PrReviewRound) {
    for (const index of roundReplies(round.review).keys())
      await attempt(taskId, round, index, true);
  }

  async function markPosted(task: TaskRecord, round: PrReviewRound, index: number, url: string) {
    const { state } = savedRound(task, round);
    await deps.updatePrReview(
      task,
      replacePost(state, round, {
        index,
        kind: "posted",
        url,
        postedAt: deps.clock(),
        confirmedByUser: true,
      }),
    );
  }
  return { attempt, postRemaining, markPosted };
}

function savedRound(task: TaskRecord, binding: PrReviewRound) {
  const state = task.prReview;
  const round = state?.rounds.find(
    (entry) => entry.generation === binding.generation && entry.head === binding.head,
  );
  if (state === undefined || round?.posted === undefined)
    throw new Error("The posted review round is unavailable; inspect the task again.");
  return { state, round };
}

function replacePost(state: PrReviewState, round: PrReviewRound, post: ReplyPost): PrReviewState {
  return {
    ...state,
    rounds: state.rounds.map((entry) =>
      entry === round
        ? {
            ...entry,
            replyPosts: [
              ...(entry.replyPosts ?? []).filter((saved) => saved.index !== post.index),
              post,
            ],
          }
        : entry,
    ),
  };
}
