import { readHomeSettings } from "../config/home-settings.ts";
import { readMergingSettings } from "../config/repositories.ts";
import type { Clock, CommandRunner, IsoTimestamp, TaskRecord } from "../contracts.ts";
import { repositoryFromRemote } from "../delivery/pull-requests.ts";
import { type PullRequestRef, parsePullRequestRef } from "../pr-review/pull-request.ts";
import { readRegisteredProjects } from "../terminal/projects.ts";
import {
  decidePrWatch,
  type MergingSettings,
  mergingSettings,
  type PrObservation,
  type PrWatchAction,
  type PrWatchDecision,
  type PrWatchFacts,
  type PrWatchLogEntry,
  type PrWatchLookup,
  type PrWatchRow,
} from "./decide.ts";
import {
  editLabels,
  enableAutoMerge,
  GitHubRateLimitError,
  hasAviatorConfig,
  listMyOpenPullRequests,
  mergeBaseIntoBranch,
  pushEmptyCommit,
  readChecksNotPassing,
  readConflictFiles,
  readDequeuer,
  readWatchedPullRequest,
} from "./github.ts";
import {
  type PrWatch,
  type PrWatchNotice,
  type PrWatchPoll,
  type PrWatchSummary,
  sameRef,
  withPrWatches,
} from "./store.ts";
import { type PrWatchView, prWatchView } from "./view.ts";

export type PrWatcherDependencies = Readonly<{
  readonly home: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  /** Every task in this Tandem home; each one's pull request is watched. */
  readonly listTasks: () => Promise<readonly TaskRecord[]>;
  /**
   * Gives a Tandem task a direction; false when this Tandem does not run that task (another
   * project's coordinator does), so a later check tries again.
   */
  readonly steerTask: (taskId: string, text: string) => Promise<boolean>;
}>;

/** Task stages in which a task is still working on what it was last told. */
const WORKING_STAGES: readonly TaskRecord["stage"][] = [
  "awaiting-approval",
  "queued",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
];
/** Task stages that can no longer take a direction. */
const CLOSED_STAGES: readonly TaskRecord["stage"][] = ["cancelled", "merged", "completed"];

/** One check at a time: a Tandem that stops mid-check frees the others after this long. */
const LEASE_MINUTES = 5;
const RATE_LIMIT_BACKOFF_MINUTES = 15;
/** Check every minute while CI runs or the watcher acted this recently, every 5 minutes otherwise. */
const BUSY_MINUTES = 5;
/** How often one process looks at the shared schedule; checks themselves follow the schedule. */
const LOOK_EVERY_MS = 30_000;

type Decided = Extract<PrWatchDecision, { readonly kind: "decided" }>;
type Outcome = Readonly<{ row: PrWatchRow; entry?: PrWatchLogEntry; notice?: PrWatchNotice }>;

/**
 * Keeps watched pull requests moving: reads each one from GitHub on the shared schedule, decides
 * with `decidePrWatch`, applies what it decided, and records it. Any Tandem open on the home runs
 * it from its scheduler tick; the poll lease keeps two from checking at once.
 */
export class PrWatcher {
  readonly #deps: PrWatcherDependencies;
  #nextLookAt = 0;
  #checking: Promise<void> | undefined;

  constructor(deps: PrWatcherDependencies) {
    this.#deps = deps;
  }

