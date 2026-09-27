import { createReviewerEndpoint } from "../adapters/herdr.ts";
import type {
  BlockCause,
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  TaskRecord,
} from "../contracts.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import type { DurableJob, RuntimeTaskState } from "../runtime/schema.ts";
import {
  currentWriter,
  describeError,
  jobDirectoryFor,
  jobPaths,
  singleLine,
  workerCommand,
} from "../service/records.ts";
import {
  type FinalAcceptanceContract,
  finalAcceptanceContract,
  ValidationConfigurationError,
} from "../tasks/acceptance.ts";
import type { ValidationJob } from "../validation-worker.ts";
import type { ReservationRefusal, ReservationResult } from "./admission.ts";
import { type CurrentCheckout, isCleanAt, readWorkerCheckout } from "./checkout.ts";
import type { JobLauncher } from "./job-launch.ts";
import { claimOf, executionIdentity, type OperationClaim } from "./operation-claim.ts";
import type { OperationRecords } from "./operation-records.ts";
import type { TaskReservations } from "./reservation.ts";
import { workerJobForEndpoint } from "./terminal-control.ts";

/** The pane id an endpoint effect's receipt names, when the receipt is readable. */
function endpointReceiptPaneId(receipt: string | undefined): string | undefined {
  if (receipt === undefined) return undefined;
  try {
    const parsed = JSON.parse(receipt) as Record<string, unknown>;
    return typeof parsed.paneId === "string" ? parsed.paneId : undefined;
  } catch {
    return undefined;
  }
}

export type ValidationStageDependencies = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly validationWorkerPath: string;
  readonly blockTask: (taskId: string, reason: string, cause?: BlockCause) => Promise<TaskRecord>;
  readonly records: OperationRecords;
  readonly launcher: JobLauncher;
  readonly reservations: TaskReservations;
}>;

/** Runs the project's check commands on a task's reviewed HEAD in a pane beside its writer. */
export class ValidationStage {
  readonly #deps: ValidationStageDependencies;

  constructor(deps: ValidationStageDependencies) {
    this.#deps = deps;
  }

  async startValidation(
    task: TaskRecord,
    reserved?: ReservationResult,
  ): Promise<ReservationRefusal | undefined> {
    const target = await this.planOrBlock(task);
    if (target === undefined) return;
    const { head, plan } = target;
    const reservation =
      reserved ?? (await this.#deps.reservations.reserveTask(task.id, "validation"));
    if ("refusal" in reservation) return reservation;
    const { runtime } = reservation;
    const reservationId = reservation.reservation.id;
    const claim = claimOf(runtime.operation);
    const records = this.#deps.records;
    if (claim === undefined) {
      await records.releaseUnlaunchedTaskReservation(task.id, reservationId, claim);
      return;
    }
    const stopWithoutLaunch = (cause: BlockCause) =>
      records.releaseAndBlock(task.id, reservationId, claim, cause);
    const worktree = await this.readyWorktree(runtime, head);
    if ("refusal" in worktree) {
      await stopWithoutLaunch(worktree.refusal);
      return;
    }
    const { cwd } = worktree;
    let endpoint: Endpoint | undefined;
    try {
      endpoint = await records.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["validating"],
        (current) => this.ensureValidationEndpoint(task, current.runtime, claim, cwd),
      );
    } catch (error) {
      await stopWithoutLaunch({
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't open a terminal to run the checks.",
        detail: `validation pane allocation failed: ${describeError(error)}`,
      });
      return;
    }
    if (endpoint === undefined) {
      await records.releaseUnlaunchedTaskReservation(task.id, reservationId, claim);
      return;
    }
    let job: DurableJob | undefined;
    try {
      job = await this.persistValidationJob({ task, runtime, claim, plan, endpoint, cwd, head });
      if (job === undefined) {
        await records.releaseUnlaunchedTaskReservation(task.id, reservationId, claim);
        return;
      }
    } catch (error) {
      await stopWithoutLaunch({
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "Tandem couldn't save the check run.",
        detail: `validation job could not be persisted: ${describeError(error)}`,
      });
      return;
    }
    await this.#deps.launcher.launchJob(
      task.id,
      job.id,
      endpoint,
      cwd,
      workerCommand(this.#deps.validationWorkerPath, job.jobPath),
      claim,
    );
  }

