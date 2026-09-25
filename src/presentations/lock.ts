import { dirname, join } from "node:path";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";

export const PRESENTATION_LOCK_TIMEOUT_MS = 5_000;
export const PRESENTATION_LOCK_POLL_MS = 20;

/** Held for a whole Lavish poll, so only one listener polls a presentation at a time. */
export function presentationFeedbackLockPath(recordPath: string): string {
  return join(dirname(recordPath), ".feedback.lock");
}

function presentationRecordLockPath(recordPath: string): string {
  return join(dirname(recordPath), ".record.lock");
}

/**
 * Serializes writes to one presentation record. It is separate from the poll lock because a poll
 * can wait on Lavish for hours while the research agent's requests still need to be recorded.
 */
export async function withPresentationLock<Result>(
  recordPath: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  const release = await acquireDarwinFileLock(
    presentationRecordLockPath(recordPath),
    PRESENTATION_LOCK_TIMEOUT_MS,
    PRESENTATION_LOCK_POLL_MS,
    signal,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}
