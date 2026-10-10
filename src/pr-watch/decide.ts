import type { MergeWith, MergingSettingsFile } from "../config/repositories.ts";
import type { IsoTimestamp } from "../contracts.ts";
import { clockTime } from "./view.ts";

type CheckState = "passed" | "failed" | "pending";

export type WatchedCheck = Readonly<{
  readonly name: string;
  readonly state: CheckState;
  /** Branch protection requires it; only required checks drive what the watcher does. */
  readonly required: boolean;
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
  /** The base branch's commit, which a conflict fix attempt is recorded against. */
  readonly baseHead: string;
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
  /** `not-set-up` until the user answers; neither it nor `off` ever arms merging. */
  readonly mergeWith: MergeWith | "not-set-up";
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
    /**
     * Put it in the queue or armed auto-merge; `requeue` does either again after a dequeue.
     * `offer-merging` asked the user how the repository merges.
     */
    | Readonly<{ readonly kind: "queue" | "auto-merge" | "requeue" | "offer-merging" }>
    /** Sent a task to fix the conflicts, or asked the user whether to; once per base commit. */
    | Readonly<{
        readonly kind: "fix-conflicts" | "ask-conflicts";
        readonly base: string;
        readonly files: readonly string[];
      }>
  );

export type PrWatchAction =
  | Readonly<{ readonly kind: "retry"; readonly checks: readonly string[] }>
  | Readonly<{
      readonly kind: "update-branch" | "queue" | "auto-merge" | "requeue" | "offer-merging";
    }>
  | Readonly<{
      readonly kind: "fix-conflicts" | "ask-conflicts";
      readonly files: readonly string[];
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
export type PrWatchLookup = "base-checks" | "dequeued-by" | "conflict-files";

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
  /** The checks failing or still running on the base branch, once looked up. */
  readonly baseFailing?: ReadonlySet<string>;
  /** Who dequeued it, once looked up. */
  readonly dequeuedBy?: Dequeuer;
  /** Files both the pull request and its base changed, once looked up. */
  readonly conflictFiles?: readonly string[];
  /** The Tandem task this pull request belongs to, when it can still take directions. */
  readonly task?: Readonly<{ readonly working: boolean }>;
  /** When the user last asked for this pull request to be watched; a declined fix counts from here. */
  readonly watchedSince: IsoTimestamp;
  /** A Tandem project for this repository exists, so an answer about merging can be saved. */
  readonly canSaveMerging: boolean;
}>;

const DEFAULT_RETRIES = { maxCiRetries: 1, stuckAfterMinutes: 60 } as const;
/** A head with no checks yet counts as CI starting for this long, so nothing acts before it does. */
const CI_START_MINUTES = 5;
const DEFAULT_QUEUE_LABEL = "mergequeue";

/**
 * The repository's settings over the defaults. Merging stays off until the user chose how the
 * repository merges; retries and the stuck limit have defaults.
 */
