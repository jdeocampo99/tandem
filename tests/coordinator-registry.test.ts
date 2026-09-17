import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  InstructionChannels,
  ResolvedPolicy,
} from "../src/contracts.ts";
import {
  type CoordinatorRecord,
  findRunningCoordinator,
  listCoordinatorRecords,
  resetCoordinators,
  saveCoordinatorRecord,
} from "../src/coordinator-registry.ts";
import { type RuntimeTaskState, runtimeFile, writeRuntimeState } from "../src/runtime.ts";
import { createTaskStore } from "../src/store.ts";

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { stdout, code, stderr };
}

function endpoint(sessionId = "tandem", paneId = "pane-a"): CoordinatorRecord["endpoint"] {
  return {
    sessionId,
    workspaceId: `workspace-${paneId}`,
    tabId: `tab-${paneId}`,
    paneId,
    role: "coordinator",
    generation: 0,
  };
}
function snapshotPayload(
  panes: readonly Readonly<{
    readonly workspaceId: string;
    readonly tabId: string;
    readonly paneId: string;
    readonly agentStatus?: "idle" | "done" | "working" | "blocked" | "unknown";
  }>[] = [],
): string {
  return JSON.stringify({
    result: {
      type: "session_snapshot",
      snapshot: {
        panes: panes.map((pane) => ({
          workspace_id: pane.workspaceId,
          tab_id: pane.tabId,
          pane_id: pane.paneId,
          ...(pane.agentStatus === undefined ? {} : { agent_status: pane.agentStatus }),
        })),
      },
    },
  });
}

function panePayload(record: CoordinatorRecord, foregroundCwd = record.worktree.path): string {
  return JSON.stringify({
    result: {
      pane: {
        pane_id: record.endpoint.paneId,
        tab_id: record.endpoint.tabId,
        workspace_id: record.endpoint.workspaceId,
        foreground_cwd: foregroundCwd,
      },
    },
  });
}

function processPayload(
  record: CoordinatorRecord,
  processes: readonly unknown[] = [
    {
      pid: 1234,
      name: "omp",
      argv: record.command,
      argv0: "omp",
      cmdline: record.command.join(" "),
    },
  ],
): string {
  return JSON.stringify({
    result: {
      process_info: {
        pane_id: record.endpoint.paneId,
        foreground_processes: processes,
      },
    },
  });
}

function scriptedRunner(results: readonly CommandResult[]): Readonly<{
  readonly calls: readonly CommandRequest[];
  readonly run: CommandRunner;
}> {
  const calls: CommandRequest[] = [];
  const remaining = [...results];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const next = remaining.shift();
    if (next === undefined) throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
    return next;
  };
  return { calls, run };
}
type ResetPaneStatus = "idle" | "done" | "working" | "blocked" | "unknown";

type ResetPaneInput = Readonly<{
  readonly record: CoordinatorRecord;
  readonly agentStatus: ResetPaneStatus;
  readonly closeResult?: CommandResult;
}>;

type ResetPaneState = ResetPaneInput & {
  present: boolean;
};

function nativeResetRunner(inputs: readonly ResetPaneInput[]): Readonly<{
  readonly calls: readonly CommandRequest[];
  readonly panes: Map<string, ResetPaneState>;
  readonly run: CommandRunner;
}> {
  const calls: CommandRequest[] = [];
  const panes = new Map<string, ResetPaneState>(
    inputs.map((input): [string, ResetPaneState] => [
      input.record.endpoint.paneId,
      { ...input, present: true },
    ]),
  );
  const missingPane = (): CommandResult =>
    result("", 1, JSON.stringify({ error: { code: "pane_not_found" } }));
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const [program, , , resource, action] = request.argv;
    if (program === "git") {
      return request.argv.includes("rev-parse") ? result("abc123\n") : result();
    }
    if (program !== "herdr" || resource === undefined) {
      throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
    }
    if (resource === "api" && action === "snapshot") {
      return result(
        snapshotPayload(
          [...panes.values()]
            .filter((pane) => pane.present)
            .map((pane) => ({
              workspaceId: pane.record.endpoint.workspaceId,
              tabId: pane.record.endpoint.tabId,
              paneId: pane.record.endpoint.paneId,
              agentStatus: pane.agentStatus,
            })),
        ),
      );
    }
    if (resource !== "pane" || action === undefined) {
      throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
    }
    const paneId = action === "process-info" ? request.argv[6] : request.argv[5];
    if (typeof paneId !== "string") {
      throw new Error(`pane command omitted pane id: ${JSON.stringify(request.argv)}`);
    }
    const pane = panes.get(paneId);
    if (pane === undefined || !pane.present) return missingPane();
    if (action === "get") return result(panePayload(pane.record));
    if (action === "process-info") return result(processPayload(pane.record));
    if (action === "close") {
      if (pane.closeResult !== undefined) return pane.closeResult;
      pane.present = false;
      return result(
        JSON.stringify({
          id: "cli:pane:close",
          result: { type: "ok" },
        }),
      );
    }
    throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
  };
  return { calls, panes, run };
}

