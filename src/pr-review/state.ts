import { join } from "node:path";
import { isRecord } from "../adapters/primitives.ts";
import type { ReviewVerdict } from "./post.ts";
import type { PullRequestRef } from "./pull-request.ts";
import { type PrReview, parsePrReview, type ReviewLens } from "./review.ts";

/**
 * What the next worker run is for: a first review, a re-review of new pushes, or an answer to a
 * follow-up question about the PR.
 */
export type PrReviewMode = "review" | "re-review" | "question";

export type PostedReview = Readonly<{
  url: string;
  verdict: ReviewVerdict;
  postedAt: string;
}>;

/** One finished review of one PR head. */
export type PrReviewRound = Readonly<{
  generation: number;
  head: string;
  /** Where the reviewed diff starts: the merge base, or the previous head on a re-review. */
  from: string;
  review: PrReview;
  notes: readonly string[];
  posted?: PostedReview;
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

export function parseLens(value: unknown, source: string): ReviewLens {
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
  return {
    generation,
    head: textAt(record.head, `${source}.head`),
    from: textAt(record.from, `${source}.from`),
    review: parsePrReview(record.review),
    notes: record.notes as readonly string[],
    ...(record.posted === undefined
      ? {}
      : { posted: parsePosted(record.posted, `${source}.posted`) }),
  };
}

function parsePosted(value: unknown, source: string): PostedReview {
  const record = recordAt(value, source);
  const verdict = textAt(record.verdict, `${source}.verdict`);
  if (!VERDICTS.has(verdict)) throw new TypeError(`${source}.verdict is not a known verdict`);
  return {
    url: stringAt(record.url, `${source}.url`),
    verdict: verdict as ReviewVerdict,
    postedAt: textAt(record.postedAt, `${source}.postedAt`),
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
