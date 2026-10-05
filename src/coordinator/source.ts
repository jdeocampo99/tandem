import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readCheckpoint } from "../adapters/git.ts";
import type { CommandRunner } from "../contracts.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { withCoordinatorLaunchLock } from "./lock.ts";
import { findRunningCoordinator } from "./ownership.ts";
import { saveCoordinatorRecord } from "./registry.ts";

export type CoordinatorSourceHead = Readonly<{
  readonly head: string;
  readonly localOnly: boolean;
}>;

export type CoordinatorSourceRefreshResult = CoordinatorSourceHead &
  Readonly<{
    readonly previousHead: string;
    readonly changed: boolean;
  }>;

export type CoordinatorSourceRefreshInput = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly repoPath: string;
  readonly sourceRepoPath: string;
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
}>;

async function gitText(
  run: CommandRunner,
  repo: string,
  args: readonly string[],
  operation: string,
): Promise<string> {
  const result = await run({ argv: ["git", "-C", repo, ...args], cwd: repo });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${operation} failed with exit code ${result.code}${detail ? `: ${detail}` : ""}`,
    );
  }
  const value = result.stdout.trim();
  if (value.length === 0) throw new Error(`${operation} returned no value`);
  return value;
}

/** Resolve the revision a new coordinator should use, fetching origin/main when configured. */
export async function resolveCoordinatorSourceHead(
  run: CommandRunner,
  repoPath: string,
): Promise<CoordinatorSourceHead> {
  const repo = resolve(repoPath);
  const remoteResult = await run({ argv: ["git", "-C", repo, "remote"], cwd: repo });
  if (remoteResult.code !== 0) {
    const detail = remoteResult.stderr.trim() || remoteResult.stdout.trim();
    throw new Error(
      `git remote lookup failed with exit code ${remoteResult.code}${detail ? `: ${detail}` : ""}`,
    );
  }
  const hasOrigin = remoteResult.stdout.split(/\s+/u).some((remote) => remote === "origin");
  if (!hasOrigin) {
    return {
      head: await gitText(run, repo, ["rev-parse", "HEAD"], "git local source HEAD"),
      localOnly: true,
    };
  }
  const fetched = await run({
    argv: ["git", "-C", repo, "fetch", "origin", "refs/heads/main:refs/remotes/origin/main"],
    cwd: repo,
  });
  if (fetched.code !== 0) {
    const detail = fetched.stderr.trim() || fetched.stdout.trim();
    throw new Error(
      `git fetch origin/main failed${detail ? `: ${detail}` : ` with exit code ${fetched.code}`}`,
    );
  }
  return {
    head: await gitText(
      run,
      repo,
      ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
      "git origin/main resolution",
    ),
    localOnly: false,
  };
}

async function refreshOwnedCheckout(
  input: CoordinatorSourceRefreshInput,
  source: CoordinatorSourceHead,
): Promise<CoordinatorSourceRefreshResult> {
  const repo = resolve(input.repoPath);
  const running = await findRunningCoordinator(input.run, input.terminal, {
    home: input.home,
    sessionId: input.sessionId,
    repoPath: repo,
  });
  if (running === undefined) {
    throw new Error("cannot refresh coordinator source without a running owned coordinator");
  }
  const worktreePath = await realpath(running.worktree.path);
  const originalPath = await realpath(repo);
  const expectedSourcePath = await realpath(input.sourceRepoPath);
  if (worktreePath !== expectedSourcePath) {
    throw new Error(
      `coordinator source ${JSON.stringify(worktreePath)} does not match expected source checkout ${JSON.stringify(expectedSourcePath)}`,
    );
  }
  if (worktreePath === originalPath) {
    throw new Error("coordinator source refresh refused the original repository checkout");
  }
  const initialCheckpoint = await readCheckpoint(input.run, { repo: worktreePath });
  if (initialCheckpoint.dirty || initialCheckpoint.unmerged) {
    throw new Error(
      `coordinator source ${JSON.stringify(worktreePath)} is dirty or has unmerged paths`,
    );
  }
  const branch = await gitText(
    input.run,
    worktreePath,
    ["branch", "--show-current"],
    "git coordinator branch",
  );
  if (branch !== running.worktree.branch) {
    throw new Error(
      `coordinator source branch ${JSON.stringify(branch)} does not match recorded lease branch ${JSON.stringify(running.worktree.branch)}`,
    );
  }
  let currentRecord = running;
  const pending = running.pendingSourceRefresh;
  if (pending !== undefined) {
    if (
      pending.leaseId !== running.worktree.leaseId ||
      pending.leaseHolder !== running.worktree.leaseHolder ||
      pending.fromHead !== running.worktree.baseHead ||
      (initialCheckpoint.head !== pending.fromHead && initialCheckpoint.head !== pending.toHead)
    ) {
      throw new Error("coordinator source refresh intent is inconsistent with the owned lease");
    }
    if (initialCheckpoint.head === pending.toHead) {
      const { pendingSourceRefresh: _pending, ...settled } = running;
      currentRecord = {
        ...settled,
        worktree: { ...running.worktree, baseHead: pending.toHead },
      };
      await saveCoordinatorRecord(input.home, currentRecord);
    }
  } else if (initialCheckpoint.head !== running.worktree.baseHead) {
    throw new Error(
      `coordinator source HEAD ${initialCheckpoint.head} does not match recorded lease base ${running.worktree.baseHead}`,
    );
  }
  const currentHead = currentRecord.worktree.baseHead;
  if (initialCheckpoint.head !== currentHead) {
    throw new Error("coordinator source refresh intent did not reconcile the observed checkout");
  }
  if (currentHead !== source.head) {
    const pendingSourceRefresh = {
      leaseId: currentRecord.worktree.leaseId,
      leaseHolder: currentRecord.worktree.leaseHolder,
      fromHead: currentHead,
      toHead: source.head,
    };
    await saveCoordinatorRecord(input.home, { ...currentRecord, pendingSourceRefresh });
    const switched = await input.run({
      argv: [
        "git",
        "-C",
        worktreePath,
        "switch",
        "--no-overwrite-ignore",
        "-C",
        currentRecord.worktree.branch,
        source.head,
      ],
      cwd: worktreePath,
    });
    if (switched.code !== 0) {
      const detail = switched.stderr.trim() || switched.stdout.trim();
      throw new Error(
        `coordinator source refresh failed${detail ? `: ${detail}` : ` with exit code ${switched.code}`}`,
      );
    }
  }
  const verified = await readCheckpoint(input.run, { repo: worktreePath });
  if (verified.dirty || verified.unmerged || verified.head !== source.head) {
    throw new Error(
      `coordinator source ${JSON.stringify(worktreePath)} failed refresh verification`,
    );
  }
  if (
    currentRecord.worktree.baseHead !== source.head ||
    currentRecord.pendingSourceRefresh !== undefined
  ) {
    const { pendingSourceRefresh: _pending, ...settled } = currentRecord;
    await saveCoordinatorRecord(input.home, {
      ...settled,
      worktree: { ...currentRecord.worktree, baseHead: source.head },
    });
  }
  return {
    ...source,
    previousHead: initialCheckpoint.head,
    changed: initialCheckpoint.head !== source.head,
  };
}

/** Refresh at a safe boundary; caller must hold the coordinator launch lock. */
export async function refreshCoordinatorSourceUnlocked(
  input: CoordinatorSourceRefreshInput,
): Promise<CoordinatorSourceRefreshResult> {
  const source = await resolveCoordinatorSourceHead(input.run, input.repoPath);
  return refreshOwnedCheckout(input, source);
}

/** Refresh only the currently running, proven-owned coordinator checkout at a safe boundary. */
export async function refreshCoordinatorSource(
  input: CoordinatorSourceRefreshInput,
): Promise<CoordinatorSourceRefreshResult> {
  return withCoordinatorLaunchLock(input.home, input.sessionId, () =>
    refreshCoordinatorSourceUnlocked(input),
  );
}
