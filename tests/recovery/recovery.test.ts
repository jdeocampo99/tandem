import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndpointOwnershipError } from "../../src/adapters/primitives.ts";
import type {
  CommandRequest,
  CommandResult,
  ResolvedPolicy,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import { RecoveryWorkflow } from "../../src/recovery/workflow.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type { DurableJob, RuntimeState } from "../../src/runtime/schema.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { acquireDarwinFileLock } from "../../src/tasks/store-lock.ts";

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
      verifier: { model: "test/verifier", thinking: "low" },
      presentation: { model: "test/presentation", thinking: "low" },
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [{ name: "smoke", argv: ["true"], surfaces: ["*"], timeoutMs: 1_000 }],
    maxWorkers: 4,
    maxFixRounds: 1,
    reviewLevels: {
      reducedRouting: false,
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

type FixtureOptions = Readonly<{
  readonly stage?: TaskRecord["stage"];
  readonly currentHead?: string;
  readonly diff?: string;
  readonly dirty?: boolean;
  readonly endpoint?: "missing" | "foreign";
  readonly job?: DurableJob;
  readonly reportPath?: string;
  readonly reviewRound?: number;
  readonly pullRequest?: TaskRecord["pullRequest"];
  readonly checkFailure?: boolean;
}>;

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { stdout, code, stderr };
}

function lease(path: string): WorktreeLease {
  return {
    root: path,
    path,
    name: "task-worktree",
    baseHead: BASE,
    branch: "task/task-1",
    leaseId: "lease-1",
    leaseHolder: "session-1",
    leasedAt: NOW,
  };
}

async function fixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "tandem-recovery-"));
  const repo = join(home, "repo");
  const worktreePath = join(home, "worktree");
  await mkdir(repo, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  const clock = (): string => NOW;
  let id = 0;
  const idFactory = (): string => `id-${++id}`;
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  const taskInput = {
    id: "task-1",
    repoPath: repo,
    kind: "implementation" as const,
    objective: "recover a durable task",
    acceptanceCriteria: ["recovery is bounded"],
    surfaces: ["runtime"],
    policy,
  };
  await store.create(taskInput);
  const worktree = lease(worktreePath);
  const endpoint = {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
    role: "implementer" as const,
    generation: 0,
  };
  const task = await store.update("task-1", 0, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: NOW,
    stage: options.stage ?? "blocked",
    scopeApproved: true,
    worktree,
    ...(options.reportPath === undefined ? {} : { reportPath: options.reportPath }),
    reviewHead: HEAD,
    reviewRound: options.reviewRound ?? 0,
    ...(options.pullRequest === undefined ? {} : { pullRequest: options.pullRequest }),
    ...(options.endpoint === undefined ? {} : { endpoints: [endpoint] }),
  }));
  const job = options.job;
  const runtime: RuntimeState = {
    schemaVersion: 1,
    presentations: [],
    tasks: [
      {
        schemaVersion: 1,
        taskId: task.id,
        sourceCheckpoint: { head: HEAD, base: HEAD, diff: "", dirty: false, unmerged: false },
        sourceRepoPath: repo,
        taskName: "task-1",
        worktree,
        endpoints: options.endpoint === undefined ? [] : [endpoint],
        jobs: job === undefined ? [] : [job],
        ...(options.endpoint === undefined
          ? {}
          : {
              reservation: {
                schemaVersion: 1,
                id: "reservation-1",
                taskId: task.id,
                ownerSessionId: "session-1",
                phase: job === undefined ? "released" : "endpoint",
                createdAt: NOW,
              },
            }),
        ...(job === undefined
          ? {}
          : {
              operation: {
                schemaVersion: 1 as const,
                id: "operation-1",
                taskId: task.id,
                kind: "implementation" as const,
                role: "implementer" as const,
                generation: 0,
                inputHead: HEAD,
                policyDigest: "policy",
                instructionRevision: 0,
                jobId: job.id,
                phase: job.phase === "consumed" ? ("completed" as const) : ("running" as const),
                fencingRevision: 1,
                claimOwner: "session-1",
                createdAt: NOW,
                effects: [],
              },
            }),
      },
    ],
  };
  await writeRuntimeState(runtimeFile(home), runtime);
  const runner = async (request: CommandRequest): Promise<CommandResult> => {
    if (request.argv[0] === "git") {
      if (request.argv.includes("symbolic-ref")) return result("task/task-1\n");
      if (request.argv.includes("remote")) return result("git@github.com:owner/repo.git\n");
      if (request.argv.includes("rev-parse")) {
        return result(`${options.currentHead ?? HEAD}\n`);
      }
      if (request.argv.includes("status")) return result(options.dirty ? " M file\n" : "");
      if (request.argv.includes("--name-only")) return result("");
      if (request.argv.includes("diff")) return result(options.diff ?? "");
      return result();
    }
    if (request.argv[0] === "herdr") {
      if (options.endpoint === "missing")
        throw new EndpointOwnershipError(endpoint, "pane missing", "missing");
      if (options.endpoint === "foreign")
        throw new EndpointOwnershipError(endpoint, "pane is foreign", "mismatch");
      return result();
    }
    if (
      request.argv[0] === "bun" &&
      request.argv[1] === "run" &&
      request.argv[2] === "check" &&
      options.checkFailure
    ) {
      return result("", 1, "generated database types are stale");
    }
    return result();
  };
  const workflow = new RecoveryWorkflow({
    home,
    sessionId: "session-1",
    run: runner,
    clock,
    idFactory,
    store,
    runtimePath: runtimeFile(home),
    getTask: async (taskId) => {
      const current = await store.read(taskId);
      if (current === undefined) throw new Error(`task ${taskId} is missing`);
      return current;
    },
    taskInScope: async () => true,
  });
  return {
    home,
    repo,
    worktreePath,
    store,
    task,
    runtimePath: runtimeFile(home),
    workflow,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

function job(phase: DurableJob["phase"], kind: DurableJob["kind"] = "worker"): DurableJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: kind === "validation" ? "validation" : "implementer",
    kind,
    cwd: "/tmp/worktree",
    jobPath: "/tmp/job.json",
    resultPath: "/tmp/result.json",
    attempt: 1,
    phase,
    launchAttempted: true,
    createdAt: NOW,
    ...(kind === "validation"
      ? {}
      : {
          endpoint: {
            sessionId: "session-1",
            workspaceId: "workspace-1",
            tabId: "tab-1",
            paneId: "pane-1",
            role: "implementer" as const,
            generation: 0,
          },
        }),
    head: HEAD,
  };
}
test("inspection exposes JSON-safe task and recovery state", async () => {
  const f = await fixture();
  try {
    const value = await f.workflow.inspect("task-1");
    expect(value.taskId).toBe("task-1");
    expect(value.stage).toBe("blocked");
    expect(value.review.reviewedHead).toBe(HEAD);
    expect(value.worktree.preserved).toBe(true);
    expect(value.jobs).toEqual([]);
    expect(value.recommendations.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(value)).taskId).toBe("task-1");
  } finally {
    await f.cleanup();
  }
});

