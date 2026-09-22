import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BlockCause,
  blockCause,
  type CommandRequest,
  type CommandResult,
  type ResolvedPolicy,
  type TaskRecord,
  type WorktreeLease,
} from "../../src/contracts.ts";
import {
  CentralRecoveryWorkflow,
  canCentralRecoverBlockedTask,
  MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
  type RelaunchWorker,
  type RevalidateWorker,
} from "../../src/recovery/central.ts";
import { runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type { RuntimeState } from "../../src/runtime/schema.ts";
import { createTaskStore } from "../../src/tasks/store.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const BASE_HEAD = "base-1";
const NEW_HEAD = "head-2";
const BRANCH = "task/task-1";

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
    setupCommands: [],
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
    baseHead: BASE_HEAD,
    branch: BRANCH,
    leaseId: "lease-1",
    leaseHolder: "session-1",
    leasedAt: NOW,
  };
}

/** The worktree git state a fixture's fake `run` reports for `readCheckpoint` and central
 *  recovery's own extra adopt-commit checks (current branch, ancestry) and mutates in response to
 *  `pointTaskBranchAtCommit`'s own branch/switch commands, so a detached-HEAD adoption can be
 *  observed actually landing on the task branch afterward. `branch: ""` models a detached worktree.
 *  `existingBranchHead`/`existingBranchIsAncestor` model whether the task's own branch ref already
 *  exists in this worktree and, if so, whether it descends from the adopted commit. */
type GitState = {
  head: string;
  dirty: boolean;
  unmergedFiles: boolean;
  branch: string;
  isAncestor: boolean;
  existingBranchHead?: string;
  existingBranchIsAncestor?: boolean;
};

function cleanAdoptableGit(): GitState {
  return { head: NEW_HEAD, dirty: false, unmergedFiles: false, branch: BRANCH, isAncestor: true };
}

function detachedAdoptableGit(overrides: Partial<GitState> = {}): GitState {
  return {
    head: NEW_HEAD,
    dirty: false,
    unmergedFiles: false,
    branch: "",
    isAncestor: true,
    ...overrides,
  };
}

function gitRunFor(git: GitState) {
  return async (request: CommandRequest): Promise<CommandResult> => {
    const argv = request.argv;
    if (argv[0] !== "git") return result();
    if (argv.includes("rev-parse") && argv.includes("--verify")) {
      return git.existingBranchHead === undefined
        ? result("", 1, "unknown revision or path not in the working tree")
        : result(`${git.existingBranchHead}\n`);
    }
    if (argv.includes("rev-parse") && argv.at(-1) === "HEAD") return result(`${git.head}\n`);
    if (argv.includes("rev-parse")) return result(`${argv.at(-1)}\n`);
    if (argv.includes("diff") && argv.includes("--name-only")) {
      return result(git.unmergedFiles ? "conflict.txt\n" : "");
    }
    if (argv.includes("diff")) return result("diff contents\n");
    if (argv.includes("status")) return result(git.dirty ? " M file.txt\n" : "");
    if (argv.includes("branch") && argv.includes("--show-current"))
      return result(`${git.branch}\n`);
    if (argv.includes("branch") && argv.includes("--force")) {
      const forced = argv.at(-1);
      if (forced !== undefined) git.existingBranchHead = forced;
      return result();
    }
    if (argv.includes("switch")) {
      const createIndex = argv.indexOf("--create");
      if (createIndex !== -1) {
        git.branch = argv[createIndex + 1] ?? git.branch;
        git.head = argv.at(-1) ?? git.head;
        git.existingBranchHead = git.head;
      } else {
        git.branch = argv.at(-1) ?? git.branch;
        git.head = git.existingBranchHead ?? git.head;
      }
      return result();
    }
    if (argv.includes("symbolic-ref")) return result(`${git.branch}\n`);
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) {
      const from = argv.at(-2);
      if (from === git.existingBranchHead) return result("", git.existingBranchIsAncestor ? 0 : 1);
      return result("", git.isAncestor ? 0 : 1);
    }
    if (argv.includes("ls-files")) return result("untracked.txt\n");
    return result();
  };
}

