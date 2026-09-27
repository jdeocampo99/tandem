import type { TaskRecord, WorkerReceipt } from "../contracts.ts";
import { readWorkerReceipt } from "../tasks/communication-persistence.ts";
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

/**
 * The receipt of the newest primary worker (scout, or implementer) for the task's current
 * generation that has one; unreadable receipts are skipped.
 */
export async function latestPrimaryReceipt(
  task: TaskRecord,
  runtime: RuntimeTaskState | undefined,
): Promise<WorkerReceipt | undefined> {
  const primaryRole = task.kind === "scout" ? "scout" : "implementer";
  const jobs = (runtime?.jobs ?? []).filter(
    (job) =>
      job.kind === "worker" &&
      job.role === primaryRole &&
      job.generation === task.generation &&
      job.receiptPath !== undefined,
  );
  for (const job of jobs.reverse()) {
    const receipt = await readWorkerReceipt(job.receiptPath as string, {
      jobId: job.id,
      taskId: task.id,
      generation: job.generation,
    }).catch(() => undefined);
    if (receipt !== undefined) return receipt;
  }
  return undefined;
}
