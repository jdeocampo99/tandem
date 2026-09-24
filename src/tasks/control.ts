import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readCheckpoint } from "../adapters/git.ts";
import { closeEndpoint, type HerdrPaneInspection, inspectEndpoint } from "../adapters/herdr.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type {
  BlockCause,
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  TaskRecord,
} from "../contracts.ts";
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
  absoluteDirectory,
  currentWriter,
  DEFAULT_STARTUP_GRACE_MS,
  describeError,
  isMissing,
  isMissingEndpoint,
  isOlderThan,
  isRecord,
  replaceRuntimeTask,
  singleLine,
  text,
} from "../service/records.ts";
import { taskSourcePath } from "../service/source.ts";
import { readValidationResult } from "../validation-worker.ts";
import { readWorkerResult } from "../workers/jobs.ts";
import type { OperationClaim } from "../workers/operation-claim.ts";
import { workerDelegationStopped } from "../workers/terminal.ts";
import {
  pauseWorkerTerminal,
  prepareWorkerTerminal,
  workerJobForEndpoint,
} from "../workers/terminal-control.ts";
import { appendTaskMessage } from "./communication-protocol.ts";
import { type TaskEvent, type TaskTransitionContext, transitionTask } from "./lifecycle.ts";
import type { TaskStore } from "./store.ts";

type ControlAction = "pause" | "cancel";
type HerdrWorkspaceObservation = Readonly<{
  readonly workspaceId: string;
  readonly activeTabId: string;
  readonly label: string;
}>;
type HerdrPaneObservation = Readonly<{
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly foregroundCwd: string | undefined;
}>;
type EndpointLaunchRecovery =
  | Readonly<{ readonly status: "recovered"; readonly endpoint: Endpoint }>
  | Readonly<{ readonly status: "pending"; readonly detail: string }>
  | Readonly<{ readonly status: "ambiguous"; readonly detail: string }>;
type OwnedEndpointProbe = Readonly<{
  readonly status: "active" | "stopped" | "missing" | "rejected";
  readonly detail: string | undefined;
}>;

function sameEndpointLaunch(
  left: DurableEndpointLaunch | undefined,
  right: DurableEndpointLaunch,
): boolean {
  return (
    left !== undefined &&
    left.schemaVersion === right.schemaVersion &&
    left.reservationId === right.reservationId &&
    left.operationId === right.operationId &&
    left.sessionId === right.sessionId &&
    left.taskName === right.taskName &&
    left.workspaceLabel === right.workspaceLabel &&
    left.cwd === right.cwd &&
    left.role === right.role &&
    left.generation === right.generation &&
    left.createdAt === right.createdAt &&
    left.parentWorkspaceId === right.parentWorkspaceId
  );
}
type TerminalResultProbe =
  | Readonly<{ readonly status: "valid" }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{ readonly status: "invalid"; readonly detail: string }>;
type ResumeResourceCheck = Readonly<{
  readonly failure: string | undefined;
  readonly abandonedJobIds: readonly string[];
  readonly terminalJobIds: readonly string[];
}>;

export type TaskControlDependencies = Readonly<{
  readonly home: string;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly sessionId: string;
  readonly run: CommandRunner;
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
}>;

function parseHerdrPayload(raw: string, operation: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) throw new Error(`${operation} returned a non-object response`);
  return parsed;
}

