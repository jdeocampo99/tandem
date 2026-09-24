import type { BlockCause, TaskRecord } from "../contracts.ts";
import { activeRuntimeJob, unreleasedReservation } from "../runtime/activity.ts";
import type { DurableJob, DurableReservation, RuntimeTaskState } from "../runtime/schema.ts";
import { currentWriter, isTerminalTask } from "./records.ts";

/** What one scheduler pass does for a task that is stopping, finished, or held. */
export type HeldTaskStep =
  | Readonly<{ kind: "settle-stop-request"; discard: boolean }>
  | Readonly<{ kind: "release-terminal-resources" }>
  | Readonly<{ kind: "wait" }>
  | Readonly<{ kind: "recover-blocked" }>;

/** What one scheduler pass does for a task that may still move forward. */
export type LiveTaskStep =
  | Readonly<{ kind: "wait" }>
  | Readonly<{ kind: "reconcile-job"; job: DurableJob }>
  | Readonly<{
      kind: "quarantine-legacy-reservation";
      reservation: DurableReservation;
      cause: BlockCause;
    }>
  | Readonly<{ kind: "block-claimed"; reservation: DurableReservation; cause: BlockCause }>
  | Readonly<{ kind: "reconcile-operation" }>
  | Readonly<{ kind: "start-queued" }>
  | Readonly<{ kind: "begin-fixes" }>
  | Readonly<{ kind: "validate" }>
  | Readonly<{ kind: "advance-review" }>
  | Readonly<{ kind: "block"; cause: BlockCause }>
  | Readonly<{ kind: "recover-stuck-writer" }>
  | Readonly<{ kind: "launch-writer" }>;

/** Terminal, paused, or blocked: a block event would be invalid, so the task is left as it is. */
export function alreadyStopped(task: TaskRecord): boolean {
  return isTerminalTask(task) || task.stage === "paused" || task.stage === "blocked";
}

/** The step for a task no worker should advance, or undefined when the task is live. */
export function heldTaskStep(
  task: TaskRecord,
  runtime: RuntimeTaskState,
): HeldTaskStep | undefined {
  if (runtime.stopRequest !== undefined) {
    return { kind: "settle-stop-request", discard: runtime.stopRequest.discard === true };
  }
  if (isTerminalTask(task)) return { kind: "release-terminal-resources" };
  if (task.stage === "paused") return { kind: "wait" };
  // A blocked task whose cause is recoverable (a worker/pane vanishing, not a person's decision)
  // reaches central recovery without anyone asking; anything not eligible stays blocked.
  if (task.stage === "blocked") return { kind: "recover-blocked" };
  return undefined;
}

/**
 * The step for a live task once its operation claim and endpoint launch are settled. An active
 * job or unreleased reservation is reconciled before the stage is allowed to start anything new.
 */
export function liveTaskStep(task: TaskRecord, runtime: RuntimeTaskState): LiveTaskStep {
  const active = runtime.jobs.find(activeRuntimeJob);
  if (active !== undefined) return { kind: "reconcile-job", job: active };
  if (unreleasedReservation(runtime.reservation)) {
    return reservationStep(runtime.reservation, runtime.operation);
  }
  switch (task.stage) {
    case "queued":
      return { kind: "start-queued" };
    case "awaiting-fixes":
      return { kind: "begin-fixes" };
    case "validating":
      return { kind: "validate" };
    case "reviewing":
      return { kind: "advance-review" };
    case "scouting":
    case "implementing":
      return writerStep(task, runtime);
    default:
      return { kind: "wait" };
  }
}

function reservationStep(
  reservation: DurableReservation,
  operation: RuntimeTaskState["operation"],
): LiveTaskStep {
  if (operation === undefined) {
    const reason =
      "legacy reservation has no durable operation; quarantined without clearing reservation or checkpoint";
    return {
      kind: "quarantine-legacy-reservation",
      reservation,
      cause: {
        group: "safety-stop",
        kind: "quarantined-unknown-outcome",
        summary:
          "Tandem's records for this task are incomplete, so it paused the task without touching your work.",
        detail: reason,
      },
    };
  }
  if (reservation.operationId !== operation.id) {
    const reason = "reservation and operation identities do not match; quarantined without launch";
    return {
      kind: "block-claimed",
      reservation,
      cause: {
        group: "safety-stop",
        kind: "identity-mismatch",
        summary:
          "Tandem's records for this task don't match each other, so it didn't start anything.",
        detail: reason,
      },
    };
  }
  return { kind: "reconcile-operation" };
}

function writerStep(task: TaskRecord, runtime: RuntimeTaskState): LiveTaskStep {
  if (runtime.endpointLaunch !== undefined) return { kind: "wait" };
  if (runtime.worktree === undefined) {
    return {
      kind: "block",
      cause: {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The task's working copy is missing.",
        detail: `task is ${task.stage} but its durable worktree is missing`,
      },
    };
  }
  // No owned pane is recorded and no job or reservation is active: the prior worker is either
  // already proven dead or needs the stop ladder run against a stale record, which central
  // recovery owns.
  if (currentWriter(runtime) === undefined) return { kind: "recover-stuck-writer" };
  return { kind: "launch-writer" };
}