export function mergingSettings(file: MergingSettingsFile | undefined): MergingSettings {
  return {
    mergeWith: file?.mergeWith ?? "not-set-up",
    queueLabel: file?.queueLabel ?? DEFAULT_QUEUE_LABEL,
    ...(file?.blockedLabel === undefined ? {} : { blockedLabel: file.blockedLabel }),
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
  if (pr.mergeable === "CONFLICTING") return decideConflicts(facts);
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
  if (ciRunning(facts)) return decided(settledRow(facts));
  return decideMerging(facts) ?? decided(settledRow(facts));
}

/**
 * One fix attempt per pull request: a Tandem task's pull request steers the task; anyone else's
 * asks the user first, since a fix pushes to a branch they may have local commits on. Still
 * conflicting once that attempt is over, or declined, is red. A declined question is not asked
 * again until the user watches the pull request again; a fix attempt stands until someone pushes
 * and the base moves on too, so a new episode of conflicts gets a new attempt.
 */
function decideConflicts(facts: PrWatchFacts): PrWatchDecision {
  const pr = facts.observation;
  if (facts.conflictFiles === undefined) return { kind: "look-up", lookup: "conflict-files" };
  const files = fileList(facts.conflictFiles);
  // A fix pushes to origin, which is not where a fork's branch lives.
  if (pr.fork) return decided(row("red", "⚔️ conflict", `🙋 fix conflicts in ${files}`));
  const fix = facts.log.findLast((entry) => entry.kind === "fix-conflicts");
  if (fix?.kind === "fix-conflicts" && (fix.head === pr.head || fix.base === pr.baseHead)) {
    return facts.task?.working === true
      ? decided(row("green", "🔀 conflict", `🔀 resolving conflicts in ${files}`))
      : decided(row("red", "⚔️ conflict", `🙋 conflicts in ${files} are still there after a fix`));
  }
  if (facts.task !== undefined) {
    return decided(row("green", "🔀 conflict", `🔀 resolving conflicts in ${files}`), {
      kind: "fix-conflicts",
      files: facts.conflictFiles,
    });
  }
  const ask = row("red", "⚔️ conflict", `🙋 fix conflicts in ${files}?`);
  const asked = facts.log.some(
    (entry) =>
      entry.kind === "ask-conflicts" && Date.parse(entry.at) >= Date.parse(facts.watchedSince),
  );
  if (asked) return decided(ask);
  return decided(ask, { kind: "ask-conflicts", files: facts.conflictFiles });
}

/** How many empty commits already reran this check on this version of the code. */
function retriesUsed(log: readonly PrWatchLogEntry[], tree: string, check: string): number {
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
  const checks = gatingChecks(pr);
  const stuck = checks.find(
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
  if (checks.some((check) => check.state === "pending")) return undefined;
  const failed = checks.filter((check) => check.state === "failed");
  if (failed.length === 0) return undefined;
  if (facts.baseFailing === undefined) return { kind: "look-up", lookup: "base-checks" };
  const baseFailing = facts.baseFailing;
  const own = failed.filter((check) => !baseFailing.has(check.name));
  if (own.length === 0) {
    return decided(
      row(
        "yellow",
        `🧱 ${pr.base} is red`,
        `⏳ ${names(failed)} isn't passing on ${pr.base} either; retrying once it does`,
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
  if (pr.fork) {
    return decided(row("red", "❌ failing", `🙋 ${names(own)} failed; a fork's CI is rerun there`));
  }
  // Tandem still pushes the task's own commits to its draft, which an extra commit would block.
  if (pr.draft && facts.task !== undefined) {
    return decided(
      row("yellow", "📝 draft", `⏳ ${names(own)} failed; rerunning once it's published`),
    );
  }
  return decided(row("green", mergeStatus(facts), `🔁 retrying ${names(own)}`), {
    kind: "retry",
    checks: own.map((check) => check.name),
  });
}

/**
 * A published pull request the watcher never put up for merging gets armed once, unless a person
 * already took it out of the queue or turned auto-merge off.
 */
function decideArming(facts: PrWatchFacts): PrWatchDecision | undefined {
  const { settings } = facts;
  if (!merges(settings)) return decideMergingOffer(facts);
  if (armed(facts.log) || inQueue(facts) || blocked(facts)) return undefined;
  if (facts.dequeuedBy === undefined) return { kind: "look-up", lookup: "dequeued-by" };
  if (facts.dequeuedBy !== null && !facts.dequeuedBy.bot) return undefined;
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
  if (!merges(facts.settings)) return undefined;
  if (pr.behind && !pr.fork && !actedOnHead(facts, "update-branch")) {
    return decided(row("green", mergeStatus(facts), `🔄 updating from ${pr.base}`), {
      kind: "update-branch",
    });
  }
  if (!dequeued(facts)) return undefined;
  if (facts.dequeuedBy === undefined) return { kind: "look-up", lookup: "dequeued-by" };
  // Someone other than the queue, or no one GitHub names, took it out: leave it to them.
  if (facts.dequeuedBy === null || !facts.dequeuedBy.bot) {
    const what =
      facts.settings.mergeWith === "queue-label"
        ? "took it out of the queue"
        : "turned auto-merge off";
    const who = facts.dequeuedBy === null ? "someone" : `@${facts.dequeuedBy.login}`;
    return decided(row("yellow", mergeStatus(facts), `✋ ${who} ${what}; leaving it`));
  }
  if (actedOnHead(facts, "requeue")) {
    return decided(row("red", "⛔ blocked", "🙋 the queue took it out again after a requeue"));
  }
  return decided(row("green", mergeStatus(facts), "🚂 requeued after the queue took it out"), {
    kind: "requeue",
  });
}

/**
 * A published pull request in a repository whose merging is not set up asks the user once how it
 * merges, when there is a project to save the answer into.
 */
function decideMergingOffer(facts: PrWatchFacts): PrWatchDecision | undefined {
  const offered = facts.log.some((entry) => entry.kind === "offer-merging");
  if (facts.settings.mergeWith !== "not-set-up" || !facts.canSaveMerging || offered) {
    return undefined;
  }
  return decided(row("green", mergeStatus(facts), "🙋 set up merging for this repo?"), {
    kind: "offer-merging",
  });
}

/** Whether the user chose a way to merge this repository's pull requests. */
function merges(settings: MergingSettings): boolean {
  return settings.mergeWith === "auto-merge" || settings.mergeWith === "queue-label";
}

/** Nothing to do: say what the pull request is waiting on. */
function settledRow(facts: PrWatchFacts): PrWatchRow {
  const pr = facts.observation;
  const running = ciRunning(facts);
  const recent = facts.log.findLast(
    (entry) =>
      (entry.kind === "retry" && entry.pushed === pr.head) ||
      (entry.kind === "fix-conflicts" && entry.head !== pr.head),
  );
  const reviewNote =
    pr.reviewers.length === 0
      ? "⏳ waiting for a review"
      : `⏳ waiting on ${pr.reviewers.map((reviewer) => `@${reviewer}`).join(", ")}`;
  const waiting = pr.draft
    ? "⏳ waiting for you to publish it"
    : pr.reviewDecision === "REVIEW_REQUIRED"
      ? reviewNote
      : facts.settings.mergeWith === "not-set-up"
        ? "merging isn't set up for this repo"
        : facts.settings.mergeWith === "off"
          ? "merging is off for this repo"
          : undefined;
  const note =
    recent?.kind === "retry"
      ? `🔁 retried ${recent.checks.join(", ")} (flaky?)`
      : recent?.kind === "fix-conflicts"
        ? `🔀 resolved conflicts in ${fileList(recent.files)}${running ? " · CI running" : ""}`
        : running
          ? pr.checks.length === 0
            ? "⏳ waiting for CI to start"
            : "⏳ CI running"
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

/**
 * The checks that decide what the watcher does: the required ones, or every check when the
 * repository requires none. Optional checks still show in the view.
 */
function gatingChecks(pr: PrObservation): readonly WatchedCheck[] {
  const required = pr.checks.filter((check) => check.required);
  return required.length === 0 ? pr.checks : required;
}

/** Checks are running, or none have shown up yet on a head seen only moments ago. */
function ciRunning(facts: PrWatchFacts): boolean {
  const checks = gatingChecks(facts.observation);
  return (
    checks.some((check) => check.state === "pending") ||
    (checks.length === 0 && minutesBetween(facts.headSeenAt, facts.now) < CI_START_MINUTES)
  );
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

/** A few file names, or how many when there are more than three. */
function fileList(files: readonly string[]): string {
  if (files.length === 0) return "its files";
  return files.length <= 3 ? files.join(", ") : `${files.length} files`;
}

function names(checks: readonly WatchedCheck[]): string {
  return checks.map((check) => check.name).join(", ");
}

function minutesBetween(from: IsoTimestamp, to: IsoTimestamp): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}
