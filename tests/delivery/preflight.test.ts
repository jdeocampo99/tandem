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
    maxWorkers: 4,
    maxFixRounds: 1,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

type FixtureOptions = Readonly<{
  readonly currentHead?: string;
  readonly pullRequest?: TaskRecord["pullRequest"];
  readonly checkFailure?: boolean;
}>;

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { stdout, code, stderr };
}

/** A ready task at its reviewed HEAD, with a git/gh fake that answers the preflight's reads. */
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
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    if (request.argv[0] === "git") {
      if (request.argv.includes("symbolic-ref")) return result("task/task-1\n");
      if (request.argv.includes("remote")) return result("git@github.com:owner/repo.git\n");
      if (request.argv.includes("rev-parse")) return result(`${options.currentHead ?? HEAD}\n`);
      return result();
    }
    if (request.argv.join(" ") === "bun run db:types:check" && options.checkFailure) {
      return result("", 1, "generated database types are stale");
    }
    return result();
  };
  return {
    preflight: (repository: string, base: string) =>
      deliveryPreflight({ run, runtimePath: runtimeFile(home) }, task, repository, base),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("delivery preflight rejects generated-type drift", async () => {
  const f = await fixture({ checkFailure: true });
  try {
    const value = await f.preflight("owner/repo", "main");
    expect(value.ready).toBe(false);
    expect(value.refusals.join("\n")).toContain("generated database types are stale");
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight rejects reviewed HEAD mismatch", async () => {
  const f = await fixture({ currentHead: "different-head" });
  try {
    const value = await f.preflight("owner/repo", "main");
    expect(value.ready).toBe(false);
    expect(value.refusals.join("\n")).toContain("reviewed-head");
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight treats the task's own draft as the PR to update, not a duplicate", async () => {
  const draft = {
    repository: "owner/repo",
    number: 11,
    state: "draft" as const,
    head: HEAD,
    base: "main",
  };
  const f = await fixture({ pullRequest: draft });
  try {
    const value = await f.preflight("owner/repo", "main");
    expect(value.refusals.join("\n")).not.toContain("duplicate publication");
    expect(value.draftPullRequest).toEqual(draft);
    expect(value.duplicatePullRequest).toBeUndefined();

    const other = await f.preflight("owner/other", "main");
    expect(other.refusals.join("\n")).toContain("duplicate publication");
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight rejects duplicate PR metadata", async () => {
  const f = await fixture({
    pullRequest: { repository: "owner/repo", number: 7, state: "open", head: HEAD, base: "main" },
  });
  try {
    const value = await f.preflight("owner/repo", "main");
    expect(value.ready).toBe(false);
    expect(value.refusals.join("\n")).toContain("duplicate publication");
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight passes a clean ready task at its reviewed HEAD", async () => {
  const f = await fixture();
  try {
    const value = await f.preflight("owner/repo", "main");
    expect(value.refusals).toEqual([]);
    expect(value.ready).toBe(true);
  } finally {
    await f.cleanup();
  }
});