test("recovery plan is dry-run and reports budgets", async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(await readRuntimeState(f.runtimePath));
    const plan = await f.workflow.plan("task-1");
    expect(plan.dryRun).toBe(true);
    expect(plan.operation.name).toBe("review-existing");
    expect(plan.budget.recoveryRemaining).toBe(3);
    expect(JSON.stringify(await readRuntimeState(f.runtimePath))).toBe(before);
  } finally {
    await f.cleanup();
  }
});

test("terminal job with missing pane is reconciled without releasing worktree", async () => {
  const f = await fixture({ endpoint: "missing", job: job("consumed") });
  try {
    const value = await f.workflow.reconcile("task-1", true);
    expect(value.clearedEndpoints).toEqual(["pane-1"]);
    expect(value.worktreePreserved).toBe(true);
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.endpoints).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("stale active job is quarantined while reservation stays fenced", async () => {
  const f = await fixture({ endpoint: "missing", job: job("running") });
  try {
    const value = await f.workflow.reconcile("task-1", true);
    expect(value.settledJobs).toEqual(["job-1"]);
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.jobs[0]?.phase).toBe("failed");
    expect(state.tasks[0]?.reservation?.phase).toBe("endpoint");
  } finally {
    await f.cleanup();
  }
});

test("proven terminal reservation is released", async () => {
  const f = await fixture({ endpoint: "missing", job: job("consumed") });
  try {
    const state = await readRuntimeState(f.runtimePath);
    await writeRuntimeState(f.runtimePath, {
      ...state,
      tasks: state.tasks.map((entry) =>
        entry.operation === undefined
          ? entry
          : { ...entry, operation: { ...entry.operation, phase: "completed" as const } },
      ),
    });
    const value = await f.workflow.reconcile("task-1", true);
    expect(value.releasedReservations).toEqual(["reservation-1"]);
  } finally {
    await f.cleanup();
  }
});

test("foreign endpoint ownership blocks recovery", async () => {
  const f = await fixture({ endpoint: "foreign" });
  try {
    const value = await f.workflow.reconcile("task-1", true);
    expect(value.blocked).toBe(true);
    expect((await f.store.read("task-1"))?.stage).toBe("blocked");
  } finally {
    await f.cleanup();
  }
});

test("reconciliation is idempotent after proven cleanup", async () => {
  const f = await fixture({ endpoint: "missing", job: job("consumed") });
  try {
    await f.workflow.reconcile("task-1", true);
    const second = await f.workflow.reconcile("task-1", true);
    expect(second.changed).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("validation retry writes a durable result when result artifact is missing", async () => {
  const validation = job("failed", "validation");
  const f = await fixture({ job: validation });
  try {
    const value = await f.workflow.validationRetry("task-1", true);
    expect(value.status).toBe("completed");
    expect(value.resultPath).toBeDefined();
    expect(await readFile(value.resultPath as string, "utf8")).toContain('"status":"completed"');
  } finally {
    await f.cleanup();
  }
});

test("review-existing preserves exact HEAD and records mode provenance", async () => {
  const f = await fixture();
  try {
    const value = await f.workflow.reviewExisting("task-1", HEAD, true);
    expect(value.status).toBe("started");
    expect(value.mode).toBe("review_existing_head");
    const repeat = await f.workflow.reviewExisting("task-1", HEAD, true);
    expect(repeat.status).toBe("already-started");
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.reviewMode).toBe("review_existing_head");
    expect(await readFile(value.provenancePath as string, "utf8")).toContain(
      "review_existing_head",
    );
  } finally {
    await f.cleanup();
  }
});

test("recovery retries bounded SQLite lock acquisition", async () => {
  const f = await fixture();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireDarwinFileLock(join(f.home, ".state.lock"), 2_000, 10);
    const pending = f.workflow.reviewExisting("task-1", HEAD, true);
    // Native O_EXLOCK contention must elapse on Darwin; fake timers cannot release the kernel lock.
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await release();
    release = undefined;
    const value = await pending;
    expect(value.status).toBe("started");
  } finally {
    if (release !== undefined) await release();
    await f.cleanup();
  }
});

test("empty diff review provenance is explicit", async () => {
  const f = await fixture({ diff: "" });
  try {
    const value = await f.workflow.reviewExisting("task-1", HEAD, true);
    expect(await readFile(value.provenancePath as string, "utf8")).toContain('"diffEmpty":true');
  } finally {
    await f.cleanup();
  }
});

test("evidence repair uses reports without inspecting a worker pane", async () => {
  const consumed = {
    ...job("consumed"),
    jobPath: join(await mkdtemp(join(tmpdir(), "tandem-job-")), "job.json"),
  };
  await writeFile(reportPath(consumed.jobPath), "durable report\n");
  const f = await fixture({ job: consumed });
  try {
    const value = await f.workflow.repairEvidence("task-1", true);
    expect(value.changed).toBe(true);
    expect((await f.store.read("task-1"))?.reportPath).toBe(reportPath(consumed.jobPath));
  } finally {
    await f.cleanup();
  }
});

test("evidence repair refuses a report from a stale reviewed HEAD", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tandem-stale-job-"));
  const stale = { ...job("consumed"), head: "old-head", jobPath: join(directory, "job.json") };
  await writeFile(reportPath(stale.jobPath), "stale report\n");
  const f = await fixture({ job: stale });
  try {
    const value = await f.workflow.repairEvidence("task-1", true);
    expect(value.changed).toBe(false);
    expect(value.reason).toContain("no durable evidence repair");
  } finally {
    await f.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

function reportPath(jobPath: string): string {
  return join(jobPath, "..", "report.txt");
}

test("review-existing succeeds after code-fix budget is exhausted", async () => {
  const f = await fixture({ reviewRound: policy.config.maxFixRounds });
  try {
    const value = await f.workflow.reviewExisting("task-1", HEAD, true);
    expect(value.status).toBe("started");
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight rejects generated-type drift", async () => {
  const f = await fixture({ stage: "ready", checkFailure: true });
  try {
    const value = await f.workflow.deliveryPreflight("task-1", "owner/repo", "main");
    expect(value.ready).toBe(false);
    expect(value.refusals.join("\n")).toContain("generated database types are stale");
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight rejects reviewed HEAD mismatch", async () => {
  const f = await fixture({ stage: "ready", currentHead: "different-head" });
  try {
    const value = await f.workflow.deliveryPreflight("task-1", "owner/repo", "main");
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
  const f = await fixture({ stage: "ready", pullRequest: draft });
  try {
    const value = await f.workflow.deliveryPreflight("task-1", "owner/repo", "main");
    expect(value.refusals.join("\n")).not.toContain("duplicate publication");
    expect(value.draftPullRequest).toEqual(draft);
    expect(value.duplicatePullRequest).toBeUndefined();

    const other = await f.workflow.deliveryPreflight("task-1", "owner/other", "main");
    expect(other.refusals.join("\n")).toContain("duplicate publication");
  } finally {
    await f.cleanup();
  }
});

test("delivery preflight rejects duplicate PR metadata", async () => {
  const f = await fixture({
    stage: "ready",
    pullRequest: { repository: "owner/repo", number: 7, state: "open", head: HEAD, base: "main" },
  });
  try {
    const value = await f.workflow.deliveryPreflight("task-1", "owner/repo", "main");
    expect(value.ready).toBe(false);
    expect(value.refusals.join("\n")).toContain("duplicate publication");
  } finally {
    await f.cleanup();
  }
});