async function readHerdrPayload(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
  args: readonly string[],
  operation: string,
): Promise<Record<string, unknown>> {
  const result = await run({
    argv: ["herdr", "--session", singleLine(sessionId, "sessionId"), ...args],
    cwd: absoluteDirectory(cwd, "cwd"),
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim().length === 0 ? result.stdout.trim() : result.stderr.trim();
    throw new Error(`${operation} failed with exit code ${result.code}: ${detail}`);
  }
  return parseHerdrPayload(result.stdout, operation);
}

function herdrResult(payload: Record<string, unknown>, operation: string): Record<string, unknown> {
  const result = payload.result;
  if (!isRecord(result)) throw new Error(`${operation} response.result must be an object`);
  return result;
}

function requiredHerdrText(value: unknown, field: string, operation: string): string {
  try {
    return singleLine(value, field);
  } catch (error) {
    throw new Error(`${operation} ${field} is invalid: ${describeError(error)}`, { cause: error });
  }
}

function parseHerdrWorkspaces(
  payload: Record<string, unknown>,
  operation: string,
): readonly HerdrWorkspaceObservation[] {
  const workspaces = herdrResult(payload, operation).workspaces;
  if (!Array.isArray(workspaces))
    throw new Error(`${operation} response.result.workspaces must be an array`);
  return workspaces.map((value, index) => {
    if (!isRecord(value)) throw new Error(`${operation} workspace ${index} must be an object`);
    return {
      workspaceId: requiredHerdrText(
        value.workspace_id,
        `workspace[${index}].workspace_id`,
        operation,
      ),
      activeTabId: requiredHerdrText(
        value.active_tab_id,
        `workspace[${index}].active_tab_id`,
        operation,
      ),
      label: requiredHerdrText(value.label, `workspace[${index}].label`, operation),
    };
  });
}

function parseHerdrPanes(
  payload: Record<string, unknown>,
  operation: string,
): readonly HerdrPaneObservation[] {
  const panes = herdrResult(payload, operation).panes;
  if (!Array.isArray(panes)) throw new Error(`${operation} response.result.panes must be an array`);
  return panes.map((value, index) => {
    if (!isRecord(value)) throw new Error(`${operation} pane ${index} must be an object`);
    const foregroundCwd =
      value.foreground_cwd === undefined
        ? undefined
        : requiredHerdrText(value.foreground_cwd, `pane[${index}].foreground_cwd`, operation);
    return {
      paneId: requiredHerdrText(value.pane_id, `pane[${index}].pane_id`, operation),
      tabId: requiredHerdrText(value.tab_id, `pane[${index}].tab_id`, operation),
      workspaceId: requiredHerdrText(value.workspace_id, `pane[${index}].workspace_id`, operation),
      cwd: requiredHerdrText(value.cwd, `pane[${index}].cwd`, operation),
      foregroundCwd,
    };
  });
}

async function samePhysicalDirectory(expected: string, actual: string): Promise<boolean> {
  try {
    const [expectedPath, actualPath] = await Promise.all([realpath(expected), realpath(actual)]);
    return expectedPath === actualPath;
  } catch {
    return resolve(expected) === resolve(actual);
  }
}

export async function recoverEndpointFromLaunch(
  run: CommandRunner,
  intent: DurableEndpointLaunch,
): Promise<EndpointLaunchRecovery> {
  let workspaces: readonly HerdrWorkspaceObservation[];
  try {
    workspaces = parseHerdrWorkspaces(
      await readHerdrPayload(
        run,
        intent.sessionId,
        intent.cwd,
        ["workspace", "list"],
        "herdr workspace list",
      ),
      "herdr workspace list",
    );
  } catch (error) {
    return {
      status: "pending",
      detail: `workspace recovery is unavailable: ${describeError(error)}`,
    };
  }
  const matches = workspaces.filter((workspace) => workspace.label === intent.workspaceLabel);
  if (matches.length === 0) {
    return {
      status: "pending",
      detail: `no Herdr workspace has label ${JSON.stringify(intent.workspaceLabel)}`,
    };
  }
  if (matches.length !== 1) {
    return {
      status: "ambiguous",
      detail: `Herdr workspace label ${JSON.stringify(intent.workspaceLabel)} matched ${matches.length} workspaces`,
    };
  }
  const workspace = matches[0];
  if (workspace === undefined) {
    return { status: "pending", detail: "Herdr workspace recovery returned no selected workspace" };
  }
  let panes: readonly HerdrPaneObservation[];
  try {
    panes = parseHerdrPanes(
      await readHerdrPayload(
        run,
        intent.sessionId,
        intent.cwd,
        ["pane", "list", "--workspace", workspace.workspaceId],
        "herdr pane list",
      ),
      "herdr pane list",
    );
  } catch (error) {
    return { status: "pending", detail: `pane recovery is unavailable: ${describeError(error)}` };
  }
  const candidates: HerdrPaneObservation[] = [];
  for (const pane of panes) {
    if (pane.workspaceId !== workspace.workspaceId || pane.tabId !== workspace.activeTabId)
      continue;
    if (!(await samePhysicalDirectory(intent.cwd, pane.cwd))) continue;
    if (
      pane.foregroundCwd !== undefined &&
      !(await samePhysicalDirectory(intent.cwd, pane.foregroundCwd))
    ) {
      continue;
    }
    candidates.push(pane);
  }
  if (candidates.length === 0) {
    return {
      status: "pending",
      detail: `workspace ${workspace.workspaceId} has no unique root pane at ${intent.cwd}`,
    };
  }
  if (candidates.length !== 1) {
    return {
      status: "ambiguous",
      detail: `workspace ${workspace.workspaceId} has ${candidates.length} matching root panes`,
    };
  }
  const pane = candidates[0];
  if (pane === undefined)
    return { status: "pending", detail: "Herdr root pane recovery returned no pane" };
  return {
    status: "recovered",
    endpoint: {
      sessionId: intent.sessionId,
      workspaceId: workspace.workspaceId,
      tabId: pane.tabId,
      paneId: pane.paneId,
      role: intent.role,
      generation: intent.generation,
    },
  };
}

export class TaskControlWorkflow {
  readonly #deps: TaskControlDependencies;

  constructor(deps: TaskControlDependencies) {
    this.#deps = deps;
  }

  private async mutateIfOperationClaim(
    task: TaskRecord,
    claim: OperationClaim | undefined,
    reason: string,
    block: boolean,
    expectedLaunch?: DurableEndpointLaunch,
    cause?: BlockCause,
  ): Promise<boolean> {
    return withStateLock(this.#deps.home, async () =>
      this.#deps.store.exclusive(async (store) => {
        const currentTask = await store.read(task.id);
        if (currentTask === undefined || currentTask.generation !== task.generation) {
          return false;
        }
        const state = await readRuntimeState(this.#deps.runtimePath);
        const current = taskRuntime(state, task.id);
        const operation = current?.operation;
        const owns =
          claim === undefined
            ? operation === undefined
            : operation?.id === claim.id &&
              operation.claimOwner === claim.claimOwner &&
              operation.fencingRevision === claim.fencingRevision;
        if (
          !owns ||
          (expectedLaunch !== undefined &&
            (current?.reservation?.id !== expectedLaunch.reservationId ||
              current?.reservation?.operationId !== expectedLaunch.operationId ||
              !sameEndpointLaunch(current?.endpointLaunch, expectedLaunch))) ||
          current?.stopRequest !== undefined
        ) {
          return false;
        }
        if (current !== undefined) {
          await writeRuntimeState(
            this.#deps.runtimePath,
            replaceRuntimeTask(state, task.id, (entry) => ({
              ...entry,
              lastError: reason,
            })),
          );
        }
        if (
          block &&
          currentTask.stage !== "cancelled" &&
          currentTask.stage !== "completed" &&
          currentTask.stage !== "merged" &&
          currentTask.stage !== "paused" &&
          currentTask.stage !== "blocked"
        ) {
          await store.update(currentTask.id, currentTask.revision, (entry) =>
            transitionTask(
              entry,
              {
                type: "block",
                reason: text(cause?.summary ?? reason, "block reason"),
                ...(cause === undefined ? {} : { cause }),
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
    const claim: OperationClaim | undefined =
      runtime.operation === undefined
        ? undefined
        : {
            id: runtime.operation.id,
            fencingRevision: runtime.operation.fencingRevision,
            claimOwner: runtime.operation.claimOwner,
          };
    if (runtime.stopRequest !== undefined) return runtime;
    if (runtime.reservation?.ownerSessionId !== this.#deps.sessionId) {
      await this.mutateIfOperationClaim(
        task,
        claim,
        "endpoint launch is owned by another session; recovery was not attempted",
        false,
        launch,
      );
      return undefined;
    }
    return withStateLock(this.#deps.home, async () => {
      const recovery = await recoverEndpointFromLaunch(this.#deps.run, launch);
      if (recovery.status !== "recovered") {
        const reason =
          recovery.status === "ambiguous"
            ? `endpoint recovery is ambiguous: ${recovery.detail}`
            : `endpoint recovery is pending: ${recovery.detail}`;
        await this.mutateIfOperationClaim(
          task,
          claim,
          reason,
          recovery.status === "ambiguous" ||
            isOlderThan(launch.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS),
          launch,
          {
            group: "lost-resource",
            kind: "resource-lost",
            summary: "Tandem couldn't find the worker's terminal after a restart.",
            detail: reason,
          },
        );
        return undefined;
      }
      const currentTask = await this.#deps.getTask(task.id);
      const current = await this.#deps.runtimeFor(task.id);
      if (
        current === undefined ||
        current.stopRequest !== undefined ||
        current.reservation?.id !== launch.reservationId ||
        current.reservation?.ownerSessionId !== this.#deps.sessionId ||
        current.reservation?.operationId !== launch.operationId ||
        !sameEndpointLaunch(current.endpointLaunch, launch) ||
        (claim === undefined
          ? launch.operationId !== undefined || current.operation !== undefined
          : launch.operationId !== claim.id ||
            current.operation?.id !== claim.id ||
            current.operation?.claimOwner !== claim.claimOwner ||
            current.operation?.fencingRevision !== claim.fencingRevision) ||
        currentTask.generation !== launch.generation
      ) {
        return undefined;
      }
      try {
        await this.#deps.saveEndpoint(task.id, recovery.endpoint, claim);
      } catch (error) {
        if (
          !(await this.mutateIfOperationClaim(
            task,
            claim,
            `recovered endpoint identity could not be persisted: ${describeError(error)}`,
            false,
            launch,
          ))
        ) {
          return undefined;
        }
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
      const prepared = await this.#deps.store.exclusive(async (store) => {
        const task = await store.read(taskId);
        if (task === undefined || !(await this.#deps.taskInScope(task))) {
          throw new Error(`task ${taskId} is missing`);
        }
        const terminal =
          task.stage === "cancelled" || task.stage === "completed" || task.stage === "merged";
        const state = await readRuntimeState(this.#deps.runtimePath);
        const runtime = taskRuntime(state, taskId);
        if (terminal) return { kind: "terminal" as const, task, runtime };
        if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
        const event: TaskEvent =
          action === "pause"
            ? { type: "pause", reason: reason ?? "paused by coordinator" }
            : { type: "cancel", ...(reason === undefined ? {} : { reason }) };
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
        return { kind: "active" as const, task, runtime, event };
      });
      if (prepared.kind === "terminal") {
        if (prepared.runtime !== undefined) {
          const resources = await this.inspectOwnedResources(prepared.task, prepared.runtime);
          if (
            resources.failure !== undefined ||
            resources.abandonedJobIds.length > 0 ||
            resources.terminalJobIds.length > 0
          ) {
            throw new Error(
              `cannot confirm task ${taskId} is stopped: ${
                resources.failure ?? "a durable worker job remains"
              }`,
            );
          }
        }
        return prepared.task;
      }
      const { task, runtime, event } = prepared;
      const cwd = runtime.worktree?.path ?? taskSourcePath(task, runtime);
      let stopFailure: string | undefined;
      for (const endpoint of runtime.endpoints) {
        const job = workerJobForEndpoint(runtime.jobs, endpoint);
        try {
          await pauseWorkerTerminal(this.#deps.run, {
            endpoint,
            cwd,
            ...(job === undefined ? {} : { job }),
          });
          const inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
          if (!(await workerDelegationStopped(inspection, job))) {
            stopFailure = `pane ${endpoint.paneId} still has an active worker`;
          }
        } catch (error) {
          if (isMissingEndpoint(error)) continue;
          stopFailure = `pane ${endpoint.paneId} could not be proven stopped: ${describeError(error)}`;
        }
      }
      if (runtime.jobs.some(activeRuntimeJob) && runtime.endpoints.length === 0) {
        stopFailure = "a durable worker job has no endpoint identity";
      }

      return this.#deps.store.exclusive(async (store) => {
        const current = await store.read(taskId);
        if (current === undefined) throw new Error(`task ${taskId} is missing`);
        const state = await readRuntimeState(this.#deps.runtimePath);
        if (stopFailure !== undefined) {
          const blockedReason = `could not safely ${action} task ${taskId}: ${stopFailure}`;
          const cause: BlockCause = {
            group: "lost-resource",
            kind: "resource-lost",
            summary: `Tandem couldn't confirm the worker stopped, so it couldn't ${action} the task.`,
            detail: blockedReason,
          };
          const failedState = replaceRuntimeTask(state, taskId, (entry) => ({
            ...entry,
            lastError: blockedReason,
          }));
          await writeRuntimeState(this.#deps.runtimePath, failedState);
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
        const planned = transitionTask(current, event, this.#deps.context());
        await store.update(current.id, current.revision, () => planned);
        return planned;
      });
    });
  }

  async resumeTask(taskId: string): Promise<TaskRecord> {
    const outcome = await this.releaseStoppedTask(taskId, { type: "resume" });
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
    const outcome = await this.releaseStoppedTask(taskId, {
      type: "skip-review",
      head: checkout.head,
    });
    return outcome.task;
  }

  /**
   * Proves a paused or blocked task's owned workers are stopped, settles their abandoned jobs,
   * clears the stop request, and applies `event` in the same step.
   */
  private async releaseStoppedTask(
    taskId: string,
    event: TaskEvent,
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
      const abandonedJobIds = new Set(resources.abandonedJobIds);
      const resumed = transitionTask(task, event, this.#deps.context());
      const clearStopRequest = replaceRuntimeTask(state, taskId, (current) => {
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
                        error:
                          "worker stopped before writing a terminal result; continuation will be dispatched",
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
          reservation: {
            ...reservation,
            phase: "released",
            releasedAt: this.#deps.clock(),
          },
        };
      });
      await writeRuntimeState(this.#deps.runtimePath, clearStopRequest);
      await store.update(task.id, task.revision, () => resumed);
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
      await this.resumeTask(taskId);
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
    await this.resumeTask(taskId);
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
      const inspection: HerdrPaneInspection = await inspectEndpoint(this.#deps.run, {
        endpoint,
        cwd,
      });
      return (await workerDelegationStopped(inspection, job))
        ? { status: "stopped", detail: undefined }
        : { status: "active", detail: `pane ${endpoint.paneId} still has an active worker` };
    } catch (error) {
      if (error instanceof EndpointOwnershipError && error.reason === "missing") {
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
    const cwd = runtime.worktree?.path ?? taskSourcePath(task, runtime);
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
        workerJobForEndpoint(runtime.jobs, endpoint),
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
        const settled = replaceRuntimeTask(state, taskId, (current) => {
          const { stopRequest: _stopRequest, ...withoutStopRequest } = current;
          const jobs = current.jobs.map((job) =>
            activeRuntimeJob(job)
              ? {
                  ...job,
                  phase: "failed" as const,
                  error: "worker stopped after task cancellation",
                }
              : job,
          );
          return {
            ...withoutStopRequest,
            endpoints: [],
            jobs,
            ...(current.operation === undefined
              ? {}
              : {
                  operation: {
                    ...current.operation,
                    phase: "cancelled" as const,
                  },
                }),
            ...(current.reservation === undefined || current.reservation.phase === "released"
              ? {}
              : {
                  reservation: {
                    ...current.reservation,
                    phase: "released" as const,
                    releasedAt: this.#deps.clock(),
                  },
                }),
          };
        });
        await writeRuntimeState(this.#deps.runtimePath, settled);
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
    const cwd = runtime.worktree?.path ?? taskSourcePath(task, runtime);

    for (const endpoint of runtime.endpoints) {
      try {
        const job = workerJobForEndpoint(runtime.jobs, endpoint);
        let inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        if (!(await workerDelegationStopped(inspection, job))) {
          await pauseWorkerTerminal(this.#deps.run, {
            endpoint,
            cwd,
            ...(job === undefined ? {} : { job }),
          });
          inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        }
        if (!(await workerDelegationStopped(inspection, job))) {
          await this.#deps.setRuntimeError(
            task.id,
            `stop request remains pending because pane ${endpoint.paneId} is still active`,
          );
          return;
        }
      } catch (error) {
        if (isMissingEndpoint(error)) continue;
        await this.#deps.setRuntimeError(
          task.id,
          `stop request could not stop pane ${endpoint.paneId}: ${describeError(error)}`,
        );
        return;
      }
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
    if (task.stage === "cancelled" || task.stage === "completed" || task.stage === "merged") {
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
              text: instruction.text,
              createdAt: this.#deps.clock(),
              ...(instruction.supersedes === undefined
                ? {}
                : { supersedes: instruction.supersedes }),
            });
      const withInstruction = (candidate: TaskRecord): TaskRecord =>
        instruction === undefined || communication === undefined
          ? candidate
          : { ...candidate, communication };
      const targetStages = ["validating", "reviewing", "ready", "awaiting-fixes"];
      if (!targetStages.includes(task.stage)) {
        if (instruction === undefined) return task;
        const updated = await store.update(task.id, task.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          updatedAt: this.#deps.clock(),
          ...(communication === undefined ? {} : { communication }),
        }));
        await this.#deps.publishTaskInbox(updated);
        return updated;
      }
      if (task.reviewHead === undefined) {
        const reason = "cannot redirect task without reviewed HEAD";
        const cause: BlockCause = {
          group: "user-decision",
          kind: "prerequisite-not-met",
          summary: "There's no reviewed work yet, so a new instruction can't be applied.",
          detail: reason,
        };
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
      }
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const cwd = runtime.worktree?.path ?? taskSourcePath(task, runtime);
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
      let stopFailure: string | undefined;
      for (const endpoint of runtime.endpoints) {
        try {
          const job = workerJobForEndpoint(runtime.jobs, endpoint);
          let inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
          if (!(await workerDelegationStopped(inspection, job))) {
            await pauseWorkerTerminal(this.#deps.run, {
              endpoint,
              cwd,
              ...(job === undefined ? {} : { job }),
            });
            inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
          }
          if (!(await workerDelegationStopped(inspection, job))) {
            stopFailure = `pane ${endpoint.paneId} still has an active worker`;
            break;
          }
        } catch (error) {
          stopFailure = `pane ${endpoint.paneId} could not be proven stopped: ${describeError(error)}`;
          break;
        }
      }
      if (stopFailure !== undefined) {
        const reason = `could not safely redirect task ${taskId}: ${stopFailure}`;
        const cause: BlockCause = {
          group: "lost-resource",
          kind: "resource-lost",
          summary:
            "Tandem couldn't confirm the worker stopped, so your new instruction wasn't applied.",
          detail: reason,
        };
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(requested, taskId, (current) => ({ ...current, lastError: reason })),
        );
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
      }
      // ponytail: "verifier" stays matched so a legacy pane still gets handled here; see
      // LEGACY_ENDPOINT_ROLES.
      const reviewers = runtime.endpoints.filter(
        (endpoint) => endpoint.role === "reviewer" || endpoint.role === "verifier",
      );
      for (const endpoint of reviewers) {
        try {
          const job = workerJobForEndpoint(runtime.jobs, endpoint);
          await prepareWorkerTerminal(this.#deps.run, {
            endpoint,
            cwd,
            ...(job === undefined ? {} : { job }),
          });
          await closeEndpoint(this.#deps.run, { endpoint, cwd });
        } catch (error) {
          if (!isMissingEndpoint(error)) {
            const reason = `reviewer pane ${endpoint.paneId} could not close: ${describeError(error)}`;
            const cause: BlockCause = {
              group: "lost-resource",
              kind: "resource-lost",
              summary:
                "A reviewer's terminal wouldn't close, so your new instruction couldn't be applied.",
              detail: reason,
              paneId: endpoint.paneId,
            };
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
          }
        }
      }
      const redirected = withInstruction(
        transitionTask(
          task,
          { type: "invalidate-evidence", head: task.reviewHead, generation: task.generation },
          this.#deps.context(),
        ),
      );
      const endpoints = (redirected.endpoints ?? [])
        .filter((endpoint) => endpoint.role === "scout" || endpoint.role === "implementer")
        .map((endpoint) => ({ ...endpoint, generation: redirected.generation }));
      const nextTask = { ...redirected, endpoints };
      await store.update(task.id, task.revision, () => nextTask);
      const nextRuntime = replaceRuntimeTask(requested, taskId, (current) => {
        const jobs = current.jobs.map((job) =>
          activeRuntimeJob(job)
            ? {
                ...job,
                phase: "failed" as const,
                error: "job invalidated by newer user instruction",
              }
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
          // Every owned worker was proven stopped above, which answers a quarantined outcome.
          ...(current.operation?.phase === "quarantined"
            ? { operation: { ...current.operation, phase: "failed" as const } }
            : {}),
          endpoints: current.endpoints
            .filter((endpoint) => endpoint.role === "scout" || endpoint.role === "implementer")
            .map((endpoint) => ({ ...endpoint, generation: redirected.generation })),
          jobs,
          ...(reservation === undefined
            ? {}
            : {
                reservation: {
                  ...reservation,
                  phase: "released" as const,
                  releasedAt: this.#deps.clock(),
                },
              }),
        };
      });
      await writeRuntimeState(this.#deps.runtimePath, nextRuntime);
      await this.#deps.publishTaskInbox(nextTask);
      return nextTask;
    });
  }
}
