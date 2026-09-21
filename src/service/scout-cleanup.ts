import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../adapters/commands.ts";
import { closeEndpoint, inspectEndpoint } from "../adapters/herdr.ts";
import {
  AdapterProtocolError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../adapters/primitives.ts";
import { releaseWorktree } from "../adapters/treehouse.ts";
import type {
  Clock,
  CommandRunner,
  Endpoint,
  TaskCleanupState,
  TaskCleanupStatus,
  TaskRecord,
  WorktreeLease,
} from "../contracts.ts";
import { activeRuntimeJob, taskRuntime, unreleasedReservation } from "../runtime/activity.ts";
import { withStateLock } from "../runtime/database.ts";
import {
  defaultIdFactory,
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type { RuntimeState, RuntimeTaskState } from "../runtime/schema.ts";
import { createTaskStore, type TaskStore } from "../tasks/store.ts";
import {
  absoluteDirectory,
  describeError,
  isMissing,
  isMissingEndpoint,
  isTerminalTask,
  replaceRuntimeTask,
} from "./records.ts";
import { taskSourcePath } from "./source.ts";

/** What one cleanup attempt settled on, including the attempts that deliberately changed nothing. */
export type TaskCleanupOutcome = Readonly<{
  readonly taskId: string;
  /** `deferred` means nothing was inspected or written, so a later pass can try again unchanged. */
  readonly status: TaskCleanupStatus | "deferred";
  readonly reason: string;
}>;

/** Everything a cleanup attempt needs from its host, so a service and a command can share it. */
export type TaskCleanupDependencies = Readonly<{
  readonly home: string;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
}>;
export type TerminalTaskCleanupOptions = Readonly<{
  /** Discard is reserved for explicitly approved cancelled or blocked implementation tasks. */
  readonly discard?: boolean;
}>;

/** The scout checkout as it was observed, without interpreting it. */
export type ScoutCheckoutObservation =
  | Readonly<{
      readonly status: "observed";
      readonly head: string;
      readonly branch: string;
      readonly dirty: boolean;
      readonly unmerged: boolean;
    }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{ readonly status: "unreadable"; readonly detail: string }>;

/** Whether a task's durable stage allows its child pane and worktree to be released at all. */
export type ScoutCleanupEligibility =
  | Readonly<{ readonly kind: "eligible" }>
  | Readonly<{ readonly kind: "retained"; readonly reason: string }>;

/** What may happen to one scout's exact worktree lease. */
export type ScoutWorktreeDecision =
  | Readonly<{ readonly kind: "release"; readonly reason: string }>
  | Readonly<{ readonly kind: "retain"; readonly reason: string }>
  | Readonly<{ readonly kind: "quarantine"; readonly reason: string }>;

/**
 * Decides from the durable task record alone whether a scout's child resources may be released.
 *
 * Blocked, paused, and decision-waiting scouts keep everything: their pane and checkout are the
 * evidence a coordinator needs to answer them. Only a settled scout with the report already
 * written, or one that was cancelled, is eligible.
 */
export function decideScoutCleanupEligibility(
  task: Pick<TaskRecord, "kind" | "stage" | "reportPath" | "communication">,
): ScoutCleanupEligibility {
  if (task.kind !== "scout") {
    return { kind: "retained", reason: "task is not a scout" };
  }
  if (task.stage === "cancelled") {
    return { kind: "eligible" };
  }
  if (task.stage === "blocked") {
    return {
      kind: "retained",
      reason: "a blocked scout keeps its pane and worktree for inspection",
    };
  }
  if (task.stage === "paused") {
    return {
      kind: "retained",
      reason: "a paused scout keeps its pane and worktree until it resumes",
    };
  }
  if (task.communication?.question !== undefined) {
    return { kind: "retained", reason: "the scout is waiting on a coordinator decision" };
  }
  if (task.stage !== "completed") {
    return { kind: "retained", reason: `scout is ${task.stage}, which is not a settled stage` };
  }
  if (task.reportPath === undefined) {
    return { kind: "retained", reason: "the completed scout has no durable report" };
  }
  return { kind: "eligible" };
}

/**
 * Decides what a settled scout's exact worktree lease may be used for.
 *
 * A scout is only ever supposed to read, so its checkout must still be the pinned source commit on
 * its own lease branch. Any difference at all, an untracked file included, is somebody's work and
 * is retained and reported. A checkout that cannot be read, or that sits on a branch the lease does
 * not name, is ownership Tandem cannot prove and is quarantined rather than guessed at.
 */
export function decideScoutWorktreeRelease(
  input: Readonly<{ readonly lease: WorktreeLease; readonly checkout: ScoutCheckoutObservation }>,
): ScoutWorktreeDecision {
  const { lease, checkout } = input;
  if (checkout.status === "unreadable") {
    return {
      kind: "quarantine",
      reason: `scout checkout could not be read: ${checkout.detail}`,
    };
  }
  if (checkout.status === "missing") {
    return { kind: "release", reason: "the scout checkout is no longer present" };
  }
  if (checkout.dirty) {
    return { kind: "retain", reason: "the scout worktree has uncommitted or untracked changes" };
  }
  if (checkout.unmerged) {
    return { kind: "retain", reason: "the scout worktree has unmerged paths" };
  }
  if (checkout.branch !== lease.branch) {
    return {
      kind: "quarantine",
      reason: `the scout worktree is on branch ${JSON.stringify(checkout.branch)} instead of its lease branch ${JSON.stringify(lease.branch)}`,
    };
  }
  if (checkout.head !== lease.baseHead) {
    return {
      kind: "retain",
      reason: `the scout worktree HEAD ${checkout.head} differs from its source commit ${lease.baseHead}`,
    };
  }
  return { kind: "release", reason: "the scout worktree is clean and still on its source commit" };
}

/**
 * Sorts a cleanup failure into one that reconciliation may retry and one that must not be retried.
 *
 * A refused pane identity or changed lease metadata means Tandem no longer knows who owns the
 * resource, which AGENTS.md requires be quarantined with the resource kept. Everything else is a
 * transient failure the next tick can attempt again.
 */
export function classifyCleanupFailure(error: unknown): "pending" | "quarantined" {
  if (error instanceof EndpointOwnershipError || error instanceof AdapterProtocolError) {
    return "quarantined";
  }
  if (error instanceof Error && error.cause !== undefined) {
    return classifyCleanupFailure(error.cause);
  }
  return "pending";
}

/** Reads a scout worktree's identity and cleanliness without judging or changing it. */
export async function observeScoutCheckout(
  run: CommandRunner,
  worktreePath: string,
): Promise<ScoutCheckoutObservation> {
  try {
    const details = await lstat(worktreePath);
    if (!details.isDirectory()) {
      return { status: "unreadable", detail: "the recorded lease path is not a directory" };
    }
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    return { status: "unreadable", detail: describeError(error) };
  }
  try {
    const head = await gitText(run, worktreePath, ["rev-parse", "HEAD"], "git scout HEAD");
    const branch = await gitText(
      run,
      worktreePath,
      ["branch", "--show-current"],
      "git scout branch",
    );
    const status = await gitText(
      run,
      worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "git scout status",
    );
    const unmerged = await gitText(
      run,
      worktreePath,
      ["diff", "--name-only", "--diff-filter=U"],
      "git scout unmerged check",
    );
    if (head.length === 0) {
      return { status: "unreadable", detail: "git reported no HEAD commit" };
    }
    return {
      status: "observed",
      head,
      branch,
      dirty: status.length !== 0,
      unmerged: unmerged.length !== 0,
    };
  } catch (error) {
    return { status: "unreadable", detail: describeError(error) };
  }
}

async function gitText(
  run: CommandRunner,
  worktreePath: string,
  args: readonly string[],
  operation: string,
): Promise<string> {
  const result = await run({ argv: ["git", "-C", worktreePath, ...args], cwd: worktreePath });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${operation} failed with exit code ${result.code}${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout.trim();
}

type PaneClosureFailure = Readonly<{
  readonly status: "pending" | "quarantined" | "deferred";
  readonly reason: string;
}>;

type PaneClosureProgress = Readonly<{
  readonly closedPaneIds: readonly string[];
  readonly failure: PaneClosureFailure | undefined;
}>;

/**
 * Closes each owned endpoint after proving the pane is the one Tandem opened and that no worker is
 * still running in it. An endpoint that is already gone counts as closed.
 */
async function closeOwnedPanes(
  run: CommandRunner,
  endpoints: readonly Endpoint[],
  cwd: string,
): Promise<PaneClosureProgress> {
  const closedPaneIds: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const inspection = await inspectEndpoint(run, { endpoint, cwd });
      if (inspection.activeWorker) {
        return {
          closedPaneIds,
          failure: {
            status: "deferred",
            reason: `pane ${endpoint.paneId} still has an active worker`,
          },
        };
      }
      await closeEndpoint(run, { endpoint, cwd });
    } catch (error) {
      if (isMissingEndpoint(error)) {
        closedPaneIds.push(endpoint.paneId);
        continue;
      }
      if (error instanceof EndpointBusyError) {
        return {
          closedPaneIds,
          failure: {
            status: "deferred",
            reason: `pane ${endpoint.paneId} became busy while closing`,
          },
        };
      }
      return {
        closedPaneIds,
        failure: {
          status: classifyCleanupFailure(error),
          reason: `pane ${endpoint.paneId} could not be closed: ${describeError(error)}`,
        },
      };
    }
    closedPaneIds.push(endpoint.paneId);
  }
  return { closedPaneIds, failure: undefined };
}

type CleanupAttempt = Readonly<{
  readonly closedPaneIds: readonly string[];
  readonly leaseReleased: boolean;
  readonly status: TaskCleanupStatus;
  readonly reason: string;
}>;

/**
 * Applies one attempt to the runtime record. A released task drops the transient scheduling state
 * along with its lease; every other outcome keeps the resources exactly as they are and only
 * reports why, so nothing Tandem refused to release loses its durable owner.
 */
function settledRuntimeTask(
  current: RuntimeTaskState,
  input: Readonly<{
    readonly attempt: CleanupAttempt;
    readonly terminalRevision: number | undefined;
    readonly now: string;
  }>,
): RuntimeTaskState {
  const { attempt, terminalRevision, now } = input;
  const closedPaneIds = new Set(attempt.closedPaneIds);
  const endpoints = current.endpoints.filter((endpoint) => !closedPaneIds.has(endpoint.paneId));
  const stamped =
    terminalRevision === undefined ? {} : { terminalCleanupRevision: terminalRevision };
  if (attempt.status !== "released") {
    return { ...current, endpoints, lastError: attempt.reason, ...stamped };
  }
  const {
    endpointLaunch: _endpointLaunch,
    stopRequest: _stopRequest,
    lastError: _lastError,
    poolAdmissionKey: _poolAdmissionKey,
    poolNotice: _poolNotice,
    worktree,
    ...withoutTransientState
  } = current;
  return {
    ...withoutTransientState,
    ...(attempt.leaseReleased || worktree === undefined ? {} : { worktree }),
    ...(current.reservation === undefined
      ? {}
      : { reservation: { ...current.reservation, phase: "released", releasedAt: now } }),
    endpoints,
    ...stamped,
  };
}

/**
 * Records one cleanup attempt: the panes it closed, the lease it did or did not return, and the
 * durable note saying why. Only a settled outcome stamps `terminalCleanupRevision`, so a `pending`
 * attempt stays eligible for the next reconciliation pass.
 */
async function recordCleanupAttempt(
  deps: TaskCleanupDependencies,
  task: TaskRecord,
  attempt: CleanupAttempt,
): Promise<TaskCleanupOutcome> {
  const now = deps.clock();
  const cleanup: TaskCleanupState = {
    schemaVersion: 1,
    status: attempt.status,
    reason: attempt.reason,
    observedAt: now,
  };
  const closedPaneIds = new Set(attempt.closedPaneIds);
  await deps.store.exclusive(async (store) => {
    const updated = await store.update(task.id, task.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      endpoints: (current.endpoints ?? []).filter(
        (endpoint) => !closedPaneIds.has(endpoint.paneId),
      ),
      cleanup,
    }));
    const state = await readRuntimeState(deps.runtimePath);
    await writeRuntimeState(
      deps.runtimePath,
      replaceRuntimeTask(state, task.id, (current) =>
        settledRuntimeTask(current, {
          attempt,
          terminalRevision: attempt.status === "pending" ? undefined : updated.revision,
          now,
        }),
      ),
    );
  });
  return { taskId: task.id, status: attempt.status, reason: attempt.reason };
}

