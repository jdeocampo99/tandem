import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandRequest,
  CommandResult,
  Endpoint,
  ResolvedPolicy,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import {
  CentralRecoveryWorkflow,
  type RelaunchWorker,
  type RevalidateWorker,
  VALIDATION_RETRY_QUESTION_ID_PREFIX,
} from "../../src/recovery/central.ts";
import { MAX_VALIDATION_RETRIES } from "../../src/recovery/workflow.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type { DurableJob, RuntimeState } from "../../src/runtime/schema.ts";
import { createTaskStore } from "../../src/tasks/store.ts";

const NOW = "2030-01-01T00:00:00.000Z";
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
    requestBudget: { capMicros: "unset", operationEstimateMicros: "unset" },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { stdout, code, stderr };
}

function lease(path: string): WorktreeLease {
  return {
    root: path,
    path,
    name: "task-worktree",
    baseHead: "base-1",
    branch: "task/task-1",
    leaseId: "lease-1",
    leaseHolder: "session-1",
    leasedAt: NOW,
  };
}

function reviewerEndpoint(paneId: string): Endpoint {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId,
    role: "reviewer",
    generation: 0,
  };
}

const DEFAULT_JOB_CREATED_AT = "2030-01-01T00:00:00.000Z";
const DEFAULT_JOB_CONSUMED_AT = "2030-01-01T00:00:30.000Z";

function deadValidationJob(
  input: Readonly<{ error?: string; createdAt?: string; consumedAt?: string }> = {},
): DurableJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "validation",
    kind: "validation",
    cwd: "/tmp/worktree",
    jobPath: "/tmp/worktree/job.json",
    resultPath: "/tmp/worktree/result.json",
    attempt: 1,
    phase: "failed",
    launchAttempted: true,
    createdAt: input.createdAt ?? DEFAULT_JOB_CREATED_AT,
    consumedAt: input.consumedAt ?? DEFAULT_JOB_CONSUMED_AT,
    error: input.error ?? "validation stopped without durable evidence: pane is missing",
  };
}

type FixtureOptions = Readonly<{
  readonly staleEndpoint?: "alive-then-gone" | "foreign" | "alive-forever" | "already-missing";
  readonly job?: DurableJob;
  readonly recovery?: RuntimeState["tasks"][number]["recovery"];
}>;

