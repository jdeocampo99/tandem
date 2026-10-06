import { roundReplies, sentWithoutClaim } from "./replies.ts";
import type { PrReviewRound, PrReviewState } from "./state.ts";

/** An uncertain submission needs the user's inspection and explicit choice before another POST. */
export function uncertainPostMessage(prUrl: string, detail?: string): string {
  return `GitHub may or may not have received this review; check the PR: ${prUrl}. Ask Tandem to post the saved review again (which may duplicate it), or mark it as posted with the review link you checked. Both require your confirmation.${detail === undefined ? "" : ` ${detail}`}`;
}

/**
 * Saved reply text, receipts and recovery choices survive process/task reloads. Replies an older
 * build already sent without a claim get no note, as that build showed none.
 */
export function replyPostNotes(prUrl: string, round: PrReviewRound): readonly string[] {
  return roundReplies(round.review).flatMap((reply, index) => {
    if (sentWithoutClaim(round, reply)) return [];
    const post = round.replyPosts?.find((saved) => saved.index === index);
    const target =
      reply.thread === undefined
        ? `your earlier comment (GitHub ${reply.replyTo})`
        : `thread ${reply.thread.threadId} (root ${reply.thread.commentId}, GitHub ${reply.replyTo})`;
    const label = `Reply ${index} to ${target}: ${reply.body}`;
    if (post?.kind === "posted") return [`${label}\nPosted: ${post.url}`];
    if (post === undefined)
      return [
        round.posted === undefined
          ? `${label}\nSaved with this review; not yet sent.`
          : `${label}\nNot sent. Posting this review again sends it.`,
      ];
    if (post.kind === "failed")
      return [
        `${label}\nNot sent: Tandem checked GitHub before posting and stopped, so GitHub did not receive it. Tandem will not automatically retry. Ask to post saved reply ${index} again, which requires your confirmation. Reason: ${post.message}`,
      ];
    const detail = post.kind === "uncertain" ? ` ${post.message}` : "";
    return [
      `${label}\nThis reply has no confirmed receipt. GitHub may or may not have received it; check the PR: ${prUrl}. Tandem will not automatically retry. Ask to post saved reply ${index} again (which may duplicate it), or mark it as posted with the reply link you checked. Both require your confirmation.${detail}`,
    ];
  });
}

export function reviewPostNotes(prUrl: string, round: PrReviewRound): readonly string[] {
  return [
    ...(round.pendingPost === undefined ? [] : [uncertainPostMessage(prUrl)]),
    ...replyPostNotes(prUrl, round),
    ...round.notes,
  ];
}

/** Small reviews read fine in chat; anything with a tour or many comments gets the page. */
export function wantsPage(round: PrReviewRound): boolean {
  return round.review.tour.length > 0 || round.review.comments.length > 5;
}

/** The review as plain text for chat and for the task report. */
export function renderReviewText(state: PrReviewState, round: PrReviewRound): string {
  const { review } = round;
  const lines = [
    `${state.ref.repo}#${state.ref.number}: ${state.title}`,
    "",
    "What it does and why",
    review.intent,
  ];
  if (round.pendingPost !== undefined) lines.unshift(uncertainPostMessage(state.url), "");
  if (review.verdict !== undefined) lines.push("", `Verdict: ${review.verdict}`);
  if (review.tour.length > 0) {
    lines.push("", "Code tour");
    review.tour.forEach((chapter, index) => {
      lines.push(`${index + 1}. ${chapter.title}: ${chapter.why}`);
      for (const stop of chapter.stops) {
        const range = stop.from === stop.to ? `${stop.from}` : `${stop.from}-${stop.to}`;
        lines.push(`   - ${stop.file}:${range} ${stop.title}: ${stop.body}`);
      }
    });
  }
  lines.push("", "Concerns");
  if (review.concerns.length === 0) lines.push("None.");
  for (const concern of review.concerns) {
    lines.push(`- [${concern.severity}] ${concern.title}: ${concern.detail}`);
  }
  if (review.priorComments.length > 0) {
    lines.push("", "Your earlier comments");
    for (const prior of review.priorComments) {
      lines.push(
        `- comment ${prior.commentId}: ${prior.status.replace("-", " ")}${prior.reply === undefined ? "" : ` (reply: "${prior.reply}")`}`,
      );
    }
  }
  lines.push("", "Draft comments");
  if (review.comments.length === 0) lines.push("None inline.");
  for (const comment of review.comments) {
    lines.push(`- ${comment.id} ${comment.file}:${comment.line} [${comment.severity}]`);
    lines.push(...comment.body.split("\n").map((line) => `    ${line}`));
  }
  if (review.summaryComment.length > 0) {
    lines.push("", "Review summary to post", review.summaryComment);
  }
  const notes = [...replyPostNotes(state.url, round), ...round.notes];
  if (notes.length > 0) lines.push("", ...notes);
  if (round.posted !== undefined) lines.push("", `Posted: ${round.posted.url}`);
  return `${lines.join("\n")}\n`;
}
