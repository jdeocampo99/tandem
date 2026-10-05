import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type GitCheckpoint, readCheckpoint } from "../adapters/git.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type {
  BlockCause,
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  ReviewMode,
  TaskQuestion,
  TaskRecord,
  WorkerReceipt,
} from "../contracts.ts";
import { renderReviewText } from "../pr-review/render.ts";
import { checkReview } from "../pr-review/review.ts";
import { readRunFiles } from "../pr-review/run.ts";
import type { PrReviewRound } from "../pr-review/state.ts";
import type { RelaunchWorker } from "../recovery/central.ts";
import { taskRuntime } from "../runtime/activity.ts";
import {
  readRuntimeState,
  taskJobsDirectory,
  writeJsonAtomically,
  writeRuntimeState,
  writeTextAtomically,
} from "../runtime/persistence.ts";
import type {
  DurableJob,
  DurableOperation,
  DurableReservation,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import type { RequestUsageEvent } from "../runtime/usage.ts";
import type { RequestUsageReadout } from "../runtime/usage-receipt.ts";
import {
  currentWriter,
  DEFAULT_STARTUP_GRACE_MS,
  describeError,
  endpointLaunchFor,
  instructionOptions,
  isMissing,
  isMissingEndpoint,
  isOlderThan,
  isRecord,
  nowMilliseconds,
  replaceJob,
  replaceRuntimeTask,
  reportPathFor,
  singleLine,
  taskWithQuestion,
  workerCommand,
  workerRoleForTask,
} from "../service/records.ts";
import { taskSourcePath } from "../service/source.ts";
import { policyIdentity } from "../tasks/acceptance.ts";
import { readWorkerReceipt } from "../tasks/communication-persistence.ts";
import { MAX_TASK_MESSAGE_CHARS } from "../tasks/communication-protocol.ts";
import { type FixRoundGate, fixRoundGate } from "../tasks/findings.ts";
import { type TaskEvent, type TaskTransitionContext, transitionTask } from "../tasks/lifecycle.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { TranscriptRef } from "../tasks/timeline.ts";
import type { EndpointInspection, TerminalBackend } from "../terminal-backend/contract.ts";
import { readValidationResult, type ValidationResult } from "../validation-worker.ts";
import type { AdmissionRole, ReservationRefusal, ReservationResult } from "./admission.ts";
import { type CurrentCheckout, isClean, isCleanAt, readWorkerCheckout } from "./checkout.ts";
import type { ModelCatalogueReader } from "./execution-routing.ts";
import { JobLauncher } from "./job-launch.ts";
import {
  consumedJobRuntime,
  failedJobRuntime,
  planJobConsumption,
  taskAtRest,
} from "./job-settlement.ts";
import { readWorkerResult, type WorkerResult, type WorkerRole } from "./jobs.ts";
import { claimOf, holdsClaim, type OperationClaim, operationSettled } from "./operation-claim.ts";
import { OperationRecords } from "./operation-records.ts";
import { TaskReservations } from "./reservation.ts";
import { ReviewStage } from "./review-stage.ts";
import { liveWorkerTerminal, taskWorkspaceLabel } from "./terminal.ts";
import { ValidationStage } from "./validation-stage.ts";
import { WorktreeLeases } from "./worktree-lease.ts";

type RelaunchOutcome = Awaited<ReturnType<RelaunchWorker>>;

const DEFAULT_STALL_WARNING_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_GRACE_MS = 60 * 1000;

/**
 * Whether a running worker's progress warning should be raised, cleared because it reported
 * progress since, or left alone. A worker with no receipt yet is judged by its startup age.
 */
function progressWarning(
  job: DurableJob,
  receipt: WorkerReceipt | undefined,
  nowMs: number,
): "warn" | "clear" | "none" {
  if (
    job.progressWarningAt !== undefined &&
    receipt !== undefined &&
    Date.parse(receipt.progressAt) > Date.parse(job.progressWarningAt)
  ) {
    return "clear";
  }
  if (job.progressWarningAt !== undefined) return "none";
  const createdMs = Date.parse(job.createdAt);
  const startupElapsed =
    Number.isFinite(createdMs) && nowMs - createdMs >= DEFAULT_HEARTBEAT_GRACE_MS;
  if (receipt === undefined) return startupElapsed ? "warn" : "none";
  const heartbeatMs = Date.parse(receipt.heartbeatAt);
  const progressMs = Date.parse(receipt.progressAt);
  const heartbeatStale =
    !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs >= DEFAULT_HEARTBEAT_GRACE_MS;
  const progressStale =
    !Number.isFinite(progressMs) || nowMs - progressMs >= DEFAULT_STALL_WARNING_MS;
  return heartbeatStale || progressStale ? "warn" : "none";
}

/** The decision a worker stopped on, bounded to what a task message may carry. */
/** What a worker result adds to the consumption beyond its lifecycle event. */
function resultOptions(
  result: WorkerResult,
): Readonly<{ instructionRevision?: number; transcript?: TranscriptRef }> {
  return {
    ...instructionOptions(result.instructionRevision),
    ...(result.transcript === undefined ? {} : { transcript: result.transcript }),
  };
}

/** The commit a consumed result is about: the one its event names, else the one the job ran on. */
function commitRef(event: TaskEvent, job: DurableJob): Readonly<{ commit?: string }> {
  const head =
    event.type === "record-review" ? event.review.head : "head" in event ? event.head : job.head;
  return head === undefined ? {} : { commit: head };
}

function workerQuestion(job: DurableJob, result: WorkerResult): TaskQuestion {
  const text =
    (result.question?.text ?? result.text).trim() || `Worker ${job.role} needs a decision`;
  const recommendation = result.question?.recommendation;
  return {
    id: job.id,
    text: text.slice(0, MAX_TASK_MESSAGE_CHARS),
    ...(recommendation === undefined
      ? {}
      : { recommendation: recommendation.slice(0, MAX_TASK_MESSAGE_CHARS) }),
  };
}

export type WorkerWorkflowDependencies = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly parentWorkspaceId: string | undefined;
  readonly poolRoot: string;
  readonly workerTimeoutMs: number | undefined;
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly workerPath: string;
  readonly validationWorkerPath: string;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
  readonly runtimeFor: (taskId: string) => Promise<RuntimeTaskState | undefined>;
  readonly readState: () => Promise<RuntimeState>;
  readonly resultExists: (path: string) => Promise<boolean>;
  readonly updateTask: (
    taskId: string,
    transform: (task: TaskRecord) => TaskRecord,
  ) => Promise<TaskRecord>;
  readonly transition: (taskId: string, event: TaskEvent) => Promise<TaskRecord>;
  readonly context: () => TaskTransitionContext;
  readonly blockTask: (taskId: string, reason: string, cause?: BlockCause) => Promise<TaskRecord>;
  readonly publishTaskInbox: (task: TaskRecord) => Promise<void>;
  readonly removeEndpoint: (taskId: string, paneId: string) => Promise<void>;
  readonly setRuntimeError: (taskId: string, error: string) => Promise<void>;
  readonly maintainPoolForAllocation: (task: TaskRecord) => Promise<boolean>;
  /** Appends accounting facts. It records only; it never decides whether work may continue. */
  readonly recordRequestUsage: (events: readonly RequestUsageEvent[]) => Promise<void>;
  /** The accounting ledger's own rows for one request, read for economical routing's usage check. */
  readonly readRequestUsage: (requestId: string) => Promise<RequestUsageReadout>;
  /** Reads catalogue tier evidence at an execution boundary; it never enables a provider. */
  readonly readModelCatalogue: ModelCatalogueReader;
}>;

