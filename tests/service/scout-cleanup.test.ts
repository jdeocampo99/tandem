import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AdapterProtocolError,
  EndpointOwnershipError,
  LeaseSafetyError,
} from "../../src/adapters/primitives.ts";
import type {
  CommandRequest,
  CommandResult,
  Endpoint,
  ResearchContinuationDisposition,
  ResolvedPolicy,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import {
  readRuntimeState,
  runtimeFile,
  writeJsonAtomically,
  writeRuntimeState,
} from "../../src/runtime/persistence.ts";
import type { DurableJob, DurableOperation, RuntimeState } from "../../src/runtime/schema.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import {
  classifyCleanupFailure,
  closeFinishedScoutPanes,
  decideScoutCleanupEligibility,
  decideScoutWorktreeRelease,
  finishPendingScoutCleanup,
  runCleanupCommands,
} from "../../src/service/scout-cleanup.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { type WorkerTerminalState, writeWorkerTerminal } from "../../src/workers/terminal.ts";

const TIMESTAMP = "2030-01-01T00:00:00.000Z";
const SOURCE_HEAD = "source-head";
const SOURCE_CHECKPOINT = {
  head: SOURCE_HEAD,
  base: SOURCE_HEAD,
  diff: "",
  dirty: false,
  unmerged: false,
} as const;
const TASK_BRANCH = "tandem/task-1";

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
    validationCommands: [],
    setupCommands: [],
    maxFixRounds: 1,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

type World = {
  panePresent: boolean;
  paneActive: boolean;
  /** A live worker in the pane exits on ctrl+d. */
  workerAcceptsClose: boolean;
  paneWorkspaceId: string;
  paneCloseCode: number;
  leaseHeld: boolean;
  leaseReturnCode: number;
  head: string;
  branch: string;
  dirty: boolean;
  unmerged: boolean;
  readonly closedPanes: string[];
  readonly returnedLeases: string[];
};

function newWorld(overrides: Partial<World> = {}): World {
  return {
    panePresent: true,
    paneActive: false,
    workerAcceptsClose: false,
    paneWorkspaceId: "workspace-1",
    paneCloseCode: 0,
    leaseHeld: true,
    leaseReturnCode: 0,
    head: SOURCE_HEAD,
    branch: TASK_BRANCH,
    dirty: false,
    unmerged: false,
    closedPanes: [],
    returnedLeases: [],
    ...overrides,
  };
}

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function leaseFor(home: string): WorktreeLease {
  return {
    root: join(home, "pool"),
    path: join(home, "pool", "task-1"),
    name: "tandem-task-1",
    baseHead: SOURCE_HEAD,
    branch: TASK_BRANCH,
    leaseId: "lease-1",
    leaseHolder: "session-1:task-1",
    leasedAt: TIMESTAMP,
  };
}

function endpointFor(): Endpoint {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
    role: "scout",
    generation: 0,
  };
}

