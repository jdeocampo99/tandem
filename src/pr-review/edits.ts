import { lineRanges } from "./diff.ts";
import type { ReviewSubmission } from "./page.ts";
import type { CommentSeverity, DraftComment, PrReview } from "./review.ts";

export type CommentEdit = Readonly<{
  id: string;
  body?: string | undefined;
  severity?: CommentSeverity | undefined;
  drop?: boolean | undefined;
}>;

/** A comment the user writes; it must sit on a line the round's diff can anchor. */
export type NewComment = Readonly<{ file: string; line: number; body: string }>;

export type PrReviewEdits = Readonly<{
  comments?: readonly CommentEdit[];
  add?: readonly NewComment[];
  summaryComment?: string;
}>;

/**
 * The review with the edits applied: rewrites, relabels, and drops by id, then adds the user's own
 * comments under new ids `u1`, `u2`, ... Throws one Error naming every unknown id or bad line.
 */
export function applyEdits(
  review: PrReview,
  edits: PrReviewEdits,
  commentable: ReadonlyMap<string, ReadonlySet<number>>,
): PrReview {
  const byId = new Map((edits.comments ?? []).map((change) => [change.id, change]));
  const unknown = [...byId.keys()].filter(
    (id) => !review.comments.some((comment) => comment.id === id),
  );
  if (unknown.length > 0) throw new Error(`No draft comment with id ${unknown.join(", ")}`);
  const kept = review.comments.flatMap((comment) => {
    const change = byId.get(comment.id);
    if (change === undefined) return [comment];
    if (change.drop === true) return [];
    return [
      {
        ...comment,
        ...(change.body === undefined ? {} : { body: nonEmpty(change.body, "comment body") }),
        ...(change.severity === undefined ? {} : { severity: change.severity }),
      },
    ];
  });
  const problems = (edits.add ?? []).flatMap((comment) => lineProblem(comment, commentable));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const used = new Set(review.comments.map((comment) => comment.id));
  const added = (edits.add ?? []).map((comment): DraftComment => {
    const id = nextUserId(used);
    used.add(id);
    return {
      id,
      file: comment.file,
      line: comment.line,
      body: nonEmpty(comment.body, "comment body"),
      severity: "suggestion",
    };
  });
  return {
    ...review,
    comments: [...kept, ...added],
    ...(edits.summaryComment === undefined ? {} : { summaryComment: edits.summaryComment.trim() }),
  };
}

/**
 * What the page's submission asks for, as edits: a draft marked post is kept (with the user's
 * wording when they edited it), every other draft is left out, the user's own comments are added,
 * and the summary replaces the review body. A draft id the review does not have is an error.
 */
export function submissionEdits(review: PrReview, submission: ReviewSubmission): PrReviewEdits {
  const decided = new Map(submission.drafts.map((draft) => [draft.id, draft]));
  const unknown = [...decided.keys()].filter(
    (id) => !review.comments.some((comment) => comment.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`The page sent draft ids this review does not have: ${unknown.join(", ")}`);
  }
  return {
    comments: review.comments.map((comment): CommentEdit => {
      const draft = decided.get(comment.id);
      if (draft?.decision !== "post") return { id: comment.id, drop: true };
      return draft.body === undefined ? { id: comment.id } : { id: comment.id, body: draft.body };
    }),
    add: submission.yours,
    summaryComment: submission.summary,
  };
}

function lineProblem(
  comment: NewComment,
  commentable: ReadonlyMap<string, ReadonlySet<number>>,
): readonly string[] {
  const lines = commentable.get(comment.file);
  if (lines === undefined)
    return [`${comment.file} is not in the diff, so it can't take a comment.`];
  if (lines.has(comment.line)) return [];
  return [
    `Line ${comment.line} of ${comment.file} can't take a comment; lines that can: ${lineRanges(lines)}.`,
  ];
}

function nextUserId(used: ReadonlySet<string>): string {
  let index = 1;
  while (used.has(`u${index}`)) index += 1;
  return `u${index}`;
}

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty`);
  return trimmed;
}
