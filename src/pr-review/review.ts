import { isRecord } from "../adapters/primitives.ts";

/** What the review looks at; `focus` carries the user's own words. */
export type ReviewLens =
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "intent" }>
  | Readonly<{ kind: "focus"; focus: string }>;

/** Orders and labels comments; never shown to the author as a grade. */
export type CommentSeverity = "blocking" | "suggestion" | "nit" | "question";

export type ReviewConcern = Readonly<{ title: string; detail: string; severity: CommentSeverity }>;

export type DraftComment = Readonly<{
  id: string;
  file: string;
  line: number;
  body: string;
  severity: CommentSeverity;
}>;

export type PriorCommentStatus = Readonly<{
  commentId: number;
  status: "addressed" | "not-addressed" | "replied";
  /** A short reply to post on the thread, such as "Looks good, thanks!". */
  reply?: string;
}>;

/** The reviewer's structured result, checked before anything is shown or posted. */
export type PrReview = Readonly<{
  head: string;
  intent: string;
  diagram?: string;
  readingOrder: readonly Readonly<{ file: string; why: string }>[];
  concerns: readonly ReviewConcern[];
  comments: readonly DraftComment[];
  /** Posted as the review body; the intent lens puts its whole review here. */
  summaryComment: string;
  priorComments: readonly PriorCommentStatus[];
}>;

export type ReviewCheck = Readonly<{
  review: PrReview;
  /** Plain-English notes about what was moved or dropped, for the user. */
  notes: readonly string[];
}>;

const SEVERITIES: ReadonlySet<string> = new Set(["blocking", "suggestion", "nit", "question"]);
const SEVERITY_ORDER: Readonly<Record<CommentSeverity, number>> = {
  blocking: 0,
  question: 1,
  suggestion: 2,
  nit: 3,
};
const PRIOR_STATUSES: ReadonlySet<string> = new Set(["addressed", "not-addressed", "replied"]);

/** The review result shape the reviewer is told to submit, kept beside the parser that reads it. */
export const PR_REVIEW_SCHEMA = `Put exactly one PrReview JSON object, with no prose around it, in the submit_report report field:
{"head":"<exact HEAD>","intent":"<2-3 plain sentences: what the PR does and why>","diagram":"<optional Mermaid flowchart from entry point to where the data ends up; changed nodes use class changed>","readingOrder":[{"file":"<path>","why":"<one line>"}],"concerns":[{"title":"<short>","detail":"<plain English>","severity":"blocking|suggestion|nit|question"}],"comments":[{"id":"<stable id>","file":"<path>","line":1,"body":"<comment as a friendly teammate would write it>","severity":"blocking|suggestion|nit|question"}],"summaryComment":"<the review body to post, 1-4 short sentences in the same voice>","priorComments":[{"commentId":123,"status":"addressed|not-addressed|replied","reply":"<optional short reply>"}]}
Omit diagram for renames, config-only or one-file changes. Lines are new-file line numbers inside the diff. priorComments is empty on a first review.`;

/** Parses the reviewer's result, then fits it to the lens and to the lines GitHub can anchor. */
export function checkReview(
  value: unknown,
  lens: ReviewLens,
  commentable: ReadonlyMap<string, ReadonlySet<number>>,
): ReviewCheck {
  const review = parsePrReview(value);
  const notes: string[] = [];
  const inline: DraftComment[] = [];
  const unanchored: DraftComment[] = [];
  for (const comment of review.comments) {
    if (lens.kind !== "intent" && commentable.get(comment.file)?.has(comment.line) === true) {
      inline.push(comment);
    } else {
      unanchored.push(comment);
    }
  }
  let summaryComment = review.summaryComment;
  if (unanchored.length > 0) {
    if (lens.kind === "intent") {
      notes.push(
        "Intent reviews stay out of the details, so line comments were folded into the summary.",
      );
    } else {
      notes.push(
        `${unanchored.length} comment${unanchored.length === 1 ? "" : "s"} pointed outside the diff, so ${unanchored.length === 1 ? "it moved" : "they moved"} into the summary.`,
      );
    }
    summaryComment = [
      summaryComment,
      ...unanchored.map((comment) => `On \`${comment.file}:${comment.line}\`: ${comment.body}`),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
  return {
    review: {
      ...review,
      comments: inline.sort(bySeverity),
      concerns: [...review.concerns].sort(bySeverity),
      summaryComment,
    },
    notes,
  };
}

function bySeverity(a: { severity: CommentSeverity }, b: { severity: CommentSeverity }): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

/** Reads a PrReview object, from the worker or from storage; throws a TypeError naming the bad field. */
export function parsePrReview(value: unknown): PrReview {
  const record = requireRecord(value, "review");
  const diagram = optionalText(record.diagram);
  return {
    head: requireText(record.head, "review.head"),
    intent: requireText(record.intent, "review.intent"),
    ...(diagram === undefined ? {} : { diagram }),
    readingOrder: list(record.readingOrder, "review.readingOrder").map((item, index) => {
      const entry = requireRecord(item, `review.readingOrder[${index}]`);
      return { file: requireText(entry.file, "file"), why: requireText(entry.why, "why") };
    }),
    concerns: list(record.concerns, "review.concerns").map((item, index) => {
      const entry = requireRecord(item, `review.concerns[${index}]`);
      return {
        title: requireText(entry.title, "title"),
        detail: requireText(entry.detail, "detail"),
        severity: severity(entry.severity),
      };
    }),
    comments: list(record.comments, "review.comments").map((item, index) => {
      const entry = requireRecord(item, `review.comments[${index}]`);
      const line = entry.line;
      if (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0) {
        throw new TypeError(`review.comments[${index}].line must be a positive integer`);
      }
      return {
        id: optionalText(entry.id) ?? `c${index + 1}`,
        file: requireText(entry.file, "file"),
        line,
        body: requireText(entry.body, "body"),
        severity: severity(entry.severity),
      };
    }),
    summaryComment: optionalText(record.summaryComment) ?? "",
    priorComments: (record.priorComments === undefined
      ? []
      : list(record.priorComments, "review.priorComments")
    ).map((item, index) => {
      const entry = requireRecord(item, `review.priorComments[${index}]`);
      const status = entry.status;
      if (typeof status !== "string" || !PRIOR_STATUSES.has(status)) {
        throw new TypeError(`review.priorComments[${index}].status is not a known status`);
      }
      const commentId = entry.commentId;
      if (typeof commentId !== "number" || !Number.isSafeInteger(commentId)) {
        throw new TypeError(`review.priorComments[${index}].commentId must be an integer`);
      }
      const reply = optionalText(entry.reply);
      return {
        commentId,
        status: status as PriorCommentStatus["status"],
        ...(reply === undefined ? {} : { reply }),
      };
    }),
  };
}

function severity(value: unknown): CommentSeverity {
  if (typeof value === "string" && SEVERITIES.has(value)) return value as CommentSeverity;
  return "suggestion";
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function list(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}
