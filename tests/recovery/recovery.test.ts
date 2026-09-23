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
import { RecoveryConversationWorkflow } from "../../src/recovery/conversation.ts";
import { AVAILABILITY_WAIT_CEILING_MS } from "../../src/recovery/wait.ts";
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
    requestBudget: { capMicros: "unset", operationEstimateMicros: "unset" },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

type FixtureOptions = Readonly<{
  readonly taskKind?: TaskRecord["kind"];
  readonly stage?: TaskRecord["stage"];
  readonly blockReason?: string;
  readonly requestId?: string;
  readonly requestHold?: string;
  readonly outOfScope?: boolean;
  readonly currentHead?: string;
  readonly diff?: string;
  readonly dirty?: boolean;
  readonly endpoint?: "missing" | "foreign";
  readonly job?: DurableJob;
  readonly reportPath?: string;
  readonly reviewRound?: number;
  readonly pullRequest?: TaskRecord["pullRequest"];
  readonly checkFailure?: boolean;
  readonly detached?: boolean;
  readonly separateSource?: boolean;
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
  const sourceRepoPath = options.separateSource ? join(home, "source") : repo;
  const worktreePath = join(home, "worktree");
  const commonPath = join(home, "common.git");
  await mkdir(repo, { recursive: true });
  await mkdir(sourceRepoPath, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(commonPath, { recursive: true });
  let currentBranch: string | undefined = options.detached ? undefined : "task/task-1";
  let branchHead = options.currentHead ?? BASE;
  let now = NOW;
  const clock = (): string => now;
  let id = 0;
  const idFactory = (): string => `id-${++id}`;
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  const taskInput = {
    id: "task-1",
    repoPath: repo,
    kind: options.taskKind ?? ("implementation" as const),
    objective: "recover a durable task",
    acceptanceCriteria: ["recovery is bounded"],
    surfaces: ["runtime"],
    policy,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
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
    ...(options.blockReason === undefined ? {} : { blockReason: options.blockReason }),
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
        sourceRepoPath,
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
      if (request.argv.includes("symbolic-ref")) {
        return currentBranch === undefined ? result("", 1) : result(`${currentBranch}\n`);
      }
      if (request.argv.includes("--show-toplevel")) return result(`${request.cwd}\n`);
      if (request.argv.includes("--git-common-dir")) return result(`${commonPath}\n`);
      if (request.argv.includes("merge-base")) return result();
      if (request.argv.includes("--verify")) {
        return branchHead === undefined ? result("", 1) : result(`${branchHead}\n`);
      }
      if (request.argv.includes("branch") && request.argv.includes("--force")) {
        branchHead = request.argv.at(-1) as string;
        return result();
      }
      if (request.argv.includes("switch")) {
        const createIndex = request.argv.indexOf("--create");
        currentBranch = createIndex >= 0 ? request.argv[createIndex + 1] : request.argv.at(-1);
        branchHead = options.currentHead ?? HEAD;
        return result();
      }
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
      request.argv[2] === "db:types:check" &&
      options.checkFailure
    ) {
      return result("", 1, "generated database types are stale");
    }
    return result();
  };
  const getTask = async (taskId: string): Promise<TaskRecord> => {
    const current = await store.read(taskId);
    if (current === undefined) throw new Error(`task ${taskId} is missing`);
    return current;
  };
  const workflow = new RecoveryWorkflow({
    home,
    sessionId: "session-1",
    run: runner,
    clock,
    idFactory,
    store,
    runtimePath: runtimeFile(home),
    getTask,
    taskInScope: async () => options.outOfScope !== true,
  });
  const conversationFor = (sessionId: string): RecoveryConversationWorkflow =>
    new RecoveryConversationWorkflow({
      sessionId,
      clock,
      idFactory,
      store,
      runtimePath: runtimeFile(home),
      recovery: {
        inspect: (taskId) => workflow.inspect(taskId),
        plan: (taskId) => workflow.plan(taskId),
        reconcile: (taskId, approved) => workflow.reconcile(taskId, approved),
        repairEvidence: (taskId, approved) => workflow.repairEvidence(taskId, approved),
      },
      getTask,
      taskInScope: async () => options.outOfScope !== true,
      requestDispatchHold: async () => options.requestHold,
      // These fixtures exercise the old decision rules directly; central recovery's own blocked-task
      // re-entry is covered separately in tests/recovery/central.test.ts.
      recoverBlockedTask: async (task) => ({
        taskId: task.id,
        action: "skipped",
        reason: "central recovery is not under test here",
      }),
    });
  return {
    home,
    repo,
    worktreePath,
    store,
    task,
    runtimePath: runtimeFile(home),
    workflow,
    conversation: conversationFor("session-1"),
    conversationFor,
    setNow: (value: string) => {
      now = value;
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

function minutesAfter(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
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

test("plan never proposes evidence-repair while the prior outcome is uncertain", async () => {
  // Reproduces the motivating incident directly: a structurally "missing artifact" condition alone
  // used to be enough for the old symptom ladder to propose evidence-repair, even though the prior
  // operation's outcome was not actually known (quarantined). The planner must refuse to propose any
  // action whose own proofs are unmet, not just apply extra approval gating around it afterward.
  const f = await fixture({ job: job("consumed"), currentHead: "different-head" });
  try {
    const state = await readRuntimeState(f.runtimePath);
    await writeRuntimeState(f.runtimePath, {
      ...state,
      tasks: state.tasks.map((entry) =>
        entry.operation === undefined
          ? entry
          : { ...entry, operation: { ...entry.operation, phase: "quarantined" as const } },
      ),
    });
    const plan = await f.workflow.plan("task-1");
    expect(plan.priorOutcome).toBe("uncertain");
    expect(plan.facts["prior-outcome-known"]).toBe(false);
    expect(plan.operation.name).toBe("none");
    expect(plan.reasons.join("\n")).toContain("evidence-repair is not proposed");
    expect(plan.reasons.join("\n")).toContain("prior-outcome-known");
  } finally {
    await f.cleanup();
  }
});

test("reconciliation repairs a detached reviewed worktree branch", async () => {
  const f = await fixture({ detached: true, separateSource: true });
  try {
    const before = await f.workflow.inspect("task-1");
    expect(before.repository.identity).toBe("proven");
    expect(before.branch).toBeUndefined();

    const value = await f.workflow.reconcile("task-1", true);

    expect(value.repairedBranch).toBe("task/task-1");
    const after = await f.workflow.inspect("task-1");
    expect(after.branch).toBe("task/task-1");
    expect(after.review.exactHead).toBe(true);
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

test("reconciliation quarantines an orphaned active job from a quarantined operation", async () => {
  const f = await fixture({ endpoint: "missing", job: job("running") });
  try {
    const state = await readRuntimeState(f.runtimePath);
    await writeRuntimeState(f.runtimePath, {
      ...state,
      tasks: state.tasks.map((entry) =>
        entry.operation === undefined
          ? entry
          : {
              ...entry,
              endpoints: [],
              operation: { ...entry.operation, phase: "quarantined" as const },
            },
      ),
    });

    const value = await f.workflow.reconcile("task-1", true);

    expect(value.settledJobs).toEqual(["job-1"]);
    const updated = await readRuntimeState(f.runtimePath);
    expect(updated.tasks[0]?.jobs[0]?.phase).toBe("failed");
    expect(updated.tasks[0]?.reservation?.phase).toBe("endpoint");
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

test("foreign endpoint ownership blocks a not-yet-blocked task with an ownership-unprovable cause", async () => {
  const f = await fixture({ endpoint: "foreign", stage: "implementing" });
  try {
    const value = await f.workflow.reconcile("task-1", true);
    expect(value.blocked).toBe(true);
    const blocked = await f.store.read("task-1");
    expect(blocked?.stage).toBe("blocked");
    expect(blocked?.blockCause?.kind).toBe("ownership-unprovable");
    expect(blocked?.blockCause?.group).toBe("safety-stop");
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
  const f = await fixture({ separateSource: true });
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

test("evidence repair preserves the durable scout continuation disposition", async () => {
  const consumed = {
    ...job("consumed"),
    role: "scout" as const,
    jobPath: join(await mkdtemp(join(tmpdir(), "tandem-scout-job-")), "job.json"),
  };
  await writeFile(reportPath(consumed.jobPath), "durable scout report\n");
  const f = await fixture({ job: consumed, taskKind: "scout" });
  try {
    const before = await f.store.read("task-1");
    expect(before?.researchContinuation?.disposition).toBe("ask-intent");
    const value = await f.workflow.repairEvidence("task-1", true);
    expect(value.changed).toBe(true);
    const after = await f.store.read("task-1");
    expect(after?.reportPath).toBe(reportPath(consumed.jobPath));
    expect(after?.researchContinuation).toEqual(before?.researchContinuation);
    expect(after?.scopeApproved).toBe(before?.scopeApproved);
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

test("a preapproved action runs once scope, ownership, and the prior outcome are proven", async () => {
  const f = await fixture({
    endpoint: "missing",
    job: job("consumed"),
    blockReason: "the implementer pane disappeared while the durable result was already recorded",
    requestId: "req-1",
  });
  try {
    const outcome = await f.conversation.decide("task-1");

    expect(outcome.status).toBe("applied");
    expect(outcome.requestId).toBe("req-1");
    expect(outcome.decision?.approval).toBe("preapproved");
    expect(outcome.decision?.recommendedAction).toBe("reconcile");
    expect(outcome.decision?.unmetProofs).toEqual([]);
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.endpoints).toEqual([]);
    const after = await f.store.read("task-1");
    expect(after?.communication?.question).toBeUndefined();
    const inspection = await f.workflow.inspect("task-1");
    expect(inspection.requestId).toBe("req-1");
    expect(inspection.recoveryDecisions).toHaveLength(1);
    expect(inspection.recoveryDecisions[0]?.disposition).toBe("applied");
    expect(inspection.recoveryDecisions[0]?.generation).toBe(0);
    expect(inspection.worktree.preserved).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("an action outside the preapproved set asks one bounded question and runs nothing", async () => {
  const f = await fixture({
    blockReason: "the reviewer never reported a result for the reviewed HEAD",
    requestId: "req-1",
  });
  try {
    const outcome = await f.conversation.decide("task-1");
    const repeated = await f.conversation.decide("task-1");

    expect(outcome.status).toBe("asked");
    expect(outcome.decision?.recommendedAction).toBe("review-existing");
    expect(outcome.decision?.approval).toBe("user-approval");
    expect(outcome.changed).toBe(true);
    expect(repeated.changed).toBe(false);
    const after = await f.store.read("task-1");
    const question = after?.communication?.question;
    expect(question?.id).toBe(outcome.decision?.questionId);
    expect(question?.text).toBe(
      '"recover a durable task" is stuck. Should I review it as it stands? The reviewer never reported a result for the reviewed HEAD.',
    );
    expect(question?.recommendation).toContain("review-existing");
    expect(after?.notifications.filter((entry) => !entry.acknowledged)).toHaveLength(1);
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.reviewMode).toBeUndefined();
    expect(state.tasks[0]?.recovery?.recoveryAttempts ?? 0).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("foreign ownership and an uncertain worker outcome ask instead of retrying", async () => {
  const f = await fixture({
    endpoint: "foreign",
    job: job("running"),
    blockReason: "the implementer pane answers for another session",
  });
  try {
    const outcome = await f.conversation.decide("task-1");

    expect(outcome.status).toBe("asked");
    expect(outcome.decision?.ownership).toBe("foreign");
    expect(outcome.decision?.priorOutcome).toBe("uncertain");
    expect(outcome.decision?.unmetProofs).toContain("endpoint-ownership-proven");
    expect(outcome.decision?.unmetProofs).toContain("prior-outcome-known");
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.jobs[0]?.phase).toBe("running");
    expect(state.tasks[0]?.endpoints).toHaveLength(1);
    expect(state.tasks[0]?.reservation?.phase).toBe("endpoint");
  } finally {
    await f.cleanup();
  }
});

test("an exhausted recovery budget asks and leaves every resource in place", async () => {
  const f = await fixture({
    endpoint: "missing",
    job: job("consumed"),
    blockReason: "the implementer pane disappeared after its durable result was recorded",
  });
  try {
    const seeded = await readRuntimeState(f.runtimePath);
    await writeRuntimeState(f.runtimePath, {
      ...seeded,
      tasks: seeded.tasks.map((entry) => ({
        ...entry,
        recovery: {
          schemaVersion: 1 as const,
          recoveryAttempts: 3,
          validationRetries: 0,
          evidenceRepairs: 0,
        },
      })),
    });

    const outcome = await f.conversation.decide("task-1");

    expect(outcome.status).toBe("asked");
    expect(outcome.decision?.unmetProofs).toContain("recovery-attempt-budget-remaining");
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.endpoints).toHaveLength(1);
    expect(state.tasks[0]?.recovery?.recoveryAttempts).toBe(3);
  } finally {
    await f.cleanup();
  }
});

test("a confirmed availability block waits at most five minutes without launching work", async () => {
  const f = await fixture({
    blockReason: "provider rate limit: the model endpoint is temporarily unavailable",
    requestId: "req-1",
  });
  try {
    const started = await f.conversation.decide("task-1");

    expect(started.status).toBe("waiting");
    expect(started.wait?.requestId).toBe("req-1");
    expect(started.wait?.deadlineAt).toBe(
      new Date(Date.parse(NOW) + AVAILABILITY_WAIT_CEILING_MS).toISOString(),
    );
    expect((await f.store.read("task-1"))?.communication?.question).toBeUndefined();

    f.setNow(minutesAfter(NOW, 2));
    const repeated = await f.conversation.decide("task-1");

    expect(repeated.status).toBe("waiting");
    expect(repeated.changed).toBe(false);
    expect(repeated.wait?.deadlineAt).toBe(started.wait?.deadlineAt);
    const inspection = await f.workflow.inspect("task-1");
    expect(inspection.availabilityWaits).toHaveLength(1);
    expect(inspection.availabilityWaits[0]?.disposition).toBe("waiting");
  } finally {
    await f.cleanup();
  }
});

test("durable evidence of a delay beyond five minutes asks immediately", async () => {
  const f = await fixture({
    blockReason: "provider quota exhausted; retry after 1800 seconds",
  });
  try {
    const outcome = await f.conversation.decide("task-1");

    expect(outcome.status).toBe("asked");
    expect(outcome.wait?.disposition).toBe("asked");
    expect(outcome.wait?.knownAvailableAt).toBe(minutesAfter(NOW, 30));
    expect((await f.store.read("task-1"))?.communication?.question?.text).toContain(
      "Provider quota exhausted",
    );
  } finally {
    await f.cleanup();
  }
});

test("a wait reconstructed after restart is overdue and asks rather than acting", async () => {
  const f = await fixture({
    blockReason: "provider rate limit: the model endpoint is temporarily unavailable",
  });
  try {
    await f.conversation.decide("task-1");
    f.setNow(minutesAfter(NOW, 9));

    const restarted = f.conversationFor("session-2");
    const outcome = await restarted.decide("task-1");

    expect(outcome.status).toBe("asked");
    expect(outcome.wait?.disposition).toBe("asked");
    expect(outcome.wait?.dispositionReason).toContain("overdue");
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.recoveryWaits).toHaveLength(1);
    expect(state.tasks[0]?.reviewMode).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("a due wait re-inspects once, continues the decision rules, and never duplicates work", async () => {
  const f = await fixture({
    blockReason: "provider rate limit: the model endpoint is temporarily unavailable",
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.conversation.decide("task-1");
    const passive = JSON.stringify(await readRuntimeState(f.runtimePath));

    f.setNow(minutesAfter(NOW, 3));
    expect(await f.conversation.reconcileWaits([task])).toEqual([]);
    expect(JSON.stringify(await readRuntimeState(f.runtimePath))).toBe(passive);

    f.setNow(minutesAfter(NOW, 6));
    const woken = await f.conversation.reconcileWaits([task]);
    const again = await f.conversation.reconcileWaits([task]);

    expect(woken).toHaveLength(1);
    expect(woken[0]?.status).toBe("asked");
    expect(woken[0]?.wait?.disposition).toBe("continued");
    expect(again).toEqual([]);
    const after = await f.store.read("task-1");
    expect(after?.notifications.filter((entry) => !entry.acknowledged)).toHaveLength(1);
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.reviewMode).toBeUndefined();
    expect(state.tasks[0]?.recoveryWaits).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a cancelled task cannot be resumed by its old wait timer", async () => {
  const f = await fixture({
    blockReason: "provider rate limit: the model endpoint is temporarily unavailable",
  });
  try {
    await f.conversation.decide("task-1");
    const current = await f.store.read("task-1");
    if (current === undefined) throw new Error("fixture task missing");
    const cancelled = await f.store.update("task-1", current.revision, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      updatedAt: NOW,
      stage: "cancelled" as const,
    }));

    f.setNow(minutesAfter(NOW, 6));
    const woken = await f.conversation.reconcileWaits([cancelled]);

    expect(woken[0]?.wait?.disposition).toBe("abandoned");
    expect((await f.store.read("task-1"))?.communication?.question).toBeUndefined();
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.recoveryWaits?.[0]?.dispositionReason).toContain("cancelled");
  } finally {
    await f.cleanup();
  }
});

test("a request whose brief approval is not current blocks preapproved recovery", async () => {
  const f = await fixture({
    endpoint: "missing",
    job: job("consumed"),
    blockReason: "the implementer pane disappeared after its durable result was recorded",
    requestId: "req-1",
    requestHold: "Request req-1 changed what was agreed after approval",
  });
  try {
    const outcome = await f.conversation.decide("task-1");

    expect(outcome.status).toBe("asked");
    expect(outcome.decision?.unmetProofs).toContain("request-approval-current");
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.endpoints).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