type FixtureOptions = Readonly<{
  readonly stage?: TaskRecord["stage"];
  readonly previousStage?: TaskRecord["stage"];
  readonly blockCause?: BlockCause;
  readonly blockReason?: string;
  readonly question?: TaskRecord["communication"];
  readonly stopRequest?: RuntimeState["tasks"][number]["stopRequest"];
  readonly recovery?: RuntimeState["tasks"][number]["recovery"];
  readonly git?: GitState;
  readonly reviewHead?: string;
}>;

async function fixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "tandem-central-recover-blocked-"));
  const worktreePath = join(home, "worktree");
  await mkdir(worktreePath, { recursive: true });
  const now = NOW;
  const clock = (): string => now;
  let id = 0;
  const idFactory = (): string => `id-${++id}`;
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  const created = await store.create({
    id: "task-1",
    repoPath: home,
    kind: "implementation",
    objective: "adopt a finished commit",
    acceptanceCriteria: ["the worker's finished commit is adopted"],
    surfaces: ["runtime"],
    policy,
  });
  await store.update("task-1", created.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: NOW,
    stage: options.stage ?? "implementing",
    scopeApproved: true,
    worktree: lease(worktreePath),
    endpoints: [],
    ...(options.previousStage === undefined ? {} : { previousStage: options.previousStage }),
    ...(options.blockCause === undefined ? {} : { blockCause: options.blockCause }),
    ...(options.blockReason === undefined ? {} : { blockReason: options.blockReason }),
    ...(options.question === undefined ? {} : { communication: options.question }),
    ...(options.reviewHead === undefined ? {} : { reviewHead: options.reviewHead }),
  }));

  const runtime: RuntimeState = {
    schemaVersion: 1,
    presentations: [],
    tasks: [
      {
        schemaVersion: 1,
        taskId: "task-1",
        sourceCheckpoint: {
          head: BASE_HEAD,
          base: BASE_HEAD,
          diff: "",
          dirty: false,
          unmerged: false,
        },
        taskName: "task-1",
        worktree: lease(worktreePath),
        endpoints: [],
        jobs: [],
        ...(options.stopRequest === undefined ? {} : { stopRequest: options.stopRequest }),
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      },
    ],
  };
  await writeRuntimeState(runtimeFile(home), runtime);

  const run = gitRunFor(options.git ?? cleanAdoptableGit());
  const getTask = async (taskId: string): Promise<TaskRecord> => {
    const current = await store.read(taskId);
    if (current === undefined) throw new Error(`task ${taskId} is missing`);
    return current;
  };

  const relaunchCalls: { extraInstructions: readonly string[] }[] = [];
  const relaunchWorker: RelaunchWorker = async (_task, extraInstructions) => {
    relaunchCalls.push({ extraInstructions });
    return { relaunched: true };
  };
  const revalidateCalls: TaskRecord[] = [];
  const revalidate: RevalidateWorker = async (task) => {
    revalidateCalls.push(task);
    return { started: true };
  };
  const blockedReasons: string[] = [];
  const blockTask = async (_taskId: string, reason: string): Promise<void> => {
    blockedReasons.push(reason);
  };
  const removeEndpoint = async (): Promise<void> => {};
  const relaunchReviewerCalls: TaskRecord[] = [];
  const relaunchReviewer = async (task: TaskRecord): Promise<void> => {
    relaunchReviewerCalls.push(task);
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
    removeEndpoint,
    relaunchReviewer,
  });

  return {
    home,
    store,
    workflow,
    runtimePath: runtimeFile(home),
    relaunchCalls,
    revalidateCalls,
    blockedReasons,
    relaunchReviewerCalls,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

// --- Gap 1: eligibility (`canCentralRecoverBlockedTask`) -------------------------------------

test("a blocked task with a lost-resource cause and a wired previous stage is eligible", () => {
  const task = {
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("resource-lost", { summary: "s", detail: "d" }),
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(true);
});

test("a blocked task with a user-decision cause is never eligible", () => {
  const task = {
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("explicit-block", { summary: "s", detail: "d" }),
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(false);
});

test("a blocked task with a safety-stop cause is never eligible", () => {
  const task = {
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("ownership-unprovable", { summary: "s", detail: "d" }),
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(false);
});

test("a blocked task with a review-lens-failed cause is never eligible (a lens that ran and reported its own failure)", () => {
  const task = {
    stage: "blocked",
    previousStage: "reviewing",
    blockCause: blockCause("review-lens-failed", { summary: "s", detail: "d" }),
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(false);
});

test("a legacy free-text stale-worker-instruction block with no typed cause is eligible", () => {
  const task = {
    stage: "blocked",
    previousStage: "implementing",
    blockReason: "stale worker instruction: worker result omitted canonical instruction revision",
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(true);
});

test("legacy free text that does not match a worker-death shape is never eligible", () => {
  const task = {
    stage: "blocked",
    previousStage: "implementing",
    blockReason: "the user asked to pause this task for review",
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(false);
});

test("a task explicitly paused by a user is never eligible (not blocked)", () => {
  const task = {
    stage: "paused",
    previousStage: "implementing",
    blockReason: "worker stopped without a durable result",
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(false);
});

test("an unanswered non-recovery question blocks eligibility", () => {
  const task = {
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("worker-failed", { summary: "s", detail: "d" }),
    communication: { revision: 1, messages: [], question: { id: "user-question-1", text: "?" } },
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(false);
});

test("an unanswered recovery question does not block eligibility", () => {
  const task = {
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("worker-failed", { summary: "s", detail: "d" }),
    communication: {
      revision: 1,
      messages: [],
      question: { id: "recovery-restart-abc", text: "?" },
    },
  } as unknown as TaskRecord;
  expect(canCentralRecoverBlockedTask(task, undefined)).toBe(true);
});

test("a pending stop request blocks eligibility", () => {
  const task = {
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("worker-failed", { summary: "s", detail: "d" }),
  } as unknown as TaskRecord;
  const runtime = { stopRequest: { requestedAt: NOW } } as unknown as Parameters<
    typeof canCentralRecoverBlockedTask
  >[1];
  expect(canCentralRecoverBlockedTask(task, runtime)).toBe(false);
});

// --- Gap 1: `recoverBlockedTask` re-entry ---------------------------------------------------

test("a blocked task with a recoverable cause re-enters and relaunches (no finished commit to adopt)", async () => {
  const f = await fixture({
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("resource-lost", { summary: "the pane vanished", detail: "d" }),
    git: { head: BASE_HEAD, dirty: false, unmergedFiles: false, branch: BRANCH, isAncestor: true },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverBlockedTask(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("implementing");
  } finally {
    await f.cleanup();
  }
});

test("a blocked task with a legacy stale-worker-instruction block re-enters and adopts its finished commit", async () => {
  const f = await fixture({
    stage: "blocked",
    previousStage: "implementing",
    blockReason: "stale worker instruction: worker result omitted canonical instruction revision",
    git: cleanAdoptableGit(),
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverBlockedTask(task);
    expect(outcome.action).toBe("adopted");
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("validating");
    expect(after?.reviewHead).toBe(NEW_HEAD);
  } finally {
    await f.cleanup();
  }
});

test("a blocked task with a user-decision cause is left exactly as blocked", async () => {
  const f = await fixture({
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("explicit-block", { summary: "the user paused this", detail: "d" }),
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverBlockedTask(task);
    expect(outcome.action).toBe("skipped");
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("blocked");
  } finally {
    await f.cleanup();
  }
});

test("a blocked task with a safety-stop cause is left exactly as blocked", async () => {
  const f = await fixture({
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("runtime-metadata-missing", { summary: "lost state", detail: "d" }),
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverBlockedTask(task);
    expect(outcome.action).toBe("skipped");
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("blocked");
  } finally {
    await f.cleanup();
  }
});

test("a task the user explicitly paused is left untouched", async () => {
  const f = await fixture({ stage: "paused", previousStage: "implementing" });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverBlockedTask(task);
    expect(outcome.action).toBe("skipped");
  } finally {
    await f.cleanup();
  }
});

test("the per-generation restart budget is respected when re-entering a blocked task: asks once spent", async () => {
  const f = await fixture({
    stage: "blocked",
    previousStage: "implementing",
    blockCause: blockCause("worker-failed", { summary: "the worker died", detail: "d" }),
    recovery: {
      schemaVersion: 1,
      recoveryAttempts: 0,
      validationRetries: 0,
      evidenceRepairs: 0,
      restarts: MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
      restartGeneration: 0,
    },
    // Not adoptable (still at base), so the normal restart-budget path applies.
    git: { head: BASE_HEAD, dirty: false, unmergedFiles: false, branch: BRANCH, isAncestor: true },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverBlockedTask(task);
    expect(outcome.action).toBe("asked");
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("blocked");
    expect(after?.communication?.question).toBeDefined();
  } finally {
    await f.cleanup();
  }
});

// --- Gap 2: adopt-commit ---------------------------------------------------------------------

test("a clean worktree strictly ahead of base is adopted: reviewHead is set and the task advances", async () => {
  const f = await fixture({ stage: "implementing", git: cleanAdoptableGit() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("adopted");
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("validating");
    expect(after?.reviewHead).toBe(NEW_HEAD);
    expect(after?.reportPath).toBeDefined();
    expect(
      after?.notifications.some((entry) => entry.message.includes("sending that commit to checks")),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a dirty worktree falls back to the ordinary relaunch instead of adopting", async () => {
  const f = await fixture({
    stage: "implementing",
    git: { head: NEW_HEAD, dirty: true, unmergedFiles: false, branch: BRANCH, isAncestor: true },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("implementing");
    expect(after?.reviewHead).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("an unmerged worktree falls back to the ordinary relaunch instead of adopting", async () => {
  const f = await fixture({
    stage: "implementing",
    git: { head: NEW_HEAD, dirty: false, unmergedFiles: true, branch: BRANCH, isAncestor: true },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("HEAD equal to base (nothing committed) falls back to the ordinary relaunch instead of adopting", async () => {
  const f = await fixture({
    stage: "implementing",
    git: { head: BASE_HEAD, dirty: false, unmergedFiles: false, branch: BRANCH, isAncestor: true },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a HEAD already recorded as the reviewed HEAD is never re-adopted", async () => {
  const f = await fixture({
    stage: "implementing",
    reviewHead: NEW_HEAD,
    git: cleanAdoptableGit(),
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a checkout not on the task's own branch is never adopted", async () => {
  const f = await fixture({
    stage: "implementing",
    git: {
      head: NEW_HEAD,
      dirty: false,
      unmergedFiles: false,
      branch: "some-other-branch",
      isAncestor: true,
    },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a HEAD not descended from base is never adopted", async () => {
  const f = await fixture({
    stage: "implementing",
    git: { head: NEW_HEAD, dirty: false, unmergedFiles: false, branch: BRANCH, isAncestor: false },
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

// --- Gap 2 follow-up: a detached HEAD, exactly the live incident's shape --------------------

test("a detached HEAD with no task branch yet is adopted: the branch is created, reviewHead is set, and the task advances", async () => {
  const f = await fixture({
    stage: "implementing",
    // The task branch does not exist as a ref yet (existingBranchHead undefined): the worker
    // committed straight onto a detached checkout without ever creating it.
    git: detachedAdoptableGit(),
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("adopted");
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("validating");
    expect(after?.reviewHead).toBe(NEW_HEAD);
    expect(
      after?.notifications.some((entry) => entry.message.includes("sending that commit to checks")),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a detached HEAD whose task branch already exists and is an ancestor is adopted: the branch is fast-forwarded", async () => {
  const f = await fixture({
    stage: "implementing",
    git: detachedAdoptableGit({ existingBranchHead: BASE_HEAD, existingBranchIsAncestor: true }),
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("adopted");
    expect(f.relaunchCalls).toHaveLength(0);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("validating");
    expect(after?.reviewHead).toBe(NEW_HEAD);
  } finally {
    await f.cleanup();
  }
});

test("adoption while already on the task's own branch (not detached) still works", async () => {
  const f = await fixture({ stage: "implementing", git: cleanAdoptableGit() });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("adopted");
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("validating");
    expect(after?.reviewHead).toBe(NEW_HEAD);
  } finally {
    await f.cleanup();
  }
});

test("a detached HEAD whose task branch already exists but diverged is never adopted; falls back to relaunch", async () => {
  const f = await fixture({
    stage: "implementing",
    // The task branch exists but points somewhere the adopted commit does not descend from: forcing
    // it would discard real work, so adoption must refuse and fall back to the ordinary relaunch.
    git: detachedAdoptableGit({
      existingBranchHead: "some-other-commit",
      existingBranchIsAncestor: false,
    }),
  });
  try {
    const task = await f.store.read("task-1");
    if (task === undefined) throw new Error("fixture task missing");
    const outcome = await f.workflow.recoverStuckWorker(task);
    expect(outcome.action).toBe("relaunched");
    expect(f.relaunchCalls).toHaveLength(1);
    const after = await f.store.read("task-1");
    expect(after?.stage).toBe("implementing");
    expect(after?.reviewHead).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});
