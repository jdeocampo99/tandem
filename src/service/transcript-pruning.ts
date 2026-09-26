import { rm } from "node:fs/promises";
import type { IsoTimestamp, TaskRecord } from "../contracts.ts";
import { taskSessionDirectory } from "../runtime/persistence.ts";
import { isTerminalTask } from "./records.ts";

/** How long a finished task keeps its worker conversation. Its timeline and reports are kept. */
export const TRANSCRIPT_RETENTION_DAYS = 30;

const RETENTION_MS = TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Tasks whose worker conversation can go: cancelled, completed, or merged, with no change for the
 * retention period. `updatedAt` is the last change, so a finished task touched later waits longer.
 */
export function transcriptsToPrune(
  tasks: readonly TaskRecord[],
  now: IsoTimestamp,
): readonly string[] {
  const cutoff = Date.parse(now) - RETENTION_MS;
  return tasks
    .filter((task) => isTerminalTask(task) && Date.parse(task.updatedAt) <= cutoff)
    .map((task) => task.id);
}

/** Deletes each task's `sessions/<task-id>/` folder; a folder already gone is not an error. */
export async function pruneTranscripts(home: string, taskIds: readonly string[]): Promise<void> {
  for (const taskId of taskIds) {
    await rm(taskSessionDirectory(home, taskId), { recursive: true, force: true });
  }
}
