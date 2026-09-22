import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandRequest,
  CommandResult,
  Endpoint,
  ResolvedPolicy,
  ReviewResult,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import { CentralRecoveryWorkflow, RESTART_QUESTION_ID_PREFIX } from "../../src/recovery/central.ts";
import {
  isQuarantinedReviewFailure,
  unresolvedReviewFailure,
} from "../../src/recovery/central-review.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type { DurableJob, RuntimeState } from "../../src/runtime/schema.ts";
import { createTaskStore } from "../../src/tasks/store.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "89abcdef0123456789abcdef0123456789abcdef";

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

function endpoint(paneId: string, role: Endpoint["role"] = "verifier"): Endpoint {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId,
    role,
    generation: 0,
  };
}

function completedReview(lens: "behavior" | "design" | "coverage"): ReviewResult {
  return {
    lens,
    head: HEAD,
    generation: 0,
    pass: true,
    findings: [],
    summary: `${lens} passed`,
    mode: "review_existing_head",
  };
}

function deadReviewJob(
  input: Readonly<{
    lens: "behavior" | "design" | "coverage" | "verification";
    error?: string;
    endpoint?: Endpoint;
  }>,
): DurableJob {
  return {
    schemaVersion: 1,
    id: `${input.lens}-job`,
    taskId: "task-1",
    generation: 0,
    role: input.lens === "verification" ? "verifier" : "reviewer",
    kind: "worker",
    cwd: "/tmp/worktree",
    jobPath: `/tmp/worktree/${input.lens}-job.json`,
    resultPath: `/tmp/worktree/${input.lens}-result.json`,
    attempt: 1,
    phase: "failed",
    launchAttempted: true,
    createdAt: NOW,
    consumedAt: new Date(Date.parse(NOW) + 30_000).toISOString(),
    reviewLens: input.lens,
    head: HEAD,
    error: input.error ?? "owned endpoint disappeared before a durable result was written",
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
  };
}

type FixtureOptions = Readonly<{
  readonly job?: DurableJob;
  readonly staleEndpoint?: "gone" | "foreign" | "alive-forever";
  readonly worktreeHead?: string;
  readonly restarts?: number;
  readonly restartGeneration?: number;
}>;