const resetChannels: InstructionChannels = {
  implementation: [],
  validation: [],
  review: [],
};
const resetPolicy: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "coordinator-model", thinking: "high" },
      scout: { model: "scout-model", thinking: "medium" },
      implementer: { model: "implementer-model", thinking: "max" },
      reviewer: { model: "reviewer-model", thinking: "max" },
      verifier: { model: "verifier-model", thinking: "high" },
      presentation: { model: "presentation-model", thinking: "low" },
    },
    instructions: resetChannels,
    instructionFiles: resetChannels,
    validationCommands: [],
    maxWorkers: 3,
    maxFixRounds: 1,
  },
  guidance: { implementation: [], validation: [], review: [] },
};

type ResetFixturePaths = Readonly<{
  readonly home: string;
  readonly repoA: string;
  readonly worktreeA: string;
}>;
function runtimeTask(values: ResetFixturePaths): RuntimeTaskState {
  return {
    schemaVersion: 1,
    taskId: "reset-task",
    sourceCheckpoint: {
      head: "abc123",
      base: "abc123",
      diff: "",
      dirty: false,
      unmerged: false,
    },
    sourceRepoPath: values.repoA,
    taskName: "reset-task",
    endpoints: [],
    jobs: [],
  };
}
function runtimeWorkerJob(values: ResetFixturePaths): RuntimeTaskState["jobs"][number] {
  return {
    schemaVersion: 1,
    id: "reset-job",
    taskId: "reset-task",
    generation: 0,
    role: "implementer",
    kind: "worker",
    cwd: values.worktreeA,
    jobPath: join(values.home, "jobs", "reset-task", "job.json"),
    resultPath: join(values.home, "jobs", "reset-task", "result.json"),
    attempt: 1,
    phase: "running",
    launchAttempted: true,
    createdAt: "2030-01-02T03:04:05.000Z",
  };
}

async function seedTask(
  home: string,
  repoPath: string,
  kind: "scout" | "implementation",
  endpoints: readonly Endpoint[] = [],
): Promise<void> {
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: () => "2030-01-02T03:04:05.000Z",
    idFactory: () => "reset-task",
    lockTimeoutMs: 2_000,
    lockPollMs: 5,
  });
  const task = await store.create({
    id: "reset-task",
    repoPath,
    kind,
    objective: "Keep the reset safety test active",
    acceptanceCriteria: ["The reset refuses active durable work"],
    surfaces: ["registry"],
    policy: resetPolicy,
  });
  if (endpoints.length === 0) return;
  await store.update(task.id, task.revision, (current) => ({
    ...current,
    endpoints: [...endpoints],
    revision: current.revision + 1,
  }));
}

async function fixture(): Promise<
  Readonly<{
    readonly root: string;
    readonly home: string;
    readonly repoA: string;
    readonly repoB: string;
    readonly worktreeRoot: string;
    readonly worktreeA: string;
    readonly worktreeB: string;
    readonly recordA: CoordinatorRecord;
    readonly recordB: CoordinatorRecord;
  }>
> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-coordinator-registry-")));
  const home = join(root, "home");
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  const worktreeRoot = join(root, "pool");
  const worktreeA = join(worktreeRoot, "a");
  const worktreeB = join(worktreeRoot, "b");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(repoA, { recursive: true }),
    mkdir(repoB, { recursive: true }),
    mkdir(worktreeA, { recursive: true }),
    mkdir(worktreeB, { recursive: true }),
  ]);
  const record = (repoPath: string, worktreePath: string, paneId: string): CoordinatorRecord => ({
    schemaVersion: 1,
    repoPath,
    endpoint: endpoint("tandem", paneId),
    worktree: {
      root: worktreeRoot,
      path: worktreePath,
      name: `coordinator-${paneId}`,
      baseHead: "abc123",
      branch: `tandem/${paneId}`,
      leaseId: `lease-${paneId}`,
      leaseHolder: `coordinator-${paneId}`,
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
    command: ["omp", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "max"],
  });
  return {
    root,
    home,
    repoA,
    repoB,
    worktreeRoot,
    worktreeA,
    worktreeB,
    recordA: record(repoA, worktreeA, "pane-a"),
    recordB: record(repoB, worktreeB, "pane-b"),
  };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function recordFile(home: string, sessionId: string, repoPath: string): string {
  const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
  return join(home, "coordinator-registry", hash(sessionId), `${hash(repoPath)}.json`);
}

test("reuses a coordinator only after pane, cwd, and native OMP command proof", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const nativeCommand = [
      "bun",
      "bun",
      join(values.root, ".bun", "bin", "omp"),
      ...values.recordA.command.slice(1),
    ];
    const runner = scriptedRunner([
      result(panePayload(values.recordA)),
      result(
        processPayload(values.recordA, [
          {
            pid: 1234,
            name: "bun",
            argv: nativeCommand,
            argv0: "bun",
            cmdline: nativeCommand.join(" "),
          },
        ]),
      ),
    ]);

    await expect(
      findRunningCoordinator(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).resolves.toEqual(values.recordA);
    expect(runner.calls.map((request) => request.argv)).toEqual([
      ["herdr", "--session", "tandem", "pane", "get", "pane-a"],
      ["herdr", "--session", "tandem", "pane", "process-info", "--pane", "pane-a"],
    ]);
  } finally {
    await cleanup(values.root);
  }
});

