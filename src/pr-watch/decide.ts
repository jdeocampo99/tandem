import type { MergingSettingsFile } from "../config/repositories.ts";
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
  readonly fork: boolean;
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

/** Something the watcher did to a pull request, kept so it is never repeated beyond its budget. */
export type PrWatchLogEntry = Readonly<{
  readonly at: IsoTimestamp;
  /** The head and tree the watcher acted on. */
  readonly head: string;
  readonly tree: string;
}> &
  (
    | Readonly<{
        readonly kind: "retry" | "update-branch";
        /** The failed checks an empty commit reran; none for a branch update. */
        readonly checks: readonly string[];
        /** The commit the watcher pushed. */
        readonly pushed: string;
        /** Whether the pull request was approved just before the watcher pushed. */
        readonly approved: boolean;
      }>
    /** Put it in the queue or armed auto-merge; `requeue` does either again after a dequeue. */
    | Readonly<{ readonly kind: "queue" | "auto-merge" | "requeue" }>
  );

export type PrWatchAction =
  | Readonly<{ readonly kind: "retry"; readonly checks: readonly string[] }>
  | Readonly<{ readonly kind: "update-branch" | "queue" | "auto-merge" | "requeue" }>;

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
export type PrWatchLookup = "base-checks" | "dequeued-by";

/** Who last took the pull request out of the queue or turned auto-merge off; null when unknown. */
export type Dequeuer = Readonly<{ readonly login: string; readonly bot: boolean }> | null;

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
  /** Who dequeued it, once looked up. */
  readonly dequeuedBy?: Dequeuer;
}>;

const DEFAULT_RETRIES = { maxCiRetries: 1, stuckAfterMinutes: 60 } as const;
const AVIATOR_QUEUE = { queueLabel: "mergequeue", blockedLabel: "blocked" } as const;

/**
 * The repository's settings over the defaults: GitHub auto-merge, or the Aviator queue labels
 * when the repository has an Aviator config and its settings do not say otherwise.
 */
export function mergingSettings(
  file: MergingSettingsFile | undefined,
  aviator: boolean,
): MergingSettings {
  const mergeWith = file?.mergeWith ?? (aviator ? "queue-label" : "auto-merge");
  const blockedLabel = file?.blockedLabel ?? (aviator ? AVIATOR_QUEUE.blockedLabel : undefined);
  return {
    mergeWith,
    queueLabel: file?.queueLabel ?? AVIATOR_QUEUE.queueLabel,
    ...(blockedLabel === undefined ? {} : { blockedLabel }),
    maxCiRetries: file?.maxCiRetries ?? DEFAULT_RETRIES.maxCiRetries,
    stuckAfterMinutes: file?.stuckAfterMinutes ?? DEFAULT_RETRIES.stuckAfterMinutes,
  };
}

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
    return decided(row("green", mergeStatus(facts), "⏳ GitHub is still checking for conflicts"));
  }
  if (pr.mergeable === "CONFLICTING") {
    return decided(row("red", "⚔️ conflict", "🙋 fix the merge conflicts"));
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return decided(row("red", "✋ changes", "🙋 a reviewer asked for changes"));
  }
  if (approvalLost(facts)) {
    return decided(row("red", "✋ approval", "🙋 the watcher's push dismissed the approval"));
  }
  const checks = decideChecks(facts);
  if (checks !== undefined) return checks;
  if (pr.draft) return decided(settledRow(facts));
  const arm = decideArming(facts);
  if (arm !== undefined) return arm;
  if (pr.checks.some((check) => check.state === "pending")) return decided(settledRow(facts));
  return decideMerging(facts) ?? decided(settledRow(facts));
}

/** How many empty commits already reran this check on this version of the code. */
export function retriesUsed(log: readonly PrWatchLogEntry[], tree: string, check: string): number {
  return log.filter(
    (entry) => entry.kind === "retry" && entry.tree === tree && entry.checks.includes(check),
  ).length;
}

/**
 * A stuck check goes red. Failed checks wait out a red base branch, then get an empty commit while
 * this version of the code has retries left, and go red when it has none.
 */
function decideChecks(facts: PrWatchFacts): PrWatchDecision | undefined {
  const { observation: pr, settings } = facts;
  const stuck = pr.checks.find(
    (check) =>
      check.state === "pending" &&
      minutesBetween(check.startedAt ?? facts.headSeenAt, facts.now) >= settings.stuckAfterMinutes,
  );
  if (stuck !== undefined) {
    return decided(
      row(
        "red",
        "⏰ stuck",
        `🙋 ${stuck.name} has not finished in ${settings.stuckAfterMinutes} min`,
        stuck.url,
      ),
    );
  }
  if (pr.checks.some((check) => check.state === "pending")) return undefined;
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
  return decided(row("green", mergeStatus(facts), `🔁 retrying ${names(own)}`), {
    kind: "retry",
    checks: own.map((check) => check.name),
  });
}