  /**
   * A scheduler tick: checks GitHub when a check is due and no other Tandem is checking. A check
   * already running in this process is joined rather than started again.
   */
  tick(): Promise<void> {
    const now = Date.parse(this.#deps.clock());
    if (this.#checking !== undefined) return this.#checking;
    if (now < this.#nextLookAt) return Promise.resolve();
    this.#nextLookAt = now + LOOK_EVERY_MS;
    this.#checking = this.check(false).finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  /** Waits for a check this process started, such as before shutting down. */
  async settle(): Promise<void> {
    await this.#checking?.catch(() => undefined);
  }

  /** The view, after fresh data unless another Tandem is checking right now. */
  async view(): Promise<PrWatchView> {
    await this.check(true);
    return this.storedView();
  }

  /**
   * Watches a pull request the user named; one they stopped is watched again. `repoPath`, a
   * checkout of its repository, is where its `[merging]` settings come from.
   */
  async start(named: NamedPullRequest): Promise<PrWatchView> {
    const now = this.#deps.clock();
    const { ref } = named;
    const repoPath = named.repoPath ?? (await this.projectFor(ref));
    await withPrWatches(this.#deps.home, (transaction) => {
      const existing = transaction.watches.find((watch) => sameRef(watch.ref, ref));
      if (existing === undefined) {
        transaction.put(newWatch(ref, "user", now, repoPath));
      } else if (existing.stoppedAt !== undefined) {
        const { stoppedAt: _stopped, finishedAt: _finished, ...rest } = existing;
        transaction.put({ ...rest, origin: "user", startedAt: now });
      }
    });
    return this.view();
  }

  /** Stops watching; the record stays so neither a task nor `watchAllMyPrs` restarts it. */
  async stop(ref: PullRequestRef): Promise<PrWatchView> {
    const now = this.#deps.clock();
    await withPrWatches(this.#deps.home, (transaction) => {
      const existing = transaction.watches.find((watch) => sameRef(watch.ref, ref));
      transaction.put({ ...(existing ?? newWatch(ref, "user", now)), stoppedAt: now });
    });
    return this.storedView();
  }

  /**
   * Starts fixing the conflicts on a pull request the user said yes to: `startTask` creates and
   * approves the task, which this records as the pull request's task and its fix attempt.
   */
  async fixConflicts(
    ref: PullRequestRef,
    startTask: (pr: PrObservation, files: readonly string[]) => Promise<TaskRecord>,
  ): Promise<TaskRecord> {
    const read = await readWatchedPullRequest(this.#deps.run, ref, { cwd: this.#deps.home });
    if (read.kind === "unreadable")
      throw new Error(`can't read ${ref.repo}#${ref.number}: ${read.reason}`);
    const pr = read.observation;
    if (pr.mergeable !== "CONFLICTING") {
      throw new Error(`${ref.repo}#${ref.number} has no merge conflicts right now`);
    }
    const files = await readConflictFiles(this.#deps.run, ref.repo, pr, this.#deps.home);
    const task = await startTask(pr, files);
    const now = this.#deps.clock();
    await withPrWatches(this.#deps.home, (transaction) => {
      const watch =
        transaction.watches.find((candidate) => sameRef(candidate.ref, ref)) ??
        newWatch(ref, "user", now);
      transaction.put({
        ...watch,
        taskId: task.id,
        log: [
          ...watch.log,
          {
            at: now,
            kind: "fix-conflicts",
            head: pr.head,
            tree: pr.tree,
            base: pr.baseHead,
            files,
          },
        ],
      });
    });
    return task;
  }

  /** Notifications no coordinator has shown yet; taking them means no other Tandem shows them. */
  async takeNotices(): Promise<readonly PrWatchNotice[]> {
    return withPrWatches(this.#deps.home, (transaction) => {
      const notices: PrWatchNotice[] = [];
      for (const watch of transaction.watches) {
        if (watch.notice === undefined) continue;
        const { notice, ...rest } = watch;
        notices.push(notice);
        transaction.put(rest);
      }
      return notices;
    });
  }

  private async storedView(): Promise<PrWatchView> {
    const now = this.#deps.clock();
    return withPrWatches(this.#deps.home, (transaction) =>
      prWatchView(transaction.watches, transaction.poll, now),
    );
  }

  /** Claims the poll, checks every active watch, and records when it did, or GitHub's rate limit. */
  private async check(force: boolean): Promise<void> {
    const { home } = this.#deps;
    const now = this.#deps.clock();
    const [tasks, settings] = await Promise.all([this.#deps.listTasks(), readHomeSettings(home)]);
    const leaseUntil = plusMinutes(now, LEASE_MINUTES);
    const claimed = await withPrWatches(home, (transaction) => {
      const started = taskWatches(tasks, transaction.watches, now);
      for (const watch of started) transaction.put(watch);
      const watches = [...transaction.watches, ...started];
      const allowed = force
        ? pollAllowed(transaction.poll, now)
        : pollDue(transaction.poll, watches, settings.watchAllMyPrs, now);
      if (allowed) transaction.putPoll({ ...transaction.poll, leaseUntil });
      return allowed;
    });
    if (!claimed) return;
    let rateLimitedUntil: IsoTimestamp | undefined;
    try {
      if (settings.watchAllMyPrs) await this.watchMyPullRequests(now);
      for (const watch of await this.activeWatches()) await this.checkWatch(watch, tasks, now);
    } catch (error) {
      if (!(error instanceof GitHubRateLimitError)) throw error;
      rateLimitedUntil = plusMinutes(now, RATE_LIMIT_BACKOFF_MINUTES);
    } finally {
      await withPrWatches(home, (transaction) => {
        // A check that outlived its lease leaves the schedule to whoever claimed it next.
        if (transaction.poll.leaseUntil !== leaseUntil) return;
        transaction.putPoll({
          polledAt: now,
          ...(rateLimitedUntil === undefined ? {} : { rateLimitedUntil }),
        });
      });
    }
  }

  /** Adds the user's new open pull requests; failing to list them never stops the checks. */
  private async watchMyPullRequests(now: IsoTimestamp): Promise<void> {
    let mine: readonly PullRequestRef[];
    try {
      mine = await listMyOpenPullRequests(this.#deps.run, this.#deps.home);
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      return;
    }
    const known = await withPrWatches(this.#deps.home, (transaction) =>
      transaction.watches.map((watch) => watch.ref),
    );
    const added: PrWatch[] = [];
    for (const ref of mine.filter((candidate) => !known.some((seen) => sameRef(seen, candidate)))) {
      added.push(newWatch(ref, "all-my-prs", now, await this.projectFor(ref)));
    }
    await withPrWatches(this.#deps.home, (transaction) => {
      for (const watch of added) {
        if (!transaction.watches.some((existing) => sameRef(existing.ref, watch.ref))) {
          transaction.put(watch);
        }
      }
    });
  }

  /**
   * The Tandem project checked out from this pull request's repository, whose `[merging]`
   * settings then apply; undefined when no project is.
   */
  private async projectFor(ref: PullRequestRef): Promise<string | undefined> {
    for (const project of await readRegisteredProjects(this.#deps.home)) {
      if ((await originRepository(this.#deps.run, project)) === ref.repo) return project;
    }
    return undefined;
  }

  private activeWatches(): Promise<readonly PrWatch[]> {
    return withPrWatches(this.#deps.home, (transaction) => transaction.watches.filter(isActive));
  }

  /** Reads, decides, and acts for one pull request; a failure here only marks its own row. */
  private async checkWatch(
    watch: PrWatch,
    tasks: readonly TaskRecord[],
    now: IsoTimestamp,
  ): Promise<void> {
    let update: (current: PrWatch) => PrWatch;
    try {
      update = await this.observeAndAct(watch, tasks, now);
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const row: PrWatchRow = { color: "red", status: "⚠ error", note: reason };
      update = (current) => ({ ...current, checkedAt: now, ...withRow(current, row) });
    }
    await withPrWatches(this.#deps.home, (transaction) => {
      const current = transaction.watches.find((candidate) => sameRef(candidate.ref, watch.ref));
      if (current !== undefined && isActive(current)) transaction.put(update(current));
    });
  }

  private async observeAndAct(
    watch: PrWatch,
    tasks: readonly TaskRecord[],
    now: IsoTimestamp,
  ): Promise<(current: PrWatch) => PrWatch> {
    const read = await readWatchedPullRequest(this.#deps.run, watch.ref, {
      cwd: this.#deps.home,
      ...(watch.head === undefined
        ? {}
        : { knownTree: { head: watch.head.oid, tree: watch.head.tree } }),
    });
    if (read.kind === "unreadable") {
      return (current) => ({
        ...current,
        checkedAt: now,
        ...withRow(current, unreadable(read.reason)),
      });
    }
    const pr = read.observation;
    const head =
      watch.head?.oid === pr.head ? watch.head : { oid: pr.head, tree: pr.tree, seenAt: now };
    const merging = await this.mergingFor(watch);
    const task = tasks.find((candidate) => candidate.id === watch.taskId);
    const decision = await this.decide(
      {
        observation: pr,
        log: watch.log,
        settings: merging.settings,
        now,
        headSeenAt: head.seenAt,
        ...(task === undefined || CLOSED_STAGES.includes(task.stage)
          ? {}
          : { task: { working: WORKING_STAGES.includes(task.stage) } }),
      },
      watch.ref,
    );
    const outcome =
      decision.action === undefined
        ? { row: decision.row }
        : await this.apply(decision.action, {
            watch,
            pr,
            settings: merging.settings,
            row: decision.row,
            now,
          });
    return (current) => ({
      ...current,
      ...(merging.aviator === undefined ? {} : { aviator: merging.aviator }),
      checkedAt: now,
      head,
      summary: summaryOf(pr),
      log: outcome.entry === undefined ? current.log : [...current.log, outcome.entry],
      ...(outcome.row.color === "done" && current.finishedAt === undefined
        ? { finishedAt: now }
        : {}),
      ...withRow(current, outcome.row, outcome.notice),
    });
  }

  /**
   * The repository's `[merging]` settings, read live from the checkout the watch belongs to. Only
   * without an explicit `mergeWith` does it look for an Aviator config, once per watch.
   */
  private async mergingFor(
    watch: PrWatch,
  ): Promise<Readonly<{ settings: MergingSettings; aviator?: boolean }>> {
    const file =
      watch.repoPath === undefined
        ? undefined
        : await readMergingSettings({ repoPath: watch.repoPath, home: this.#deps.home });
    if (file?.mergeWith !== undefined) return { settings: mergingSettings(file, false) };
    const aviator =
      watch.aviator ?? (await hasAviatorConfig(this.#deps.run, watch.ref.repo, this.#deps.home));
    return { settings: mergingSettings(file, aviator), aviator };
  }

  /** Decides, making each extra GitHub read the decision asks for first. */
  private async decide(facts: PrWatchFacts, ref: PullRequestRef): Promise<Decided> {
    let current = facts;
    for (;;) {
      const decision = decidePrWatch(current);
      if (decision.kind === "decided") return decision;
      current = await this.lookUp(decision.lookup, current, ref);
    }
  }

  private async lookUp(
    lookup: PrWatchLookup,
    facts: PrWatchFacts,
    ref: PullRequestRef,
  ): Promise<PrWatchFacts> {
    switch (lookup) {
      case "base-checks":
        return {
          ...facts,
          baseFailing: await readChecksNotPassing(
            this.#deps.run,
            ref.repo,
            facts.observation.base,
            this.#deps.home,
          ),
        };
      case "dequeued-by":
        return {
          ...facts,
          dequeuedBy: await readDequeuer(this.#deps.run, ref, facts.settings, this.#deps.home),
        };
      case "conflict-files":
        return {
          ...facts,
          conflictFiles: await readConflictFiles(
            this.#deps.run,
            ref.repo,
            facts.observation,
            this.#deps.home,
          ),
        };
    }
  }

  /** Applies one decided action, unless the user stopped watching while GitHub was being read. */
  private async apply(
    action: PrWatchAction,
    context: Readonly<{
      watch: PrWatch;
      pr: PrObservation;
      settings: MergingSettings;
      row: PrWatchRow;
      now: IsoTimestamp;
    }>,
  ): Promise<Outcome> {
    const { pr, row, now, settings } = context;
    const ref = context.watch.ref;
    const { run, home } = this.#deps;
    if (!(await this.stillWatched(ref))) return { row };
    const logged = { at: now, head: pr.head, tree: pr.tree };
    switch (action.kind) {
      case "retry": {
        const pushed = await pushEmptyCommit(this.#deps.run, {
          repository: pr.headRepository,
          branch: pr.branch,
          head: pr.head,
          tree: pr.tree,
          message: `Rerun CI for ${action.checks.join(", ")}\n\nEmpty commit from Tandem PR watch.`,
          cwd: this.#deps.home,
        });
        if (pushed.kind === "moved") {
          return { row: { ...row, note: "🔁 someone pushed; checking the new commit" } };
        }
        return {
          row: { ...row, note: `🔁 retried ${action.checks.join(", ")} (flaky?)` },
          entry: {
            ...logged,
            kind: "retry",
            checks: action.checks,
            pushed: pushed.commit,
            approved: pr.reviewDecision === "APPROVED",
          },
        };
      }
      case "update-branch": {
        const merged = await mergeBaseIntoBranch(run, {
          repository: pr.headRepository,
          branch: pr.branch,
          base: pr.base,
          cwd: home,
        });
        if (merged === undefined) return { row };
        return {
          row,
          entry: {
            ...logged,
            kind: "update-branch",
            checks: [],
            pushed: merged,
            approved: pr.reviewDecision === "APPROVED",
          },
        };
      }
      case "queue":
        await editLabels(run, ref, { add: settings.queueLabel }, home);
        return { row, entry: { ...logged, kind: "queue" } };
      case "auto-merge":
        await enableAutoMerge(run, ref, pr.head, home);
        return { row, entry: { ...logged, kind: "auto-merge" } };
      case "requeue":
        if (settings.mergeWith === "auto-merge") {
          await enableAutoMerge(run, ref, pr.head, home);
        } else {
          await editLabels(
            run,
            ref,
            {
              add: settings.queueLabel,
              ...(settings.blockedLabel !== undefined && pr.labels.includes(settings.blockedLabel)
                ? { remove: settings.blockedLabel }
                : {}),
            },
            home,
          );
        }
        return { row, entry: { ...logged, kind: "requeue" } };
      case "fix-conflicts": {
        const taskId = context.watch.taskId;
        const text = `Pull this branch from origin, merge origin/${pr.base} into it, resolve the conflicts, commit, and push. Never force-push.`;
        if (taskId === undefined || !(await this.#deps.steerTask(taskId, text))) {
          return {
            row: {
              color: "yellow",
              status: "⚔️ conflict",
              note: "⏳ its task gets the conflicts once its project's Tandem is open",
            },
          };
        }
        const entry = { ...logged, kind: action.kind, base: pr.baseHead, files: action.files };
        return { row, entry };
      }
      case "ask-conflicts":
        return {
          row,
          entry: { ...logged, kind: action.kind, base: pr.baseHead, files: action.files },
          notice: {
            pullRequest: `${ref.repo}#${ref.number}`,
            text: `${ref.repo}#${ref.number} has merge conflicts${action.files.length === 0 ? "" : ` in ${action.files.join(", ")}`}. Fix them?`,
            askToFix: true,
          },
        };
    }
  }

  private stillWatched(ref: PullRequestRef): Promise<boolean> {
    return withPrWatches(this.#deps.home, (transaction) =>
      transaction.watches.some((watch) => sameRef(watch.ref, ref) && isActive(watch)),
    );
  }
}

/** A pull request the user named, with the checkout of its repository when they named it from one. */
export type NamedPullRequest = Readonly<{ ref: PullRequestRef; repoPath?: string }>;

/**
 * The pull request a user named: a GitHub link, `owner/repo#N`, or `N` / `#N` in the repository
 * checked out at `repoPath`. The checkout is kept only when it is that pull request's repository.
 */
export async function resolvePullRequest(
  run: CommandRunner,
  text: string,
  repoPath: string | undefined,
): Promise<NamedPullRequest> {
  const origin = repoPath === undefined ? undefined : await originRepository(run, repoPath);
  const number = /^#?(\d+)$/u.exec(text.trim())?.[1];
  const ref =
    parsePullRequestRef(text) ??
    (number === undefined || origin === undefined
      ? undefined
      : { repo: origin, number: Number(number) });
  if (ref === undefined) {
    throw new Error(`"${text}" is not a pull request; use its link, owner/repo#N, or #N here`);
  }
  return { ref, ...(repoPath !== undefined && origin === ref.repo ? { repoPath } : {}) };
}

async function originRepository(run: CommandRunner, repoPath: string): Promise<string | undefined> {
  const result = await run({
    argv: ["git", "-C", repoPath, "remote", "get-url", "origin"],
    cwd: repoPath,
  });
  if (result.code !== 0) return undefined;
  try {
    return repositoryFromRemote(result.stdout).toLowerCase();
  } catch {
    return undefined;
  }
}

/** Checks run when due: every 1 or 5 minutes, never while another Tandem holds the poll. */
export function pollDue(
  poll: PrWatchPoll,
  watches: readonly PrWatch[],
  watchAllMyPrs: boolean,
  now: IsoTimestamp,
): boolean {
  if (!pollAllowed(poll, now)) return false;
  const interval = pollIntervalMinutes(watches, watchAllMyPrs, now);
  if (interval === undefined) return false;
  return poll.polledAt === undefined || minutesBetween(poll.polledAt, now) >= interval;
}

/** Nothing watched means no checks at all; `watchAllMyPrs` still looks for new pull requests. */
export function pollIntervalMinutes(
  watches: readonly PrWatch[],
  watchAllMyPrs: boolean,
  now: IsoTimestamp,
): number | undefined {
  const active = watches.filter(isActive);
  if (active.length === 0 && !watchAllMyPrs) return undefined;
  const busy = active.some(
    (watch) =>
      (watch.summary?.checks.pending ?? 0) > 0 ||
      watch.log.some((entry) => minutesBetween(entry.at, now) < BUSY_MINUTES),
  );
  return busy ? 1 : 5;
}

function pollAllowed(poll: PrWatchPoll, now: IsoTimestamp): boolean {
  const waiting = (until: IsoTimestamp | undefined) =>
    until !== undefined && Date.parse(until) > Date.parse(now);
  return !waiting(poll.leaseUntil) && !waiting(poll.rateLimitedUntil);
}

/** A watch for each task pull request that has none yet. */
function taskWatches(
  tasks: readonly TaskRecord[],
  watches: readonly PrWatch[],
  now: IsoTimestamp,
): readonly PrWatch[] {
  const started: PrWatch[] = [];
  for (const task of tasks) {
    const pullRequest = task.pullRequest;
    if (pullRequest === undefined || task.stage === "cancelled") continue;
    if (pullRequest.state !== "draft" && pullRequest.state !== "open") continue;
    const ref = { repo: pullRequest.repository.toLowerCase(), number: pullRequest.number };
    if ([...watches, ...started].some((watch) => sameRef(watch.ref, ref))) continue;
    const repoPath = task.target?.checkout ?? task.repoPath;
    started.push({ ...newWatch(ref, "task", now, repoPath), taskId: task.id });
  }
  return started;
}

function newWatch(
  ref: PullRequestRef,
  origin: PrWatch["origin"],
  now: IsoTimestamp,
  repoPath?: string,
): PrWatch {
  return { ref, origin, startedAt: now, ...(repoPath === undefined ? {} : { repoPath }), log: [] };
}

function isActive(watch: PrWatch): boolean {
  return watch.stoppedAt === undefined && watch.finishedAt === undefined;
}

/**
 * The new row, and a notification: the one an action raised, or else one when the row just turned
 * red or the pull request just merged.
 */
function withRow(
  current: PrWatch,
  row: PrWatchRow,
  raised?: PrWatchNotice,
): Pick<PrWatch, "row" | "notice" | "redNotified"> {
  const pullRequest = `${current.ref.repo}#${current.ref.number}`;
  const red =
    row.color === "red"
      ? `🔴 ${pullRequest} ${row.status}: ${row.note}${row.link === undefined ? "" : ` → ${row.link}`}`
      : undefined;
  // The same red reason is told once, even when a brief green read (GitHub recomputing
  // mergeability after a push to the base) comes between.
  const turnedRed = red !== undefined && red !== current.redNotified;
  const merged = row.status.startsWith("🎉") && current.row?.color !== "done";
  const text = turnedRed ? red : merged ? `🎉 ${pullRequest} merged` : undefined;
  const notice = raised ?? (text === undefined ? current.notice : { pullRequest, text });
  const redNotified = turnedRed ? red : current.redNotified;
  return {
    row,
    ...(notice === undefined ? {} : { notice }),
    ...(redNotified === undefined ? {} : { redNotified }),
  };
}

/** What a task that fixes someone's conflicts is told to do, starting from their branch. */
export function conflictFixObjective(pr: PrObservation, files: readonly string[]): string {
  return [
    `Resolve the merge conflicts on pull request ${pr.url} (branch ${pr.branch}) with ${pr.base}${files.length === 0 ? "" : `, in ${files.join(", ")}`}.`,
    `Start from the pull request's branch: git fetch origin ${pr.branch} ${pr.base}, then git reset --hard origin/${pr.branch}.`,
    `Merge origin/${pr.base} into it, resolve the conflicts, commit, and push with git push origin HEAD:${pr.branch}. Never force-push.`,
  ].join(" ");
}

/** An unreadable pull request, such as one behind SSO the login has not authorized. */
function unreadable(reason: string): PrWatchRow {
  return { color: "red", status: "⚠ can't read", note: reason };
}

function summaryOf(pr: PrObservation): PrWatchSummary {
  const count = (state: string) => pr.checks.filter((check) => check.state === state).length;
  return {
    title: pr.title,
    branch: pr.branch,
    url: pr.url,
    checks: { passed: count("passed"), failed: count("failed"), pending: count("pending") },
  };
}

function plusMinutes(timestamp: IsoTimestamp, minutes: number): IsoTimestamp {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

function minutesBetween(from: IsoTimestamp, to: IsoTimestamp): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}
