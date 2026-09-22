import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
  RESTART_QUESTION_ID_PREFIX,
  type RelaunchWorker,
} from "../../src/recovery/central.ts";
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

function endpoint(paneId: string): Endpoint {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId,
    role: "implementer",
    generation: 0,
  };
}

// A job that ran for well beyond the startup grace period by default, so tests that do not care
// about the same-failure-class guard never accidentally trip it on a zero-elapsed, reused fixture.
const DEFAULT_JOB_CREATED_AT = "2030-01-01T00:00:00.000Z";
const DEFAULT_JOB_CONSUMED_AT = "2030-01-01T00:00:30.000Z";

function deadJob(
  input: Readonly<{ error?: string; createdAt?: string; consumedAt?: string }> = {},
): DurableJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "implementer",
    kind: "worker",
    cwd: "/tmp/worktree",
    jobPath: "/tmp/worktree/job.json",
    resultPath: "/tmp/worktree/result.json",
    attempt: 1,
    phase: "failed",
    launchAttempted: true,
    createdAt: input.createdAt ?? DEFAULT_JOB_CREATED_AT,
    consumedAt: input.consumedAt ?? DEFAULT_JOB_CONSUMED_AT,
    error: input.error ?? "worker aborted without a logged reason",
  };
}

type FixtureOptions = Readonly<{
  readonly staleEndpoint?: "alive-then-gone" | "foreign" | "alive-forever" | "already-missing";
  readonly job?: DurableJob;
  readonly recovery?: RuntimeState["tasks"][number]["recovery"];
}>;