test("treats shell-only or missing panes as stale without deleting the stored lease", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const shellOnly = scriptedRunner([
      result(panePayload(values.recordA)),
      result(processPayload(values.recordA, [{ pid: 5, name: "zsh", argv: ["-zsh"] }])),
      result(snapshotPayload()),
    ]);
    await expect(
      findRunningCoordinator(shellOnly.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).resolves.toBeUndefined();

    const missingPane = scriptedRunner([
      result("", 1, JSON.stringify({ error: { code: "pane_not_found" } })),
      result(snapshotPayload()),
    ]);
    await expect(
      findRunningCoordinator(missingPane.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).resolves.toBeUndefined();
    await expect(listCoordinatorRecords(values.home, "tandem")).resolves.toEqual([values.recordA]);
  } finally {
    await cleanup(values.root);
  }
});
test("treats the native inactive-server response as stale without probing or replacing records", async () => {
  const values = await fixture();
  const inactiveServer = JSON.stringify({
    id: "cli:api:snapshot",
    error: {
      code: "server_not_running",
      message: "no herdr server is running at /tmp/herdr.sock",
    },
  });
  try {
    const noRecord = scriptedRunner([result(inactiveServer, 1)]);
    await expect(
      findRunningCoordinator(noRecord.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).resolves.toBeUndefined();
    expect(noRecord.calls).toHaveLength(1);

    await saveCoordinatorRecord(values.home, values.recordA);
    const staleRecord = scriptedRunner([result(inactiveServer, 1), result(inactiveServer, 1)]);
    await expect(
      findRunningCoordinator(staleRecord.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).resolves.toBeUndefined();
    await expect(listCoordinatorRecords(values.home, "tandem")).resolves.toEqual([values.recordA]);
  } finally {
    await cleanup(values.root);
  }
});

test("keeps different canonical repositories independent and rejects corrupt records", async () => {
  const values = await fixture();
  const repoC = join(values.root, "repo-c");
  await mkdir(repoC, { recursive: true });
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await saveCoordinatorRecord(values.home, values.recordB);
    await expect(listCoordinatorRecords(values.home, "tandem")).resolves.toHaveLength(2);

    const noProbe = scriptedRunner([result(snapshotPayload())]);
    await expect(
      findRunningCoordinator(noProbe.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: repoC,
      }),
    ).resolves.toBeUndefined();
    expect(noProbe.calls).toHaveLength(1);

    await writeFile(recordFile(values.home, "tandem", values.repoA), "not-json\n", "utf8");
    await expect(
      findRunningCoordinator(noProbe.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).rejects.toThrow(/not valid JSON/u);
  } finally {
    await cleanup(values.root);
  }
});
test("rejects a live pre-registry Tandem coordinator instead of adopting or duplicating it", async () => {
  const values = await fixture();
  try {
    const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "../src/extension.ts");
    const legacyCommand = [
      "bun",
      "bun",
      join(values.root, ".bun", "bin", "omp"),
      "--extension",
      extensionPath,
      "--cwd",
      values.repoA,
      "--no-title",
    ];
    const runner = scriptedRunner([
      result(
        snapshotPayload([
          {
            workspaceId: values.recordA.endpoint.workspaceId,
            tabId: values.recordA.endpoint.tabId,
            paneId: values.recordA.endpoint.paneId,
          },
        ]),
      ),
      result(panePayload(values.recordA, values.repoA)),
      result(
        processPayload(values.recordA, [
          {
            pid: 7777,
            name: "omp",
            argv: legacyCommand,
            argv0: "omp",
            cmdline: legacyCommand.join(" "),
          },
        ]),
      ),
    ]);

    await expect(
      findRunningCoordinator(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).rejects.toThrow(/Stop that coordinator manually/u);
    await expect(listCoordinatorRecords(values.home, "tandem")).resolves.toEqual([]);
  } finally {
    await cleanup(values.root);
  }
});

test("fails closed on a live foreign process and leaves the record untouched", async () => {
  const values = await fixture();
  const foreignPath = join(values.root, "foreign");
  await mkdir(foreignPath, { recursive: true });
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const runner = scriptedRunner([
      result(panePayload(values.recordA)),
      result(
        processPayload(values.recordA, [
          {
            pid: 4321,
            name: "omp",
            argv: ["omp", "--model", "foreign"],
            argv0: "omp",
            cmdline: "omp --model foreign",
          },
        ]),
      ),
    ]);
    await expect(
      findRunningCoordinator(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).rejects.toThrow(/ownership could not be proved/u);
    await expect(listCoordinatorRecords(values.home, "tandem")).resolves.toEqual([values.recordA]);

    const cwdMismatch = scriptedRunner([
      result(panePayload(values.recordA, foreignPath)),
      result(processPayload(values.recordA)),
    ]);
    await expect(
      findRunningCoordinator(cwdMismatch.run, {
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
      }),
    ).rejects.toThrow(/cwd .* does not match lease/u);
    await expect(
      readFile(recordFile(values.home, "tandem", values.repoA), "utf8"),
    ).resolves.toContain(values.recordA.repoPath);
  } finally {
    await cleanup(values.root);
  }
});

test("resets selected owned idle and done coordinators without touching unrelated panes or registry files", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await saveCoordinatorRecord(values.home, values.recordB);
    const unrelated = {
      ...values.recordA,
      endpoint: endpoint("tandem", "pane-unrelated"),
    };
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "idle" },
      { record: values.recordB, agentStatus: "done" },
      { record: unrelated, agentStatus: "working" },
    ]);

    const stopped = await resetCoordinators(runner.run, {
      home: values.home,
      sessionId: "tandem",
      repoPaths: [values.repoA, values.repoB],
    });

    expect(stopped.map((record) => record.repoPath).sort()).toEqual(
      [values.repoA, values.repoB].sort(),
    );
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(false);
    expect(runner.panes.get(values.recordB.endpoint.paneId)?.present).toBe(false);
    expect(runner.panes.get(unrelated.endpoint.paneId)?.present).toBe(true);
    expect(
      runner.calls.some(
        (request) => request.argv[4] === "close" && request.argv[5] === unrelated.endpoint.paneId,
      ),
    ).toBe(false);
    await expect(
      readFile(recordFile(values.home, "tandem", values.repoA), "utf8"),
    ).resolves.toContain(values.recordA.repoPath);
    await expect(
      readFile(recordFile(values.home, "tandem", values.repoB), "utf8"),
    ).resolves.toContain(values.recordB.repoPath);
  } finally {
    await cleanup(values.root);
  }
});

test("allows reset when historical worker endpoints are no longer live", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const historicalEndpoint: Endpoint = {
      sessionId: "tandem",
      workspaceId: "workspace-dead-worker",
      tabId: "tab-dead-worker",
      paneId: "pane-dead-worker",
      role: "implementer",
      generation: 0,
    };
    await seedTask(values.home, values.repoA, "implementation", [historicalEndpoint]);
    const runner = nativeResetRunner([{ record: values.recordA, agentStatus: "idle" }]);

    const stopped = await resetCoordinators(runner.run, {
      home: values.home,
      sessionId: "tandem",
      repoPaths: [values.repoA],
    });

    expect(stopped.map((record) => record.repoPath)).toEqual([values.repoA]);
    expect(
      runner.calls.some(
        (request) => request.argv[4] === "close" && request.argv[5] === historicalEndpoint.paneId,
      ),
    ).toBe(false);
    await expect(
      readFile(recordFile(values.home, "tandem", values.repoA), "utf8"),
    ).resolves.toContain(values.recordA.repoPath);
  } finally {
    await cleanup(values.root);
  }
});