function deferred(taskId: string, reason: string): TaskCleanupOutcome {
  return { taskId, status: "deferred", reason };
}

function hasBusyPresentation(state: RuntimeState, taskId: string): boolean {
  return state.presentations.some(
    (presentation) =>
      presentation.taskId === taskId &&
      (activeRuntimeJob(presentation.job) || unreleasedReservation(presentation.reservation)),
  );
}

/**
 * Releases the child pane and worktree of one terminal task, and leaves a durable note saying what
 * happened.
 *
 * A scout must additionally prove its checkout is still the untouched source commit before its
 * lease is returned, because a scout never has work of its own to preserve; an implementation task
 * keeps the task-side release contract, which refuses any lease it cannot prove landed.
 */
export async function releaseTerminalTaskResources(
  deps: TaskCleanupDependencies,
  captured: TaskRecord,
  options: TerminalTaskCleanupOptions = {},
): Promise<TaskCleanupOutcome> {
  return withStateLock(deps.home, async () => {
    const task = await deps.store.read(captured.id);
    const discardableBlocked =
      options.discard === true && task?.kind === "implementation" && task.stage === "blocked";
    if (
      task === undefined ||
      task.revision !== captured.revision ||
      (!isTerminalTask(task) && !discardableBlocked)
    ) {
      return deferred(captured.id, "the task changed before cleanup started");
    }
    const state = await readRuntimeState(deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined) {
      return deferred(task.id, "the task has no durable runtime metadata");
    }
    if (runtime.terminalCleanupRevision === task.revision) {
      return {
        taskId: task.id,
        status: task.cleanup?.status ?? "released",
        reason: task.cleanup?.reason ?? "cleanup already settled for this revision",
      };
    }
    if (runtime.endpointLaunch !== undefined || runtime.jobs.some(activeRuntimeJob)) {
      return deferred(task.id, "a worker launch is still unresolved");
    }
    if (unreleasedReservation(runtime.reservation)) {
      return deferred(task.id, "the task reservation is still held");
    }
    if (hasBusyPresentation(state, task.id)) {
      return deferred(task.id, "a presentation for this task is still running");
    }
    const eligibility =
      task.kind === "scout" ? decideScoutCleanupEligibility(task) : ({ kind: "eligible" } as const);
    if (eligibility.kind === "retained") {
      return recordCleanupAttempt(deps, task, {
        closedPaneIds: [],
        leaseReleased: false,
        status: "retained",
        reason: eligibility.reason,
      });
    }

    const cwd = runtime.worktree?.path ?? taskSourcePath(task, runtime);
    const panes = await closeOwnedPanes(deps.run, runtime.endpoints, cwd);
    if (panes.failure !== undefined) {
      const failure = panes.failure;
      if (failure.status === "deferred") return deferred(task.id, failure.reason);
      return recordCleanupAttempt(deps, task, {
        closedPaneIds: panes.closedPaneIds,
        leaseReleased: false,
        status: failure.status,
        reason: failure.reason,
      });
    }

    const lease = runtime.worktree;
    if (lease === undefined) {
      return recordCleanupAttempt(deps, task, {
        closedPaneIds: panes.closedPaneIds,
        leaseReleased: false,
        status: "released",
        reason: "the task holds no worktree lease",
      });
    }
    const decision =
      task.kind === "scout"
        ? decideScoutWorktreeRelease({
            lease,
            checkout: await observeScoutCheckout(deps.run, lease.path),
          })
        : ({
            kind: "release",
            reason: "the lease release contract proves an implementation worktree landed",
          } as const);
    if (decision.kind !== "release") {
      return recordCleanupAttempt(deps, task, {
        closedPaneIds: panes.closedPaneIds,
        leaseReleased: false,
        status: decision.kind === "retain" ? "retained" : "quarantined",
        reason: decision.reason,
      });
    }
    try {
      await releaseWorktree(deps.run, {
        repo: task.repoPath,
        lease,
        childWorkerStopped: true,
        ...(options.discard === true &&
        task.kind === "implementation" &&
        (task.stage === "cancelled" || task.stage === "blocked")
          ? { discard: true, destructiveApproval: true }
          : {}),
      });
    } catch (error) {
      return recordCleanupAttempt(deps, task, {
        closedPaneIds: panes.closedPaneIds,
        leaseReleased: false,
        status: classifyCleanupFailure(error),
        reason: `the worktree lease was retained: ${describeError(error)}`,
      });
    }
    return recordCleanupAttempt(deps, task, {
      closedPaneIds: panes.closedPaneIds,
      leaseReleased: true,
      status: "released",
      reason: decision.reason,
    });
  });
}

