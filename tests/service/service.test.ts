import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CommandRequest,
  type CommandResult,
  type Endpoint,
  MAX_RESEARCH_HANDOFF_COUNT,
  MAX_RESEARCH_HANDOFF_EXCERPT_BYTES,
  type ResolvedPolicy,
  type TaskRecord,
  type WorkerReceipt,
  type WorktreeLease,
} from "../../src/contracts.ts";
import type { PresentationRecord } from "../../src/presentations/records.ts";
import { activeReservations, activeRuntimeJob } from "../../src/runtime/activity.ts";
import {
  readRuntimeState,
  runtimeFile,
  writeJsonAtomically,
  writeRuntimeState,
} from "../../src/runtime/persistence.ts";
import type {
  DurableJob,
  DurableOperation,
  DurableReservation,
  RuntimePresentation,
  RuntimeState,
  RuntimeTaskState,
} from "../../src/runtime/schema.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import {
  readTaskInbox,
  taskInboxPath,
  writeTaskInbox,
} from "../../src/tasks/communication-persistence.ts";
import { taskInbox } from "../../src/tasks/communication-protocol.ts";
import { type TaskEvent, transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import type { WorkerJob, WorkerResult } from "../../src/workers/jobs.ts";
import { writeWorkerTerminal } from "../../src/workers/terminal.ts";
import { WorkerWorkflow } from "../../src/workers/workflow.ts";

const TIMESTAMP = "2030-01-01T00:00:00.000Z";
const SOURCE_CHECKPOINT = {
  head: "source-head",
  base: "source-head",
  diff: "",
  dirty: false,
  unmerged: false,
} as const;

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
    validationCommands: [],
    maxWorkers: 4,
    maxFixRounds: 1,
  },
  guidance: { implementation: [], validation: [], review: [] },
};
const OMP_MODELS = [
  {
    selector: "test/coordinator",
    id: "coordinator",
    provider: "test",
    thinking: ["low", "high", "max"],
  },
  { selector: "test/scout", id: "scout", provider: "test", thinking: ["low", "high", "max"] },
  {
    selector: "test/implementer",
    id: "implementer",
    provider: "test",
    thinking: ["low", "high", "max"],
  },
  { selector: "test/reviewer", id: "reviewer", provider: "test", thinking: ["low", "high", "max"] },
  { selector: "test/verifier", id: "verifier", provider: "test", thinking: ["low", "high", "max"] },
  {
    selector: "test/presentation",
    id: "presentation",
    provider: "test",
    thinking: ["low", "high", "max"],
  },
] as const;

type FakeRunnerOptions = Readonly<{
  readonly active?: boolean;
  readonly holdInitialHead?: boolean;
  readonly checkoutHead?: string;
  readonly checkoutHeadFor?: (path: string) => string;
  readonly commonDirectory?: string;
  readonly dirty?: boolean;
  readonly unmerged?: boolean;
  readonly recovery?: boolean;
  readonly paneState?: "owned" | "missing" | "foreign";
  readonly workspaceLabel?: string;
  readonly holdProof?: boolean;
  readonly presentationResponses?: readonly CommandResult[];
  readonly presentationOpenResponse?: CommandResult;
  readonly ompModels?: readonly unknown[];
}>;

type FakeRunnerState = {
  readonly calls: CommandRequest[];
  readonly launches: number;
  readonly active: boolean;
  readonly proofBlocked: boolean;
  readonly proofStarted: Promise<void>;
  readonly releaseProof: () => void;
  readonly headStarted: Promise<void>;
  readonly releaseHead: () => void;
  readonly presentationStarted: Promise<void>;
  readonly releasePresentation: () => void;
};

function commandResult(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

function fakeRunner(options: FakeRunnerOptions = {}): {
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
  readonly state: FakeRunnerState;
} {
  const calls: CommandRequest[] = [];
  const presentationResponses = [...(options.presentationResponses ?? [])];
  let launches = 0;
  let active = options.active ?? false;
  let panePresent = options.paneState !== "missing";
  let splitPanePresent = false;
  let proofBlocked = false;
  let startProof = (): void => undefined;
  let releaseProof = (): void => undefined;
  const proofStarted = new Promise<void>((resolve) => {
    startProof = resolve;
  });
  const proofGate = new Promise<void>((resolve) => {
    releaseProof = resolve;
  });
  let headBlocked = false;
  let startHead = (): void => undefined;
  let releaseHead = (): void => undefined;
  const headStarted = new Promise<void>((resolve) => {
    startHead = resolve;
  });
  const headGate = new Promise<void>((resolve) => {
    releaseHead = resolve;
  });
  const presentationStarted = Promise.withResolvers<void>();
  const presentationGate = Promise.withResolvers<void>();
  const startPresentation = (): void => presentationStarted.resolve();
  const releasePresentation = (): void => presentationGate.resolve();

  const state: FakeRunnerState = {
    calls,
    get launches() {
      return launches;
    },
    get active() {
      return active;
    },
    get proofBlocked() {
      return proofBlocked;
    },
    proofStarted,
    get releaseProof() {
      return releaseProof;
    },
    headStarted,
    get releaseHead() {
      return releaseHead;
    },
    presentationStarted: presentationStarted.promise,
    get releasePresentation() {
      return releasePresentation;
    },
  };

  const run = async (request: CommandRequest): Promise<CommandResult> => {
    calls.push(request);
    const argv = request.argv;
    if (argv[0] === "omp" && argv[1] === "models") {
      return commandResult(JSON.stringify({ models: options.ompModels ?? [] }));
    }
    if (argv[0] === "lavish-axi") {
      if (argv[1] === "poll") {
        startPresentation();
        await presentationGate.promise;
        return (
          presentationResponses.shift() ??
          commandResult("session:\n  status: waiting\n  session_ended: false\n")
        );
      }
      return options.presentationOpenResponse ?? commandResult();
    }
    if (argv[0] === "treehouse") {
      if (argv.includes("status")) return commandResult(JSON.stringify([]));
      return commandResult();
    }
    if (argv[0] === "herdr") {
      if (argv.includes("workspace") && argv.includes("list")) {
        return commandResult(
          JSON.stringify({
            result: {
              workspaces: [
                {
                  workspace_id: "workspace-1",
                  active_tab_id: "tab-1",
                  label: options.workspaceLabel ?? "└ tandem-task-1",
                },
              ],
            },
          }),
        );
      }
      if (argv.includes("pane") && argv.includes("list")) {
        return commandResult(
          JSON.stringify({
            result: {
              panes: !panePresent
                ? []
                : [
                    {
                      pane_id: "pane-1",
                      tab_id: "tab-1",
                      workspace_id:
                        options.paneState === "foreign" ? "workspace-foreign" : "workspace-1",
                      cwd: request.cwd,
                      foreground_cwd: request.cwd,
                    },
                    ...(splitPanePresent
                      ? [
                          {
                            pane_id: "pane-2",
                            tab_id: "tab-1",
                            workspace_id: "workspace-1",
                            cwd: request.cwd,
                            foreground_cwd: request.cwd,
                          },
                        ]
                      : []),
                  ],
            },
          }),
        );
      }
      if (argv.includes("pane") && argv.includes("get")) {
        if (!panePresent) {
          return commandResult("", 1, JSON.stringify({ error: { code: "pane_not_found" } }));
        }
        return commandResult(
          JSON.stringify({
            result: {
              pane: {
                pane_id: argv.includes("pane-2") ? "pane-2" : "pane-1",
                tab_id:
                  argv.includes("pane-2") || options.paneState !== "foreign"
                    ? "tab-1"
                    : "tab-foreign",
                workspace_id:
                  argv.includes("pane-2") || options.paneState !== "foreign"
                    ? "workspace-1"
                    : "workspace-foreign",
                foreground_cwd: request.cwd,
              },
            },
          }),
        );
      }
      if (argv.includes("pane") && argv.includes("split")) {
        splitPanePresent = true;
        return commandResult(
          JSON.stringify({
            result: { pane: { pane_id: "pane-2", tab_id: "tab-1", workspace_id: "workspace-1" } },
          }),
        );
      }
      if (argv.includes("pane") && argv.includes("process-info")) {
        if (options.holdProof && launches > 0 && !proofBlocked) {
          proofBlocked = true;
          startProof();
          await proofGate;
        }
        return commandResult(
          JSON.stringify({
            result: {
              process_info: {
                pane_id: argv.includes("pane-2") ? "pane-2" : "pane-1",
                foreground_processes: active ? [{ pid: 100, name: "omp", argv: ["omp"] }] : [],
              },
            },
          }),
        );
      }
      if (argv.includes("pane") && argv.includes("send-keys")) {
        active = false;
        return commandResult();
      }
      if (argv.includes("pane") && argv.includes("run")) {
        launches += 1;
        active = true;
        return commandResult();
      }
      if (argv.includes("pane") && argv.includes("close")) {
        panePresent = false;
        active = false;
        return commandResult();
      }
      if (argv.includes("workspace") && argv.includes("create")) {
        return commandResult(
          JSON.stringify({
            result: {
              workspace: { workspace_id: "workspace-1" },
              tab: { tab_id: "tab-1" },
              root_pane: { pane_id: "pane-1" },
            },
          }),
        );
      }
      return commandResult();
    }
    if (argv[0] === "git") {
      const path = argv[2] ?? request.cwd;
      const checkoutHead = options.checkoutHeadFor?.(path) ?? options.checkoutHead ?? "source-head";
      if (argv.includes("rev-parse")) {
        const target = argv.at(-1);
        if (target === "HEAD") {
          if (options.holdInitialHead && !headBlocked) {
            headBlocked = true;
            startHead();
            await headGate;
          }
          return commandResult(checkoutHead);
        }
        if (target === "--git-common-dir") return commandResult(options.commonDirectory ?? path);
        if (target === "source-head" || target?.startsWith("refs/heads/"))
          return commandResult("source-head");
        if (target !== undefined) return commandResult(target);
      }
      if (argv.includes("branch") && argv.includes("--show-current"))
        return commandResult("tandem-task-1");
      if (argv.includes("status"))
        return commandResult(options.dirty === true ? " M dirty.txt\n" : "");
      if (argv.includes("--diff-filter=U"))
        return commandResult(options.unmerged === true ? "conflict.txt\n" : "");
      if (argv.includes("diff")) return commandResult();
      if (argv.includes("merge-base")) return commandResult();
    }
    throw new Error(`unexpected fake command ${JSON.stringify(argv)}`);
  };

  return { run, state };
}

function leaseFor(home: string): WorktreeLease {
  return {
    root: join(home, "pool"),
    path: join(home, "pool", "task-1"),
    name: "tandem-task-1",
    baseHead: "source-head",
    branch: "tandem/task-1",
    leaseId: "lease-1",
    leaseHolder: "session-1:task-1",
    leasedAt: TIMESTAMP,
  };
}

function endpointFor(role: Endpoint["role"] = "scout"): Endpoint {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
    role,
    generation: 0,
  };
}

function reservationFor(
  taskId = "task-1",
  phase: DurableReservation["phase"] = "reserved",
): DurableReservation {
  return {
    schemaVersion: 1,
    id: "reservation-1",
    taskId,
    ownerSessionId: "session-1",
    phase,
    createdAt: TIMESTAMP,
  };
}

type FixtureOptions = Readonly<{
  readonly kind?: "scout" | "implementation";
  readonly stage?: TaskRecord["stage"];
  readonly maxWorkers?: number;
  readonly clock?: () => string;
  readonly idFactory?: () => string;
  readonly taskEdits?: Readonly<{
    readonly stage?: TaskRecord["stage"];
    readonly previousStage?: TaskRecord["stage"];
    readonly reviewHead?: string;
    readonly reviewRound?: number;
    readonly worktree?: WorktreeLease;
    readonly clearWorktree?: boolean;
  }>;
  readonly runtimeEdits?: Partial<RuntimeTaskState>;
  readonly runner?: FakeRunnerOptions;
}>;

type Fixture = Readonly<{
  readonly home: string;
  readonly task: TaskRecord;
  readonly lease: WorktreeLease;
  readonly endpoint: Endpoint;
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
  readonly runnerState: FakeRunnerState;
  readonly service: TandemService;
}>;

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "tandem-service-regression-"));
  const repoPath = join(home, "repo");
  await mkdir(repoPath, { recursive: true });
  const clock = options.clock ?? (() => TIMESTAMP);
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock,
    idFactory: () => "store-id",
  });
  const kind = options.kind ?? "scout";
  const taskPolicy =
    options.maxWorkers === undefined
      ? policy
      : { ...policy, config: { ...policy.config, maxWorkers: options.maxWorkers } };
  let task = await store.create({
    id: "task-1",
    repoPath,
    kind,
    objective: "exercise a durable service path",
    acceptanceCriteria: ["the outcome is persisted"],
    surfaces: ["service"],
    policy: taskPolicy,
  });
  if (
    task.stage === "awaiting-approval" &&
    options.stage !== undefined &&
    options.stage !== "awaiting-approval"
  ) {
    task = await store.update(task.id, task.revision, (current) =>
      transitionTask(current, { type: "approve" }, { now: clock(), notificationId: "approve-1" }),
    );
  }
  const edits = options.taskEdits;
  if (edits !== undefined || options.stage !== undefined) {
    task = await store.update(task.id, task.revision, (current) => {
      let next: TaskRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: clock(),
        ...(options.stage === undefined ? {} : { stage: options.stage }),
        ...(edits?.stage === undefined ? {} : { stage: edits.stage }),
        ...(edits?.previousStage === undefined ? {} : { previousStage: edits.previousStage }),
        ...(edits?.reviewHead === undefined ? {} : { reviewHead: edits.reviewHead }),
        ...(edits?.reviewRound === undefined ? {} : { reviewRound: edits.reviewRound }),
        ...(edits?.worktree === undefined ? {} : { worktree: edits.worktree }),
      };
      if (edits?.clearWorktree === true) {
        const { worktree: _worktree, ...withoutWorktree } = next;
        next = withoutWorktree;
      }
      return next;
    });
  }
  const lease = leaseFor(home);
  await mkdir(lease.path, { recursive: true });
  const endpoint = endpointFor(kind === "implementation" ? "implementer" : "scout");
  const runner = fakeRunner(options.runner);
  const runtime: RuntimeTaskState = {
    schemaVersion: 1,
    taskId: task.id,
    sourceCheckpoint: SOURCE_CHECKPOINT,
    taskName: "tandem-task-1",
    endpoints: [],
    jobs: [],
    ...(options.runtimeEdits ?? {}),
  };
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    tasks: [runtime],
    presentations: [],
  });
  let sequence = 0;
  const idFactory =
    options.idFactory ??
    (() => {
      sequence += 1;
      return `service-id-${sequence}`;
    });
  const service = createTandemService({
    home,
    sessionId: "session-1",
    poolRoot: lease.root,
    run: runner.run,
    clock,
    idFactory,
  });
  return { home, task, lease, endpoint, run: runner.run, runnerState: runner.state, service };
}

