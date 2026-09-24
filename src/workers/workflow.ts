import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GitCheckpoint, readCheckpoint } from "../adapters/git.ts";
import {
  closeEndpoint,
  createReviewerEndpoint,
  createTaskEndpoint,
  type HerdrPaneInspection,
  inspectEndpoint,
  sendCommand,
  taskWorkspaceLabel,
} from "../adapters/herdr.ts";
import {
  EndpointBusyError,
  EndpointOwnershipError,
  LeaseSafetyError,
} from "../adapters/primitives.ts";
import { acquireWorktree } from "../adapters/treehouse.ts";
import type {
  BlockCause,
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  ReviewLens,
  ReviewLevelRecord,
  ReviewMode,
  TaskQuestion,
  TaskRecord,
  WorkerReceipt,
} from "../contracts.ts";
import { buildPrReviewBrief } from "../pr-review/brief.ts";
import { renderReviewText } from "../pr-review/render.ts";
import { checkReview } from "../pr-review/review.ts";
import { preparePrReviewRun, readRunFiles } from "../pr-review/run.ts";
import { type PrReviewRound, prReviewRunDiffPath } from "../pr-review/state.ts";
import { isQuarantinedReviewFailure, unresolvedReviewFailure } from "../recovery/central-review.ts";
import { activeRuntimeJob, taskRuntime, unreleasedReservation } from "../runtime/activity.ts";
import { withStateLock } from "../runtime/database.ts";
import {
  readRuntimeState,
  taskJobsDirectory,
  updateRuntimeState,
  writeJsonAtomically,
  writeRuntimeState,
  writeTextAtomically,
} from "../runtime/persistence.ts";
import type {
  DurableEndpointLaunch,
  DurableExecutionRouting,
  DurableJob,
  DurableOperation,
  DurableOperationEffect,
  DurableOperationPhase,
  DurableReservation,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import type { RequestUsageEvent } from "../runtime/usage.ts";
import { type RequestUsageReadout, requestUsageExposure } from "../runtime/usage-receipt.ts";
import {
  appendTaskJob,
  buildPrompt,
  currentWriter,
  DEFAULT_STARTUP_GRACE_MS,
  describeError,
  durableOperation,
  endpointLaunchFor,
  instructionOptions,
  isMissing,
  isMissingEndpoint,
  isOlderThan,
  isRecord,
  jobDirectoryFor,
  jobPaths,
  makeDurableJob,
  modelRoleForTask,
  nowMilliseconds,
  replaceJob,
  replaceRuntimeTask,
  reportPathFor,
  reviewFindings,
  runtimeReservation,
  singleLine,
  taskWithQuestion,
  workerCommand,
  workerRoleForTask,
} from "../service/records.ts";
import {
  closeFinishedScoutPanes,
  decideScoutWorktreeRelease,
  observeScoutCheckout,
} from "../service/scout-cleanup.ts";
import { taskSourcePath } from "../service/source.ts";
import {
  type PlannedValidation,
  planValidation,
  policyIdentity,
  ValidationConfigurationError,
} from "../tasks/acceptance.ts";
import {
  readWorkerReceipt,
  taskInboxPath,
  workerReceiptPath,
} from "../tasks/communication-persistence.ts";
import { MAX_TASK_MESSAGE_CHARS } from "../tasks/communication-protocol.ts";
import { keepFixingQuestion } from "../tasks/findings.ts";
import { type TaskEvent, type TaskTransitionContext, transitionTask } from "../tasks/lifecycle.ts";
import type { ReviewAssistanceRuntime } from "../tasks/review-assistance.ts";
import { buildReviewBrief, renderReviewBrief } from "../tasks/review-brief.ts";
import { requiredReviewLenses } from "../tasks/review-levels.ts";
import type { TaskStore, TaskStoreTransaction } from "../tasks/store.ts";
import {
  readValidationResult,
  type ValidationJob,
  type ValidationResult,
} from "../validation-worker.ts";
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
  assertSourceUnchanged,
  type CurrentCheckout,
  isClean,
  isCleanAt,
  readWorkerCheckout,
} from "./checkout.ts";
import {
  describeExecutionRoutingDecision,
  type ExecutionUsageObservation,
  executionRoutingPauseStands,
  type ModelCatalogueReader,
  type ModelCatalogueSnapshot,
  type RaisedExecutionRoutingPause,
  resolvedExecutionModel,
  resolveExecutionRouting,
  routingPauseExplanation,
} from "./execution-routing.ts";
import {
  consumedJobRuntime,
  failedJobRuntime,
  planJobConsumption,
  taskAtRest,
} from "./job-settlement.ts";
import {
  parseWorkerJob,
  readWorkerResult,
  type WorkerJob,
  type WorkerResult,
  type WorkerRole,
} from "./jobs.ts";
import {
  claimedOperation,
  claimOf,
  executionIdentity,
  holdsClaim,
  type OperationClaim,
  operationSettled,
} from "./operation-claim.ts";
import { reviewerBriefContext, reviewRoundPaths, workerBriefContext } from "./prompts.ts";
import {
  type ClassifiedReviewRound,
  classifyReviewRound,
  type ReviewDiffFacts,
  readReviewDiffFacts,
  reviewBriefObservations,
} from "./review-round.ts";
import { liveWorkerTerminal, workerDelegationStopped } from "./terminal.ts";
import { prepareWorkerTerminal, workerJobForEndpoint } from "./terminal-control.ts";

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

/** Re-stamps a prepared job spec with the claim now launching it, after checking its identity. */
async function refreshJobSpecClaim(job: DurableJob, claim: OperationClaim): Promise<void> {
  const parsed = JSON.parse(await readFile(job.jobPath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.id !== job.id || parsed.taskId !== job.taskId) {
    throw new Error("prepared job spec identity does not match durable job");
  }
  if (parsed.generation !== job.generation || !isRecord(parsed.execution)) {
    throw new Error("prepared job spec execution identity is invalid");
  }
  await writeJsonAtomically(job.jobPath, {
    ...parsed,
    execution: {
      ...parsed.execution,
      operationId: claim.id,
      fencingRevision: claim.fencingRevision,
      claimOwner: claim.claimOwner,
    },
  });
}

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

/** The decision a worker stopped on, bounded to what a task message may carry. */
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
  readonly reviewAssistance: ReviewAssistanceRuntime;
  /** Appends accounting facts. It records only; it never decides whether work may continue. */
  readonly recordRequestUsage: (events: readonly RequestUsageEvent[]) => Promise<void>;
  /** The accounting ledger's own rows for one request, read for economical routing's usage check. */
  readonly readRequestUsage: (requestId: string) => Promise<RequestUsageReadout>;
  /** Whether the request's approved brief says its work needs no code review. */
  readonly briefSkipsReview: (requestId: string) => Promise<boolean>;
  /** Reads catalogue tier evidence at an execution boundary; it never enables a provider. */
  readonly readModelCatalogue: ModelCatalogueReader;
}>;
export class WorkerWorkflow {
  readonly #deps: WorkerWorkflowDependencies;
  readonly #claimOwner: string;

  constructor(deps: WorkerWorkflowDependencies) {
    this.#deps = deps;
    this.#claimOwner = `${deps.sessionId}:${process.pid}:${randomUUID()}`;
  }