/** A published pull request the watcher never put up for merging gets armed once. */
function decideArming(facts: PrWatchFacts): PrWatchDecision | undefined {
  const { settings } = facts;
  if (armed(facts.log) || inQueue(facts) || blocked(facts)) return undefined;
  return settings.mergeWith === "queue-label"
    ? decided(row("green", "🚂 queued", `🚂 added ${settings.queueLabel}`), { kind: "queue" })
    : decided(row("green", "🤖 auto-merge", "🤖 turned on auto-merge"), { kind: "auto-merge" });
}

/**
 * With checks green: bring the branch up to date when GitHub requires it, and put a pull request
 * the queue kicked out back in, once per head commit. A person who took it out is left alone.
 */
function decideMerging(facts: PrWatchFacts): PrWatchDecision | undefined {
  const pr = facts.observation;
  if (pr.behind && !pr.fork && !actedOnHead(facts, "update-branch")) {
    return decided(row("green", mergeStatus(facts), `🔄 updating from ${pr.base}`), {
      kind: "update-branch",
    });
  }
  if (!dequeued(facts)) return undefined;
  if (facts.dequeuedBy === undefined) return { kind: "look-up", lookup: "dequeued-by" };
  if (facts.dequeuedBy?.bot === false) {
    const what =
      facts.settings.mergeWith === "queue-label"
        ? "took it out of the queue"
        : "turned auto-merge off";
    return decided(
      row("yellow", mergeStatus(facts), `✋ @${facts.dequeuedBy.login} ${what}; leaving it`),
    );
  }
  if (actedOnHead(facts, "requeue")) {
    return decided(row("red", "⛔ blocked", "🙋 the queue took it out again after a requeue"));
  }
  return decided(row("green", mergeStatus(facts), "🚂 requeued after the queue took it out"), {
    kind: "requeue",
  });
}

/** Nothing to do: say what the pull request is waiting on. */
function settledRow(facts: PrWatchFacts): PrWatchRow {
  const pr = facts.observation;
  const running = pr.checks.some((check) => check.state === "pending");
  const retried = facts.log.findLast((entry) => entry.kind === "retry" && entry.pushed === pr.head);
  const reviewNote =
    pr.reviewers.length === 0
      ? "⏳ waiting for a review"
      : `⏳ waiting on ${pr.reviewers.map((reviewer) => `@${reviewer}`).join(", ")}`;
  const waiting = pr.draft
    ? "⏳ waiting for you to publish it"
    : pr.reviewDecision === "REVIEW_REQUIRED"
      ? reviewNote
      : undefined;
  const note =
    retried?.kind === "retry"
      ? `🔁 retried ${retried.checks.join(", ")} (flaky?)`
      : running
        ? "⏳ CI running"
        : (waiting ?? "");
  return row(running || waiting === undefined ? "green" : "yellow", mergeStatus(facts), note);
}

function mergeStatus(facts: PrWatchFacts): string {
  const pr = facts.observation;
  if (pr.draft) return "📝 draft";
  if (blocked(facts)) return "⛔ blocked";
  if (inQueue(facts))
    return facts.settings.mergeWith === "queue-label" ? "🚂 queued" : "🤖 auto-merge";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "👀 review";
  return pr.reviewDecision === "APPROVED" ? "✅ approved" : "🟢 open";
}

/** The watcher's own push left the head it pushed, and the approval that was there is gone. */
function approvalLost(facts: PrWatchFacts): boolean {
  const pr = facts.observation;
  const pushed = facts.log.findLast(
    (entry) =>
      (entry.kind === "retry" || entry.kind === "update-branch") && entry.pushed === pr.head,
  );
  return (
    pushed !== undefined &&
    (pushed.kind === "retry" || pushed.kind === "update-branch") &&
    pushed.approved &&
    pr.reviewDecision !== "APPROVED"
  );
}

function armed(log: readonly PrWatchLogEntry[]): boolean {
  return log.some(
    (entry) => entry.kind === "queue" || entry.kind === "auto-merge" || entry.kind === "requeue",
  );
}

function inQueue(facts: PrWatchFacts): boolean {
  const { observation: pr, settings } = facts;
  return settings.mergeWith === "queue-label"
    ? pr.labels.includes(settings.queueLabel)
    : pr.autoMerge;
}

function blocked(facts: PrWatchFacts): boolean {
  const { blockedLabel } = facts.settings;
  return (
    facts.settings.mergeWith === "queue-label" &&
    blockedLabel !== undefined &&
    facts.observation.labels.includes(blockedLabel)
  );
}

/** The queue kicked it out, or it left the queue or auto-merge after the watcher put it there. */
function dequeued(facts: PrWatchFacts): boolean {
  return blocked(facts) || (armed(facts.log) && !inQueue(facts));
}

function actedOnHead(facts: PrWatchFacts, kind: PrWatchLogEntry["kind"]): boolean {
  return facts.log.some((entry) => entry.kind === kind && entry.head === facts.observation.head);
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
