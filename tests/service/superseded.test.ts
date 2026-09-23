import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import type { PullRequestMetadata, WorktreeLease } from "../../src/contracts.ts";
import {
  containerRefs,
  observeWorktreeContainment,
  recheckSuperseded,
} from "../../src/service/superseded.ts";

const pr = (overrides: Partial<PullRequestMetadata>): PullRequestMetadata => ({
  repository: "owner/repo",
  number: 1364,
  state: "open",
  head: "tandem/follow-up",
  base: "main",
  ...overrides,
});

test("containers are recorded PR heads and other tasks' branches, never closed PRs or itself", () => {
  const task = { id: "cancelled-1", repoPath: "/repo" };
  const refs = containerRefs(task, "tandem/cancelled-1", [
    {
      task: { ...task, pullRequest: pr({ head: "tandem/cancelled-1" }) },
      branch: "tandem/cancelled-1",
    },
    {
      task: { id: "e2c0fbb5-ready", repoPath: "/repo", pullRequest: pr({}) },
      branch: "tandem/follow-up",
    },
    {
      task: {
        id: "closed-pr",
        repoPath: "/repo",
        pullRequest: pr({ number: 7, state: "closed", head: "a".repeat(40) }),
      },
      branch: undefined,
    },
    {
      task: {
        id: "merged-pr",
        repoPath: "/repo",
        pullRequest: pr({ number: 9, state: "merged", head: "b".repeat(40) }),
      },
      branch: undefined,
    },
    { task: { id: "elsewhere", repoPath: "/other" }, branch: "tandem/elsewhere" },
  ]);
  expect(refs).toEqual([
    { ref: "refs/remotes/origin/tandem/cancelled-1", label: "PR #1364" },
    { ref: "refs/heads/tandem/follow-up", label: "PR #1364" },
    { ref: "refs/remotes/origin/tandem/follow-up", label: "PR #1364" },
    { ref: "b".repeat(40), label: "PR #9" },
  ]);
});

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ argv: ["git", ...args], cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function commit(cwd: string, file: string, text: string): Promise<void> {
  await writeFile(join(cwd, file), text);
  await sh(cwd, "add", file);
  await sh(cwd, "commit", "-q", "-m", `change ${file}`);
}

/**
 * A real repository: `main` checked out in the primary folder, the other task's branch `other`,
 * and the cancelled task's branch `task` checked out in its own worktree, shaped by `build`.
 */
async function withRepo(
  build: (repo: string) => Promise<void>,
  check: (repo: string, lease: WorktreeLease) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-superseded-")));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    await sh(repo, "init", "-q", "-b", "main");
    await sh(repo, "config", "user.email", "test@example.com");
    await sh(repo, "config", "user.name", "Test");
    await commit(repo, "base.txt", "base\n");
    await build(repo);
    await sh(repo, "switch", "-q", "main");
    const path = join(root, "task-worktree");
    await sh(repo, "worktree", "add", "-q", path, "task");
    await check(repo, {
      root,
      path,
      name: "task",
      baseHead: await sh(repo, "rev-parse", "main"),
      branch: "task",
      leaseId: "lease-task",
      leaseHolder: "tandem:task",
      leasedAt: "2030-01-01T00:00:00.000Z",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const OTHER = [{ ref: "refs/heads/other", label: "task e2c0fbb5" }];

test("a cancelled attempt whose changes were rebased into another task is carried by it", async () => {
  await withRepo(
    async (repo) => {
      await sh(repo, "switch", "-q", "-c", "task");
      await commit(repo, "a.txt", "a\n");
      await commit(repo, "b.txt", "b\n");
      await sh(repo, "switch", "-q", "main");
      await commit(repo, "main.txt", "main moved on\n");
      await sh(repo, "switch", "-q", "-c", "other");
      await sh(repo, "cherry-pick", "main..task");
      await commit(repo, "c.txt", "the later attempt added more\n");
    },
    async (repo, lease) => {
      const found = await observeWorktreeContainment(runCommand, repo, lease, OTHER);
      expect(found).toEqual({
        kind: "superseded",
        proof: {
          head: await sh(lease.path, "rev-parse", "HEAD"),
          label: "task e2c0fbb5 (same changes, rebased)",
        },
      });
      if (found.kind !== "superseded") return;
      expect(await recheckSuperseded(runCommand, repo, lease, found.proof, OTHER)).toBeUndefined();
      await commit(lease.path, "late.txt", "a commit after the check\n");
      expect(await recheckSuperseded(runCommand, repo, lease, found.proof, OTHER)).toBe(
        "the worktree has new commits since it was checked",
      );
    },
  );
});

test("an attempt that only merged main into another task's work is carried by that task", async () => {
  await withRepo(
    async (repo) => {
      await sh(repo, "switch", "-q", "-c", "other");
      await commit(repo, "other.txt", "the other task's work\n");
      await sh(repo, "switch", "-q", "-c", "task");
      await sh(repo, "switch", "-q", "main");
      await commit(repo, "main.txt", "a commit from main\n");
      await sh(repo, "switch", "-q", "task");
      await sh(repo, "merge", "-q", "--no-edit", "main");
    },
    async (repo, lease) => {
      const found = await observeWorktreeContainment(runCommand, repo, lease, OTHER);
      expect(found.kind === "superseded" && found.proof.label).toBe("task e2c0fbb5");
    },
  );
});

test("an attempt with its own commit, or with uncommitted changes, is kept", async () => {
  await withRepo(
    async (repo) => {
      await sh(repo, "switch", "-q", "-c", "other");
      await commit(repo, "other.txt", "the other task's work\n");
      await sh(repo, "switch", "-q", "-c", "task");
      await commit(repo, "only-here.txt", "found nowhere else\n");
    },
    async (repo, lease) => {
      expect(await observeWorktreeContainment(runCommand, repo, lease, OTHER)).toEqual({
        kind: "kept",
        reason: "has 1 commit not in main or any other work",
      });
      await sh(lease.path, "reset", "-q", "--hard", "HEAD~1");
      expect((await observeWorktreeContainment(runCommand, repo, lease, OTHER)).kind).toBe(
        "superseded",
      );
      await writeFile(join(lease.path, "draft.txt"), "not committed\n");
      expect(await observeWorktreeContainment(runCommand, repo, lease, OTHER)).toEqual({
        kind: "kept",
        reason: "has uncommitted changes",
      });
    },
  );
});
