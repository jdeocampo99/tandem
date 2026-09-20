import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/commands.ts";
import { ApprovalRequiredError } from "../../src/adapters/primitives.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  ModelSpec,
  PinnedValidationEvidence,
  PullRequestMetadata,
  RepoPolicy,
  ResolvedPolicy,
  ReviewLens,
  ReviewResult,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import { describeTaskPr, type PrSummary } from "../../src/delivery/evidence.ts";
import { mergeReviewedTask, publishReviewedTask } from "../../src/delivery/pull-requests.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";

const models: Readonly<
  Record<
    "coordinator" | "scout" | "implementer" | "reviewer" | "verifier" | "presentation",
    ModelSpec
  >
> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  verifier: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

const policyConfig: RepoPolicy = {
  version: 1,
  models,
  instructions: { implementation: [], validation: [], review: [] },
  instructionFiles: { implementation: [], validation: [], review: [] },
  validationCommands: [
    { name: "check", argv: ["bun", "run", "check"], surfaces: ["delivery"], timeoutMs: 10_000 },
  ],
  maxWorkers: 3,
  maxFixRounds: 3,
  reviewLevels: {
    reducedRouting: false,
    deepScrutiny: false,
    jevAssistance: "off",
    sourceTransmission: false,
  },
};

const policy: ResolvedPolicy = {
  config: policyConfig,
  guidance: { implementation: [], validation: [], review: [] },
};

const summary: PrSummary = {
  tldr: ["Keeps reviewed delivery explicit."],
  what: ["Publishes only the reviewed task branch."],
  why: ["Reviewers need immutable evidence."],
};

const lease: WorktreeLease = {
  root: "/tmp/treehouse",
  path: "/tmp/task-worktree",
  name: "delivery-task",
  baseHead: "base-1",
  branch: "tandem/delivery-task",
  leaseId: "lease-1",
  leaseHolder: "tandem-1",
  leasedAt: "2030-01-02T03:04:05.000Z",
};

function review(lens: ReviewLens, reviewedHead = "head-1"): ReviewResult {
  return {
    lens,
    head: reviewedHead,
    generation: 0,
    pass: true,
    findings: [],
    summary: `${lens} passed`,
  };
}

function evidence(reviewedHead = "head-1"): PinnedValidationEvidence {
  return {
    name: "check",
    argv: ["bun", "run", "check"],
    exitCode: 0,
    stdout: "56 tests passed",
    stderr: "",
    head: reviewedHead,
    contract: "final",
    origin: "local",
    policyDigest: policyIdentity(policy),
  };
}

type TaskFixtureOptions = Readonly<{
  readonly reviewedHead?: string;
  readonly worktree?: WorktreeLease;
}>;

