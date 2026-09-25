import type { IsoTimestamp } from "../contracts.ts";
import { clockTime } from "./view.ts";

export type CheckState = "passed" | "failed" | "pending";

export type WatchedCheck = Readonly<{
  readonly name: string;
  readonly state: CheckState;
  /** The CI page for this check, when GitHub has one. */
  readonly url?: string;
  readonly startedAt?: IsoTimestamp;
}>;

/** What GitHub reports about one pull request, read in one `gh pr view`. */
export type PrObservation = Readonly<{
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly title: string;
  readonly url: string;
  readonly branch: string;
  /** The repository the branch lives in; another owner's fork for a PR from a fork. */
  readonly headRepository: string;
  readonly head: string;
  /** The head commit's tree: the version of the code, which an empty commit keeps. */
  readonly tree: string;
  readonly base: string;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub requires the branch to be up to date with its base and it is not. */
  readonly behind: boolean;
  readonly reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "NONE";
  /** Logins and team names asked to review and not yet done. */
  readonly reviewers: readonly string[];
  readonly labels: readonly string[];
  readonly autoMerge: boolean;
  readonly mergedAt?: IsoTimestamp;
  readonly checks: readonly WatchedCheck[];
}>;

/** How a repository merges and how patient the watcher is; see `[merging]` in settings.toml. */
export type MergingSettings = Readonly<{
  readonly mergeWith: "auto-merge" | "queue-label";
  readonly queueLabel: string;
  readonly blockedLabel?: string;
  readonly maxCiRetries: number;
  readonly stuckAfterMinutes: number;
}>;

export const DEFAULT_MERGING_SETTINGS: MergingSettings = {
  mergeWith: "auto-merge",
  queueLabel: "mergequeue",
  maxCiRetries: 1,
  stuckAfterMinutes: 60,
};

/** Something the watcher did to a pull request, kept so it is never repeated beyond its budget. */
export type PrWatchLogEntry = Readonly<{
  readonly at: IsoTimestamp;
  readonly kind: "retry";
  /** The head and tree the watcher acted on. */
  readonly head: string;
  readonly tree: string;
  /** The failed checks an empty commit reran. */
  readonly checks: readonly string[];
  /** The commit the watcher pushed. */
  readonly pushed: string;
  /** Whether the pull request was approved just before the watcher pushed. */
  readonly approved: boolean;
}>;

export type PrWatchAction = Readonly<{
  readonly kind: "retry";
  readonly checks: readonly string[];
}>;

export type PrWatchColor = "red" | "yellow" | "green" | "done";

/** One line of the PR watch view, apart from the number, branch, and checks it always shows. */
export type PrWatchRow = Readonly<{
  /** red needs you, yellow waits on someone else, green is moving, done has merged or closed. */
  readonly color: PrWatchColor;
  readonly status: string;
  readonly note: string;
  /** Where to look, such as the failing check's CI page. */
  readonly link?: string;
}>;

/** An extra GitHub read the decision needs before it can choose. */
export type PrWatchLookup = "base-checks";

export type PrWatchDecision =
  | Readonly<{ readonly kind: "look-up"; readonly lookup: PrWatchLookup }>
  | Readonly<{
      readonly kind: "decided";
      readonly row: PrWatchRow;
      readonly action?: PrWatchAction;
    }>;

export type PrWatchFacts = Readonly<{
  readonly observation: PrObservation;
  readonly log: readonly PrWatchLogEntry[];
  readonly settings: MergingSettings;
  readonly now: IsoTimestamp;
  /** When the watcher first saw this head; a check without a start time counts from here. */
  readonly headSeenAt: IsoTimestamp;
  /** The checks failing on the base branch, once looked up. */
  readonly baseFailing?: ReadonlySet<string>;
}>;

/**
 * What to do about one pull request, from what GitHub reports, what the watcher already did, and
 * the repository's settings. It never acts; the caller applies the action and records it.
 */
export function decidePrWatch(facts: PrWatchFacts): PrWatchDecision {
  const pr = facts.observation;
  if (pr.state === "merged") {
    return decided(row("done", `🎉 merged ${clockTime(pr.mergedAt ?? facts.now)}`, ""));
  }
  if (pr.state === "closed") return decided(row("done", "🚪 closed", ""));
  if (pr.mergeable === "UNKNOWN") {
    return decided(row("green", mergeStatus(pr), "⏳ GitHub is still checking for conflicts"));
  }
  if (pr.mergeable === "CONFLICTING") {
    return decided(row("red", "⚔️ conflict", "🙋 fix the merge conflicts"));
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return decided(row("red", "✋ changes", "🙋 a reviewer asked for changes"));
  }
  return decideChecks(facts) ?? decided(settledRow(facts));
}