/** A Herdr/Treehouse/Git boundary that answers only the commands terminal cleanup issues. */
function worldRunner(world: World, lease: WorktreeLease) {
  return async (request: CommandRequest): Promise<CommandResult> => {
    const argv = request.argv;
    if (argv[0] === "herdr") {
      const paneId = argv.at(-1) ?? "";
      if (argv.includes("pane") && argv.includes("get")) {
        if (!world.panePresent) {
          return {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "pane_not_found" } }),
          };
        }
        return ok(
          JSON.stringify({
            result: {
              pane: {
                pane_id: paneId,
                tab_id: "tab-1",
                workspace_id: world.paneWorkspaceId,
                foreground_cwd: request.cwd,
              },
            },
          }),
        );
      }
      if (argv.includes("pane") && argv.includes("process-info")) {
        return ok(
          JSON.stringify({
            result: {
              process_info: {
                pane_id: paneId,
                foreground_processes: world.paneActive
                  ? [{ pid: 100, name: "omp", argv: ["omp"] }]
                  : [],
              },
            },
          }),
        );
      }
      if (argv.includes("send-keys") && argv.at(-1) === "ctrl+d") {
        if (world.workerAcceptsClose) world.paneActive = false;
        return ok();
      }
      if (argv.includes("pane") && argv.includes("close")) {
        if (world.paneCloseCode !== 0) {
          return { code: world.paneCloseCode, stdout: "", stderr: "herdr refused to close" };
        }
        world.panePresent = false;
        world.closedPanes.push(paneId);
        return ok();
      }
      return ok();
    }
    if (argv[0] === "treehouse") {
      if (argv.includes("status")) {
        return ok(
          JSON.stringify(
            world.leaseHeld
              ? [
                  {
                    name: lease.name,
                    path: lease.path,
                    status: "leased",
                    flavor: "git",
                    lease_id: lease.leaseId,
                    lease_holder: lease.leaseHolder,
                    leased_at: lease.leasedAt,
                    processes: [],
                  },
                ]
              : [],
          ),
        );
      }
      if (argv.includes("return")) {
        if (world.leaseReturnCode !== 0) {
          return {
            code: world.leaseReturnCode,
            stdout: "",
            stderr: "treehouse refused the return",
          };
        }
        world.leaseHeld = false;
        world.returnedLeases.push(lease.path);
        return ok();
      }
      return ok();
    }
    if (argv[0] === "git") {
      const path = argv[2] ?? request.cwd;
      if (argv.includes("rev-parse")) {
        const target = argv.at(-1);
        if (target === "HEAD") return ok(path === lease.path ? world.head : SOURCE_HEAD);
        if (target === "--git-common-dir") return ok(path);
        return ok(target ?? "");
      }
      if (argv.includes("branch") && argv.includes("--show-current")) return ok(world.branch);
      if (argv.includes("status")) return ok(world.dirty ? "?? scratch-notes.txt\n" : "");
      if (argv.includes("--diff-filter=U")) return ok(world.unmerged ? "conflict.txt\n" : "");
      if (argv.includes("merge-base")) return ok();
      if (argv.includes("diff")) return ok();
    }
    if (argv[0] === "omp" && argv[1] === "models") return ok(JSON.stringify({ models: [] }));
    throw new Error(`unexpected command ${JSON.stringify(argv)}`);
  };
}

/** Plays the worker extension's side of a close request: it answers with the closing phase. */
function answerCloseRequests(job: DurableJob): () => void {
  const timer = setInterval(async () => {
    const command = await readFile(`${job.jobPath}.terminal.json.command`, "utf8").catch(() => "");
    if (command === "") return;
    const commandId = (JSON.parse(command) as { id: string }).id;
    await writeScoutTerminal(job, { phase: "closing", completed: true, commandId });
  }, 10);
  return () => clearInterval(timer);
}

async function writeScoutTerminal(
  job: DurableJob,
  state: Pick<WorkerTerminalState, "phase" | "completed" | "commandId">,
): Promise<void> {
  await writeWorkerTerminal(job.jobPath, {
    schemaVersion: 1,
    jobId: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: "scout",
    cwd: job.cwd,
    pid: 100,
    heartbeatAt: new Date().toISOString(),
    ...state,
  });
}

function scoutJob(home: string, endpoint: Endpoint, phase: DurableJob["phase"]): DurableJob {
  const directory = join(home, "jobs", "task-1", "0", "job-1");
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "scout",
    kind: "worker",
    cwd: join(home, "pool", "task-1"),
    jobPath: join(directory, "job.json"),
    resultPath: join(directory, "result.json"),
    attempt: 1,
    phase,
    launchAttempted: true,
    createdAt: TIMESTAMP,
    endpoint,
  };
}

function scoutOperation(job: DurableJob, task: TaskRecord): DurableOperation {
  return {
    schemaVersion: 1,
    id: `${job.id}-operation`,
    taskId: job.taskId,
    kind: "scout",
    role: "scout",
    generation: job.generation,
    inputHead: SOURCE_HEAD,
    policyDigest: createHash("sha256").update(JSON.stringify(task.policy)).digest("hex"),
    instructionRevision: 0,
    jobId: job.id,
    phase: "finalizing",
    fencingRevision: 1,
    claimOwner: "seeded-controller",
    createdAt: TIMESTAMP,
    effects: [],
  };
}

type Fixture = Readonly<{
  readonly home: string;
  readonly repoPath: string;
  readonly lease: WorktreeLease;
  readonly endpoint: Endpoint;
  readonly world: World;
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
  readonly service: TandemService;
  readonly newService: () => TandemService;
}>;

