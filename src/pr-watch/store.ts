import { isRecord } from "../adapters/primitives.ts";
import type { IsoTimestamp } from "../contracts.ts";
import type { PullRequestRef } from "../pr-review/pull-request.ts";
import {
  readMetadataPayload,
  readPrWatchPayloads,
  withStateTransaction,
  writeMetadataPayload,
  writePrWatchPayload,
} from "../runtime/database.ts";
import type { PrWatchLogEntry, PrWatchRow } from "./decide.ts";

/** One watched pull request, kept in `state.sqlite` so any Tandem open on this home picks it up. */
export type PrWatch = Readonly<{
  readonly ref: PullRequestRef;
  /** A Tandem task's pull request, `tandem watch`, or `watchAllMyPrs`. */
  readonly origin: "task" | "user" | "all-my-prs";
  /** The Tandem task whose pull request this is. */
  readonly taskId?: string;
  /** A checkout of its repository, whose settings.toml `[merging]` applies; defaults without one. */
  readonly repoPath?: string;
  /** Whether its repository has an Aviator config, looked up once when settings do not say. */
  readonly aviator?: boolean;
  readonly startedAt: IsoTimestamp;
  /** When the user stopped watching; a stopped pull request is never picked up again on its own. */
  readonly stoppedAt?: IsoTimestamp;
  /** When it merged or closed; the view keeps it for the rest of that day. */
  readonly finishedAt?: IsoTimestamp;
  readonly checkedAt?: IsoTimestamp;
  /** The head last seen, its tree, and when the watcher first saw it. */
  readonly head?: Readonly<{ oid: string; tree: string; seenAt: IsoTimestamp }>;
  /** What the last read found, for the view. */
  readonly summary?: PrWatchSummary;
  readonly row?: PrWatchRow;
  /** What the watcher did, oldest first. */
  readonly log: readonly PrWatchLogEntry[];
  /** A notification no coordinator has shown yet. */
  readonly notice?: PrWatchNotice;
  /** The last red row the user was told about, so the same reason is told once. */
  readonly redNotified?: string;
}>;

/** A pull request turned red or merged, or the watcher asks whether to fix its conflicts. */
export type PrWatchNotice = Readonly<{
  /** `owner/repo#N`, for the coordinator to act on. */
  readonly pullRequest: string;
  readonly text: string;
  /** A yes means start a task that fixes the conflicts (the `pr-watch-fix` action). */
  readonly askToFix?: boolean;
}>;

export type PrWatchSummary = Readonly<{
  readonly title: string;
  readonly branch: string;
  readonly url: string;
  readonly checks: Readonly<{ passed: number; failed: number; pending: number }>;
}>;

/** When GitHub was last read for every watch, who is reading it now, and any rate-limit wait. */
export type PrWatchPoll = Readonly<{
  readonly polledAt?: IsoTimestamp;
  /** Another Tandem is checking until then; the next check waits for it. */
  readonly leaseUntil?: IsoTimestamp;
  readonly rateLimitedUntil?: IsoTimestamp;
}>;

export type PrWatchTransaction = Readonly<{
  readonly watches: readonly PrWatch[];
  readonly poll: PrWatchPoll;
  readonly put: (watch: PrWatch) => void;
  readonly putPoll: (poll: PrWatchPoll) => void;
}>;

const POLL_KEY = "pr_watch_poll";
const SCHEMA_VERSION = 1;

/** Runs `operation` in one state transaction over every watch and the poll schedule. */
export function withPrWatches<Result>(
  home: string,
  operation: (transaction: PrWatchTransaction) => Result,
): Promise<Result> {
  return withStateTransaction(home, (db) => {
    const watches = readPrWatchPayloads(db).map(decodeWatch);
    const poll = readMetadataPayload(db, POLL_KEY);
    return operation({
      watches,
      poll: isRecord(poll) ? decodePoll(poll) : {},
      put: (watch) =>
        writePrWatchPayload(db, watchKey(watch.ref), { schemaVersion: SCHEMA_VERSION, ...watch }),
      putPoll: (next) => writeMetadataPayload(db, POLL_KEY, next),
    });
  });
}

export function watchKey(ref: PullRequestRef): string {
  return `${ref.repo}#${ref.number}`;
}

export function sameRef(left: PullRequestRef, right: PullRequestRef): boolean {
  return left.repo === right.repo && left.number === right.number;
}

/** A record another build wrote in a shape this one does not know fails loudly, never guessed. */
function decodeWatch(value: unknown): PrWatch {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !isRecord(value.ref) ||
    typeof value.ref.repo !== "string" ||
    typeof value.ref.number !== "number" ||
    (value.origin !== "task" && value.origin !== "user" && value.origin !== "all-my-prs") ||
    typeof value.startedAt !== "string" ||
    !Array.isArray(value.log) ||
    !value.log.every((entry) => isRecord(entry) && typeof entry.kind === "string")
  ) {
    throw new Error(`a PR watch record in state.sqlite is malformed: ${JSON.stringify(value)}`);
  }
  const { schemaVersion: _version, ...watch } = value;
  return watch as PrWatch;
}

function decodePoll(value: Readonly<Record<string, unknown>>): PrWatchPoll {
  const time = (field: string): Partial<Record<string, IsoTimestamp>> =>
    typeof value[field] === "string" ? { [field]: value[field] } : {};
  return { ...time("polledAt"), ...time("leaseUntil"), ...time("rateLimitedUntil") };
}