/** How many empty commits already reran this check on this version of the code. */
export function retriesUsed(log: readonly PrWatchLogEntry[], tree: string, check: string): number {
  return log.filter(
    (entry) => entry.kind === "retry" && entry.tree === tree && entry.checks.includes(check),
  ).length;
}

/**
 * Running checks wait unless one is stuck. Failed checks wait out a red base branch, then get an
 * empty commit while this version of the code has retries left, and go red when it has none.
 */
function decideChecks(facts: PrWatchFacts): PrWatchDecision | undefined {
  const { observation: pr, settings } = facts;
  const pending = pr.checks.filter((check) => check.state === "pending");
  if (pending.length > 0) {
    const stuck = pending.find(
      (check) =>
        minutesBetween(check.startedAt ?? facts.headSeenAt, facts.now) >=
        settings.stuckAfterMinutes,
    );
    if (stuck === undefined) return undefined;
    return decided(
      row(
        "red",
        "⏰ stuck",
        `🙋 ${stuck.name} has not finished in ${settings.stuckAfterMinutes} min`,
        stuck.url,
      ),
    );
  }
  const failed = pr.checks.filter((check) => check.state === "failed");
  if (failed.length === 0) return undefined;
  if (facts.baseFailing === undefined) return { kind: "look-up", lookup: "base-checks" };
  const baseFailing = facts.baseFailing;
  const own = failed.filter((check) => !baseFailing.has(check.name));
  if (own.length === 0) {
    return decided(
      row(
        "yellow",
        `🧱 ${pr.base} is red`,
        `⏳ ${names(failed)} fails on ${pr.base} too; retrying once it passes`,
      ),
    );
  }
  const spent = own.find(
    (check) => retriesUsed(facts.log, pr.tree, check.name) >= settings.maxCiRetries,
  );
  if (spent !== undefined) {
    const runs = retriesUsed(facts.log, pr.tree, spent.name) + 1;
    return decided(
      row(
        "red",
        "❌ failing",
        `🙋 ${spent.name} failed ${runs === 2 ? "twice" : `${runs} times`}`,
        spent.url,
      ),
    );
  }
  return decided(row("green", mergeStatus(pr), `🔁 retrying ${names(own)}`), {
    kind: "retry",
    checks: own.map((check) => check.name),
  });
}

/** Nothing to do: say what the pull request is waiting on. */
function settledRow(facts: PrWatchFacts): PrWatchRow {
  const pr = facts.observation;
  const running = pr.checks.some((check) => check.state === "pending");
  const retried = facts.log.findLast((entry) => entry.kind === "retry" && entry.pushed === pr.head);
  const note =
    retried !== undefined
      ? `🔁 retried ${retried.checks.join(", ")} (flaky?)`
      : running
        ? "⏳ CI running"
        : "";
  if (pr.draft)
    return row(
      running ? "green" : "yellow",
      "📝 draft",
      note || "⏳ waiting for you to publish it",
    );
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    const waitingOn =
      pr.reviewers.length === 0
        ? "⏳ waiting for a review"
        : `⏳ waiting on ${pr.reviewers.map((reviewer) => `@${reviewer}`).join(", ")}`;
    return row(running ? "green" : "yellow", "👀 review", note || waitingOn);
  }
  return row("green", mergeStatus(pr), note);
}

function mergeStatus(pr: PrObservation): string {
  if (pr.draft) return "📝 draft";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "👀 review";
  return pr.reviewDecision === "APPROVED" ? "✅ approved" : "🟢 open";
}

function decided(rowValue: PrWatchRow, action?: PrWatchAction): PrWatchDecision {
  return { kind: "decided", row: rowValue, ...(action === undefined ? {} : { action }) };
}

function row(color: PrWatchColor, status: string, note: string, link?: string): PrWatchRow {
  return { color, status, note, ...(link === undefined ? {} : { link }) };
}

function names(checks: readonly WatchedCheck[]): string {
  return checks.map((check) => check.name).join(", ");
}

function minutesBetween(from: IsoTimestamp, to: IsoTimestamp): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}
