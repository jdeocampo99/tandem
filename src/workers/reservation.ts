import { join } from "node:path";
import type { Clock, IdFactory, TaskRecord } from "../contracts.ts";
import { taskRuntime } from "../runtime/activity.ts";
import { readRuntimeState, taskJobsDirectory, writeRuntimeState } from "../runtime/persistence.ts";
import type { DurableExecutionRouting, RuntimeTaskState } from "../runtime/schema.ts";
import { type RequestUsageReadout, requestUsageExposure } from "../runtime/usage-receipt.ts";
import {
  durableOperation,
  modelRoleForTask,
  replaceRuntimeTask,
  reviewFindings,
  runtimeReservation,
  singleLine,
} from "../service/records.ts";
import { taskSourcePath } from "../service/source.ts";
import { policyIdentity } from "../tasks/acceptance.ts";
import type { TaskTransitionContext } from "../tasks/lifecycle.ts";
import type { TaskStore, TaskStoreTransaction } from "../tasks/store.ts";
import {
  type AdmissionRole,
  attemptNumber,
  fixRoundTask,
  isFixAdmission,
  operationKindFor,
  priorExecutionAttempt,
  type ReservationRefusal,
  type ReservationResult,
  type RoutingAttempt,
  routingBoundary,
  routingLimits,
  runtimeAdmissionRefusal,
  taskAdmissionRefusal,
} from "./admission.ts";
import {
  describeExecutionRoutingDecision,
  type ExecutionUsageObservation,
  executionRoutingPauseStands,
  type ModelCatalogueReader,
  type ModelCatalogueSnapshot,
  type RaisedExecutionRoutingPause,
  resolveExecutionRouting,
  routingPauseExplanation,
} from "./execution-routing.ts";

export type TaskReservationsDependencies = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  /** The owner this coordinator stamps on every operation it admits or takes over. */
  readonly claimOwner: string;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly context: () => TaskTransitionContext;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
  /** The accounting ledger's own rows for one request, read for economical routing's usage check. */
  readonly readRequestUsage: (requestId: string) => Promise<RequestUsageReadout>;
  /** Reads catalogue tier evidence at an execution boundary; it never enables a provider. */
  readonly readModelCatalogue: ModelCatalogueReader;
}>;

/** Admits durable operations, reserving a task's worker slot and deciding its execution model. */
export class TaskReservations {
  readonly #deps: TaskReservationsDependencies;

  constructor(deps: TaskReservationsDependencies) {
    this.#deps = deps;
  }