async function fixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "tandem-central-recovery-"));
  const worktreePath = join(home, "worktree");
  await mkdir(worktreePath, { recursive: true });
  let now = NOW;
  const clock = (): string => now;
  let id = 0;
  const idFactory = (): string => `id-${++id}`;
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  await store.create({
    id: "task-1",
    repoPath: home,
    kind: "implementation",
    objective: "recover a stuck worker",
    acceptanceCriteria: ["the worker restarts safely"],
    surfaces: ["runtime"],
    policy,
  });
  const staleEndpoints: Endpoint[] =
    options.staleEndpoint === undefined ? [] : [endpoint("pane-stale")];
  await store.update("task-1", 0, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: NOW,
    stage: "implementing",
    scopeApproved: true,
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
      // "process-info" carries its pane id after a "--pane" flag; every other pane action carries
      // it directly as the next positional argument.
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

  const relaunchCalls: { extraInstructions: readonly string[] }[] = [];
  let relaunchOutcome: Readonly<{ readonly relaunched: boolean; readonly reason?: string }> = {
    relaunched: true,
  };
  const relaunchWorker: RelaunchWorker = async (_task, extraInstructions) => {
    relaunchCalls.push({ extraInstructions });
    return relaunchOutcome;
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
    blockTask,
  });

  return {
    home,
    store,
    workflow,
    runtimePath: runtimeFile(home),
    relaunchCalls,
    blockedReasons,
    setRelaunchOutcome: (
      outcome: Readonly<{ readonly relaunched: boolean; readonly reason?: string }>,
    ) => {
      relaunchOutcome = outcome;
    },
    setNow: (value: string) => {
      now = value;
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("a task with nothing owned and no dead job re-enters with restart 1 of 2", async () => {
  const f = await fixture();
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
    expect(f.relaunchCalls[0]?.extraInstructions.join(" ")).toContain("restart 1 of 2");
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.recovery?.restarts).toBe(1);
    expect(state.tasks[0]?.recovery?.restartGeneration).toBe(0);
    const notified = await f.store.read("task-1");
    expect(notified?.notifications.some((entry) => entry.message.includes("restarted it"))).toBe(
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("a proven-failed job re-enters with its own error as the reason and worktree is snapshotted", async () => {
  const f = await fixture({ job: deadJob({ error: "worker timed out after 60000ms" }) });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls[0]?.extraInstructions.join(" ")).toContain(
      "worker timed out after 60000ms",
    );
    const snapshotDirectory = join(f.home, "jobs", "task-1", "0", "recovery-restart-1");
    expect(await readFile(join(snapshotDirectory, "uncommitted.diff"), "utf8")).toContain(
      "diff contents",
    );
    expect(await readFile(join(snapshotDirectory, "untracked-files.txt"), "utf8")).toContain(
      "untracked.txt",
    );
  } finally {
    await f.cleanup();
  }
});

test("a stale endpoint proven stopped via the stop ladder is cleared before re-entry", async () => {
  const f = await fixture({ staleEndpoint: "alive-then-gone", job: deadJob() });
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

test("an already-missing stale endpoint counts as proven dead without a close call", async () => {
  const f = await fixture({ staleEndpoint: "already-missing", job: deadJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
  } finally {
    await f.cleanup();
  }
});

test("a foreign stale endpoint is never touched; central recovery asks instead of restarting", async () => {
  const f = await fixture({ staleEndpoint: "foreign", job: deadJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("asked");
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.endpoints).toHaveLength(1);
    expect(after?.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);
    expect(after?.communication?.revision ?? 0).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("a stale endpoint that never proves stopped is never closed and central recovery asks", async () => {
  const f = await fixture({ staleEndpoint: "alive-forever", job: deadJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("asked");
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.endpoints).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
}, 15_000);

test("the restart budget allows two automatic restarts per generation and asks on the third", async () => {
  const f = await fixture({ job: deadJob() });
  try {
    for (let attempt = 1; attempt <= MAX_AUTOMATIC_RESTARTS_PER_GENERATION; attempt += 1) {
      const task = await f.store.read("task-1");
      if (task === undefined) throw new Error("fixture task missing");
      const outcome = await f.workflow.recoverStuckWorker(task);
      expect(outcome.action).toBe("relaunched");
    }
    const thirdTask = await f.store.read("task-1");
    if (thirdTask === undefined) throw new Error("fixture task missing");
    const third = await f.workflow.recoverStuckWorker(thirdTask);
    expect(third.action).toBe("asked");
    expect(f.relaunchCalls).toHaveLength(MAX_AUTOMATIC_RESTARTS_PER_GENERATION);
    const asked = await f.store.read("task-1");
    expect(asked?.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);
    expect(asked?.communication?.revision ?? 0).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("a repeated same-class failure inside the startup grace window asks instead of restarting again", async () => {
  const f = await fixture({
    job: deadJob({ error: "provider rate limit exceeded", createdAt: NOW, consumedAt: NOW }),
    recovery: {
      schemaVersion: 1,
      recoveryAttempts: 0,
      validationRetries: 0,
      evidenceRepairs: 0,
      restarts: 1,
      restartGeneration: 0,
      lastRestartFailureClass: "provider-unavailable",
      lastRestartAt: NOW,
    },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("asked");
    expect(f.relaunchCalls).toHaveLength(0);
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.recovery?.restarts).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("a restart question offers explicit choices and refuses anything but an exact match", async () => {
  const f = await fixture({ staleEndpoint: "foreign", job: deadJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a restart question to be recorded");
    expect(asked?.communication?.question?.text).toContain('"restart"');
    expect(asked?.communication?.question?.text).toContain('"stop"');
    // No task/generation/job identifiers leak into the plain-English question text itself.
    expect(asked?.communication?.question?.text).not.toContain("task-1");
    expect(asked?.communication?.question?.recommendation).toContain("task task-1");

    // A loose reply that used to be treated as approval ("ok" matches the old regex) is refused
    // outright, and the question is left exactly as it was — no decision, no state change.
    await expect(
      f.workflow.answerRestartQuestion("task-1", questionId, "ok but stop"),
    ).rejects.toThrow(/only accepts "restart" or "stop"/u);
    const untouched = await f.store.read("task-1");
    expect(untouched?.communication?.question?.id).toBe(questionId);
    expect(untouched?.revision).toBe(asked?.revision);
    expect(f.relaunchCalls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test('answering "stop" records a decision without bumping communication.revision', async () => {
  const f = await fixture({ staleEndpoint: "foreign", job: deadJob() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a restart question to be recorded");
    const beforeRevision = asked?.communication?.revision ?? 0;

    await f.workflow.answerRestartQuestion("task-1", questionId, "stop");

    const declined = await f.store.read("task-1");
    expect(declined?.communication?.question).toBeUndefined();
    expect(declined?.communication?.revision ?? 0).toBe(beforeRevision);
    const state = await readRuntimeState(f.runtimePath);
    const decisions = state.tasks[0]?.recoveryDecisions ?? [];
    const decision = decisions.findLast((entry) => entry.questionId === questionId);
    expect(decision?.disposition).toBe("refused");
    // Nothing was re-proven for "stop"; the receipt must not claim ownership/outcome were proven.
    expect(decision?.ownership).toBe("unknown");
    expect(decision?.priorOutcome).toBe("uncertain");
    expect(f.relaunchCalls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test('answering "restart" re-proves death and records what was actually proven, not a blind "yes"', async () => {
  const f = await fixture({ job: deadJob() });
  try {
    const state = await readRuntimeState(f.runtimePath);
    await writeRuntimeState(f.runtimePath, {
      ...state,
      tasks: state.tasks.map((entry) => ({
        ...entry,
        recovery: {
          schemaVersion: 1 as const,
          recoveryAttempts: 0,
          validationRetries: 0,
          evidenceRepairs: 0,
          restarts: MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
          restartGeneration: 0,
        },
      })),
    });
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a restart question to be recorded");
    const beforeRevision = asked?.communication?.revision ?? 0;

    await f.workflow.answerRestartQuestion("task-1", questionId, "restart");

    expect(f.relaunchCalls).toHaveLength(1);
    const approved = await f.store.read("task-1");
    expect(approved?.communication?.question).toBeUndefined();
    expect(approved?.communication?.revision ?? 0).toBe(beforeRevision);
    const after = await readRuntimeState(f.runtimePath);
    expect(after.tasks[0]?.recovery?.restarts).toBe(MAX_AUTOMATIC_RESTARTS_PER_GENERATION + 1);
    const decisions = after.tasks[0]?.recoveryDecisions ?? [];
    const decision = decisions.findLast((entry) => entry.questionId === questionId);
    // These reflect forceOneMoreRestart's own re-proof of death, not the fact that the user said yes.
    expect(decision?.disposition).toBe("applied");
    expect(decision?.ownership).toBe("proven-owned");
    expect(decision?.priorOutcome).toBe("known");
  } finally {
    await f.cleanup();
  }
});

test('answering "restart" that cannot re-prove death is refused, not applied on trust', async () => {
  const f = await fixture({ staleEndpoint: "alive-forever", job: deadJob() });
  try {
    const state = await readRuntimeState(f.runtimePath);
    await writeRuntimeState(f.runtimePath, {
      ...state,
      tasks: state.tasks.map((entry) => ({
        ...entry,
        recovery: {
          schemaVersion: 1 as const,
          recoveryAttempts: 0,
          validationRetries: 0,
          evidenceRepairs: 0,
          restarts: MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
          restartGeneration: 0,
        },
      })),
    });
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a restart question to be recorded");

    await f.workflow.answerRestartQuestion("task-1", questionId, "restart");

    // The stale pane still cannot be proven stopped, so the approval never reaches relaunch.
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await readRuntimeState(f.runtimePath);
    const decisions = after.tasks[0]?.recoveryDecisions ?? [];
    const decision = decisions.findLast((entry) => entry.questionId === questionId);
    expect(decision?.disposition).toBe("refused");
    expect(decision?.ownership).toBe("unknown");
    expect(decision?.priorOutcome).toBe("uncertain");
  } finally {
    await f.cleanup();
  }
}, 25_000);

test("a stage other than implementing or scouting is reported as skipped", async () => {
  const f = await fixture();
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker({ ...task, stage: "reviewing" });
    expect(outcome.action).toBe("skipped");
    expect(f.relaunchCalls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("a relaunch refusal blocks the task with the refusal reason", async () => {
  const f = await fixture({ job: deadJob() });
  f.setRelaunchOutcome({ relaunched: false, reason: "worktree lease could not be reconfirmed" });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("blocked");
    expect(f.blockedReasons.join("\n")).toContain("worktree lease could not be reconfirmed");
  } finally {
    await f.cleanup();
  }
});