async function fixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "tandem-central-review-"));
  const worktreePath = join(home, "worktree");
  await mkdir(worktreePath, { recursive: true });
  const clock = (): string => NOW;
  let id = 0;
  const idFactory = (): string => `id-${++id}`;
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  await store.create({
    id: "task-1",
    repoPath: home,
    kind: "implementation",
    objective: "recover a stuck reviewer",
    acceptanceCriteria: ["review completes safely"],
    surfaces: ["runtime"],
    policy,
  });
  await store.update("task-1", 0, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: NOW,
    stage: "reviewing",
    scopeApproved: true,
    worktree: lease(worktreePath),
    reviewHead: HEAD,
    reviews: [completedReview("behavior"), completedReview("design"), completedReview("coverage")],
  }));

  const stalePaneId = "pane-stale";
  const pane = {
    present: options.staleEndpoint !== undefined,
    alive: options.staleEndpoint === "alive-forever",
  };
  const foreign = options.staleEndpoint === "foreign";
  const worktreeHead = options.worktreeHead ?? HEAD;

  const run = async (request: CommandRequest): Promise<CommandResult> => {
    if (request.argv[0] === "git") {
      if (request.argv.includes("rev-parse")) return result(`${worktreeHead}\n`);
      if (request.argv.includes("diff") && request.argv.includes("--name-only")) return result("");
      if (request.argv.includes("diff")) return result("");
      if (request.argv.includes("status")) return result("");
      return result();
    }
    if (request.argv[0] === "kill") return result();
    if (request.argv[0] === "herdr") {
      const words = request.argv.slice(3);
      const action = words[0] === "pane" ? words[1] : undefined;
      const paneId = action === "process-info" ? words[3] : words[2];
      if (action === undefined || paneId !== stalePaneId) {
        return result(JSON.stringify({ result: { type: "ok" } }));
      }
      if (!pane.present)
        return result("", 1, JSON.stringify({ error: { code: "pane_not_found" } }));
      if (action === "get") {
        return result(
          JSON.stringify({
            result: {
              pane: {
                pane_id: stalePaneId,
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
                pane_id: stalePaneId,
                shell_pid: 100,
                foreground_processes: pane.alive ? [{ pid: 101, name: "omp" }] : [],
              },
            },
          }),
        );
      }
      if (action === "close") {
        pane.present = false;
        return result(JSON.stringify({ result: { type: "ok" } }));
      }
      return result(JSON.stringify({ result: { type: "ok" } }));
    }
    return result();
  };

  const job = options.job ?? deadReviewJob({ lens: "verification" });
  const runtime: RuntimeState = {
    schemaVersion: 1,
    presentations: [],
    tasks: [
      {
        schemaVersion: 1,
        taskId: "task-1",
        sourceCheckpoint: { head: HEAD, base: HEAD, diff: "", dirty: false, unmerged: false },
        taskName: "task-1",
        worktree: lease(worktreePath),
        endpoints: options.staleEndpoint === undefined ? [] : [endpoint(stalePaneId)],
        jobs: [job],
        reviewMode: "review_existing_head",
        operation: {
          schemaVersion: 1,
          id: "operation-dead",
          taskId: "task-1",
          kind: job.role === "verifier" ? "verification" : "review",
          role: job.role,
          generation: 0,
          inputHead: HEAD,
          policyDigest: "policy-digest",
          instructionRevision: 0,
          jobId: job.id,
          phase: "quarantined",
          fencingRevision: 1,
          claimOwner: "test-controller",
          createdAt: NOW,
          effects: [],
          ...(job.error === undefined ? {} : { error: job.error }),
        },
        ...(options.restarts === undefined
          ? {}
          : {
              recovery: {
                schemaVersion: 1,
                recoveryAttempts: 0,
                validationRetries: 0,
                evidenceRepairs: 0,
                restarts: options.restarts,
                restartGeneration: options.restartGeneration ?? 0,
              },
            }),
      },
    ],
  };
  await writeRuntimeState(runtimeFile(home), runtime);

  const getTask = async (taskId: string): Promise<TaskRecord> => {
    const current = await store.read(taskId);
    if (current === undefined) throw new Error(`task ${taskId} is missing`);
    return current;
  };

  const removedEndpoints: string[] = [];
  const removeEndpoint = async (_taskId: string, paneId: string): Promise<void> => {
    removedEndpoints.push(paneId);
  };

  const relaunchReviewerCalls: TaskRecord[] = [];
  const relaunchReviewer = async (task: TaskRecord): Promise<void> => {
    relaunchReviewerCalls.push(task);
  };

  const blockedReasons: string[] = [];
  const blockTask = async (_taskId: string, reason: string): Promise<void> => {
    blockedReasons.push(reason);
  };

  const relaunchWorker = async (): Promise<{ relaunched: boolean; reason?: string }> => ({
    relaunched: false,
    reason: "not used by reviewing tests",
  });

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
    removeEndpoint,
    relaunchReviewer,
  });

  return {
    home,
    store,
    workflow,
    runtimePath: runtimeFile(home),
    removedEndpoints,
    relaunchReviewerCalls,
    blockedReasons,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("unresolvedReviewFailure ignores a lens a newer job already completed, but reports a still-dead lens", async () => {
  const f = await fixture();
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const supersededByRecordedReview = deadReviewJob({ lens: "behavior" });
    const stillDead = deadReviewJob({ lens: "verification" });
    const runtimeState = (await readRuntimeState(f.runtimePath)).tasks[0];
    if (runtimeState === undefined) throw new Error("fixture runtime missing");
    const found = unresolvedReviewFailure(task, {
      ...runtimeState,
      jobs: [supersededByRecordedReview, stillDead],
    });
    expect(found?.id).toBe(stillDead.id);
  } finally {
    await f.cleanup();
  }
});