async function fixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "tandem-central-validating-"));
  const worktreePath = join(home, "worktree");
  await mkdir(worktreePath, { recursive: true });
  const now = NOW;
  const clock = (): string => now;
  let id = 0;
  const idFactory = (): string => `id-${++id}`;
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  await store.create({
    id: "task-1",
    repoPath: home,
    kind: "implementation",
    objective: "recover a stuck validation run",
    acceptanceCriteria: ["validation reruns safely"],
    surfaces: ["runtime"],
    policy,
  });
  const staleEndpoints: Endpoint[] =
    options.staleEndpoint === undefined ? [] : [reviewerEndpoint("pane-stale")];
  await store.update("task-1", 0, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: NOW,
    stage: "validating",
    scopeApproved: true,
    reviewHead: "head-1",
    worktree: lease(worktreePath),
    endpoints: staleEndpoints,
  }));
  const job = options.job;
  const runtime: RuntimeState = {
    schemaVersion: 1,
    presentations: [],
    tasks: [
      {
        schemaVersion: 1,
        taskId: "task-1",
        sourceCheckpoint: {
          head: "head-1",
          base: "head-1",
          diff: "",
          dirty: false,
          unmerged: false,
        },
        taskName: "task-1",
        worktree: lease(worktreePath),
        endpoints: [],
        jobs: job === undefined ? [] : [job],
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      },
    ],
  };
  await writeRuntimeState(runtimeFile(home), runtime);

  const missingPane = (): CommandResult =>
    result("", 1, JSON.stringify({ error: { code: "pane_not_found" } }));
  const pane = {
    present: options.staleEndpoint !== "already-missing",
    alive: options.staleEndpoint === "alive-then-gone" || options.staleEndpoint === "alive-forever",
    respondsToInterrupt: options.staleEndpoint === "alive-then-gone",
  };
  const foreign = options.staleEndpoint === "foreign";
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    if (request.argv[0] === "git") {
      if (request.argv.includes("diff")) return result("diff contents\n");
      if (request.argv.includes("ls-files")) return result("untracked.txt\n");
      return result();
    }
    if (request.argv[0] === "kill") return result();
    if (request.argv[0] === "herdr") {
      const words = request.argv.slice(3);
      const action = words[0] === "pane" ? words[1] : undefined;
      const paneId = action === "process-info" ? words[3] : words[2];
      if (action === undefined || paneId !== "pane-stale") {
        return result(JSON.stringify({ result: { type: "ok" } }));
      }
      if (!pane.present) return missingPane();
      if (action === "get") {
        return result(
          JSON.stringify({
            result: {
              pane: {
                pane_id: "pane-stale",
                tab_id: foreign ? "tab-other" : "tab-1",
                workspace_id: foreign ? "workspace-other" : "workspace-1",
                foreground_cwd: worktreePath,
              },
            },
          }),
        );
      }
      if (action === "process-info") {
        return result(
          JSON.stringify({
            result: {
              process_info: {
                pane_id: "pane-stale",
                shell_pid: 100,
                foreground_processes: pane.alive ? [{ pid: 101, name: "omp" }] : [],
              },
            },
          }),
        );
      }
      if (action === "send-keys") {
        if (pane.respondsToInterrupt) pane.alive = false;
        return result(JSON.stringify({ result: { type: "ok" } }));
      }
      if (action === "close") {
        pane.present = false;
        return result(JSON.stringify({ result: { type: "ok" } }));
      }
      return result(JSON.stringify({ result: { type: "ok" } }));
    }
    return result();
  };

  const getTask = async (taskId: string): Promise<TaskRecord> => {
    const current = await store.read(taskId);
    if (current === undefined) throw new Error(`task ${taskId} is missing`);
    return current;
  };

  const relaunchWorker: RelaunchWorker = async () => ({
    relaunched: false,
    reason: "not exercised by validating tests",
  });

  const revalidateCalls: TaskRecord[] = [];
  let revalidateOutcome: Readonly<{ readonly started: boolean; readonly reason?: string }> = {
    started: true,
  };
  const revalidate: RevalidateWorker = async (task) => {
    revalidateCalls.push(task);
    return revalidateOutcome;
  };

  const blockedReasons: string[] = [];
  const blockTask = async (_taskId: string, reason: string): Promise<void> => {
    blockedReasons.push(reason);
  };

  const workflow = new CentralRecoveryWorkflow({
    home,
    sessionId: "session-1",
    run,
    clock,
    idFactory,
    store,
    runtimePath: runtimeFile(home),
    getTask,
    relaunchWorker,
    revalidate,
    blockTask,
    removeEndpoint: async () => {},
    relaunchReviewer: async () => {},
  });

  return {
    home,
    store,
    workflow,
    runtimePath: runtimeFile(home),
    revalidateCalls,
    blockedReasons,
    setRevalidateOutcome: (
      outcome: Readonly<{ readonly started: boolean; readonly reason?: string }>,
    ) => {
      revalidateOutcome = outcome;
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("a task with no dead validation job is skipped, leaving the normal entry point to run", async () => {
  const f = await fixture();
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("skipped");
    expect(f.revalidateCalls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("a dead validation job re-enters with retry 1 of the shared validation-retry budget", async () => {
  const f = await fixture({ job: deadValidationJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.revalidateCalls).toHaveLength(1);
    expect(outcome.reason).toContain("Retry 1 of 3");
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.recovery?.validationRetries).toBe(1);
    const notified = await f.store.read("task-1");
    expect(
      notified?.notifications.some((entry) => entry.message.includes("reran it at the same")),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a stale validation endpoint proven stopped via the stop ladder is cleared before re-entry", async () => {
  const f = await fixture({ staleEndpoint: "alive-then-gone", job: deadValidationJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    const after = await f.store.read("task-1");
    expect(after?.endpoints).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("a foreign stale validation endpoint is never touched; central recovery asks instead of rerunning", async () => {
  const f = await fixture({ staleEndpoint: "foreign", job: deadValidationJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("asked");
    expect(f.revalidateCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.endpoints).toHaveLength(1);
    expect(after?.communication?.question?.id.startsWith(VALIDATION_RETRY_QUESTION_ID_PREFIX)).toBe(
      true,
    );
    expect(after?.communication?.revision ?? 0).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("the validation retry budget is exhausted at 3 and central recovery asks instead of rerunning", async () => {
  const f = await fixture({
    job: deadValidationJob(),
    recovery: {
      schemaVersion: 1,
      recoveryAttempts: 0,
      validationRetries: MAX_VALIDATION_RETRIES,
      evidenceRepairs: 0,
    },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("asked");
    expect(f.revalidateCalls).toHaveLength(0);
    const asked = await f.store.read("task-1");
    expect(asked?.communication?.question?.id.startsWith(VALIDATION_RETRY_QUESTION_ID_PREFIX)).toBe(
      true,
    );
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.recovery?.validationRetries).toBe(MAX_VALIDATION_RETRIES);
  } finally {
    await f.cleanup();
  }
});

test("a validation-retry question offers explicit retry/stop choices and refuses anything else", async () => {
  const f = await fixture({ staleEndpoint: "foreign", job: deadValidationJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a validation-retry question");
    expect(asked?.communication?.question?.text).toContain('"retry"');
    expect(asked?.communication?.question?.text).toContain('"stop"');
    expect(asked?.communication?.question?.text).not.toContain("task-1");
    expect(asked?.communication?.question?.recommendation).toContain("task task-1");

    await expect(
      f.workflow.answerValidationRetryQuestion("task-1", questionId, "sure"),
    ).rejects.toThrow(/only accepts "retry" or "stop"/u);
    const untouched = await f.store.read("task-1");
    expect(untouched?.communication?.question?.id).toBe(questionId);
    expect(untouched?.revision).toBe(asked?.revision);
    expect(f.revalidateCalls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test('answering "stop" records a decision without bumping communication.revision', async () => {
  const f = await fixture({ staleEndpoint: "foreign", job: deadValidationJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a validation-retry question");
    const beforeRevision = asked?.communication?.revision ?? 0;

    await f.workflow.answerValidationRetryQuestion("task-1", questionId, "stop");

    const declined = await f.store.read("task-1");
    expect(declined?.communication?.question).toBeUndefined();
    expect(declined?.communication?.revision ?? 0).toBe(beforeRevision);
    const state = await readRuntimeState(f.runtimePath);
    const decisions = state.tasks[0]?.recoveryDecisions ?? [];
    const decision = decisions.findLast((entry) => entry.questionId === questionId);
    expect(decision?.disposition).toBe("refused");
    expect(decision?.ownership).toBe("unknown");
    expect(decision?.priorOutcome).toBe("uncertain");
    expect(f.revalidateCalls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test('answering "retry" re-proves death and reruns validation, recording what was actually proven', async () => {
  const f = await fixture({
    job: deadValidationJob(),
    recovery: {
      schemaVersion: 1,
      recoveryAttempts: 0,
      validationRetries: MAX_VALIDATION_RETRIES,
      evidenceRepairs: 0,
    },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a validation-retry question");
    const beforeRevision = asked?.communication?.revision ?? 0;

    await f.workflow.answerValidationRetryQuestion("task-1", questionId, "retry");

    expect(f.revalidateCalls).toHaveLength(1);
    const approved = await f.store.read("task-1");
    expect(approved?.communication?.question).toBeUndefined();
    expect(approved?.communication?.revision ?? 0).toBe(beforeRevision);
    const after = await readRuntimeState(f.runtimePath);
    expect(after.tasks[0]?.recovery?.validationRetries).toBe(MAX_VALIDATION_RETRIES + 1);
    const decisions = after.tasks[0]?.recoveryDecisions ?? [];
    const decision = decisions.findLast((entry) => entry.questionId === questionId);
    expect(decision?.disposition).toBe("applied");
    expect(decision?.ownership).toBe("proven-owned");
    expect(decision?.priorOutcome).toBe("known");
  } finally {
    await f.cleanup();
  }
});

test("a revalidate refusal blocks the task with the refusal reason", async () => {
  const f = await fixture({ job: deadValidationJob() });
  f.setRevalidateOutcome({ started: false, reason: "validation refused a stale worktree" });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("blocked");
    expect(f.blockedReasons.join("\n")).toContain("validation refused a stale worktree");
  } finally {
    await f.cleanup();
  }
});

test("a stage other than implementing, scouting, or validating is reported as skipped", async () => {
  const f = await fixture();
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker({ ...task, stage: "reviewing" });
    expect(outcome.action).toBe("skipped");
    expect(f.revalidateCalls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
