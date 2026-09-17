import { dirname, join } from "node:path";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";

export const PRESENTATION_LOCK_TIMEOUT_MS = 5_000;
export const PRESENTATION_LOCK_POLL_MS = 20;

export function presentationFeedbackLockPath(recordPath: string): string {
  return join(dirname(recordPath), ".feedback.lock");
}

export async function withPresentationLock<Result>(
  recordPath: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  const release = await acquireDarwinFileLock(
    presentationFeedbackLockPath(recordPath),
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
