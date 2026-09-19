import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type GitCheckpoint, readCheckpoint } from "../adapters/git.ts";
import {
  closeEndpoint,
  createReviewerEndpoint,
  createTaskEndpoint,
  type HerdrEndpointResult,
  type HerdrPaneInspection,
  inspectEndpoint,
  sendCommand,
  taskWorkspaceLabel,
} from "../adapters/herdr.ts";
import { EndpointOwnershipError, LeaseSafetyError } from "../adapters/primitives.ts";
import { acquireWorktree } from "../adapters/treehouse.ts";
import type {
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  TaskQuestion,
  TaskRecord,
} from "../contracts.ts";
import {
  activeReservations,
  activeRuntimeJob,
  taskRuntime,
  unreleasedReservation,
} from "../runtime/activity.ts";
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
  DurableJob,
  DurableJobConsumption,
  DurableReservation,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import {
  type JevShadowInput,
  type JevShadowResult,
  jevRecommendationNotification,
} from "../service/jev.ts";
import {
  appendTaskJob,
  buildPrompt,
  currentWriter,
  DEFAULT_STARTUP_GRACE_MS,
  describeError,
  endpointLaunchFor,
  inputEventKey,
  instructionOptions,
  isMissing,
  isMissingEndpoint,
  isOlderThan,
  jobDirectoryFor,
  jobPaths,
  makeDurableJob,
  nowMilliseconds,
  recognizesAppliedEvent,
  replaceJob,
  replaceRuntimeTask,
  reportPathFor,
  reviewFindings,
  runtimeReservation,
  singleLine,
  taskFingerprint,
  taskWithQuestion,
  taskWithQuestionCommit,
  workerCommand,
  workerRoleForTask,
} from "../service/records.ts";
import { taskSourcePath } from "../service/source.ts";
import {
  readWorkerReceipt,
  taskInboxPath,
  workerReceiptPath,
} from "../tasks/communication-persistence.ts";
import {
  activeTaskMessages,
  formatTaskMessages,
  MAX_TASK_MESSAGE_CHARS,
} from "../tasks/communication-protocol.ts";
import { type TaskEvent, type TaskTransitionContext, transitionTask } from "../tasks/lifecycle.ts";
import type { TaskStore } from "../tasks/store.ts";
import {
  readValidationResult,
  type ValidationJob,
  type ValidationResult,
} from "../validation-worker.ts";
import {
  parseWorkerJob,
  readWorkerResult,
  type WorkerJob,
  type WorkerResult,
  type WorkerRole,
} from "./jobs.ts";
import { liveWorkerTerminal, workerDelegationStopped } from "./terminal.ts";
import { prepareWorkerTerminal, workerJobForEndpoint } from "./terminal-control.ts";

const DEFAULT_STALL_WARNING_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_GRACE_MS = 60 * 1000;
const REQUIRED_REVIEW_LENSES: readonly ["behavior", "design", "coverage", "verification"] = [
  "behavior",
  "design",
  "coverage",
  "verification",
];
export type ReservationResult = Readonly<{
  readonly task: TaskRecord;
  readonly runtime: RuntimeTaskState;
  readonly reservation: DurableReservation;
}>;

export type CurrentCheckout = Readonly<{
  readonly checkpoint: GitCheckpoint;
  readonly expectedHead: string;
}>;

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
  readonly blockTask: (taskId: string, reason: string) => Promise<TaskRecord>;
  readonly publishTaskInbox: (task: TaskRecord) => Promise<void>;
  readonly removeEndpoint: (taskId: string, paneId: string) => Promise<void>;
  readonly setRuntimeError: (taskId: string, error: string) => Promise<void>;
  readonly maintainPoolForAllocation: (task: TaskRecord) => Promise<boolean>;
  readonly evaluateShadow?: (input: JevShadowInput) => Promise<JevShadowResult>;
}>;

export class WorkerWorkflow {
  readonly #deps: WorkerWorkflowDependencies;

  constructor(deps: WorkerWorkflowDependencies) {
    this.#deps = deps;
  }

