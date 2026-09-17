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

export async function acquireDarwinFileLock(
  path: string,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
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
      return async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          const currentStat = await lstat(path);
          const ownerStat = await lease.stat();
          if (!sameFile(currentStat, ownerStat)) {
            throw new StoreLockError(`Repository lock ${path} changed before release`);
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
