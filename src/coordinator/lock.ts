import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
import {
  canonicalHome,
  canonicalPath,
  digest,
  errorCode,
  isMissing,
  REGISTRY_DIRECTORY,
  sessionText,
} from "./record.ts";

const COORDINATOR_LOCK_TIMEOUT_MS = 5_000;
const COORDINATOR_LOCK_POLL_MS = 20;
const REPOSITORY_LOCK_PREFIX = "repository-";

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
/**
 * Names the lock file every Tandem session shares for one canonical repository. Two spellings of
 * one repository, such as a symlinked checkout, resolve to the same canonical path and therefore
 * to the same lock.
 */
export async function coordinatorRepositoryLockPath(
  homeInput: string,
  repoPathInput: string,
): Promise<string> {
  const home = await canonicalHome(homeInput);
  const repoPath = await canonicalPath(repoPathInput, "repoPath");
  return join(
    home,
    REGISTRY_DIRECTORY,
    `${REPOSITORY_LOCK_PREFIX}${digest(repoPath).slice(0, 16)}.lock`,
  );
}

/**
 * Serializes coordinator work for one canonical repository across every Tandem session sharing a
 * home, so two sessions cannot each decide they are the repository's only coordinator.
 *
 * Lock ordering, so no two callers can deadlock: the repository lock is always acquired first,
 * then the launching session's own launch lock, then the launch lock of any other session whose
 * records are being reconciled. Callers that hold only a session lock, such as coordinator reset
 * and source refresh, never acquire the repository lock, so no cycle exists.
 */
export async function withCoordinatorRepositoryLock<Result>(
  homeInput: string,
  repoPathInput: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function");
  }
  const path = await coordinatorRepositoryLockPath(homeInput, repoPathInput);
  await ensurePrivateDirectoryTree(dirname(path), "coordinator registry directory");
  const release = await acquireDarwinFileLock(
    path,
    COORDINATOR_LOCK_TIMEOUT_MS,
    COORDINATOR_LOCK_POLL_MS,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

/** Serializes coordinator work for one session; acquired after the repository lock above. */
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