  async reconcileJob(task: TaskRecord, runtime: RuntimeTaskState, job: DurableJob): Promise<void> {
    const endpoint = job.endpoint;
    if (endpoint === undefined) {
      if (isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
        await this.failJob(task, job, "worker job has no durable endpoint identity");
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
        await this.reconcileMissingEndpoint(task, job);
        return;
      }
      throw error;
    }
    if (inspection.activeWorker) {
      await this.observeWorkerProgress(task, job);
      const terminal = await liveWorkerTerminal(inspection, job);
      if (terminal === undefined || (!terminal.completed && terminal.phase !== "paused")) {
        if (job.phase !== "running")
          await this.updateJob(job.taskId, job.id, (current) => ({ ...current, phase: "running" }));
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
          await this.failJob(
            task,
            job,
            `worker stopped without a durable result: ${describeError(error)}`,
          );
          return;
        }
        await this.failJob(task, job, `worker result rejected: ${describeError(error)}`);
        return;
      }
      await this.consumeWorkerResult(task, runtime, job, result);
      return;
    }
    let result: ValidationResult;
    try {
      if (job.head === undefined) throw new Error("validation job is missing expected HEAD");
      result = await readValidationResult(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        head: job.head,
      });
    } catch (error) {
      if (isMissing(error)) {
        if (!isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) return;
        await this.failJob(
          task,
          job,
          `validation stopped without durable evidence: ${describeError(error)}`,
        );
        return;
      }
      await this.failJob(task, job, `validation result rejected: ${describeError(error)}`);
      return;
    }
    await this.consumeValidationResult(task, runtime, job, result);
  }

  private async reconcileMissingEndpoint(task: TaskRecord, job: DurableJob): Promise<void> {
    if (!isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) return;
    const resultExists = await this.#deps.resultExists(job.resultPath);
    if (resultExists) {
      await this.failJob(
        task,
        job,
        "owned endpoint disappeared; durable result cannot be trusted without stopped-pane proof",
      );
      return;
    }
    if (job.endpoint !== undefined) await this.#deps.removeEndpoint(task.id, job.endpoint.paneId);
    await this.failJob(task, job, "owned endpoint disappeared before a durable result was written");
  }

  private async observeWorkerProgress(task: TaskRecord, job: DurableJob): Promise<void> {
    if (job.receiptPath === undefined) return;
    const receipt = await readWorkerReceipt(job.receiptPath, {
      jobId: job.id,
      taskId: task.id,
      generation: job.generation,
    }).catch(() => undefined);
    const now = this.#deps.clock();
    const nowMs = nowMilliseconds(this.#deps.clock);
    const createdMs = Date.parse(job.createdAt);
    const heartbeatMs = receipt === undefined ? Number.NaN : Date.parse(receipt.heartbeatAt);
    const progressMs = receipt === undefined ? Number.NaN : Date.parse(receipt.progressAt);
    const startupElapsed =
      Number.isFinite(createdMs) && nowMs - createdMs >= DEFAULT_HEARTBEAT_GRACE_MS;
    const heartbeatStale =
      receipt === undefined
        ? startupElapsed
        : !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs >= DEFAULT_HEARTBEAT_GRACE_MS;
    const progressStale =
      receipt === undefined
        ? startupElapsed
        : !Number.isFinite(progressMs) || nowMs - progressMs >= DEFAULT_STALL_WARNING_MS;
    if (
      job.progressWarningAt !== undefined &&
      receipt !== undefined &&
      Date.parse(receipt.progressAt) > Date.parse(job.progressWarningAt)
    ) {
      await this.updateJob(job.taskId, job.id, (current) => {
        const { progressWarningAt: _progressWarningAt, ...withoutWarning } = current;
        return withoutWarning;
      });
      return;
    }
    if (!heartbeatStale && !progressStale) return;
    if (job.progressWarningAt !== undefined) return;
    await this.updateJob(job.taskId, job.id, (current) => ({
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
  ): Promise<void> {
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
    if (
      (job.role === "reviewer" || job.role === "verifier") &&
      (job.instructionRevision ?? 0) !== (task.communication?.revision ?? 0)
    ) {
      await this.failJob(
        task,
        job,
        "review result was launched for an older instruction revision",
        false,
      );
      return;
    }
    try {
      await this.assertInstructionCurrent(task, job, result.instructionRevision);
    } catch (error) {
      await this.failJob(task, job, `stale worker instruction: ${describeError(error)}`, false);
      return;
    }
    if (result.status === "failed" || result.status === "needs-decision") {
      const question =
        result.status === "needs-decision"
          ? {
              id: job.id,
              text: (
                (result.question?.text ?? result.text).trim() ||
                `Worker ${job.role} needs a decision`
              ).slice(0, MAX_TASK_MESSAGE_CHARS),
              ...(result.question?.recommendation === undefined
                ? {}
                : {
                    recommendation: result.question.recommendation.slice(0, MAX_TASK_MESSAGE_CHARS),
                  }),
            }
          : undefined;
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
      await this.consumeJob(
        task.id,
        job.id,
        { type: "block", reason },
        {
          ...(question === undefined ? {} : { question }),
          ...instructionOptions(result.instructionRevision),
          reportPath,
        },
      );
      return;
    }
    if (job.role === "scout") {
      let checkout: CurrentCheckout;
      try {
        checkout = await this.readWorkerCheckout(runtime, job);
      } catch (error) {
        await this.consumeJob(
          task.id,
          job.id,
          {
            type: "block",
            reason: `scout checkout could not be verified: ${describeError(error)}; worktree is preserved`,
          },
          instructionOptions(result.instructionRevision),
        );
        return;
      }
      if (
        checkout.checkpoint.dirty ||
        checkout.checkpoint.unmerged ||
        checkout.checkpoint.head !== runtime.worktree?.baseHead
      ) {
        await this.consumeJob(
          task.id,
          job.id,
          {
            type: "block",
            reason:
              "scout stopped with a changed, dirty, or unmerged checkout; worktree is preserved",
          },
          instructionOptions(result.instructionRevision),
        );
        return;
      }
      const reportPath = reportPathFor(job.jobPath);
      await writeTextAtomically(reportPath, result.text);
      await this.consumeJob(
        task.id,
        job.id,
        {
          type: "scout-report-complete",
          reportPath,
          generation: job.generation,
        },
        instructionOptions(result.instructionRevision),
      );
      return;
    }
    if (job.role === "implementer") {
      const checkout = await this.readWorkerCheckout(runtime, job);
      if (
        checkout.checkpoint.dirty ||
        checkout.checkpoint.unmerged ||
        checkout.checkpoint.head === runtime.worktree?.baseHead
      ) {
        await this.consumeJob(
          task.id,
          job.id,
          {
            type: "block",
            reason:
              "implementer stopped without a new clean committed checkpoint; worktree is preserved",
          },
          instructionOptions(result.instructionRevision),
        );
        return;
      }
      const reportPath = reportPathFor(job.jobPath);
      await writeTextAtomically(reportPath, result.text);
      await this.consumeJob(
        task.id,
        job.id,
        {
          type: "implementation-complete",
          head: checkout.checkpoint.head,
          generation: job.generation,
          reportPath,
        },
        instructionOptions(result.instructionRevision),
      );
      return;
    }
    const review = result.review;
    if (review === undefined || job.head === undefined || job.reviewLens === undefined) {
      await this.failJob(task, job, "review worker completed without complete review identity");
      return;
    }
    const checkout = await this.readWorkerCheckout(runtime, job);
    if (
      checkout.checkpoint.dirty ||
      checkout.checkpoint.unmerged ||
      checkout.checkpoint.head !== job.head ||
      review.head !== job.head ||
      review.generation !== job.generation ||
      review.lens !== job.reviewLens
    ) {
      await this.consumeJob(
        task.id,
        job.id,
        {
          type: "block",
          reason: `stale or dirty review evidence for ${job.reviewLens} at ${job.head}; review was not accepted`,
        },
        instructionOptions(result.instructionRevision),
      );
      return;
    }
    await this.consumeJob(
      task.id,
      job.id,
      { type: "record-review", review },
      instructionOptions(result.instructionRevision),
    );
  }

  private async consumeValidationResult(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    result: ValidationResult,
  ): Promise<void> {
    const canonicalRevision = task.communication?.revision ?? 0;
    if (canonicalRevision !== 0 && job.instructionRevision !== canonicalRevision) {
      await this.failJob(
        task,
        job,
        `stale validation instruction revision ${String(job.instructionRevision)}; canonical is ${canonicalRevision}`,
        false,
      );
      return;
    }
    const expectedHead = job.head;
    if (expectedHead === undefined) {
      await this.failJob(task, job, "validation job has no expected HEAD");
      return;
    }
    const checkout = await this.readWorkerCheckout(runtime, job);
    if (
      checkout.checkpoint.dirty ||
      checkout.checkpoint.unmerged ||
      checkout.checkpoint.head !== expectedHead
    ) {
      await this.consumeJob(
        task.id,
        job.id,
        {
          type: "validation-failed",
          head: expectedHead,
          generation: job.generation,
          evidence: [
            ...result.evidence,
            {
              name: "validation-head-check",
              argv: ["git", "rev-parse", "HEAD"],
              exitCode: 1,
              stdout: checkout.checkpoint.head,
              stderr: "worktree changed while validation was running",
              head: expectedHead,
            },
          ],
        },
        instructionOptions(job.instructionRevision),
      );
      await this.closeValidationAfterResult(task.id, job.endpoint);
      return;
    }
    const event: TaskEvent =
      result.status === "completed"
        ? {
            type: "validation-succeeded",
            head: expectedHead,
            generation: job.generation,
            evidence: result.evidence,
          }
        : {
            type: "validation-failed",
            head: expectedHead,
            generation: job.generation,
            evidence: result.evidence,
          };
    await this.consumeJob(task.id, job.id, event, {
      ...instructionOptions(job.instructionRevision),
    });
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
    block = true,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, task.id, (current) => {
        const failed = replaceJob(current, job.id, (entry) => ({
          ...entry,
          phase: "failed",
          error: reason,
        }));
        return failed.reservation === undefined || failed.jobs.some(activeRuntimeJob)
          ? failed
          : {
              ...failed,
              reservation: {
                ...failed.reservation,
                releasedAt: this.#deps.clock(),
              },
            };
      }),
    );
    if (block) await this.#deps.blockTask(task.id, reason);
  }

  private async consumeJob(
    taskId: string,
    jobId: string,
    event: TaskEvent,
    options: Readonly<{
      question?: TaskQuestion;
      instructionRevision?: number;
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
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      try {
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
        } else {
          await this.assertInstructionCurrent(task, job, options.instructionRevision);
        }
      } catch (error) {
        if (job.kind !== "worker") throw error;
        const staleReason = `stale worker instruction: ${describeError(error)}`;
        const retired = replaceRuntimeTask(state, taskId, (current) => {
          const failed = replaceJob(current, jobId, (entry) => ({
            ...entry,
            phase: "failed",
            error: staleReason,
          }));
          return failed.reservation === undefined || failed.jobs.some(activeRuntimeJob)
            ? failed
            : {
                ...failed,
                reservation: {
                  ...failed.reservation,
                  phase: "released",
                  releasedAt: this.#deps.clock(),
                },
              };
        });
        await writeRuntimeState(this.#deps.runtimePath, retired);
        return task;
      }
      if (job.phase === "consumed") return task;
      const applyReportPath = (candidate: TaskRecord): TaskRecord => {
        if (options.reportPath === undefined || candidate.reportPath === options.reportPath) {
          return candidate;
        }
        if (candidate.revision !== task.revision) {
          return { ...candidate, reportPath: options.reportPath };
        }
        return {
          ...candidate,
          revision: candidate.revision + 1,
          updatedAt: this.#deps.clock(),
          reportPath: options.reportPath,
        };
      };
      const inputKey = inputEventKey(job.id, event);
      const existing = job.consumption;
      let nextTask = task;
      let consumption: DurableJobConsumption;

      if (existing !== undefined) {
        if (existing.inputEventKey !== inputKey) {
          throw new Error(`durable result ${job.id} was prepared for a different lifecycle event`);
        }
        const currentFingerprint = taskFingerprint(task);
        if (
          task.revision === existing.afterRevision &&
          currentFingerprint === existing.taskFingerprint
        ) {
          consumption = existing;
        } else if (
          task.revision === existing.beforeRevision &&
          currentFingerprint === existing.beforeFingerprint
        ) {
          const context: TaskTransitionContext = {
            now: existing.now,
            notificationId: existing.notificationId,
          };
          let effectiveEvent = event;
          try {
            nextTask = transitionTask(task, event, context);
          } catch (error) {
            effectiveEvent = {
              type: "block",
              reason: `durable result could not be applied: ${describeError(error)}`,
            };
            nextTask = transitionTask(task, effectiveEvent, context);
          }
          nextTask = applyReportPath(
            options.question === undefined
              ? nextTask
              : taskWithQuestion(nextTask, options.question),
          );
          if (
            inputEventKey(job.id, effectiveEvent) !== existing.appliedEventKey ||
            nextTask.revision !== existing.afterRevision ||
            taskFingerprint(nextTask) !== existing.taskFingerprint
          ) {
            throw new Error(
              `durable result ${job.id} no longer matches its prepared lifecycle transition`,
            );
          }
          consumption = existing;
        } else if (
          task.stage === "paused" ||
          task.stage === "blocked" ||
          task.stage === "cancelled" ||
          task.stage === "completed" ||
          task.stage === "merged"
        ) {
          consumption = existing;
        } else {
          throw new Error(`durable result ${job.id} has an unexpected task revision or state`);
        }
      } else if (recognizesAppliedEvent(task, event)) {
        nextTask = applyReportPath(
          options.question === undefined
            ? task
            : taskWithQuestionCommit(task, options.question, this.#deps.clock()),
        );
        consumption = {
          schemaVersion: 1,
          inputEventKey: inputKey,
          appliedEventKey: inputKey,
          beforeRevision: task.revision,
          afterRevision: nextTask.revision,
          beforeFingerprint: taskFingerprint(task),
          taskFingerprint: taskFingerprint(nextTask),
          now: this.#deps.clock(),
          notificationId: singleLine(this.#deps.idFactory(), "notification id"),
        };
      } else {
        const context = this.#deps.context();
        let effectiveEvent = event;
        if (
          task.stage === "cancelled" ||
          task.stage === "completed" ||
          task.stage === "merged" ||
          task.stage === "paused" ||
          task.stage === "blocked"
        ) {
          nextTask = task;
        } else {
          try {
            nextTask = transitionTask(task, event, context);
          } catch (error) {
            effectiveEvent = {
              type: "block",
              reason: `durable result could not be applied: ${describeError(error)}`,
            };
            nextTask = transitionTask(task, effectiveEvent, context);
          }
        }
        if (options.question !== undefined) {
          nextTask =
            nextTask.revision === task.revision
              ? taskWithQuestionCommit(nextTask, options.question, context.now)
              : taskWithQuestion(nextTask, options.question);
        }
        nextTask = applyReportPath(nextTask);
        consumption = {
          schemaVersion: 1,
          inputEventKey: inputKey,
          appliedEventKey: inputEventKey(job.id, effectiveEvent),
          beforeRevision: task.revision,
          afterRevision: nextTask.revision,
          beforeFingerprint: taskFingerprint(task),
          taskFingerprint: taskFingerprint(nextTask),
          now: context.now,
          notificationId: context.notificationId,
        };
      }

      if (existing === undefined) {
        const pendingRuntime = replaceRuntimeTask(state, taskId, (current) =>
          replaceJob(current, jobId, (entry) => ({ ...entry, consumption })),
        );
        await writeRuntimeState(this.#deps.runtimePath, pendingRuntime);
      }
      if (nextTask !== task) {
        await store.update(task.id, task.revision, () => nextTask);
      }
      const nextRuntime = replaceRuntimeTask(state, taskId, (current) => {
        const consumed = replaceJob(current, jobId, (entry) => ({
          ...entry,
          ...(options.instructionRevision === undefined
            ? {}
            : { instructionRevision: options.instructionRevision }),
          phase: "consumed",
          consumedAt: this.#deps.clock(),
          consumption,
        }));
        if (consumed.reservation !== undefined && !consumed.jobs.some(activeRuntimeJob)) {
          return {
            ...consumed,
            reservation: {
              ...consumed.reservation,
              phase: "released",
              releasedAt: this.#deps.clock(),
            },
          };
        }
        return consumed;
      });
      await writeRuntimeState(this.#deps.runtimePath, nextRuntime);
      await this.#deps.publishTaskInbox(nextTask);
      return nextTask;
    });
  }

  private async setReservationPhase(
    taskId: string,
    phase: DurableReservation["phase"],
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        ...(current.reservation === undefined
          ? {}
          : { reservation: { ...current.reservation, phase } }),
      })),
    );
  }

  async startQueuedTask(task: TaskRecord, reserved?: ReservationResult): Promise<void> {
    const role = workerRoleForTask(task);
    const reservation = reserved ?? (await this.reserveTask(task.id, role));
    if (reservation === undefined) return;
    const runtime = reservation.runtime;
    if (runtime.worktree === undefined && !(await this.#deps.maintainPoolForAllocation(task))) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      return;
    }
    let lease = runtime.worktree;
    if (lease === undefined) {
      try {
        const source = await readCheckpoint(this.#deps.run, {
          repo: taskSourcePath(task, runtime),
        });
        this.assertSourceUnchanged(runtime.sourceCheckpoint, source);
        lease = await acquireWorktree(this.#deps.run, {
          repo: taskSourcePath(task, runtime),
          root: this.#deps.poolRoot,
          tandemId: `${this.#deps.sessionId}:${task.id}`,
          taskName: runtime.taskName,
        });
        if (lease.baseHead !== runtime.sourceCheckpoint.head) {
          throw new LeaseSafetyError(
            `acquired worktree base ${lease.baseHead} does not match pinned source ${runtime.sourceCheckpoint.head}`,
            lease,
          );
        }
        await this.saveWorktree(task.id, lease);
      } catch (error) {
        if (error instanceof LeaseSafetyError) await this.saveWorktree(task.id, error.lease);
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
        await this.#deps.blockTask(task.id, `worktree allocation failed: ${describeError(error)}`);
        return;
      }
    }
    if (lease === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(task.id, "worktree allocation returned no lease");
      return;
    }
    const endpoint = currentWriter({ ...runtime, worktree: lease });
    if (endpoint === undefined) {
      const workspaceLabel = taskWorkspaceLabel(runtime.taskName, task.objective, role);
      const endpointLaunch = endpointLaunchFor(
        reservation.reservation,
        this.#deps.sessionId,
        runtime.taskName,
        workspaceLabel,
        lease.path,
        role,
        task.generation,
        this.#deps.clock(),
        this.#deps.parentWorkspaceId,
      );
      try {
        await this.setReservationPhase(task.id, "endpoint");
        const claimed = await this.saveEndpointLaunch(task.id, endpointLaunch);
        if (!claimed) return;
      } catch (error) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
        await this.#deps.blockTask(
          task.id,
          `worker launch intent could not be persisted: ${describeError(error)}`,
        );
        return;
      }
      let created: HerdrEndpointResult;
      try {
        created = await this.#deps.store.exclusive(() =>
          createTaskEndpoint(this.#deps.run, {
            sessionId: this.#deps.sessionId,
            cwd: lease.path,
            taskName: runtime.taskName,
            workspaceLabel: endpointLaunch.workspaceLabel,
            role,
            generation: task.generation,
            ...(this.#deps.parentWorkspaceId === undefined
              ? {}
              : { parentWorkspaceId: this.#deps.parentWorkspaceId }),
          }),
        );
      } catch (error) {
        await this.#deps.blockTask(
          task.id,
          `worker pane allocation failed: ${describeError(error)}`,
        );
        return;
      }
      try {
        await this.saveEndpoint(task.id, created.endpoint);
      } catch (error) {
        await this.#deps.blockTask(
          task.id,
          `worker pane identity could not be persisted: ${describeError(error)}`,
        );
        return;
      }
      try {
        const current = await this.#deps.getTask(task.id);
        if (current.stage === "queued") {
          await this.#deps.transition(task.id, {
            type: "start",
            worktree: lease,
            endpoints: [created.endpoint],
          });
        }
      } catch (error) {
        const current = await this.#deps.getTask(task.id);
        if (current.stage === "queued") {
          await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
          await this.#deps.blockTask(
            task.id,
            `task start transition failed after pane allocation: ${describeError(error)}`,
          );
          return;
        }
      }
    } else if ((await this.#deps.getTask(task.id)).stage === "queued") {
      try {
        await this.#deps.transition(task.id, {
          type: "start",
          worktree: lease,
          endpoints: [endpoint],
        });
      } catch (error) {
        const current = await this.#deps.getTask(task.id);
        if (current.stage === "queued") {
          await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
          await this.#deps.blockTask(
            task.id,
            `task start transition failed with recovered pane: ${describeError(error)}`,
          );
          return;
        }
      }
    }
    const currentTask = await this.#deps.getTask(task.id);
    const expectedStage = role === "scout" ? "scouting" : "implementing";
    if (currentTask.stage !== expectedStage) {
      if (["paused", "blocked", "cancelled", "completed", "merged"].includes(currentTask.stage)) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      }
      return;
    }
    const currentRuntime = await this.#deps.runtimeFor(task.id);
    if (currentRuntime === undefined || currentRuntime.worktree === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        "runtime lost its acquired worktree before worker launch",
      );
      return;
    }
    const writer = currentWriter(currentRuntime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(task.id, "runtime lost its worker endpoint before launch");
      return;
    }
    await this.launchAgent(currentTask, currentRuntime, writer, role);
  }

  async beginFixes(task: TaskRecord): Promise<void> {
    if (task.reviewHead === undefined) {
      await this.#deps.blockTask(task.id, "fix stage has no reviewed HEAD");
      return;
    }
    const reservation = await this.reserveTask(task.id, "implementer");
    if (reservation === undefined) return;
    const contextPath = join(
      taskJobsDirectory(this.#deps.home, task.id),
      `fix-context-${task.generation + 1}.json`,
    );
    try {
      await writeJsonAtomically(contextPath, {
        taskId: task.id,
        head: task.reviewHead,
        generation: task.generation,
        validationEvidence: task.validationEvidence,
        findings: reviewFindings(task),
      });
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        `fix context could not be persisted: ${describeError(error)}`,
      );
      return;
    }
    try {
      await this.#deps.updateTask(task.id, (current) => {
        if (current.reviewHead === undefined) throw new Error("fix stage has no reviewed HEAD");
        const next = transitionTask(
          current,
          { type: "begin-fixes", head: current.reviewHead, generation: current.generation },
          this.#deps.context(),
        );
        return {
          ...next,
          endpoints: (next.endpoints ?? []).map((endpoint) => ({
            ...endpoint,
            generation: next.generation,
          })),
        };
      });
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(task.id, `fix round could not begin: ${describeError(error)}`);
      return;
    }
    try {
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
        replaceRuntimeTask(state, task.id, (current) => ({
          ...current,
          fixContextPath: contextPath,
          endpoints: current.endpoints.map((endpoint) => ({
            ...endpoint,
            generation: task.generation + 1,
          })),
        })),
      );
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        `fix runtime metadata could not be persisted: ${describeError(error)}`,
      );
      return;
    }
    const nextTask = await this.#deps.getTask(task.id);
    const nextRuntime = await this.#deps.runtimeFor(task.id);
    if (nextRuntime === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        "fix round lost its durable runtime metadata before launch",
      );
      return;
    }
    const writer = currentWriter(nextRuntime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(task.id, "fix round has no owned implementer pane");
      return;
    }
    await this.launchAgent(nextTask, nextRuntime, writer, "implementer");
  }

  async startValidation(task: TaskRecord): Promise<void> {
    if (task.reviewHead === undefined || task.worktree === undefined) {
      await this.#deps.blockTask(task.id, "validation requires a task worktree and reviewed HEAD");
      return;
    }
    const reservation = await this.reserveTask(task.id, "validation");
    if (reservation === undefined) return;
    const runtime = reservation.runtime;
    if (runtime.worktree === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(task.id, "validation runtime lost its worktree");
      return;
    }
    let checkout: CurrentCheckout;
    try {
      checkout = await this.readWorkerCheckout(runtime, {
        cwd: runtime.worktree.path,
        head: task.reviewHead,
      });
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        `validation checkout could not be verified: ${describeError(error)}`,
      );
      return;
    }
    if (
      checkout.checkpoint.head !== task.reviewHead ||
      checkout.checkpoint.dirty ||
      checkout.checkpoint.unmerged
    ) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        "validation refused because the task worktree is stale or dirty",
      );
      return;
    }
    const writer = currentWriter(runtime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(task.id, "validation has no owned implementer pane");
      return;
    }
    const writerJob = workerJobForEndpoint(runtime.jobs, writer);
    let validationEndpointResult: HerdrEndpointResult;
    try {
      validationEndpointResult = await createReviewerEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: runtime.worktree.path,
        writer,
        generation: task.generation,
        ...(writerJob === undefined ? {} : { writerJob }),
      });
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        `validation pane allocation failed: ${describeError(error)}`,
      );
      return;
    }
    const validationEndpoint = validationEndpointResult.endpoint;
    try {
      await this.saveEndpoint(task.id, validationEndpoint);
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        `validation pane identity could not be persisted: ${describeError(error)}`,
      );
      return;
    }
    let durableJob: DurableJob;
    try {
      const jobId = singleLine(this.#deps.idFactory(), "validation job id");
      const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
      const paths = jobPaths(directory);
      const spec: ValidationJob = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        repoPath: runtime.worktree.path,
        head: task.reviewHead,
        surfaces: task.surfaces,
        commands: task.policy.config.validationCommands,
        resultPath: paths.resultPath,
      };
      await writeJsonAtomically(paths.jobPath, spec);
      durableJob = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        role: "validation",
        kind: "validation",
        cwd: runtime.worktree.path,
        jobPath: paths.jobPath,
        resultPath: paths.resultPath,
        attempt: 1,
        phase: "reserved",
        launchAttempted: false,
        createdAt: this.#deps.clock(),
        endpoint: validationEndpoint,
        head: task.reviewHead,
        ...(task.communication === undefined
          ? {}
          : { instructionRevision: task.communication.revision }),
      };
      await this.appendJob(task.id, durableJob);
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(
        task.id,
        `validation job could not be persisted: ${describeError(error)}`,
      );
      return;
    }
    await this.launchJob(
      task.id,
      durableJob.id,
      validationEndpoint,
      runtime.worktree.path,
      workerCommand(this.#deps.validationWorkerPath, durableJob.jobPath),
    );
  }

  async advanceReview(task: TaskRecord): Promise<void> {
    if (task.reviewHead === undefined || task.worktree === undefined) {
      await this.#deps.blockTask(task.id, "review requires a task worktree and reviewed HEAD");
      return;
    }
    const runtime = await this.#deps.runtimeFor(task.id);
    if (runtime === undefined) {
      await this.#deps.blockTask(task.id, "review has no durable runtime metadata");
      return;
    }
    for (const reviewer of runtime.endpoints) {
      if (reviewer.role !== "reviewer" && reviewer.role !== "verifier") continue;
      try {
        const inspection = await inspectEndpoint(this.#deps.run, {
          endpoint: reviewer,
          cwd: task.worktree.path,
        });
        if (
          !(await workerDelegationStopped(inspection, workerJobForEndpoint(runtime.jobs, reviewer)))
        )
          return;
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
        await this.#deps.removeEndpoint(task.id, reviewer.paneId);
        return;
      }
    }
    const currentCheckout = await readCheckpoint(this.#deps.run, {
      repo: task.worktree.path,
      baseRef: task.worktree.baseHead,
    });
    if (
      currentCheckout.head !== task.reviewHead ||
      currentCheckout.dirty ||
      currentCheckout.unmerged
    ) {
      await this.#deps.blockTask(task.id, "review refused because the worktree is stale or dirty");
      return;
    }
    const nextLens = REQUIRED_REVIEW_LENSES.find(
      (lens) =>
        !task.reviews.some(
          (review) =>
            review.lens === lens &&
            review.head === task.reviewHead &&
            review.generation === task.generation,
        ),
    );
    if (nextLens === undefined) {
      await this.#deps.transition(task.id, {
        type: "finish-review",
        head: task.reviewHead,
        generation: task.generation,
      });
      return;
    }
    const role: WorkerRole = nextLens === "verification" ? "verifier" : "reviewer";
    const reservation = await this.reserveTask(task.id, role);
    if (reservation === undefined) return;
    const reservedRuntime = reservation.runtime;
    const writer = currentWriter(reservedRuntime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.#deps.blockTask(task.id, "review has no writer endpoint");
      return;
    }
    const writerJob = workerJobForEndpoint(reservedRuntime.jobs, writer);
    let endpointResult: HerdrEndpointResult;
    try {
      endpointResult = await createReviewerEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: task.worktree.path,
        writer,
        ...(writerJob === undefined ? {} : { writerJob }),
        generation: task.generation,
      });
    } catch (error) {
      await this.#deps.blockTask(task.id, `review pane allocation failed: ${describeError(error)}`);
      return;
    }
    const endpoint: Endpoint = { ...endpointResult.endpoint, role };
    try {
      await this.saveEndpoint(task.id, endpoint);
      const jobId = singleLine(this.#deps.idFactory(), "review job id");
      const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
      const paths = jobPaths(directory);
      const diffPath = join(directory, "diff.patch");
      const evidencePath = join(directory, "validation-evidence.json");
      await writeTextAtomically(diffPath, currentCheckout.diff);
      await writeJsonAtomically(evidencePath, task.validationEvidence);
      const reportPath = reportPathFor(paths.jobPath);
      const instructionRevision = task.communication?.revision ?? 0;
      const communication = {
        inboxPath: taskInboxPath(this.#deps.home, task.id),
        receiptPath: workerReceiptPath(paths.jobPath),
        initialRevision: instructionRevision,
      };
      const prompt = buildPrompt(
        task,
        role,
        reportPath,
        [diffPath, evidencePath, ...(task.reportPath === undefined ? [] : [task.reportPath])],
        { head: task.reviewHead, generation: task.generation, pass: nextLens },
        [
          `Review only the selected ${nextLens} lens. The immutable diff is at ${diffPath}.`,
          `Validation evidence is at ${evidencePath}; treat it as runner-produced evidence only.`,
          ...(instructionRevision === 0
            ? []
            : [
                formatTaskMessages(
                  task.id,
                  instructionRevision,
                  activeTaskMessages(task.communication),
                ),
              ]),
        ],
      );
      const spec: WorkerJob = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        role,
        cwd: task.worktree.path,
        model: task.policy.config.models[role],
        prompt,
        resultPath: paths.resultPath,
        communication,
        review: { head: task.reviewHead, lens: nextLens },
        ...(this.#deps.workerTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.#deps.workerTimeoutMs }),
      };
      await writeJsonAtomically(paths.jobPath, spec);
      const durableJob: DurableJob = makeDurableJob(
        task.id,
        task.generation,
        role,
        "worker",
        task.worktree.path,
        paths.jobPath,
        paths.resultPath,
        1,
        this.#deps.clock(),
        {
          endpoint,
          head: task.reviewHead,
          reviewLens: nextLens,
          receiptPath: communication.receiptPath,
          instructionRevision,
        },
      );
      await this.appendJob(task.id, durableJob);
      await this.recordShadowRecommendation(task, durableJob);
      await this.launchJob(
        task.id,
        durableJob.id,
        endpoint,
        task.worktree.path,
        workerCommand(this.#deps.workerPath, paths.jobPath),
      );
    } catch (error) {
      const currentRuntime = await this.#deps.runtimeFor(task.id);
      if (currentRuntime?.endpoints.some((candidate) => candidate.paneId === endpoint.paneId)) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      }
      await this.#deps.blockTask(
        task.id,
        `review job could not be prepared: ${describeError(error)}`,
      );
    }
  }
  async recordShadowRecommendation(task: TaskRecord, job: DurableJob): Promise<void> {
    const evaluator = this.#deps.evaluateShadow;
    if (evaluator === undefined) return;
    let result: JevShadowResult;
    try {
      result = await evaluator({
        task,
        job,
      });
    } catch {
      result = {
        status: "unavailable",
        message: "Jev shadow evaluator failed; normal dispatch continues",
      };
    }
    if (result.status === "skipped" && result.artifactPath === undefined) return;
    const message = jevRecommendationNotification(result);
    try {
      await this.#deps.updateTask(task.id, (current) => {
        if (current.notifications.some((entry) => entry.message === message)) return current;
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.#deps.clock(),
          notifications: [
            ...current.notifications,
            {
              id: singleLine(this.#deps.idFactory(), "Jev shadow notification id"),
              message,
              acknowledged: false,
              kind: "routine",
            },
          ],
        };
      });
    } catch {
      // Shadow metadata must never block or alter the normal worker launch.
    }
  }

  async launchAgent(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    endpoint: Endpoint,
    role: WorkerRole,
  ): Promise<void> {
    const jobId = singleLine(this.#deps.idFactory(), "worker job id");
    const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
    const paths = jobPaths(directory);
    const reportPath = reportPathFor(paths.jobPath);
    const priorReportPath = task.reportPath;
    const fixArtifacts = [
      ...(runtime.fixContextPath === undefined ? [] : [runtime.fixContextPath]),
      ...(priorReportPath === undefined ? [] : [priorReportPath]),
    ];
    const extra = [
      ...(priorReportPath === undefined
        ? []
        : [
            `A prior worker question/report is recorded at ${priorReportPath}. Read it before continuing and preserve its evidence context.`,
          ]),
      ...(role === "implementer" && runtime.fixContextPath !== undefined
        ? [
            `This is a bounded fix round. Read findings and validation evidence from ${runtime.fixContextPath}.`,
            "Preserve the original task scope and repair only evidence-backed findings.",
          ]
        : []),
    ];
    const sessionDirectory =
      role === "implementer" || role === "scout" ? runtime.sessionDirectory : undefined;
    if (sessionDirectory !== undefined)
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    const instructionRevision = task.communication?.revision ?? 0;
    const communication = {
      inboxPath: taskInboxPath(this.#deps.home, task.id),
      receiptPath: workerReceiptPath(paths.jobPath),
      initialRevision: instructionRevision,
    };
    const prompt = buildPrompt(
      task,
      role,
      reportPath,
      fixArtifacts,
      undefined,
      instructionRevision === 0
        ? extra
        : [
            ...extra,
            formatTaskMessages(
              task.id,
              instructionRevision,
              activeTaskMessages(task.communication),
            ),
          ],
    );
    const spec: WorkerJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      role,
      cwd: runtime.worktree?.path ?? taskSourcePath(task, runtime),
      model: task.policy.config.models[role],
      prompt,
      resultPath: paths.resultPath,
      communication,
      ...(this.#deps.workerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#deps.workerTimeoutMs }),
      ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    };
    await writeJsonAtomically(paths.jobPath, spec);
    parseWorkerJob(spec);
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
        endpoint,
        receiptPath: communication.receiptPath,
        instructionRevision,
      },
    );
    try {
      await this.appendJob(task.id, durableJob);
    } catch (error) {
      const currentRuntime = await this.#deps.runtimeFor(task.id);
      if (currentRuntime?.jobs.some(activeRuntimeJob)) return;
      throw error;
    }
    await this.recordShadowRecommendation(task, durableJob);
    await this.launchJob(
      task.id,
      durableJob.id,
      endpoint,
      spec.cwd,
      workerCommand(this.#deps.workerPath, paths.jobPath),
    );
  }

  private async launchJob(
    taskId: string,
    jobId: string,
    endpoint: Endpoint,
    cwd: string,
    command: readonly string[],
  ): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      const job = runtime.jobs.find((entry) => entry.id === jobId);
      if (job === undefined) throw new Error(`runtime job ${jobId} is missing`);
      if (job.phase !== "reserved" || job.launchAttempted) return;

      const activeTask =
        task.stage !== "paused" &&
        task.stage !== "blocked" &&
        task.stage !== "cancelled" &&
        task.stage !== "completed" &&
        task.stage !== "merged";
      if (!activeTask || runtime.stopRequest !== undefined) {
        const released = replaceRuntimeTask(state, taskId, (current) => {
          const failed = replaceJob(current, jobId, (entry) => ({
            ...entry,
            phase: "failed",
            error: "worker launch was refused by a durable stop request",
          }));
          return failed.reservation === undefined
            ? failed
            : {
                ...failed,
                reservation: {
                  ...failed.reservation,
                  phase: "released",
                  releasedAt: this.#deps.clock(),
                },
              };
        });
        await writeRuntimeState(this.#deps.runtimePath, released);
        return;
      }

      const launching = replaceRuntimeTask(state, taskId, (current) =>
        replaceJob(current, jobId, (entry) => ({
          ...entry,
          phase: "launching",
          launchAttempted: true,
        })),
      );
      await writeRuntimeState(this.#deps.runtimePath, launching);
      try {
        const previousJob = workerJobForEndpoint(
          runtime.jobs.filter((entry) => entry.id !== jobId),
          endpoint,
        );
        await prepareWorkerTerminal(this.#deps.run, {
          endpoint,
          cwd,
          ...(previousJob === undefined ? {} : { job: previousJob }),
        });
        await sendCommand(this.#deps.run, { endpoint, cwd, command });
        await this.proveWorkerStartup(job, endpoint, cwd);
      } catch (error) {
        const reason = `worker launch could not be proven after launch intent: ${describeError(error)}`;
        const failed = replaceRuntimeTask(launching, taskId, (current) =>
          replaceJob(current, jobId, (entry) => ({ ...entry, phase: "failed", error: reason })),
        );
        await writeRuntimeState(this.#deps.runtimePath, failed);
        if (activeTask) {
          const blocked = transitionTask(task, { type: "block", reason }, this.#deps.context());
          await store.update(task.id, task.revision, () => blocked);
        }
        return;
      }
      const running = replaceRuntimeTask(launching, taskId, (current) =>
        replaceJob(current, jobId, (entry) => ({
          ...entry,
          phase: "running",
          launchedAt: this.#deps.clock(),
        })),
      );
      await writeRuntimeState(this.#deps.runtimePath, running);
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

  async reserveTask(
    taskId: string,
    role: WorkerRole | "validation",
  ): Promise<ReservationResult | undefined> {
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${taskId} is missing`);
      }
      const stageAllowed =
        role === "validation"
          ? task.stage === "validating"
          : role === "scout"
            ? task.stage === "queued" || task.stage === "scouting"
            : role === "reviewer" || role === "verifier"
              ? task.stage === "reviewing"
              : task.stage === "queued" ||
                task.stage === "implementing" ||
                task.stage === "awaiting-fixes";
      if (!stageAllowed) return undefined;
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      if (runtime.stopRequest !== undefined) return undefined;
      if (unreleasedReservation(runtime.reservation)) return undefined;
      if (runtime.jobs.some(activeRuntimeJob)) return undefined;
      if (activeReservations(state) >= task.policy.config.maxWorkers) return undefined;
      const reservation = runtimeReservation(
        singleLine(this.#deps.idFactory(), "reservation id"),
        taskId,
        this.#deps.sessionId,
        this.#deps.clock(),
      );
      const nextRuntime = { ...runtime, reservation };
      await writeRuntimeState(
        this.#deps.runtimePath,
        replaceRuntimeTask(state, taskId, () => nextRuntime),
      );
      return { task, runtime: nextRuntime, reservation };
    });
  }

  private async appendJob(taskId: string, job: DurableJob): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
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
    transform: (job: DurableJob) => DurableJob,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => replaceJob(current, jobId, transform)),
    );
  }

  private async saveWorktree(
    taskId: string,
    worktree: NonNullable<RuntimeTaskState["worktree"]>,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        worktree,
        ...(current.reservation === undefined
          ? {}
          : { reservation: { ...current.reservation, phase: "worktree" } }),
      })),
    );
  }

  async saveEndpoint(taskId: string, endpoint: Endpoint): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        const { endpointLaunch: _endpointLaunch, ...withoutLaunch } = current;
        return {
          ...withoutLaunch,
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

  private async saveEndpointLaunch(
    taskId: string,
    launch: DurableEndpointLaunch,
  ): Promise<boolean> {
    let claimed = false;
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
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

  async releaseUnlaunchedTaskReservation(taskId: string, reservationId: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        if (
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
          reservation: {
            ...current.reservation,
            phase: "released",
            releasedAt: this.#deps.clock(),
          },
        };
      }),
    );
  }

  private async readWorkerCheckout(
    runtime: RuntimeTaskState,
    job: Pick<DurableJob, "cwd" | "head">,
  ): Promise<CurrentCheckout> {
    const expectedHead = job.head ?? runtime.worktree?.baseHead;
    if (expectedHead === undefined) throw new Error("worker checkout has no expected HEAD");
    const checkpoint =
      runtime.worktree?.baseHead === undefined
        ? await readCheckpoint(this.#deps.run, { repo: job.cwd })
        : await readCheckpoint(this.#deps.run, {
            repo: job.cwd,
            baseRef: runtime.worktree.baseHead,
          });
    return { checkpoint, expectedHead };
  }

  assertSourceUnchanged(pinned: GitCheckpoint, current: GitCheckpoint): void {
    if (
      pinned.head === current.head &&
      pinned.dirty === current.dirty &&
      pinned.unmerged === current.unmerged &&
      !current.dirty &&
      !current.unmerged
    ) {
      return;
    }
    const reasons = [
      pinned.head !== current.head
        ? `HEAD changed from ${pinned.head} to ${current.head}`
        : undefined,
      current.dirty
        ? "current worktree is dirty"
        : pinned.dirty !== current.dirty
          ? `dirty state changed from ${String(pinned.dirty)} to ${String(current.dirty)}`
          : undefined,
      current.unmerged
        ? "current checkout has unmerged paths"
        : pinned.unmerged !== current.unmerged
          ? `unmerged state changed from ${String(pinned.unmerged)} to ${String(current.unmerged)}`
          : undefined,
    ].filter((reason): reason is string => reason !== undefined);
    throw new Error(`source checkpoint is unsafe: ${reasons.join("; ")}`);
  }
}
