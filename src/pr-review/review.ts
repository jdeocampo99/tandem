import { isRecord } from "../adapters/primitives.ts";
import { lineRanges } from "./diff.ts";

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

/** One place the tour stops: a new-file line range, inclusive, explained in 1-2 sentences. */
export type TourStop = Readonly<{
  file: string;
  from: number;
  to: number;
  title: string;
  body: string;
}>;

/** One part of the change, its stops in execution order; the page draws its diagram from these. */
type TourChapter = Readonly<{ title: string; why: string; stops: readonly TourStop[] }>;

type PriorCommentStatus = Readonly<{
  commentId: number;
  status: "addressed" | "not-addressed" | "replied";
  /** A short reply to post on the thread, such as "Looks good, thanks!". */
  reply?: string;
}>;

export type ReviewReply = Readonly<{
  threadId: string;
  commentId: string;
  replyTo: number;
  body: string;
}>;

export function parseReviewReplies(value: unknown): readonly ReviewReply[] {
  return list(value, "replies").map((item, index) => {
    const entry = requireRecord(item, `replies[${index}]`);
    const replyTo = integer(entry.replyTo, "replyTo");
    if (!Number.isSafeInteger(replyTo) || replyTo <= 0)
      throw new TypeError("replyTo must be a positive safe integer");
    for (const key of Object.keys(entry))
      if (!["threadId", "commentId", "replyTo", "body"].includes(key))
        throw new TypeError(`Unknown reply field ${key}`);
    return {
      threadId: requireText(entry.threadId, "threadId"),
      commentId: requireText(entry.commentId, "commentId"),
      replyTo,
      body: requireText(entry.body, "body"),
    };
  });
}

/** The reviewer's structured result, checked before anything is shown or posted. */
export type PrReview = Readonly<{
  head: string;
  intent: string;
  /** One sentence on whether it is safe to merge and what has to happen first. */
  verdict?: string;
  tour: readonly TourChapter[];
  concerns: readonly ReviewConcern[];
  comments: readonly DraftComment[];
  /** Posted as the review body; the intent lens puts its whole review here. */
  summaryComment: string;
  priorComments: readonly PriorCommentStatus[];
  replies?: readonly ReviewReply[];
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
{"head":"<exact HEAD>","intent":"<2-3 plain sentences: what the PR does and why>","verdict":"<one sentence: is it safe to merge, and what must happen first>","tour":[{"title":"<chapter>","why":"<one line>","stops":[{"file":"<path>","from":1,"to":9,"title":"<short>","body":"<1-2 sentences>"}]}],"concerns":[{"title":"<short>","detail":"<plain English>","severity":"blocking|suggestion|nit|question"}],"comments":[{"id":"<stable id>","file":"<path>","line":1,"body":"<comment as a friendly teammate would write it>","severity":"blocking|suggestion|nit|question"}],"summaryComment":"<the review body to post, 1-4 short sentences in the same voice>","priorComments":[{"commentId":123,"status":"addressed|not-addressed|replied","reply":"<optional short reply>"}]}
tour: 2-4 chapters and about 3-12 stops in all, each chapter's stops in execution order; from-to is an inclusive new-file range that touches the diff. Leave tour empty for renames and config-only changes. concerns are only points with no single line; a point about one line is a comment. Lines are new-file line numbers inside the diff. priorComments is empty on a first review.`;

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
  const tour = review.tour.flatMap((chapter) => {
    const stops = chapter.stops.filter((stop) => stopProblem(stop, commentable) === undefined);
    return stops.length === 0 ? [] : [{ ...chapter, stops }];
  });
  const dropped = stopCount(review.tour) - stopCount(tour);
  if (dropped > 0) {
    notes.push(
      `${dropped} tour stop${dropped === 1 ? "" : "s"} pointed outside the diff, so ${dropped === 1 ? "it was" : "they were"} left out of the tour.`,
    );
  }
  return {
    review: {
      ...review,
      tour,
      comments: inline.sort(bySeverity),
      concerns: [...review.concerns].sort(bySeverity),
      summaryComment,
    },
    notes,
  };
}

