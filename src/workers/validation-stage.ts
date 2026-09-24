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
  type PlannedValidation,
  planValidation,
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
    const reviewHead = task.reviewHead;
    if (reviewHead === undefined || task.worktree === undefined) {
      const reason = "validation requires a task worktree and reviewed HEAD";
      await this.#deps.blockTask(task.id, reason, {
        group: "user-decision",
        kind: "prerequisite-not-met",
        summary: "There's no finished work to check yet.",
        detail: reason,
      });
      return;
    }
    let planned: PlannedValidation;
    try {
      planned = planValidation(task, reviewHead);
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
      return;
    }
    const reservation =
      reserved ?? (await this.#deps.reservations.reserveTask(task.id, "validation"));
    if ("refusal" in reservation) return reservation;
    const runtime = reservation.runtime;
    const claim = claimOf(runtime.operation);
    if (claim === undefined) {
      await this.#deps.records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      return;
    }
    const stopWithoutLaunch = async (reason: string, cause: Omit<BlockCause, "detail">) => {
      await this.#deps.records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      await this.#deps.records.blockIfOperationClaim(task.id, reason, claim, {
        ...cause,
        detail: reason,
      });
    };
    if (runtime.worktree === undefined) {
      await stopWithoutLaunch("validation runtime lost its worktree", {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The task's working copy is missing, so the checks can't run.",
      });
      return;
    }
    const validationCwd = runtime.worktree.path;
    let checkout: CurrentCheckout;
    try {
      checkout = await readWorkerCheckout(this.#deps.run, runtime, {
        cwd: validationCwd,
        head: reviewHead,
      });
    } catch (error) {
      await stopWithoutLaunch(
        `validation checkout could not be verified: ${describeError(error)}`,
        {
          group: "lost-resource",
          kind: "checkout-unverifiable",
          summary: "Tandem couldn't read the task's files, so the checks didn't run.",
        },
      );
      return;
    }
    if (!isCleanAt(checkout.checkpoint, reviewHead)) {
      await stopWithoutLaunch("validation refused because the task worktree is stale or dirty", {
        group: "user-decision",
        kind: "prerequisite-not-met",
        summary: "The code changed after it was submitted, so the checks didn't run.",
      });
      return;
    }
    if (currentWriter(runtime) === undefined) {
      await stopWithoutLaunch("validation has no owned implementer pane", {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The worker's terminal is gone, so the checks can't run.",
      });
      return;
    }
    let validationEndpoint: Endpoint | undefined;
    try {
      validationEndpoint = await this.#deps.records.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["validating"],
        (current) => this.ensureValidationEndpoint(task, current.runtime, claim, validationCwd),
      );
    } catch (error) {
      await stopWithoutLaunch(`validation pane allocation failed: ${describeError(error)}`, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't open a terminal to run the checks.",
      });
      return;
    }
    if (validationEndpoint === undefined) {
      await this.#deps.records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      return;
    }
    let durableJob: DurableJob;
    try {
      const operation = runtime.operation;
      const jobId = operation?.jobId ?? singleLine(this.#deps.idFactory(), "validation job id");
      const paths = jobPaths(jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId));
      const contract = planned.plan.contract;
      const policyDigest = planned.plan.identity.policyDigest;
      const spec: ValidationJob = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        repoPath: validationCwd,
        head: reviewHead,
        contract,
        policyDigest,
        surfaces: planned.plan.surfaces,
        commands: planned.plan.commands,
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
      if (jobWritten !== true) {
        await this.#deps.records.releaseUnlaunchedTaskReservation(
          task.id,
          reservation.reservation.id,
          claim,
        );
        return;
      }
      durableJob = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        role: "validation",
        kind: "validation",
        cwd: validationCwd,
        jobPath: paths.jobPath,
        resultPath: paths.resultPath,
        attempt: 1,
        phase: "reserved",
        launchAttempted: false,
        createdAt: this.#deps.clock(),
        ...(operation === undefined ? {} : { operationId: operation.id }),
        endpoint: validationEndpoint,
        head: reviewHead,
        contract,
        policyDigest,
        ...(planned.escalation === undefined ? {} : { escalation: planned.escalation }),
        ...(task.communication === undefined
          ? {}
          : { instructionRevision: task.communication.revision }),
      };
      await this.#deps.records.appendJob(task.id, durableJob, claim);
    } catch (error) {
      await stopWithoutLaunch(`validation job could not be persisted: ${describeError(error)}`, {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "Tandem couldn't save the check run.",
      });
      return;
    }
    await this.#deps.launcher.launchJob(
      task.id,
      durableJob.id,
      validationEndpoint,
      validationCwd,
      workerCommand(this.#deps.validationWorkerPath, durableJob.jobPath),
      claim,
    );
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