export type PendingScoutCleanupInput = Readonly<{
  readonly home: string;
  readonly run?: CommandRunner;
  readonly clock?: Clock;
}>;

/**
 * Finishes scout cleanup that an earlier coordinator started and did not settle, across every task
 * in one Tandem home.
 *
 * This is the global path a reconciliation command calls. It is idempotent: a scout whose cleanup
 * already settled, or whose ownership was quarantined, is skipped rather than attempted again, so
 * repeated runs converge instead of re-inspecting released resources.
 */
export async function finishPendingScoutCleanup(
  input: PendingScoutCleanupInput,
): Promise<readonly TaskCleanupOutcome[]> {
  const home = absoluteDirectory(input.home, "home");
  const run = input.run ?? runCommand;
  const clock = input.clock ?? ((): string => new Date().toISOString());
  if (typeof run !== "function" || typeof clock !== "function") {
    throw new TypeError("run and clock must be functions");
  }
  const deps: TaskCleanupDependencies = {
    home,
    store: createTaskStore({
      directory: join(home, "tasks"),
      clock,
      idFactory: defaultIdFactory(),
    }),
    runtimePath: runtimeFile(home),
    run,
    clock,
  };
  return withStateLock(home, async () => {
    const tasks = await deps.store.list();
    const state = await readRuntimeState(deps.runtimePath);
    const outcomes: TaskCleanupOutcome[] = [];
    for (const task of tasks) {
      if (decideScoutCleanupEligibility(task).kind !== "eligible") continue;
      if (task.cleanup?.status === "quarantined") continue;
      const runtime = taskRuntime(state, task.id);
      if (runtime === undefined || runtime.terminalCleanupRevision === task.revision) continue;
      outcomes.push(await releaseTerminalTaskResources(deps, task));
    }
    return outcomes;
  });
}

