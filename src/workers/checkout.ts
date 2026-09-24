import { type GitCheckpoint, readCheckpoint } from "../adapters/git.ts";
import type { CommandRunner } from "../contracts.ts";
import type { DurableJob, RuntimeTaskState } from "../runtime/schema.ts";

export type CurrentCheckout = Readonly<{
  readonly checkpoint: GitCheckpoint;
  readonly expectedHead: string;
}>;

/** Whether the checkout has no uncommitted or unmerged changes. */
export function isClean(checkpoint: GitCheckpoint): boolean {
  return !checkpoint.dirty && !checkpoint.unmerged;
}

/** Whether the checkout is clean and sits exactly at `head`. */
export function isCleanAt(checkpoint: GitCheckpoint, head: string | undefined): boolean {
  return isClean(checkpoint) && checkpoint.head === head;
}

/** Reads a worker's checkout, diffed against its worktree base when one is recorded. */
export async function readWorkerCheckout(
  run: CommandRunner,
  runtime: RuntimeTaskState,
  job: Pick<DurableJob, "cwd" | "head">,
): Promise<CurrentCheckout> {
  const expectedHead = job.head ?? runtime.worktree?.baseHead;
  if (expectedHead === undefined) throw new Error("worker checkout has no expected HEAD");
  const checkpoint =
    runtime.worktree?.baseHead === undefined
      ? await readCheckpoint(run, { repo: job.cwd })
      : await readCheckpoint(run, { repo: job.cwd, baseRef: runtime.worktree.baseHead });
  return { checkpoint, expectedHead };
}

/**
 * Throws unless the source checkout still matches the one captured at task creation. A managed
 * coordinator source may advance its HEAD cleanly; dirty or unmerged state is never accepted.
 */
export function assertSourceUnchanged(
  pinned: GitCheckpoint,
  current: GitCheckpoint,
  allowManagedHeadAdvance = false,
): void {
  if (
    (allowManagedHeadAdvance || pinned.head === current.head) &&
    pinned.dirty === current.dirty &&
    pinned.unmerged === current.unmerged &&
    isClean(current)
  ) {
    return;
  }
  const reasons = [
    !allowManagedHeadAdvance && pinned.head !== current.head
      ? `HEAD changed from ${pinned.head} to ${current.head}`
      : undefined,
    current.dirty
      ? "current worktree is dirty"
      : pinned.dirty !== current.dirty
        ? `dirty state changed from ${String(pinned.dirty)} to ${String(current.dirty)}`
        : undefined,
    current.unmerged
      ? "current checkout has unmerged paths"
      : pinned.unmerged !== current.unmerged
        ? `unmerged state changed from ${String(pinned.unmerged)} to ${String(current.unmerged)}`
        : undefined,
  ].filter((reason): reason is string => reason !== undefined);
  throw new Error(`source checkpoint is unsafe: ${reasons.join("; ")}`);
}