/** How a job's pane showed its worker stopped; see `WorkerWorkflow.jobStopped`. */
type JobStop = "exited" | "finished";

/**
 * Drives a task's workers through their stages: starting queued work, fix rounds, relaunch, and
 * consuming each job's durable result. Validation and review run in their own stage modules.
 */
export class WorkerWorkflow {
  readonly #deps: WorkerWorkflowDependencies;
  readonly #claimOwner: string;
  readonly #records: OperationRecords;
  readonly #reservations: TaskReservations;
  readonly #launcher: JobLauncher;
  readonly #leases: WorktreeLeases;
  readonly #validation: ValidationStage;
  readonly #review: ReviewStage;

  constructor(deps: WorkerWorkflowDependencies) {
    this.#deps = deps;
    this.#claimOwner = `${deps.sessionId}:${process.pid}:${randomUUID()}`;
    const records = new OperationRecords(deps);
    const reservations = new TaskReservations({ ...deps, claimOwner: this.#claimOwner });
    const launcher = new JobLauncher({ ...deps, claimOwner: this.#claimOwner, records });
    this.#records = records;
    this.#reservations = reservations;
    this.#launcher = launcher;
    this.#leases = new WorktreeLeases({ ...deps, records });
    this.#validation = new ValidationStage({ ...deps, records, launcher, reservations });
    this.#review = new ReviewStage({ ...deps, records, launcher, reservations });
  }

  get claimOwner(): string {
    return this.#claimOwner;
  }

  reserveTask(
    taskId: string,
    role: AdmissionRole,
  ): Promise<ReservationResult | ReservationRefusal> {
    return this.#reservations.reserveTask(taskId, role);
  }

  claimOperation(taskId: string): Promise<RuntimeTaskState | undefined> {
    return this.#reservations.claimOperation(taskId);
  }

  startValidation(
    task: TaskRecord,
    reserved?: ReservationResult,
  ): Promise<ReservationRefusal | undefined> {
    return this.#validation.startValidation(task, reserved);
  }

  advanceReview(task: TaskRecord, reserved?: ReservationResult): Promise<void> {
    return this.#review.advanceReview(task, reserved);
  }

  launchAgent(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    endpoint: Endpoint,
    role: WorkerRole,
  ): Promise<void> {
    return this.#launcher.launchAgent(task, runtime, endpoint, role);
  }

  releaseUnlaunchedTaskReservation(
    taskId: string,
    reservationId: string,
    claim?: OperationClaim,
  ): Promise<void> {
    return this.#records.releaseUnlaunchedTaskReservation(taskId, reservationId, claim);
  }

  saveEndpoint(taskId: string, endpoint: Endpoint, claim?: OperationClaim): Promise<void> {
    return this.#records.saveEndpoint(taskId, endpoint, claim);
  }

  async reconcileJob(task: TaskRecord, runtime: RuntimeTaskState, job: DurableJob): Promise<void> {
    const endpoint = job.endpoint;
    const claim = claimOf(runtime.operation);
    if (claim === undefined) return;
    if (
      endpoint !== undefined &&
      job.phase === "reserved" &&
      !job.launchAttempted &&
      runtime.operation?.jobId === job.id &&
      runtime.operation.effects.every((effect) => effect.id !== job.id)
    ) {
      const command =
        job.kind === "validation"
          ? workerCommand(this.#deps.validationWorkerPath, job.jobPath)
          : workerCommand(this.#deps.workerPath, job.jobPath);
      await this.#launcher.launchJob(task.id, job.id, endpoint, job.cwd, command, claim);
      return;
    }
    if (endpoint === undefined) {
      if (isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
        const reason = "worker job has no durable endpoint identity";
        await this.#records.failJob(task, job, reason, claim, true, true, {
          group: "safety-stop",
          kind: "quarantined-unknown-outcome",
          summary:
            "Tandem lost track of which terminal the worker ran in, so it can't tell what it finished.",
          detail: reason,
          jobId: job.id,
        });
      }
      return;
    }
    const stop = await this.jobStopped(task, job, endpoint, claim);
    if (stop === undefined) return;
    if (job.kind === "worker") {
      await this.settleWorkerJob(task, runtime, job, claim, stop);
      return;
    }
    await this.settleValidationJob(task, runtime, job, claim);
  }

  /**
   * How the job's pane shows its worker stopped, so its result can be read: `exited` when no worker
   * process remains, `finished` when the process is still there but reports it completed or paused.
   * A running worker's progress is observed instead, and a vanished pane is settled here.
   */
  private async jobStopped(
    task: TaskRecord,
    job: DurableJob,
    endpoint: Endpoint,
    claim: OperationClaim,
  ): Promise<JobStop | undefined> {
    let inspection: EndpointInspection;
    try {
      inspection = await this.#deps.terminal.inspect({
        endpoint,
        cwd: job.cwd,
      });
    } catch (error) {
      if (error instanceof EndpointOwnershipError && error.reason === "missing") {
        await this.reconcileMissingEndpoint(task, job, claim);
        return undefined;
      }
      throw error;
    }
    if (!inspection.activeWorker) return "exited";
    await this.observeWorkerProgress(task, job, claim);
    const terminal = await liveWorkerTerminal(inspection, job);
    if (terminal !== undefined && (terminal.completed || terminal.phase === "paused")) {
      return "finished";
    }
    if (job.phase !== "running") {
      await this.#records.updateJob(job.taskId, job.id, claim, (current) => ({
        ...current,
        phase: "running",
      }));
    }
    return undefined;
  }

  /** Reads a stopped worker's durable result and consumes it, failing the job when it can't. */
  private async settleWorkerJob(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    claim: OperationClaim,
    stop: JobStop,
  ): Promise<void> {
    let result: WorkerResult;
    try {
      result = await readWorkerResult(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        ...(job.role === "validation" ? {} : { role: job.role }),
      });
    } catch (error) {
      if (isMissing(error)) {
        if (!isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) return;
        const reason = `worker stopped without a durable result: ${describeError(error)}`;
        if (stop === "exited") {
          // No worker process is left in the pane: the worker died, a known outcome. Block with a
          // recoverable cause so central recovery restarts it within its restart budget.
          await this.#records.failJob(task, job, reason, claim, true, false, {
            group: "lost-resource",
            kind: "resource-lost",
            summary: "The worker stopped without reporting back.",
            detail: reason,
            jobId: job.id,
          });
          return;
        }
        await this.#records.failJob(task, job, reason, claim, true, true, {
          group: "safety-stop",
          kind: "quarantined-unknown-outcome",
          summary:
            "The worker stopped without reporting back, so Tandem can't tell what it finished.",
          detail: reason,
          jobId: job.id,
        });
        return;
      }
      const rejectedReason = `worker result rejected: ${describeError(error)}`;
      await this.#records.failJob(task, job, rejectedReason, claim, true, false, {
        group: "unusable-result",
        kind: "worker-failed",
        summary: "The worker's report couldn't be read.",
        detail: rejectedReason,
        jobId: job.id,
      });
      return;
    }
    await this.consumeWorkerResult(task, runtime, job, result);
  }

  /** Reads a stopped validation run's durable result and consumes it, failing the job when it can't. */
  private async settleValidationJob(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    claim: OperationClaim,
  ): Promise<void> {
    let result: ValidationResult;
    try {
      if (job.head === undefined) throw new Error("validation job is missing expected HEAD");
      if (job.contract === undefined || job.policyDigest === undefined) {
        throw new Error("validation job is missing its contract identity");
      }
      result = await readValidationResult(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        head: job.head,
        contract: job.contract,
        policyDigest: job.policyDigest,
      });
    } catch (error) {
      if (isMissing(error)) {
        if (!isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) return;
        // The validation runner process is gone without writing a durable result: an infrastructure
        // loss, not a genuine result. Settle the job as failed and release its reservation without
        // blocking, so the task stays at `validating` and central recovery's stop/save/re-entry
        // (bounded by the validation retry budget) can pick it up instead of sitting blocked.
        await this.#records.failJob(
          task,
          job,
          `validation stopped without durable evidence: ${describeError(error)}`,
          claim,
          false,
          false,
        );
        return;
      }
      const rejectedReason = `validation result rejected: ${describeError(error)}`;
      await this.#records.failJob(task, job, rejectedReason, claim, true, false, {
        group: "unusable-result",
        kind: "worker-failed",
        summary: "The check results couldn't be read.",
        detail: rejectedReason,
        jobId: job.id,
      });
      return;
    }
    await this.consumeValidationResult(task, runtime, job, result);
  }

  private async reconcileMissingEndpoint(
    task: TaskRecord,
    job: DurableJob,
    claim: OperationClaim,
  ): Promise<void> {
    if (!isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) return;
    const resultExists = await this.#deps.resultExists(job.resultPath);
    const reason = resultExists
      ? "owned endpoint disappeared; durable result cannot be trusted without stopped-pane proof"
      : "owned endpoint disappeared before a durable result was written";
    if (job.kind === "validation") {
      // A lost validation pane is an infrastructure loss, not a genuine result: settle the job as
      // failed and release its reservation without blocking, so the task stays at `validating` and
      // central recovery's stop/save/re-entry (bounded by the validation retry budget) can pick it
      // up on the next reconcile tick instead of the task sitting blocked for a human.
      await this.#records.failJob(task, job, reason, claim, false, false);
      return;
    }
    // Nothing runs in a pane that no longer exists, so the worker is known dead. Block with a
    // recoverable cause so central recovery restarts it within its restart budget.
    await this.#records.failJob(task, job, reason, claim, true, false, {
      group: "lost-resource",
      kind: "resource-lost",
      summary: "The worker's terminal disappeared before it finished.",
      detail: reason,
      jobId: job.id,
    });
  }

  private async observeWorkerProgress(
    task: TaskRecord,
    job: DurableJob,
    claim: OperationClaim,
  ): Promise<void> {
    if (job.receiptPath === undefined) return;
    const receipt = await readWorkerReceipt(job.receiptPath, {
      jobId: job.id,
      taskId: task.id,
      generation: job.generation,
    }).catch(() => undefined);
    const now = this.#deps.clock();
    const warning = progressWarning(job, receipt, nowMilliseconds(this.#deps.clock));
    if (warning === "clear") {
      await this.#records.updateJob(job.taskId, job.id, claim, (current) => {
        const { progressWarningAt: _progressWarningAt, ...withoutWarning } = current;
        return withoutWarning;
      });
      return;
    }
    if (warning === "none") return;
    await this.#records.updateJob(job.taskId, job.id, claim, (current) => ({
      ...current,
      progressWarningAt: now,
    }));
    await this.#deps.updateTask(task.id, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      notifications: [
        ...current.notifications,
        {
          id: singleLine(this.#deps.idFactory(), "progress warning id"),
          message: `Worker ${job.role} has not reported meaningful progress; inspect its activity before taking action`,
          acknowledged: false,
          kind: "coordinator",
        },
      ],
    }));
  }

  private async assertInstructionCurrent(
    task: TaskRecord,
    job: DurableJob,
    resultRevision: number | undefined,
    required = true,
  ): Promise<void> {
    // A failed worker result intentionally omits proof of the canonical instruction (the worker
    // extension only proves it for a status that is not "failed"); requiring that proof here would
    // treat every genuine failure as a stale instruction and swallow the real transition.
    if (!required) return;
    const canonicalRevision = task.communication?.revision ?? 0;
    if (canonicalRevision === 0 && job.receiptPath === undefined) return;
    if (resultRevision === undefined) {
      throw new Error("worker result omitted canonical instruction revision");
    }
    if (resultRevision !== canonicalRevision) {
      throw new Error(
        `worker applied instruction revision ${resultRevision}, canonical revision is ${canonicalRevision}`,
      );
    }
    if (job.receiptPath === undefined) throw new Error("worker has no communication receipt path");
    const receipt = await readWorkerReceipt(job.receiptPath, {
      jobId: job.id,
      taskId: job.taskId,
      generation: job.generation,
    });
    if (receipt === undefined || receipt.appliedRevision < canonicalRevision) {
      throw new Error(
        "matching worker receipt does not prove the canonical instruction was applied",
      );
    }
  }

  private async consumeWorkerResult(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    result: WorkerResult,
  ): Promise<void> {
    const claim = claimOf(runtime.operation);
    if (claim === undefined) return;
    if (
      result.status !== "failed" &&
      !(await this.acceptsInstructionRevision(task, job, result, claim))
    ) {
      return;
    }
    if (result.status === "failed" || result.status === "needs-decision") {
      const question = result.status === "needs-decision" ? workerQuestion(job, result) : undefined;
      const reason =
        question === undefined
          ? (result.error ?? `worker ${result.status} for ${job.role}`)
          : [
              question.text,
              ...(question.recommendation === undefined
                ? []
                : [`Recommendation: ${question.recommendation}`]),
            ].join(" ");
      const reportPath = reportPathFor(job.jobPath);
      await writeTextAtomically(reportPath, result.text);
      const cause: BlockCause = {
        group: "unusable-result",
        kind: "worker-failed",
        summary:
          result.status === "needs-decision"
            ? `Worker ${job.role} stopped and needs a decision before it can continue.`
            : `The ${job.role} failed.`,
        detail: reason,
        jobId: job.id,
      };
      await this.consumeJob(
        task.id,
        job.id,
        claim,
        { type: "block", reason, cause },
        {
          ...(question === undefined ? {} : { question }),
          ...resultOptions(result),
          instructionRequired: result.status !== "failed",
          reportPath,
        },
      );
      return;
    }
    if (job.role === "scout") {
      await this.consumeScoutResult(task, runtime, job, result, claim);
      return;
    }
    if (job.role === "implementer") {
      await this.consumeImplementerResult(task, runtime, job, result, claim);
      return;
    }
    await this.consumeReviewResult(task, runtime, job, result, claim);
  }

  /**
   * Refuses a result produced under an older canonical instruction than the task now carries. A
   * review job is also refused when it was launched for an older revision than the current one.
   */
  private async acceptsInstructionRevision(
    task: TaskRecord,
    job: DurableJob,
    result: WorkerResult,
    claim: OperationClaim,
  ): Promise<boolean> {
    // ponytail: "verifier" stays matched so a legacy job's failure is still handled as a review
    // failure; see LegacyWorkerRole.
    const reviewJob = job.role === "reviewer" || job.role === "verifier";
    if (reviewJob && (job.instructionRevision ?? 0) !== (task.communication?.revision ?? 0)) {
      const reason = "review result was launched for an older instruction revision";
      await this.#records.failJob(task, job, reason, claim, true, false, {
        group: "unusable-result",
        kind: "stale-review-state",
        summary: "The review was based on older instructions, so it no longer counts.",
        detail: reason,
        jobId: job.id,
      });
      return false;
    }
    try {
      await this.assertInstructionCurrent(task, job, result.instructionRevision);
      return true;
    } catch (error) {
      const reason = `stale worker instruction: ${describeError(error)}`;
      await this.#records.failJob(task, job, reason, claim, reviewJob, false, {
        group: "unusable-result",
        kind: "stale-review-state",
        summary: "The worker was following older instructions, so its result no longer counts.",
        detail: reason,
        jobId: job.id,
      });
      return false;
    }
  }

  /** Consumes a result by blocking the task on `cause`, keeping the result's instruction proof. */
  private async blockOnResult(
    task: TaskRecord,
    job: DurableJob,
    claim: OperationClaim,
    result: WorkerResult,
    cause: BlockCause,
    reason: string = cause.detail,
  ): Promise<void> {
    await this.consumeJob(
      task.id,
      job.id,
      claim,
      { type: "block", reason, cause },
      resultOptions(result),
    );
  }

  private async consumeScoutResult(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    result: WorkerResult,
    claim: OperationClaim,
  ): Promise<void> {
    let checkout: CurrentCheckout;
    try {
      checkout = await readWorkerCheckout(this.#deps.run, runtime, job);
    } catch (error) {
      const reason = `scout checkout could not be verified: ${describeError(error)}; worktree is preserved`;
      await this.blockOnResult(task, job, claim, result, {
        group: "lost-resource",
        kind: "checkout-unverifiable",
        summary:
          "Tandem couldn't check the research worker's files, so it didn't trust the result.",
        detail: reason,
        jobId: job.id,
      });
      return;
    }
    if (!isCleanAt(checkout.checkpoint, runtime.worktree?.baseHead)) {
      await this.blockOnResult(task, job, claim, result, {
        group: "unusable-result",
        kind: "no-clean-checkpoint",
        summary: "The research worker changed files it wasn't supposed to.",
        detail: "scout stopped with a changed, dirty, or unmerged checkout; worktree is preserved",
        jobId: job.id,
      });
      return;
    }
    const reportPath = reportPathFor(job.jobPath);
    const prReviewRound =
      task.prReview === undefined || task.prReview.mode === "question"
        ? undefined
        : await this.readPrReviewRound(task, task.prReview, job, result.text);
    if (prReviewRound instanceof Error) {
      await this.blockOnResult(task, job, claim, result, {
        group: "unusable-result",
        kind: "worker-failed",
        summary: "The PR reviewer's result couldn't be read.",
        detail: `the PR review could not be read: ${prReviewRound.message}`,
        jobId: job.id,
      });
      return;
    }
    await writeTextAtomically(
      reportPath,
      task.prReview === undefined || prReviewRound === undefined
        ? result.text
        : renderReviewText(task.prReview, prReviewRound),
    );
    await this.consumeJob(
      task.id,
      job.id,
      claim,
      {
        type: "scout-report-complete",
        reportPath,
        generation: job.generation,
        ...(prReviewRound === undefined ? {} : { prReviewRound }),
      },
      resultOptions(result),
    );
  }

  private async consumeImplementerResult(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    result: WorkerResult,
    claim: OperationClaim,
  ): Promise<void> {
    const checkout = await readWorkerCheckout(this.#deps.run, runtime, job);
    if (!isClean(checkout.checkpoint) || checkout.checkpoint.head === runtime.worktree?.baseHead) {
      const cause: BlockCause = {
        group: "unusable-result",
        kind: "no-clean-checkpoint",
        summary: "The worker stopped without committing its work.",
        detail:
          "implementer stopped without a new clean committed checkpoint; worktree is preserved",
        jobId: job.id,
      };
      await this.blockOnResult(task, job, claim, result, cause, cause.summary);
      return;
    }
    const reportPath = reportPathFor(job.jobPath);
    await writeTextAtomically(reportPath, result.text);
    await this.consumeJob(
      task.id,
      job.id,
      claim,
      {
        type: "implementation-complete",
        head: checkout.checkpoint.head,
        generation: job.generation,
        reportPath,
      },
      resultOptions(result),
    );
  }

  private async consumeReviewResult(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    result: WorkerResult,
    claim: OperationClaim,
  ): Promise<void> {
    const review = result.review;
    if (review === undefined || job.head === undefined || job.reviewLens === undefined) {
      const reason = "review worker completed without complete review identity";
      await this.#records.failJob(task, job, reason, claim, true, false, {
        group: "unusable-result",
        kind: "worker-failed",
        summary: "The review finished, but Tandem couldn't match it to this task.",
        detail: reason,
        jobId: job.id,
      });
      return;
    }
    const checkout = await readWorkerCheckout(this.#deps.run, runtime, job);
    if (
      !isCleanAt(checkout.checkpoint, job.head) ||
      review.head !== job.head ||
      review.generation !== job.generation ||
      review.lens !== job.reviewLens
    ) {
      await this.blockOnResult(task, job, claim, result, {
        group: "unusable-result",
        kind: "stale-review-state",
        summary: "The code changed after it was reviewed, so the review no longer counts.",
        detail: `stale or dirty review evidence for ${job.reviewLens} at ${job.head}; review was not accepted`,
        jobId: job.id,
      });
      return;
    }
    const expectedReviewMode: ReviewMode = runtime.reviewMode ?? "review_changed_diff";
    if (review.mode !== undefined && review.mode !== expectedReviewMode) {
      const reason = `review result mode ${review.mode} does not match ${expectedReviewMode}`;
      await this.#records.failJob(task, job, reason, claim, true, false, {
        group: "unusable-result",
        kind: "worker-failed",
        summary: "The review ran in the wrong mode.",
        detail: reason,
        jobId: job.id,
      });
      return;
    }
    await this.consumeJob(
      task.id,
      job.id,
      claim,
      { type: "record-review", review: { ...review, mode: expectedReviewMode } },
      resultOptions(result),
    );
  }

  private async consumeValidationResult(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    result: ValidationResult,
  ): Promise<void> {
    const claim = claimOf(runtime.operation);
    if (claim === undefined) return;
    const canonicalRevision = task.communication?.revision ?? 0;
    if (canonicalRevision !== 0 && job.instructionRevision !== canonicalRevision) {
      await this.#records.failJob(
        task,
        job,
        `stale validation instruction revision ${String(job.instructionRevision)}; canonical is ${canonicalRevision}`,
        claim,
        false,
      );
      return;
    }
    const expectedHead = job.head;
    if (expectedHead === undefined) {
      const reason = "validation job has no expected HEAD";
      await this.#records.failJob(task, job, reason, claim, true, false, {
        group: "unusable-result",
        kind: "worker-failed",
        summary: "The check run didn't record which commit it checked.",
        detail: reason,
        jobId: job.id,
      });
      return;
    }
    const contract = job.contract;
    const policyDigest = job.policyDigest;
    if (contract === undefined || policyDigest === undefined) {
      const reason = "validation job has no contract identity";
      await this.#records.failJob(task, job, reason, claim, true, false, {
        group: "unusable-result",
        kind: "worker-failed",
        summary: "The check run didn't record which settings it used.",
        detail: reason,
        jobId: job.id,
      });
      return;
    }
    if (policyIdentity(task.policy) !== policyDigest) {
      const reason = "validation evidence was produced under a different policy identity";
      await this.#records.failJob(task, job, reason, claim, true, false, {
        group: "unusable-result",
        kind: "worker-failed",
        summary: "The checks ran under old settings, so they no longer count.",
        detail: reason,
        jobId: job.id,
      });
      return;
    }
    const checkout = await readWorkerCheckout(this.#deps.run, runtime, job);
    const identity = { head: expectedHead, generation: job.generation, contract, policyDigest };
    const event: TaskEvent = !isCleanAt(checkout.checkpoint, expectedHead)
      ? {
          type: "validation-failed",
          ...identity,
          evidence: [
            ...result.evidence,
            {
              name: "validation-head-check",
              argv: ["git", "rev-parse", "HEAD"],
              exitCode: 1,
              stdout: checkout.checkpoint.head,
              stderr: "worktree changed while validation was running",
              head: expectedHead,
              contract,
              origin: "local",
              policyDigest,
            },
          ],
        }
      : result.status === "completed"
        ? { type: "validation-succeeded", ...identity, evidence: result.evidence }
        : { type: "validation-failed", ...identity, evidence: result.evidence };
    await this.consumeJob(
      task.id,
      job.id,
      claim,
      event,
      instructionOptions(job.instructionRevision),
    );
    await this.closeValidationAfterResult(task.id, job.endpoint);
  }

  private async closeValidationAfterResult(
    taskId: string,
    endpoint: Endpoint | undefined,
  ): Promise<void> {
    if (endpoint === undefined) return;
    const runtime = await this.#deps.runtimeFor(taskId);
    const task = await this.#deps.getTask(taskId);
    if (runtime === undefined) return;
    try {
      await this.#deps.terminal.close({
        endpoint,
        cwd: taskSourcePath(task, runtime),
      });
    } catch (error) {
      if (!isMissingEndpoint(error)) {
        await this.#deps.setRuntimeError(
          taskId,
          `validation pane ${endpoint.paneId} could not close: ${describeError(error)}`,
        );
        return;
      }
    }
    await this.#deps.removeEndpoint(taskId, endpoint.paneId);
  }

  /**
   * Applies one durable job result to the task exactly once. The consumption receipt is written
   * before the task changes, so a crash between the two replays the same transition instead of
   * applying the result again.
   */
  private async consumeJob(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
    event: TaskEvent,
    options: Readonly<{
      question?: TaskQuestion;
      instructionRevision?: number;
      /** False for a failed worker result, which never carries proof of the canonical instruction. */
      instructionRequired?: boolean;
      reportPath?: string;
      transcript?: TranscriptRef;
    }> = {},
  ): Promise<TaskRecord> {
    return this.#deps.store.exclusive(async (store) => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const job = runtime.jobs.find((entry) => entry.id === jobId);
      if (job === undefined) throw new Error(`runtime job ${jobId} is missing`);
      const task = await store.read(taskId);
      if (task === undefined) throw new Error(`task ${taskId} is missing`);
      const operation = runtime.operation;
      if (
        runtime.stopRequest !== undefined ||
        !holdsClaim(operation, claim) ||
        operationSettled(operation) ||
        operation.jobId !== job.id ||
        job.operationId !== operation.id ||
        job.taskId !== taskId
      ) {
        return task;
      }
      try {
        await this.assertResultInstructionCurrent(task, job, options);
      } catch (error) {
        if (job.kind !== "worker") throw error;
        await this.retireStaleWorkerJob(state, task, job, error);
        return task;
      }
      if (job.phase === "consumed") return task;
      const { nextTask, consumption } = planJobConsumption(this.#deps, {
        task,
        job,
        event,
        ...(options.question === undefined ? {} : { question: options.question }),
        ...(options.reportPath === undefined ? {} : { reportPath: options.reportPath }),
      });
      if (job.consumption === undefined) {
        const pendingRuntime = replaceRuntimeTask(state, taskId, (current) =>
          replaceJob(current, jobId, (entry) => ({ ...entry, consumption })),
        );
        await writeRuntimeState(this.#deps.runtimePath, pendingRuntime);
      }
      if (nextTask !== task) {
        await store.update(task.id, task.revision, () => nextTask, {
          refs: {
            job: job.id,
            report: options.reportPath ?? job.resultPath,
            ...commitRef(event, job),
            ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
          },
        });
      }
      const nextRuntime = replaceRuntimeTask(state, taskId, (current) =>
        consumedJobRuntime(
          current,
          job,
          consumption,
          options.instructionRevision,
          this.#deps.clock(),
        ),
      );
      await writeRuntimeState(this.#deps.runtimePath, nextRuntime);
      await this.#deps.publishTaskInbox(nextTask);
      return nextTask;
    });
  }

  /** Throws when the job's result was produced under an instruction the task no longer carries. */
  private async assertResultInstructionCurrent(
    task: TaskRecord,
    job: DurableJob,
    options: Readonly<{ instructionRevision?: number; instructionRequired?: boolean }>,
  ): Promise<void> {
    if (
      job.kind === "worker" &&
      (job.role === "reviewer" || job.role === "verifier") &&
      (job.instructionRevision ?? 0) !== (task.communication?.revision ?? 0)
    ) {
      throw new Error("review result was launched for an older instruction revision");
    }
    if (job.kind === "validation") {
      const canonicalRevision = task.communication?.revision ?? 0;
      if (canonicalRevision !== 0 && job.instructionRevision !== canonicalRevision) {
        throw new Error(
          `validation instruction revision ${String(job.instructionRevision)} does not match canonical revision ${canonicalRevision}`,
        );
      }
      return;
    }
    await this.assertInstructionCurrent(
      task,
      job,
      options.instructionRevision,
      options.instructionRequired ?? true,
    );
  }

  /** Fails a worker job whose instruction went stale, blocking the task when it was a review. */
  private async retireStaleWorkerJob(
    state: RuntimeState,
    task: TaskRecord,
    job: DurableJob,
    error: unknown,
  ): Promise<void> {
    const staleReason = `stale worker instruction: ${describeError(error)}`;
    const retired = replaceRuntimeTask(state, task.id, (current) =>
      failedJobRuntime(current, job.id, staleReason, this.#deps.clock()),
    );
    await writeRuntimeState(this.#deps.runtimePath, retired);
    if (job.role === "reviewer" || job.role === "verifier") {
      await this.#deps.blockTask(task.id, staleReason, {
        group: "unusable-result",
        kind: "stale-review-state",
        summary: "The review was based on older instructions, so it no longer counts.",
        detail: staleReason,
        jobId: job.id,
      });
    }
  }

  async startQueuedTask(task: TaskRecord, reserved?: ReservationResult): Promise<void> {
    const role = workerRoleForTask(task);
    const reservation = reserved ?? (await this.#reservations.reserveTask(task.id, role));
    if ("refusal" in reservation) return;
    const runtime = reservation.runtime;
    const claim = claimOf(runtime.operation);
    if (claim === undefined) {
      await this.#records.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      return;
    }
    const lease =
      task.kind === "pr-review"
        ? await this.#leases.preparePrReviewLease(task, runtime, reservation, claim)
        : await this.#leases.prepareTaskLease(task, runtime, reservation, claim);
    if (lease === "stopped") return;
    if (lease === undefined) {
      await this.#records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't set up a working copy for this task.",
        detail: "worktree allocation returned no lease",
      });
      return;
    }
    const launch = await this.ensureLaunchEndpoint(
      task,
      runtime,
      claim,
      role,
      lease,
      reservation.reservation,
      ["queued"],
    );
    if (launch === undefined) {
      await this.#records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      return;
    }
    try {
      await this.#records.transitionIfOperationClaim(task.id, claim, {
        type: "start",
        worktree: lease,
        endpoints: [launch.endpoint],
      });
    } catch (error) {
      if (launch.created) {
        await this.#records.releaseUnlaunchedTaskReservation(
          task.id,
          reservation.reservation.id,
          claim,
        );
      }
      const reason = `task start transition failed ${launch.created ? "after pane allocation" : "with recovered pane"}: ${describeError(error)}`;
      await this.#records.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "transition-failed",
        summary: "Tandem couldn't start this task.",
        detail: reason,
      });
      return;
    }
    const currentTask = await this.#deps.getTask(task.id);
    const expectedStage = role === "scout" ? "scouting" : "implementing";
    if (currentTask.stage !== expectedStage) {
      if (taskAtRest(currentTask)) {
        await this.#records.releaseUnlaunchedTaskReservation(
          task.id,
          reservation.reservation.id,
          claim,
        );
      }
      return;
    }
    const currentRuntime = await this.#deps.runtimeFor(task.id);
    if (currentRuntime === undefined || currentRuntime.worktree === undefined) {
      await this.#records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The task's working copy is missing.",
        detail: "runtime lost its acquired worktree before worker launch",
      });
      return;
    }
    const writer = currentWriter(currentRuntime);
    if (writer === undefined) {
      await this.#records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The worker's terminal is gone.",
        detail: "runtime lost its worker endpoint before launch",
      });
      return;
    }
    await this.#launcher.launchAgent(currentTask, currentRuntime, writer, role);
  }

  /**
   * Ensures the task has an owned launch pane: returns the endpoint already recorded, or creates a
   * fresh one and records its endpoint-launch intent exactly as any other launch. Shared by
   * `startQueuedTask` (queued-only) and `relaunchWorker` (implementing/scouting re-entry); only the
   * stages the underlying effect is allowed to run in differ between the two callers.
   */
  private async ensureLaunchEndpoint(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    claim: OperationClaim,
    role: WorkerRole,
    lease: NonNullable<RuntimeTaskState["worktree"]>,
    reservation: DurableReservation,
    allowedStages: readonly TaskRecord["stage"][],
  ): Promise<Readonly<{ readonly endpoint: Endpoint; readonly created: boolean }> | undefined> {
    const existing = currentWriter({ ...runtime, worktree: lease });
    if (existing !== undefined) return { endpoint: existing, created: false };
    const created = await this.#records.withOperationEffect(
      task.id,
      claim,
      task.generation,
      allowedStages,
      async ({ task: currentTask, runtime: currentRuntime }) => {
        const workspaceLabel = taskWorkspaceLabel(currentTask);
        const endpointLaunch = endpointLaunchFor(
          reservation,
          this.#deps.terminal.name,
          this.#deps.sessionId,
          currentRuntime.taskName,
          workspaceLabel,
          lease.path,
          role,
          currentTask.generation,
          this.#deps.clock(),
          this.#deps.parentWorkspaceId,
          claim.id,
        );
        await this.#records.setReservationPhase(task.id, "endpoint", claim);
        if (!(await this.#records.saveEndpointLaunch(task.id, endpointLaunch, claim)))
          return undefined;
        await this.#records.recordOperationEffect(
          task.id,
          claim,
          `endpoint:${claim.id}`,
          "endpoint",
          "intent",
          endpointLaunch.workspaceLabel,
        );
        const result = await this.#deps.terminal.createWorkspace({
          sessionId: this.#deps.sessionId,
          cwd: lease.path,
          label: endpointLaunch.workspaceLabel,
          role,
          generation: currentTask.generation,
          ...(this.#deps.parentWorkspaceId === undefined
            ? {}
            : { parentWorkspaceId: this.#deps.parentWorkspaceId }),
        });
        await this.#records.recordOperationEffect(
          task.id,
          claim,
          `endpoint:${claim.id}`,
          "endpoint",
          "succeeded",
          endpointLaunch.workspaceLabel,
          JSON.stringify(result.endpoint),
        );
        await this.#records.saveEndpoint(task.id, result.endpoint, claim);
        return result;
      },
    );
    if (created === undefined) return undefined;
    return { endpoint: created.endpoint, created: true };
  }

  async beginFixes(task: TaskRecord, reserved?: ReservationResult): Promise<void> {
    const recoveryFix = task.stage !== "awaiting-fixes";
    if (!recoveryFix && task.reviewHead === undefined) {
      const reason = "fix stage has no reviewed HEAD";
      await this.#deps.blockTask(task.id, reason, {
        group: "user-decision",
        kind: "prerequisite-not-met",
        summary: "There's no reviewed work to fix yet.",
        detail: reason,
      });
      return;
    }
    const gate = recoveryFix ? undefined : fixRoundGate(task);
    if (gate !== undefined) {
      await this.stopBeforeFixRound(task.id, gate);
      return;
    }
    const reservation = reserved ?? (await this.#reservations.reserveTask(task.id, "implementer"));
    if ("refusal" in reservation) return;
    const operation = reservation.runtime.operation;
    const claim = claimOf(operation);
    const contextPath =
      reservation.runtime.fixContextPath ??
      join(taskJobsDirectory(this.#deps.home, task.id), `fix-context-${task.generation + 1}.json`);
    if (operation === undefined || claim === undefined) {
      await this.#records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      return;
    }
    if (operation.fixContext === undefined) {
      await this.#records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "The review findings weren't saved, so the fix couldn't start.",
        detail: "fix admission has no durable context snapshot",
      });
      return;
    }
    const fixContext = operation.fixContext;
    try {
      const written = await this.#records.withOperationEffect(
        task.id,
        claim,
        operation.generation,
        ["implementing"],
        async () => {
          await writeJsonAtomically(contextPath, {
            head: fixContext.head,
            generation: fixContext.generation,
            validationEvidence: fixContext.validationEvidence,
            findings: fixContext.findings,
          });
          return true;
        },
      );
      if (written !== true) return;
    } catch (error) {
      await this.#records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "Tandem couldn't save the review findings, so the fix couldn't start.",
        detail: `fix context could not be persisted: ${describeError(error)}`,
      });
      return;
    }
    const nextTask = await this.#deps.getTask(task.id);
    const nextRuntime = await this.#deps.runtimeFor(task.id);
    if (nextRuntime === undefined) {
      await this.#records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "safety-stop",
        kind: "runtime-metadata-missing",
        summary: "Tandem lost its saved record for this task, so the fix can't start.",
        detail: "fix round lost its durable runtime metadata before launch",
      });
      return;
    }
    const writer = currentWriter(nextRuntime);
    if (writer === undefined) {
      // The pane this fix round expected to reuse (the original implementer's, carried through
      // review) is gone. The begin-fixes transition above already committed this generation and its
      // review round, so this is never blocked here: release the reservation and leave the task at
      // `implementing` with no owned pane and no active job/reservation. The next reconcile tick
      // routes it through the already-wired implementing-stage central recovery (stop/save/re-enter,
      // `src/recovery/central.ts`), which proves the old pane dead (or finds none ever ran this
      // generation), snapshots any partial edits, and relaunches a fresh pane in the same preserved
      // worktree. `runtime.fixContextPath` survives that relaunch's own admission untouched (a plain
      // relaunch never overwrites it), so the new worker is told the same findings again without
      // spending another code-fix round.
      await this.#records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      return;
    }
    await this.#launcher.launchAgent(nextTask, nextRuntime, writer, "implementer");
  }

  /**
   * Blocks a task in `awaiting-fixes` before another fix round: on the "Keep fixing?" question, so
   * the person decides whether this same task and worktree get more fix rounds, or, once its one
   * extension is spent, with the open findings and no question. Nothing is launched and no round is
   * spent.
   */
  private async stopBeforeFixRound(taskId: string, gate: FixRoundGate): Promise<void> {
    const summary = gate.type === "ask" ? gate.question.text : gate.summary;
    const detail =
      gate.type === "ask" ? (gate.question.recommendation ?? gate.question.text) : gate.detail;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current?.stage !== "awaiting-fixes") return;
      await store.update(current.id, current.revision, (entry) => {
        const blocked = transitionTask(
          entry,
          {
            type: "block",
            reason: summary,
            cause: { group: "user-decision", kind: "fix-rounds-exhausted", summary, detail },
          },
          this.#deps.context(),
        );
        return gate.type === "ask" ? taskWithQuestion(blocked, gate.question) : blocked;
      });
    });
  }

  /**
   * Central recovery's re-entry move: gets an `implementing`/`scouting` task whose worker is proven
   * dead back into its core loop, without ever mutating the dead job, its result, or the durable
   * worktree lease. It admits a brand-new durable operation through the normal reservation gate
   * (`reserveTask`), launches a fresh owned pane when one is not already recorded, and starts a new
   * worker through the normal `launchAgent` path so a fresh receipt, instruction revision, and
   * prompt are built exactly as any other launch. The caller (central recovery) is responsible for
   * proving death and for snapshotting uncommitted work before calling this.
   */
  async relaunchWorker(
    task: TaskRecord,
    extraInstructions: readonly string[],
  ): Promise<RelaunchOutcome> {
    const role = workerRoleForTask(task);
    const allowedStages: readonly TaskRecord["stage"][] = ["implementing", "scouting"];
    const reservation = await this.#reservations.reserveTask(task.id, role);
    if ("refusal" in reservation) {
      return {
        relaunched: false,
        reason: reservation.summary,
        detail: reservation.detail,
        refusal: reservation.refusal,
      };
    }
    const runtime = reservation.runtime;
    const reservationId = reservation.reservation.id;
    const operation = runtime.operation;
    if (operation === undefined) {
      await this.#records.releaseUnlaunchedTaskReservation(task.id, reservationId);
      return {
        relaunched: false,
        reason: "Tandem couldn't record the new attempt.",
        detail: "relaunch admission produced no durable operation",
      };
    }
    const claim: OperationClaim = {
      id: operation.id,
      fencingRevision: operation.fencingRevision,
      claimOwner: operation.claimOwner,
    };
    const refuse = async (reason: string, detail: string): Promise<RelaunchOutcome> => {
      await this.#records.releaseUnlaunchedTaskReservation(task.id, reservationId, claim);
      return { relaunched: false, reason, detail };
    };
    const lease = runtime.worktree;
    if (lease === undefined) {
      const summary = "The task's working copy is missing, so it can't be restarted.";
      const detail = "relaunch requires an existing durable worktree";
      await this.#records.releaseAndBlock(task.id, reservationId, claim, {
        group: "lost-resource",
        kind: "resource-lost",
        summary,
        detail,
      });
      return { relaunched: false, reason: summary, detail };
    }
    // Re-entry never refuses on a moved source repository HEAD (only first launch does, via
    // assertSourceUnchanged); it only records the observation durably and notes it in plain English.
    const sourceDriftNote = await this.noteSourceDriftIfMoved(task, runtime, operation, claim);
    const launch = await this.ensureLaunchEndpoint(
      task,
      runtime,
      claim,
      role,
      lease,
      reservation.reservation,
      allowedStages,
    );
    if (launch === undefined) {
      return refuse(
        "Tandem couldn't open a terminal for the worker.",
        "relaunch could not allocate a worker pane",
      );
    }
    try {
      await this.#records.transitionIfOperationClaim(
        task.id,
        claim,
        { type: "relaunch", endpoints: [launch.endpoint], generation: task.generation },
        allowedStages,
      );
    } catch (error) {
      if (launch.created) {
        await this.#records.releaseUnlaunchedTaskReservation(task.id, reservationId, claim);
      }
      const reason = `relaunch transition failed: ${describeError(error)}`;
      await this.#records.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "transition-failed",
        summary: "Tandem couldn't restart this task.",
        detail: reason,
      });
      return { relaunched: false, reason: "Tandem couldn't restart this task.", detail: reason };
    }
    const currentTask = await this.#deps.getTask(task.id);
    if (currentTask.stage !== task.stage) {
      if (taskAtRest(currentTask)) {
        await this.#records.releaseUnlaunchedTaskReservation(task.id, reservationId, claim);
      }
      return {
        relaunched: false,
        reason: `The task became ${currentTask.stage} before the worker could start.`,
        detail: `task moved to ${currentTask.stage} before relaunch could start a worker`,
      };
    }
    const currentRuntime = await this.#deps.runtimeFor(task.id);
    if (currentRuntime === undefined) {
      return refuse(
        "Tandem lost its saved record for this task.",
        "relaunch lost its durable runtime metadata",
      );
    }
    const writer = currentWriter(currentRuntime);
    if (writer === undefined) {
      return refuse(
        "The worker's terminal closed before it could start.",
        "relaunch lost its worker endpoint before launch",
      );
    }
    await this.#launcher.launchAgent(currentTask, currentRuntime, writer, role, {
      extraInstructions,
    });
    return { relaunched: true, ...(sourceDriftNote === undefined ? {} : { sourceDriftNote }) };
  }

  /**
   * Re-entry only ever notes a moved source repository HEAD; it never refuses on it the way first
   * launch's `assertSourceUnchanged` does. When the current source HEAD no longer matches the
   * operation's recorded `inputHead`, the observation is recorded as a durable operation effect and
   * a plain-English note (no hashes) is returned for the restart notice.
   */
  private async noteSourceDriftIfMoved(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    operation: DurableOperation,
    claim: OperationClaim,
  ): Promise<string | undefined> {
    if (task.target !== undefined) return undefined;
    let current: GitCheckpoint;
    try {
      current = await readCheckpoint(this.#deps.run, { repo: taskSourcePath(task, runtime) });
    } catch {
      return undefined;
    }
    if (current.head === operation.inputHead) return undefined;
    const note = "the source repository has moved since this task started";
    await this.#records.recordOperationEffect(
      task.id,
      claim,
      `source-drift:${claim.id}`,
      "worker",
      "unknown",
      note,
      JSON.stringify({ inputHead: operation.inputHead, observedHead: current.head }),
    );
    return note;
  }

  async reconcileOperation(task: TaskRecord, runtime: RuntimeTaskState): Promise<void> {
    const operation = runtime.operation;
    const claim = claimOf(operation);
    if (operation === undefined || claim === undefined || operation.phase === "quarantined") return;
    for (const effect of operation.effects) {
      if (effect.kind === "worktree" && runtime.worktree === undefined) {
        if (
          effect.phase === "succeeded" &&
          (await this.#records.restoreResourceEffect(task.id, effect, claim))
        ) {
          return;
        }
        if (effect.phase !== "succeeded") {
          await this.#records.quarantineOperation(
            task.id,
            `worktree effect ${effect.id} has no durable receipt; allocator will not be retried`,
            claim,
          );
          return;
        }
      }
      if (effect.kind === "endpoint" && runtime.endpointLaunch === undefined) {
        if (effect.phase !== "succeeded" || effect.receipt === undefined) {
          await this.#records.quarantineOperation(
            task.id,
            `endpoint effect ${effect.id} has no durable receipt; pane allocator will not be retried`,
            claim,
          );
          return;
        }
        let receipt: unknown;
        try {
          receipt = JSON.parse(effect.receipt);
        } catch {
          await this.#records.quarantineOperation(
            task.id,
            `endpoint effect ${effect.id} has invalid receipt`,
            claim,
          );
          return;
        }
        if (
          !isRecord(receipt) ||
          typeof receipt.paneId !== "string" ||
          typeof receipt.generation !== "number"
        ) {
          await this.#records.quarantineOperation(
            task.id,
            `endpoint effect ${effect.id} has invalid receipt`,
            claim,
          );
          return;
        }
        const samePane = runtime.endpoints.find((entry) => entry.paneId === receipt.paneId);
        if (samePane !== undefined && samePane.generation !== receipt.generation) {
          await this.#records.quarantineOperation(
            task.id,
            `endpoint effect ${effect.id} receipt generation conflicts with runtime`,
            claim,
          );
          return;
        }
        const linked = runtime.endpoints.some(
          (entry) => entry.paneId === receipt.paneId && entry.generation === receipt.generation,
        );
        if (!linked) {
          if (await this.#records.restoreResourceEffect(task.id, effect, claim)) return;
          await this.#records.quarantineOperation(
            task.id,
            `endpoint effect ${effect.id} could not be restored`,
            claim,
          );
          return;
        }
      }
    }
    const reservation =
      runtime.reservation === undefined || runtime.reservation.phase === "released"
        ? undefined
        : { task, runtime, reservation: runtime.reservation };
    if (operation.kind === "fix") {
      await this.beginFixes(task, reservation);
      return;
    }
    if (operation.kind === "validation") {
      await this.#validation.startValidation(task, reservation);
      return;
    }
    if (operation.kind === "review" || operation.kind === "verification") {
      await this.#review.advanceReview(task, reservation);
      return;
    }
    if (task.stage === "queued") {
      await this.startQueuedTask(task, reservation);
      return;
    }
    const writer = currentWriter(runtime);
    if (writer !== undefined && runtime.worktree !== undefined) {
      await this.#launcher.launchAgent(task, runtime, writer, workerRoleForTask(task));
    }
  }

  /** Checks a finished review against the lens and the diff it was given; an Error when unusable. */
  private async readPrReviewRound(
    task: TaskRecord,
    state: NonNullable<TaskRecord["prReview"]>,
    job: DurableJob,
    text: string,
  ): Promise<PrReviewRound | Error> {
    try {
      const files = await readRunFiles(this.#deps.home, task.id, job.generation);
      const checked = checkReview(JSON.parse(text), state.lens, files.commentable);
      return {
        generation: job.generation,
        head: files.head,
        from: files.from,
        // The runner's head is authoritative; a typo in the reviewer's copy must not misplace a post.
        review: { ...checked.review, head: files.head },
        notes: checked.notes,
      };
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}
