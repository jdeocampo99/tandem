import { join } from "node:path";
import { isRecord } from "../adapters/primitives.ts";
import type { TaskRecord } from "../contracts.ts";
import type { ReviewVerdict } from "./post.ts";
import type { PullRequestRef } from "./pull-request.ts";
import { roundReplies } from "./replies.ts";
import { type PrReview, parsePrReview, type ReviewLens } from "./review.ts";

/**
 * What the next worker run is for: a first review, a re-review of new pushes, or an answer to a
 * follow-up question about the PR.
 */
export type PrReviewMode = "review" | "re-review" | "question";

type PostedReview = Readonly<{
  url: string;
  verdict: ReviewVerdict;
  postedAt: string;
  /** The user checked the PR and explicitly supplied this receipt after an uncertain POST. */
  confirmedByUser?: true;
  /**
   * Set on every receipt saved by a build that claims replies to earlier comments in `replyPosts`.
   * Older builds sent those replies directly with no claim or receipt, so on a receipt without it
   * they count as already sent.
   */
  priorRepliesClaimed?: true;
}>;

/** One reply's network claim or settled result; its target and body live in roundReplies(review)[index]. */
export type ReplyPost = Readonly<{ index: number }> &
  (
    | Readonly<{ kind: "pending"; attemptedAt: string; attemptRevision: number }>
    | Readonly<{ kind: "uncertain"; attemptedAt: string; attemptRevision: number; message: string }>
    | Readonly<{ kind: "failed"; message: string }>
    | Readonly<{ kind: "posted"; url: string; postedAt: string; confirmedByUser?: true }>
  );

/** One finished review of one PR head. */
export type PrReviewRound = Readonly<{
  generation: number;
  head: string;
  /** Where the reviewed diff starts: the merge base, or the previous head on a re-review. */
  from: string;
  review: PrReview;
  notes: readonly string[];
  posted?: PostedReview;
  replyPosts?: readonly ReplyPost[];
  /** Saved before GitHub is called; retained until its marker proves the review landed. */
  pendingPost?: Readonly<{ verdict: ReviewVerdict; attemptedAt: string }>;
}>;

/** The durable part of a `pr-review` task, stored on its task record. */
export type PrReviewState = Readonly<{
  ref: PullRequestRef;
  url: string;
  title: string;
  author: string;
  baseRef: string;
  /** The user's own checkout the review worktree is created from. */
  checkout: string;
  remote: string;
  lens: ReviewLens;
  mode: PrReviewMode;
  rounds: readonly PrReviewRound[];
  /** Set when the user is done; cleanup then removes the review worktree. */
  closed?: true;
}>;

const MODES: ReadonlySet<string> = new Set(["review", "re-review", "question"]);
const VERDICTS: ReadonlySet<string> = new Set(["comment", "approve", "request-changes"]);

/** Files one worker run reads: the diff and the PR's context, written before the worker starts. */
export function prReviewRunDirectory(home: string, taskId: string, generation: number): string {
  return join(home, "pr-review", taskId, `run-${generation}`);
}

/** The raw diff one run reviews; worker and runner both check comment anchors against it. */
export function prReviewRunDiffPath(home: string, taskId: string, generation: number): string {
  return join(prReviewRunDirectory(home, taskId, generation), "diff.patch");
}

export function prReviewWorktreePath(home: string, taskId: string): string {
  return join(home, "pr-review", taskId, "worktree");
}

export function latestRound(state: PrReviewState): PrReviewRound | undefined {
  return state.rounds.at(-1);
}

export function findRound(
  state: PrReviewState,
  binding: Pick<PrReviewRound, "generation" | "head">,
): PrReviewRound | undefined {
  return state.rounds.find(
    (round) => round.generation === binding.generation && round.head === binding.head,
  );
}

export function lensLabel(lens: ReviewLens): string {
  if (lens.kind === "intent") return "for intent";
  if (lens.kind === "focus") return `focused on ${lens.focus}`;
  return "";
}

