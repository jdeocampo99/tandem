import { join } from "node:path";
import { runCommand } from "../adapters/commands.ts";
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
import { createTaskStore, type TaskStore } from "../tasks/store.ts";
import { terminalBackend } from "../terminal-backend/compose.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { prepareWorkerTerminal, workerJobForEndpoint } from "../workers/terminal-control.ts";
import {
  absoluteDirectory,
  describeError,
  isMissingEndpoint,
  isTerminalTask,
  replaceRuntimeTask,
} from "./records.ts";
import { observeScoutCheckout, type ScoutCheckoutObservation } from "./scout-checkout.ts";
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
  readonly terminal: TerminalBackend;
  readonly clock: Clock;
  /** The project's cleanupCommands, read when a finished task's worktree is cleaned up. */
  readonly cleanupCommands: (repoPath: string) => Promise<readonly string[]>;
}>;
export type TerminalTaskCleanupOptions = Readonly<{
  /** Discard is reserved for explicitly approved cancelled or blocked implementation tasks. */
  readonly discard?: boolean;
  /**
   * Explicitly approved: return a cancelled or completed implementation worktree whose commits
   * the proof shows are already in other work. Re-proved under the state lock; the branch is kept.
   */
  readonly free?: SupersededProof;
}>;

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
 * Whether a completed scout's clean worktree should wait for an implementation to adopt it rather
 * than return to the pool. Report-only research, and research never classified, releases as usual.
 */
export function scoutLeadsToImplementation(
  task: Pick<TaskRecord, "kind" | "stage" | "researchContinuation">,
): boolean {
  const disposition = task.researchContinuation?.disposition;
  return (
    task.kind === "scout" &&
    task.stage === "completed" &&
    (disposition === "ask-intent" || disposition === "implementation-interview")
  );
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
  terminal: TerminalBackend,
  runtime: Pick<RuntimeTaskState, "endpoints" | "jobs">,
  cwd: string,
): Promise<PaneClosureProgress> {
  const closedPaneIds: string[] = [];
  for (const endpoint of runtime.endpoints) {
    try {
      const job = workerJobForEndpoint(runtime.jobs, endpoint);
      await prepareWorkerTerminal(terminal, {
        endpoint,
        cwd,
        ...(job === undefined ? {} : { job }),
      });
      await terminal.close({ endpoint, cwd });
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
 * Keeps a finished scout that leads to implementation fully alive: its pane stays open, so the
 * user's mockup requests and Lavish comments reach the agent that did the research, and its clean
 * worktree waits for the implementation to adopt. `undefined` means clean up as usual.
 */
async function keepResearchAgent(
  deps: TaskCleanupDependencies,
  task: TaskRecord,
  runtime: RuntimeTaskState,
): Promise<TaskCleanupOutcome | undefined> {
  const lease = runtime.worktree;
  if (!scoutLeadsToImplementation(task) || lease === undefined) return undefined;
  const checkout = await observeScoutCheckout(deps.run, lease.path);
  if (checkout.status !== "observed") return undefined;
  if (decideScoutWorktreeRelease({ lease, checkout }).kind !== "release") return undefined;
  return recordCleanupAttempt(deps, task, {
    closedPaneIds: [],
    leaseReleased: false,
    status: "retained",
    reason:
      "the research agent and its worktree stay for mockups and the implementation that follows",
  });
}

/**
 * Closes a finished scout's pane once the implementation that follows it starts, so that
 * implementation can adopt the worktree. The worktree lease and cleanup record are unchanged.
 */
export async function closeFinishedScoutPanes(
  deps: Pick<TaskCleanupDependencies, "store" | "runtimePath" | "terminal">,
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
    deps.terminal,
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
    if (task.kind === "scout" && options.free === undefined) {
      const kept = await keepResearchAgent(deps, task, runtime);
      if (kept !== undefined) return kept;
    }

    const cwd = runtime.worktree?.path ?? taskSourcePath(task, runtime);
    const panes = await closeOwnedPanes(deps.terminal, runtime, cwd);
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
      if (
        decision.kind === "release" &&
        checkout?.status === "observed" &&
        scoutLeadsToImplementation(task)
      ) {
        return recordCleanupAttempt(deps, task, {
          closedPaneIds: panes.closedPaneIds,
          leaseReleased: false,
          status: "retained",
          reason: "the scout worktree is kept for the implementation that follows this research",
        });
      }
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
  readonly terminal?: TerminalBackend;
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
    terminal: input.terminal ?? terminalBackend(run, { home }),
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
    terminal: input.terminal ?? terminalBackend(run, { home }),
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