  get claimOwner(): string {
    return this.#claimOwner;
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
      await this.launchJob(task.id, job.id, endpoint, job.cwd, command, claim);
      return;
    }
    if (endpoint === undefined) {
      if (isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
        const reason = "worker job has no durable endpoint identity";
        await this.failJob(task, job, reason, claim, true, true, {
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
    let inspection: HerdrPaneInspection;
    try {
      inspection = await inspectEndpoint(this.#deps.run, {
        endpoint,
        cwd: job.cwd,
      });
    } catch (error) {
      if (error instanceof EndpointOwnershipError && error.reason === "missing") {
        await this.reconcileMissingEndpoint(task, job, claim);
        return;
      }
      throw error;
    }
    if (inspection.activeWorker) {
      await this.observeWorkerProgress(task, job, claim);
      const terminal = await liveWorkerTerminal(inspection, job);
      if (terminal === undefined || (!terminal.completed && terminal.phase !== "paused")) {
        if (job.phase !== "running") {
          await this.updateJob(job.taskId, job.id, claim, (current) => ({
            ...current,
            phase: "running",
          }));
        }
        return;
      }
    }
    if (job.kind === "worker") {
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
          await this.failJob(task, job, reason, claim, true, true, {
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
        await this.failJob(task, job, rejectedReason, claim, true, false, {
          group: "unusable-result",
          kind: "worker-failed",
          summary: "The worker's report couldn't be read.",
          detail: rejectedReason,
          jobId: job.id,
        });
        return;
      }
      await this.consumeWorkerResult(task, runtime, job, result);
      return;
    }
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
        await this.failJob(
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
      await this.failJob(task, job, rejectedReason, claim, true, false, {
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
      await this.failJob(task, job, reason, claim, false, false);
      return;
    }
    await this.failJob(task, job, reason, claim, true, true, {
      group: "safety-stop",
      kind: "quarantined-unknown-outcome",
      summary:
        "The worker's terminal disappeared before it finished, so Tandem paused the task for you to look at.",
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
      await this.updateJob(job.taskId, job.id, claim, (current) => {
        const { progressWarningAt: _progressWarningAt, ...withoutWarning } = current;
        return withoutWarning;
      });
      return;
    }
    if (warning === "none") return;
    await this.updateJob(job.taskId, job.id, claim, (current) => ({
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
          ...instructionOptions(result.instructionRevision),
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
      await this.failJob(task, job, reason, claim, true, false, {
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
      await this.failJob(task, job, reason, claim, reviewJob, false, {
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
      instructionOptions(result.instructionRevision),
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
      instructionOptions(result.instructionRevision),
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
      instructionOptions(result.instructionRevision),
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
      await this.failJob(task, job, reason, claim, true, false, {
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
      await this.failJob(task, job, reason, claim, true, false, {
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
      instructionOptions(result.instructionRevision),
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
      await this.failJob(
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
      await this.failJob(task, job, reason, claim, true, false, {
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
      await this.failJob(task, job, reason, claim, true, false, {
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
      await this.failJob(task, job, reason, claim, true, false, {
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
      await closeEndpoint(this.#deps.run, {
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

  private async failJob(
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
        if (
          current === undefined ||
          currentJob === undefined ||
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
  private async blockIfOperationClaim(
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
  private async transitionIfOperationClaim(
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
        await store.update(task.id, task.revision, () => nextTask);
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
  private async setReservationPhase(
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

  private async recordOperationEffect(
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

  private async withOperationEffect<Result>(
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

  async startQueuedTask(task: TaskRecord, reserved?: ReservationResult): Promise<void> {
    const role = workerRoleForTask(task);
    const reservation = reserved ?? (await this.reserveTask(task.id, role));
    if ("refusal" in reservation) return;
    const runtime = reservation.runtime;
    const claim = claimOf(runtime.operation);
    if (claim === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      return;
    }
    const lease =
      task.kind === "pr-review"
        ? await this.preparePrReviewLease(task, runtime, reservation, claim)
        : await this.prepareTaskLease(task, runtime, reservation, claim);
    if (lease === "stopped") return;
    if (lease === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const noLeaseReason = "worktree allocation returned no lease";
      await this.blockIfOperationClaim(task.id, noLeaseReason, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't set up a working copy for this task.",
        detail: noLeaseReason,
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
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return;
    }
    try {
      await this.transitionIfOperationClaim(task.id, claim, {
        type: "start",
        worktree: lease,
        endpoints: [launch.endpoint],
      });
    } catch (error) {
      if (launch.created) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      }
      const reason = `task start transition failed ${launch.created ? "after pane allocation" : "with recovered pane"}: ${describeError(error)}`;
      await this.blockIfOperationClaim(task.id, reason, claim, {
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
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      }
      return;
    }
    const currentRuntime = await this.#deps.runtimeFor(task.id);
    if (currentRuntime === undefined || currentRuntime.worktree === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = "runtime lost its acquired worktree before worker launch";
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The task's working copy is missing.",
        detail: reason,
      });
      return;
    }
    const writer = currentWriter(currentRuntime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = "runtime lost its worker endpoint before launch";
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The worker's terminal is gone.",
        detail: reason,
      });
      return;
    }
    await this.launchAgent(currentTask, currentRuntime, writer, role);
  }

  /** Leases and checks a pool worktree at the pinned source commit for a scout or implementation. */
  private async prepareTaskLease(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    reservation: ReservationResult,
    claim: OperationClaim,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | undefined | "stopped"> {
    const adoption =
      runtime.worktree === undefined ? await this.adoptableScoutWorktree(task) : undefined;
    if (runtime.worktree === undefined && adoption === undefined) {
      const poolReady = await this.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["queued"],
        ({ task: currentTask }) => this.#deps.maintainPoolForAllocation(currentTask),
      );
      if (poolReady !== true) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
        return "stopped";
      }
    }
    let lease = runtime.worktree;
    try {
      // A target task is pinned to a fetched commit; the user's own checkout may be anywhere.
      if (task.target === undefined) {
        const source = await readCheckpoint(this.#deps.run, {
          repo: taskSourcePath(task, runtime),
        });
        assertSourceUnchanged(
          runtime.sourceCheckpoint,
          source,
          runtime.sourceRepoPath !== undefined,
        );
      }
      const expectedHolder = `${this.#deps.sessionId}:${task.id}`;
      // An implementation may run in the worktree it adopted from its first research handoff's
      // scout, which Treehouse still records under that scout's holder.
      const adoptedFrom =
        task.kind === "implementation" ? task.researchHandoffs?.[0]?.scoutTaskId : undefined;
      const allowedHolders =
        adoptedFrom === undefined
          ? [expectedHolder]
          : [expectedHolder, `${this.#deps.sessionId}:${adoptedFrom}`];
      if (lease !== undefined && !allowedHolders.includes(lease.leaseHolder)) {
        throw new LeaseSafetyError(
          `runtime worktree lease is held by ${JSON.stringify(lease.leaseHolder)}, expected ${JSON.stringify(expectedHolder)}`,
          lease,
        );
      }
      const needsFirstLaunchValidation = runtime.jobs.length === 0;
      const needsLeasePreparation =
        lease === undefined ||
        lease.baseHead === "unknown" ||
        (needsFirstLaunchValidation &&
          task.worktree === undefined &&
          runtime.endpointLaunch === undefined &&
          runtime.endpoints.length === 0);
      if (lease !== undefined && needsFirstLaunchValidation) {
        const savedLease = await readCheckpoint(this.#deps.run, { repo: lease.path });
        if (!isCleanAt(savedLease, runtime.sourceCheckpoint.head)) {
          throw new LeaseSafetyError(
            `saved worktree is not the captured source commit ${runtime.sourceCheckpoint.head}`,
            lease,
          );
        }
      }
      if (needsLeasePreparation) {
        const holder = adoption?.leaseHolder ?? expectedHolder;
        const prepared = await this.withOperationEffect(
          task.id,
          claim,
          task.generation,
          ["queued"],
          (current) =>
            this.restoreOrAcquireWorktree(current.task, current.runtime, claim, {
              holder,
              adoption,
              adoptedFrom,
              lease,
            }),
        );
        if (prepared === undefined) {
          await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
          return "stopped";
        }
        lease = prepared;
      }
    } catch (error) {
      if (error instanceof LeaseSafetyError) {
        await this.saveWorktree(task.id, { ...error.lease, baseHead: "unknown" }, claim);
      }
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const allocationFailedReason = `worktree allocation failed: ${describeError(error)}`;
      await this.blockIfOperationClaim(task.id, allocationFailedReason, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't set up a working copy for this task.",
        detail: allocationFailedReason,
      });
      const noLeaseReason = "worktree allocation returned no lease";
      await this.blockIfOperationClaim(task.id, noLeaseReason, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't set up a working copy for this task.",
        detail: noLeaseReason,
      });
      return "stopped";
    }
    return lease;
  }

  /**
   * Restores the worktree a prior attempt of this operation already acquired, or acquires one
   * from Treehouse under `holder`, recording the allocator effect before and after. An unresolved
   * or unreadable earlier effect quarantines the operation instead of retrying the allocator.
   */
  private async restoreOrAcquireWorktree(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    claim: OperationClaim,
    input: Readonly<{
      readonly holder: string;
      readonly adoption: NonNullable<RuntimeTaskState["worktree"]> | undefined;
      readonly adoptedFrom: string | undefined;
      readonly lease: NonNullable<RuntimeTaskState["worktree"]> | undefined;
    }>,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | undefined> {
    const effectId = `worktree:${claim.id}`;
    const existingEffect = runtime.operation?.effects.find((entry) => entry.id === effectId);
    if (existingEffect !== undefined) {
      if (existingEffect.phase !== "succeeded" || existingEffect.receipt === undefined) {
        await this.quarantineOperation(
          task.id,
          `worktree effect ${existingEffect.id} is unresolved; allocator retry refused`,
          claim,
        );
        return undefined;
      }
      try {
        const restored = JSON.parse(existingEffect.receipt) as NonNullable<
          RuntimeTaskState["worktree"]
        >;
        await this.saveWorktree(task.id, restored, claim, input.adoptedFrom);
        return restored;
      } catch {
        await this.quarantineOperation(
          task.id,
          `worktree effect ${existingEffect.id} has an invalid receipt`,
          claim,
        );
        return undefined;
      }
    }
    await this.recordOperationEffect(task.id, claim, effectId, "worktree", "intent", input.holder);
    const { adoption, lease } = input;
    const acquired = await acquireWorktree(this.#deps.run, {
      repo: taskSourcePath(task, runtime),
      root: this.#deps.poolRoot,
      tandemId: input.holder,
      taskName: runtime.taskName,
      sourceHead: runtime.sourceCheckpoint.head,
      ...(adoption === undefined
        ? {}
        : { adopt: { branch: adoption.branch, head: adoption.baseHead } }),
    });
    if (
      lease !== undefined &&
      (acquired.leaseId !== lease.leaseId || acquired.path !== lease.path)
    ) {
      throw new LeaseSafetyError(
        "treehouse returned a different lease than the runtime worktree",
        acquired,
      );
    }
    if (acquired.baseHead !== runtime.sourceCheckpoint.head) {
      throw new LeaseSafetyError(
        `acquired worktree base ${acquired.baseHead} does not match pinned source ${runtime.sourceCheckpoint.head}`,
        acquired,
      );
    }
    await this.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "worktree",
      "succeeded",
      input.holder,
      JSON.stringify(acquired),
    );
    await this.saveWorktree(task.id, acquired, claim, input.adoptedFrom);
    return acquired;
  }

  /**
   * Readies the PR review worktree from the user's own checkout and writes the run's diff and
   * context. It replaces the pool lease: a review never uses the coordinator's source commit.
   */
  private async preparePrReviewLease(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    reservation: ReservationResult,
    claim: OperationClaim,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | "stopped"> {
    const state = task.prReview;
    try {
      if (state === undefined) throw new Error("the task records no pull request");
      const lease = await this.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["queued"],
        async ({ task: currentTask }) => {
          const prepared = await preparePrReviewRun({
            run: this.#deps.run,
            clock: this.#deps.clock,
            home: this.#deps.home,
            taskId: currentTask.id,
            holder: `${this.#deps.sessionId}:${currentTask.id}`,
            generation: currentTask.generation,
            state: currentTask.prReview ?? state,
            ...(runtime.worktree === undefined ? {} : { existing: runtime.worktree }),
          });
          await this.saveWorktree(currentTask.id, prepared.lease, claim);
          return prepared.lease;
        },
      );
      if (lease !== undefined) return lease;
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return "stopped";
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = `PR review checkout failed: ${describeError(error)}`;
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't set up a checkout of this pull request.",
        detail: reason,
      });
      return "stopped";
    }
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
    const created = await this.withOperationEffect(
      task.id,
      claim,
      task.generation,
      allowedStages,
      async ({ task: currentTask, runtime: currentRuntime }) => {
        const workspaceLabel = taskWorkspaceLabel(
          currentRuntime.taskName,
          currentTask.objective,
          role,
        );
        const endpointLaunch = endpointLaunchFor(
          reservation,
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
        await this.setReservationPhase(task.id, "endpoint", claim);
        if (!(await this.saveEndpointLaunch(task.id, endpointLaunch, claim))) return undefined;
        await this.recordOperationEffect(
          task.id,
          claim,
          `endpoint:${claim.id}`,
          "endpoint",
          "intent",
          endpointLaunch.workspaceLabel,
        );
        const result = await createTaskEndpoint(this.#deps.run, {
          sessionId: this.#deps.sessionId,
          cwd: lease.path,
          taskName: currentRuntime.taskName,
          workspaceLabel: endpointLaunch.workspaceLabel,
          role,
          generation: currentTask.generation,
          ...(this.#deps.parentWorkspaceId === undefined
            ? {}
            : { parentWorkspaceId: this.#deps.parentWorkspaceId }),
        });
        await this.recordOperationEffect(
          task.id,
          claim,
          `endpoint:${claim.id}`,
          "endpoint",
          "succeeded",
          endpointLaunch.workspaceLabel,
          JSON.stringify(result.endpoint),
        );
        await this.saveEndpoint(task.id, result.endpoint, claim);
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
    const keepFixing = recoveryFix ? undefined : keepFixingQuestion(task);
    if (keepFixing !== undefined) {
      await this.askKeepFixing(task.id, keepFixing);
      return;
    }
    const reservation = reserved ?? (await this.reserveTask(task.id, "implementer"));
    if ("refusal" in reservation) return;
    const operation = reservation.runtime.operation;
    const claim = claimOf(operation);
    const contextPath =
      reservation.runtime.fixContextPath ??
      join(taskJobsDirectory(this.#deps.home, task.id), `fix-context-${task.generation + 1}.json`);
    if (operation === undefined || claim === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return;
    }
    if (operation.fixContext === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = "fix admission has no durable context snapshot";
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "The review findings weren't saved, so the fix couldn't start.",
        detail: reason,
      });
      return;
    }
    const fixContext = operation.fixContext;
    try {
      const written = await this.withOperationEffect(
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
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = `fix context could not be persisted: ${describeError(error)}`;
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "Tandem couldn't save the review findings, so the fix couldn't start.",
        detail: reason,
      });
      return;
    }
    const nextTask = await this.#deps.getTask(task.id);
    const nextRuntime = await this.#deps.runtimeFor(task.id);
    if (nextRuntime === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = "fix round lost its durable runtime metadata before launch";
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "safety-stop",
        kind: "runtime-metadata-missing",
        summary: "Tandem lost its saved record for this task, so the fix can't start.",
        detail: reason,
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
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return;
    }
    await this.launchAgent(nextTask, nextRuntime, writer, "implementer");
  }

  /**
   * Blocks a task in `awaiting-fixes` on the "Keep fixing?" question, so the person decides whether
   * this same task and worktree get more fix rounds. Nothing is launched and no round is spent.
   */
  private async askKeepFixing(taskId: string, question: TaskQuestion): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current?.stage !== "awaiting-fixes") return;
      await store.update(current.id, current.revision, (entry) =>
        taskWithQuestion(
          transitionTask(
            entry,
            {
              type: "block",
              reason: question.text,
              cause: {
                group: "user-decision",
                kind: "fix-rounds-exhausted",
                summary: question.text,
                detail: question.recommendation ?? question.text,
              },
            },
            this.#deps.context(),
          ),
          question,
        ),
      );
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
  ): Promise<
    Readonly<{
      readonly relaunched: boolean;
      readonly reason?: string;
      readonly detail?: string;
      readonly refusal?: ReservationRefusal["refusal"];
      readonly sourceDriftNote?: string;
    }>
  > {
    const role = workerRoleForTask(task);
    const allowedStages: readonly TaskRecord["stage"][] = ["implementing", "scouting"];
    const reservation = await this.reserveTask(task.id, role);
    if ("refusal" in reservation) {
      return {
        relaunched: false,
        reason: reservation.summary,
        detail: reservation.detail,
        refusal: reservation.refusal,
      };
    }
    const runtime = reservation.runtime;
    const operation = runtime.operation;
    if (operation === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
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
    const lease = runtime.worktree;
    if (lease === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = "relaunch requires an existing durable worktree";
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The task's working copy is missing, so it can't be restarted.",
        detail: reason,
      });
      return {
        relaunched: false,
        reason: "The task's working copy is missing, so it can't be restarted.",
        detail: reason,
      };
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
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return {
        relaunched: false,
        reason: "Tandem couldn't open a terminal for the worker.",
        detail: "relaunch could not allocate a worker pane",
      };
    }
    try {
      await this.transitionIfOperationClaim(
        task.id,
        claim,
        { type: "relaunch", endpoints: [launch.endpoint], generation: task.generation },
        allowedStages,
      );
    } catch (error) {
      if (launch.created) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      }
      const reason = `relaunch transition failed: ${describeError(error)}`;
      await this.blockIfOperationClaim(task.id, reason, claim, {
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
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      }
      return {
        relaunched: false,
        reason: `The task became ${currentTask.stage} before the worker could start.`,
        detail: `task moved to ${currentTask.stage} before relaunch could start a worker`,
      };
    }
    const currentRuntime = await this.#deps.runtimeFor(task.id);
    if (currentRuntime === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return {
        relaunched: false,
        reason: "Tandem lost its saved record for this task.",
        detail: "relaunch lost its durable runtime metadata",
      };
    }
    const writer = currentWriter(currentRuntime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return {
        relaunched: false,
        reason: "The worker's terminal closed before it could start.",
        detail: "relaunch lost its worker endpoint before launch",
      };
    }
    await this.launchAgent(currentTask, currentRuntime, writer, role, { extraInstructions });
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
    await this.recordOperationEffect(
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

  private async restoreResourceEffect(
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
            endpoints: current.endpoints.some((entry) => entry.paneId === value.paneId)
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
  private async quarantineOperation(
    taskId: string,
    reason: string,
    claim: OperationClaim,
  ): Promise<void> {
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
  async reconcileOperation(task: TaskRecord, runtime: RuntimeTaskState): Promise<void> {
    const operation = runtime.operation;
    const claim = claimOf(operation);
    if (operation === undefined || claim === undefined || operation.phase === "quarantined") return;
    for (const effect of operation.effects) {
      if (effect.kind === "worktree" && runtime.worktree === undefined) {
        if (
          effect.phase === "succeeded" &&
          (await this.restoreResourceEffect(task.id, effect, claim))
        ) {
          return;
        }
        if (effect.phase !== "succeeded") {
          await this.quarantineOperation(
            task.id,
            `worktree effect ${effect.id} has no durable receipt; allocator will not be retried`,
            claim,
          );
          return;
        }
      }
      if (effect.kind === "endpoint" && runtime.endpointLaunch === undefined) {
        if (effect.phase !== "succeeded" || effect.receipt === undefined) {
          await this.quarantineOperation(
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
          await this.quarantineOperation(
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
          await this.quarantineOperation(
            task.id,
            `endpoint effect ${effect.id} has invalid receipt`,
            claim,
          );
          return;
        }
        const samePane = runtime.endpoints.find((entry) => entry.paneId === receipt.paneId);
        if (samePane !== undefined && samePane.generation !== receipt.generation) {
          await this.quarantineOperation(
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
          if (await this.restoreResourceEffect(task.id, effect, claim)) return;
          await this.quarantineOperation(
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
      await this.startValidation(task, reservation);
      return;
    }
    if (operation.kind === "review" || operation.kind === "verification") {
      await this.advanceReview(task, reservation);
      return;
    }
    if (task.stage === "queued") {
      await this.startQueuedTask(task, reservation);
      return;
    }
    const writer = currentWriter(runtime);
    if (writer !== undefined && runtime.worktree !== undefined) {
      await this.launchAgent(task, runtime, writer, workerRoleForTask(task));
    }
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
    const reservation = reserved ?? (await this.reserveTask(task.id, "validation"));
    if ("refusal" in reservation) return reservation;
    const runtime = reservation.runtime;
    const claim = claimOf(runtime.operation);
    if (claim === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return;
    }
    const stopWithoutLaunch = async (reason: string, cause: Omit<BlockCause, "detail">) => {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      await this.blockIfOperationClaim(task.id, reason, claim, { ...cause, detail: reason });
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
      validationEndpoint = await this.withOperationEffect(
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
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
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
      const jobWritten = await this.withOperationEffect(
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
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
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
      await this.appendJob(task.id, durableJob, claim);
    } catch (error) {
      await stopWithoutLaunch(`validation job could not be persisted: ${describeError(error)}`, {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "Tandem couldn't save the check run.",
      });
      return;
    }
    await this.launchJob(
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
        await this.quarantineOperation(
          task.id,
          `endpoint effect ${existingEffect.id} is unresolved`,
          claim,
        );
        return undefined;
      }
      try {
        const restored = JSON.parse(existingEffect.receipt) as Endpoint;
        await this.saveEndpoint(task.id, restored, claim);
        return restored;
      } catch {
        await this.quarantineOperation(
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
    await this.recordOperationEffect(task.id, claim, effectId, "endpoint", "intent", identity);
    const result = await createReviewerEndpoint(this.#deps.run, {
      sessionId: this.#deps.sessionId,
      cwd: runtime.worktree?.path ?? validationCwd,
      writer,
      generation: task.generation,
      ...(writerJob === undefined ? {} : { writerJob }),
    });
    await this.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "endpoint",
      "succeeded",
      identity,
      JSON.stringify(result.endpoint),
    );
    await this.saveEndpoint(task.id, result.endpoint, claim);
    return result.endpoint;
  }

  /**
   * Persists the round's classification so the level and its reason survive a restart and appear
   * in the task summary. The durable write is skipped when the classification is unchanged, which
   * keeps a review tick from bumping the task revision for nothing.
   */
  private async recordReviewLevel(
    task: TaskRecord,
    record: ReviewLevelRecord,
  ): Promise<TaskRecord> {
    if (
      task.reviewLevel !== undefined &&
      JSON.stringify(task.reviewLevel) === JSON.stringify(record)
    ) {
      return task;
    }
    return this.#deps.updateTask(task.id, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      reviewLevel: record,
    }));
  }

  async advanceReview(task: TaskRecord, reserved?: ReservationResult): Promise<void> {
    const reviewHead = task.reviewHead;
    const worktree = task.worktree;
    if (reviewHead === undefined || worktree === undefined) {
      const reason = "review requires a task worktree and reviewed HEAD";
      await this.#deps.blockTask(task.id, reason, {
        group: "user-decision",
        kind: "prerequisite-not-met",
        summary: "There's no finished work to review yet.",
        detail: reason,
      });
      return;
    }
    const runtime = await this.#deps.runtimeFor(task.id);
    if (runtime === undefined) {
      const reason = "review has no durable runtime metadata";
      await this.#deps.blockTask(task.id, reason, {
        group: "safety-stop",
        kind: "runtime-metadata-missing",
        summary: "Tandem lost its saved record for this task, so the review can't run.",
        detail: reason,
      });
      return;
    }
    // A lens whose most recent job failed and is still unresolved either blocks (a genuine content
    // failure the worker itself reported, a stale canonical instruction, or a malformed result) or,
    // when the job's own recorded reason is a durable-quarantine one (proven-unowned: the pane or its
    // result disappeared, never proof of a real outcome), is left for central recovery's `reviewing`
    // re-entry, which the caller runs before this method and which clears the dead lens so it is
    // picked up as `nextLens` below instead.
    const failedReview = unresolvedReviewFailure(task, runtime);
    if (failedReview !== undefined && !isQuarantinedReviewFailure(failedReview)) {
      const reason = failedReview.error ?? `review ${failedReview.reviewLens ?? "worker"} failed`;
      await this.#deps.blockTask(task.id, reason, {
        group: "unusable-result",
        kind: "review-lens-failed",
        summary: "One of the reviews failed.",
        detail: reason,
      });
      return;
    }
    if (!(await this.reviewersStopped(task, runtime, worktree.path))) return;
    const currentCheckout = await readCheckpoint(this.#deps.run, {
      repo: worktree.path,
      baseRef: worktree.baseHead,
    });
    if (!isCleanAt(currentCheckout, reviewHead)) {
      const reason = "review refused because the worktree is stale or dirty";
      await this.#deps.blockTask(task.id, reason, {
        group: "user-decision",
        kind: "prerequisite-not-met",
        summary: "The code changed after it was submitted, so the review didn't run.",
        detail: reason,
      });
      return;
    }
    const facts = await readReviewDiffFacts(this.#deps.run, {
      task,
      head: reviewHead,
      repo: worktree.path,
      baseHead: worktree.baseHead,
    });
    const classified = await classifyReviewRound(this.#deps, { task, head: reviewHead, facts });
    const leveledTask = await this.recordReviewLevel(task, classified.record);
    // The user's approved "no review" wins over the risk classification recorded just above.
    if (task.requestId !== undefined && (await this.#deps.briefSkipsReview(task.requestId))) {
      await this.#deps.transition(task.id, { type: "skip-review", head: reviewHead });
      return;
    }
    const nextLens = requiredReviewLenses(leveledTask, reviewHead).find(
      (lens) =>
        !leveledTask.reviews.some(
          (review) =>
            review.lens === lens &&
            review.head === reviewHead &&
            review.generation === leveledTask.generation,
        ),
    );
    if (nextLens === undefined) {
      await this.#deps.transition(task.id, {
        type: "finish-review",
        head: reviewHead,
        generation: task.generation,
      });
      return;
    }
    const reservation = reserved ?? (await this.reserveTask(task.id, "reviewer"));
    if ("refusal" in reservation) return;
    const reservedRuntime = reservation.runtime;
    const claim = claimOf(reservedRuntime.operation);
    if (claim === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      return;
    }
    if (
      currentWriter(reservedRuntime) === undefined &&
      reservedRuntime.reviewMode !== "review_existing_head"
    ) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = "review has no writer endpoint";
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The worker's terminal is gone, so the review can't run.",
        detail: reason,
      });
      return;
    }
    let endpoint: Endpoint | undefined;
    try {
      endpoint = await this.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["reviewing"],
        (current) => this.ensureReviewEndpoint(task, current.runtime, claim, nextLens),
      );
      if (endpoint === undefined) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
        return;
      }
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      const reason = `review pane allocation failed: ${describeError(error)}`;
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't open a terminal for the review.",
        detail: reason,
      });
      return;
    }
    const reviewEndpoint = endpoint;
    try {
      await this.launchReviewer({
        task,
        leveledTask,
        runtime: reservedRuntime,
        claim,
        endpoint: reviewEndpoint,
        head: reviewHead,
        cwd: worktree.path,
        lens: nextLens,
        facts,
        classified,
        changedDiff: currentCheckout.diff,
      });
    } catch (error) {
      const currentRuntime = await this.#deps.runtimeFor(task.id);
      if (
        currentRuntime?.endpoints.some((candidate) => candidate.paneId === reviewEndpoint.paneId)
      ) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id, claim);
      }
      const reason = `review job could not be prepared: ${describeError(error)}`;
      await this.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "Tandem couldn't set up the review.",
        detail: reason,
        paneId: reviewEndpoint.paneId,
      });
    }
  }

  /**
   * Whether every recorded reviewer pane is proven stopped, so a new review may start. A missing
   * pane is forgotten for the next tick; a pane whose ownership cannot be proven blocks the task.
   */
  private async reviewersStopped(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    cwd: string,
  ): Promise<boolean> {
    for (const reviewer of runtime.endpoints) {
      if (reviewer.role !== "reviewer" && reviewer.role !== "verifier") continue;
      try {
        const inspection = await inspectEndpoint(this.#deps.run, { endpoint: reviewer, cwd });
        const job = workerJobForEndpoint(runtime.jobs, reviewer);
        if (!(await workerDelegationStopped(inspection, job))) return false;
      } catch (error) {
        if (isMissingEndpoint(error)) {
          await this.#deps.removeEndpoint(task.id, reviewer.paneId);
          return false;
        }
        // Foreign ownership or a proof failure (stale heartbeat, PID no longer foreground): the pane
        // is never touched without proof either way, so this blocks instead of retrying forever.
        const reason = `review pane ${reviewer.paneId} ownership could not be proven: ${describeError(error)}`;
        await this.#deps.blockTask(task.id, reason, {
          group: "safety-stop",
          kind: "ownership-unprovable",
          summary:
            "Tandem couldn't confirm the reviewer's terminal belongs to this task, so it didn't touch it.",
          detail: reason,
          paneId: reviewer.paneId,
        });
        return false;
      }
    }
    return true;
  }

  /**
   * Returns this generation's reviewer pane, or opens one: beside the writer's pane when it still
   * exists, or as a fresh task pane when reviewing an existing HEAD with no writer.
   */
  private async ensureReviewEndpoint(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    claim: OperationClaim,
    lens: ReviewLens,
  ): Promise<Endpoint> {
    const role: WorkerRole = "reviewer";
    const existingEndpoint = runtime.endpoints.find(
      (entry) => entry.role === role && entry.generation === task.generation,
    );
    if (existingEndpoint !== undefined) return existingEndpoint;
    const reviewExisting = runtime.reviewMode === "review_existing_head";
    const writer = reviewExisting ? undefined : currentWriter(runtime);
    const reviewCwd = runtime.worktree?.path ?? task.worktree?.path;
    if (reviewCwd === undefined) throw new Error("review has no worktree");
    if (writer === undefined && !reviewExisting) throw new Error("review has no writer endpoint");
    const effectId = `endpoint:${claim.id}`;
    const identity = `review:${task.id}:${task.generation}`;
    const writerJob = writer === undefined ? undefined : workerJobForEndpoint(runtime.jobs, writer);
    await this.recordOperationEffect(task.id, claim, effectId, "endpoint", "intent", identity);
    let createdEndpoint: Endpoint;
    if (writer === undefined) {
      const taskName = `${runtime.taskName}-${lens}`;
      const created = await createTaskEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: reviewCwd,
        taskName,
        workspaceLabel: taskWorkspaceLabel(taskName, task.objective, role),
        role,
        generation: task.generation,
        ...(this.#deps.parentWorkspaceId === undefined
          ? {}
          : { parentWorkspaceId: this.#deps.parentWorkspaceId }),
      });
      createdEndpoint = created.endpoint;
    } else {
      const created = await createReviewerEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: reviewCwd,
        writer,
        ...(writerJob === undefined ? {} : { writerJob }),
        generation: task.generation,
      });
      createdEndpoint = { ...created.endpoint, role };
    }
    await this.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "endpoint",
      "succeeded",
      identity,
      JSON.stringify(createdEndpoint),
    );
    await this.saveEndpoint(task.id, createdEndpoint, claim);
    return createdEndpoint;
  }

  /** Writes one review round's inputs and job spec under the claim, then launches the reviewer. */
  private async launchReviewer(
    input: Readonly<{
      readonly task: TaskRecord;
      /** The task after this round's review level was recorded; the brief reads its ledger. */
      readonly leveledTask: TaskRecord;
      readonly runtime: RuntimeTaskState;
      readonly claim: OperationClaim;
      readonly endpoint: Endpoint;
      readonly head: string;
      readonly cwd: string;
      readonly lens: ReviewLens;
      readonly facts: ReviewDiffFacts;
      readonly classified: ClassifiedReviewRound;
      readonly changedDiff: string;
    }>,
  ): Promise<void> {
    const { task, runtime, claim, facts, head, lens } = input;
    const role: WorkerRole = "reviewer";
    const operation = runtime.operation;
    const jobId = operation?.jobId ?? singleLine(this.#deps.idFactory(), "review job id");
    const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
    const jobFiles = jobPaths(directory);
    const paths = reviewRoundPaths(directory);
    const reviewMode: ReviewMode = runtime.reviewMode ?? "review_changed_diff";
    const existingHead = reviewMode === "review_existing_head";
    const brief = renderReviewBrief(
      buildReviewBrief({
        task: input.leveledTask,
        head,
        lens,
        observations: reviewBriefObservations(facts, {
          cumulativePatchPath: existingHead ? paths.cumulativePatchPath : paths.diffPath,
          incrementalPatchPath: paths.incrementalPatchPath,
        }),
        advisoryLeads: input.classified.leads,
      }),
    );
    const artifactsWritten = await this.withOperationEffect(
      task.id,
      claim,
      task.generation,
      ["reviewing"],
      async () => {
        await writeTextAtomically(paths.diffPath, existingHead ? "" : input.changedDiff);
        if (existingHead) {
          await writeTextAtomically(paths.cumulativePatchPath, facts.cumulative.patch);
        }
        if (facts.sinceLastReview !== undefined) {
          await writeTextAtomically(paths.incrementalPatchPath, facts.sinceLastReview.patch);
        }
        await writeTextAtomically(paths.briefPath, brief);
        await writeJsonAtomically(paths.evidencePath, task.validationEvidence);
        return true;
      },
    );
    if (artifactsWritten !== true) return;
    const instructionRevision = task.communication?.revision ?? 0;
    const communication = {
      inboxPath: taskInboxPath(this.#deps.home, task.id),
      receiptPath: workerReceiptPath(jobFiles.jobPath),
      initialRevision: instructionRevision,
    };
    const context = reviewerBriefContext({
      task,
      runtime,
      head,
      lens,
      level: input.classified.record.level,
      reviewMode,
      paths,
      hasIncrementalPatch: facts.sinceLastReview !== undefined,
    });
    const spec: WorkerJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      role,
      cwd: input.cwd,
      model: resolvedExecutionModel(operation?.routing, task.policy.config.models[role]),
      prompt: buildPrompt(
        task,
        role,
        reportPathFor(jobFiles.jobPath),
        context.artifacts,
        { head, generation: task.generation, pass: lens },
        context.instructions,
      ),
      resultPath: jobFiles.resultPath,
      ...(operation === undefined
        ? {}
        : { execution: executionIdentity(this.#deps.home, operation) }),
      communication,
      review: { head, lens, round: task.reviewRound + 1 },
      ...(this.#deps.workerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#deps.workerTimeoutMs }),
    };
    const specWritten = await this.withOperationEffect(
      task.id,
      claim,
      task.generation,
      ["reviewing"],
      async () => {
        await writeJsonAtomically(jobFiles.jobPath, spec);
        return true;
      },
    );
    if (specWritten !== true) return;
    const durableJob: DurableJob = makeDurableJob(
      task.id,
      task.generation,
      role,
      "worker",
      input.cwd,
      jobFiles.jobPath,
      jobFiles.resultPath,
      1,
      this.#deps.clock(),
      {
        ...(operation === undefined ? {} : { operationId: operation.id }),
        endpoint: input.endpoint,
        head,
        reviewLens: lens,
        receiptPath: communication.receiptPath,
        instructionRevision,
      },
    );
    await this.appendJob(task.id, durableJob, claim);
    await this.launchJob(
      task.id,
      durableJob.id,
      input.endpoint,
      input.cwd,
      workerCommand(this.#deps.workerPath, jobFiles.jobPath),
      claim,
    );
  }

  async launchAgent(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    endpoint: Endpoint,
    role: WorkerRole,
    options: Readonly<{
      /** Extra instructions prepended ahead of the usual context, e.g. central recovery's relaunch notice. */
      readonly extraInstructions?: readonly string[];
    }> = {},
  ): Promise<void> {
    const jobId = runtime.operation?.jobId ?? singleLine(this.#deps.idFactory(), "worker job id");
    const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
    const paths = jobPaths(directory);
    const context = workerBriefContext(task, runtime, role, options.extraInstructions ?? []);
    const sessionDirectory =
      role === "implementer" || role === "scout" ? runtime.sessionDirectory : undefined;
    const claim = claimOf(runtime.operation);
    if (claim === undefined) return;
    if (sessionDirectory !== undefined) {
      const prepared = await this.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["scouting", "implementing"],
        async () => {
          await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
          return true;
        },
      );
      if (prepared !== true) return;
    }
    const instructionRevision = task.communication?.revision ?? 0;
    const communication = {
      inboxPath: taskInboxPath(this.#deps.home, task.id),
      receiptPath: workerReceiptPath(paths.jobPath),
      initialRevision: instructionRevision,
    };
    const prReview = task.prReview;
    const prompt =
      prReview === undefined
        ? buildPrompt(
            task,
            role,
            reportPathFor(paths.jobPath),
            context.artifacts,
            undefined,
            context.instructions,
          )
        : await this.prReviewPrompt(task, prReview, context.instructions);
    const modelRole = modelRoleForTask(task, role);
    const spec: WorkerJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      role,
      cwd: runtime.worktree?.path ?? taskSourcePath(task, runtime),
      model: resolvedExecutionModel(
        runtime.operation?.routing,
        task.policy.config.models[modelRole],
      ),
      prompt,
      resultPath: paths.resultPath,
      ...(runtime.operation === undefined
        ? {}
        : { execution: executionIdentity(this.#deps.home, runtime.operation) }),
      communication,
      // One OMP conversation per task: a fix round continues where the implementer left off.
      ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
      ...(this.#deps.workerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#deps.workerTimeoutMs }),
      ...(role === "implementer" && task.policy.config.setupCommands.length > 0
        ? { setup: task.policy.config.setupCommands }
        : {}),
      ...(prReview === undefined
        ? {}
        : {
            prReview: {
              structuredReport: prReview.mode !== "question",
              diffPath: prReviewRunDiffPath(this.#deps.home, task.id, task.generation),
              inlineComments: prReview.lens.kind !== "intent",
            },
          }),
    };
    const specWritten = await this.withOperationEffect(
      task.id,
      claim,
      task.generation,
      ["scouting", "implementing"],
      async () => {
        await writeJsonAtomically(paths.jobPath, spec);
        parseWorkerJob(spec);
        return true;
      },
    );
    if (specWritten !== true) return;
    const durableJob: DurableJob = makeDurableJob(
      task.id,
      task.generation,
      role,
      "worker",
      spec.cwd,
      paths.jobPath,
      paths.resultPath,
      1,
      this.#deps.clock(),
      {
        ...(runtime.operation === undefined ? {} : { operationId: runtime.operation.id }),
        endpoint,
        receiptPath: communication.receiptPath,
        instructionRevision,
      },
    );
    try {
      await this.appendJob(task.id, durableJob, claim);
    } catch (error) {
      const currentRuntime = await this.#deps.runtimeFor(task.id);
      if (currentRuntime?.jobs.some(activeRuntimeJob)) return;
      throw error;
    }
    await this.launchJob(
      task.id,
      durableJob.id,
      endpoint,
      spec.cwd,
      workerCommand(this.#deps.workerPath, paths.jobPath),
      claim,
    );
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

  private async prReviewPrompt(
    task: TaskRecord,
    state: NonNullable<TaskRecord["prReview"]>,
    messages: readonly string[],
  ): Promise<string> {
    const files = await readRunFiles(this.#deps.home, task.id, task.generation);
    return buildPrReviewBrief({
      state,
      head: files.head,
      from: files.from,
      contextPath: files.contextPath,
      diffPath: files.numberedDiffPath,
      extra: messages,
    });
  }

  private async launchJob(
    taskId: string,
    jobId: string,
    endpoint: Endpoint,
    cwd: string,
    command: readonly string[],
    claim: OperationClaim,
  ): Promise<void> {
    return withStateLock(this.#deps.home, async () => {
      const launch = await this.recordLaunchIntent(taskId, jobId, claim);
      if (launch === undefined) return;
      try {
        await refreshJobSpecClaim(launch.job, claim);
      } catch (error) {
        await this.quarantineOperation(
          taskId,
          `prepared job spec could not be refreshed: ${describeError(error)}`,
          claim,
        );
        return;
      }
      let commandSent = false;
      try {
        const previousJob = workerJobForEndpoint(
          launch.runtime.jobs.filter((entry) => entry.id !== jobId),
          endpoint,
        );
        await prepareWorkerTerminal(this.#deps.run, {
          endpoint,
          cwd,
          ...(previousJob === undefined ? {} : { job: previousJob }),
        });
        commandSent = true;
        await sendCommand(this.#deps.run, { endpoint, cwd, command });
        await this.proveWorkerStartup(launch.job, endpoint, cwd);
      } catch (error) {
        if (!commandSent && error instanceof EndpointBusyError) {
          await this.deferBusyLaunch(taskId, jobId, claim, launch.runtime.operation?.phase, error);
          return;
        }
        const reason = `worker launch could not be proven after launch intent: ${describeError(error)}`;
        await this.quarantineUnprovenLaunch(taskId, jobId, claim, reason);
        return;
      }
      await this.recordLaunchRunning(taskId, jobId, claim, endpoint);
    });
  }

  /**
   * Marks the reserved job launching and records the worker effect's intent, before anything is
   * typed into a pane. A job whose operation no longer matches this claim, policy, or input HEAD
   * is left alone; one whose task stopped or rests is cancelled instead of launched.
   */
  private async recordLaunchIntent(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
  ): Promise<
    Readonly<{ readonly runtime: RuntimeTaskState; readonly job: DurableJob }> | undefined
  > {
    return this.#deps.store.exclusive(async (store) => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      const job = runtime.jobs.find((entry) => entry.id === jobId);
      if (job === undefined) throw new Error(`runtime job ${jobId} is missing`);
      if (job.phase !== "reserved" || job.launchAttempted) return undefined;
      const operation = runtime.operation;
      if (
        operation?.jobId !== jobId ||
        operation.claimOwner !== this.#claimOwner ||
        !holdsClaim(operation, claim) ||
        operation.policyDigest !== policyIdentity(task.policy) ||
        operationSettled(operation) ||
        operation.inputHead !==
          (operation.kind === "fix"
            ? operation.fixContext?.head
            : (task.reviewHead ?? runtime.sourceCheckpoint.head))
      ) {
        return undefined;
      }
      if (taskAtRest(task) || runtime.stopRequest !== undefined) {
        const cancelled = replaceRuntimeTask(state, taskId, (current) => {
          const failed = replaceJob(current, jobId, (entry) => ({
            ...entry,
            phase: "failed",
            error: "worker launch was refused by a durable stop request",
          }));
          return {
            ...failed,
            ...(failed.operation === undefined
              ? {}
              : { operation: { ...failed.operation, phase: "cancelled" as const } }),
            ...(failed.reservation === undefined
              ? {}
              : {
                  reservation: {
                    ...failed.reservation,
                    phase: "released" as const,
                    releasedAt: this.#deps.clock(),
                  },
                }),
          };
        });
        await writeRuntimeState(this.#deps.runtimePath, cancelled);
        return undefined;
      }
      const launching = replaceRuntimeTask(state, taskId, (current) => ({
        ...replaceJob(current, jobId, (entry) => ({
          ...entry,
          phase: "launching",
          launchAttempted: true,
        })),
        ...(current.operation === undefined
          ? {}
          : {
              operation: {
                ...current.operation,
                phase: "launching" as const,
                effects: [
                  ...current.operation.effects,
                  {
                    id: jobId,
                    kind: "worker" as const,
                    phase: "intent" as const,
                    createdAt: this.#deps.clock(),
                    identity: job.jobPath,
                  },
                ],
              },
            }),
      }));
      await writeRuntimeState(this.#deps.runtimePath, launching);
      return { runtime, job };
    });
  }

  /** Quarantines a launch whose command may have been typed but whose worker was never proven. */
  private async quarantineUnprovenLaunch(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
    reason: string,
  ): Promise<void> {
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const current = taskRuntime(state, taskId);
      const operation = current?.operation;
      const currentJob = current?.jobs.find((entry) => entry.id === jobId);
      if (
        current === undefined ||
        currentJob === undefined ||
        !holdsClaim(operation, claim) ||
        operation.jobId !== jobId ||
        currentJob.operationId !== operation.id ||
        current.stopRequest !== undefined
      ) {
        return;
      }
      const quarantined = replaceRuntimeTask(state, taskId, (entry) => ({
        ...entry,
        lastError: reason,
        operation: {
          ...operation,
          phase: "quarantined" as const,
          error: reason,
          effects: operation.effects.map((effect) =>
            effect.id === jobId ? { ...effect, phase: "unknown" as const } : effect,
          ),
        },
      }));
      await writeRuntimeState(this.#deps.runtimePath, quarantined);
      await this.#deps.blockTask(taskId, reason, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "Tandem couldn't confirm the worker started.",
        detail: reason,
        jobId,
      });
    });
  }

  /** Records a proven launch: the job runs and the worker effect names the pane it runs in. */
  private async recordLaunchRunning(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
    endpoint: Endpoint,
  ): Promise<void> {
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const current = taskRuntime(state, taskId);
      const operation = current?.operation;
      const currentJob = current?.jobs.find((entry) => entry.id === jobId);
      if (
        current === undefined ||
        currentJob === undefined ||
        !holdsClaim(operation, claim) ||
        operation.jobId !== jobId ||
        currentJob.operationId !== operation.id ||
        currentJob.phase !== "launching" ||
        current.stopRequest !== undefined ||
        operationSettled(operation)
      ) {
        return;
      }
      const running = replaceRuntimeTask(state, taskId, (entry) => ({
        ...replaceJob(entry, jobId, (candidate) => ({
          ...candidate,
          phase: "running",
          launchedAt: this.#deps.clock(),
        })),
        operation: {
          ...operation,
          phase: "running" as const,
          effects: operation.effects.map((effect) =>
            effect.id === jobId
              ? { ...effect, phase: "succeeded" as const, receipt: endpoint.paneId }
              : effect,
          ),
        },
      }));
      await writeRuntimeState(this.#deps.runtimePath, running);
    });
  }

  // The busy pane refused before any command was typed, so the launch provably never
  // happened: undo the intent and let the next reconcile pass relaunch the reserved job.
  private async deferBusyLaunch(
    taskId: string,
    jobId: string,
    claim: OperationClaim,
    priorPhase: DurableOperationPhase | undefined,
    error: EndpointBusyError,
  ): Promise<void> {
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const current = taskRuntime(state, taskId);
      const operation = current?.operation;
      const currentJob = current?.jobs.find((entry) => entry.id === jobId);
      if (
        current === undefined ||
        priorPhase === undefined ||
        currentJob?.phase !== "launching" ||
        !holdsClaim(operation, claim) ||
        operation.jobId !== jobId ||
        operation.phase !== "launching"
      ) {
        return;
      }
      const deferred = replaceRuntimeTask(state, taskId, (entry) => ({
        ...replaceJob(entry, jobId, (candidate) => ({
          ...candidate,
          phase: "reserved",
          launchAttempted: false,
        })),
        lastError: `worker launch deferred: ${error.message}`,
        operation: {
          ...operation,
          phase: priorPhase,
          effects: operation.effects.filter((effect) => effect.id !== jobId),
        },
      }));
      await writeRuntimeState(this.#deps.runtimePath, deferred);
    });
  }

  private async proveWorkerStartup(
    job: DurableJob,
    endpoint: Endpoint,
    cwd: string,
  ): Promise<void> {
    const deadline = Date.now() + DEFAULT_STARTUP_GRACE_MS;
    while (true) {
      const inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
      if (inspection.activeWorker || (await this.#deps.resultExists(job.resultPath))) return;
      if (Date.now() >= deadline) {
        throw new Error(`worker did not become active within ${DEFAULT_STARTUP_GRACE_MS}ms`);
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 50);
      });
    }
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
          this.#claimOwner,
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
                claimOwner: this.#claimOwner,
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

  private async appendJob(taskId: string, job: DurableJob, claim: OperationClaim): Promise<void> {
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

  private async updateJob(
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

  private async saveEndpointLaunch(
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
  private async saveWorktree(
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

  /**
   * The worktree an implementation can take over from the scout of its first research handoff:
   * the scout has settled, holds no pane or reservation, and its checkout is still clean on its
   * own branch at its source commit. Anything else falls back to leasing a fresh worktree. A
   * finished scout kept alive for mockups has its pane closed first, since building has started.
   */
  private async adoptableScoutWorktree(
    task: TaskRecord,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | undefined> {
    const scoutId =
      task.kind === "implementation" ? task.researchHandoffs?.[0]?.scoutTaskId : undefined;
    if (scoutId === undefined) return undefined;
    try {
      await closeFinishedScoutPanes(this.#deps, scoutId);
    } catch {
      // A pane that would not close keeps the scout's worktree; the implementation leases another.
    }
    const [scout, runtime] = await Promise.all([
      this.#deps.getTask(scoutId),
      this.#deps.runtimeFor(scoutId),
    ]);
    const lease = runtime?.worktree;
    if (
      scout.target?.repo !== task.target?.repo ||
      scout.stage !== "completed" ||
      lease === undefined ||
      lease.leaseHolder !== `${this.#deps.sessionId}:${scoutId}` ||
      runtime === undefined ||
      runtime.endpoints.length > 0 ||
      runtime.endpointLaunch !== undefined ||
      unreleasedReservation(runtime.reservation)
    ) {
      return undefined;
    }
    const checkout = await observeScoutCheckout(this.#deps.run, lease.path);
    if (checkout.status !== "observed") return undefined;
    return decideScoutWorktreeRelease({ lease, checkout }).kind === "release" ? lease : undefined;
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