function task(withPullRequest = false, options: TaskFixtureOptions = {}): TaskRecord {
  const reviewedHead = options.reviewedHead ?? "head-1";
  const worktree = options.worktree ?? lease;
  const pullRequest: PullRequestMetadata = {
    repository: "acme/repo",
    number: 7,
    state: "open",
    head: reviewedHead,
    base: "main",
  };
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 8,
    repoPath: "/tmp/source-repo",
    kind: "implementation",
    objective: "Deliver the reviewed change",
    acceptanceCriteria: ["The reviewed branch is delivered."],
    surfaces: ["delivery"],
    stage: "ready",
    scopeApproved: true,
    policy,
    createdAt: "2030-01-02T03:04:05.000Z",
    updatedAt: "2030-01-02T03:04:05.000Z",
    worktree,
    generation: 0,
    reviewRound: 0,
    reviewHead: reviewedHead,
    validationEvidence: [evidence(reviewedHead)],
    reviews: [
      review("behavior", reviewedHead),
      review("design", reviewedHead),
      review("coverage", reviewedHead),
      review("verification", reviewedHead),
    ],
    notifications: [],
    ...(withPullRequest ? { pullRequest } : {}),
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runCommand({ argv: ["git", "-C", cwd, ...args], cwd });
  if (result.code !== 0) {
    throw new Error(`git fixture command failed: ${JSON.stringify(args)}; ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function readRemoteBranchHead(cwd: string, branch: string): Promise<string> {
  const output = await runGit(cwd, ["ls-remote", "origin", `refs/heads/${branch}`]);
  const head = output.split(/\s+/u)[0];
  if (head === undefined || head.length === 0) {
    throw new Error(`remote branch ${JSON.stringify(branch)} was not advertised`);
  }
  return head;
}

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

function publishRunner(): Readonly<{
  readonly calls: CommandRequest[];
  readonly run: CommandRunner;
}> {
  const calls: CommandRequest[] = [];
  let listCount = 0;
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const argv = request.argv;
    if (argv[0] === "git" && argv.includes("status")) return result();
    if (argv[0] === "git" && argv.includes("rev-parse")) return result("head-1\n");
    if (argv[0] === "git" && argv.includes("diff")) return result();
    if (argv[0] === "git" && argv.includes("symbolic-ref")) return result("tandem/delivery-task\n");
    if (argv[0] === "git" && argv.includes("remote"))
      return result("git@github.com:acme/repo.git\n");
    if (argv[0] === "git" && argv.includes("push")) {
      if (argv.at(-1) !== "head-1:refs/heads/tandem/delivery-task") {
        throw new Error(`mutable delivery push source: ${JSON.stringify(argv)}`);
      }
      return result();
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") {
      listCount += 1;
      return result("[]");
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
      return result("https://github.com/acme/repo/pull/7\n");
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") {
      return result(
        JSON.stringify({
          number: 7,
          url: "https://github.com/acme/repo/pull/7",
          state: "OPEN",
          isDraft: false,
          headRefOid: "head-1",
          baseRefName: "main",
          title: "Reviewed delivery",
        }),
      );
    }
    throw new Error(`unexpected command ${JSON.stringify(argv)} after ${listCount} list calls`);
  };
  return { calls, run };
}

function mergeRunner(
  checks: readonly Record<string, unknown>[],
): Readonly<{ readonly calls: CommandRequest[]; readonly run: CommandRunner }> {
  const calls: CommandRequest[] = [];
  let merged = false;
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const argv = request.argv;
    if (argv[0] === "git" && argv.includes("status")) return result();
    if (argv[0] === "git" && argv.includes("rev-parse")) return result("head-1\n");
    if (argv[0] === "git" && argv.includes("diff")) return result();
    if (argv[0] === "git" && argv.includes("symbolic-ref")) return result("tandem/delivery-task\n");
    if (argv[0] === "git" && argv.includes("remote"))
      return result("https://github.com/acme/repo.git\n");
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") {
      const detailed =
        argv.at(-1) ===
        "number,url,state,isDraft,headRefName,headRefOid,baseRefName,title,statusCheckRollup";
      return result(
        JSON.stringify({
          number: 7,
          url: "https://github.com/acme/repo/pull/7",
          state: merged ? "MERGED" : "OPEN",
          isDraft: false,
          headRefName: "tandem/delivery-task",
          headRefOid: "head-1",
          baseRefName: "main",
          title: "Reviewed delivery",
          ...(detailed ? { statusCheckRollup: checks } : {}),
        }),
      );
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      merged = true;
      return result();
    }
    throw new Error(`unexpected command ${JSON.stringify(argv)}`);
  };
  return { calls, run };
}

test("refuses remote delivery without explicit approval and does not invoke the runner", async () => {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    return result();
  };

  await expect(
    publishReviewedTask({
      task: task(),
      summary,
      repository: "acme/repo",
      title: "Reviewed delivery",
      base: "main",
      approved: false,
      run,
    }),
  ).rejects.toBeInstanceOf(ApprovalRequiredError);
  await expect(
    mergeReviewedTask({ task: task(true), approved: false, method: "squash", run }),
  ).rejects.toBeInstanceOf(ApprovalRequiredError);
  expect(calls).toHaveLength(0);
});

test("renders validation bullets from recorded evidence rather than supplied claims", () => {
  const rendered = describeTaskPr(task(), summary);
  expect(rendered).toContain("check [final contract, local check]: exit code 0");
  expect(rendered).toContain("reviewed HEAD head-1");
  expect(rendered).toContain('argv "bun" "run" "check"');
  expect(rendered).toContain("final acceptance manifest at HEAD head-1");
  expect(rendered).not.toContain("all tests passed by user claim");
});

test("refuses delivery when only targeted iteration checks passed at the reviewed head", () => {
  const iterationOnly: TaskRecord = {
    ...task(),
    validationEvidence: [{ ...evidence(), contract: "iteration" }],
  };
  expect(() => describeTaskPr(iterationOnly, summary)).toThrow(
    /complete final acceptance run at HEAD head-1/u,
  );
});

test("refuses to publish a ready task whose evidence predates validation contracts", () => {
  const {
    contract: _contract,
    origin: _origin,
    policyDigest: _policyDigest,
    ...recorded
  } = evidence();
  const legacyReady: TaskRecord = {
    ...task(),
    validationEvidence: [{ ...recorded, contract: "legacy" }],
  };
  expect(() => describeTaskPr(legacyReady, summary)).toThrow(
    /predates validation contracts and the final acceptance manifest must run again at HEAD head-1/u,
  );
});

test("refuses delivery when final evidence was recorded under a superseded policy identity", () => {
  const superseded: TaskRecord = {
    ...task(),
    validationEvidence: [{ ...evidence(), policyDigest: "superseded-policy" }],
  };
  expect(() => describeTaskPr(superseded, summary)).toThrow(
    /complete final acceptance run at HEAD head-1/u,
  );
});

test("publishes the exact task branch only after identity checks and avoids duplicate pull requests", async () => {
  const runner = publishRunner();
  const published = await publishReviewedTask({
    task: task(),
    summary,
    repository: "acme/repo",
    title: "Reviewed delivery",
    base: "main",
    approved: true,
    run: runner.run,
  });

  expect(published).toEqual({
    repository: "acme/repo",
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    title: "Reviewed delivery",
    state: "open",
    head: "head-1",
    base: "main",
  });
  const push = runner.calls.find((call) => call.argv.includes("push"));
  expect(push?.argv).toEqual([
    "git",
    "-C",
    "/tmp/task-worktree",
    "push",
    "origin",
    "head-1:refs/heads/tandem/delivery-task",
  ]);
  expect(runner.calls.some((call) => call.argv.includes("--force"))).toBe(false);
});

test("publishes only the reviewed SHA when the local task branch advances during PR lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-delivery-race-"));
  try {
    const worktree = join(root, "worktree");
    const remote = join(root, "remote.git");
    const branch = lease.branch;
    await runGit(root, ["init", "--bare", remote]);
    await runGit(root, ["init", worktree]);
    await runGit(worktree, ["config", "user.name", "Tandem Test"]);
    await runGit(worktree, ["config", "user.email", "tandem@example.test"]);
    await runGit(worktree, ["config", "core.hooksPath", "/dev/null"]);
    await runGit(worktree, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(worktree, "reviewed.txt"), "reviewed\n");
    await runGit(worktree, ["add", "reviewed.txt"]);
    await runGit(worktree, ["commit", "-m", "reviewed"]);
    await runGit(worktree, ["branch", "-M", branch]);
    await runGit(worktree, ["remote", "add", "origin", remote]);
    const reviewedHead = await runGit(worktree, ["rev-parse", "HEAD"]);
    await runGit(worktree, ["push", "origin", `${reviewedHead}:refs/heads/${branch}`]);
    await runGit(worktree, ["push", "origin", `${reviewedHead}:refs/heads/unrelated`]);

    let lookupCount = 0;
    let unreviewedHead = "";
    const run: CommandRunner = async (request) => {
      const argv = request.argv;
      if (argv[0] === "git" && argv.includes("remote") && argv.includes("get-url")) {
        return result("git@github.com:acme/repo.git\n");
      }
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") {
        lookupCount += 1;
        if (lookupCount === 1) {
          await writeFile(join(worktree, "reviewed.txt"), "unreviewed\n");
          await runGit(worktree, ["add", "reviewed.txt"]);
          await runGit(worktree, ["commit", "-m", "unreviewed"]);
          unreviewedHead = await runGit(worktree, ["rev-parse", "HEAD"]);
        }
        return result("[]");
      }
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
        return result("https://github.com/acme/repo/pull/7\n");
      }
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") {
        const publishedHead = await readRemoteBranchHead(worktree, branch);
        return result(
          JSON.stringify({
            number: 7,
            url: "https://github.com/acme/repo/pull/7",
            state: "OPEN",
            isDraft: false,
            headRefOid: publishedHead,
            baseRefName: "main",
            title: "Reviewed delivery",
          }),
        );
      }
      if (argv[0] === "gh") throw new Error(`unexpected GitHub command ${JSON.stringify(argv)}`);
      return runCommand(request);
    };

    const publishInput = {
      task: task(false, {
        reviewedHead,
        worktree: { ...lease, path: worktree },
      }),
      summary,
      repository: "acme/repo",
      title: "Reviewed delivery",
      base: "main",
      approved: true,
      run,
    };
    const published = await publishReviewedTask(publishInput);

    expect(published.head).toBe(reviewedHead);
    if (unreviewedHead.length === 0)
      throw new Error("race fixture did not advance the local branch");
    expect(await runGit(worktree, ["rev-parse", "HEAD"])).toBe(unreviewedHead);
    expect(await readRemoteBranchHead(worktree, branch)).toBe(reviewedHead);
    expect(await readRemoteBranchHead(worktree, "unrelated")).toBe(reviewedHead);

    await runGit(worktree, ["push", "origin", `${unreviewedHead}:refs/heads/${branch}`]);
    await runGit(worktree, ["reset", "--hard", reviewedHead]);
    await expect(publishReviewedTask(publishInput)).rejects.toThrow();
    expect(await readRemoteBranchHead(worktree, branch)).toBe(unreviewedHead);
    expect(await readRemoteBranchHead(worktree, "unrelated")).toBe(reviewedHead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a repository identity mismatch before any remote mutation", async () => {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const argv = request.argv;
    if (argv[0] === "git" && argv.includes("status")) return result();
    if (argv[0] === "git" && argv.includes("rev-parse")) return result("head-1\n");
    if (argv[0] === "git" && argv.includes("diff")) return result();
    if (argv[0] === "git" && argv.includes("symbolic-ref")) return result("tandem/delivery-task\n");
    if (argv[0] === "git" && argv.includes("remote"))
      return result("git@github.com:other/repo.git\n");
    throw new Error(`unexpected command ${JSON.stringify(argv)}`);
  };
  await expect(
    publishReviewedTask({
      task: task(),
      summary,
      repository: "acme/repo",
      title: "Reviewed delivery",
      base: "main",
      approved: true,
      run,
    }),
  ).rejects.toThrow("does not match origin");
  expect(calls.some((call) => call.argv.includes("push"))).toBe(false);
  expect(calls.some((call) => call.argv.includes("create"))).toBe(false);
});

test("rejects stale reviewed heads and unsuccessful required CI before merge", async () => {
  const stale = mergeRunner([{ name: "required", status: "COMPLETED", conclusion: "SUCCESS" }]);
  const staleRun: CommandRunner = async (request) => {
    if (request.argv[0] === "git" && request.argv.includes("rev-parse"))
      return result("other-head\n");
    return stale.run(request);
  };
  await expect(
    mergeReviewedTask({ task: task(true), approved: true, method: "squash", run: staleRun }),
  ).rejects.toThrow("does not match reviewed HEAD");

  const failing = mergeRunner([{ name: "required", status: "COMPLETED", conclusion: "FAILURE" }]);
  await expect(
    mergeReviewedTask({ task: task(true), approved: true, method: "squash", run: failing.run }),
  ).rejects.toThrow("required CI is not successful");
  expect(failing.calls.some((call) => call.argv.includes("--match-head-commit"))).toBe(false);
});

test("merges only after nonempty required CI and pins the immutable reviewed SHA", async () => {
  const runner = mergeRunner([
    { name: "required-check", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
  ]);
  const merged = await mergeReviewedTask({
    task: task(true),
    approved: true,
    method: "squash",
    run: runner.run,
  });
  expect(merged.state).toBe("merged");
  const merge = runner.calls.find((call) => call.argv.includes("--match-head-commit"));
  expect(merge?.argv).toEqual([
    "gh",
    "pr",
    "merge",
    "7",
    "--repo",
    "acme/repo",
    "--squash",
    "--match-head-commit",
    "head-1",
  ]);
});
