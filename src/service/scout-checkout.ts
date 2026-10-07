import { lstat } from "node:fs/promises";
import type { CommandRunner } from "../contracts.ts";
import { describeError, isMissing } from "./records.ts";

/** The scout checkout as it was observed, without interpreting it. */
export type ScoutCheckoutObservation =
  | Readonly<{
      readonly status: "observed";
      readonly head: string;
      readonly branch: string;
      readonly dirty: boolean;
      readonly unmerged: boolean;
    }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{ readonly status: "unreadable"; readonly detail: string }>;

/** Reads a scout worktree's identity and cleanliness without judging or changing it. */
export async function observeScoutCheckout(
  run: CommandRunner,
  worktreePath: string,
): Promise<ScoutCheckoutObservation> {
  try {
    const details = await lstat(worktreePath);
    if (!details.isDirectory()) {
      return { status: "unreadable", detail: "the recorded lease path is not a directory" };
    }
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    return { status: "unreadable", detail: describeError(error) };
  }
  try {
    const head = await gitText(run, worktreePath, ["rev-parse", "HEAD"], "git scout HEAD");
    const branch = await gitText(
      run,
      worktreePath,
      ["branch", "--show-current"],
      "git scout branch",
    );
    const status = await gitText(
      run,
      worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "git scout status",
    );
    const unmerged = await gitText(
      run,
      worktreePath,
      ["diff", "--name-only", "--diff-filter=U"],
      "git scout unmerged check",
    );
    if (head.length === 0) {
      return { status: "unreadable", detail: "git reported no HEAD commit" };
    }
    return {
      status: "observed",
      head,
      branch,
      dirty: status.length !== 0,
      unmerged: unmerged.length !== 0,
    };
  } catch (error) {
    return { status: "unreadable", detail: describeError(error) };
  }
}

async function gitText(
  run: CommandRunner,
  worktreePath: string,
  args: readonly string[],
  operation: string,
): Promise<string> {
  const result = await run({ argv: ["git", "-C", worktreePath, ...args], cwd: worktreePath });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${operation} failed with exit code ${result.code}${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout.trim();
}
