import type { BlockCause, TaskRecord } from "../contracts.ts";
import { type CentralRecoveryWorkflow, reportBlock } from "../recovery/central.ts";
import type { DurableReservation, RuntimeTaskState } from "../runtime/schema.ts";
import type { WorkerWorkflow } from "../workers/workflow.ts";
import type { LiveTaskStep } from "./reconcile-step.ts";
import { currentWriter, workerRoleForTask } from "./records.ts";

export type LiveTaskDependencies = Readonly<{
  worker: Pick<
    WorkerWorkflow,
    | "reconcileJob"
    | "reconcileOperation"
    | "startQueuedTask"
    | "beginFixes"
    | "startValidation"
    | "advanceReview"
    | "reserveTask"
    | "releaseUnlaunchedTaskReservation"
    | "launchAgent"
  >;
  recovery: Pick<CentralRecoveryWorkflow, "recoverStuckWorker">;
  cleanupSettledTask: (taskId: string) => Promise<void>;
  quarantineLegacyReservation: (
    task: TaskRecord,
    reservation: DurableReservation,
    cause: BlockCause,
  ) => Promise<void>;
  blockTaskIfReconcileClaim: (
    task: TaskRecord,
    runtime: RuntimeTaskState,
    reason: string,
    options: Readonly<{
      runtimeError: boolean;
      reservation: DurableReservation;
      cause: BlockCause;
    }>,
  ) => Promise<void>;
  blockTask: (taskId: string, reason: string, cause?: BlockCause) => Promise<TaskRecord>;
}>;

/** Executes the live scheduler decision after ownership and endpoint launches are settled. */
export class LiveTaskWorkflow {
  readonly #deps: LiveTaskDependencies;

  constructor(deps: LiveTaskDependencies) {
    this.#deps = deps;
  }

  async run(task: TaskRecord, runtime: RuntimeTaskState, step: LiveTaskStep): Promise<void> {
    const deps = this.#deps;
    switch (step.kind) {
      case "reconcile-job":
        await deps.worker.reconcileJob(task, runtime, step.job);
        await deps.cleanupSettledTask(task.id);
        return;
      case "quarantine-legacy-reservation":
        return deps.quarantineLegacyReservation(task, step.reservation, step.cause);
      case "block-claimed":
        return deps.blockTaskIfReconcileClaim(task, runtime, step.cause.detail, {
          runtimeError: true,
          reservation: step.reservation,
          cause: step.cause,
        });
      case "reconcile-operation":
        return deps.worker.reconcileOperation(task, runtime);
      case "start-queued":
        return deps.worker.startQueuedTask(task);
      case "begin-fixes":
        // beginFixes enters implementing before touching a pane. A missing pane stays there
        // unblocked so central recovery can pick it up on the next tick.
        return deps.worker.beginFixes(task);
      case "validate":
      case "advance-review":
        return this.advanceAfterRecovery(task, step.kind);
      case "block":
        return reportBlock(deps.blockTask, task.id, step.cause);
      case "recover-stuck-writer":
        await deps.recovery.recoverStuckWorker(task);
        return;
      case "launch-writer":
        return this.launchWriter(task);
      case "wait":
        return;
    }
  }

  private async advanceAfterRecovery(
    task: TaskRecord,
    step: "validate" | "advance-review",
  ): Promise<void> {
    // Infrastructure failures can leave validation without an active job, or a resumed review
    // can retain a quarantined reviewer. Central recovery owns stop/save/re-entry in both cases;
    // skipped means this is a fresh entry and the normal stage action runs.
    const recovered = await this.#deps.recovery.recoverStuckWorker(task);
    if (recovered.action !== "skipped") return;
    if (step === "validate") await this.#deps.worker.startValidation(task);
    else await this.#deps.worker.advanceReview(task);
  }

  private async launchWriter(task: TaskRecord): Promise<void> {
    const deps = this.#deps;
    const admission = await deps.worker.reserveTask(task.id, workerRoleForTask(task));
    if ("refusal" in admission) return;
    const admittedWriter = currentWriter(admission.runtime);
    if (admission.runtime.worktree === undefined || admittedWriter === undefined) {
      await deps.worker.releaseUnlaunchedTaskReservation(task.id, admission.reservation.id);
      await reportBlock(deps.blockTask, task.id, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The worker's terminal and files are gone.",
        detail: `task is ${task.stage} but its worker resources are missing`,
      });
      return;
    }
    await deps.worker.launchAgent(
      admission.task,
      admission.runtime,
      admittedWriter,
      workerRoleForTask(admission.task),
    );
  }
}