type FixtureOptions = Readonly<{
  readonly stage?: TaskRecord["stage"];
  /** Defaults to report-only, so the settled scout has no implementation to keep its worktree for. */
  readonly disposition?: ResearchContinuationDisposition;
  readonly world?: Partial<World>;
}>;

/**
 * Seeds one scout whose worker already finished: a report on disk, a consumed job, a held lease,
 * and a stopped pane. Cleanup is the only thing left to happen.
 */
async function settledScoutFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "tandem-scout-cleanup-"));
  const repoPath = join(home, "repo");
  const lease = leaseFor(home);
  await mkdir(repoPath, { recursive: true });
  await mkdir(lease.path, { recursive: true });
  const clock = (): string => TIMESTAMP;
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory: () => "seed" });
  const endpoint = endpointFor();
  const job = scoutJob(home, endpoint, "consumed");
  const reportPath = join(dirname(job.jobPath), "report.txt");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, "Outcome: completed\nThe authentication boundary is here.\n", "utf8");

  const created = await store.create({
    id: "task-1",
    repoPath,
    kind: "scout",
    objective: "map the authentication boundary",
    acceptanceCriteria: ["report entry points"],
    surfaces: ["service"],
    policy,
    researchContinuation: {
      schemaVersion: 1,
      disposition: options.disposition ?? "report-only",
      selectedBy: "explicit",
    },
  });
  const stage = options.stage ?? "completed";
  const started = await store.update(created.id, created.revision, (task) =>
    transitionTask(
      task,
      { type: "start", worktree: lease, endpoints: [endpoint] },
      { now: TIMESTAMP, notificationId: "start-1" },
    ),
  );
  const task = await store.update(started.id, started.revision, (current) =>
    stage === "completed"
      ? transitionTask(
          current,
          { type: "scout-report-complete", reportPath, generation: 0 },
          { now: TIMESTAMP, notificationId: "complete-1" },
        )
      : stage === "cancelled"
        ? transitionTask(
            current,
            { type: "cancel", reason: "superseded" },
            { now: TIMESTAMP, notificationId: "cancel-1" },
          )
        : stage === "paused"
          ? transitionTask(
              current,
              { type: "pause", reason: "operator paused" },
              { now: TIMESTAMP, notificationId: "pause-1" },
            )
          : transitionTask(
              current,
              { type: "block", reason: "the scout needs a decision" },
              { now: TIMESTAMP, notificationId: "block-1" },
            ),
  );
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    tasks: [
      {
        schemaVersion: 1,
        taskId: task.id,
        sourceCheckpoint: SOURCE_CHECKPOINT,
        taskName: "tandem-task-1",
        worktree: lease,
        endpoints: [endpoint],
        jobs: [{ ...job, operationId: `${job.id}-operation`, consumedAt: TIMESTAMP }],
        operation: {
          ...scoutOperation(job, task),
          phase: "completed",
          resultConsumedAt: TIMESTAMP,
        },
      },
    ],
    presentations: [],
  });
  const world = newWorld(options.world);
  const run = worldRunner(world, lease);
  const newService = (): TandemService =>
    createTandemService({
      home,
      sessionId: "session-1",
      poolRoot: lease.root,
      run,
      clock,
      idFactory: (() => {
        let sequence = 0;
        return (): string => {
          sequence += 1;
          return `cleanup-id-${sequence}`;
        };
      })(),
    });
  return { home, repoPath, lease, endpoint, world, run, service: newService(), newService };
}

async function withFixture(
  options: FixtureOptions,
  action: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const created = await settledScoutFixture(options);
  try {
    await action(created);
  } finally {
    await created.service.shutdown();
    await rm(created.home, { recursive: true, force: true });
  }
}

async function readRuntime(home: string): Promise<RuntimeState> {
  return readRuntimeState(runtimeFile(home));
}