async function withFixture(
  options: FixtureOptions,
  action: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const created = await fixture(options);
  try {
    await action(created);
  } finally {
    created.runnerState.releasePresentation();
    await created.service.shutdown();
    await rm(created.home, { recursive: true, force: true });
  }
}
async function readRuntime(home: string): Promise<RuntimeState> {
  return readRuntimeState(runtimeFile(home));
}
async function seedCompletedScout(
  fixtureValue: Fixture,
  report: string,
  sourceCheckpoint: RuntimeTaskState["sourceCheckpoint"] = SOURCE_CHECKPOINT,
): Promise<string> {
  const reportPath = join(
    fixtureValue.home,
    "jobs",
    fixtureValue.task.id,
    "0",
    "job-1",
    "report.txt",
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, "utf8");

  const store = createTaskStore({
    directory: join(fixtureValue.home, "tasks"),
    clock: () => TIMESTAMP,
    idFactory: () => "unused",
  });
  const current = await store.read(fixtureValue.task.id);
  if (current === undefined) throw new Error("fixture scout task missing");
  await store.update(current.id, current.revision, (task) => ({
    ...task,
    revision: task.revision + 1,
    updatedAt: TIMESTAMP,
    stage: "completed",
    previousStage: "scouting",
    reportPath,
  }));

  const runtime = await readRuntime(fixtureValue.home);
  const scoutRuntime = runtime.tasks.find((entry) => entry.taskId === fixtureValue.task.id);
  if (scoutRuntime === undefined) throw new Error("fixture scout runtime missing");
  const scoutJob = workerJob(fixtureValue.home, fixtureValue.endpoint, "scout", "consumed");
  await writeRuntimeState(runtimeFile(fixtureValue.home), {
    ...runtime,
    tasks: runtime.tasks.map((entry) =>
      entry.taskId === fixtureValue.task.id
        ? { ...entry, sourceCheckpoint, jobs: [scoutJob] }
        : entry,
    ),
  });
  return reportPath;
}

