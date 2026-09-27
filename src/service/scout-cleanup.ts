import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../adapters/commands.ts";
import { closeEndpoint } from "../adapters/herdr.ts";
import {
  AdapterProtocolError,
  EndpointBusyError,
  EndpointOwnershipError,
} from "../adapters/primitives.ts";
import { releaseWorktree } from "../adapters/treehouse.ts";
import { readCleanupCommands } from "../config/repositories.ts";
import type {
  Clock,
  CommandRunner,
  TaskCleanupState,
  TaskCleanupStatus,
  TaskRecord,
  WorktreeLease,
} from "../contracts.ts";
import { removeReviewWorktree } from "../pr-review/worktree.ts";
import { activeRuntimeJob, taskRuntime, unreleasedReservation } from "../runtime/activity.ts";
import { withStateLock } from "../runtime/database.ts";
import {
  defaultIdFactory,
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type { RuntimeState, RuntimeTaskState } from "../runtime/schema.ts";
import { researchInterviewFor } from "../tasks/research-interview.ts";
import { createTaskStore, type TaskStore } from "../tasks/store.ts";
import { prepareWorkerTerminal, workerJobForEndpoint } from "../workers/terminal-control.ts";
import {
  absoluteDirectory,
  describeError,
  isMissing,
  isMissingEndpoint,
  isTerminalTask,
  replaceRuntimeTask,
} from "./records.ts";
import { taskCheckoutPath, taskSourcePath } from "./source.ts";
import {
  containerRefs,
  otherTaskWork,
  recheckSuperseded,
  type SupersededProof,
} from "./superseded.ts";

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
  /** The project's cleanupCommands, read when a finished task's worktree is cleaned up. */
  readonly cleanupCommands: (repoPath: string) => Promise<readonly string[]>;
}>;
export type TerminalTaskCleanupOptions = Readonly<{
  /** Discard is reserved for explicitly approved cancelled or blocked implementation tasks. */
  readonly discard?: boolean;
  /**
   * Close a non-adopted scout cited by an approved implementation. Exact ownership and cleanliness
   * are still re-proved before its worktree is released.
   */
  readonly approvedResearchHandoff?: boolean;
  /**
   * Explicitly approved: return a cancelled or completed implementation worktree whose commits
   * the proof shows are already in other work. Re-proved under the state lock; the branch is kept.
   */
  readonly free?: SupersededProof;
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
 * Blocked and paused scouts keep everything: their pane and checkout are evidence a coordinator
 * needs to answer them. A completed report remains available until its research interview is
 * explicitly stopped; cancellation is itself an explicit stop.
 */
export function decideScoutCleanupEligibility(
  task: Pick<TaskRecord, "kind" | "stage" | "reportPath" | "communication" | "researchInterview">,
  options: Readonly<{ readonly allowApprovedHandoff?: boolean }> = {},
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
  const interview = researchInterviewFor(task);
  if (interview?.status === "approved") {
    return options.allowApprovedHandoff === true
      ? { kind: "eligible" }
      : { kind: "retained", reason: "research approved for implementation handoff" };
  }
  if (interview?.status === "open") {
    return {
      kind: "retained",
      reason: "the completed research interview is open; its session stays available until stopped",
    };
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
 * Closes each owned endpoint after proving the pane is the one Tandem opened. A finished worker
 * that OMP left idle in the pane is asked to exit first; a busy one defers cleanup. An endpoint
 * that is already gone counts as closed.
 */
async function closeOwnedPanes(
  run: CommandRunner,
  runtime: Pick<RuntimeTaskState, "endpoints" | "jobs">,
  cwd: string,
): Promise<PaneClosureProgress> {
  const closedPaneIds: string[] = [];
  for (const endpoint of runtime.endpoints) {
    try {
      const job = workerJobForEndpoint(runtime.jobs, endpoint);
      await prepareWorkerTerminal(run, { endpoint, cwd, ...(job === undefined ? {} : { job }) });
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
            reason: `pane ${endpoint.paneId} still has an active worker`,
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

// ponytail: only the retired presentation worker ran its own job; agent-drawn pages hold nothing.
function hasBusyPresentation(state: RuntimeState, taskId: string): boolean {
  return state.presentations.some(
    (presentation) =>
      presentation.taskId === taskId &&
      ((presentation.job !== undefined && activeRuntimeJob(presentation.job)) ||
        unreleasedReservation(presentation.reservation)),
  );
}

/**
 * Closes a finished scout's pane once the implementation that follows it starts, so that
 * implementation can adopt the worktree. The worktree lease and cleanup record are unchanged.
 */
export async function closeFinishedScoutPanes(
  deps: Pick<TaskCleanupDependencies, "store" | "runtimePath" | "run">,
  scoutId: string,
): Promise<void> {
  const [task, state] = await Promise.all([
    deps.store.read(scoutId),
    deps.store.exclusive(() => readRuntimeState(deps.runtimePath)),
  ]);
  const runtime = state === undefined ? undefined : taskRuntime(state, scoutId);
  if (
    task?.kind !== "scout" ||
    task.stage !== "completed" ||
    runtime === undefined ||
    runtime.endpoints.length === 0 ||
    runtime.endpointLaunch !== undefined ||
    runtime.jobs.some(activeRuntimeJob) ||
    unreleasedReservation(runtime.reservation)
  ) {
    return;
  }
  const panes = await closeOwnedPanes(
    deps.run,
    runtime,
    runtime.worktree?.path ?? taskSourcePath(task, runtime),
  );
  const closed = new Set(panes.closedPaneIds);
  if (closed.size === 0) return;
  await deps.store.exclusive(async (store) => {
    const current = await store.read(scoutId);
    if (current !== undefined) {
      await store.update(scoutId, current.revision, (latest) => ({
        ...latest,
        revision: latest.revision + 1,
        endpoints: (latest.endpoints ?? []).filter((endpoint) => !closed.has(endpoint.paneId)),
      }));
    }
    const latestState = await readRuntimeState(deps.runtimePath);
    await writeRuntimeState(
      deps.runtimePath,
      replaceRuntimeTask(latestState, scoutId, (entry) => ({
        ...entry,
        endpoints: entry.endpoints.filter((endpoint) => !closed.has(endpoint.paneId)),
      })),
    );
  });
}

const CLEANUP_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Runs the project's cleanupCommands in a finished task's worktree once its agents are closed, so
 * what they started outside their own processes, like a Docker stack, stops too. A failure never
 * keeps the worktree; it is returned so the caller can report it.
 */
export async function runCleanupCommands(
  deps: Pick<TaskCleanupDependencies, "run" | "cleanupCommands">,
  repoPath: string,
  worktreePath: string | undefined,
): Promise<string | undefined> {
  if (worktreePath === undefined) return undefined;
  let commands: readonly string[];
  try {
    commands = await deps.cleanupCommands(repoPath);
  } catch (error) {
    return `cleanup commands could not be read: ${describeError(error)}`;
  }
  const failures: string[] = [];
  for (const command of commands) {
    const result = await deps
      .run({
        argv: ["/bin/sh", "-c", command],
        cwd: worktreePath,
        timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS,
      })
      .catch((error: unknown) => ({ code: -1, stdout: "", stderr: describeError(error) }));
    if (result.code !== 0) failures.push(`${command} exited ${result.code}`);
  }
  return failures.length === 0 ? undefined : `cleanup commands failed: ${failures.join("; ")}`;
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
    const retryApprovedHandoff =
      options.approvedResearchHandoff === true &&
      task.kind === "scout" &&
      task.cleanup?.status === "retained" &&
      researchInterviewFor(task)?.status === "approved";
    if (runtime.terminalCleanupRevision === task.revision && !retryApprovedHandoff) {
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
      task.kind === "scout"
        ? decideScoutCleanupEligibility(task, {
            allowApprovedHandoff: options.approvedResearchHandoff === true,
          })
        : ({ kind: "eligible" } as const);
    if (eligibility.kind === "retained") {
      return recordCleanupAttempt(deps, task, {
        closedPaneIds: [],
        leaseReleased: false,
        status: "retained",
        reason: eligibility.reason,
      });
    }

    const cwd = runtime.worktree?.path ?? taskSourcePath(task, runtime);
    const panes = await closeOwnedPanes(deps.run, runtime, cwd);
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

    // A PR review worktree holds someone else's repository, where the project's commands do not apply.
    const cleanupFailure =
      task.kind === "pr-review"
        ? undefined
        : await runCleanupCommands(deps, taskCheckoutPath(task), runtime.worktree?.path);
    const settle = async (): Promise<TaskCleanupOutcome> => {
      const lease = runtime.worktree;
      if (lease !== undefined && task.kind === "pr-review") {
        return settlePrReviewWorktree(deps, task, lease, panes.closedPaneIds);
      }
      if (lease === undefined) {
        return recordCleanupAttempt(deps, task, {
          closedPaneIds: panes.closedPaneIds,
          leaseReleased: false,
          status: "released",
          reason: "the task holds no worktree lease",
        });
      }
      if (options.free !== undefined) {
        return await freeSupersededWorktree(deps, task, lease, options.free, panes.closedPaneIds);
      }
      const checkout =
        task.kind === "scout" ? await observeScoutCheckout(deps.run, lease.path) : undefined;
      const decision =
        checkout === undefined
          ? ({
              kind: "release",
              reason: "the lease release contract proves an implementation worktree landed",
            } as const)
          : decideScoutWorktreeRelease({ lease, checkout });
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
          repo: taskCheckoutPath(task),
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
    };
    const outcome = await settle();
    // ponytail: the failure reaches the caller's outcome, not the durable cleanup record.
    return cleanupFailure === undefined
      ? outcome
      : { ...outcome, reason: `${outcome.reason}; ${cleanupFailure}` };
  });
}

/**
 * Keeps a finished PR review's worktree for follow-up questions and re-reviews, and removes it once
 * the user closes the review or cancels the task. Only the review worktree and its refs go; the
 * user's checkout is otherwise untouched.
 */
async function settlePrReviewWorktree(
  deps: TaskCleanupDependencies,
  task: TaskRecord,
  lease: WorktreeLease,
  closedPaneIds: readonly string[],
): Promise<TaskCleanupOutcome> {
  const state = task.prReview;
  if (state !== undefined && state.closed !== true && task.stage !== "cancelled") {
    return recordCleanupAttempt(deps, task, {
      closedPaneIds,
      leaseReleased: false,
      status: "retained",
      reason:
        "the review checkout is kept for follow-up questions and re-reviews until the review is closed",
    });
  }
  if (state !== undefined) {
    await removeReviewWorktree(deps.run, { checkout: lease.root, path: lease.path }, state.ref);
  }
  return recordCleanupAttempt(deps, task, {
    closedPaneIds,
    leaseReleased: true,
    status: "released",
    reason: "the review checkout was removed",
  });
}

/**
 * Returns a worktree whose commits other work already carries. Only a cancelled or completed
 * implementation task qualifies, and only after its checkout is re-proved clean and contained;
 * the return then uses the approved discard path, which keeps the branch ref and its commits.
 */
async function freeSupersededWorktree(
  deps: TaskCleanupDependencies,
  task: TaskRecord,
  lease: WorktreeLease,
  proof: SupersededProof,
  closedPaneIds: readonly string[],
): Promise<TaskCleanupOutcome> {
  const refusal =
    task.kind !== "implementation" || (task.stage !== "cancelled" && task.stage !== "completed")
      ? "only a cancelled or completed implementation task can be freed"
      : await recheckSuperseded(
          deps.run,
          taskCheckoutPath(task),
          lease,
          proof,
          containerRefs(
            task,
            lease.branch,
            otherTaskWork(await deps.store.list(), await readRuntimeState(deps.runtimePath)),
          ),
        );
  if (refusal !== undefined) {
    return recordCleanupAttempt(deps, task, {
      closedPaneIds,
      leaseReleased: false,
      status: "pending",
      reason: `the worktree was kept: ${refusal}`,
    });
  }
  try {
    await releaseWorktree(deps.run, {
      repo: taskCheckoutPath(task),
      lease,
      childWorkerStopped: true,
      discard: true,
      destructiveApproval: true,
    });
  } catch (error) {
    return recordCleanupAttempt(deps, task, {
      closedPaneIds,
      leaseReleased: false,
      status: classifyCleanupFailure(error),
      reason: `the worktree lease was retained: ${describeError(error)}`,
    });
  }
  return recordCleanupAttempt(deps, task, {
    closedPaneIds,
    leaseReleased: true,
    status: "released",
    reason: `the worktree was returned because its commits are in ${proof.label}; branch ${lease.branch} is kept`,
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
    cleanupCommands: (repoPath) => readCleanupCommands({ repoPath, home }),
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
  Readonly<{
    readonly discard?: boolean;
    /** When present, only these tasks are attempted, so an apply never exceeds its plan. */
    readonly taskIds?: ReadonlySet<string>;
    /** Explicitly approved superseded worktrees to return, by task id. */
    readonly free?: ReadonlyMap<string, SupersededProof>;
  }>;

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
    cleanupCommands: (repoPath) => readCleanupCommands({ repoPath, home }),
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
      if (input.taskIds !== undefined && !input.taskIds.has(task.id)) continue;
      if (task.cleanup?.status === "quarantined") continue;
      const runtime = taskRuntime(state, task.id);
      if (runtime === undefined || runtime.terminalCleanupRevision === task.revision) continue;
      const free = input.free?.get(task.id);
      outcomes.push(
        await releaseTerminalTaskResources(deps, task, {
          discard:
            input.discard === true &&
            task.kind === "implementation" &&
            (task.stage === "cancelled" || task.stage === "blocked"),
          ...(free === undefined ? {} : { free }),
        }),
      );
    }
    return outcomes;
  });
}
