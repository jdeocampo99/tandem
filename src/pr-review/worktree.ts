import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readGitText, runChecked } from "../adapters/primitives.ts";
import type { CommandRunner } from "../contracts.ts";
import type { PullRequestRef } from "./pull-request.ts";

/** A detached worktree at the PR head, created from the user's own checkout. */
export type ReviewWorktree = Readonly<{
  checkout: string;
  path: string;
  head: string;
  mergeBase: string;
}>;

export type PrepareWorktreeInput = Readonly<{
  checkout: string;
  remote: string;
  ref: PullRequestRef;
  baseRef: string;
  path: string;
}>;

/**
 * Fetches the PR head and base into Tandem-owned refs, so the user's branches, remote-tracking refs,
 * and FETCH_HEAD are untouched, then adds a detached worktree at the head.
 * `refs/pull/N/head` exists on the base repository even when the PR comes from a fork.
 */
export async function prepareReviewWorktree(
  run: CommandRunner,
  input: PrepareWorktreeInput,
): Promise<ReviewWorktree> {
  const { checkout, path } = input;
  const { head, mergeBase } = await fetchPullRequest(run, checkout, input);
  await mkdir(dirname(path), { recursive: true });
  await git(run, checkout, ["worktree", "add", "--detach", path, head]);
  return { checkout, path, head, mergeBase };
}

/**
 * Moves an existing review worktree to the PR's current head for a re-review. The new merge base is
 * taken against the base branch as it is now.
 */
export async function refreshReviewWorktree(
  run: CommandRunner,
  worktree: ReviewWorktree,
  input: Omit<PrepareWorktreeInput, "checkout" | "path">,
): Promise<ReviewWorktree> {
  const { head, mergeBase } = await fetchPullRequest(run, worktree.checkout, input);
  await git(run, worktree.path, ["checkout", "--detach", "--quiet", head]);
  return { ...worktree, head, mergeBase };
}

/** True when `from` is still in the PR's history, i.e. the author did not rebase or force-push. */
export async function isAncestor(
  run: CommandRunner,
  worktree: ReviewWorktree,
  from: string,
): Promise<boolean> {
  const result = await run({
    argv: ["git", "-C", worktree.checkout, "merge-base", "--is-ancestor", from, worktree.head],
    cwd: worktree.checkout,
  });
  return result.code === 0;
}

/** Removes only this review's worktree and the refs it fetched; the checkout is otherwise untouched. */
export async function removeReviewWorktree(
  run: CommandRunner,
  worktree: Pick<ReviewWorktree, "checkout" | "path">,
  ref: PullRequestRef,
): Promise<void> {
  const refs = reviewRefs(ref);
  await run({
    argv: ["git", "-C", worktree.checkout, "worktree", "remove", "--force", worktree.path],
    cwd: worktree.checkout,
  });
  for (const name of [refs.head, refs.base]) {
    await run({
      argv: ["git", "-C", worktree.checkout, "update-ref", "-d", name],
      cwd: worktree.checkout,
    });
  }
}

async function fetchPullRequest(
  run: CommandRunner,
  checkout: string,
  input: Omit<PrepareWorktreeInput, "checkout" | "path">,
): Promise<Readonly<{ head: string; mergeBase: string }>> {
  const refs = reviewRefs(input.ref);
  await git(run, checkout, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    input.remote,
    `+refs/pull/${input.ref.number}/head:${refs.head}`,
    `+refs/heads/${input.baseRef}:${refs.base}`,
  ]);
  const head = await readGitText(run, checkout, ["rev-parse", refs.head], "PR head");
  const mergeBase = await readGitText(
    run,
    checkout,
    ["merge-base", refs.head, refs.base],
    "PR merge base",
  );
  return { head, mergeBase };
}

function reviewRefs(ref: PullRequestRef): Readonly<{ head: string; base: string }> {
  const prefix = `refs/tandem/pr-review/${ref.number}`;
  return { head: `${prefix}/head`, base: `${prefix}/base` };
}

async function git(run: CommandRunner, cwd: string, args: readonly string[]): Promise<void> {
  await runChecked(run, { argv: ["git", "-C", cwd, ...args], cwd }, `git ${args[0] ?? ""}`);
}