export function parsePrReviewState(value: unknown, source: string): PrReviewState {
  const record = recordAt(value, source);
  const ref = recordAt(record.ref, `${source}.ref`);
  const number = ref.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${source}.ref.number must be a positive integer`);
  }
  const mode = textAt(record.mode, `${source}.mode`);
  if (!MODES.has(mode)) throw new TypeError(`${source}.mode is not a known mode`);
  if (!Array.isArray(record.rounds)) throw new TypeError(`${source}.rounds must be an array`);
  if (record.closed !== undefined && record.closed !== true) {
    throw new TypeError(`${source}.closed must be true when present`);
  }
  return {
    ref: { repo: textAt(ref.repo, `${source}.ref.repo`), number },
    url: textAt(record.url, `${source}.url`),
    title: stringAt(record.title, `${source}.title`),
    author: stringAt(record.author, `${source}.author`),
    baseRef: textAt(record.baseRef, `${source}.baseRef`),
    checkout: textAt(record.checkout, `${source}.checkout`),
    remote: textAt(record.remote, `${source}.remote`),
    lens: parseLens(record.lens, `${source}.lens`),
    mode: mode as PrReviewMode,
    rounds: record.rounds.map((round, index) => parseRound(round, `${source}.rounds[${index}]`)),
    ...(record.closed === true ? { closed: true as const } : {}),
  };
}

function parseLens(value: unknown, source: string): ReviewLens {
  const record = recordAt(value, source);
  if (record.kind === "full" || record.kind === "intent") return { kind: record.kind };
  if (record.kind === "focus") {
    return { kind: "focus", focus: textAt(record.focus, `${source}.focus`) };
  }
  throw new TypeError(`${source}.kind must be full, intent, or focus`);
}

function parseRound(value: unknown, source: string): PrReviewRound {
  const record = recordAt(value, source);
  const generation = record.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError(`${source}.generation must be a non-negative integer`);
  }
  if (!Array.isArray(record.notes) || record.notes.some((note) => typeof note !== "string")) {
    throw new TypeError(`${source}.notes must be an array of strings`);
  }
  const review = parsePrReview(record.review);
  return {
    generation,
    ...(record.replyPosts === undefined
      ? {}
      : {
          replyPosts: parseReplyPosts(record.replyPosts, source, roundReplies(review).length),
        }),
    head: textAt(record.head, `${source}.head`),
    from: textAt(record.from, `${source}.from`),
    review,
    notes: record.notes as readonly string[],
    ...(record.posted === undefined
      ? {}
      : { posted: parsePosted(record.posted, `${source}.posted`) }),
    ...(record.pendingPost === undefined
      ? {}
      : { pendingPost: parsePendingPost(record.pendingPost, `${source}.pendingPost`) }),
  };
}

function parseReplyPosts(value: unknown, source: string, count: number): readonly ReplyPost[] {
  if (!Array.isArray(value)) throw new TypeError(`${source}.replyPosts must be an array`);
  const indices = new Set<number>();
  return value.map((item) => {
    const record = recordAt(item, `${source}.replyPosts`);
    const index = record.index;
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count ||
      indices.has(index)
    )
      throw new TypeError(`${source}.replyPosts.index must name a unique saved reply`);
    indices.add(index);
    if (record.kind === "posted") {
      if (record.confirmedByUser !== undefined && record.confirmedByUser !== true)
        throw new TypeError(`${source}.replyPosts.confirmedByUser must be true when present`);
      return {
        index,
        kind: "posted",
        url: textAt(record.url, source),
        postedAt: textAt(record.postedAt, source),
        ...(record.confirmedByUser === true ? { confirmedByUser: true as const } : {}),
      };
    }
    if (record.kind === "pending" || record.kind === "uncertain") {
      const attemptedAt = textAt(record.attemptedAt, source);
      const attemptRevision = record.attemptRevision;
      if (
        typeof attemptRevision !== "number" ||
        !Number.isSafeInteger(attemptRevision) ||
        attemptRevision < 0
      )
        throw new TypeError(`${source}.replyPosts.attemptRevision must be a non-negative integer`);
      return record.kind === "pending"
        ? { index, kind: "pending", attemptedAt, attemptRevision }
        : {
            index,
            kind: "uncertain",
            attemptedAt,
            attemptRevision,
            message: textAt(record.message, source),
          };
    }
    if (record.kind === "failed")
      return { index, kind: "failed", message: textAt(record.message, source) };
    throw new TypeError(`${source}.replyPosts.kind is unknown`);
  });
}

function parsePendingPost(
  value: unknown,
  source: string,
): NonNullable<PrReviewRound["pendingPost"]> {
  const record = recordAt(value, source);
  const verdict = textAt(record.verdict, `${source}.verdict`);
  if (!VERDICTS.has(verdict)) throw new TypeError(`${source}.verdict is not a known verdict`);
  return {
    verdict: verdict as ReviewVerdict,
    attemptedAt: textAt(record.attemptedAt, `${source}.attemptedAt`),
  };
}

function parsePosted(value: unknown, source: string): PostedReview {
  const record = recordAt(value, source);
  const verdict = textAt(record.verdict, `${source}.verdict`);
  if (!VERDICTS.has(verdict)) throw new TypeError(`${source}.verdict is not a known verdict`);
  for (const flag of ["confirmedByUser", "priorRepliesClaimed"] as const) {
    if (record[flag] !== undefined && record[flag] !== true)
      throw new TypeError(`${source}.${flag} must be true when present`);
  }
  return {
    url: stringAt(record.url, `${source}.url`),
    verdict: verdict as ReviewVerdict,
    postedAt: textAt(record.postedAt, `${source}.postedAt`),
    ...(record.confirmedByUser === true ? { confirmedByUser: true as const } : {}),
    ...(record.priorRepliesClaimed === true ? { priorRepliesClaimed: true as const } : {}),
  };
}

function recordAt(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${source} must be an object`);
  return value;
}

function textAt(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${source} must be non-empty text`);
  }
  return value;
}

function stringAt(value: unknown, source: string): string {
  if (typeof value !== "string") throw new TypeError(`${source} must be text`);
  return value;
}

export function postedRound(task: TaskRecord, binding: PrReviewRound, message?: string) {
  const state = message === undefined ? reviewState(task) : task.prReview;
  const round = state === undefined ? undefined : findRound(state, binding);
  if (state === undefined || round?.posted === undefined)
    throw new Error(message ?? "The review receipt was not saved.");
  return { task, state, round, posted: round.posted };
}

export function reviewState(task: TaskRecord): PrReviewState {
  if (task.prReview === undefined) throw new Error(`Task ${task.id} is not a PR review.`);
  return task.prReview;
}

export function replaceLatestRound(state: PrReviewState, round: PrReviewRound): PrReviewState {
  return { ...state, rounds: [...state.rounds.slice(0, -1), round] };
}

export function samePr(left: PrReviewState, right: PrReviewState): boolean {
  return left.ref.repo === right.ref.repo && left.ref.number === right.ref.number;
}

export function replaceRound(
  state: PrReviewState,
  round: PrReviewRound,
  next: PrReviewRound,
): PrReviewState {
  return { ...state, rounds: state.rounds.map((entry) => (entry === round ? next : entry)) };
}