/**
 * Finishes unsettled implementation tasks across a Tandem home. Normal cleanup still proves a
 * landed worktree; an explicit discard pass may force-return only cancelled or blocked tasks.
 */

export type PendingImplementationCleanupInput = PendingScoutCleanupInput &
  Readonly<{ readonly discard?: boolean }>;

export async function finishPendingImplementationCleanup(
  input: PendingImplementationCleanupInput,
): Promise<readonly TaskCleanupOutcome[]> {
  const home = absoluteDirectory(input.home, "home");
  const run = input.run ?? runCommand;
  const clock = input.clock ?? ((): string => new Date().toISOString());
  if (typeof run !== "function" || typeof clock !== "function") {
    throw new TypeError("run and clock must be functions");
  }
  const deps: TaskCleanupDependencies = {
    home,
    store: createTaskStore({
      directory: join(home, "tasks"),
      clock,
      idFactory: defaultIdFactory(),
    }),
    runtimePath: runtimeFile(home),
    run,
    clock,
  };
  return withStateLock(home, async () => {
    const tasks = await deps.store.list();
    const state = await readRuntimeState(deps.runtimePath);
    const outcomes: TaskCleanupOutcome[] = [];
    for (const task of tasks) {
      const explicitlyDiscardedBlocked =
        input.discard === true && task.kind === "implementation" && task.stage === "blocked";
      if (task.kind !== "implementation" || (!isTerminalTask(task) && !explicitlyDiscardedBlocked))
        continue;
      if (task.cleanup?.status === "quarantined") continue;
      const runtime = taskRuntime(state, task.id);
      if (runtime === undefined || runtime.terminalCleanupRevision === task.revision) continue;
      outcomes.push(
        await releaseTerminalTaskResources(deps, task, {
          discard:
            input.discard === true &&
            task.kind === "implementation" &&
            (task.stage === "cancelled" || task.stage === "blocked"),
        }),
      );
    }
    return outcomes;
  });
}
