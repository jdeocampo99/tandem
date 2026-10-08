import { lstat } from "node:fs/promises";
import { readGitText } from "../adapters/primitives.ts";
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
    const head = await readGitText(run, worktreePath, ["rev-parse", "HEAD"], {
      operation: "git scout HEAD",
      allowEmpty: true,
      failure: "plain",
    });
    const branch = await readGitText(run, worktreePath, ["branch", "--show-current"], {
      operation: "git scout branch",
      allowEmpty: true,
      failure: "plain",
    });
    const status = await readGitText(
      run,
      worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        operation: "git scout status",
        allowEmpty: true,
        failure: "plain",
      },
    );
    const unmerged = await readGitText(
      run,
      worktreePath,
      ["diff", "--name-only", "--diff-filter=U"],
      {
        operation: "git scout unmerged check",
        allowEmpty: true,
        failure: "plain",
      },
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
