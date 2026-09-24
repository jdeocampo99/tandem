import type { Clock, IdFactory, IsoTimestamp, TaskQuestion, TaskRecord } from "../contracts.ts";
import { activeRuntimeJob } from "../runtime/activity.ts";
import type { DurableJob, DurableJobConsumption, RuntimeTaskState } from "../runtime/schema.ts";
import {
  describeError,
  inputEventKey,
  recognizesAppliedEvent,
  replaceJob,
  singleLine,
  taskFingerprint,
  taskWithQuestion,
  taskWithQuestionCommit,
} from "../service/records.ts";
import { type TaskEvent, type TaskTransitionContext, transitionTask } from "../tasks/lifecycle.ts";

/** What applying one durable job result needs beyond the records themselves. */
export type JobConsumptionDependencies = Readonly<{
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly context: () => TaskTransitionContext;
}>;

export type JobConsumptionInput = Readonly<{
  readonly task: TaskRecord;
  readonly job: DurableJob;
  readonly event: TaskEvent;
  readonly question?: TaskQuestion;
  readonly reportPath?: string;
}>;

/** The task record a job result produces and the consumption receipt that proves it. */
export type PlannedJobConsumption = Readonly<{
  readonly nextTask: TaskRecord;
  readonly consumption: DurableJobConsumption;
}>;

const RESTING_STAGES: readonly TaskRecord["stage"][] = [
  "paused",
  "blocked",
  "cancelled",
  "completed",
  "merged",
];

/** Whether the task is paused, blocked, or finished, so no worker result may move its stage. */
export function taskAtRest(task: TaskRecord): boolean {
  return RESTING_STAGES.includes(task.stage);
}

/** Releases the task's reservation once no job of its operation is still active. */
export function releaseIdleReservation(
  runtime: RuntimeTaskState,
  now: IsoTimestamp,
): RuntimeTaskState {
  if (runtime.reservation === undefined || runtime.jobs.some(activeRuntimeJob)) return runtime;
  return {
    ...runtime,
    reservation: { ...runtime.reservation, phase: "released", releasedAt: now },
  };
}

/** Marks one job failed with `reason`, then releases the reservation if nothing else runs. */
export function failedJobRuntime(
  runtime: RuntimeTaskState,
  jobId: string,
  reason: string,
  now: IsoTimestamp,
): RuntimeTaskState {
  return releaseIdleReservation(
    replaceJob(runtime, jobId, (job) => ({ ...job, phase: "failed", error: reason })),
    now,
  );
}

/** Settles a job as consumed and completes its operation, releasing the idle reservation. */
export function consumedJobRuntime(
  runtime: RuntimeTaskState,
  job: DurableJob,
  consumption: DurableJobConsumption,
  instructionRevision: number | undefined,
  now: IsoTimestamp,
): RuntimeTaskState {
  const consumed = replaceJob(runtime, job.id, (entry) => ({
    ...entry,
    ...(instructionRevision === undefined ? {} : { instructionRevision }),
    phase: "consumed",
    consumedAt: now,
    consumption,
  }));
  const completed = {
    ...consumed,
    ...(consumed.operation === undefined
      ? {}
      : {
          operation: {
            ...consumed.operation,
            phase: "completed" as const,
            resultConsumedAt: now,
          },
        }),
  };
  return releaseIdleReservation(
    job.role === "implementer" ? { ...completed, reviewMode: "review_changed_diff" } : completed,
    now,
  );
}

/**
 * Decides the task record a job result produces. A prepared consumption is replayed and must
 * reproduce its recorded transition exactly; a result the task already reflects is recognized
 * without transitioning again; anything else transitions now, turning a rejected event into a
 * block. A task at rest keeps its stage.
 */
