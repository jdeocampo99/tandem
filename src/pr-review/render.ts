import type { PrReviewRound, PrReviewState } from "./state.ts";

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
  if (round.notes.length > 0) lines.push("", ...round.notes);
  if (round.posted !== undefined) lines.push("", `Posted: ${round.posted.url}`);
  return `${lines.join("\n")}\n`;
}
