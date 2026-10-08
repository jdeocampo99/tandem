import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandRequest,
  CommandResult,
  ResolvedPolicy,
  TaskRecord,
} from "../../src/contracts.ts";
import { deliveryPreflight } from "../../src/delivery/preflight.ts";
import { runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { createTaskStore } from "../../src/tasks/store.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const HEAD = "head-1";
const BASE = "base-1";
const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "test/coordinator", thinking: "low" },
      scout: { model: "test/scout", thinking: "low" },
      implementer: { model: "test/implementer", thinking: "low" },
      reviewer: { model: "test/reviewer", thinking: "low" },
      presentation: { model: "test/presentation", thinking: "low" },
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [{ name: "smoke", argv: ["true"], surfaces: ["*"], timeoutMs: 1_000 }],
    setupCommands: [],
    maxFixRounds: 1,
  },
  guidance: { implementation: [], validation: [], review: [] },
};

type FixtureOptions = Readonly<{
  readonly currentHead?: string;
  readonly pullRequest?: TaskRecord["pullRequest"];
  readonly dirty?: boolean;
  readonly origin?: string;
  readonly openPullRequests?: readonly unknown[];
  readonly gitFailure?: "exit" | "throw" | "empty";
}>;

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { stdout, code, stderr };
}

/**
 * A ready task at its reviewed HEAD in an npm repository: the git/gh fake answers the preflight's
 * reads and fails any other command, as bun and biome scripts would in that repository.
 */
async function fixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "tandem-preflight-"));
  const repo = join(home, "repo");
  const worktreePath = join(home, "worktree");
  await mkdir(repo, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: () => NOW,
    idFactory: () => "id-1",
  });
  await store.create({
    id: "task-1",
    repoPath: repo,
    kind: "implementation",
    objective: "deliver a reviewed task",
    acceptanceCriteria: ["delivery is checked"],
    surfaces: ["runtime"],
    policy,
  });
  const worktree = {
    root: worktreePath,
    path: worktreePath,
    name: "task-worktree",
    baseHead: BASE,
    branch: "task/task-1",
    leaseId: "lease-1",
    leaseHolder: "session-1",
    leasedAt: NOW,
  };
  const task = await store.update("task-1", 0, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: NOW,
    stage: "ready",
    scopeApproved: true,
    worktree,
    reviewHead: HEAD,
    ...(options.pullRequest === undefined ? {} : { pullRequest: options.pullRequest }),
  }));
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    presentations: [],
    tasks: [
      {
        schemaVersion: 1,
        taskId: task.id,
        sourceCheckpoint: { head: HEAD, base: HEAD, diff: "", dirty: false, unmerged: false },
        taskName: "task-1",
        worktree,
        endpoints: [],
        jobs: [],
      },
    ],
  });
  const commands: string[] = [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    commands.push(request.argv.join(" "));
    if (request.argv[0] === "git") {
      if (request.argv.includes("symbolic-ref") || request.argv.includes("remote")) {
        if (options.gitFailure === "exit") return result("", 7, "offline");
        if (options.gitFailure === "throw") throw new Error("spawn failed");
        if (options.gitFailure === "empty") return result(" \n");
      }
      if (request.argv.includes("symbolic-ref")) return result("task/task-1\n");
      if (request.argv.includes("remote")) {
        return result(
          `${options.origin ?? "https://github.com/tagalog-learning-app/Tagalingo-App.git"}\n`,
        );
      }
      if (request.argv.includes("rev-parse")) return result(`${options.currentHead ?? HEAD}\n`);
      if (request.argv.includes("status") && options.dirty) return result(" M src/app.ts\n");
      return result();
    }
    if (request.argv[0] === "gh") return result(JSON.stringify(options.openPullRequests ?? []));
    return result("", 1, `unexpected command ${request.argv.join(" ")}`);
  };
  return {
    commands,
    preflight: (base: string) =>
      deliveryPreflight({ run, runtimePath: runtimeFile(home) }, task, base),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("delivery preflight passes a ready npm task and reads the repository from origin", async () => {
  const f = await fixture();
  try {
    const value = await f.preflight("main");
    expect(value.refusals).toEqual([]);
    expect(value.ready).toBe(true);
    expect(value.repository).toBe("tagalog-learning-app/Tagalingo-App");
    expect(f.commands.filter((command) => !/^(git|gh) /u.test(command))).toEqual([]);
    expect(f.commands).toContain(
      "gh pr list --repo tagalog-learning-app/Tagalingo-App --head task/task-1 --state open --json number,headRefOid,baseRefName,url,title,isDraft",
    );
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight refuses a dirty worktree in one plain line", async () => {
  const f = await fixture({ dirty: true });
  try {
    const value = await f.preflight("main");
    expect(value.ready).toBe(false);
    expect(value.refusals).toEqual(["the worktree has uncommitted or unmerged changes"]);
  } finally {
    await f.cleanup();
  }
});

for (const gitFailure of ["exit", "throw", "empty"] as const) {
  test(`delivery preflight keeps unavailable branch and origin optional on ${gitFailure}`, async () => {
    const f = await fixture({ gitFailure });
    try {
      const value = await f.preflight("main");
      expect(value.ready).toBe(false);
      expect(value.branch).toBeUndefined();
      expect(value.repository).toBeUndefined();
      expect(value.refusals).toEqual([
        "the worktree is on no branch, not task/task-1",
        "the worktree has no origin remote",
      ]);
    } finally {
      await f.cleanup();
    }
  });
}

test("delivery preflight refuses a HEAD other than the reviewed one", async () => {
  const f = await fixture({ currentHead: "different-head" });
  try {
    const value = await f.preflight("main");
    expect(value.ready).toBe(false);
    expect(value.refusals).toEqual([
      "the worktree is at different-head, not the reviewed commit head-1",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight refuses an origin that is not on GitHub", async () => {
  const f = await fixture({ origin: "https://gitlab.com/owner/repo.git" });
  try {
    const value = await f.preflight("main");
    expect(value.ready).toBe(false);
    expect(value.refusals).toEqual([
      "origin https://gitlab.com/owner/repo.git is not a GitHub repository",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight refuses when a pull request is already open for the branch", async () => {
  const f = await fixture({
    openPullRequests: [{ number: 9, headRefOid: HEAD, baseRefName: "main", isDraft: false }],
  });
  try {
    const value = await f.preflight("main");
    expect(value.ready).toBe(false);
    expect(value.refusals).toEqual(["pull request #9 is already open for task/task-1"]);
    expect(value.duplicatePullRequest?.number).toBe(9);
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight treats the task's own draft as the PR to update, not a duplicate", async () => {
  const draft = {
    repository: "tagalog-learning-app/Tagalingo-App",
    number: 11,
    state: "draft" as const,
    head: HEAD,
    base: "main",
  };
  const f = await fixture({ pullRequest: draft });
  try {
    const value = await f.preflight("main");
    expect(value.refusals).toEqual([]);
    expect(value.draftPullRequest).toEqual(draft);
    expect(value.duplicatePullRequest).toBeUndefined();

    const otherBase = await f.preflight("release");
    expect(otherBase.refusals).toEqual(["the task already has pull request #11"]);
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight refuses a task that already has a published pull request", async () => {
  const f = await fixture({
    pullRequest: {
      repository: "tagalog-learning-app/Tagalingo-App",
      number: 7,
      state: "open",
      head: HEAD,
      base: "main",
    },
  });
  try {
    const value = await f.preflight("main");
    expect(value.ready).toBe(false);
    expect(value.refusals).toEqual(["the task already has pull request #7"]);
  } finally {
    await f.cleanup();
  }
});