test("stage retention keeps blocked, paused, decision-waiting, and foreign work", () => {
  const base = { kind: "scout", reportPath: "/home/jobs/task-1/0/job-1/report.txt" } as const;
  expect(decideScoutCleanupEligibility({ ...base, stage: "completed" })).toEqual({
    kind: "eligible",
  });
  expect(decideScoutCleanupEligibility({ ...base, stage: "cancelled" })).toEqual({
    kind: "eligible",
  });
  expect(decideScoutCleanupEligibility({ ...base, stage: "blocked" }).kind).toBe("retained");
  expect(decideScoutCleanupEligibility({ ...base, stage: "paused" }).kind).toBe("retained");
  expect(decideScoutCleanupEligibility({ ...base, stage: "scouting" }).kind).toBe("retained");
  expect(
    decideScoutCleanupEligibility({
      ...base,
      stage: "completed",
      communication: {
        revision: 1,
        messages: [],
        question: { id: "question-1", text: "Which boundary?" },
      },
    }).kind,
  ).toBe("retained");
  expect(decideScoutCleanupEligibility({ kind: "implementation", stage: "completed" }).kind).toBe(
    "retained",
  );
  expect(decideScoutCleanupEligibility({ kind: "scout", stage: "completed" }).kind).toBe(
    "retained",
  );
});

test("worktree release requires a clean checkout still on its exact source commit", () => {
  const lease = leaseFor("/home");
  const clean = {
    status: "observed",
    head: SOURCE_HEAD,
    branch: TASK_BRANCH,
    dirty: false,
    unmerged: false,
  } as const;
  expect(decideScoutWorktreeRelease({ lease, checkout: clean }).kind).toBe("release");
  expect(decideScoutWorktreeRelease({ lease, checkout: { ...clean, dirty: true } }).kind).toBe(
    "retain",
  );
  expect(decideScoutWorktreeRelease({ lease, checkout: { ...clean, unmerged: true } }).kind).toBe(
    "retain",
  );
  const changed = decideScoutWorktreeRelease({
    lease,
    checkout: { ...clean, head: "other-head" },
  });
  expect(changed.kind).toBe("retain");
  expect(changed.reason).toContain("other-head");
  expect(
    decideScoutWorktreeRelease({ lease, checkout: { ...clean, branch: "someone-elses" } }).kind,
  ).toBe("quarantine");
  expect(
    decideScoutWorktreeRelease({
      lease,
      checkout: { status: "unreadable", detail: "git exploded" },
    }).kind,
  ).toBe("quarantine");
  expect(decideScoutWorktreeRelease({ lease, checkout: { status: "missing" } }).kind).toBe(
    "release",
  );
});

test("unproven ownership is quarantined while transient failures stay retryable", () => {
  const lease = leaseFor("/home");
  expect(
    classifyCleanupFailure(
      new EndpointOwnershipError(endpointFor(), "pane belongs to another workspace"),
    ),
  ).toBe("quarantined");
  expect(
    classifyCleanupFailure(
      new LeaseSafetyError(
        "release could not be proven",
        lease,
        new AdapterProtocolError("treehouse lease status", "lease metadata changed", "[]"),
      ),
    ),
  ).toBe("quarantined");
  expect(classifyCleanupFailure(new Error("herdr exited with code 1"))).toBe("pending");
});

test("a completed clean scout is released while its report and history survive", async () => {
  await withFixture({}, async ({ home, world, service, lease, repoPath }) => {
    await service.tick();

    const task = await service.get("task-1");
    expect(task.stage).toBe("completed");
    expect(task.cleanup?.status).toBe("released");
    expect(task.notifications.some((entry) => entry.message.includes("Scout report"))).toBe(true);
    expect(await readFile(task.reportPath ?? "", "utf8")).toContain("authentication boundary");
    expect(world.closedPanes).toEqual(["pane-1"]);
    expect(world.returnedLeases).toEqual([lease.path]);

    const runtime = await readRuntime(home);
    const runtimeTask = runtime.tasks[0];
    expect(runtimeTask?.worktree).toBeUndefined();
    expect(runtimeTask?.endpoints).toEqual([]);
    expect(runtimeTask?.jobs[0]?.phase).toBe("consumed");
    expect(runtimeTask?.sourceCheckpoint.head).toBe(SOURCE_HEAD);
    expect(runtimeTask?.terminalCleanupRevision).toBe(task.revision);

    const implementation = await service.create({
      repoPath,
      kind: "implementation",
      objective: "apply the scout findings",
      acceptanceCriteria: ["the boundary is enforced"],
      surfaces: ["service"],
      researchTaskIds: ["task-1"],
    });
    const handoff = implementation.researchHandoffs?.[0];
    expect(handoff?.scoutTaskId).toBe("task-1");
    expect(handoff?.excerpt).toContain("authentication boundary");
  });
});