test("bound coordinators scope tasks by physical original identity and reject foreign projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-service-scope-"));
  const home = join(root, "home");
  const original = join(root, "original");
  const source = join(root, "clean-source");
  const other = join(root, "other");
  const originalAlias = join(root, "original-alias");
  await Promise.all([mkdir(original), mkdir(source), mkdir(other)]);
  await symlink(original, originalAlias);
  const clock = (): string => TIMESTAMP;
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock,
    idFactory: () => "store-id",
  });
  const taskA = await store.create({
    id: "task-a",
    repoPath: originalAlias,
    kind: "scout",
    objective: "Inspect project A",
    acceptanceCriteria: ["Report project A"],
    surfaces: ["src"],
    policy,
  });
  await store.create({
    id: "task-b",
    repoPath: other,
    kind: "scout",
    objective: "Inspect project B",
    acceptanceCriteria: ["Report project B"],
    surfaces: ["src"],
    policy,
  });
  const service = createTandemService({
    home,
    sessionId: "session-a",
    poolRoot: join(root, "pool"),
    sourceWorkspace: { repoPath: original, path: source },
    run: async () => commandResult(),
    clock,
    idFactory: () => "service-id",
  });
  try {
    expect(await service.list()).toEqual([taskA]);
    expect(await service.get("task-a")).toEqual(taskA);
    await unlink(originalAlias);
    await symlink(other, originalAlias);
    expect(await service.list()).toEqual([]);
    await expect(service.get("task-a")).rejects.toThrow("Task task-a was not found");
    await expect(service.cancel("task-a")).rejects.toThrow("task task-a is missing");
    await expect(service.get("task-b")).rejects.toThrow("Task task-b was not found");
    await expect(service.cancel("task-b")).rejects.toThrow("task task-b is missing");
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
test("bound task creation normalizes clean input to the original identity and persists its source", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-service-source-"));
  const home = join(root, "home");
  const original = join(root, "original");
  const source = join(root, "clean-source");
  const common = join(root, "git-common");
  await Promise.all([mkdir(original), mkdir(source), mkdir(common)]);
  const runner = fakeRunner({ commonDirectory: common });
  const service = createTandemService({
    home,
    sessionId: "session-a",
    poolRoot: join(root, "pool"),
    sourceWorkspace: { repoPath: original, path: source },
    run: runner.run,
    clock: () => TIMESTAMP,
    idFactory: () => "task-a",
  });
  try {
    const created = await service.create({
      repoPath: source,
      kind: "scout",
      objective: "Inspect the clean source",
      acceptanceCriteria: ["Persist original identity"],
      surfaces: ["src"],
    });
    expect(created.repoPath).toBe(await realpath(original));
    const runtime = await readRuntime(home);
    expect(runtime.tasks[0]?.sourceRepoPath).toBe(await realpath(source));
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
test("creates a bounded immutable scout handoff for a same-source implementation", async () => {
  await withFixture({ kind: "scout" }, async (fixtureValue) => {
    const report = `Outcome: completed\n${"界".repeat(3_000)}`;
    const reportPath = await seedCompletedScout(fixtureValue, report);

    const created = await fixtureValue.service.create({
      repoPath: fixtureValue.task.repoPath,
      kind: "implementation",
      objective: "Use the completed scout evidence",
      acceptanceCriteria: ["The implementation uses the handoff"],
      surfaces: ["service"],
      researchTaskIds: [fixtureValue.task.id],
    });
    const handoff = created.researchHandoffs?.[0];
    if (handoff === undefined) throw new Error("research handoff was not persisted");

    expect(handoff.scoutTaskId).toBe(fixtureValue.task.id);
    expect(handoff.scoutRepoPath).toBe(await realpath(fixtureValue.task.repoPath));
    expect(handoff.scoutSourceHead).toBe(SOURCE_CHECKPOINT.head);
    expect(handoff.scoutSourceBase).toBe(SOURCE_CHECKPOINT.base);
    expect(handoff.reportPath).toBe(await realpath(reportPath));
    expect(handoff.reportDigest).toBe(createHash("sha256").update(report).digest("hex"));
    expect(Buffer.byteLength(handoff.excerpt, "utf8")).toBeLessThanOrEqual(
      MAX_RESEARCH_HANDOFF_EXCERPT_BYTES,
    );
    expect(handoff.excerpt).toContain("Outcome: completed");
    expect((await fixtureValue.service.get(created.id)).researchHandoffs).toEqual(
      created.researchHandoffs,
    );
  });
});

test("rejects missing, over-limit, and stale scout handoff references", async () => {
  await withFixture({ kind: "scout" }, async (fixtureValue) => {
    const createInput = {
      repoPath: fixtureValue.task.repoPath,
      kind: "implementation" as const,
      objective: "Implement from scout evidence",
      acceptanceCriteria: ["Invalid references fail closed"],
      surfaces: ["service"],
    };
    await expect(
      fixtureValue.service.create({ ...createInput, researchTaskIds: ["missing-scout"] }),
    ).rejects.toThrow("not a completed scout");
    await expect(
      fixtureValue.service.create({
        ...createInput,
        researchTaskIds: Array.from(
          { length: MAX_RESEARCH_HANDOFF_COUNT + 1 },
          (_, index) => `scout-${index}`,
        ),
      }),
    ).rejects.toThrow(`at most ${MAX_RESEARCH_HANDOFF_COUNT}`);

    await seedCompletedScout(fixtureValue, "Outcome: completed\nstale", {
      ...SOURCE_CHECKPOINT,
      head: "old-head",
      base: "old-head",
    });
    await expect(
      fixtureValue.service.create({
        ...createInput,
        researchTaskIds: [fixtureValue.task.id],
      }),
    ).rejects.toThrow("stale for the implementation source checkpoint");
    expect(
      (await fixtureValue.service.list()).some((entry) => entry.kind === "implementation"),
    ).toBe(false);
  });
});

test("service resolves task policy from Tandem home and leaves repository-local config untouched", async () => {
  await withFixture({}, async ({ home, service }) => {
    const existing = await service.get("task-1");
    const proposal = await service.onboard(existing.repoPath, false);
    const localConfigPath = join(proposal.repoPath, ".tandem.json");
    const localConfig = '{"models":{"coordinator":{"model":"local/should-not-be-read"}}}';
    await writeFile(localConfigPath, localConfig, "utf8");
    await mkdir(dirname(proposal.configPath), { recursive: true });
    await writeFile(
      proposal.configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        repoPath: proposal.repoPath,
        policy: { models: { coordinator: { model: "central/coordinator" } } },
      })}\n`,
      "utf8",
    );

    const created = await service.create({
      repoPath: proposal.repoPath,
      kind: "scout",
      objective: "use the centrally configured policy",
      acceptanceCriteria: ["the central policy is pinned"],
      surfaces: ["service"],
    });

    expect(created.policy.config.models.coordinator.model).toBe("central/coordinator");
    await expect(readFile(localConfigPath, "utf8")).resolves.toBe(localConfig);
    expect(proposal.configPath).toContain(join(home, "repositories"));
  });
});
test("service rejects unavailable model choices before writing settings", async () => {
  await withFixture(
    { runner: { ompModels: OMP_MODELS } },
    async ({ task, service, runnerState }) => {
      const options = await service.models(task.repoPath);
      expect(options.modelSettings.configured).toBe(false);
      const callsBeforeConfigure = runnerState.calls.length;
      const unavailable = {
        ...policy.config.models,
        verifier: { model: "missing/verifier", thinking: "low" as const },
      };

      await expect(
        service.configureModels({ repoPath: task.repoPath, models: unavailable }),
      ).rejects.toThrow("missing/verifier");

      expect(runnerState.calls.slice(callsBeforeConfigure)).toHaveLength(1);
      await expect(readFile(options.modelSettings.configPath, "utf8")).rejects.toThrow();
    },
  );
});

test("approved model changes affect future tasks without mutating an existing policy snapshot", async () => {
  await withFixture({ runner: { ompModels: OMP_MODELS } }, async ({ task, service }) => {
    const updatedModels = {
      ...policy.config.models,
      coordinator: { model: "test/scout", thinking: "high" as const },
    };
    await service.configureModels({ repoPath: task.repoPath, models: updatedModels });

    const existing = await service.get(task.id);
    expect(existing.policy.config.models.coordinator).toEqual(policy.config.models.coordinator);

    const created = await service.create({
      repoPath: task.repoPath,
      kind: "scout",
      objective: "use the updated global model settings",
      acceptanceCriteria: ["the new task uses the saved coordinator model"],
      surfaces: ["service"],
    });
    expect(created.policy.config.models.coordinator).toEqual(updatedModels.coordinator);
  });
});

function workerJob(
  home: string,
  endpoint: Endpoint,
  role: Exclude<DurableJob["role"], "validation">,
  phase: DurableJob["phase"] = "running",
): DurableJob {
  const directory = join(home, "jobs", "task-1", "0", "job-1");
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 0,
    role,
    kind: "worker",
    cwd: endpoint.paneId === "pane-1" ? join(home, "pool", "task-1") : home,
    jobPath: join(directory, "job.json"),
    resultPath: join(directory, "result.json"),
    attempt: 1,
    phase,
    launchAttempted: phase !== "reserved",
    createdAt: TIMESTAMP,
    endpoint,
  };
}
function operationForJob(job: DurableJob, task: TaskRecord): DurableOperation {
  const kind: DurableOperation["kind"] =
    job.kind === "validation"
      ? "validation"
      : job.role === "scout"
        ? "scout"
        : job.role === "implementer"
          ? task.reviewRound > 0
            ? "fix"
            : "implementation"
          : job.role === "reviewer"
            ? "review"
            : "verification";
  return {
    schemaVersion: 1,
    id: `${job.id}-operation`,
    taskId: job.taskId,
    kind,
    role: job.role,
    generation: job.generation,
    inputHead: task.reviewHead ?? SOURCE_CHECKPOINT.head,
    policyDigest: createHash("sha256").update(JSON.stringify(task.policy)).digest("hex"),
    instructionRevision: 0,
    jobId: job.id,
    phase: job.phase === "consumed" ? "finalizing" : "running",
    fencingRevision: 1,
    claimOwner: "seeded-controller",
    createdAt: TIMESTAMP,
    effects: [],
  };
}

function taskFingerprint(task: TaskRecord): string {
  return JSON.stringify(task);
}

function eventKey(jobId: string, event: TaskEvent): string {
  return `${jobId}:${JSON.stringify(event)}`;
}

async function seedTaskResources(
  home: string,
  lease: WorktreeLease,
  endpoints: readonly Endpoint[],
  jobs: readonly DurableJob[],
): Promise<void> {
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: () => TIMESTAMP,
    idFactory: () => "unused",
  });
  const current = await store.read("task-1");
  if (current === undefined) throw new Error("fixture task missing");
  const updated = await store.update(current.id, current.revision, (task) => ({
    ...task,
    revision: task.revision + 1,
    updatedAt: TIMESTAMP,
    worktree: lease,
    endpoints,
  }));
  const seedJob = jobs[0];
  const operation = seedJob === undefined ? undefined : operationForJob(seedJob, updated);
  const linkedJobs = jobs.map((job) =>
    operation !== undefined && job.id === operation.jobId
      ? { ...job, operationId: operation.id }
      : job,
  );
  const reservation =
    operation !== undefined && seedJob !== undefined && activeRuntimeJob(seedJob)
      ? {
          ...reservationFor("task-1"),
          operationId: operation.id,
        }
      : undefined;
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    tasks: [
      {
        schemaVersion: 1,
        taskId: "task-1",
        sourceCheckpoint: SOURCE_CHECKPOINT,
        taskName: "tandem-task-1",
        ...(operation === undefined ? {} : { operation }),
        ...(reservation === undefined ? {} : { reservation }),
        worktree: lease,
        endpoints,
        jobs: linkedJobs,
      },
    ],
    presentations: [],
  });
}

async function seedConsumedPresentation(
  home: string,
  id: string,
): Promise<Readonly<{ readonly artifactPath: string; readonly recordPath: string }>> {
  const recordPath = join(home, `${id}-record.json`);
  const jobPath = join(home, `${id}-job.json`);
  const resultPath = join(home, `${id}-result.json`);
  const artifactPath = join(home, `${id}-artifact.html`);
  await writeFile(artifactPath, "<!doctype html><title>presentation</title>", "utf8");
  await writeJsonAtomically(recordPath, {
    id,
    taskId: "task-1",
    generation: 0,
    cwd: home,
    artifactPath,
    jobPath,
    resultPath,
    status: "open",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    observation: {
      artifact: artifactPath,
      status: "opened",
      terminal: false,
      sessionEnded: false,
      raw: "session:\n  status: opened\n  session_ended: false",
      rawFeedback: "",
    },
  });
  const runtime = await readRuntime(home);
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    tasks: runtime.tasks,
    presentations: [
      {
        schemaVersion: 1,
        id,
        taskId: "task-1",
        recordPath,
        job: {
          schemaVersion: 1,
          id: `${id}-job`,
          taskId: "task-1",
          generation: 0,
          role: "presentation",
          kind: "worker",
          cwd: home,
          jobPath,
          resultPath,
          attempt: 1,
          phase: "consumed",
          launchAttempted: true,
          createdAt: TIMESTAMP,
          consumedAt: TIMESTAMP,
        },
      },
    ],
  });
  return { artifactPath, recordPath };
}

async function seedRunningPresentation(
  home: string,
  id: string,
): Promise<
  Readonly<{
    readonly artifactPath: string;
    readonly recordPath: string;
    readonly resultPath: string;
  }>
> {
  const recordPath = join(home, `${id}-record.json`);
  const jobPath = join(home, `${id}-job.json`);
  const resultPath = join(home, `${id}-result.json`);
  const artifactPath = join(home, `${id}-artifact.html`);
  const endpoint = endpointFor("presentation");
  await writeFile(artifactPath, "<!doctype html><title>presentation</title>", "utf8");
  await writeJsonAtomically(recordPath, {
    id,
    taskId: "task-1",
    generation: 0,
    cwd: home,
    artifactPath,
    jobPath,
    resultPath,
    status: "running",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    endpoint,
  });
  const operation: DurableOperation = {
    schemaVersion: 1,
    id: `${id}-operation`,
    taskId: "task-1",
    kind: "presentation",
    role: "presentation",
    generation: 0,
    inputHead: SOURCE_CHECKPOINT.head,
    policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    instructionRevision: 0,
    jobId: id,
    phase: "running",
    fencingRevision: 1,
    claimOwner: "seeded-controller",
    createdAt: TIMESTAMP,
    effects: [],
  };
  const runtime = await readRuntime(home);
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    tasks: runtime.tasks,
    presentations: [
      {
        schemaVersion: 1,
        id,
        operation,
        taskId: "task-1",
        recordPath,
        endpoint,
        job: {
          schemaVersion: 1,
          id,
          taskId: "task-1",
          generation: 0,
          role: "presentation",
          kind: "worker",
          cwd: home,
          jobPath,
          operationId: operation.id,
          resultPath,
          attempt: 1,
          phase: "running",
          launchAttempted: true,
          createdAt: TIMESTAMP,
          endpoint,
        },
      },
    ],
  });
  await writeJsonAtomically(resultPath, {
    id,
    taskId: "task-1",
    generation: 0,
    role: "presentation",
    status: "completed",
    text: `Artifact: ${artifactPath}`,
    artifactPath,
    finishedAt: TIMESTAMP,
  });
  return { artifactPath, recordPath, resultPath };
}
async function seedBlockedPresentation(
  home: string,
  id: string,
  taskId: string,
  questionText: string,
): Promise<
  Readonly<{
    readonly recordPath: string;
    readonly jobPath: string;
    readonly resultPath: string;
    readonly questionId: string;
  }>
> {
  const recordPath = join(home, `${id}-record.json`);
  const jobPath = join(home, `${id}-job.json`);
  const resultPath = join(home, `${id}-result.json`);
  const artifactPath = join(home, `${id}-artifact.html`);
  const questionId = `${id}-old-job`;
  const endpoint = endpointFor("presentation");
  const question = { id: questionId, text: questionText };
  await writeFile(artifactPath, "<!doctype html><title>blocked presentation</title>", "utf8");
  const job = {
    schemaVersion: 1 as const,
    id: questionId,
    taskId,
    generation: 0,
    role: "presentation" as const,
    cwd: home,
    model: { model: "test/presentation", thinking: "low" as const },
    prompt: `Create the ${id} artifact.`,
    resultPath,
  } satisfies WorkerJob;
  await writeJsonAtomically(jobPath, job);
  const result = {
    id: questionId,
    taskId,
    generation: 0,
    role: "presentation" as const,
    status: "needs-decision" as const,
    text: `Outcome: needs-decision\nQuestion: ${questionText}`,
    question: { text: questionText },
    finishedAt: TIMESTAMP,
  } satisfies WorkerResult;
  await writeJsonAtomically(resultPath, result);
  const record = {
    id,
    taskId,
    generation: 0,
    cwd: home,
    artifactPath,
    jobPath,
    resultPath,
    status: "blocked" as const,
    question,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  } satisfies PresentationRecord;
  await writeJsonAtomically(recordPath, record);
  const operation: DurableOperation = {
    schemaVersion: 1,
    id: `${questionId}-operation`,
    taskId,
    kind: "presentation",
    role: "presentation",
    generation: 0,
    inputHead: SOURCE_CHECKPOINT.head,
    policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    instructionRevision: 0,
    jobId: questionId,
    phase: "completed",
    fencingRevision: 1,
    claimOwner: "seeded-controller",
    createdAt: TIMESTAMP,
    effects: [],
    resultConsumedAt: TIMESTAMP,
  };
  const runtime = await readRuntime(home);
  await writeRuntimeState(runtimeFile(home), {
    ...runtime,
    presentations: [
      ...runtime.presentations,
      {
        schemaVersion: 1,
        id,
        taskId,
        recordPath,
        operation,
        endpoint,
        job: {
          schemaVersion: 1,
          id: questionId,
          taskId,
          generation: 0,
          role: "presentation",
          kind: "worker",
          cwd: home,
          jobPath,
          operationId: operation.id,
          resultPath,
          attempt: 1,
          phase: "consumed",
          launchAttempted: true,
          createdAt: TIMESTAMP,
          consumedAt: TIMESTAMP,
          endpoint,
        },
      },
    ],
  });
  return { recordPath, jobPath, resultPath, questionId };
}
test("presentation answers create isolated attempts, preserve evidence, and target the owning record", async () => {
  await withFixture(
    { kind: "implementation", stage: "paused", runner: { active: false } },
    async ({ home, service }) => {
      const first = await seedBlockedPresentation(
        home,
        "presentation-first",
        "task-1",
        "Which first direction should be used?",
      );
      const second = await seedBlockedPresentation(
        home,
        "presentation-second",
        "task-1",
        "Which second direction should be used?",
      );
      await expect(
        service.answer({
          taskId: "task-1",
          questionId: "stale-question",
          text: "stale",
        }),
      ).rejects.toThrow("no longer current");

      const answered = await service.answer({
        taskId: "task-1",
        questionId: second.questionId,
        text: "Use the second direction.",
      });
      expect(answered.presentationAnswer).toEqual({
        presentationId: "presentation-second",
        questionId: second.questionId,
        status: "queued",
      });
      const state = await readRuntime(home);
      const restarted = state.presentations.find((entry) => entry.id === "presentation-second");
      if (restarted === undefined) throw new Error("restarted presentation runtime missing");
      expect(restarted.job.jobPath).not.toBe(second.jobPath);
      expect(restarted.job.resultPath).not.toBe(second.resultPath);
      const worker = JSON.parse(await readFile(restarted.job.jobPath, "utf8")) as {
        readonly prompt: string;
      };
      expect(worker.prompt).toContain(`Prior worker report: ${second.resultPath}`);
      expect(worker.prompt).toContain("Which second direction should be used?");
      expect(worker.prompt).toContain("Use the second direction.");
      expect(await readFile(second.resultPath, "utf8")).toContain("needs-decision");

      await service.tick();
      const afterTick = await readRuntime(home);
      const afterRestart = afterTick.presentations.find(
        (entry) => entry.id === "presentation-second",
      );
      if (afterRestart === undefined) throw new Error("restarted presentation disappeared");
      expect(afterRestart.job.phase).toBe("running");
      const firstRecord = (await service.presentations()).find(
        (record) => record.id === "presentation-first",
      );
      expect(firstRecord?.status).toBe("blocked");
      expect(firstRecord?.question?.id).toBe(first.questionId);
    },
  );
});

test("presentation answers reject cancelled owners but remain allowed for completed owners", async () => {
  await withFixture({ kind: "implementation", stage: "paused" }, async ({ home, service }) => {
    const blocked = await seedBlockedPresentation(
      home,
      "presentation-cancelled",
      "task-1",
      "Which cancelled direction should be used?",
    );
    await service.cancel("task-1", "cancel presentation owner");
    await expect(
      service.answer({
        taskId: "task-1",
        questionId: blocked.questionId,
        text: "Do not relaunch.",
      }),
    ).rejects.toThrow("cancelled task");
  });

  await withFixture({ kind: "implementation", stage: "completed" }, async ({ home, service }) => {
    const blocked = await seedBlockedPresentation(
      home,
      "presentation-completed",
      "task-1",
      "Which completed-task direction should be used?",
    );
    const answered = await service.answer({
      taskId: "task-1",
      questionId: blocked.questionId,
      text: "Reuse the approved completed artifact.",
    });
    expect(answered.presentationAnswer?.presentationId).toBe("presentation-completed");
    expect((await service.presentations())[0]?.status).toBe("running");
  });
});

test("concurrent controllers consume one completed presentation only once", async () => {
  await withFixture(
    {
      kind: "implementation",
      runner: {
        presentationOpenResponse: commandResult(
          "session:\n  status: opened\n  session_ended: false\n",
        ),
      },
    },
    async ({ home, run, runnerState, service }) => {
      await seedRunningPresentation(home, "presentation-1");
      const secondService = createTandemService({
        home,
        sessionId: "session-2",
        poolRoot: join(home, "pool"),
        run,
        clock: () => TIMESTAMP,
        idFactory: () => "second-service-id",
      });
      try {
        await Promise.all([service.tick(), secondService.tick()]);
        const openCalls = runnerState.calls.filter(
          (request) => request.argv[0] === "lavish-axi" && request.argv[1] !== "poll",
        );
        expect(openCalls).toHaveLength(1);
        const runtime = await readRuntime(home);
        expect(runtime.presentations[0]?.job.phase).toBe("consumed");
        expect(runtime.presentations[0]?.endpoint?.paneId).toBe("pane-1");
        const record = JSON.parse(
          await Bun.file(join(home, "presentation-1-record.json")).text(),
        ) as {
          readonly status: string;
        };
        expect(record.status).toBe("open");
        runnerState.releasePresentation();
      } finally {
        await secondService.shutdown();
      }
    },
  );
});

test("quarantines a presentation notification after delivering pending feedback exactly once", async () => {
  await withFixture({ stage: "completed" }, async ({ home, service }) => {
    const recordPath = join(home, "failure-record.json");
    const jobPath = join(home, "failure-job.json");
    const resultPath = join(home, "failure-result.json");
    const artifactPath = join(home, "failure-artifact.html");
    await writeFile(artifactPath, "<!doctype html><title>failure</title>", "utf8");
    await writeJsonAtomically(recordPath, {
      id: "presentation-failure",
      taskId: "task-1",
      generation: 0,
      cwd: home,
      artifactPath,
      jobPath,
      resultPath,
      status: "open",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      observation: {
        artifact: artifactPath,
        status: "opened",
        terminal: false,
        sessionEnded: false,
        raw: "session:\n  status: opened\n  session_ended: false",
        rawFeedback: "",
      },
      pendingNotification: {
        id: "feedback-before-failure",
        kind: "coordinator",
        message: "Choose a direction before the worker fails",
      },
    });
    const operation: DurableOperation = {
      schemaVersion: 1,
      id: "failure-operation",
      taskId: "task-1",
      kind: "presentation",
      role: "presentation",
      generation: 0,
      inputHead: SOURCE_CHECKPOINT.head,
      policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
      instructionRevision: 0,
      jobId: "failure-job",
      phase: "running",
      fencingRevision: 1,
      claimOwner: "seeded-controller",
      createdAt: TIMESTAMP,
      effects: [],
    };
    const presentationReservation = { ...reservationFor("task-1"), operationId: operation.id };
    const runtime = await readRuntime(home);
    await writeRuntimeState(runtimeFile(home), {
      schemaVersion: 1,
      tasks: runtime.tasks.map((entry) => ({
        ...entry,
        operation,
        reservation: presentationReservation,
      })),
      presentations: [
        {
          schemaVersion: 1,
          id: "presentation-failure",
          taskId: "task-1",
          recordPath,
          operation,
          job: {
            schemaVersion: 1,
            id: "failure-job",
            taskId: "task-1",
            generation: 0,
            role: "presentation",
            kind: "worker",
            cwd: home,
            jobPath,
            resultPath,
            attempt: 1,
            phase: "running",
            operationId: operation.id,
            launchAttempted: true,
            createdAt: "2020-01-01T00:00:00.000Z",
          },
        },
      ],
    });
    await service.tick();
    let task = await service.get("task-1");
    let notifications = task.notifications.filter((entry) => entry.kind === "coordinator");
    expect(notifications.filter((entry) => entry.id === "feedback-before-failure")).toHaveLength(1);
    expect(notifications.filter((entry) => entry.id !== "feedback-before-failure")).toHaveLength(1);
    expect(notifications.findIndex((entry) => entry.id === "feedback-before-failure")).toBeLessThan(
      notifications.findIndex((entry) => entry.id !== "feedback-before-failure"),
    );
    let persistedRuntime = await readRuntime(home);
    expect(persistedRuntime.presentations[0]?.job.phase).toBe("running");
    expect(persistedRuntime.presentations[0]?.operation?.phase).toBe("quarantined");
    expect(persistedRuntime.tasks[0]?.reservation?.phase).toBe("reserved");
    expect(activeReservations(persistedRuntime)).toBe(1);
    await service.tick();
    task = await service.get("task-1");
    notifications = task.notifications.filter((entry) => entry.kind === "coordinator");
    expect(notifications.filter((entry) => entry.id === "feedback-before-failure")).toHaveLength(1);
    expect(notifications.filter((entry) => entry.id !== "feedback-before-failure")).toHaveLength(1);
    persistedRuntime = await readRuntime(home);
    expect(persistedRuntime.presentations[0]?.job.phase).toBe("running");
  });
});

test("feedback poll failure marks a consumed presentation failed without resurrecting its operation", async () => {
  await withFixture(
    {
      stage: "completed",
      runner: { presentationResponses: [commandResult("", 1, "poll failed")] },
    },
    async ({ home, service, runnerState }) => {
      const id = "presentation-consumed-feedback-failure";
      await seedConsumedPresentation(home, id);
      const state = await readRuntime(home);
      const current = state.presentations[0];
      if (current === undefined) throw new Error("consumed presentation fixture missing");
      const operation: DurableOperation = {
        schemaVersion: 1,
        id: `${id}-operation`,
        taskId: "task-1",
        kind: "presentation",
        role: "presentation",
        generation: 0,
        inputHead: SOURCE_CHECKPOINT.head,
        policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
        instructionRevision: 0,
        jobId: current.job.id,
        phase: "completed",
        fencingRevision: 1,
        claimOwner: "seeded-controller",
        createdAt: TIMESTAMP,
        effects: [],
      };
      const reservation = {
        ...reservationFor("task-1", "released"),
        operationId: operation.id,
        releasedAt: TIMESTAMP,
      };
      await writeRuntimeState(runtimeFile(home), {
        ...state,
        presentations: [
          {
            ...current,
            operation,
            reservation,
            job: { ...current.job, operationId: operation.id },
          },
        ],
      });

      await service.tick();
      await runnerState.presentationStarted;
      const feedback = service.feedback(id);
      runnerState.releasePresentation();
      const failed = await feedback;
      expect(failed.status).toBe("failed");
      expect(failed.error).toBeDefined();

      const task = await service.get("task-1");
      expect(task.notifications.some((entry) => entry.kind === "coordinator")).toBe(true);
      const persisted = await readRuntime(home);
      const presentation = persisted.presentations[0];
      expect(presentation?.job.phase).toBe("consumed");
      expect(presentation?.operation?.phase).toBe("completed");
      expect(presentation?.reservation?.phase).toBe("released");
    },
  );
});

test("approved task allocates a fresh endpoint and dispatches one worker", async () => {
  await withFixture({ kind: "implementation" }, async ({ home, lease, service, runnerState }) => {
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => TIMESTAMP,
      idFactory: () => "unused",
    });
    const current = await store.read("task-1");
    if (current === undefined) throw new Error("fixture task missing");
    await store.update(current.id, current.revision, (task) => ({
      ...task,
      revision: task.revision + 1,
      updatedAt: TIMESTAMP,
      worktree: lease,
    }));
    await writeRuntimeState(runtimeFile(home), {
      schemaVersion: 1,
      tasks: [
        {
          schemaVersion: 1,
          taskId: "task-1",
          sourceCheckpoint: SOURCE_CHECKPOINT,
          taskName: "tandem-task-1",
          worktree: lease,
          endpoints: [],
          jobs: [],
        },
      ],
      presentations: [],
    });

    const approved = await service.approve("task-1");
    expect(approved.stage).toBe("queued");
    await service.tick();

    const started = await service.get("task-1");
    const persisted = await readRuntime(home);
    expect(started.stage).toBe("implementing");
    expect(started.endpoints).toHaveLength(1);
    expect(started.endpoints?.[0]?.paneId).toBe("pane-1");
    expect(runnerState.launches).toBe(1);
    const workspaceCreate = runnerState.calls.find(
      (request) => request.argv.includes("workspace") && request.argv.includes("create"),
    );
    expect(workspaceCreate?.argv).toContain("└ implement exercise a durable service path · task-1");
    expect(persisted.tasks[0]?.taskName).toBe("tandem-task-1");
    expect(persisted.tasks[0]?.worktree?.name).toBe("tandem-task-1");
    expect(persisted.tasks[0]?.jobs[0]?.phase).toBe("running");
  });
});
test("implementer jobs receive bounded scout context and the full report artifact", async () => {
  await withFixture({ kind: "implementation" }, async ({ home, lease, service }) => {
    const reportPath = join(home, "jobs", "scout-1", "0", "job-1", "report.txt");
    const handoff = {
      scoutTaskId: "scout-1",
      scoutRepoPath: join(home, "repo"),
      scoutSourceHead: SOURCE_CHECKPOINT.head,
      scoutSourceBase: SOURCE_CHECKPOINT.base,
      reportPath,
      reportDigest: "a".repeat(64),
      excerpt: "Evidence from scout.",
    } as const;
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => TIMESTAMP,
      idFactory: () => "unused",
    });
    const current = await store.read("task-1");
    if (current === undefined) throw new Error("fixture implementation task missing");
    await store.update(current.id, current.revision, (task) => ({
      ...task,
      revision: task.revision + 1,
      updatedAt: TIMESTAMP,
      worktree: lease,
      researchHandoffs: [handoff],
    }));
    const runtime = await readRuntime(home);
    await writeRuntimeState(runtimeFile(home), {
      ...runtime,
      tasks: runtime.tasks.map((entry) => ({
        ...entry,
        worktree: lease,
        endpoints: [],
        jobs: [],
      })),
    });

    await service.approve("task-1");
    await service.tick();

    const launched = (await readRuntime(home)).tasks[0]?.jobs[0];
    if (launched === undefined) throw new Error("implementer job was not persisted");
    const spec = JSON.parse(await readFile(launched.jobPath, "utf8")) as {
      readonly prompt: string;
    };
    expect(spec.prompt).toContain("Evidence from scout.");
    expect(spec.prompt).toContain("untrusted task evidence");
    expect(spec.prompt).toContain(reportPath);
  });
});

test("two controllers serialize one worker dispatch and persist one active job", async () => {
  await withFixture(
    {
      kind: "scout",
      stage: "queued",
      runner: { active: false },
    },
    async ({ home, lease, endpoint, run, service, runnerState }) => {
      const seededStore = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const current = await seededStore.read("task-1");
      if (current === undefined) throw new Error("fixture task missing");
      await seededStore.update(current.id, current.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        updatedAt: TIMESTAMP,
        worktree: lease,
      }));
      await writeRuntimeState(runtimeFile(home), {
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "task-1",
            sourceCheckpoint: SOURCE_CHECKPOINT,
            taskName: "tandem-task-1",
            worktree: lease,
            endpoints: [endpoint],
            jobs: [],
          },
        ],
        presentations: [],
      });
      const other = createTandemService({
        home,
        sessionId: "session-1",
        poolRoot: lease.root,
        run,
        clock: () => TIMESTAMP,
        idFactory: () => "other-job",
      });
      await Promise.all([service.tick(), other.tick()]);
      const task = await service.get("task-1");
      const runtime = await readRuntime(home);
      expect({ stage: task.stage, blockReason: task.blockReason }).toEqual({
        stage: "scouting",
        blockReason: undefined,
      });
      expect(runnerState.launches).toBe(1);
      expect(runtime.tasks[0]?.jobs).toHaveLength(1);
      expect(runtime.tasks[0]?.jobs[0]?.phase).toBe("running");
      expect(activeRuntimeJob(runtime.tasks[0]?.jobs[0] as DurableJob)).toBe(true);
    },
  );
});

test("pause waits behind launch proof and prevents a second dispatch", async () => {
  await withFixture(
    {
      kind: "scout",
      stage: "queued",
      runner: { active: false, holdProof: true },
      runtimeEdits: {},
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const current = await store.read("task-1");
      if (current === undefined) throw new Error("fixture task missing");
      await store.update(current.id, current.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        updatedAt: TIMESTAMP,
        worktree: lease,
      }));
      await writeRuntimeState(runtimeFile(home), {
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "task-1",
            sourceCheckpoint: SOURCE_CHECKPOINT,
            taskName: "tandem-task-1",
            worktree: lease,
            endpoints: [endpoint],
            jobs: [],
          },
        ],
        presentations: [],
      });
      const tick = service.tick();
      await runnerState.proofStarted;
      const pause = service.pause("task-1", "pause during startup");
      runnerState.releaseProof();
      await Promise.all([pause, tick]);
      expect((await service.get("task-1")).stage).toBe("paused");
      expect(runnerState.launches).toBe(1);
      expect(runnerState.active).toBe(false);
      const persisted = await readRuntime(home);
      expect(persisted.tasks[0]?.stopRequest?.action).toBe("pause");
    },
  );
});
test("pause treats a missing worker pane as already stopped", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: false, paneState: "missing" },
    },
    async ({ home, lease, service }) => {
      const endpoint = endpointFor("implementer");
      await seedTaskResources(home, lease, [endpoint], []);

      const paused = await service.pause("task-1", "stop the missing worker pane");
      expect(paused.stage).toBe("paused");
      const runtime = await readRuntime(home);
      expect(runtime.tasks[0]?.stopRequest?.action).toBe("pause");
    },
  );
});

test("shutdown waits for an active scheduler tick to drain its launch proof", async () => {
  await withFixture(
    {
      kind: "scout",
      stage: "queued",
      runner: { active: false, holdProof: true },
      runtimeEdits: {},
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const current = await store.read("task-1");
      if (current === undefined) throw new Error("fixture task missing");
      await store.update(current.id, current.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        updatedAt: TIMESTAMP,
        worktree: lease,
      }));
      await writeRuntimeState(runtimeFile(home), {
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "task-1",
            sourceCheckpoint: SOURCE_CHECKPOINT,
            taskName: "tandem-task-1",
            worktree: lease,
            endpoints: [endpoint],
            jobs: [],
          },
        ],
        presentations: [],
      });
      const tick = service.tick();
      await runnerState.proofStarted;
      let shutdownSettled = false;
      const shutdown = service.shutdown().then(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      runnerState.releaseProof();
      await tick;
      await shutdown;
      expect(shutdownSettled).toBe(true);
    },
  );
});

test("pre-job validation blocker can resume without retaining a reservation", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "validating",
      taskEdits: { reviewHead: "source-head" },
    },
    async ({ service, home, lease }) => {
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const current = await store.read("task-1");
      if (current === undefined) throw new Error("fixture task missing");
      await store.update(current.id, current.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        updatedAt: TIMESTAMP,
        worktree: lease,
      }));
      await service.tick();
      expect((await service.get("task-1")).stage).toBe("blocked");
      const resumed = await service.resume("task-1");
      expect(resumed.stage).toBe("validating");
      const runtime = await readRuntime(home);
      expect(runtime.tasks[0]?.reservation?.phase).toBe("released");
      expect(runtime.tasks[0]?.jobs).toHaveLength(0);
    },
  );
});

test("source checkpoint diagnostics distinguish dirty worktrees from changed HEADs", async () => {
  await withFixture({ kind: "implementation", runner: { dirty: true } }, async ({ service }) => {
    await expect(service.approve("task-1")).rejects.toThrow(
      "source checkpoint is unsafe: current worktree is dirty",
    );
  });
  await withFixture(
    { kind: "implementation", runner: { checkoutHead: "changed-head" } },
    async ({ service }) => {
      await expect(service.approve("task-1")).rejects.toThrow(
        "source checkpoint is unsafe: HEAD changed from source-head to changed-head",
      );
    },
  );
});
test("managed coordinator sources permit clean refreshes but retain dirty safety", () => {
  const workflow = Object.create(WorkerWorkflow.prototype) as WorkerWorkflow;
  const pinned = {
    head: "source-a",
    base: "source-a",
    diff: "",
    dirty: false,
    unmerged: false,
  };
  expect(() =>
    workflow.assertSourceUnchanged(pinned, { ...pinned, head: "source-b", base: "source-b" }, true),
  ).not.toThrow();
  expect(() =>
    workflow.assertSourceUnchanged(
      pinned,
      { ...pinned, head: "source-b", base: "source-b", dirty: true },
      true,
    ),
  ).toThrow("current worktree is dirty");
  expect(() =>
    workflow.assertSourceUnchanged(pinned, { ...pinned, head: "source-b", base: "source-b" }),
  ).toThrow("HEAD changed from source-a to source-b");
});
test("blocks a saved lease whose checkout moved before the first worker in both queue recovery shapes", async () => {
  const capturedSource = {
    head: "A",
    base: "A",
    diff: "",
    dirty: false,
    unmerged: false,
  } as const;
  for (const recovered of [false, true]) {
    await withFixture(
      {
        kind: "scout",
        stage: recovered ? "blocked" : "queued",
        ...(recovered ? { taskEdits: { previousStage: "queued" as const } } : {}),
        runner: {
          checkoutHeadFor: (path) => (path.endsWith("/repo") ? "A" : "B"),
        },
      },
      async ({ home, lease, endpoint, service, runnerState }) => {
        const savedLease = { ...lease, baseHead: "A" };
        const store = createTaskStore({
          directory: join(home, "tasks"),
          clock: () => TIMESTAMP,
          idFactory: () => "unused",
        });
        const current = await store.read("task-1");
        if (current === undefined) throw new Error("fixture task missing");
        await store.update(current.id, current.revision, (task) => ({
          ...task,
          revision: task.revision + 1,
          updatedAt: TIMESTAMP,
          ...(recovered ? { worktree: savedLease, endpoints: [endpoint] } : {}),
        }));
        await writeRuntimeState(runtimeFile(home), {
          schemaVersion: 1,
          tasks: [
            {
              schemaVersion: 1,
              taskId: "task-1",
              sourceCheckpoint: capturedSource,
              taskName: "tandem-task-1",
              worktree: savedLease,
              endpoints: recovered ? [endpoint] : [],
              jobs: [],
            },
          ],
          presentations: [],
        });

        if (recovered) {
          expect((await service.resume("task-1")).stage).toBe("queued");
        }
        await service.tick();

        const task = await service.get("task-1");
        const persisted = await readRuntime(home);
        const runtime = persisted.tasks[0];
        expect(task.stage).toBe("blocked");
        expect(task.blockReason).toContain("saved worktree is not the captured source commit A");
        expect(runtime?.jobs).toHaveLength(0);
        expect(runtime?.worktree?.path).toBe(savedLease.path);
        expect(runtime?.worktree?.leaseId).toBe(savedLease.leaseId);
        expect(runnerState.launches).toBe(0);
        expect(
          runnerState.calls.some(
            (request) =>
              request.argv[0] === "git" &&
              request.argv.some((argument) => ["checkout", "reset", "switch"].includes(argument)),
          ),
        ).toBe(false);
      },
    );
  }
});

test("scout success is blocked and the worktree is preserved when checkout changed", async () => {
  await withFixture(
    {
      kind: "scout",
      stage: "scouting",
      taskEdits: {},
      runner: { active: false, checkoutHead: "changed-head" },
    },
    async ({ home, lease, endpoint, service }) => {
      const job = workerJob(home, endpoint, "scout");
      await writeJsonAtomically(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: job.role,
        status: "completed",
        text: "scout report",
        finishedAt: TIMESTAMP,
      });
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const current = await store.read("task-1");
      if (current === undefined) throw new Error("fixture task missing");
      await store.update(current.id, current.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        updatedAt: TIMESTAMP,
        worktree: lease,
        endpoints: [endpoint],
      }));
      const operation = { ...operationForJob(job, current), phase: "finalizing" as const };
      const linkedJob = { ...job, operationId: operation.id };
      await writeRuntimeState(runtimeFile(home), {
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "task-1",
            sourceCheckpoint: SOURCE_CHECKPOINT,
            taskName: "tandem-task-1",
            operation,
            worktree: lease,
            endpoints: [endpoint],
            jobs: [linkedJob],
          },
        ],
        presentations: [],
      });
      await service.tick();
      const task = await service.get("task-1");
      const runtime = await readRuntime(home);
      expect(task.stage).toBe("blocked");
      expect(task.worktree?.path).toBe(lease.path);
      expect(runtime.tasks[0]?.worktree?.path).toBe(lease.path);
      expect(runtime.tasks[0]?.jobs[0]?.phase).toBe("consumed");
    },
  );
});

test("active worker watchdog warns once per quiet episode without a runtime kill", async () => {
  let nowMs = Date.parse(TIMESTAMP);
  const clock = (): string => new Date(nowMs).toISOString();
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: true },
      clock,
      idFactory: () => "watchdog-warning",
    },
    async ({ home, lease, service, runnerState }) => {
      const endpoint = endpointFor("implementer");
      const baseJob = workerJob(home, endpoint, "implementer");
      const receiptPath = join(dirname(baseJob.jobPath), "communication.json");
      const job: DurableJob = { ...baseJob, receiptPath };
      const writeReceipt = async (timestamp: string): Promise<void> => {
        const receipt: WorkerReceipt = {
          schemaVersion: 1,
          jobId: job.id,
          taskId: job.taskId,
          generation: job.generation,
          receivedRevision: 0,
          appliedRevision: 0,
          heartbeatAt: timestamp,
          progressAt: timestamp,
          phase: "model",
        };
        await writeJsonAtomically(receiptPath, receipt);
      };
      const readRuntimeTask = async (): Promise<RuntimeTaskState> => {
        const state = await readRuntime(home);
        const runtime = state.tasks[0];
        if (runtime === undefined) throw new Error("watchdog runtime task missing");
        return runtime;
      };

      await writeReceipt(clock());
      await seedTaskResources(home, lease, [endpoint], [job]);

      nowMs += 16 * 60 * 1000;
      await writeReceipt(clock());
      await service.tick();
      let task = await service.get("task-1");
      expect(task.notifications.filter((entry) => entry.kind === "coordinator")).toHaveLength(0);
      expect((await readRuntimeTask()).jobs[0]?.phase).toBe("running");
      expect(runnerState.active).toBe(true);

      nowMs += 6 * 60 * 1000;
      await service.tick();
      task = await service.get("task-1");
      expect(task.stage).toBe("implementing");
      expect(task.notifications.filter((entry) => entry.kind === "coordinator")).toHaveLength(1);
      expect((await readRuntimeTask()).jobs[0]?.phase).toBe("running");
      expect(runnerState.active).toBe(true);

      await service.tick();
      task = await service.get("task-1");
      expect(task.notifications.filter((entry) => entry.kind === "coordinator")).toHaveLength(1);

      nowMs += 60 * 1000;
      await writeReceipt(clock());
      await service.tick();
      expect((await readRuntimeTask()).jobs[0]?.progressWarningAt).toBeUndefined();

      nowMs += 6 * 60 * 1000;
      await service.tick();
      task = await service.get("task-1");
      expect(task.notifications.filter((entry) => entry.kind === "coordinator")).toHaveLength(2);
      expect((await readRuntimeTask()).jobs[0]?.phase).toBe("running");
      expect(runnerState.active).toBe(true);
    },
  );
});

test("endpoint launch recovery adopts the exact Herdr pane without creating another workspace", async () => {
  await withFixture(
    {
      kind: "scout",
      stage: "queued",
      runner: { active: false, workspaceLabel: "└ Saved recovery label · task-1 · scout" },
    },
    async ({ home, lease, service, runnerState }) => {
      const reservationBase = reservationFor("task-1", "endpoint");
      const seedJob = workerJob(home, endpointFor("scout"), "scout", "reserved");
      const currentTask = await service.get("task-1");
      const operation = { ...operationForJob(seedJob, currentTask), phase: "admitted" as const };
      const reservation = { ...reservationBase, operationId: operation.id };
      const endpointLaunch = {
        schemaVersion: 1 as const,
        reservationId: reservation.id,
        operationId: operation.id,
        sessionId: "session-1",
        taskName: "tandem-task-1",
        workspaceLabel: "└ Saved recovery label · task-1 · scout",
        cwd: lease.path,
        role: "scout" as const,
        generation: 0,
        createdAt: TIMESTAMP,
      };
      const operationWithEndpointIntent: DurableOperation = {
        ...operation,
        effects: [
          {
            id: `endpoint:${operation.id}`,
            kind: "endpoint",
            phase: "intent",
            createdAt: TIMESTAMP,
            identity: endpointLaunch.workspaceLabel,
          },
        ],
      };
      await writeRuntimeState(runtimeFile(home), {
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "task-1",
            sourceCheckpoint: SOURCE_CHECKPOINT,
            operation: operationWithEndpointIntent,
            taskName: "tandem-task-1",
            reservation,
            endpointLaunch,
            worktree: lease,
            endpoints: [],
            jobs: [],
          },
        ],
        presentations: [],
      });
      await service.tick();
      const task = await service.get("task-1");
      const persisted = await readRuntime(home);
      expect(task.stage).toBe("scouting");
      expect(runnerState.launches).toBe(1);
      expect(persisted.tasks[0]?.endpointLaunch).toBeUndefined();
      expect(persisted.tasks[0]?.endpoints[0]?.paneId).toBe("pane-1");
      expect(
        runnerState.calls.some(
          (request) => request.argv.includes("workspace") && request.argv.includes("create"),
        ),
      ).toBe(false);
    },
  );
});

test("owned pre-launch worker reservation recovers without a duplicate admission", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: false },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      await seedTaskResources(home, lease, [endpoint], []);
      const job = workerJob(home, endpoint, "implementer", "reserved");
      await seedOperationIntent(home, job, "admitted");

      await service.tick();
      expect(runnerState.launches).toBe(1);
      const recovered = await readRuntime(home);
      expect(activeReservations(recovered)).toBe(1);
      expect(recovered.tasks[0]?.jobs.filter(activeRuntimeJob)).toHaveLength(1);
    },
  );
});

test("pending worker consumption replays once from its persisted two-file identity", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      taskEdits: {},
      runner: { active: false, checkoutHead: "new-head" },
    },
    async ({ home, lease, service }) => {
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const initial = await service.get("task-1");
      await store.update(initial.id, initial.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        updatedAt: TIMESTAMP,
        worktree: lease,
        endpoints: [endpointFor("implementer")],
      }));
      const before = await service.get("task-1");
      const endpoint = endpointFor("implementer");
      const job = workerJob(home, endpoint, "implementer");
      const event: TaskEvent = {
        type: "implementation-complete",
        head: "new-head",
        generation: 0,
        reportPath: join(home, "jobs", "task-1", "0", "job-1", "report.txt"),
      };
      const after = transitionTask(before, event, {
        now: TIMESTAMP,
        notificationId: "notification-1",
      });
      await writeJsonAtomically(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: job.role,
        status: "completed",
        text: "implementation report",
        finishedAt: TIMESTAMP,
      });
      const pending: DurableJob = {
        ...job,
        consumption: {
          schemaVersion: 1,
          inputEventKey: eventKey(job.id, event),
          appliedEventKey: eventKey(job.id, event),
          beforeRevision: before.revision,
          afterRevision: after.revision,
          beforeFingerprint: taskFingerprint(before),
          taskFingerprint: taskFingerprint(after),
          now: TIMESTAMP,
          notificationId: "notification-1",
        },
      };
      const operation = { ...operationForJob(pending, before), phase: "finalizing" as const };
      const linkedPending = { ...pending, operationId: operation.id };
      await writeRuntimeState(runtimeFile(home), {
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "task-1",
            sourceCheckpoint: SOURCE_CHECKPOINT,
            taskName: "tandem-task-1",
            worktree: lease,
            endpoints: [endpoint],
            operation,
            jobs: [linkedPending],
          },
        ],
        presentations: [],
      });
      await service.tick();
      const consumed = await service.get("task-1");
      const runtime = await readRuntime(home);
      expect(consumed.stage).toBe("validating");
      expect(consumed.revision).toBe(after.revision);
      expect(runtime.tasks[0]?.jobs[0]?.phase).toBe("consumed");
      await service.tick();
      expect(consumed.notifications).toHaveLength(before.notifications.length);
      const repeated = await service.get("task-1");
      expect(repeated.revision).toBe(consumed.revision);
      expect(repeated.notifications).toHaveLength(consumed.notifications.length);
    },
  );
});

test("a direction arriving before worker completion survives an old-revision result", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: false, checkoutHead: "new-head" },
    },
    async ({ home, lease, service }) => {
      await service.steer({
        taskId: "task-1",
        text: "Keep the current scope and preserve the API.",
      });
      const endpoint = endpointFor("implementer");
      const baseJob = workerJob(home, endpoint, "implementer");
      const job: DurableJob = {
        ...baseJob,
        receiptPath: join(dirname(baseJob.jobPath), "communication.json"),
        instructionRevision: 0,
      };
      await writeJsonAtomically(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: job.role,
        status: "completed",
        text: "old worker result",
        finishedAt: TIMESTAMP,
        instructionRevision: 0,
      });
      await seedTaskResources(home, lease, [endpoint], [job]);

      await service.tick();

      const task = await service.get("task-1");
      const runtime = await readRuntime(home);
      expect(task.stage).toBe("implementing");
      expect(task.communication?.revision).toBe(1);
      expect(task.communication?.messages[0]?.text).toBe(
        "Keep the current scope and preserve the API.",
      );
      expect(runtime.tasks[0]?.jobs[0]?.phase).toBe("failed");
    },
  );
});

test("needs-decision survives reload, rejects stale answers, and resumes only after the matching answer", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: false },
    },
    async ({ home, lease, run, service }) => {
      const endpoint = endpointFor("implementer");
      const job = workerJob(home, endpoint, "implementer");
      await writeJsonAtomically(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: job.role,
        status: "needs-decision",
        text: "The implementation needs a decision.",
        question: {
          text: "Should the existing public API remain unchanged?",
          recommendation: "Keep the existing API unchanged.",
        },
        finishedAt: TIMESTAMP,
      });
      await seedTaskResources(home, lease, [endpoint], [job]);

      await service.tick();

      const reloaded = createTandemService({
        home,
        sessionId: "session-1",
        poolRoot: lease.root,
        run,
        clock: () => TIMESTAMP,
        idFactory: () => "reloaded-id",
      });
      try {
        const persisted = await reloaded.get("task-1");
        const question = persisted.communication?.question;
        if (question === undefined) throw new Error("needs-decision question was not persisted");
        expect(persisted.stage).toBe("blocked");
        expect(persisted.previousStage).toBe("implementing");
        expect(persisted.scopeApproved).toBe(true);

        await expect(
          reloaded.answer({
            taskId: "task-1",
            questionId: "stale-question",
            text: "This answer is stale.",
          }),
        ).rejects.toThrow("no longer current");
        const unchanged = await reloaded.get("task-1");
        expect(unchanged.revision).toBe(persisted.revision);
        expect(unchanged.communication).toEqual(persisted.communication);
        expect(unchanged.stage).toBe("blocked");

        const answered = await reloaded.answer({
          taskId: "task-1",
          questionId: question.id,
          text: "Yes, keep the existing public API unchanged.",
        });
        expect(answered.question).toBeUndefined();
        expect(answered.stage).toBe("implementing");
        const resumed = await reloaded.get("task-1");
        expect(resumed.stage).toBe("implementing");
        expect(resumed.scopeApproved).toBe(true);
        expect(resumed.communication?.messages.at(-1)?.kind).toBe("answer");
        expect(resumed.communication?.messages.at(-1)?.replyTo).toBe(question.id);
      } finally {
        await reloaded.shutdown();
      }
    },
  );
});
test("scout and reviewer questions preserve report evidence and resume only their prior role stage", async () => {
  const cases: readonly {
    readonly kind: "scout" | "implementation";
    readonly stage: "scouting" | "reviewing";
    readonly role: "scout" | "reviewer";
    readonly report: string;
  }[] = [
    {
      kind: "scout",
      stage: "scouting",
      role: "scout",
      report: "Outcome: needs-decision\nQuestion: Which source is authoritative?",
    },
    {
      kind: "implementation",
      stage: "reviewing",
      role: "reviewer",
      report: "Outcome: needs-decision\nQuestion: Which review evidence should be authoritative?",
    },
  ];
  for (const value of cases) {
    await withFixture(
      {
        kind: value.kind,
        stage: value.stage,
        ...(value.role === "reviewer" ? { taskEdits: { reviewHead: "source-head" } } : {}),
        runner: { active: false },
      },
      async ({ home, lease, service }) => {
        const endpoint = endpointFor(value.role);
        const writer = value.role === "reviewer" ? endpointFor("implementer") : undefined;
        const job = workerJob(home, endpoint, value.role);
        await writeJsonAtomically(job.resultPath, {
          id: job.id,
          taskId: job.taskId,
          generation: job.generation,
          role: job.role,
          status: "needs-decision",
          text: value.report,
          question: { text: value.report.split("Question: ")[1] },
          finishedAt: TIMESTAMP,
        });
        await seedTaskResources(
          home,
          lease,
          writer === undefined ? [endpoint] : [writer, endpoint],
          [job],
        );
        await service.tick();
        const blocked = await service.get("task-1");
        const question = blocked.communication?.question;
        if (question === undefined || blocked.reportPath === undefined) {
          throw new Error("worker question or report evidence was not persisted");
        }
        expect(blocked.stage).toBe("blocked");
        expect(await readFile(blocked.reportPath, "utf8")).toBe(value.report);
        await expect(
          service.answer({
            taskId: "task-1",
            questionId: "stale-question",
            text: "stale",
          }),
        ).rejects.toThrow("no longer current");
        const answered = await service.answer({
          taskId: "task-1",
          questionId: question.id,
          text: "Use the repository evidence.",
        });
        expect(answered.question).toBeUndefined();
        const answeredTask = await service.get("task-1");
        expect(answeredTask.blockReason).toBeUndefined();
        expect(answered.stage).toBe(value.stage);
        expect(answeredTask.reportPath).toBe(blocked.reportPath);
        expect(answered.messages.at(-1)?.replyTo).toBe(question.id);
      },
    );
  }
});
test("failed review results block the task instead of advancing into a review loop", async () => {
  for (const status of ["completed", "failed"] as const) {
    await withFixture(
      {
        kind: "implementation",
        stage: "reviewing",
        taskEdits: { reviewHead: "source-head" },
        runner: { active: false },
      },
      async ({ home, lease, service }) => {
        const endpoint = endpointFor("reviewer");
        const job = {
          ...workerJob(home, endpoint, "reviewer"),
          reviewLens: "design" as const,
          receiptPath: join(home, "review-receipt.json"),
          instructionRevision: 0,
        };
        await writeJsonAtomically(job.resultPath, {
          id: job.id,
          taskId: job.taskId,
          generation: job.generation,
          role: job.role,
          status,
          text: '{"lens":"design","head":"source-head","generation":0,"pass":false,"findings":[],"summary":"review"}',
          ...(status === "failed" ? { error: "review output identity mismatch" } : {}),
          review: {
            lens: "design",
            head: "source-head",
            generation: 0,
            pass: false,
            findings: [],
            summary: "review",
          },
          finishedAt: TIMESTAMP,
        });
        await seedTaskResources(home, lease, [endpointFor("implementer"), endpoint], [job]);

        await service.tick();
        const blocked = await service.get("task-1");
        expect(blocked.stage).toBe("blocked");
        expect(blocked.blockReason).toContain("stale worker instruction");

        await service.tick();
        const runtime = await readRuntime(home);
        expect(runtime.tasks[0]?.jobs).toHaveLength(1);
        expect(runtime.tasks[0]?.jobs[0]?.phase).toBe("failed");
      },
    );
  }
});

test("communication repair and answer publication never preserve a stale inbox revision", async () => {
  await withFixture(
    { kind: "implementation", stage: "implementing" },
    async ({ home, service }) => {
      await service.steer({
        taskId: "task-1",
        text: "Keep the current implementation scope.",
      });
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const current = await store.read("task-1");
      if (current?.communication === undefined) throw new Error("communication was not persisted");
      const communication = current.communication;
      const withQuestion = await store.update(current.id, current.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        updatedAt: TIMESTAMP,
        communication: {
          ...communication,
          question: {
            id: "question-1",
            text: "Should the implementation keep the existing API?",
          },
        },
      }));
      if (withQuestion.communication === undefined) throw new Error("question was not persisted");
      const inboxPath = taskInboxPath(home, "task-1");
      const staleInbox = taskInbox("task-1", withQuestion.communication);
      await writeTaskInbox(inboxPath, staleInbox);

      const answered = await service.answer({
        taskId: "task-1",
        questionId: "question-1",
        text: "Yes, keep the existing API.",
      });
      expect(answered.messages.at(-1)?.kind).toBe("answer");
      const published = await readTaskInbox(inboxPath);
      if (published === undefined) throw new Error("answer inbox was not published");
      expect(published.revision).toBe(2);

      await writeTaskInbox(inboxPath, staleInbox);
      await service.messages("task-1");
      const repaired = await readTaskInbox(inboxPath);
      if (repaired === undefined) throw new Error("repaired inbox is missing");
      expect(repaired.revision).toBe(2);
    },
  );
});

test("resume refuses an active worker pane and leaves the paused task unchanged", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "paused",
      taskEdits: { previousStage: "implementing" },
      runner: { active: true },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      const job = workerJob(home, endpointFor("implementer"), "implementer");
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const current = await store.read("task-1");
      if (current === undefined) throw new Error("fixture task missing");
      await store.update(current.id, current.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        updatedAt: TIMESTAMP,
        worktree: lease,
        endpoints: [endpoint],
      }));
      const operation = { ...operationForJob(job, current), phase: "running" as const };
      const linkedJob = { ...job, operationId: operation.id };
      await writeRuntimeState(runtimeFile(home), {
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            taskId: "task-1",
            sourceCheckpoint: SOURCE_CHECKPOINT,
            taskName: "tandem-task-1",
            operation,
            worktree: lease,
            endpoints: [endpoint],
            jobs: [linkedJob],
          },
        ],
        presentations: [],
      });
      const before = await service.get("task-1");
      await expect(service.resume("task-1")).rejects.toThrow("active worker");
      const after = await service.get("task-1");
      expect(after.stage).toBe("paused");
      expect(after.revision).toBe(before.revision);
      expect(runnerState.launches).toBe(0);
      expect(runnerState.calls.some((request) => request.argv.includes("send-keys"))).toBe(false);
    },
  );
});

test("an existing presentation reservation is not treated as permission for a duplicate launch", async () => {
  await withFixture({}, async ({ home, service, runnerState }) => {
    const recordPath = join(home, "presentation-record.json");
    const jobPath = join(home, "presentation-job.json");
    const resultPath = join(home, "presentation-result.json");
    const artifactPath = join(home, "artifact.html");
    await writeJsonAtomically(recordPath, {
      id: "presentation-1",
      taskId: "task-1",
      generation: 0,
      cwd: home,
      artifactPath,
      jobPath,
      resultPath,
      status: "queued",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    const presentation: RuntimePresentation = {
      schemaVersion: 1,
      id: "presentation-1",
      taskId: "task-1",
      recordPath,
      reservation: reservationFor("task-1", "reserved"),
      job: {
        schemaVersion: 1,
        id: "presentation-job-1",
        taskId: "task-1",
        generation: 0,
        role: "presentation",
        kind: "worker",
        cwd: home,
        jobPath,
        resultPath,
        attempt: 1,
        phase: "reserved",
        launchAttempted: false,
        createdAt: TIMESTAMP,
      },
    };
    const state = await readRuntime(home);
    await writeRuntimeState(runtimeFile(home), {
      ...state,
      presentations: [presentation],
    });
    await service.tick();
    const persisted = await readRuntime(home);
    expect(runnerState.launches).toBe(0);
    expect(persisted.presentations[0]?.reservation?.id).toBe("reservation-1");
    expect(persisted.presentations[0]?.job.phase).toBe("reserved");
  });
});

test("reloads a browser-disconnected presentation as open for an explicit user decision", async () => {
  await withFixture({}, async ({ home, service, runnerState }) => {
    const recordPath = join(home, "record.json");
    const jobPath = join(home, "job.json");
    const resultPath = join(home, "result.json");
    const artifactPath = join(home, "artifact.html");
    await writeJsonAtomically(recordPath, {
      id: "presentation-2",
      taskId: "task-1",
      generation: 0,
      cwd: home,
      artifactPath,
      jobPath,
      resultPath,
      status: "open",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      observation: {
        artifact: artifactPath,
        status: "browser_disconnected",
        terminal: false,
        sessionEnded: false,
        raw: "browser disconnected",
        rawFeedback: "",
      },
    });
    const runtime = await readRuntime(home);
    await writeRuntimeState(runtimeFile(home), {
      ...runtime,
      presentations: [
        {
          schemaVersion: 1,
          id: "presentation-2",
          taskId: "task-1",
          recordPath,
          job: {
            schemaVersion: 1,
            id: "presentation-job-2",
            taskId: "task-1",
            generation: 0,
            role: "presentation",
            kind: "worker",
            cwd: home,
            jobPath,
            resultPath,
            attempt: 1,
            phase: "consumed",
            launchAttempted: true,
            createdAt: TIMESTAMP,
            consumedAt: TIMESTAMP,
          },
        },
      ],
    });
    await service.tick();
    expect(runnerState.calls.some((request) => request.argv[0] === "lavish-axi")).toBe(false);
    const [record] = await service.presentations();
    expect(record?.status).toBe("open");
    expect(record?.observation?.status).toBe("browser_disconnected");
    expect(record?.observation?.terminal).toBe(false);
    const feedback = service.feedback("presentation-2");
    await runnerState.presentationStarted;
    runnerState.releasePresentation();
    const reconnected = await feedback;
    expect(reconnected.status).toBe("open");
    expect(reconnected.observation?.status).toBe("waiting");
    const polls = runnerState.calls.filter(
      (request) => request.argv[0] === "lavish-axi" && request.argv[1] === "poll",
    );
    expect(polls).toHaveLength(1);
  });
});
test("scheduler starts open presentation feedback polling without blocking task reconciliation", async () => {
  await withFixture(
    {
      runner: {
        presentationResponses: [
          commandResult(
            [
              "session:",
              "  status: feedback",
              "  session_ended: true",
              "feedback[0]{message,kind}:",
              "  message: Select a direction",
            ].join("\n"),
          ),
        ],
      },
    },
    async ({ home, service, run, runnerState }) => {
      const recordPath = join(home, "automatic-record.json");
      const jobPath = join(home, "automatic-job.json");
      const resultPath = join(home, "automatic-result.json");
      const artifactPath = join(home, "automatic-artifact.html");
      await writeFile(artifactPath, "<!doctype html><title>automatic</title>", "utf8");
      await writeJsonAtomically(recordPath, {
        id: "presentation-automatic",
        taskId: "task-1",
        generation: 0,
        cwd: home,
        artifactPath,
        jobPath,
        resultPath,
        status: "open",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        observation: {
          artifact: artifactPath,
          status: "opened",
          terminal: false,
          sessionEnded: false,
          raw: "session:\n  status: opened\n  session_ended: false",
          rawFeedback: "",
        },
      });
      const runtime = await readRuntime(home);
      await writeRuntimeState(runtimeFile(home), {
        schemaVersion: 1,
        tasks: runtime.tasks,
        presentations: [
          {
            schemaVersion: 1,
            id: "presentation-automatic",
            taskId: "task-1",
            recordPath,
            job: {
              schemaVersion: 1,
              id: "presentation-job-automatic",
              taskId: "task-1",
              generation: 0,
              role: "presentation",
              kind: "worker",
              cwd: home,
              jobPath,
              resultPath,
              attempt: 1,
              phase: "consumed",
              launchAttempted: true,
              createdAt: TIMESTAMP,
              consumedAt: TIMESTAMP,
            },
          },
        ],
      });

      await service.tick();
      await runnerState.presentationStarted;
      const automaticPoll = runnerState.calls.find(
        (request) => request.argv[0] === "lavish-axi" && request.argv[1] === "poll",
      );
      expect(automaticPoll?.timeoutMs).toBeUndefined();
      const feedback = service.feedback("presentation-automatic");
      runnerState.releasePresentation();
      const observed = await feedback;
      expect(observed.status).toBe("ended");
      expect(observed.observation?.status).toBe("feedback");
      const task = await service.get("task-1");
      const feedbackNotifications = task.notifications.filter(
        (entry) => entry.kind === "coordinator" && entry.message.includes("Select a direction"),
      );
      expect(feedbackNotifications).toHaveLength(1);
      const feedbackNotification = feedbackNotifications[0];
      expect(feedbackNotification?.acknowledged).toBe(false);
      if (feedbackNotification === undefined)
        throw new Error("feedback notification was not persisted");
      await service.acknowledge(task.id, feedbackNotification.id);
      await service.shutdown();
      const restarted = createTandemService({
        home,
        sessionId: "session-restarted",
        poolRoot: join(home, "pool"),
        run,
        clock: () => TIMESTAMP,
        idFactory: () => "restarted-id",
      });
      try {
        await restarted.tick();
        const afterRestart = await restarted.get("task-1");
        const replayedFeedback = afterRestart.notifications.filter(
          (entry) => entry.kind === "coordinator" && entry.message.includes("Select a direction"),
        );
        expect(replayedFeedback.map((entry) => [entry.id, entry.acknowledged])).toEqual([
          [feedbackNotification.id, true],
        ]);
      } finally {
        runnerState.releasePresentation();
        await restarted.shutdown();
      }
    },
  );
});

test("persists full feedback evidence across a later poll and restart", async () => {
  await withFixture(
    {
      runner: {
        presentationResponses: [
          commandResult(
            [
              "session:",
              "  status: feedback",
              "  session_ended: false",
              "feedback[0]{message,kind}:",
              "  message: Choose the safer option",
            ].join("\n"),
          ),
          commandResult("session:\n  status: ended\n  session_ended: true\n"),
        ],
      },
    },
    async ({ home, run, service, runnerState }) => {
      await seedConsumedPresentation(home, "presentation-evidence");
      await service.tick();
      await runnerState.presentationStarted;
      const firstFeedback = service.feedback("presentation-evidence");
      runnerState.releasePresentation();
      const first = await firstFeedback;
      expect(first.status).toBe("open");
      const task = await service.get("task-1");
      const notification = task.notifications.find((entry) =>
        entry.message.includes("feedback evidence:"),
      );
      if (notification === undefined) throw new Error("feedback notification was not persisted");
      const evidencePath = notification.message.match(
        /^(.+\/feedback\/[A-Za-z0-9._-]+\.json) — /u,
      )?.[1];
      if (evidencePath === undefined) throw new Error("feedback evidence path was not notified");
      const evidence = JSON.parse(await Bun.file(evidencePath).text()) as {
        readonly presentationId: string;
        readonly eventId: string;
        readonly observation: { readonly rawFeedback: string };
      };
      expect(evidence.presentationId).toBe("presentation-evidence");
      expect(evidence.eventId.length).toBeGreaterThan(0);
      expect(evidence.observation.rawFeedback).toContain("Choose the safer option");

      const ended = await service.feedback("presentation-evidence");
      expect(ended.status).toBe("ended");
      await service.shutdown();
      const restarted = createTandemService({
        home,
        sessionId: "session-restarted",
        poolRoot: join(home, "pool"),
        run,
        clock: () => TIMESTAMP,
        idFactory: () => "restarted-id",
      });
      try {
        await restarted.tick();
        const afterRestart = await restarted.get("task-1");
        expect(
          afterRestart.notifications.some((entry) => entry.message.includes(evidencePath)),
        ).toBe(true);
        const persisted = JSON.parse(await Bun.file(evidencePath).text()) as {
          readonly observation: { readonly rawFeedback: string };
        };
        expect(persisted.observation.rawFeedback).toContain("Choose the safer option");
      } finally {
        await restarted.shutdown();
      }
    },
  );
});

test("separate controllers serialize native presentation consumption", async () => {
  await withFixture({}, async ({ home, service, run, runnerState }) => {
    await seedConsumedPresentation(home, "presentation-lock");
    const other = createTandemService({
      home,
      sessionId: "session-2",
      poolRoot: join(home, "pool"),
      run,
      clock: () => TIMESTAMP,
      idFactory: () => "other-id",
    });
    try {
      await Promise.all([service.tick(), other.tick()]);
      await runnerState.presentationStarted;
      await Promise.resolve();
      const polls = runnerState.calls.filter(
        (request) => request.argv[0] === "lavish-axi" && request.argv[1] === "poll",
      );
      expect(polls).toHaveLength(1);
    } finally {
      runnerState.releasePresentation();
      await other.shutdown();
    }
  });
});

test("shutdown stops owned presentation polling without starting a later poll", async () => {
  await withFixture({}, async ({ home, service, runnerState }) => {
    await seedConsumedPresentation(home, "presentation-shutdown");
    await service.tick();
    await runnerState.presentationStarted;
    const shutdown = service.shutdown();
    runnerState.releasePresentation();
    await shutdown;
    await service.tick();
    const polls = runnerState.calls.filter(
      (request) => request.argv[0] === "lavish-axi" && request.argv[1] === "poll",
    );
    expect(polls).toHaveLength(1);
  });
});

test("resume consumes a stopped worker result once without relaunching the implementation", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "paused",
      taskEdits: { previousStage: "implementing" },
      runner: { active: false, checkoutHead: "new-head" },
    },
    async ({ home, lease, service, runnerState }) => {
      const endpoint = endpointFor("implementer");
      const job = workerJob(home, endpoint, "implementer");
      await seedTaskResources(home, lease, [endpoint], [job]);
      await writeJsonAtomically(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: "implementer",
        status: "completed",
        text: "Outcome: implemented",
        finishedAt: TIMESTAMP,
      });

      const resumed = await service.resume("task-1");
      expect(resumed.stage).toBe("validating");
      expect(runnerState.launches).toBe(0);
      const persisted = await readRuntime(home);
      expect(persisted.tasks[0]?.jobs[0]?.phase).toBe("consumed");

      const repeated = await service.resume("task-1");
      expect(repeated.stage).toBe("validating");
      expect(runnerState.launches).toBe(0);
    },
  );
});

test("review result retains its reviewer pane with durable task revisions", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "reviewing",
      taskEdits: { reviewHead: "review-head" },
      runner: { active: false, checkoutHead: "review-head" },
    },
    async ({ home, lease, service, runnerState }) => {
      const endpoint = endpointFor("reviewer");
      const job = {
        ...workerJob(home, endpoint, "reviewer"),
        head: "review-head",
        reviewLens: "behavior" as const,
      };
      await seedTaskResources(home, lease, [endpoint], [job]);
      await writeJsonAtomically(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: "reviewer",
        status: "completed",
        text: "Review complete",
        review: {
          lens: "behavior",
          head: "review-head",
          generation: 0,
          pass: true,
          findings: [],
          summary: "No behavior findings",
        },
        finishedAt: TIMESTAMP,
      });
      const before = await service.get("task-1");

      await service.tick();

      const current = await service.get("task-1");
      expect(current.stage).toBe("reviewing");
      expect(current.reviews).toHaveLength(1);
      expect(current.endpoints ?? []).toHaveLength(1);
      expect(current.revision).toBe(before.revision + 1);
      expect(runnerState.launches).toBe(0);
      const runtime = await readRuntime(home);
      expect(runtime.tasks[0]?.operation?.kind).toBe("review");
    },
  );
});

test("consumes a completed interactive result before the OMP process exits", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: true, checkoutHead: "new-head" },
    },
    async ({ home, lease, service, runnerState }) => {
      const endpoint = endpointFor("implementer");
      const job = workerJob(home, endpoint, "implementer");
      await seedTaskResources(home, lease, [endpoint], [job]);
      await writeWorkerTerminal(job.jobPath, {
        schemaVersion: 1,
        jobId: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: "implementer",
        cwd: job.cwd,
        pid: 100,
        phase: "idle",
        completed: true,
        heartbeatAt: new Date().toISOString(),
      });
      await writeJsonAtomically(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: "implementer",
        status: "completed",
        text: "Implementation complete",
        finishedAt: new Date().toISOString(),
      });

      await service.tick();

      const current = await service.get("task-1");
      expect(current.stage).toBe("validating");
      expect(current.endpoints ?? []).toHaveLength(1);
      expect(runnerState.active).toBe(true);
    },
  );
});

test("blocks an interactive worker whose foreground PID is not the recorded worker", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: true },
    },
    async ({ home, lease, service, runnerState }) => {
      const endpoint = endpointFor("implementer");
      const job = workerJob(home, endpoint, "implementer");
      await seedTaskResources(home, lease, [endpoint], [job]);
      await writeWorkerTerminal(job.jobPath, {
        schemaVersion: 1,
        jobId: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: "implementer",
        cwd: job.cwd,
        pid: 999,
        phase: "busy",
        completed: false,
        heartbeatAt: new Date().toISOString(),
      });

      await service.tick();

      const current = await service.get("task-1");
      expect(current.stage).toBe("blocked");
      expect(runnerState.launches).toBe(0);
    },
  );
});
test("validation runs in a split non-model pane beside the retained writer", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "validating",
      taskEdits: { reviewHead: "review-head" },
      runner: { checkoutHead: "review-head" },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      await seedTaskResources(home, lease, [endpoint], []);

      await service.tick();

      const persisted = await readRuntime(home);
      const runtime = persisted.tasks[0];
      if (runtime === undefined) throw new Error("fixture runtime task missing");
      const validationJob = runtime.jobs[0];
      const writer = runtime.endpoints.find((candidate) => candidate.paneId === endpoint.paneId);
      const validationEndpoint = runtime.endpoints.find(
        (candidate) => candidate.paneId !== endpoint.paneId,
      );
      expect(validationJob?.kind).toBe("validation");
      expect(validationJob?.endpoint?.paneId).toBe(validationEndpoint?.paneId);
      expect(writer?.paneId).toBe(endpoint.paneId);
      expect(validationEndpoint?.paneId).toBe("pane-2");
      expect(runnerState.launches).toBe(1);
      expect(runtime.operation?.kind).toBe("validation");
    },
  );
});

test("resume waits for capacity and retains admission after the slot is freed", async () => {
  for (const kind of ["implementation", "scout"] as const) {
    await withFixture(
      {
        kind,
        stage: "paused",
        maxWorkers: 1,
        taskEdits: {
          previousStage: kind === "scout" ? "scouting" : "implementing",
        },
        runner: { active: false },
      },
      async ({ home, lease, endpoint, service, runnerState }) => {
        await seedTaskResources(home, lease, [endpoint], []);
        const initial = await readRuntime(home);
        const taskRuntime = initial.tasks.find((entry) => entry.taskId === "task-1");
        if (taskRuntime === undefined) throw new Error("fixture runtime task missing");
        const busyRuntime: RuntimeTaskState = {
          schemaVersion: 1,
          taskId: "task-2",
          sourceCheckpoint: SOURCE_CHECKPOINT,
          taskName: "tandem-task-2",
          reservation: { ...reservationFor("task-2"), id: "busy-reservation" },
          endpoints: [],
          jobs: [],
        };
        await writeRuntimeState(runtimeFile(home), {
          schemaVersion: 1,
          tasks: [
            {
              ...taskRuntime,
              reservation: {
                ...reservationFor("task-1", "released"),
                releasedAt: TIMESTAMP,
              },
            },
            busyRuntime,
          ],
          presentations: initial.presentations,
        });

        const resumed = await service.resume("task-1");
        expect(resumed.stage).toBe(kind === "scout" ? "scouting" : "implementing");
        expect(runnerState.launches).toBe(0);
        const waiting = await readRuntime(home);
        const waitingTask = waiting.tasks.find((entry) => entry.taskId === "task-1");
        expect(waitingTask?.reservation?.phase).toBe("released");
        expect(waitingTask?.worktree?.path).toBe(lease.path);

        const withFreeSlot = await readRuntime(home);
        await writeRuntimeState(runtimeFile(home), {
          schemaVersion: 1,
          tasks: withFreeSlot.tasks.map(
            (entry): RuntimeTaskState =>
              entry.taskId === "task-2" && entry.reservation !== undefined
                ? {
                    ...entry,
                    reservation: {
                      ...entry.reservation,
                      phase: "released",
                      releasedAt: TIMESTAMP,
                    },
                  }
                : entry,
          ),
          presentations: withFreeSlot.presentations,
        });

        await service.tick();
        expect(runnerState.launches).toBe(1);
        const running = await readRuntime(home);
        expect(activeReservations(running)).toBe(1);
        const resumedRuntime = running.tasks.find((entry) => entry.taskId === "task-1");
        expect(resumedRuntime?.jobs.filter(activeRuntimeJob)).toHaveLength(1);
      },
    );
  }
});

test("resume after an interrupted worker abandons the stopped job and dispatches continuation", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: false },
    },
    async ({ home, lease, service, runnerState }) => {
      const endpoint = endpointFor("implementer");
      await seedTaskResources(home, lease, [endpoint], []);
      await service.tick();
      expect(runnerState.launches).toBe(1);

      const paused = await service.pause("task-1", "pause for continuation");
      expect(paused.stage).toBe("paused");
      expect(runnerState.active).toBe(false);

      const resumed = await service.resume("task-1");
      expect(resumed.stage).toBe("implementing");
      expect(runnerState.launches).toBe(2);
      const persisted = await readRuntime(home);
      const jobs = persisted.tasks[0]?.jobs ?? [];
      expect(jobs.some((job) => job.phase === "failed")).toBe(true);
      expect(jobs.filter(activeRuntimeJob)).toHaveLength(1);
    },
  );
});

test("resume tolerates a closed reviewer pane and removes it without a revision conflict", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "paused",
      taskEdits: { previousStage: "reviewing", reviewHead: "review-head" },
      runner: { active: false, paneState: "missing" },
    },
    async ({ home, lease, service }) => {
      const endpoint = endpointFor("reviewer");
      await seedTaskResources(home, lease, [endpoint], []);
      const before = await service.get("task-1");

      const resumed = await service.resume("task-1");
      expect(resumed.stage).toBe("reviewing");
      await service.tick();

      const current = await service.get("task-1");
      expect(current.stage).toBe("reviewing");
      expect(current.endpoints ?? []).toHaveLength(0);
      expect(current.revision).toBe(before.revision + 2);
      const persisted = await readRuntime(home);
      expect(persisted.tasks[0]?.endpoints).toHaveLength(0);
    },
  );
});

test("resume refuses a foreign endpoint during root recovery", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "paused",
      taskEdits: { previousStage: "implementing" },
      runner: { active: false, paneState: "foreign" },
    },
    async ({ home, lease, service, runnerState }) => {
      const endpoint = endpointFor("implementer");
      await seedTaskResources(home, lease, [endpoint], []);
      const before = await service.get("task-1");

      await expect(service.resume("task-1")).rejects.toThrow("could not be proven owned");

      const current = await service.get("task-1");
      expect(current.stage).toBe("paused");
      expect(current.revision).toBe(before.revision);
      expect(runnerState.launches).toBe(0);
    },
  );
});

test("rejects a relative durable home before constructing service state", () => {
  expect(() => createTandemService({ home: "relative-home", sessionId: "session-1" })).toThrow(
    TypeError,
  );
});

async function seedOperationIntent(
  home: string,
  job: DurableJob,
  phase: DurableOperation["phase"] = "admitted",
): Promise<DurableOperation> {
  const state = await readRuntime(home);
  const runtime = state.tasks.find((entry) => entry.taskId === job.taskId);
  if (runtime === undefined) throw new Error("fixture runtime task missing");
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: () => TIMESTAMP,
    idFactory: () => "unused",
  });
  const task = await store.read(job.taskId);
  if (task === undefined) throw new Error("fixture task missing");
  const operation = { ...operationForJob(job, task), phase };
  const linkedJob = { ...job, operationId: operation.id };
  const reservation = { ...reservationFor(job.taskId), operationId: operation.id };
  await writeRuntimeState(runtimeFile(home), {
    ...state,
    tasks: state.tasks.map((entry) =>
      entry.taskId !== job.taskId
        ? entry
        : {
            ...entry,
            operation,
            reservation,
            jobs: [linkedJob],
          },
    ),
  });
  if (job.role !== "validation") {
    await writeJsonAtomically(job.jobPath, {
      schemaVersion: 1,
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      role: job.role,
      cwd: job.cwd,
      model: { model: `test/${job.role}`, thinking: "low" },
      prompt: "recover the admitted operation",
      resultPath: job.resultPath,
      execution: {
        schemaVersion: 1,
        home,
        operationId: operation.id,
        fencingRevision: operation.fencingRevision,
        claimOwner: operation.claimOwner,
      },
    });
  }
  return operation;
}

test("TAG-989 maxed awaiting-fixes intent cannot reserve, launch, or advance work", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "awaiting-fixes",
      taskEdits: { reviewRound: 1, reviewHead: "review-head" },
      runner: { active: false },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      await seedTaskResources(home, lease, [endpoint], []);
      const before = await service.get("task-1");

      await service.tick();

      const after = await service.get("task-1");
      const state = await readRuntime(home);
      const runtime = state.tasks[0];
      expect(after.stage).toBe("blocked");
      expect(after.generation).toBe(before.generation);
      expect(after.reviewRound).toBe(before.reviewRound);
      expect(after.reviewHead).toBe(before.reviewHead);
      expect(after.policy).toEqual(before.policy);
      expect(runnerState.launches).toBe(0);
      expect(activeReservations(state)).toBe(0);
      expect(runtime?.operation).toBeUndefined();
      expect(runtime?.endpoints).toEqual([endpoint]);
      expect(runtime?.jobs.some(activeRuntimeJob)).toBe(false);
    },
  );
});

test("awaiting-fixes below the budget resumes through one durable fix operation", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "awaiting-fixes",
      taskEdits: { reviewRound: 0, reviewHead: "review-head" },
      runner: { active: false, checkoutHead: "review-head" },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      await seedTaskResources(home, lease, [endpoint], []);
      await service.tick();

      const state = await readRuntime(home);
      const runtime = state.tasks[0];
      const task = await service.get("task-1");
      expect(task.stage).toBe("implementing");
      expect(task.reviewRound).toBe(1);
      expect(runtime?.operation?.kind).toBe("fix");
      expect(runtime?.operation?.inputHead).toBe("review-head");
      expect(runtime?.operation?.phase).toBe("running");
      expect(runtime?.jobs.filter(activeRuntimeJob)).toHaveLength(1);
      expect(runnerState.launches).toBe(1);

      await service.tick();
      const repeated = await readRuntime(home);
      expect(repeated.tasks[0]?.jobs.filter(activeRuntimeJob)).toHaveLength(1);
      expect(runnerState.launches).toBe(1);
    },
  );
});

test("legacy incomplete reservation is quarantined without inventing an operation", async () => {
  await withFixture(
    { kind: "scout", stage: "queued", runner: { active: false } },
    async ({ home, lease, service, runnerState }) => {
      const state = await readRuntime(home);
      const initialRuntime = state.tasks[0];
      if (initialRuntime === undefined) throw new Error("fixture runtime missing");
      await writeRuntimeState(runtimeFile(home), {
        ...state,
        tasks: [
          {
            ...initialRuntime,
            worktree: lease,
            reservation: reservationFor("task-1"),
          },
        ],
      });

      await service.tick();

      const recovered = await readRuntime(home);
      const runtime = recovered.tasks[0];
      expect(runnerState.launches).toBe(0);
      expect(runtime?.operation).toBeUndefined();
      expect(runtime?.reservation?.phase).toBe("reserved");
      expect(runtime?.lastError).toContain("legacy reservation");
      expect(activeReservations(recovered)).toBe(1);
    },
  );
});

test("unknown launch acknowledgement quarantines the operation and retains capacity", async () => {
  await withFixture(
    {
      kind: "scout",
      stage: "scouting",
      clock: () => "2030-01-01T00:01:00.000Z",
      runner: { active: false, paneState: "missing" },
    },
    async ({ home, service, runnerState }) => {
      const endpoint = endpointFor("scout");
      const job = workerJob(home, endpoint, "scout", "launching");
      const intent = await seedOperationIntent(home, job, "launching");

      await service.tick();

      const state = await readRuntime(home);
      const runtime = state.tasks[0];
      expect(runnerState.launches).toBe(0);
      expect(runtime?.operation?.id).toBe(intent.id);
      expect(runtime?.operation?.phase).toBe("quarantined");
      expect(runtime?.reservation?.phase).toBe("reserved");
      expect(runtime?.jobs[0]?.phase).toBe("launching");
      expect(activeReservations(state)).toBe(1);
    },
  );
});

test("paused and cancelled operation intents never relaunch after restart", async () => {
  for (const stage of ["paused", "cancelled"] as const) {
    await withFixture(
      {
        kind: "scout",
        stage,
        ...(stage === "paused" ? { taskEdits: { previousStage: "scouting" as const } } : {}),
        runner: { active: false },
      },
      async ({ home, service, runnerState }) => {
        const endpoint = endpointFor("scout");
        const job = workerJob(home, endpoint, "scout", "running");
        await seedOperationIntent(home, job, "running");

        await service.tick();
        await service.tick();

        expect(runnerState.launches).toBe(0);
      },
    );
  }
});

async function seedValidationEndpointRecovery(
  home: string,
  lease: WorktreeLease,
  writer: Endpoint,
  service: TandemService,
  effectPhase: "started" | "succeeded",
): Promise<Readonly<{ readonly operationId: string; readonly jobId: string }>> {
  await seedTaskResources(home, lease, [writer], []);
  const task = await service.get("task-1");
  const template = workerJob(home, writer, "implementer", "reserved");
  const validationJob: DurableJob = {
    ...template,
    role: "validation",
    kind: "validation",
    launchAttempted: false,
  };
  const baseOperation = operationForJob(validationJob, task);
  const endpoint = { ...endpointFor("reviewer"), paneId: "pane-2" };
  const operation: DurableOperation = {
    ...baseOperation,
    phase: "admitted",
    effects: [
      {
        id: `endpoint:${baseOperation.id}`,
        kind: "endpoint",
        phase: effectPhase,
        createdAt: TIMESTAMP,
        identity: `validation:${task.id}:${task.generation}`,
        ...(effectPhase === "succeeded" ? { receipt: JSON.stringify(endpoint) } : {}),
      },
    ],
  };
  const state = await readRuntime(home);
  await writeRuntimeState(runtimeFile(home), {
    ...state,
    tasks: state.tasks.map((entry) =>
      entry.taskId !== task.id
        ? entry
        : {
            ...entry,
            operation,
            reservation: { ...reservationFor(task.id), operationId: operation.id },
            endpoints: [writer],
            jobs: [],
          },
    ),
  });
  return { operationId: operation.id, jobId: operation.jobId };
}

test("validation endpoint receipt recovery reuses the pane and launches one admitted job", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "validating",
      taskEdits: { reviewHead: "review-head" },
      runner: { active: false, checkoutHead: "review-head" },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      const intent = await seedValidationEndpointRecovery(
        home,
        lease,
        endpoint,
        service,
        "succeeded",
      );

      await service.tick();
      await service.tick();

      const state = await readRuntime(home);
      const runtime = state.tasks[0];
      expect(runnerState.calls.some((request) => request.argv.includes("split"))).toBe(false);
      expect(runnerState.launches).toBe(1);
      expect(runtime?.endpoints.some((entry) => entry.paneId === "pane-2")).toBe(true);
      expect(runtime?.operation?.id).toBe(intent.operationId);
      expect(runtime?.jobs[0]?.id).toBe(intent.jobId);
      expect(runtime?.jobs[0]?.operationId).toBe(intent.operationId);
    },
  );
});

test("validation endpoint started intent without a receipt quarantines before pane allocation", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "validating",
      taskEdits: { reviewHead: "review-head" },
      runner: { active: false, checkoutHead: "review-head" },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      const intent = await seedValidationEndpointRecovery(
        home,
        lease,
        endpoint,
        service,
        "started",
      );

      await service.tick();

      const state = await readRuntime(home);
      const runtime = state.tasks[0];
      expect(runnerState.calls.some((request) => request.argv.includes("split"))).toBe(false);
      expect(runnerState.launches).toBe(0);
      expect(runtime?.operation?.id).toBe(intent.operationId);
      expect(runtime?.operation?.phase).toBe("quarantined");
      expect(runtime?.reservation?.phase).toBe("reserved");
      expect(activeReservations(state)).toBe(1);
    },
  );
});

test("admitted fix context recovery materializes findings and launches the same generation job", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      taskEdits: { reviewRound: 1, reviewHead: "review-head" },
      runner: { active: false, checkoutHead: "review-head" },
    },
    async ({ home, lease, service, runnerState }) => {
      await seedTaskResources(home, lease, [endpointFor("implementer")], []);
      const task = await service.get("task-1");
      const template = workerJob(home, endpointFor("implementer"), "implementer", "reserved");
      const operation: DurableOperation = {
        ...operationForJob(template, task),
        kind: "fix",
        phase: "admitted",
        generation: task.generation,
        fixContext: {
          head: "review-head",
          generation: task.generation,
          validationEvidence: [{ command: "bun test", passed: false }],
          findings: [
            {
              id: "finding-1",
              severity: "P1",
              verdict: "confirmed",
              description: "repair the persisted recovery path",
            },
          ],
        },
      };
      const state = await readRuntime(home);
      await writeRuntimeState(runtimeFile(home), {
        ...state,
        tasks: state.tasks.map((entry) =>
          entry.taskId !== task.id
            ? entry
            : {
                ...entry,
                operation,
                reservation: { ...reservationFor(task.id), operationId: operation.id },
                fixContextPath: join(home, "jobs", task.id, "fix-context-missing.json"),
                endpoints: [endpointFor("implementer")],
                jobs: [],
              },
        ),
      });

      await service.tick();

      const after = await service.get("task-1");
      const recovered = await readRuntime(home);
      const runtime = recovered.tasks[0];
      const contextPath = runtime?.fixContextPath;
      if (contextPath === undefined) throw new Error("fix context path was not retained");
      const context = JSON.parse(await readFile(contextPath, "utf8")) as {
        readonly generation: number;
        readonly findings: readonly { readonly id: string }[];
      };
      expect(after.reviewRound).toBe(task.reviewRound);
      expect(after.generation).toBe(task.generation);
      expect(context.generation).toBe(task.generation);
      expect(context.findings[0]?.id).toBe("finding-1");
      expect(runtime?.operation?.jobId).toBe(operation.jobId);
      expect(runtime?.jobs[0]?.id).toBe(operation.jobId);
      expect(runnerState.launches).toBe(1);
    },
  );
});

test("prepared jobs refresh their execution fence and launch the same durable job", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      runner: { active: false },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      await seedTaskResources(home, lease, [endpoint], []);
      const job = workerJob(home, endpoint, "implementer", "reserved");
      const admitted = await seedOperationIntent(home, job, "prepared");
      await writeJsonAtomically(job.jobPath, {
        schemaVersion: 1,
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        role: "implementer",
        cwd: job.cwd,
        model: { model: "test/implementer", thinking: "low" },
        prompt: "resume the admitted implementation",
        resultPath: job.resultPath,
        execution: {
          schemaVersion: 1,
          home,
          operationId: admitted.id,
          fencingRevision: admitted.fencingRevision,
          claimOwner: admitted.claimOwner,
        },
      });

      await service.tick();

      const state = await readRuntime(home);
      const runtime = state.tasks[0];
      const operation = runtime?.operation;
      const spec = JSON.parse(await readFile(job.jobPath, "utf8")) as {
        readonly execution?: {
          readonly operationId: string;
          readonly fencingRevision: number;
          readonly claimOwner: string;
        };
      };
      expect(runnerState.launches).toBe(1);
      expect(runtime?.jobs).toHaveLength(1);
      expect(runtime?.jobs[0]?.id).toBe(admitted.jobId);
      expect(runtime?.jobs[0]?.phase).toBe("running");
      expect(operation?.jobId).toBe(admitted.jobId);
      expect(operation?.fencingRevision).toBeGreaterThan(admitted.fencingRevision);
      expect(spec.execution?.operationId).toBe(operation?.id);
      expect(spec.execution?.fencingRevision).toBe(operation?.fencingRevision);
      expect(spec.execution?.claimOwner).toBe(operation?.claimOwner);
      expect(runtime?.endpoints.some((entry) => entry.paneId === endpoint.paneId)).toBe(true);
    },
  );
});

test("stale source-check failure cannot block a reservation taken over by another controller", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "queued",
      runner: { active: false, holdInitialHead: true, checkoutHead: "mismatched-head" },
    },
    async ({ home, lease, service, runnerState }) => {
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock: () => TIMESTAMP,
        idFactory: () => "unused",
      });
      const task = await store.read("task-1");
      if (task === undefined) throw new Error("fixture task missing");
      await store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: TIMESTAMP,
        worktree: lease,
      }));
      const initial = await readRuntime(home);
      await writeRuntimeState(runtimeFile(home), {
        ...initial,
        tasks: initial.tasks.map((entry) =>
          entry.taskId === "task-1"
            ? { ...entry, worktree: lease, endpoints: [], jobs: [] }
            : entry,
        ),
      });

      const seedJob = workerJob(home, endpointFor("implementer"), "implementer", "reserved");
      await seedTaskResources(home, lease, [], []);
      await seedOperationIntent(home, seedJob, "admitted");
      const admittedState = await readRuntime(home);
      await writeRuntimeState(runtimeFile(home), {
        ...admittedState,
        tasks: admittedState.tasks.map((entry) =>
          entry.taskId === "task-1" ? { ...entry, jobs: [] } : entry,
        ),
      });
      const firstTick = service.tick();
      await runnerState.headStarted;

      const beforeTakeover = await readRuntime(home);
      const current = beforeTakeover.tasks[0];
      const currentOperation = current?.operation;
      const currentReservation = current?.reservation;
      if (currentOperation === undefined || currentReservation === undefined) {
        throw new Error("launch did not persist an operation and reservation");
      }
      const beforeTask = await service.get("task-1");
      const takeover = writeRuntimeState(runtimeFile(home), {
        ...beforeTakeover,
        tasks: beforeTakeover.tasks.map((entry) =>
          entry.taskId !== "task-1"
            ? entry
            : {
                ...entry,
                operation: {
                  ...currentOperation,
                  claimOwner: "controller-b",
                  fencingRevision: currentOperation.fencingRevision + 1,
                },
                reservation: {
                  ...currentReservation,
                  ownerSessionId: "session-2",
                },
              },
        ),
      });

      runnerState.releaseHead();
      await firstTick;
      await takeover;

      const after = await readRuntime(home);
      const runtime = after.tasks[0];
      expect(runnerState.launches).toBe(0);
      expect(runtime?.operation?.claimOwner).toBe("controller-b");
      expect(runtime?.reservation?.ownerSessionId).toBe("session-2");
      expect(runtime?.reservation?.phase).toBe("reserved");
      expect(runtime?.lastError).toBeUndefined();
      expect((await service.get("task-1")).stage).toBe(beforeTask.stage);
    },
  );
});

test("stale successful source-check cannot transition a queued task after takeover", async () => {
  await withFixture(
    {
      kind: "scout",
      stage: "queued",
      runner: { active: false, holdInitialHead: true, checkoutHead: SOURCE_CHECKPOINT.head },
    },
    async ({ home, lease, endpoint, run, service, runnerState }) => {
      await seedTaskResources(home, lease, [endpoint], []);
      const seedJob = workerJob(home, endpoint, "scout", "reserved");
      await seedOperationIntent(home, seedJob, "admitted");
      const admittedState = await readRuntime(home);
      await writeRuntimeState(runtimeFile(home), {
        ...admittedState,
        tasks: admittedState.tasks.map((entry) =>
          entry.taskId === "task-1" ? { ...entry, jobs: [] } : entry,
        ),
      });

      const secondHeadStarted = Promise.withResolvers<void>();
      const secondHeadGate = Promise.withResolvers<void>();
      let headCalls = 0;
      const sharedRun = async (request: CommandRequest): Promise<CommandResult> => {
        if (request.argv.includes("rev-parse") && request.argv.at(-1) === "HEAD") {
          headCalls += 1;
          if (headCalls === 1) {
            secondHeadStarted.resolve();
            await secondHeadGate.promise;
          }
        }
        return run(request);
      };
      const other = createTandemService({
        home,
        sessionId: "session-1",
        poolRoot: lease.root,
        run: sharedRun,
        clock: () => TIMESTAMP,
        idFactory: () => "controller-b-id",
      });
      const firstTick = service.tick();
      let secondTick: typeof firstTick | undefined;
      try {
        await runnerState.headStarted;
        secondTick = other.tick();
        await secondHeadStarted.promise;

        runnerState.releaseHead();
        await firstTick;

        const afterFirst = await readRuntime(home);
        expect((await service.get("task-1")).stage).toBe("queued");
        expect(afterFirst.tasks[0]?.jobs).toHaveLength(0);
        expect(runnerState.launches).toBe(0);

        secondHeadGate.resolve();
        await secondTick;

        const finalRuntime = await readRuntime(home);
        expect((await service.get("task-1")).stage).toBe("scouting");
        expect(finalRuntime.tasks[0]?.jobs.filter(activeRuntimeJob)).toHaveLength(1);
        expect(runnerState.launches).toBe(1);
      } finally {
        runnerState.releaseHead();
        secondHeadGate.resolve();
        await Promise.allSettled(secondTick === undefined ? [firstTick] : [firstTick, secondTick]);
        await other.shutdown();
      }
    },
  );
});

test("launched operation with missing endpoint and result is quarantined, not failed-and-released", async () => {
  await withFixture(
    {
      kind: "implementation",
      stage: "implementing",
      clock: () => "2030-01-01T00:01:00.000Z",
      runner: { active: false, paneState: "missing" },
    },
    async ({ home, lease, endpoint, service, runnerState }) => {
      const job = workerJob(home, endpoint, "implementer", "running");
      await seedTaskResources(home, lease, [endpoint], [job]);
      const state = await readRuntime(home);
      const runtime = state.tasks[0];
      if (runtime?.operation === undefined || runtime.reservation === undefined) {
        throw new Error("fixture did not persist launched operation");
      }
      const operation: DurableOperation = {
        ...runtime.operation,
        phase: "running",
        effects: [
          {
            id: `execution:${job.id}`,
            kind: "worker",
            phase: "started",
            createdAt: TIMESTAMP,
            identity: job.id,
          },
        ],
      };
      await writeRuntimeState(runtimeFile(home), {
        ...state,
        tasks: state.tasks.map((entry) =>
          entry.taskId !== "task-1"
            ? entry
            : {
                ...entry,
                operation,
                endpoints: [],
                jobs: entry.jobs.map((candidate) =>
                  candidate.id === job.id ? { ...candidate, operationId: operation.id } : candidate,
                ),
              },
        ),
      });

      await service.tick();
      await service.tick();
      await service.resume("task-1").catch(() => undefined);
      await service.tick();

      const after = await readRuntime(home);
      const recovered = after.tasks[0];
      expect(runnerState.launches).toBe(0);
      expect(recovered?.operation?.phase).toBe("quarantined");
      expect(recovered?.reservation?.phase).toBe("reserved");
      expect(recovered?.jobs[0]?.phase).toBe("running");
      expect(activeReservations(after)).toBe(1);
      expect(recovered?.endpoints).toHaveLength(0);
    },
  );
});
