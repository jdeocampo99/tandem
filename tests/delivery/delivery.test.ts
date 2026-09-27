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
import {
  assertDraftTaskShape,
  assertTaskShape,
  describeTaskDraftPr,
  describeTaskPr,
  type PrSummary,
} from "../../src/delivery/evidence.ts";
import {
  mergeReviewedTask,
  publishReviewedTask,
  publishTaskDraft,
  refreshTaskDraft,
} from "../../src/delivery/pull-requests.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";

const models: Readonly<
  Record<"coordinator" | "scout" | "implementer" | "reviewer" | "presentation", ModelSpec>
> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
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
  setupCommands: [],
  maxFixRounds: 3,
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
    reviews: [review("review", reviewedHead)],
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

test("lists the known issues review did not block on", () => {
  const withKnownIssue: TaskRecord = {
    ...task(),
    findingLedger: [
      {
        id: "f-2",
        lens: "review",
        severity: "P2",
        verdict: "confirmed",
        description:
          "Label says Back. The mobile header renders it next to the close icon, so users see two exits.",
        file: "src/back.tsx",
        status: "unresolved",
        raisedAt: { head: "head-1", generation: 0, reviewRound: 0 },
        statusAt: { head: "head-1", generation: 0, reviewRound: 0 },
      },
    ],
  };
  expect(describeTaskPr(withKnownIssue, summary)).toContain(
    "# Known issues\nReview findings still open. Judge them before merging.\n- P2: Label says Back. (src/back.tsx)",
  );
  expect(describeTaskPr(task(), summary)).not.toContain("# Known issues");
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

test("a task in another repository refuses to publish when its checkout's origin is a fork", async () => {
  const runner = publishRunner();
  const target = { repo: "upstream/repo", checkout: "/tmp/upstream", branch: "main" };
  await expect(
    publishReviewedTask({
      task: { ...task(), target },
      summary,
      title: "Reviewed delivery",
      base: "main",
      approved: true,
      run: runner.run,
    }),
  ).rejects.toThrow("origin is acme/repo, not upstream/repo");
  expect(runner.calls.some((call) => call.argv.includes("push"))).toBe(false);
});

test("publishes the exact task branch only after identity checks and avoids duplicate pull requests", async () => {
  const runner = publishRunner();
  const published = await publishReviewedTask({
    task: task(),
    summary,
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

test("publishing a task whose draft is open marks that draft ready instead of opening another", async () => {
  const calls: CommandRequest[] = [];
  let draft = true;
  const pullRequest = {
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    headRefName: "tandem/delivery-task",
    headRefOid: "head-1",
    baseRefName: "main",
    title: "Reviewed delivery",
  };
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const argv = request.argv;
    if (argv[0] === "git" && argv.includes("rev-parse")) return result("head-1\n");
    if (argv[0] === "git" && argv.includes("symbolic-ref")) return result("tandem/delivery-task\n");
    if (argv[0] === "git" && argv.includes("remote"))
      return result("git@github.com:acme/repo.git\n");
    if (argv[0] === "git") return result();
    if (argv[1] === "pr" && argv[2] === "list") {
      return result(JSON.stringify([{ ...pullRequest, state: "OPEN", isDraft: draft }]));
    }
    if (argv[1] === "pr" && argv[2] === "ready") {
      draft = false;
      return result();
    }
    if (argv[1] === "pr" && argv[2] === "view") {
      return result(JSON.stringify({ ...pullRequest, state: "OPEN", isDraft: draft }));
    }
    throw new Error(`unexpected command ${JSON.stringify(argv)}`);
  };
  const published = await publishReviewedTask({
    task: task(),
    summary,
    title: "Reviewed delivery",
    base: "main",
    approved: true,
    run,
  });
  expect(published.state).toBe("open");
  expect(calls.filter((call) => call.argv[0] === "gh").map((call) => call.argv[2])).toEqual([
    "list",
    "ready",
    "view",
  ]);
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

test("rejects a non-GitHub origin before any remote mutation", async () => {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const argv = request.argv;
    if (argv[0] === "git" && argv.includes("status")) return result();
    if (argv[0] === "git" && argv.includes("rev-parse")) return result("head-1\n");
    if (argv[0] === "git" && argv.includes("diff")) return result();
    if (argv[0] === "git" && argv.includes("symbolic-ref")) return result("tandem/delivery-task\n");
    if (argv[0] === "git" && argv.includes("remote"))
      return result("https://gitlab.com/acme/repo.git\n");
    throw new Error(`unexpected command ${JSON.stringify(argv)}`);
  };
  await expect(
    publishReviewedTask({
      task: task(),
      summary,
      title: "Reviewed delivery",
      base: "main",
      approved: true,
      run,
    }),
  ).rejects.toThrow("is not a GitHub repository URL");
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

type DraftTaskOptions = Readonly<{
  readonly stage?: TaskRecord["stage"];
  readonly reviewRound?: number;
  readonly reviews?: readonly ReviewResult[];
  readonly validationEvidence?: readonly PinnedValidationEvidence[];
  readonly pullRequest?: PullRequestMetadata;
  readonly maxFixRounds?: number;
}>;

function draftPolicy(maxFixRounds: number): ResolvedPolicy {
  return {
    config: {
      ...policyConfig,
      maxFixRounds,
      validationCommands: [
        { name: "check", argv: ["bun", "run", "check"], surfaces: ["delivery"], timeoutMs: 60_000 },
        {
          name: "audit",
          argv: ["bun", "run", "audit"],
          surfaces: ["unrelated"],
          timeoutMs: 60_000,
        },
      ],
    },
    guidance: policy.guidance,
  };
}

function draftTask(options: DraftTaskOptions = {}): TaskRecord {
  return {
    ...task(),
    stage: options.stage ?? "implementing",
    policy: draftPolicy(options.maxFixRounds ?? 3),
    reviewRound: options.reviewRound ?? 0,
    reviews: options.reviews ?? [],
    validationEvidence: options.validationEvidence ?? [],
    ...(options.pullRequest === undefined ? {} : { pullRequest: options.pullRequest }),
  };
}

const draftMetadata: PullRequestMetadata = {
  repository: "acme/repo",
  number: 11,
  url: "https://github.com/acme/repo/pull/11",
  title: "Draft: deliver the reviewed change",
  state: "draft",
  head: "head-1",
  base: "main",
};

function draftRemotePullRequest(isDraft: boolean): Record<string, unknown> {
  return {
    number: 11,
    url: "https://github.com/acme/repo/pull/11",
    state: "OPEN",
    isDraft,
    headRefName: "tandem/delivery-task",
    headRefOid: "head-1",
    baseRefName: "main",
    title: "Draft: deliver the reviewed change",
  };
}

type DraftRunnerOptions = Readonly<{
  /** Pull requests the remote reports for the task branch, one entry per observation. */
  readonly listResponses?: readonly (readonly Record<string, unknown>[])[];
  readonly createFails?: boolean;
  readonly pushFails?: boolean;
}>;

function draftRunner(options: DraftRunnerOptions = {}): Readonly<{
  readonly calls: CommandRequest[];
  readonly run: CommandRunner;
}> {
  const calls: CommandRequest[] = [];
  const listResponses = options.listResponses ?? [[]];
  let listIndex = 0;
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
      if (options.pushFails === true) return result("", 1, "non-fast-forward");
      return result();
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") {
      const response = listResponses[Math.min(listIndex, listResponses.length - 1)] ?? [];
      listIndex += 1;
      return result(JSON.stringify(response));
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
      if (options.createFails === true) return result("", 1, "remote outcome is unknown");
      return result("https://github.com/acme/repo/pull/11\n");
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "edit") return result();
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") {
      return result(JSON.stringify(draftRemotePullRequest(true)));
    }
    throw new Error(`unexpected command ${JSON.stringify(argv)}`);
  };
  return { calls, run };
}

test("a draft refuses publication without explicit publishing approval even when scope is approved", async () => {
  const runner = draftRunner();
  const scopeApproved = draftTask();
  expect(scopeApproved.scopeApproved).toBe(true);
  await expect(
    publishTaskDraft({
      task: scopeApproved,
      title: "Draft: deliver the reviewed change",
      base: "main",
      approved: false,
      run: runner.run,
    }),
  ).rejects.toBeInstanceOf(ApprovalRequiredError);
  expect(runner.calls).toHaveLength(0);
});

test("a draft body reports review level, activity, blockers, and remaining checks", () => {
  const body = describeTaskDraftPr({
    task: draftTask({
      stage: "awaiting-fixes",
      reviewRound: 3,
      maxFixRounds: 3,
      reviews: [
        {
          lens: "behavior",
          head: "head-1",
          generation: 0,
          pass: false,
          findings: [
            {
              id: "F-1",
              severity: "P1",
              verdict: "confirmed",
              description: "ordering regression on retry",
            },
          ],
          summary: "behavior findings",
        },
      ],
      validationEvidence: [evidence()],
    }),
    publishedHead: "head-1",
    worktreeHead: "head-1",
    uncommittedChanges: true,
  });

  expect(body).toContain(
    "it is not a claim that the work is ready, mergeable, deployable, or accepted",
  );
  expect(body).toContain("Review level: standard.");
  expect(body).toContain("no review level is recorded for this task");
  expect(body).toContain("the pinned repository policy requires review at final acceptance");
  expect(body).toContain("at most 3 bounded fix round(s)");
  expect(body).toContain("# Current activity");
  expect(body).toContain("fix round 3 of 3 has been used");
  expect(body).toContain("The bounded fix-round loop is exhausted at 3 of 3");
  expect(body).toContain("F-1/P1: ordering regression on retry");
  expect(body).toContain("uncommitted changes that are not part of this draft");
  expect(body).toContain("A passing review by a fresh independent read-only reviewer");
  expect(body).toContain("Runner-owned required GitHub checks");
  expect(body).toContain("remain separate explicit approvals");
  expect(body).toContain("Final acceptance requirement check (local check)");
  expect(body).not.toContain("audit");
});

test("a draft shows the task's recorded review level and its reason", () => {
  const body = describeTaskDraftPr({
    task: {
      ...draftTask({ stage: "reviewing" }),
      reviewLevel: {
        level: "standard",
        reason: "it changes package.json, so P0 and P1 findings block",
      },
    },
    publishedHead: "head-1",
    worktreeHead: "head-1",
    uncommittedChanges: false,
  });

  expect(body).toContain("Review level: standard.");
  expect(body).toContain("Reason: it changes package.json, so P0 and P1 findings block");
  expect(body).toContain("Whatever the level, the pinned repository policy requires");
});

test("a ready task's draft still refuses to claim acceptance", () => {
  const body = describeTaskDraftPr({
    task: draftTask({
      stage: "ready",
      reviews: [review("review")],
      validationEvidence: [evidence()],
    }),
    publishedHead: "head-1",
    worktreeHead: "head-1",
    uncommittedChanges: false,
  });

  expect(body).toContain("Delivery acceptance is still a separate explicit step.");
  expect(body).toContain("Runner-owned required GitHub checks on the delivered commit.");
  expect(body).toContain("Tandem never merges a draft");
  expect(body).toContain("- None recorded in durable task state.");
  expect(body).not.toContain("A passing behavior review");
});

test("a draft is created marked unfinished at the pushed task HEAD", async () => {
  const runner = draftRunner();
  const publication = await publishTaskDraft({
    task: draftTask(),
    title: "Draft: deliver the reviewed change",
    base: "main",
    approved: true,
    run: runner.run,
  });

  expect(publication).toEqual({
    pullRequest: draftMetadata,
    created: true,
    branchAdvanced: true,
  });
  expect(runner.calls.find((call) => call.argv[2] === "create")?.argv).toContain("--draft");
  expect(runner.calls.find((call) => call.argv.includes("push"))?.argv.at(-1)).toBe(
    "head-1:refs/heads/tandem/delivery-task",
  );
  expect(runner.calls.some((call) => call.argv.includes("--force"))).toBe(false);
  expect(runner.calls.some((call) => call.argv[2] === "merge")).toBe(false);
});

test("a second draft publication updates the same pull request instead of creating another", async () => {
  const runner = draftRunner({ listResponses: [[draftRemotePullRequest(true)]] });
  const publication = await publishTaskDraft({
    task: draftTask({ stage: "reviewing", pullRequest: draftMetadata }),
    title: "Draft: deliver the reviewed change",
    base: "main",
    approved: true,
    run: runner.run,
  });

  expect(publication.created).toBe(false);
  expect(publication.pullRequest.number).toBe(11);
  expect(runner.calls.some((call) => call.argv[2] === "create")).toBe(false);
  expect(runner.calls.find((call) => call.argv[2] === "edit")?.argv.slice(0, 6)).toEqual([
    "gh",
    "pr",
    "edit",
    "11",
    "--repo",
    "acme/repo",
  ]);
});

test("an uncertain create is reconciled to the observed pull request rather than retried", async () => {
  const runner = draftRunner({
    createFails: true,
    listResponses: [[], [], [draftRemotePullRequest(true)]],
  });
  const publication = await publishTaskDraft({
    task: draftTask(),
    title: "Draft: deliver the reviewed change",
    base: "main",
    approved: true,
    run: runner.run,
  });

  expect(publication.created).toBe(false);
  expect(publication.pullRequest.number).toBe(11);
  expect(runner.calls.filter((call) => call.argv[2] === "create")).toHaveLength(1);
});

test("an uncertain create with no observable pull request fails closed without a second create", async () => {
  const runner = draftRunner({ createFails: true });
  await expect(
    publishTaskDraft({
      task: draftTask(),
      title: "Draft: deliver the reviewed change",
      base: "main",
      approved: true,
      run: runner.run,
    }),
  ).rejects.toThrow();
  expect(runner.calls.filter((call) => call.argv[2] === "create")).toHaveLength(1);
});

test("a retry after an unreconciled create observes the remote first and never creates twice", async () => {
  const runner = draftRunner({
    createFails: true,
    listResponses: [[], [], [], [draftRemotePullRequest(true)]],
  });
  const request = {
    task: draftTask(),
    title: "Draft: deliver the reviewed change",
    base: "main",
    approved: true,
    run: runner.run,
  } as const;

  await expect(publishTaskDraft(request)).rejects.toThrow();
  const createsBeforeRetry = runner.calls.filter((call) => call.argv[2] === "create").length;
  expect(createsBeforeRetry).toBe(1);

  const retryFrom = runner.calls.length;
  const retry = await publishTaskDraft(request);
  expect(retry.created).toBe(false);
  expect(retry.pullRequest.number).toBe(11);
  expect(runner.calls.filter((call) => call.argv[2] === "create")).toHaveLength(1);
  const retryCalls = runner.calls.slice(retryFrom).filter((call) => call.argv[0] === "gh");
  expect(retryCalls[0]?.argv[2]).toBe("list");
  expect(retryCalls.some((call) => call.argv[2] === "create")).toBe(false);
});

test("a refused branch push leaves the published commit alone and discloses the lag", async () => {
  const runner = draftRunner({
    pushFails: true,
    listResponses: [[{ ...draftRemotePullRequest(true), headRefOid: "head-0" }]],
  });
  const publication = await publishTaskDraft({
    task: draftTask({ pullRequest: draftMetadata }),
    title: "Draft: deliver the reviewed change",
    base: "main",
    approved: true,
    run: runner.run,
  });

  expect(publication.branchAdvanced).toBe(false);
  const body = runner.calls.find((call) => call.argv[2] === "edit")?.argv.at(-1) ?? "";
  expect(body).toContain("Draft commit: head-0");
  expect(body).toContain("the branch could not be advanced");
  expect(runner.calls.some((call) => call.argv.includes("--force"))).toBe(false);
});

test("refreshing an approved draft never creates one and stops once it is no longer a draft", async () => {
  const current = draftRunner({ listResponses: [[draftRemotePullRequest(true)]] });
  const refreshed = await refreshTaskDraft({
    task: draftTask({ stage: "reviewing", pullRequest: draftMetadata }),
    run: current.run,
  });
  expect(refreshed?.created).toBe(false);
  expect(current.calls.some((call) => call.argv[2] === "create")).toBe(false);

  const promoted = draftRunner({ listResponses: [[draftRemotePullRequest(false)]] });
  expect(
    await refreshTaskDraft({
      task: draftTask({ stage: "reviewing", pullRequest: draftMetadata }),
      run: promoted.run,
    }),
  ).toBeUndefined();
  expect(promoted.calls.some((call) => call.argv[2] === "edit")).toBe(false);
  expect(promoted.calls.some((call) => call.argv[2] === "create")).toBe(false);

  const undrafted = draftRunner();
  expect(await refreshTaskDraft({ task: draftTask(), run: undrafted.run })).toBeUndefined();
  expect(undrafted.calls).toHaveLength(0);
});

test("draft eligibility never satisfies delivery acceptance", async () => {
  const unfinished = draftTask({ stage: "implementing", pullRequest: draftMetadata });
  expect(() => assertDraftTaskShape(unfinished)).not.toThrow();
  expect(() => assertTaskShape(unfinished)).toThrow("is not ready for delivery");

  const runner = draftRunner();
  await expect(
    publishReviewedTask({
      task: unfinished,
      summary,
      title: "Reviewed delivery",
      base: "main",
      approved: true,
      run: runner.run,
    }),
  ).rejects.toThrow("is not ready for delivery");
  expect(runner.calls).toHaveLength(0);

  expect(() => assertDraftTaskShape({ ...draftTask(), kind: "scout" })).toThrow(
    "is not an implementation task",
  );
  expect(() => assertDraftTaskShape({ ...draftTask(), stage: "queued" })).toThrow(
    "has no draft-eligible work",
  );
  expect(() => assertDraftTaskShape({ ...draftTask(), scopeApproved: false })).toThrow(
    "has not received scope approval",
  );
});