test("isQuarantinedReviewFailure only matches the exact durable-quarantine reasons", () => {
  expect(
    isQuarantinedReviewFailure(
      deadReviewJob({
        lens: "verification",
        error: "owned endpoint disappeared before a durable result was written",
      }),
    ),
  ).toBe(true);
  expect(
    isQuarantinedReviewFailure(
      deadReviewJob({
        lens: "verification",
        error: "worker stopped without a durable result: timeout",
      }),
    ),
  ).toBe(true);
  expect(
    isQuarantinedReviewFailure(
      deadReviewJob({
        lens: "verification",
        error: "review worker completed without complete review identity",
      }),
    ),
  ).toBe(false);
  expect(
    isQuarantinedReviewFailure(
      deadReviewJob({
        lens: "verification",
        error:
          "stale worker instruction: review result was launched for an older instruction revision",
      }),
    ),
  ).toBe(false);
});

test("a quarantined dead lens with no owned endpoint is relaunched with restart 1 of 2", async () => {
  const f = await fixture();
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchReviewerCalls).toHaveLength(1);
    const state = await readRuntimeState(f.runtimePath);
    expect(state.tasks[0]?.recovery?.restarts).toBe(1);
    // The stale quarantined operation is settled so the replacement attempt's own routing reads a
    // known-safe prior outcome rather than pausing on an uncertain one.
    expect(state.tasks[0]?.operation?.phase).toBe("failed");
    const notified = await f.store.read("task-1");
    expect(notified?.notifications.some((entry) => entry.message.includes("verification"))).toBe(
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("a genuine (non-quarantine) review failure is skipped and left for advanceReview to block", async () => {
  const f = await fixture({
    job: deadReviewJob({
      lens: "verification",
      error: "review worker completed without complete review identity",
    }),
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("skipped");
    expect(f.relaunchReviewerCalls).toHaveLength(0);
    expect(f.blockedReasons).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("a stale reviewer endpoint proven stopped is cleared before re-entry", async () => {
  const f = await fixture({ staleEndpoint: "gone" });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.removedEndpoints).toContain("pane-stale");
  } finally {
    await f.cleanup();
  }
});

test("a foreign reviewer endpoint is never touched; central recovery asks instead of restarting", async () => {
  const f = await fixture({ staleEndpoint: "foreign" });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("asked");
    expect(f.relaunchReviewerCalls).toHaveLength(0);
    expect(f.removedEndpoints).toHaveLength(0);
    const asked = await f.store.read("task-1");
    expect(asked?.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a worktree that no longer matches the reviewed HEAD is never relaunched against; central recovery asks", async () => {
  const f = await fixture({ worktreeHead: OTHER_HEAD });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("asked");
    expect(f.relaunchReviewerCalls).toHaveLength(0);
    const asked = await f.store.read("task-1");
    expect(asked?.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("the reviewing restart budget allows two automatic restarts per generation and asks on the third", async () => {
  const f = await fixture({ restarts: 2, restartGeneration: 0 });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("asked");
    expect(f.relaunchReviewerCalls).toHaveLength(0);
    const asked = await f.store.read("task-1");
    expect(asked?.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test('answering "restart" for a reviewing question resumes and relaunches once more', async () => {
  const f = await fixture({ staleEndpoint: "foreign" });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    expect(asked?.stage).toBe("blocked");
    expect(asked?.previousStage).toBe("reviewing");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a restart question to be recorded");

    // The pane is no longer foreign by the time the user answers; re-proof must succeed.
    const state = await readRuntimeState(f.runtimePath);
    await writeRuntimeState(f.runtimePath, {
      ...state,
      tasks: state.tasks.map((entry) => ({
        ...entry,
        endpoints: [],
      })),
    });

    await f.workflow.answerRestartQuestion("task-1", questionId, "restart");

    expect(f.relaunchReviewerCalls).toHaveLength(1);
    const approved = await f.store.read("task-1");
    expect(approved?.stage).toBe("reviewing");
    expect(approved?.communication?.question).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test('answering "stop" for a reviewing question records a decision without relaunching', async () => {
  const f = await fixture({ staleEndpoint: "foreign" });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    await f.workflow.recoverStuckWorker(task);
    const asked = await f.store.read("task-1");
    const questionId = asked?.communication?.question?.id;
    if (questionId === undefined) throw new Error("expected a restart question to be recorded");

    await f.workflow.answerRestartQuestion("task-1", questionId, "stop");

    const declined = await f.store.read("task-1");
    expect(declined?.communication?.question).toBeUndefined();
    expect(declined?.stage).toBe("blocked");
    expect(f.relaunchReviewerCalls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
