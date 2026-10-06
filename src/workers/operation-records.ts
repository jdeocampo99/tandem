import type { BlockCause, Clock, Endpoint, TaskRecord } from "../contracts.ts";
import { activeRuntimeJob, taskRuntime } from "../runtime/activity.ts";
import { withStateLock } from "../runtime/database.ts";
import { readRuntimeState, updateRuntimeState, writeRuntimeState } from "../runtime/persistence.ts";
import type {
  DurableEndpointLaunch,
  DurableJob,
  DurableOperationEffect,
  DurableReservation,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import {
  appendTaskJob,
  currentWriter,
  isRecord,
  replaceJob,
  replaceRuntimeTask,
} from "../service/records.ts";
import { type TaskEvent, type TaskTransitionContext, transitionTask } from "../tasks/lifecycle.ts";
import type { TaskStore } from "../tasks/store.ts";
import { failedJobRuntime } from "./job-settlement.ts";
import {
  claimedOperation,
  holdsClaim,
  type OperationClaim,
  operationSettled,
} from "./operation-claim.ts";

export type OperationRecordsDependencies = Readonly<{
  readonly home: string;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly clock: Clock;
  readonly context: () => TaskTransitionContext;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  readonly runtimeFor: (taskId: string) => Promise<RuntimeTaskState | undefined>;
  readonly blockTask: (taskId: string, reason: string, cause?: BlockCause) => Promise<TaskRecord>;
}>;

/**
 * The durable writes a workflow step makes under its operation claim. Each re-reads runtime state
 * under the store lock and does nothing, or throws, once the claim no longer fences the task.
 */
export class OperationRecords {
  readonly #deps: OperationRecordsDependencies;

  constructor(deps: OperationRecordsDependencies) {
    this.#deps = deps;
  }

  /** Releases a reservation that never launched, then blocks the task on `cause`. */
  async releaseAndBlock(
    taskId: string,
    reservationId: string,
    claim: OperationClaim,
    cause: BlockCause,
  ): Promise<void> {
    await this.releaseUnlaunchedTaskReservation(taskId, reservationId, claim);
    await this.blockIfOperationClaim(taskId, cause.detail, claim, cause);
  }

  async failJob(
    task: TaskRecord,
    job: DurableJob,
    reason: string,
    claim: OperationClaim,
    block = true,
    quarantine = false,
    cause?: BlockCause,
  ): Promise<void> {
    await withStateLock(this.#deps.home, async () => {
      await this.#deps.store.exclusive(async () => {
        const state = await readRuntimeState(this.#deps.runtimePath);
        const current = taskRuntime(state, task.id);
        const operation = current?.operation;
        const currentJob = current?.jobs.find((entry) => entry.id === job.id);
        // A job already settled, e.g. by a restart, is never failed again from an older snapshot.
        if (
          current === undefined ||
          currentJob === undefined ||
          !activeRuntimeJob(currentJob) ||
          !holdsClaim(operation, claim) ||
          operation.taskId !== task.id ||
          operation.jobId !== job.id ||
          job.taskId !== task.id ||
          job.operationId !== operation.id ||
          currentJob.operationId !== operation.id
        ) {
          return;
        }
        const next = replaceRuntimeTask(state, task.id, (entry) =>
          quarantine
            ? {
                ...entry,
                lastError: reason,
                operation: { ...operation, phase: "quarantined" as const, error: reason },
              }
            : {
                ...failedJobRuntime(entry, job.id, reason, this.#deps.clock()),
                operation: { ...operation, phase: "failed" as const, error: reason },
              },
        );
        await writeRuntimeState(this.#deps.runtimePath, next);
        if (quarantine || block) await this.#deps.blockTask(task.id, reason, cause);
      });
    });
  }

  async blockIfOperationClaim(
    taskId: string,
    reason: string,
    claim: OperationClaim,
    cause?: BlockCause,
  ): Promise<void> {
    await withStateLock(this.#deps.home, async () => {
      await this.#deps.store.exclusive(async (store) => {
        const runtime = await this.#deps.runtimeFor(taskId);
        const operation = runtime?.operation;
        if (
          runtime === undefined ||
          runtime.stopRequest !== undefined ||
          !holdsClaim(operation, claim) ||
          ["completed", "quarantined", "cancelled"].includes(operation.phase)
        ) {
          return;
        }
        const task = await store.read(taskId);
        if (task?.generation !== operation.generation) return;
        await this.#deps.blockTask(taskId, reason, cause);
      });
    });
  }

  async transitionIfOperationClaim(
    taskId: string,
    claim: OperationClaim,
    event: TaskEvent,
    allowedStages: readonly TaskRecord["stage"][] = ["queued"],
  ): Promise<boolean> {
    return withStateLock(this.#deps.home, async () =>
      this.#deps.store.exclusive(async (store) => {
        const state = await readRuntimeState(this.#deps.runtimePath);
        if (!holdsClaim(taskRuntime(state, taskId)?.operation, claim)) return false;
        const task = await store.read(taskId);
        if (task === undefined || !allowedStages.includes(task.stage)) return false;
        const next = transitionTask(task, event, this.#deps.context());
        await store.update(taskId, task.revision, () => next);
        return true;
      }),
    );
  }

  async setReservationPhase(
    taskId: string,
    phase: DurableReservation["phase"],
    claim: OperationClaim,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        claimedOperation(current, taskId, claim);
        return {
          ...current,
          ...(current.reservation === undefined
            ? {}
            : { reservation: { ...current.reservation, phase } }),
        };
      }),
    );
  }

  async recordOperationEffect(
    taskId: string,
    claim: OperationClaim,
    id: string,
    kind: DurableOperationEffect["kind"],
    phase: DurableOperationEffect["phase"],
    identity: string,
    receipt?: string,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        const operation = claimedOperation(current, taskId, claim);
        const effect: DurableOperationEffect = {
          id,
          kind,
          phase,
          createdAt: this.#deps.clock(),
          identity,
          ...(receipt === undefined ? {} : { receipt }),
        };
        const effects = operation.effects.some((entry) => entry.id === id)
          ? operation.effects.map((entry) => (entry.id === id ? { ...entry, ...effect } : entry))
          : [...operation.effects, effect];
        return {
          ...current,
          operation: {
            ...operation,
            effects,
          },
        };
      }),
    );
  }

  async withOperationEffect<Result>(
    taskId: string,
    claim: OperationClaim,
    generation: number,
    stages: readonly TaskRecord["stage"][],
    effect: (
      input: Readonly<{ readonly task: TaskRecord; readonly runtime: RuntimeTaskState }>,
    ) => Promise<Result>,
  ): Promise<Result | undefined> {
    return withStateLock(this.#deps.home, async () => {
      const permit = await this.#deps.store.exclusive(async (store) => {
        const task = await store.read(taskId);
        if (task === undefined || task.generation !== generation || !stages.includes(task.stage)) {
          return undefined;
        }
        const state = await readRuntimeState(this.#deps.runtimePath);
        const runtime = taskRuntime(state, taskId);
        if (
          runtime === undefined ||
          runtime.stopRequest !== undefined ||
          runtime.reservation?.operationId !== claim.id
        ) {
          return undefined;
        }
        if (operationSettled(claimedOperation(runtime, taskId, claim))) return undefined;
        return { task, runtime };
      });
      if (permit === undefined) return undefined;
      return effect(permit);
    });
  }

  async restoreResourceEffect(
    taskId: string,
    effect: DurableOperationEffect,
    claim: OperationClaim,
  ): Promise<boolean> {
    if (effect.receipt === undefined) return false;
    let value: unknown;
    try {
      value = JSON.parse(effect.receipt);
    } catch {
      return false;
    }
    if (!isRecord(value)) return false;
    if (effect.kind === "endpoint") {
      const required = ["sessionId", "workspaceId", "tabId", "paneId", "role", "generation"];
      if (!required.every((field) => field in value)) return false;
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
        replaceRuntimeTask(state, taskId, (current) => {
          if (!holdsClaim(current.operation, claim)) return current;
          return {
            ...current,
            endpoints: current.endpoints.some(
              (entry) => entry.terminal === value.terminal && entry.paneId === value.paneId,
            )
              ? current.endpoints
              : [...current.endpoints, value as unknown as Endpoint],
          };
        }),
      );
      return true;
    }
    if (effect.kind === "worktree") {
      const required = [
        "root",
        "path",
        "name",
        "baseHead",
        "branch",
        "leaseId",
        "leaseHolder",
        "leasedAt",
      ];
      if (!required.every((field) => field in value)) return false;
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
        replaceRuntimeTask(state, taskId, (current) => {
          if (!holdsClaim(current.operation, claim)) return current;
          return {
            ...current,
            ...(current.worktree === undefined
              ? { worktree: value as unknown as NonNullable<RuntimeTaskState["worktree"]> }
              : {}),
          };
        }),
      );
      return true;
    }
    return false;
  }

  async quarantineOperation(taskId: string, reason: string, claim: OperationClaim): Promise<void> {
    await withStateLock(this.#deps.home, async () => {
      await this.#deps.store.exclusive(async () => {
        await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
          replaceRuntimeTask(state, taskId, (current) => {
            if (
              !holdsClaim(current.operation, claim) ||
              current.stopRequest !== undefined ||
              operationSettled(current.operation)
            ) {
              return current;
            }
            return {
              ...current,
              lastError: reason,
              operation: {
                ...current.operation,
                phase: "quarantined" as const,
                error: reason,
              },
            };
          }),
        );
        const currentTask = await this.#deps.getTask(taskId);
        if (!["blocked", "cancelled", "completed", "merged"].includes(currentTask.stage)) {
          const cause: BlockCause = {
            group: "safety-stop",
            kind: "quarantined-unknown-outcome",
            summary:
              "Tandem couldn't trust its own saved record of this step, so it paused the task for you to look at.",
            detail: reason,
          };
          await this.#deps.blockTask(taskId, reason, cause);
        }
      });
    });
  }

  async appendJob(taskId: string, job: DurableJob, claim: OperationClaim): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        claimedOperation(current, taskId, claim);
        if (current.jobs.some(activeRuntimeJob)) {
          throw new Error(`runtime task ${taskId} already has an active job`);
        }
        return appendTaskJob(current, job);
      }),
    );
  }

  async updateJob(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
    transform: (job: DurableJob) => DurableJob,
  ): Promise<void> {
    await withStateLock(this.#deps.home, async () => {
      await this.#deps.store.exclusive(async () => {
        const state = await readRuntimeState(this.#deps.runtimePath);
        const runtime = taskRuntime(state, taskId);
        const operation = runtime?.operation;
        const job = runtime?.jobs.find((entry) => entry.id === jobId);
        if (
          runtime === undefined ||
          job === undefined ||
          !holdsClaim(operation, claim) ||
          operation.jobId !== jobId ||
          job.operationId !== operation.id ||
          runtime.stopRequest !== undefined ||
          operationSettled(operation) ||
          ["consumed", "failed"].includes(job.phase)
        ) {
          return;
        }
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(state, taskId, (current) => replaceJob(current, jobId, transform)),
        );
      });
    });
  }

  async saveEndpointLaunch(
    taskId: string,
    launch: DurableEndpointLaunch,
    claim: OperationClaim,
  ): Promise<boolean> {
    let claimed = false;
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        claimedOperation(current, taskId, claim);
        if (current.reservation?.id !== launch.reservationId) {
          throw new Error(`runtime task ${taskId} has no matching endpoint reservation`);
        }
        if (current.endpointLaunch !== undefined || currentWriter(current) !== undefined)
          return current;
        claimed = true;
        return { ...current, endpointLaunch: launch };
      }),
    );
    return claimed;
  }

  async releaseUnlaunchedTaskReservation(
    taskId: string,
    reservationId: string,
    claim?: OperationClaim,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        if (
          current.operation !== undefined &&
          (claim === undefined || !holdsClaim(current.operation, claim))
        ) {
          return current;
        }
        if (
          current.operation?.phase === "quarantined" ||
          current.reservation?.id !== reservationId ||
          current.reservation.phase === "released" ||
          current.endpointLaunch !== undefined ||
          current.endpoints.length > 0 ||
          current.jobs.some(activeRuntimeJob)
        ) {
          return current;
        }
        return {
          ...current,
          ...(current.operation === undefined
            ? {}
            : { operation: { ...current.operation, phase: "failed" as const } }),
          reservation: {
            ...current.reservation,
            phase: "released",
            releasedAt: this.#deps.clock(),
          },
        };
      }),
    );
  }

  /**
   * Records the task's worktree. When it was adopted from `adoptedFrom`'s scout, the scout's record
   * of the same lease is dropped in the same write, so scout cleanup can never release it.
   */
  async saveWorktree(
    taskId: string,
    worktree: NonNullable<RuntimeTaskState["worktree"]>,
    claim: OperationClaim,
    adoptedFrom?: string,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) => {
      const saved = replaceRuntimeTask(state, taskId, (current) => {
        claimedOperation(current, taskId, claim);
        return {
          ...current,
          worktree,
          ...(current.reservation === undefined
            ? {}
            : { reservation: { ...current.reservation, phase: "worktree" } }),
        };
      });
      const scout = adoptedFrom === undefined ? undefined : taskRuntime(saved, adoptedFrom);
      if (adoptedFrom === undefined || scout?.worktree?.leaseId !== worktree.leaseId) return saved;
      return replaceRuntimeTask(saved, adoptedFrom, ({ worktree: _adopted, ...rest }) => rest);
    });
  }

  async saveEndpoint(taskId: string, endpoint: Endpoint, claim?: OperationClaim): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        if (current.operation !== undefined && claim === undefined) {
          throw new Error(`runtime task ${taskId} operation claim is required`);
        }
        if (claim !== undefined) claimedOperation(current, taskId, claim);
        const launch = current.endpointLaunch;
        const operation = current.operation;
        const completesEndpointEffect =
          claim !== undefined &&
          operation !== undefined &&
          launch?.operationId === claim.id &&
          launch.operationId === operation.id;
        const effects = completesEndpointEffect
          ? operation.effects.map((effect) =>
              effect.id === `endpoint:${claim.id}` && effect.kind === "endpoint"
                ? {
                    ...effect,
                    phase: "succeeded" as const,
                    receipt: JSON.stringify(endpoint),
                  }
                : effect,
            )
          : operation?.effects;
        const { endpointLaunch: _endpointLaunch, ...withoutLaunch } = current;
        return {
          ...withoutLaunch,
          ...(operation === undefined || effects === undefined
            ? {}
            : { operation: { ...operation, effects } }),
          endpoints: [
            ...current.endpoints.filter((candidate) => candidate.paneId !== endpoint.paneId),
            endpoint,
          ],
          ...(current.reservation === undefined
            ? {}
            : { reservation: { ...current.reservation, phase: "endpoint" } }),
        };
      }),
    );
  }
}