  /**
   * Admits one new durable operation for `role` and reserves the task's worker slot for it, or
   * says why nothing was admitted. A fix round also moves the task into its new generation here,
   * in the same critical section, so the admitted operation and the task never disagree.
   */
  async reserveTask(
    taskId: string,
    role: AdmissionRole,
  ): Promise<ReservationResult | ReservationRefusal> {
    return this.#deps.store.exclusive<ReservationResult | ReservationRefusal>(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      const taskRefusal = taskAdmissionRefusal(task, role);
      if (taskRefusal !== undefined) return taskRefusal;
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const runtimeRefusal = runtimeAdmissionRefusal(state, runtime, task.policy.config.maxWorkers);
      if (runtimeRefusal !== undefined) return runtimeRefusal;
      const isFix = isFixAdmission(task, role);
      const operationId = singleLine(this.#deps.idFactory(), "operation id");
      const inputHead = task.reviewHead ?? runtime.sourceCheckpoint.head;
      const targetTask = isFix ? fixRoundTask(task, inputHead, this.#deps.context()) : task;
      const jobId = singleLine(this.#deps.idFactory(), "operation job id");
      const policyDigest = policyIdentity(targetTask.policy);
      const routing =
        role === "validation"
          ? undefined
          : await this.resolveRouting(store, targetTask, runtime, {
              role,
              operationId,
              jobId,
              inputHead,
              policyDigest,
              cwd: runtime.worktree?.path ?? taskSourcePath(targetTask, runtime),
            });
      if (routing !== undefined && !("basis" in routing)) {
        return {
          refusal: "routing-question",
          summary: `A routing question is waiting: ${routingPauseExplanation(routing)}`,
          detail: `routing decision ${routing.decisionId} (${routing.reason})`,
        };
      }
      const operation = {
        ...durableOperation(
          operationId,
          taskId,
          operationKindFor(role, isFix),
          role,
          targetTask.generation,
          inputHead,
          policyDigest,
          targetTask.communication?.revision ?? 0,
          jobId,
          this.#deps.claimOwner,
          this.#deps.clock(),
        ),
        phase: "admitted" as const,
        ...(routing === undefined ? {} : { routing }),
        ...(isFix
          ? {
              fixContext: {
                head: inputHead,
                generation: task.generation,
                validationEvidence: task.validationEvidence,
                findings: reviewFindings(task),
              },
            }
          : {}),
      };
      const reservation = runtimeReservation(
        singleLine(this.#deps.idFactory(), "reservation id"),
        taskId,
        this.#deps.sessionId,
        this.#deps.clock(),
        operation.id,
      );
      const { routingPause: _answered, ...admittedRuntime } = runtime;
      const nextRuntime = {
        ...admittedRuntime,
        operation,
        ...(runtime.operation === undefined
          ? {}
          : { operationHistory: [...(runtime.operationHistory ?? []), runtime.operation] }),
        reservation,
        ...(isFix
          ? {
              fixContextPath: join(
                taskJobsDirectory(this.#deps.home, task.id),
                `fix-context-${targetTask.generation}.json`,
              ),
              endpoints: runtime.endpoints.map((endpoint) => ({
                ...endpoint,
                generation: targetTask.generation,
              })),
            }
          : {}),
      };
      if (isFix) await store.update(task.id, task.revision, () => targetTask);
      const admitted = replaceRuntimeTask(state, taskId, () => nextRuntime);
      await writeRuntimeState(this.#deps.runtimePath, admitted);
      return { task: targetTask, runtime: nextRuntime, reservation };
    });
  }

  async claimOperation(taskId: string): Promise<RuntimeTaskState | undefined> {
    let claimed: RuntimeTaskState | undefined;
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime?.operation === undefined) return;
      const operation = runtime.operation;
      if (
        runtime.stopRequest !== undefined ||
        !["admitted", "prepared"].includes(operation.phase) ||
        runtime.jobs.some((job) => job.id === operation.jobId && job.launchAttempted) ||
        operation.effects.some(
          (effect) => effect.id === operation.jobId || effect.id === `execution:${operation.jobId}`,
        )
      ) {
        return;
      }
      const next = replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        ...(current.operation === undefined
          ? {}
          : {
              operation: {
                ...current.operation,
                claimOwner: this.#deps.claimOwner,
                fencingRevision: current.operation.fencingRevision + 1,
              },
            }),
        ...(current.reservation === undefined
          ? {}
          : { reservation: { ...current.reservation, ownerSessionId: this.#deps.sessionId } }),
      }));
      await writeRuntimeState(this.#deps.runtimePath, next);
      claimed = taskRuntime(next, taskId);
    });
    return claimed;
  }

  /**
   * Resolves which exact model this attempt may invoke, at the one boundary that decides it.
   * Returns the transition to record on the admitting operation, or the routing question the task
   * stops on, which it records once and never asks again while it still speaks.
   */
  private async resolveRouting(
    store: TaskStoreTransaction,
    task: TaskRecord,
    runtime: RuntimeTaskState,
    attempt: RoutingAttempt,
  ): Promise<DurableExecutionRouting | RaisedExecutionRoutingPause> {
    const identity = {
      role: attempt.role,
      generation: task.generation,
      policyDigest: attempt.policyDigest,
      inputHead: attempt.inputHead,
    };
    const modelRole = modelRoleForTask(task, attempt.role);
    const prior = priorExecutionAttempt(
      runtime,
      attempt.role,
      modelRole,
      task.policy.config.models,
    );
    // An uncertain-outcome question stops speaking once that attempt settles as a known failure.
    const settledUncertainty =
      runtime.routingPause?.reason === "prior-outcome-uncertain" && prior?.outcome !== "uncertain";
    if (!settledUncertainty && executionRoutingPauseStands(runtime.routingPause, identity)) {
      return runtime.routingPause;
    }
    const decision = resolveExecutionRouting({
      boundary: routingBoundary(prior),
      identity: {
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        taskId: task.id,
        jobId: attempt.jobId,
        operationId: attempt.operationId,
        role: attempt.role,
        generation: task.generation,
        attempt: attemptNumber(runtime, attempt.role),
        policyDigest: attempt.policyDigest,
        inputHead: attempt.inputHead,
      },
      pinned: task.policy.config.models[modelRole],
      catalogue: await this.readCatalogue(attempt.cwd),
      limits: routingLimits(task),
      usage: await this.observeRequestUsage(task),
      now: this.#deps.clock(),
    });
    if (decision.outcome === "authorized") return decision.routing;
    await this.stopTaskRouting(store, task, runtime, decision.pause);
    return decision.pause;
  }

  /**
   * What the request's own accounting ledger shows for this task's request, for economical
   * routing's usage-safety check. It only reads; it never decides whether work may continue.
   */
  private async observeRequestUsage(task: TaskRecord): Promise<ExecutionUsageObservation> {
    const requestId = task.requestId;
    if (requestId === undefined) return { status: "no-governing-request" };
    const readout = await this.#deps.readRequestUsage(requestId);
    return { status: "observed", exposure: requestUsageExposure(readout) };
  }

  /** Reads catalogue evidence without letting a boundary failure decide anything by itself. */
  private async readCatalogue(cwd: string): Promise<ModelCatalogueSnapshot> {
    try {
      return await this.#deps.readModelCatalogue(cwd);
    } catch {
      return { status: "unavailable", reason: "catalogue-unreadable" };
    }
  }

  /**
   * Stops one task on a routing question, recording it before anything else for that task can be
   * admitted and notifying the coordinator only for the admission that raised it.
   */
  private async stopTaskRouting(
    store: TaskStoreTransaction,
    task: TaskRecord,
    runtime: RuntimeTaskState,
    pause: RaisedExecutionRoutingPause,
  ): Promise<void> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    await writeRuntimeState(
      this.#deps.runtimePath,
      replaceRuntimeTask(state, task.id, (current) => ({ ...current, routingPause: pause })),
    );
    if (runtime.routingPause?.decisionId === pause.decisionId) return;
    await store.update(task.id, task.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      notifications: [
        ...current.notifications,
        {
          id: singleLine(this.#deps.idFactory(), "routing decision notification id"),
          message: describeExecutionRoutingDecision(pause, task.objective),
          acknowledged: false,
          kind: "coordinator" as const,
        },
      ],
    }));
  }
}
