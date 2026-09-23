import { expect, test } from "bun:test";
import type { PullRequestMetadata } from "../../src/contracts.ts";
import { containerRefs } from "../../src/service/superseded.ts";

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
