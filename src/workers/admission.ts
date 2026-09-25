import type { AgentRole, ModelSpec, TaskRecord } from "../contracts.ts";
import { activeRuntimeJob, unreleasedReservation } from "../runtime/activity.ts";
import type {
  DurableOperation,
  DurableOperationKind,
  DurableReservation,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import { iterationScopeFor } from "../tasks/acceptance.ts";
import { fixRoundBudget } from "../tasks/findings.ts";
import { type TaskTransitionContext, transitionTask } from "../tasks/lifecycle.ts";
import type { ExecutionRoutingBoundary, PriorExecutionAttempt } from "./execution-routing.ts";
import type { WorkerRole } from "./jobs.ts";

export type AdmissionRole = WorkerRole | "validation";

export type ReservationResult = Readonly<{
  readonly task: TaskRecord;
  readonly runtime: RuntimeTaskState;
  readonly reservation: DurableReservation;
}>;

/** Why `reserveTask` admitted nothing: one plain sentence for people, the specifics in `detail`. */
export type ReservationRefusal = Readonly<{
  readonly refusal:
    | "stage"
    | "fix-rounds"
    | "stop-requested"
    | "slot-held"
    | "job-running"
    | "routing-question";
  readonly summary: string;
  readonly detail: string;
}>;

/** What one reservation needs routing resolved for, before its operation exists. */
export type RoutingAttempt = Readonly<{
  readonly role: WorkerRole;
  readonly operationId: string;
  readonly jobId: string;
  readonly inputHead: string;
  readonly policyDigest: string;
  readonly cwd: string;
}>;

/** Whether admitting `role` now starts a fix round rather than a first implementation. */
export function isFixAdmission(task: TaskRecord, role: AdmissionRole): boolean {
  return role === "implementer" && task.stage === "awaiting-fixes";
}

/** Refuses a role the task's stage or fix-round budget does not allow; the task alone decides. */
export function taskAdmissionRefusal(
  task: TaskRecord,
  role: AdmissionRole,
): ReservationRefusal | undefined {
  const isFix = isFixAdmission(task, role);
  if (isFix && (task.reviewHead === undefined || task.reviewRound >= fixRoundBudget(task))) {
    return {
      refusal: "fix-rounds",
      summary: "The worker has no fix rounds left.",
      detail: `review round ${task.reviewRound} of ${fixRoundBudget(task)}; reviewed head ${String(task.reviewHead)}`,
    };
  }
  const stageAllowed =
    role === "validation"
      ? task.stage === "validating"
      : role === "scout"
        ? task.stage === "queued" || task.stage === "scouting"
        : role === "reviewer"
          ? task.stage === "reviewing"
          : task.stage === "queued" || task.stage === "implementing" || isFix;
  if (stageAllowed) return undefined;
  return {
    refusal: "stage",
    summary: `The task is ${task.stage}, so no ${role} can start.`,
    detail: `role ${role} cannot start at stage ${task.stage}`,
  };
}

/** Refuses while a stop, another reservation, or a running job stands. */
export function runtimeAdmissionRefusal(runtime: RuntimeTaskState): ReservationRefusal | undefined {
  if (runtime.stopRequest !== undefined) {
    return {
      refusal: "stop-requested",
      summary: "A stop was requested for this task.",
      detail: `pending ${runtime.stopRequest.action} request for generation ${runtime.stopRequest.generation}`,
    };
  }
  const held = runtime.reservation;
  if (unreleasedReservation(held)) {
    return {
      refusal: "slot-held",
      summary: "Another worker still holds this task's slot.",
      detail: `reservation ${held.id} (${held.phase}) for operation ${String(held.operationId)}`,
    };
  }
  const running = runtime.jobs.find(activeRuntimeJob);
  if (running !== undefined) {
    return {
      refusal: "job-running",
      summary: "A worker is still running for this task.",
      detail: `job ${running.id} is ${running.phase}`,
    };
  }
  return undefined;
}

export function operationKindFor(role: AdmissionRole, isFix: boolean): DurableOperationKind {
  if (role === "validation") return "validation";
  if (role === "scout") return "scout";
  if (role === "reviewer") return "review";
  return isFix ? "fix" : "implementation";
}

/** The task after `begin-fixes`, with its recorded endpoints moved to the new generation. */
export function fixRoundTask(
  task: TaskRecord,
  inputHead: string,
  context: TaskTransitionContext,
): TaskRecord {
  const iterationScope = iterationScopeFor(task);
  const transitioned = transitionTask(
    task,
    {
      type: "begin-fixes",
      head: inputHead,
      generation: task.generation,
      ...(iterationScope === undefined ? {} : { iterationScope }),
    },
    context,
  );
  return {
    ...transitioned,
    ...(transitioned.endpoints === undefined
      ? {}
      : {
          endpoints: transitioned.endpoints.map((endpoint) => ({
            ...endpoint,
            generation: transitioned.generation,
          })),
        }),
  };
}

/** Every operation this task has recorded for one role, oldest first. */
function roleOperations(runtime: RuntimeTaskState, role: WorkerRole): readonly DurableOperation[] {
  return [
    ...(runtime.operationHistory ?? []),
    ...(runtime.operation === undefined ? [] : [runtime.operation]),
  ].filter((operation) => operation.role === role);
}

/** Which attempt this is for the role, counting every operation already recorded for it. */
export function attemptNumber(runtime: RuntimeTaskState, role: WorkerRole): number {
  return roleOperations(runtime, role).length + 1;
}

/**
 * How the last attempt for this role ended, as far as the durable record proves. A failed
 * operation is a known safe failure: it settled and released what it held. A quarantined one is
 * uncertain and stays that way. Anything else is not a replacement boundary at all.
 */
export function priorExecutionAttempt(
  runtime: RuntimeTaskState,
  role: WorkerRole,
  modelRole: WorkerRole,
  pinned: Readonly<Record<AgentRole, ModelSpec>>,
): PriorExecutionAttempt | undefined {
  const operations = roleOperations(runtime, role);
  const last = operations[operations.length - 1];
  if (last === undefined) return undefined;
  if (last.phase !== "failed" && last.phase !== "quarantined") return undefined;
  return {
    operationId: last.id,
    selector: last.routing?.selector ?? pinned[modelRole].model,
    outcome: last.phase === "failed" ? "known-safe-failure" : "uncertain",
  };
}

export function routingBoundary(
  prior: PriorExecutionAttempt | undefined,
): ExecutionRoutingBoundary {
  return prior === undefined ? { kind: "job-launch" } : { kind: "replacement-attempt", prior };
}
