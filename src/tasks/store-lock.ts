import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open } from "node:fs/promises";

import { errorCode, StoreLockError, StoreLockTimeoutError } from "./store-errors.ts";

// Bun omits Darwin's open(2) lock flags from fs.constants; values mirror fcntl.h.
const DARWIN_O_RDWR = 0x0002;
const DARWIN_O_NONBLOCK = 0x0004;
const DARWIN_O_EXLOCK = 0x0020;
const DARWIN_O_NOFOLLOW = 0x0100;
const DARWIN_O_CREAT = 0x0200;
const LOCK_FLAGS =
  DARWIN_O_RDWR | DARWIN_O_NONBLOCK | DARWIN_O_EXLOCK | DARWIN_O_NOFOLLOW | DARWIN_O_CREAT;

function assertNativeRepositoryLock(): void {
  if (process.platform !== "darwin") {
    throw new StoreLockError("Repository locks require Darwin O_EXLOCK support");
  }
}

function isLockBusy(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pauseFor(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

/** Leases held by the in-process test lock, keyed by lock path. */
const inProcessLeases = new Map<string, Promise<void>>();

/**
 * Test-only stand-in for O_EXLOCK on machines without it (Linux cloud sessions), opted into with
 * `TANDEM_IN_PROCESS_STORE_LOCK=1`. It serializes callers in this process only, so it never
 * protects against another process and must not be set for a real Tandem home.
 */
function inProcessLockEnabled(): boolean {
  return process.platform !== "darwin" && process.env.TANDEM_IN_PROCESS_STORE_LOCK === "1";
}

async function acquireInProcessLock(path: string): Promise<() => Promise<void>> {
  for (let held = inProcessLeases.get(path); held !== undefined; held = inProcessLeases.get(path)) {
    await held;
  }
  const lease = Promise.withResolvers<void>();
  inProcessLeases.set(path, lease.promise);
  return async () => {
    if (inProcessLeases.get(path) === lease.promise) inProcessLeases.delete(path);
    lease.resolve();
  };
}

export async function acquireDarwinFileLock(
  path: string,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
): Promise<(relocatedPath?: string) => Promise<void>> {
  if (inProcessLockEnabled()) return acquireInProcessLock(path);
  assertNativeRepositoryLock();
  const assertNotAborted = (): void => {
    if (signal?.aborted) {
      throw new StoreLockError(`Repository lock ${path} acquisition was aborted`, {
        cause: signal.reason,
      });
    }
  };
  assertNotAborted();
  const startedAt = Date.now();
  while (true) {
    assertNotAborted();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, LOCK_FLAGS, 0o600);
      const lockStat = await handle.stat();
      if (!lockStat.isFile()) {
        throw new StoreLockError(`Repository lock ${path} is not a regular file`);
      }
      const pathStat = await lstat(path);
      if (!sameFile(pathStat, lockStat)) {
        throw new StoreLockError(`Repository lock ${path} changed during acquisition`);
      }
      await handle.chmod(0o600);
      const lease = handle;
      handle = undefined;
      let released = false;
      return async (relocatedPath = path) => {
        if (released) {
          return;
        }
        released = true;
        try {
          const currentStat = await lstat(relocatedPath);
          const ownerStat = await lease.stat();
          if (!sameFile(currentStat, ownerStat)) {
            throw new StoreLockError(`Repository lock ${relocatedPath} changed before release`);
          }
        } finally {
          await lease.close();
        }
      };
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (error instanceof StoreLockError) {
        throw error;
      }
      if (!isLockBusy(error)) {
        throw new StoreLockError(`Could not acquire repository lock ${path}`, { cause: error });
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new StoreLockTimeoutError(path, timeoutMs);
      }
      assertNotAborted();
      await pauseFor(pollMs);
    }
  }
}