test("a scout whose research leads to implementation keeps its pane and worktree", async () => {
  await withFixture(
    { disposition: "implementation-interview" },
    async ({ home, world, service, lease }) => {
      await service.tick();

      const task = await service.get("task-1");
      expect(task.cleanup?.status).toBe("retained");
      expect(task.cleanup?.reason).toContain("mockups");
      expect(world.closedPanes).toEqual([]);
      expect(world.returnedLeases).toEqual([]);
      const runtime = (await readRuntime(home)).tasks[0];
      expect(runtime?.endpoints).toHaveLength(1);
      expect(runtime?.worktree?.leaseId).toBe(lease.leaseId);
    },
  );
});

test("a finished scout kept open for mockups is closed when building starts, keeping its worktree", async () => {
  await withFixture(
    {
      disposition: "implementation-interview",
      world: { paneActive: true, workerAcceptsClose: true },
    },
    async ({ home, world, service, lease, run }) => {
      const job = scoutJob(home, endpointFor(), "consumed");
      await writeScoutTerminal(job, { phase: "idle", completed: true });
      await service.tick();
      expect(world.closedPanes).toEqual([]);

      const stop = answerCloseRequests(job);
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      await closeFinishedScoutPanes(
        { store, runtimePath: runtimeFile(home), run },
        "task-1",
      ).finally(stop);

      expect(world.closedPanes).toEqual(["pane-1"]);
      const runtime = (await readRuntime(home)).tasks[0];
      expect(runtime?.endpoints).toEqual([]);
      expect(runtime?.worktree?.leaseId).toBe(lease.leaseId);
      const task = await service.get("task-1");
      expect(task.endpoints ?? []).toEqual([]);
      expect(task.cleanup?.status).toBe("retained");
    },
  );
});

test("closing finished scout panes leaves a scout that is not finished alone", async () => {
  await withFixture({ stage: "blocked" }, async ({ home, world, run }) => {
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => TIMESTAMP,
      idFactory: () => "unused",
    });
    await closeFinishedScoutPanes({ store, runtimePath: runtimeFile(home), run }, "task-1");
    expect(world.closedPanes).toEqual([]);
    expect((await readRuntime(home)).tasks[0]?.endpoints).toHaveLength(1);
  });
});

test("a scout whose OMP is still busy keeps its pane until a later tick", async () => {
  await withFixture({ world: { paneActive: true } }, async ({ home, world, service }) => {
    await writeScoutTerminal(scoutJob(home, endpointFor(), "consumed"), {
      phase: "busy",
      completed: true,
    });

    await service.tick();

    expect(world.closedPanes).toEqual([]);
    expect(world.returnedLeases).toEqual([]);
    expect((await service.get("task-1")).cleanup).toBeUndefined();
    expect((await readRuntime(home)).tasks[0]?.endpoints).toHaveLength(1);
  });
});

test("an untracked file in a scout checkout keeps the worktree with a reported reason", async () => {
  await withFixture({ world: { dirty: true } }, async ({ home, world, service, lease }) => {
    await service.tick();

    const task = await service.get("task-1");
    expect(task.stage).toBe("completed");
    expect(task.cleanup?.status).toBe("retained");
    expect(task.cleanup?.reason).toContain("uncommitted or untracked");
    expect(await readFile(task.reportPath ?? "", "utf8")).toContain("authentication boundary");
    expect(world.returnedLeases).toEqual([]);

    const runtime = await readRuntime(home);
    expect(runtime.tasks[0]?.worktree?.path).toBe(lease.path);
    expect(runtime.tasks[0]?.lastError).toContain("uncommitted or untracked");
  });
});

test("a scout checkout moved off its source commit keeps its worktree", async () => {
  await withFixture({ world: { head: "advanced-head" } }, async ({ home, world, service }) => {
    await service.tick();

    const task = await service.get("task-1");
    expect(task.cleanup?.status).toBe("retained");
    expect(task.cleanup?.reason).toContain("advanced-head");
    expect(world.returnedLeases).toEqual([]);
    expect((await readRuntime(home)).tasks[0]?.worktree).toBeDefined();
  });
});