export function planJobConsumption(
  deps: JobConsumptionDependencies,
  input: JobConsumptionInput,
): PlannedJobConsumption {
  const { task, job, event } = input;
  const existing = job.consumption;
  const inputKey = inputEventKey(job.id, event);
  if (existing !== undefined) {
    return {
      nextTask: replayedConsumptionTask(deps, input, existing, inputKey),
      consumption: existing,
    };
  }
  if (recognizesAppliedEvent(task, event)) {
    const nextTask = withReportPath(
      deps.clock,
      task,
      input.question === undefined
        ? task
        : taskWithQuestionCommit(task, input.question, deps.clock()),
      input.reportPath,
    );
    return {
      nextTask,
      consumption: {
        schemaVersion: 1,
        inputEventKey: inputKey,
        appliedEventKey: inputKey,
        beforeRevision: task.revision,
        afterRevision: nextTask.revision,
        beforeFingerprint: taskFingerprint(task),
        taskFingerprint: taskFingerprint(nextTask),
        now: deps.clock(),
        notificationId: singleLine(deps.idFactory(), "notification id"),
      },
    };
  }
  const context = deps.context();
  const applied = taskAtRest(task)
    ? { nextTask: task, effectiveEvent: event }
    : transitionOrBlock(task, event, context, job.id);
  let nextTask = applied.nextTask;
  if (input.question !== undefined) {
    nextTask =
      nextTask.revision === task.revision
        ? taskWithQuestionCommit(nextTask, input.question, context.now)
        : taskWithQuestion(nextTask, input.question);
  }
  nextTask = withReportPath(deps.clock, task, nextTask, input.reportPath);
  return {
    nextTask,
    consumption: {
      schemaVersion: 1,
      inputEventKey: inputKey,
      appliedEventKey: inputEventKey(job.id, applied.effectiveEvent),
      beforeRevision: task.revision,
      afterRevision: nextTask.revision,
      beforeFingerprint: taskFingerprint(task),
      taskFingerprint: taskFingerprint(nextTask),
      now: context.now,
      notificationId: context.notificationId,
    },
  };
}

function replayedConsumptionTask(
  deps: JobConsumptionDependencies,
  input: JobConsumptionInput,
  existing: DurableJobConsumption,
  inputKey: string,
): TaskRecord {
  const { task, job, event } = input;
  if (existing.inputEventKey !== inputKey) {
    throw new Error(`durable result ${job.id} was prepared for a different lifecycle event`);
  }
  const currentFingerprint = taskFingerprint(task);
  if (task.revision === existing.afterRevision && currentFingerprint === existing.taskFingerprint) {
    return task;
  }
  if (
    task.revision === existing.beforeRevision &&
    currentFingerprint === existing.beforeFingerprint
  ) {
    const context: TaskTransitionContext = {
      now: existing.now,
      notificationId: existing.notificationId,
    };
    const applied = transitionOrBlock(task, event, context, job.id);
    const nextTask = withReportPath(
      deps.clock,
      task,
      input.question === undefined
        ? applied.nextTask
        : taskWithQuestion(applied.nextTask, input.question),
      input.reportPath,
    );
    if (
      inputEventKey(job.id, applied.effectiveEvent) !== existing.appliedEventKey ||
      nextTask.revision !== existing.afterRevision ||
      taskFingerprint(nextTask) !== existing.taskFingerprint
    ) {
      throw new Error(
        `durable result ${job.id} no longer matches its prepared lifecycle transition`,
      );
    }
    return nextTask;
  }
  if (taskAtRest(task)) return task;
  throw new Error(`durable result ${job.id} has an unexpected task revision or state`);
}

/** Applies `event`, or blocks the task on why the lifecycle refused it. */
function transitionOrBlock(
  task: TaskRecord,
  event: TaskEvent,
  context: TaskTransitionContext,
  jobId: string,
): Readonly<{ readonly nextTask: TaskRecord; readonly effectiveEvent: TaskEvent }> {
  try {
    return { nextTask: transitionTask(task, event, context), effectiveEvent: event };
  } catch (error) {
    const reason = `durable result could not be applied: ${describeError(error)}`;
    const blocked: TaskEvent = {
      type: "block",
      reason,
      cause: {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "Tandem couldn't save this step's result.",
        detail: reason,
        jobId,
      },
    };
    return { nextTask: transitionTask(task, blocked, context), effectiveEvent: blocked };
  }
}

/**
 * Records the result's report path. It bumps the revision only when nothing else changed the
 * task, so a transition that already bumped it is not counted twice.
 */
function withReportPath(
  clock: Clock,
  before: TaskRecord,
  candidate: TaskRecord,
  reportPath: string | undefined,
): TaskRecord {
  if (reportPath === undefined || candidate.reportPath === reportPath) return candidate;
  if (candidate.revision !== before.revision) return { ...candidate, reportPath };
  return { ...candidate, revision: candidate.revision + 1, updatedAt: clock(), reportPath };
}