  /** The full manifest for the task's reviewed HEAD, or undefined once the task is blocked. */
  private async planOrBlock(
    task: TaskRecord,
  ): Promise<
    Readonly<{ readonly head: string; readonly plan: FinalAcceptanceContract }> | undefined
  > {
    const head = task.reviewHead;
    if (head === undefined || task.worktree === undefined) {
      const reason = "validation requires a task worktree and reviewed HEAD";
      await this.#deps.blockTask(task.id, reason, {
        group: "user-decision",
        kind: "prerequisite-not-met",
        summary: "There's no finished work to check yet.",
        detail: reason,
      });
      return undefined;
    }
    try {
      return { head, plan: finalAcceptanceContract(task, head) };
    } catch (error) {
      const reason =
        error instanceof ValidationConfigurationError
          ? `validation refused: ${error.message}`
          : `validation contract could not be planned: ${describeError(error)}`;
      await this.#deps.blockTask(task.id, reason, {
        group: "user-decision",
        kind: "validation-config-refused",
        summary: "The project's check commands aren't set up correctly.",
        detail: reason,
      });
      return undefined;
    }
  }

  /**
   * The worktree validation runs in: still recorded, clean at `head`, and beside a live writer
   * pane. Otherwise the reason the checks can't run.
   */
  private async readyWorktree(
    runtime: RuntimeTaskState,
    head: string,
  ): Promise<Readonly<{ readonly cwd: string }> | Readonly<{ readonly refusal: BlockCause }>> {
    if (runtime.worktree === undefined) {
      return {
        refusal: {
          group: "lost-resource",
          kind: "resource-lost",
          summary: "The task's working copy is missing, so the checks can't run.",
          detail: "validation runtime lost its worktree",
        },
      };
    }
    const cwd = runtime.worktree.path;
    let checkout: CurrentCheckout;
    try {
      checkout = await readWorkerCheckout(this.#deps.run, runtime, { cwd, head });
    } catch (error) {
      return {
        refusal: {
          group: "lost-resource",
          kind: "checkout-unverifiable",
          summary: "Tandem couldn't read the task's files, so the checks didn't run.",
          detail: `validation checkout could not be verified: ${describeError(error)}`,
        },
      };
    }
    if (!isCleanAt(checkout.checkpoint, head)) {
      return {
        refusal: {
          group: "user-decision",
          kind: "prerequisite-not-met",
          summary: "The code changed after it was submitted, so the checks didn't run.",
          detail: "validation refused because the task worktree is stale or dirty",
        },
      };
    }
    if (currentWriter(runtime) === undefined) {
      return {
        refusal: {
          group: "lost-resource",
          kind: "resource-lost",
          summary: "The worker's terminal is gone, so the checks can't run.",
          detail: "validation has no owned implementer pane",
        },
      };
    }
    return { cwd };
  }

  /**
   * Writes the validation job spec under the claim and records its durable job, or returns
   * undefined when the claim no longer allows the write.
   */
  private async persistValidationJob(
    input: Readonly<{
      readonly task: TaskRecord;
      readonly runtime: RuntimeTaskState;
      readonly claim: OperationClaim;
      readonly plan: FinalAcceptanceContract;
      readonly endpoint: Endpoint;
      readonly cwd: string;
      readonly head: string;
    }>,
  ): Promise<DurableJob | undefined> {
    const { task, claim, plan, cwd, head } = input;
    const operation = input.runtime.operation;
    const jobId = operation?.jobId ?? singleLine(this.#deps.idFactory(), "validation job id");
    const paths = jobPaths(jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId));
    const contract = plan.contract;
    const policyDigest = plan.identity.policyDigest;
    const spec: ValidationJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      repoPath: cwd,
      head,
      contract,
      policyDigest,
      surfaces: plan.surfaces,
      commands: plan.commands,
      resultPath: paths.resultPath,
      ...(operation === undefined
        ? {}
        : { execution: executionIdentity(this.#deps.home, operation) }),
    };
    const jobWritten = await this.#deps.records.withOperationEffect(
      task.id,
      claim,
      task.generation,
      ["validating"],
      async () => {
        await writeJsonAtomically(paths.jobPath, spec);
        return true;
      },
    );
    if (jobWritten !== true) return undefined;
    const job: DurableJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      role: "validation",
      kind: "validation",
      cwd,
      jobPath: paths.jobPath,
      resultPath: paths.resultPath,
      attempt: 1,
      phase: "reserved",
      launchAttempted: false,
      createdAt: this.#deps.clock(),
      ...(operation === undefined ? {} : { operationId: operation.id }),
      endpoint: input.endpoint,
      head,
      contract,
      policyDigest,
      ...(task.communication === undefined
        ? {}
        : { instructionRevision: task.communication.revision }),
    };
    await this.#deps.records.appendJob(task.id, job, claim);
    return job;
  }

  /**
   * Returns the validation pane this operation already opened, restores it from the endpoint
   * effect's receipt, or opens one beside the implementer's pane. An unresolved or unreadable
   * earlier effect quarantines the operation instead of opening a second pane.
   */
  private async ensureValidationEndpoint(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    claim: OperationClaim,
    validationCwd: string,
  ): Promise<Endpoint | undefined> {
    const effectId = `endpoint:${claim.id}`;
    const existingEffect = runtime.operation?.effects.find((entry) => entry.id === effectId);
    const receiptPaneId = endpointReceiptPaneId(existingEffect?.receipt);
    const existingEndpoint =
      existingEffect === undefined
        ? undefined
        : runtime.endpoints.find(
            (entry) =>
              entry.paneId === receiptPaneId ||
              (receiptPaneId === undefined &&
                entry.generation === task.generation &&
                entry.role === "reviewer"),
          );
    if (existingEndpoint !== undefined) return existingEndpoint;
    if (existingEffect !== undefined) {
      if (existingEffect.phase !== "succeeded" || existingEffect.receipt === undefined) {
        await this.#deps.records.quarantineOperation(
          task.id,
          `endpoint effect ${existingEffect.id} is unresolved`,
          claim,
        );
        return undefined;
      }
      try {
        const restored = JSON.parse(existingEffect.receipt) as Endpoint;
        await this.#deps.records.saveEndpoint(task.id, restored, claim);
        return restored;
      } catch {
        await this.#deps.records.quarantineOperation(
          task.id,
          `endpoint effect ${existingEffect.id} has invalid receipt`,
          claim,
        );
        return undefined;
      }
    }
    const writer = currentWriter(runtime);
    if (writer === undefined) throw new Error("validation has no owned implementer pane");
    const writerJob = workerJobForEndpoint(runtime.jobs, writer);
    const identity = `validation:${task.id}:${task.generation}`;
    await this.#deps.records.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "endpoint",
      "intent",
      identity,
    );
    const result = await createReviewerEndpoint(this.#deps.run, {
      sessionId: this.#deps.sessionId,
      cwd: runtime.worktree?.path ?? validationCwd,
      writer,
      generation: task.generation,
      ...(writerJob === undefined ? {} : { writerJob }),
    });
    await this.#deps.records.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "endpoint",
      "succeeded",
      identity,
      JSON.stringify(result.endpoint),
    );
    await this.#deps.records.saveEndpoint(task.id, result.endpoint, claim);
    return result.endpoint;
  }
}