function stopCount(tour: readonly TourChapter[]): number {
  return tour.reduce((count, chapter) => count + chapter.stops.length, 0);
}

function bySeverity(a: { severity: CommentSeverity }, b: { severity: CommentSeverity }): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

/**
 * Why each inline comment or tour stop cannot be used as written, phrased so the reviewer can fix
 * it: a line outside the diff names the lines in the diff, and an intent review takes no comments.
 */
export function anchorProblems(
  review: PrReview,
  commentable: ReadonlyMap<string, ReadonlySet<number>>,
  inlineComments: boolean,
): readonly string[] {
  const stops = review.tour.flatMap((chapter) =>
    chapter.stops.flatMap((stop) => {
      const problem = stopProblem(stop, commentable);
      return problem === undefined ? [] : [`tour stop "${stop.title}": ${problem}`];
    }),
  );
  if (!inlineComments && review.comments.length > 0) {
    return [
      "this is an intent review: leave comments empty and put those points in concerns and summaryComment",
      ...stops,
    ];
  }
  const comments = review.comments.flatMap((comment) => {
    const lines = commentable.get(comment.file);
    if (lines === undefined) {
      return [
        `${comment.id}: ${comment.file} is not in the diff; comment on a changed file or use summaryComment`,
      ];
    }
    if (lines.has(comment.line)) return [];
    return [
      `${comment.id}: line ${comment.line} of ${comment.file} is not in the diff; lines that can take comments: ${lineRanges(lines)}`,
    ];
  });
  return [...comments, ...stops];
}

/**
 * Why a tour stop cannot be shown, or `undefined` when it can: its file is in the diff, its range
 * runs forward from line 1 or later, and the range touches at least one line the diff shows.
 */
export function stopProblem(
  stop: TourStop,
  commentable: ReadonlyMap<string, ReadonlySet<number>>,
): string | undefined {
  const lines = commentable.get(stop.file);
  if (lines === undefined) return `${stop.file} is not in the diff; stop on a changed file`;
  if (stop.from < 1 || stop.to < stop.from) {
    return `${stop.from}-${stop.to} is not a line range; use 1 <= from <= to`;
  }
  for (let line = stop.from; line <= stop.to; line += 1) {
    if (lines.has(line)) return undefined;
  }
  return `lines ${stop.from}-${stop.to} of ${stop.file} are outside the diff; lines in the diff: ${lineRanges(lines)}`;
}

/** Reads a PrReview object, from the worker or from storage; throws a TypeError naming the bad field. */
export function parsePrReview(value: unknown): PrReview {
  const record = requireRecord(value, "review");
  const verdict = optionalText(record.verdict);
  return {
    head: requireText(record.head, "review.head"),
    ...(record.replies === undefined ? {} : { replies: parseReviewReplies(record.replies) }),
    intent: requireText(record.intent, "review.intent"),
    ...(verdict === undefined ? {} : { verdict }),
    // Rounds stored before the tour have diagram and readingOrder instead, which are ignored.
    tour: (record.tour === undefined ? [] : list(record.tour, "review.tour")).map((item, index) => {
      const where = `review.tour[${index}]`;
      const entry = requireRecord(item, where);
      return {
        title: requireText(entry.title, `${where}.title`),
        why: requireText(entry.why, `${where}.why`),
        stops: list(entry.stops, `${where}.stops`).map((stop, stopIndex) =>
          parseStop(stop, `${where}.stops[${stopIndex}]`),
        ),
      };
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

function parseStop(value: unknown, where: string): TourStop {
  const entry = requireRecord(value, where);
  return {
    file: requireText(entry.file, `${where}.file`),
    from: integer(entry.from, `${where}.from`),
    to: integer(entry.to, `${where}.to`),
    title: requireText(entry.title, `${where}.title`),
    body: requireText(entry.body, `${where}.body`),
  };
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be an integer`);
  }
  return value;
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