test("blocked, paused, and decision-waiting scouts keep their pane and worktree", async () => {
  for (const stage of ["blocked", "paused"] as const) {
    await withFixture({ stage }, async ({ home, world, service, lease }) => {
      await service.tick();
      const task = await service.get("task-1");
      expect(task.stage).toBe(stage);
      expect(task.cleanup).toBeUndefined();
      expect(world.closedPanes).toEqual([]);
      expect(world.returnedLeases).toEqual([]);
      const runtime = await readRuntime(home);
      expect(runtime.tasks[0]?.worktree?.path).toBe(lease.path);
      expect(runtime.tasks[0]?.endpoints).toHaveLength(1);
    });
  }
});

test("a pane close failure leaves durable pending state and keeps the report", async () => {
  await withFixture({ world: { paneCloseCode: 1 } }, async ({ home, world, service, lease }) => {
    await service.tick();

    const task = await service.get("task-1");
    expect(task.cleanup?.status).toBe("pending");
    expect(task.cleanup?.reason).toContain("pane-1");
    expect(await readFile(task.reportPath ?? "", "utf8")).toContain("authentication boundary");
    expect(world.returnedLeases).toEqual([]);

    const runtime = await readRuntime(home);
    expect(runtime.tasks[0]?.terminalCleanupRevision).toBeUndefined();
    expect(runtime.tasks[0]?.worktree?.path).toBe(lease.path);
  });
});

test("a foreign pane is quarantined with every resource retained", async () => {
  await withFixture(
    { world: { paneWorkspaceId: "workspace-foreign" } },
    async ({ home, world, service }) => {
      await service.tick();

      const task = await service.get("task-1");
      expect(task.cleanup?.status).toBe("quarantined");
      expect(world.closedPanes).toEqual([]);
      expect(world.returnedLeases).toEqual([]);
      expect((await readRuntime(home)).tasks[0]?.worktree).toBeDefined();
    },
  );
});

test("a lease release failure leaves durable pending state and keeps the report", async () => {
  await withFixture({ world: { leaseReturnCode: 1 } }, async ({ home, world, service, lease }) => {
    await service.tick();

    const task = await service.get("task-1");
    expect(task.cleanup?.status).toBe("pending");
    expect(task.cleanup?.reason).toContain("lease");
    expect(await readFile(task.reportPath ?? "", "utf8")).toContain("authentication boundary");
    expect(world.closedPanes).toEqual(["pane-1"]);

    const runtime = await readRuntime(home);
    expect(runtime.tasks[0]?.terminalCleanupRevision).toBeUndefined();
    expect(runtime.tasks[0]?.worktree?.path).toBe(lease.path);
  });
});

test("pending cleanup finishes on a later tick after a coordinator restart", async () => {
  await withFixture(
    { world: { leaseReturnCode: 1 } },
    async ({ home, world, service, newService, lease }) => {
      await service.tick();
      expect((await service.get("task-1")).cleanup?.status).toBe("pending");
      await service.shutdown();

      world.leaseReturnCode = 0;
      const restarted = newService();
      try {
        await restarted.tick();
        const task = await restarted.get("task-1");
        expect(task.cleanup?.status).toBe("released");
        expect(world.returnedLeases).toEqual([lease.path]);
        const runtime = await readRuntime(home);
        expect(runtime.tasks[0]?.worktree).toBeUndefined();
        expect(runtime.tasks[0]?.terminalCleanupRevision).toBe(task.revision);
      } finally {
        await restarted.shutdown();
      }
    },
  );
});

test("the global pending cleanup path finishes stranded scouts and is idempotent", async () => {
  await withFixture(
    { world: { leaseReturnCode: 1 } },
    async ({ home, world, service, run, lease }) => {
      await service.tick();
      expect((await service.get("task-1")).cleanup?.status).toBe("pending");
      await service.shutdown();

      world.leaseReturnCode = 0;
      const first = await finishPendingScoutCleanup({ home, run, clock: () => TIMESTAMP });
      expect(first).toEqual([
        {
          taskId: "task-1",
          status: "released",
          reason: "the scout worktree is clean and still on its source commit",
        },
      ]);
      expect(world.returnedLeases).toEqual([lease.path]);

      const second = await finishPendingScoutCleanup({ home, run, clock: () => TIMESTAMP });
      expect(second).toEqual([]);
      expect(world.returnedLeases).toEqual([lease.path]);
      const runtime = await readRuntime(home);
      expect(runtime.tasks[0]?.worktree).toBeUndefined();
    },
  );
});