test("refuses a busy selected coordinator before closing any idle coordinator", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await saveCoordinatorRecord(values.home, values.recordB);
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "idle" },
      { record: values.recordB, agentStatus: "working" },
    ]);

    await expect(
      resetCoordinators(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA, values.repoB],
      }),
    ).rejects.toThrow(/busy|idle|reset/u);
    expect(runner.calls.some((request) => request.argv[4] === "close")).toBe(false);
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
    expect(runner.panes.get(values.recordB.endpoint.paneId)?.present).toBe(true);
  } finally {
    await cleanup(values.root);
  }
});

test("refuses active durable workers, tasks, and reservations before closing", async () => {
  for (const activeKind of ["worker", "task", "reservation"] as const) {
    const values = await fixture();
    try {
      await saveCoordinatorRecord(values.home, values.recordA);
      const runner = nativeResetRunner([{ record: values.recordA, agentStatus: "idle" }]);
      if (activeKind === "task") {
        await seedTask(values.home, values.repoA, "scout");
      } else {
        await seedTask(values.home, values.repoA, "implementation");
        const task = runtimeTask(values);
        await writeRuntimeState(runtimeFile(values.home), {
          schemaVersion: 1,
          tasks: [
            {
              ...task,
              ...(activeKind === "worker"
                ? { jobs: [runtimeWorkerJob(values)] }
                : {
                    reservation: {
                      schemaVersion: 1,
                      id: "reset-reservation",
                      taskId: "reset-task",
                      ownerSessionId: "tandem",
                      phase: "worktree",
                      createdAt: "2030-01-02T03:04:05.000Z",
                    },
                  }),
            },
          ],
          presentations: [],
        });
      }
      const durablePath =
        activeKind === "task"
          ? join(values.home, "tasks", "reset-task.json")
          : runtimeFile(values.home);
      const durableBefore = await readFile(durablePath, "utf8");

      await expect(
        resetCoordinators(runner.run, {
          home: values.home,
          sessionId: "tandem",
          repoPaths: [values.repoA],
        }),
      ).rejects.toThrow(/active|queued|job|reservation|worker|reset/u);
      expect(await readFile(durablePath, "utf8")).toBe(durableBefore);
      expect(runner.calls.some((request) => request.argv[4] === "close")).toBe(false);
      expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
    } finally {
      await cleanup(values.root);
    }
  }
});

test("treats stale and missing selected coordinators as no-ops", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const runner = nativeResetRunner([]);

    await expect(
      resetCoordinators(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA, values.repoB],
      }),
    ).resolves.toEqual([]);
    expect(runner.calls.some((request) => request.argv[4] === "close")).toBe(false);
    await expect(
      readFile(recordFile(values.home, "tandem", values.repoA), "utf8"),
    ).resolves.toContain(values.recordA.repoPath);
  } finally {
    await cleanup(values.root);
  }
});

test("reports a partial close instead of hiding it when a later coordinator turns busy mid-reset", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await saveCoordinatorRecord(values.home, values.recordB);
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "idle" },
      { record: values.recordB, agentStatus: "idle" },
    ]);
    let flipped = false;
    const run: CommandRunner = async (request) => {
      const response = await runner.run(request);
      if (
        !flipped &&
        request.argv[4] === "close" &&
        request.argv[5] === values.recordA.endpoint.paneId &&
        response.code === 0
      ) {
        flipped = true;
        const paneB = runner.panes.get(values.recordB.endpoint.paneId);
        if (paneB !== undefined) paneB.agentStatus = "working";
      }
      return response;
    };

    await expect(
      resetCoordinators(run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA, values.repoB],
      }),
    ).rejects.toThrow(/closed 1 coordinator.*repo-a.*repo-b/su);
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(false);
    expect(runner.panes.get(values.recordB.endpoint.paneId)?.present).toBe(true);
    await expect(
      readFile(recordFile(values.home, "tandem", values.repoB), "utf8"),
    ).resolves.toContain(values.recordB.repoPath);
  } finally {
    await cleanup(values.root);
  }
});

test("surfaces a native coordinator close failure without mutating the registry", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const runner = nativeResetRunner([
      {
        record: values.recordA,
        agentStatus: "idle",
        closeResult: result(
          "",
          1,
          JSON.stringify({ error: { code: "pane_close_failed", message: "native close failed" } }),
        ),
      },
    ]);

    await expect(
      resetCoordinators(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA],
      }),
    ).rejects.toThrow(/close/u);
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
    await expect(
      readFile(recordFile(values.home, "tandem", values.repoA), "utf8"),
    ).resolves.toContain(values.recordA.repoPath);
  } finally {
    await cleanup(values.root);
  }
});
