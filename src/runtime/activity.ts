import type { TaskRecord } from "../contracts.ts";
import type {
  DurableJob,
  DurableReservation,
  RuntimePresentation,
  RuntimeState,
  RuntimeTaskState,
} from "./schema.ts";

export function taskRuntime(state: RuntimeState, taskId: string): RuntimeTaskState | undefined {
  return state.tasks.find((entry) => entry.taskId === taskId);
}

export function presentationRuntime(
  state: RuntimeState,
  id: string,
): RuntimePresentation | undefined {
  return state.presentations.find((entry) => entry.id === id);
}

export function activeRuntimeJob(job: DurableJob): boolean {
  return job.phase === "reserved" || job.phase === "launching" || job.phase === "running";
}

export function unreleasedReservation(
  reservation: DurableReservation | undefined,
): reservation is DurableReservation {
  return reservation !== undefined && reservation.phase !== "released";
}

export function activeReservations(state: RuntimeState): number {
  let count = 0;
  for (const task of state.tasks) {
    if (unreleasedReservation(task.reservation)) count += 1;
  }
  for (const presentation of state.presentations) {
    if (unreleasedReservation(presentation.reservation)) count += 1;
  }
  return count;
}

export function taskHasActiveJob(task: RuntimeTaskState): boolean {
  return task.jobs.some(activeRuntimeJob);
}

export function taskRecordForRuntime(
  task: TaskRecord,
  runtime: RuntimeTaskState | undefined,
): RuntimeTaskState | undefined {
  if (runtime === undefined || runtime.taskId !== task.id) return undefined;
  return runtime;
}
