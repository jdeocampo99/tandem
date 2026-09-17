import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
import {
  canonicalHome,
  digest,
  errorCode,
  isMissing,
  REGISTRY_DIRECTORY,
  sessionText,
} from "./record.ts";

const COORDINATOR_LOCK_TIMEOUT_MS = 5_000;
const COORDINATOR_LOCK_POLL_MS = 20;

export async function ensurePrivateDirectoryTree(directory: string, field: string): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`${field} must be a private directory`);
      }
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(parent === sep ? current.slice(1) : current.slice(parent.length + 1));
      current = parent;
    }
  }
  for (const component of missing) {
    const next = join(current, component);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const details = await lstat(next);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`${field} must be a private directory`);
    }
    current = next;
  }
}
export async function withCoordinatorLaunchLock<Result>(
  homeInput: string,
  sessionInput: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function");
  }
  const home = await canonicalHome(homeInput);
  const sessionId = sessionText(sessionInput);
  const registryDirectory = join(home, REGISTRY_DIRECTORY);
  await ensurePrivateDirectoryTree(registryDirectory, "coordinator registry directory");
  const release = await acquireDarwinFileLock(
    join(registryDirectory, `${digest(sessionId).slice(0, 16)}.lock`),
    COORDINATOR_LOCK_TIMEOUT_MS,
    COORDINATOR_LOCK_POLL_MS,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}