test("a safely cancelled scout releases its pane and worktree", async () => {
  await withFixture({ stage: "cancelled" }, async ({ home, world, service, lease }) => {
    await service.tick();

    const task = await service.get("task-1");
    expect(task.stage).toBe("cancelled");
    expect(task.cleanup?.status).toBe("released");
    expect(world.closedPanes).toEqual(["pane-1"]);
    expect(world.returnedLeases).toEqual([lease.path]);
    expect((await readRuntime(home)).tasks[0]?.worktree).toBeUndefined();
  });
});

test("scout completion releases resources in the same pass that writes the report", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-scout-completion-"));
  const repoPath = join(home, "repo");
  const lease = leaseFor(home);
  await mkdir(repoPath, { recursive: true });
  await mkdir(lease.path, { recursive: true });
  const clock = (): string => TIMESTAMP;
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory: () => "seed" });
  const endpoint = endpointFor();
  const created = await store.create({
    id: "task-1",
    repoPath,
    kind: "scout",
    objective: "map the authentication boundary",
    acceptanceCriteria: ["report entry points"],
    surfaces: ["service"],
    policy,
    researchContinuation: { schemaVersion: 1, disposition: "report-only", selectedBy: "explicit" },
  });
  const task = await store.update(created.id, created.revision, (current) =>
    transitionTask(
      current,
      { type: "start", worktree: lease, endpoints: [endpoint] },
      { now: TIMESTAMP, notificationId: "start-1" },
    ),
  );
  const job = scoutJob(home, endpoint, "running");
  await writeJsonAtomically(job.resultPath, {
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    status: "completed",
    text: "Outcome: completed\nThe authentication boundary is here.\n",
    finishedAt: TIMESTAMP,
  });
  const operation = scoutOperation(job, task);
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    tasks: [
      {
        schemaVersion: 1,
        taskId: task.id,
        sourceCheckpoint: SOURCE_CHECKPOINT,
        taskName: "tandem-task-1",
        operation,
        worktree: lease,
        endpoints: [endpoint],
        jobs: [{ ...job, operationId: operation.id }],
      },
    ],
    presentations: [],
  });
  const world = newWorld();
  const service = createTandemService({
    home,
    sessionId: "session-1",
    poolRoot: lease.root,
    run: worldRunner(world, lease),
    clock,
    idFactory: (() => {
      let sequence = 0;
      return (): string => {
        sequence += 1;
        return `completion-id-${sequence}`;
      };
    })(),
  });
  try {
    await service.tick();
    const settled = await service.get("task-1");
    expect(settled.stage).toBe("completed");
    expect(settled.cleanup?.status).toBe("released");
    expect(await readFile(settled.reportPath ?? "", "utf8")).toContain("authentication boundary");
    expect(world.closedPanes).toEqual(["pane-1"]);
    expect(world.returnedLeases).toEqual([lease.path]);
  } finally {
    await service.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("cleanup commands run in the finished task's worktree and report failures without throwing", async () => {
  const requests: CommandRequest[] = [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    requests.push(request);
    return {
      code: request.argv.at(-1) === "npm run db:stop:local" ? 0 : 3,
      stdout: "",
      stderr: "",
    };
  };
  const deps = {
    run,
    cleanupCommands: async () => ["npm run db:stop:local", "docker compose down"],
  };

  const failure = await runCleanupCommands(deps, "/repo", "/pool/3/app");

  expect(requests.map((request) => [request.argv, request.cwd])).toEqual([
    [["/bin/sh", "-c", "npm run db:stop:local"], "/pool/3/app"],
    [["/bin/sh", "-c", "docker compose down"], "/pool/3/app"],
  ]);
  expect(failure).toBe("cleanup commands failed: docker compose down exited 3");
  expect(await runCleanupCommands(deps, "/repo", undefined)).toBeUndefined();
  expect(
    await runCleanupCommands(
      { run, cleanupCommands: async () => ["npm run db:stop:local"] },
      "/repo",
      "/w",
    ),
  ).toBeUndefined();
});
