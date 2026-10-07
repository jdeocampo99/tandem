import { readCheckpoint } from "../adapters/git.ts";
import { EndpointBusyError } from "../adapters/primitives.ts";
import type {
  BlockCause,
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  TaskRecord,
} from "../contracts.ts";
import { STOPPED_BEFORE_RESULT_REASON } from "../recovery/central-review.ts";
import { activeRuntimeJob, taskRuntime } from "../runtime/activity.ts";
import { withStateLock } from "../runtime/database.ts";
import { readRuntimeState, writeRuntimeState } from "../runtime/persistence.ts";
import type {
  DurableEndpointLaunch,
  DurableJob,
  DurableStopRequest,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import {
  currentWriter,
  DEFAULT_STARTUP_GRACE_MS,
  describeError,
  isMissing,
  isOlderThan,
  replaceRuntimeTask,
  singleLine,
  text,
} from "../service/records.ts";
import { taskSourcePath } from "../service/source.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { readValidationResult } from "../validation-worker.ts";
import { readWorkerResult } from "../workers/jobs.ts";
import { claimOf, type OperationClaim, ownsOperation } from "../workers/operation-claim.ts";
import { workerDelegationStopped } from "../workers/terminal.ts";
import {
  prepareWorkerTerminal,
  stopWorkerPane,
  workerJobForEndpoint,
  workerJobOccupyingEndpoint,
} from "../workers/terminal-control.ts";
import { appendTaskMessage } from "./communication-protocol.ts";
import { recoverEndpointFromLaunch, sameEndpointLaunch } from "./endpoint-launch.ts";
import {
  isActiveTask,
  type TaskEvent,
  type TaskTransitionContext,
  transitionTask,
} from "./lifecycle.ts";
import { decideRequiredStages, policyStageFacts, pullRequestPublished } from "./required-stages.ts";
import type { TaskStore, TaskStoreTransaction } from "./store.ts";

type ControlAction = "pause" | "cancel";
type OwnedEndpointProbe = Readonly<{
  readonly status: "active" | "stopped" | "missing" | "rejected";
  readonly detail: string | undefined;
}>;
type TerminalResultProbe =
  | Readonly<{ readonly status: "valid" }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{ readonly status: "invalid"; readonly detail: string }>;
type ResumeResourceCheck = Readonly<{
  readonly failure: string | undefined;
  readonly abandonedJobIds: readonly string[];
  readonly terminalJobIds: readonly string[];
}>;
type PreparedStop =
  | Readonly<{
      readonly kind: "terminal";
      readonly task: TaskRecord;
      readonly runtime: RuntimeTaskState | undefined;
    }>
  | Readonly<{
      readonly kind: "active";
      readonly task: TaskRecord;
      readonly runtime: RuntimeTaskState;
      readonly event: TaskEvent;
    }>;
/** A launch recovery problem to record, and the block to apply when it can no longer wait. */
type LaunchFailure = Readonly<{
  readonly claim: OperationClaim | undefined;
  readonly launch: DurableEndpointLaunch;
  readonly reason: string;
  readonly blockCause?: BlockCause;
}>;

export type TaskControlDependencies = Readonly<{
  readonly home: string;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly sessionId: string;
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
  readonly runtimeFor: (taskId: string) => Promise<RuntimeTaskState | undefined>;
  readonly reconcileTask: (task: TaskRecord) => Promise<void>;
  readonly reconcileJob: (
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
  ) => Promise<void>;
  readonly context: () => TaskTransitionContext;
  readonly transition: (taskId: string, event: TaskEvent) => Promise<TaskRecord>;
  readonly blockTask: (taskId: string, reason: string, cause?: BlockCause) => Promise<TaskRecord>;
  readonly publishTaskInbox: (task: TaskRecord) => Promise<void>;
  readonly saveEndpoint: (
    taskId: string,
    endpoint: Endpoint,
    claim?: OperationClaim,
  ) => Promise<void>;
  readonly setRuntimeError: (taskId: string, error: string) => Promise<void>;
  /** Whether the request's approved brief says its work needs no code review. */
  readonly briefSkipsReview: (requestId: string) => Promise<boolean>;
}>;

/** Added to a direction for a task whose pull request is open: Tandem pushes, the agent commits. */
const OPEN_PR_FOLLOW_UP =
  "This task's pull request is already open. If you change code, commit it before you submit; Tandem pushes the branch to the pull request, so don't push it yourself.";

const REDIRECT_STAGES: readonly TaskRecord["stage"][] = [
  "validating",
  "reviewing",
  "ready",
  "awaiting-fixes",
];

function workerCwd(task: TaskRecord, runtime: RuntimeTaskState): string {
  return runtime.worktree?.path ?? taskSourcePath(task, runtime);
}

/** The runtime still holds exactly this launch, under this claim, with no stop requested. */
function launchStillClaimed(
  current: RuntimeTaskState | undefined,
  launch: DurableEndpointLaunch,
  claim: OperationClaim | undefined,
): boolean {
  return (
    current !== undefined &&
    current.stopRequest === undefined &&
    ownsOperation(current.operation, claim) &&
    current.reservation?.id === launch.reservationId &&
    current.reservation?.operationId === launch.operationId &&
    sameEndpointLaunch(current.endpointLaunch, launch)
  );
}

function stopEvent(action: ControlAction, reason: string | undefined): TaskEvent {
  return action === "pause"
    ? { type: "pause", reason: reason ?? "paused by coordinator" }
    : { type: "cancel", ...(reason === undefined ? {} : { reason }) };
}

/** Only the implementer or scout pane survives a redirect, renumbered to the new generation. */
function workerEndpoints(endpoints: readonly Endpoint[], generation: number): Endpoint[] {
  return endpoints
    .filter((endpoint) => endpoint.role === "scout" || endpoint.role === "implementer")
    .map((endpoint) => ({ ...endpoint, generation }));
}

/**
 * Clears the stop request after every owned worker was proven stopped: abandoned jobs fail, and the
 * reservation is released once nothing active remains to hold it.
 */
function releaseStoppedRuntime(
  current: RuntimeTaskState,
  resources: ResumeResourceCheck,
  clock: Clock,
): RuntimeTaskState {
  const abandonedJobIds = new Set(resources.abandonedJobIds);
  const { stopRequest: _stopRequest, lastError: _lastError, ...withoutControl } = current;
  const jobs: readonly DurableJob[] =
    abandonedJobIds.size === 0
      ? current.jobs
      : current.jobs.map(
          (job): DurableJob =>
            abandonedJobIds.has(job.id)
              ? {
                  ...job,
                  phase: "failed",
                  error: STOPPED_BEFORE_RESULT_REASON,
                }
              : job,
        );
  // Every owned worker was just proven stopped, so a quarantined operation's outcome is no
  // longer uncertain: nothing it started is still running. Settle it here rather than leave a
  // stored "uncertain" that would refuse every relaunch.
  const settlesQuarantine =
    withoutControl.operation?.phase === "quarantined" &&
    resources.terminalJobIds.length === 0 &&
    !jobs.some(activeRuntimeJob);
  const operation =
    settlesQuarantine && withoutControl.operation !== undefined
      ? { operation: { ...withoutControl.operation, phase: "failed" as const } }
      : {};
  const reservation = withoutControl.reservation;
  if (
    (abandonedJobIds.size === 0 && !settlesQuarantine) ||
    jobs.some(activeRuntimeJob) ||
    reservation === undefined ||
    reservation.phase === "released"
  ) {
    return { ...withoutControl, ...operation, jobs };
  }
  return {
    ...withoutControl,
    ...operation,
    jobs,
    reservation: { ...reservation, phase: "released", releasedAt: clock() },
  };
}

function cancelledRuntime(current: RuntimeTaskState, clock: Clock): RuntimeTaskState {
  const { stopRequest: _stopRequest, ...withoutStopRequest } = current;
  const jobs = current.jobs.map((job) =>
    activeRuntimeJob(job)
      ? { ...job, phase: "failed" as const, error: "worker stopped after task cancellation" }
      : job,
  );
  return {
    ...withoutStopRequest,
    endpoints: [],
    jobs,
    ...(current.operation === undefined
      ? {}
      : { operation: { ...current.operation, phase: "cancelled" as const } }),
    ...(current.reservation === undefined || current.reservation.phase === "released"
      ? {}
      : {
          reservation: {
            ...current.reservation,
            phase: "released" as const,
            releasedAt: clock(),
          },
        }),
  };
}

function redirectedRuntime(
  current: RuntimeTaskState,
  generation: number,
  clock: Clock,
): RuntimeTaskState {
  const jobs = current.jobs.map((job) =>
    activeRuntimeJob(job)
      ? { ...job, phase: "failed" as const, error: "job invalidated by newer user instruction" }
      : job,
  );
  const reservation = current.reservation;
  const {
    stopRequest: _stopRequest,
    fixContextPath: _fixContextPath,
    ...withoutTransient
  } = current;
  return {
    ...withoutTransient,
    // Every owned worker was proven stopped before the redirect, which answers a quarantined outcome.
    ...(current.operation?.phase === "quarantined"
      ? { operation: { ...current.operation, phase: "failed" as const } }
      : {}),
    endpoints: workerEndpoints(current.endpoints, generation),
    jobs,
    ...(reservation === undefined
      ? {}
      : { reservation: { ...reservation, phase: "released" as const, releasedAt: clock() } }),
  };
}

const RESTARTED_BY_USER = "The user restarted it.";

export class TaskControlWorkflow {
  readonly #deps: TaskControlDependencies;

  constructor(deps: TaskControlDependencies) {
    this.#deps = deps;
  }

  /**
   * Records a launch recovery problem while the launch is still this claim's, and blocks an open
   * task when `blockCause` is given. Returns false, changing nothing, once the launch moved on.
   */
  private async recordLaunchFailure(task: TaskRecord, failure: LaunchFailure): Promise<boolean> {
    const { claim, launch, reason, blockCause } = failure;
    return withStateLock(this.#deps.home, async () =>
      this.#deps.store.exclusive(async (store) => {
        const currentTask = await store.read(task.id);
        if (currentTask === undefined || currentTask.generation !== task.generation) {
          return false;
        }
        const state = await readRuntimeState(this.#deps.runtimePath);
        if (!launchStillClaimed(taskRuntime(state, task.id), launch, claim)) return false;
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(state, task.id, (entry) => ({ ...entry, lastError: reason })),
        );
        if (
          blockCause !== undefined &&
          isActiveTask(currentTask) &&
          currentTask.stage !== "paused" &&
          currentTask.stage !== "blocked"
        ) {
          await store.update(currentTask.id, currentTask.revision, (entry) =>
            transitionTask(
              entry,
              {
                type: "block",
                reason: text(blockCause.summary, "block reason"),
                cause: blockCause,
              },
              this.#deps.context(),
            ),
          );
        }
        return true;
      }),
    );
  }

  async reconcileEndpointLaunch(
    task: TaskRecord,
    runtime: RuntimeTaskState,
  ): Promise<RuntimeTaskState | undefined> {
    const launch = runtime.endpointLaunch;
    if (launch === undefined) return runtime;
    const claim = claimOf(runtime.operation);
    if (runtime.stopRequest !== undefined) return runtime;
    if (runtime.reservation?.ownerSessionId !== this.#deps.sessionId) {
      await this.recordLaunchFailure(task, {
        claim,
        launch,
        reason: "endpoint launch is owned by another session; recovery was not attempted",
      });
      return undefined;
    }
    return withStateLock(this.#deps.home, async () => {
      const recovery = await recoverEndpointFromLaunch(this.#deps.terminal, launch);
      if (recovery.status !== "recovered") {
        const reason =
          recovery.status === "ambiguous"
            ? `endpoint recovery is ambiguous: ${recovery.detail}`
            : `endpoint recovery is pending: ${recovery.detail}`;
        const block =
          recovery.status === "ambiguous" ||
          isOlderThan(launch.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS);
        await this.recordLaunchFailure(task, {
          claim,
          launch,
          reason,
          ...(block
            ? {
                blockCause: {
                  group: "lost-resource",
                  kind: "resource-lost",
                  summary: "Tandem couldn't find the worker's terminal after a restart.",
                  detail: reason,
                },
              }
            : {}),
        });
        return undefined;
      }
      const currentTask = await this.#deps.getTask(task.id);
      const current = await this.#deps.runtimeFor(task.id);
      if (
        !launchStillClaimed(current, launch, claim) ||
        current?.reservation?.ownerSessionId !== this.#deps.sessionId ||
        launch.operationId !== claim?.id ||
        currentTask.generation !== launch.generation
      ) {
        return undefined;
      }
      try {
        await this.#deps.saveEndpoint(task.id, recovery.endpoint, claim);
      } catch (error) {
        const recorded = await this.recordLaunchFailure(task, {
          claim,
          launch,
          reason: `recovered endpoint identity could not be persisted: ${describeError(error)}`,
        });
        if (!recorded) return undefined;
      }
      return this.#deps.runtimeFor(task.id);
    });
  }

  async controlTask(
    taskId: string,
    action: ControlAction,
    reason: string | undefined,
    discard = false,
  ): Promise<TaskRecord> {
    return withStateLock(this.#deps.home, async () => {
      const prepared = await this.requestStop(taskId, action, reason, discard);
      if (prepared.kind === "terminal") {
        if (prepared.runtime !== undefined) {
          await this.assertOwnedResourcesStopped(prepared.task, prepared.runtime);
        }
        return prepared.task;
      }
      const { task, runtime, event } = prepared;
      const stopFailure =
        runtime.jobs.some(activeRuntimeJob) && runtime.endpoints.length === 0
          ? "a durable worker job has no endpoint identity"
          : await this.stopOwnedWorkers(runtime, workerCwd(task, runtime), "control");
      return this.#deps.store.exclusive(async (store) => {
        const current = await store.read(taskId);
        if (current === undefined) throw new Error(`task ${taskId} is missing`);
        if (stopFailure !== undefined) {
          return this.blockUnstoppedTask(store, current, action, stopFailure);
        }
        const planned = transitionTask(current, event, this.#deps.context());
        await store.update(
          current.id,
          current.revision,
          () => planned,
          reason === undefined ? undefined : { cause: reason },
        );
        return planned;
      });
    });
  }

  /** Durably records the stop request for a live task; a finished task needs none. */
  private async requestStop(
    taskId: string,
    action: ControlAction,
    reason: string | undefined,
    discard: boolean,
  ): Promise<PreparedStop> {
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (!isActiveTask(task)) return { kind: "terminal", task, runtime };
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const event = stopEvent(action, reason);
      const stopRequest: DurableStopRequest = {
        schemaVersion: 1,
        action,
        generation: task.generation,
        requestedAt: this.#deps.clock(),
        ...(action === "cancel" && discard ? { discard: true } : {}),
      };
      await writeRuntimeState(
        this.#deps.runtimePath,
        replaceRuntimeTask(state, taskId, (current) => ({
          ...current,
          stopRequest,
          lastError: `${action} requested`,
        })),
      );
      return { kind: "active", task, runtime, event };
    });
  }

  private async assertOwnedResourcesStopped(
    task: TaskRecord,
    runtime: RuntimeTaskState,
  ): Promise<void> {
    const resources = await this.inspectOwnedResources(task, runtime);
    if (
      resources.failure !== undefined ||
      resources.abandonedJobIds.length > 0 ||
      resources.terminalJobIds.length > 0
    ) {
      throw new Error(
        `cannot confirm task ${task.id} is stopped: ${
          resources.failure ?? "a durable worker job remains"
        }`,
      );
    }
  }

  private async blockUnstoppedTask(
    store: TaskStoreTransaction,
    current: TaskRecord,
    action: ControlAction,
    stopFailure: string,
  ): Promise<TaskRecord> {
    const blockedReason = `could not safely ${action} task ${current.id}: ${stopFailure}`;
    const cause: BlockCause = {
      group: "lost-resource",
      kind: "resource-lost",
      summary: `Tandem couldn't confirm the worker stopped, so it couldn't ${action} the task.`,
      detail: blockedReason,
    };
    const state = await readRuntimeState(this.#deps.runtimePath);
    await writeRuntimeState(
      this.#deps.runtimePath,
      replaceRuntimeTask(state, current.id, (entry) => ({ ...entry, lastError: blockedReason })),
    );
    const blocked =
      current.stage === "paused" || current.stage === "blocked"
        ? current
        : transitionTask(
            current,
            { type: "block", reason: cause.summary, cause },
            this.#deps.context(),
          );
    if (blocked !== current) await store.update(current.id, current.revision, () => blocked);
    return blocked;
  }

  /** `cause` says on the task's timeline why it resumed. */
  async resumeTask(taskId: string, cause: string): Promise<TaskRecord> {
    const outcome = await this.releaseStoppedTask(taskId, { type: "resume" }, cause);
    if (!outcome.resumed) return outcome.task;
    const current = await this.#deps.getTask(taskId);
    const runtime = await this.#deps.runtimeFor(taskId);
    const shouldContinue =
      runtime !== undefined &&
      (runtime.jobs.some(activeRuntimeJob) ||
        ((current.stage === "scouting" || current.stage === "implementing") &&
          runtime.worktree !== undefined &&
          currentWriter(runtime) !== undefined));
    if (shouldContinue) await this.#deps.reconcileTask(current);
    return this.#deps.getTask(taskId);
  }

  /**
   * The user's explicit "publish now": stops any running validator or reviewer the same way a
   * pause does, then moves the task to `ready` at its committed HEAD with the skip recorded. Only
   * an implementation task that is validating, reviewing, awaiting fixes, or blocked qualifies.
   */
  async skipReview(taskId: string): Promise<TaskRecord> {
    const task = await this.#deps.getTask(taskId);
    if (
      task.kind !== "implementation" ||
      !["validating", "reviewing", "awaiting-fixes", "blocked"].includes(task.stage)
    ) {
      throw new Error(
        `Task ${taskId} can skip review only while validating, reviewing, awaiting fixes, or blocked; it is ${task.stage}`,
      );
    }
    const worktree = task.worktree;
    if (worktree === undefined) throw new Error(`Task ${taskId} has no worktree to publish`);
    const checkout = await readCheckpoint(this.#deps.run, {
      repo: worktree.path,
      baseRef: worktree.baseHead,
    });
    if (checkout.dirty || checkout.unmerged || checkout.head === worktree.baseHead) {
      throw new Error(`Task ${taskId} has no clean commit beyond its base to publish`);
    }
    if (task.stage !== "blocked") {
      const paused = await this.controlTask(taskId, "pause", "the user asked to publish now");
      if (paused.stage !== "paused") {
        throw new Error(`Task ${taskId} could not be safely stopped to publish now`);
      }
    }
    const outcome = await this.releaseStoppedTask(
      taskId,
      { type: "skip-review", head: checkout.head },
      "The user chose to publish now.",
    );
    return outcome.task;
  }

  /**
   * Proves a paused or blocked task's owned workers are stopped, settles their abandoned jobs,
   * clears the stop request, and applies `event` in the same step.
   */
  private async releaseStoppedTask(
    taskId: string,
    event: TaskEvent,
    cause: string,
  ): Promise<Readonly<{ readonly task: TaskRecord; readonly resumed: boolean }>> {
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      if (task.stage !== "paused" && task.stage !== "blocked") {
        return { task, resumed: false };
      }
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const resources = await this.inspectOwnedResources(task, runtime);
      if (resources.failure !== undefined) {
        const message = `cannot resume task ${taskId} until owned workers are stopped: ${resources.failure}`;
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(state, taskId, (current) => ({ ...current, lastError: message })),
        );
        throw new Error(message);
      }
      const resumed = transitionTask(task, event, this.#deps.context());
      await writeRuntimeState(
        this.#deps.runtimePath,
        replaceRuntimeTask(state, taskId, (current) =>
          releaseStoppedRuntime(current, resources, this.#deps.clock),
        ),
      );
      await store.update(task.id, task.revision, () => resumed, { cause });
      return { task: resumed, resumed: true };
    });
  }

  /**
   * Restart managed worker execution without changing task identity or
   * generation. Stop/resume reuses the durable job/session context and the
   * normal scheduler bridge; terminal tasks are never resurrected.
   */
  async restartTask(taskId: string): Promise<TaskRecord> {
    const task = await this.#deps.getTask(taskId);
    if (["cancelled", "completed", "merged"].includes(task.stage)) {
      throw new Error(`Task ${taskId} cannot be restarted while it is ${task.stage}`);
    }
    if (
      (task.stage === "paused" || task.stage === "blocked") &&
      task.communication?.question !== undefined
    ) {
      throw new Error(
        `Task ${taskId} has an unanswered question ${JSON.stringify(task.communication.question.id)}; answer it before restarting managed work`,
      );
    }
    if (task.stage === "paused" || task.stage === "blocked") {
      await this.resumeTask(taskId, RESTARTED_BY_USER);
      return this.continueAfterRestart(taskId);
    }
    if (task.stage === "queued") {
      await this.#deps.reconcileTask(task);
      return this.#deps.getTask(taskId);
    }
    if (
      !["scouting", "implementing", "validating", "reviewing", "awaiting-fixes"].includes(
        task.stage,
      )
    ) {
      throw new Error(`Task ${taskId} has no restartable managed worker at stage ${task.stage}`);
    }
    const paused = await this.controlTask(taskId, "pause", "managed worker restart");
    if (paused.stage !== "paused") {
      throw new Error(`Task ${taskId} could not be safely paused for managed restart`);
    }
    await this.resumeTask(taskId, RESTARTED_BY_USER);
    return this.continueAfterRestart(taskId);
  }

  /**
   * Hands a resumed task to its stage's normal reconcile path, which is central recovery for a
   * worker stage with no live writer. `resumeTask` already continued a worker that still has one.
   */
  private async continueAfterRestart(taskId: string): Promise<TaskRecord> {
    const current = await this.#deps.getTask(taskId);
    const runtime = await this.#deps.runtimeFor(taskId);
    const writerless =
      (current.stage === "scouting" || current.stage === "implementing") &&
      (runtime === undefined || currentWriter(runtime) === undefined);
    if (writerless || ["validating", "reviewing", "awaiting-fixes"].includes(current.stage)) {
      await this.#deps.reconcileTask(current);
    }
    return this.#deps.getTask(taskId);
  }

  private async probeOwnedEndpoint(
    endpoint: Endpoint,
    cwd: string,
    job: DurableJob | undefined,
  ): Promise<OwnedEndpointProbe> {
    try {
      const inspection = await this.#deps.terminal.inspect({
        endpoint,
        cwd,
      });
      return (await workerDelegationStopped(inspection, job))
        ? { status: "stopped", detail: undefined }
        : { status: "active", detail: `pane ${endpoint.paneId} still has an active worker` };
    } catch (error) {
      if (this.#deps.terminal.isEndpointGone(error)) {
        return { status: "missing", detail: `pane ${endpoint.paneId} is no longer present` };
      }
      return { status: "rejected", detail: describeError(error) };
    }
  }

  private async probeTerminalResult(job: DurableJob): Promise<TerminalResultProbe> {
    try {
      if (job.kind === "validation") {
        if (
          job.role !== "validation" ||
          job.head === undefined ||
          job.contract === undefined ||
          job.policyDigest === undefined
        ) {
          return { status: "invalid", detail: "validation job has no complete identity" };
        }
        await readValidationResult(job.resultPath, {
          id: job.id,
          taskId: job.taskId,
          generation: job.generation,
          head: job.head,
          contract: job.contract,
          policyDigest: job.policyDigest,
        });
      } else {
        if (job.role === "validation") {
          return { status: "invalid", detail: "worker job has validation role" };
        }
        await readWorkerResult(job.resultPath, {
          id: job.id,
          taskId: job.taskId,
          generation: job.generation,
          role: job.role,
        });
      }
      return { status: "valid" };
    } catch (error) {
      if (isMissing(error)) return { status: "missing" };
      return { status: "invalid", detail: describeError(error) };
    }
  }

  private async inspectOwnedResources(
    task: TaskRecord,
    runtime: RuntimeTaskState,
  ): Promise<ResumeResourceCheck> {
    const empty = (failure: string | undefined): ResumeResourceCheck => ({
      failure,
      abandonedJobIds: [],
      terminalJobIds: [],
    });
    if (runtime.endpointLaunch !== undefined) {
      return empty("an endpoint launch identity is unresolved");
    }
    const cwd = workerCwd(task, runtime);
    const activeJobs = runtime.jobs.filter(activeRuntimeJob);
    const dependentPanes = new Set(
      activeJobs.flatMap((job) => (job.endpoint === undefined ? [] : [job.endpoint.paneId])),
    );
    const probes = new Map<string, OwnedEndpointProbe>();
    const probe = async (endpoint: Endpoint): Promise<OwnedEndpointProbe> => {
      const known = probes.get(endpoint.paneId);
      if (known !== undefined) return known;
      const result = await this.probeOwnedEndpoint(
        endpoint,
        cwd,
        await workerJobOccupyingEndpoint(runtime.jobs, endpoint),
      );
      probes.set(endpoint.paneId, result);
      return result;
    };
    for (const endpoint of runtime.endpoints) {
      const result = await probe(endpoint);
      if (result.status === "active") return empty(result.detail);
      if (result.status === "rejected")
        return empty(`pane ${endpoint.paneId} could not be proven owned: ${result.detail}`);
      if (result.status === "missing" && dependentPanes.has(endpoint.paneId)) {
        return empty(`pane ${endpoint.paneId} is missing while an active job depends on it`);
      }
    }
    const abandonedJobIds: string[] = [];
    const terminalJobIds: string[] = [];
    for (const job of activeJobs) {
      if (job.generation !== task.generation) {
        return empty(
          `durable job ${job.id} belongs to generation ${job.generation}, not ${task.generation}`,
        );
      }
      const endpoint = job.endpoint;
      if (endpoint === undefined) return empty(`durable job ${job.id} has no endpoint identity`);
      const result = await probe(endpoint);
      if (result.status === "active") return empty(result.detail);
      if (result.status === "missing") {
        return empty(`pane ${endpoint.paneId} is missing while durable job ${job.id} is active`);
      }
      if (result.status === "rejected") {
        return empty(`pane ${endpoint.paneId} could not be proven owned: ${result.detail}`);
      }
      const terminal = await this.probeTerminalResult(job);
      if (terminal.status === "valid") {
        terminalJobIds.push(job.id);
      } else if (terminal.status === "missing") {
        abandonedJobIds.push(job.id);
      } else {
        return empty(`durable job ${job.id} has an invalid terminal result: ${terminal.detail}`);
      }
    }
    return { failure: undefined, abandonedJobIds, terminalJobIds };
  }

  private async settleQuarantinedCancellation(taskId: string): Promise<void> {
    await withStateLock(this.#deps.home, async () => {
      await this.#deps.store.exclusive(async () => {
        const state = await readRuntimeState(this.#deps.runtimePath);
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(state, taskId, (current) =>
            cancelledRuntime(current, this.#deps.clock),
          ),
        );
      });
    });
  }

  private async clearSettledStopRequest(taskId: string): Promise<void> {
    await withStateLock(this.#deps.home, async () => {
      await this.#deps.store.exclusive(async () => {
        const state = await readRuntimeState(this.#deps.runtimePath);
        const settled = replaceRuntimeTask(state, taskId, (current) => {
          if (current.operation?.phase === "quarantined") return current;
          const { stopRequest: _stopRequest, ...withoutStopRequest } = current;
          return withoutStopRequest;
        });
        await writeRuntimeState(this.#deps.runtimePath, settled);
      });
    });
  }

  async reconcileStopRequest(task: TaskRecord, runtime: RuntimeTaskState): Promise<void> {
    const failure = await this.stopOwnedWorkers(runtime, workerCwd(task, runtime), "reconcile");
    if (failure !== undefined) {
      await this.#deps.setRuntimeError(task.id, failure);
      return;
    }
    const active = runtime.jobs.find(activeRuntimeJob);
    if (active !== undefined) {
      if (task.stage === "cancelled" && runtime.operation?.phase === "quarantined") {
        await this.settleQuarantinedCancellation(task.id);
        return;
      }
      await this.#deps.reconcileJob(task, runtime, active);
      return;
    }
    if (task.stage === "paused" || task.stage === "blocked") {
      return;
    }
    if (!isActiveTask(task)) {
      await this.clearSettledStopRequest(task.id);
      return;
    }
    const event: TaskEvent =
      runtime.stopRequest?.action === "pause"
        ? { type: "pause", reason: "pause request recovered after restart" }
        : { type: "cancel", reason: "cancel request recovered after restart" };
    try {
      await this.#deps.transition(task.id, event);
    } catch (error) {
      await this.#deps.setRuntimeError(
        task.id,
        `stop request could not complete: ${describeError(error)}`,
      );
    }
  }

  async redirectToPrimary(
    taskId: string,
    instruction?: Readonly<{ text: string; supersedes?: readonly string[] }>,
  ): Promise<TaskRecord> {
    // Read before the lock: the brief lives in the same database, and a task's request never changes.
    const requestId = (await this.#deps.store.read(taskId))?.requestId;
    const briefSkipsReview =
      requestId !== undefined && (await this.#deps.briefSkipsReview(requestId));
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      if (task.stage === "cancelled" || task.stage === "merged") {
        throw new Error(`Task ${taskId} cannot be steered while it is ${task.stage}`);
      }
      const communication =
        instruction === undefined
          ? task.communication
          : appendTaskMessage(task.communication, {
              id: singleLine(this.#deps.idFactory(), "message id"),
              kind: "instruction",
              text: pullRequestPublished(task)
                ? `${instruction.text} ${OPEN_PR_FOLLOW_UP}`
                : instruction.text,
              createdAt: this.#deps.clock(),
              ...(instruction.supersedes === undefined
                ? {}
                : { supersedes: instruction.supersedes }),
            });
      // Steering records which stages the new work runs, from the facts as they stand now.
      const requiredStages =
        instruction === undefined || task.kind !== "implementation"
          ? undefined
          : decideRequiredStages({
              briefSkipsReview,
              pullRequestPublished: pullRequestPublished(task),
              ...policyStageFacts(task),
            });
      const withInstruction = (candidate: TaskRecord): TaskRecord =>
        instruction === undefined || communication === undefined
          ? candidate
          : {
              ...candidate,
              communication,
              ...(requiredStages === undefined ? {} : { requiredStages }),
            };
      const commitBlock = async (cause: BlockCause): Promise<TaskRecord> => {
        const blocked = withInstruction(
          transitionTask(
            task,
            { type: "block", reason: cause.summary, cause },
            this.#deps.context(),
          ),
        );
        await store.update(task.id, task.revision, () => blocked);
        await this.#deps.publishTaskInbox(blocked);
        return blocked;
      };
      if (!REDIRECT_STAGES.includes(task.stage)) {
        if (instruction === undefined) return task;
        const updated = await store.update(task.id, task.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          updatedAt: this.#deps.clock(),
          ...(communication === undefined ? {} : { communication }),
          ...(requiredStages === undefined ? {} : { requiredStages }),
        }));
        await this.#deps.publishTaskInbox(updated);
        return updated;
      }
      if (task.reviewHead === undefined) {
        return commitBlock({
          group: "user-decision",
          kind: "prerequisite-not-met",
          summary: "There's no reviewed work yet, so a new instruction can't be applied.",
          detail: "cannot redirect task without reviewed HEAD",
        });
      }
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const cwd = workerCwd(task, runtime);
      const requested = replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        stopRequest: {
          schemaVersion: 1,
          action: "pause",
          generation: task.generation,
          requestedAt: this.#deps.clock(),
        },
        lastError: "new instruction requires evidence invalidation",
      }));
      await writeRuntimeState(this.#deps.runtimePath, requested);
      const stopFailure = await this.stopOwnedWorkers(runtime, cwd, "redirect");
      if (stopFailure !== undefined) {
        const reason = `could not safely redirect task ${taskId}: ${stopFailure}`;
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(requested, taskId, (current) => ({ ...current, lastError: reason })),
        );
        return commitBlock({
          group: "lost-resource",
          kind: "resource-lost",
          summary:
            "Tandem couldn't confirm the worker stopped, so your new instruction wasn't applied.",
          detail: reason,
        });
      }
      const reviewerFailure = await this.closeReviewerPanes(runtime, cwd);
      if (reviewerFailure !== undefined) return commitBlock(reviewerFailure);
      const redirected = withInstruction(
        transitionTask(
          task,
          { type: "invalidate-evidence", head: task.reviewHead, generation: task.generation },
          this.#deps.context(),
        ),
      );
      const nextTask = {
        ...redirected,
        endpoints: workerEndpoints(redirected.endpoints ?? [], redirected.generation),
      };
      await store.update(task.id, task.revision, () => nextTask);
      await writeRuntimeState(
        this.#deps.runtimePath,
        replaceRuntimeTask(requested, taskId, (current) =>
          redirectedRuntime(current, redirected.generation, this.#deps.clock),
        ),
      );
      await this.#deps.publishTaskInbox(nextTask);
      return nextTask;
    });
  }

  private async stopOwnedWorkers(
    runtime: RuntimeTaskState,
    cwd: string,
    context: "control" | "redirect" | "reconcile",
  ): Promise<string | undefined> {
    let failure: string | undefined;
    for (const endpoint of runtime.endpoints) {
      const job = await workerJobOccupyingEndpoint(runtime.jobs, endpoint);
      const stopped = await stopWorkerPane(this.#deps.terminal, {
        endpoint,
        cwd,
        ...(job === undefined ? {} : { job }),
        goal: "pause",
        skipStopped: context !== "control",
      });
      if (stopped.status === "stopped") continue;
      if (stopped.status === "still-running") {
        failure =
          context === "reconcile"
            ? `stop request remains pending because pane ${endpoint.paneId} is still active`
            : `pane ${endpoint.paneId} still has an active worker`;
      } else {
        failure =
          context === "reconcile"
            ? `stop request could not stop pane ${endpoint.paneId}: ${describeError(stopped.error)}`
            : `pane ${endpoint.paneId} could not be proven stopped: ${describeError(stopped.error)}`;
      }
      if (context !== "control") return failure;
    }
    return failure;
  }

  /** Closes reviewer panes a redirect retires; returns the block cause for one that won't close. */
  private async closeReviewerPanes(
    runtime: RuntimeTaskState,
    cwd: string,
  ): Promise<BlockCause | undefined> {
    // ponytail: "verifier" stays matched so a legacy pane still gets handled here; see
    // LEGACY_ENDPOINT_ROLES.
    const reviewers = runtime.endpoints.filter(
      (endpoint) => endpoint.role === "reviewer" || endpoint.role === "verifier",
    );
    for (const endpoint of reviewers) {
      try {
        const job = workerJobForEndpoint(runtime.jobs, endpoint);
        await prepareWorkerTerminal(this.#deps.terminal, {
          endpoint,
          cwd,
          ...(job === undefined ? {} : { job }),
        });
        const stopped = await stopWorkerPane(this.#deps.terminal, {
          endpoint,
          cwd,
          ...(job === undefined ? {} : { job }),
          goal: "close",
          run: this.#deps.run,
          clock: () => Date.parse(this.#deps.clock()),
        });
        if (stopped.status === "foreign" || stopped.status === "unknown") throw stopped.error;
        if (stopped.status !== "stopped") throw new EndpointBusyError(endpoint);
      } catch (error) {
        if (this.#deps.terminal.isEndpointGone(error)) continue;
        const reason = `reviewer pane ${endpoint.paneId} could not close: ${describeError(error)}`;
        return {
          group: "lost-resource",
          kind: "resource-lost",
          summary:
            "A reviewer's terminal wouldn't close, so your new instruction couldn't be applied.",
          detail: reason,
          paneId: endpoint.paneId,
        };
      }
    }
    return undefined;
  }
}
