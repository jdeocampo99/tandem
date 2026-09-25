import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/adapters/commands.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  InstructionChannels,
  ResolvedPolicy,
} from "../../src/contracts.ts";
import { findRunningCoordinator } from "../../src/coordinator/ownership.ts";
import type { CoordinatorRecord } from "../../src/coordinator/record.ts";
import { listCoordinatorRecords, saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { resetCoordinators } from "../../src/coordinator/reset.ts";
import {
  refreshCoordinatorSource,
  resolveCoordinatorSourceHead,
} from "../../src/coordinator/source.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type { RuntimeTaskState } from "../../src/runtime/schema.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { writeWorkerTerminal } from "../../src/workers/terminal.ts";

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
        shell_pid: 1234,
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
  readonly processes?: readonly unknown[];
  readonly foregroundCwd?: string;
  readonly workspaceLabel?: string;
}>;

type ResetPaneState = ResetPaneInput & {
  present: boolean;
};

type NativeResetRunner = Readonly<{
  readonly calls: readonly CommandRequest[];
  readonly panes: Map<string, ResetPaneState>;
  readonly run: CommandRunner;
  readonly workspaces: Map<string, string>;
}>;

function nativeResetRunner(inputs: readonly ResetPaneInput[]): NativeResetRunner {
  const calls: CommandRequest[] = [];
  const panes = new Map<string, ResetPaneState>(
    inputs.map((input): [string, ResetPaneState] => [
      input.record.endpoint.paneId,
      { ...input, present: true },
    ]),
  );
  const workspaces = new Map(
    inputs.map((input) => [
      input.record.endpoint.workspaceId,
      input.workspaceLabel ?? `Tandem coordinator · ${basename(input.record.repoPath)}`,
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
    if (resource === "workspace") {
      const workspaceId = request.argv[5] ?? "";
      if (!workspaces.has(workspaceId)) {
        return result("", 1, JSON.stringify({ error: { code: "workspace_not_found" } }));
      }
      if (action === "rename") workspaces.set(workspaceId, request.argv[6] ?? "");
      else if (action !== "get") throw new Error(`unexpected workspace action ${action}`);
      return result(
        JSON.stringify({
          result: {
            type: "workspace_info",
            workspace: { workspace_id: workspaceId, label: workspaces.get(workspaceId) },
          },
        }),
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
    if (action === "get") return result(panePayload(pane.record, pane.foregroundCwd));
    if (action === "process-info") return result(processPayload(pane.record, pane.processes));
    if (action === "close") {
      if (pane.closeResult !== undefined) return pane.closeResult;
      pane.present = false;
      if (
        ![...panes.values()].some(
          (other) =>
            other.present && other.record.endpoint.workspaceId === pane.record.endpoint.workspaceId,
        )
      ) {
        workspaces.delete(pane.record.endpoint.workspaceId);
      }
      return result(
        JSON.stringify({
          id: "cli:pane:close",
          result: { type: "ok" },
        }),
      );
    }
    throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
  };
  return { calls, panes, workspaces, run };
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
      presentation: { model: "presentation-model", thinking: "low" },
    },
    instructions: resetChannels,
    instructionFiles: resetChannels,
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

type RegistryFixture = Readonly<{
  readonly root: string;
  readonly home: string;
  readonly repoA: string;
  readonly repoB: string;
  readonly worktreeRoot: string;
  readonly worktreeA: string;
  readonly worktreeB: string;
  readonly recordA: CoordinatorRecord;
  readonly recordB: CoordinatorRecord;
}>;

async function fixture(): Promise<RegistryFixture> {
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

type SourceRefreshFixture = Readonly<{
  readonly values: RegistryFixture;
  readonly sourceHeadA: string;
  readonly sourceHeadB: string;
}>;

async function runGitFixtureCommand(cwd: string, args: readonly string[]): Promise<string> {
  const response = await runCommand({ argv: ["git", "-C", cwd, ...args], cwd });
  if (response.code !== 0) {
    throw new Error(
      `source refresh Git fixture command failed: ${args.join(" ")}: ${response.stderr}`,
    );
  }
  return response.stdout.trim();
}

async function sourceRefreshFixture(): Promise<SourceRefreshFixture> {
  const values = await fixture();
  const origin = join(values.root, "origin.git");
  await mkdir(origin, { recursive: true });
  await runGitFixtureCommand(values.repoA, ["init", "-b", "main"]);
  await runGitFixtureCommand(values.repoA, ["config", "user.email", "tandem-tests@example.com"]);
  await runGitFixtureCommand(values.repoA, ["config", "user.name", "Tandem Tests"]);
  await writeFile(join(values.repoA, "source.txt"), "source A\n");
  await runGitFixtureCommand(values.repoA, ["add", "source.txt"]);
  await runGitFixtureCommand(values.repoA, ["commit", "-m", "source A"]);
  const sourceHeadA = await runGitFixtureCommand(values.repoA, ["rev-parse", "HEAD"]);
  await writeFile(join(values.repoA, "source.txt"), "source B\n");
  await runGitFixtureCommand(values.repoA, ["commit", "-am", "source B"]);
  const sourceHeadB = await runGitFixtureCommand(values.repoA, ["rev-parse", "HEAD"]);
  await runGitFixtureCommand(origin, ["init", "--bare"]);
  await runGitFixtureCommand(values.repoA, ["remote", "add", "origin", origin]);
  await runGitFixtureCommand(values.repoA, ["push", "origin", `${sourceHeadB}:refs/heads/main`]);
  await runGitFixtureCommand(values.repoA, ["reset", "--hard", sourceHeadA]);
  await rm(values.worktreeA, { recursive: true, force: true });
  await runGitFixtureCommand(values.repoA, [
    "worktree",
    "add",
    "-b",
    values.recordA.worktree.branch,
    values.worktreeA,
    sourceHeadA,
  ]);
  const recordA = {
    ...values.recordA,
    worktree: { ...values.recordA.worktree, baseHead: sourceHeadA },
  };
  return {
    values: { ...values, recordA },
    sourceHeadA,
    sourceHeadB,
  };
}

function sourceRefreshRunner(
  record: CoordinatorRecord,
  afterSwitch?: (request: CommandRequest) => void | Promise<void>,
): Readonly<{
  readonly native: NativeResetRunner;
  readonly run: CommandRunner;
}> {
  const native = nativeResetRunner([{ record, agentStatus: "idle" }]);
  const run: CommandRunner = async (request) => {
    if (request.argv[0] === "herdr") return native.run(request);
    const response = await runCommand(request);
    if (response.code === 0 && request.argv.includes("switch")) {
      await afterSwitch?.(request);
    }
    return response;
  };
  return { native, run };
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
    const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "../../src/extension.ts");
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

for (const force of [false, true]) {
  test(`reset closes a stopped recorded coordinator shell and leaves unrelated terminals (force=${force})`, async () => {
    const values = await fixture();
    try {
      await saveCoordinatorRecord(values.home, values.recordA);
      const shell = [{ pid: 1234, name: "zsh", argv: ["-zsh"], argv0: "-zsh", cmdline: "-zsh" }];
      const unrelated = { ...values.recordA, endpoint: endpoint("tandem", "unrelated-shell") };
      const runner = nativeResetRunner([
        { record: values.recordA, agentStatus: "unknown", processes: shell },
        { record: unrelated, agentStatus: "unknown", processes: shell },
      ]);
      const request = { home: values.home, sessionId: "tandem", repoPaths: [values.repoA], force };

      expect(
        (await resetCoordinators(runner.run, request)).map((record) => record.repoPath),
      ).toEqual([values.repoA]);
      expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(false);
      expect(runner.workspaces.has(values.recordA.endpoint.workspaceId)).toBe(false);
      expect(runner.panes.get(unrelated.endpoint.paneId)?.present).toBe(true);
      expect(await resetCoordinators(runner.run, request)).toEqual([]);
      expect([...runner.workspaces.keys()]).toEqual([unrelated.endpoint.workspaceId]);
    } finally {
      await cleanup(values.root);
    }
  });
}

for (const label of ["Tandem coordinator · repo-a", "My scratch terminal"]) {
  test(`reset preserves extra panes and only retires its own generated workspace label: ${label}`, async () => {
    const values = await fixture();
    try {
      await saveCoordinatorRecord(values.home, values.recordA);
      const extra = {
        ...values.recordA,
        endpoint: { ...values.recordA.endpoint, paneId: "unrelated-omp" },
        command: ["omp"],
      };
      const runner = nativeResetRunner([
        { record: values.recordA, agentStatus: "idle", workspaceLabel: label },
        { record: extra, agentStatus: "working", workspaceLabel: label },
      ]);

      await resetCoordinators(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA],
      });

      expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(false);
      expect(runner.panes.get(extra.endpoint.paneId)?.present).toBe(true);
      expect(runner.workspaces.get(values.recordA.endpoint.workspaceId)).toBe(
        label === "My scratch terminal" ? label : "Retained terminals · repo-a",
      );
    } finally {
      await cleanup(values.root);
    }
  });
}

test("force reset refuses a stopped recorded pane that has moved outside its coordinator worktree", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const runner = nativeResetRunner([
      {
        record: values.recordA,
        agentStatus: "unknown",
        foregroundCwd: values.repoB,
        processes: [{ pid: 1234, name: "zsh", argv: ["-zsh"], argv0: "-zsh", cmdline: "-zsh" }],
      },
    ]);
    await expect(
      resetCoordinators(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA],
        force: true,
      }),
    ).rejects.toThrow("does not match lease");
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
  } finally {
    await cleanup(values.root);
  }
});

test("force reset does not mistake another foreground shell process for the stopped coordinator's terminal shell", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const runner = nativeResetRunner([
      {
        record: values.recordA,
        agentStatus: "unknown",
        processes: [
          {
            pid: 5678,
            name: "zsh",
            argv: ["zsh", "work.sh"],
            argv0: "zsh",
            cmdline: "zsh work.sh",
          },
        ],
      },
    ]);
    await expect(
      resetCoordinators(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA],
        force: true,
      }),
    ).rejects.toThrow("does not prove its original terminal shell");
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
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

test("allows reset past a settled terminal stop intent but refuses a quarantined one", async () => {
  for (const phase of ["cancelled", "quarantined"] as const) {
    const values = await fixture();
    try {
      await saveCoordinatorRecord(values.home, values.recordA);
      await seedTask(values.home, values.repoA, "implementation");
      const store = createTaskStore({
        directory: join(values.home, "tasks"),
        clock: () => new Date().toISOString(),
        idFactory: () => "reset-task",
      });
      const seeded = await store.read("reset-task");
      if (seeded === undefined) throw new Error("fixture task missing");
      await store.update(seeded.id, seeded.revision, (current) => ({
        ...current,
        stage: "cancelled",
        revision: current.revision + 1,
      }));
      await writeRuntimeState(runtimeFile(values.home), {
        schemaVersion: 1,
        tasks: [
          {
            ...runtimeTask(values),
            stopRequest: {
              schemaVersion: 1,
              action: "cancel",
              generation: 0,
              requestedAt: "2030-01-02T03:04:05.000Z",
            },
            operation: {
              schemaVersion: 1,
              id: "reset-operation",
              taskId: "reset-task",
              kind: "implementation",
              role: "implementer",
              generation: 0,
              inputHead: "abc123",
              policyDigest: "policy",
              instructionRevision: 0,
              jobId: "reset-job",
              phase,
              fencingRevision: 1,
              claimOwner: "tandem",
              createdAt: "2030-01-02T03:04:05.000Z",
              effects: [],
            },
          },
        ],
        presentations: [],
      });
      const runner = nativeResetRunner([{ record: values.recordA, agentStatus: "idle" }]);
      const reset = resetCoordinators(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA],
      });

      if (phase === "cancelled") {
        expect((await reset).map((record) => record.repoPath)).toEqual([values.repoA]);
      } else {
        await expect(reset).rejects.toThrow("pending stop intent");
        expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
      }
    } finally {
      await cleanup(values.root);
    }
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
      const store = createTaskStore({
        directory: join(values.home, "tasks"),
        clock: () => new Date().toISOString(),
        idFactory: () => "reset-task",
      });
      const taskBefore = await store.read("reset-task");
      const runtimeBefore = await readRuntimeState(runtimeFile(values.home));

      await expect(
        resetCoordinators(runner.run, {
          home: values.home,
          sessionId: "tandem",
          repoPaths: [values.repoA],
        }),
      ).rejects.toThrow(/active|queued|job|reservation|worker|reset/u);
      expect(await store.read("reset-task")).toEqual(taskBefore);
      expect(await readRuntimeState(runtimeFile(values.home))).toEqual(runtimeBefore);
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
        if (paneB !== undefined)
          runner.panes.set(values.recordB.endpoint.paneId, { ...paneB, agentStatus: "working" });
      }
      return response;
    };

    let caught: unknown;
    try {
      await resetCoordinators(run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA, values.repoB],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toContain(values.recordA.repoPath);
    expect(err.message).toContain(values.recordB.repoPath);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain("working");

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

test("force reset cancels stale scouting work while preserving files and unselected projects", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await saveCoordinatorRecord(values.home, values.recordB);
    const worker: Endpoint = { ...endpoint("tandem", "missing-worker"), role: "scout" };
    await seedTask(values.home, values.repoA, "scout", [worker]);
    const store = createTaskStore({
      directory: join(values.home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: () => "unselected-task",
    });
    const selected = await store.read("reset-task");
    if (selected === undefined) throw new Error("missing fixture task");
    await store.update(selected.id, selected.revision, (task) => ({
      ...task,
      stage: "scouting",
      revision: task.revision + 1,
    }));
    const unselected = await store.create({
      repoPath: values.repoB,
      kind: "scout",
      objective: "Keep this unrelated project running",
      acceptanceCriteria: ["Reset of another project leaves this task alone"],
      surfaces: ["example.ts"],
      policy: resetPolicy,
    });
    const { researchContinuation: _scoutContinuation, ...unselectedFields } = unselected;
    const awaitingApproval = await store.create({
      ...unselectedFields,
      id: "awaiting-approval",
      repoPath: values.repoA,
      kind: "implementation",
    });
    await writeRuntimeState(runtimeFile(values.home), {
      schemaVersion: 1,
      tasks: [
        {
          ...runtimeTask(values),
          worktree: values.recordA.worktree,
          endpoints: [worker],
          jobs: [{ ...runtimeWorkerJob(values), role: "scout", endpoint: worker }],
          reservation: {
            schemaVersion: 1,
            id: "reset-reservation",
            taskId: selected.id,
            ownerSessionId: "tandem",
            phase: "endpoint",
            createdAt: "2030-01-02T03:04:05.000Z",
          },
        },
      ],
      presentations: [],
    });
    const originalFile = join(values.repoA, "uncommitted.txt");
    const worktreeFile = join(values.worktreeA, "unmerged.txt");
    await writeFile(originalFile, "original work");
    await writeFile(worktreeFile, "worktree work");
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "working" },
      { record: values.recordB, agentStatus: "working" },
    ]);

    await resetCoordinators(runner.run, {
      home: values.home,
      sessionId: "tandem",
      repoPaths: [values.repoA],
      force: true,
    });

    expect((await store.read(selected.id))?.stage).toBe("cancelled");
    expect(await store.read(unselected.id)).toEqual(unselected);
    expect(await store.read(awaitingApproval.id)).toEqual(awaitingApproval);
    const runtime = (await readRuntimeState(runtimeFile(values.home))).tasks[0];
    expect(runtime?.jobs[0]?.phase).toBe("failed");
    expect(runtime?.reservation?.phase).toBe("released");
    expect(runtime?.stopRequest).toBeUndefined();
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(false);
    expect(runner.panes.get(values.recordB.endpoint.paneId)?.present).toBe(true);
    expect(await readFile(originalFile, "utf8")).toBe("original work");
    expect(await readFile(worktreeFile, "utf8")).toBe("worktree work");
  } finally {
    await cleanup(values.root);
  }
});

test("force reset refuses a foreign coordinator before cancelling tasks or closing owned panes", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await saveCoordinatorRecord(values.home, values.recordB);
    await seedTask(values.home, values.repoA, "scout");
    const store = createTaskStore({
      directory: join(values.home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: () => "reset-task",
    });
    const before = await store.read("reset-task");
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "working" },
      { record: values.recordB, agentStatus: "working" },
    ]);
    const run: CommandRunner = (request) =>
      request.argv[4] === "process-info" && request.argv[6] === values.recordB.endpoint.paneId
        ? Promise.resolve(
            result(
              processPayload(values.recordB, [
                { pid: 1234, name: "vim", argv: ["vim", "notes"], argv0: "vim" },
              ]),
            ),
          )
        : runner.run(request);

    await expect(
      resetCoordinators(run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA, values.repoB],
        force: true,
      }),
    ).rejects.toThrow();

    expect(await store.read("reset-task")).toEqual(before);
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
    expect(runner.panes.get(values.recordB.endpoint.paneId)?.present).toBe(true);
  } finally {
    await cleanup(values.root);
  }
});

test("force reset refuses a foreign process in a recorded worker pane", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const worker: Endpoint = { ...endpoint("tandem", "worker-pane"), role: "scout" };
    await seedTask(values.home, values.repoA, "scout", [worker]);
    const store = createTaskStore({
      directory: join(values.home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: () => "reset-task",
    });
    const before = await store.read("reset-task");
    await writeRuntimeState(runtimeFile(values.home), {
      schemaVersion: 1,
      tasks: [
        {
          ...runtimeTask(values),
          endpoints: [worker],
          jobs: [{ ...runtimeWorkerJob(values), role: "scout", endpoint: worker }],
        },
      ],
      presentations: [],
    });
    const foreign = { ...values.recordA, endpoint: worker, command: ["vim", "notes"] };
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "working" },
      { record: foreign, agentStatus: "working" },
    ]);
    const run: CommandRunner = (request) =>
      request.argv[4] === "process-info" && request.argv[6] === worker.paneId
        ? Promise.resolve(
            result(
              processPayload(foreign, [
                { pid: 1234, name: "vim", argv: ["vim", "notes"], argv0: "vim" },
              ]),
            ),
          )
        : runner.run(request);

    await expect(
      resetCoordinators(run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA],
        force: true,
      }),
    ).rejects.toThrow();

    expect(await store.read("reset-task")).toEqual(before);
    expect(runner.panes.get(worker.paneId)?.present).toBe(true);
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
  } finally {
    await cleanup(values.root);
  }
});

test("force reset can retry a partial coordinator close without reviving cancelled work", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await saveCoordinatorRecord(values.home, values.recordB);
    await seedTask(values.home, values.repoA, "scout");
    const store = createTaskStore({
      directory: join(values.home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: () => "reset-task",
    });
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "working" },
      {
        record: values.recordB,
        agentStatus: "working",
        closeResult: result("", 1, "native close failed"),
      },
    ]);
    const input = {
      home: values.home,
      sessionId: "tandem",
      repoPaths: [values.repoA, values.repoB],
      force: true,
    };

    await expect(resetCoordinators(runner.run, input)).rejects.toThrow();
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(false);
    expect(runner.panes.get(values.recordB.endpoint.paneId)?.present).toBe(true);
    runner.panes.set(values.recordB.endpoint.paneId, {
      record: values.recordB,
      agentStatus: "working",
      present: true,
    });
    await resetCoordinators(runner.run, input);

    expect(runner.panes.get(values.recordB.endpoint.paneId)?.present).toBe(false);
    expect((await store.read("reset-task"))?.stage).toBe("cancelled");
  } finally {
    await cleanup(values.root);
  }
});

test("force reset refuses work reserved by a different session", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await seedTask(values.home, values.repoA, "scout");
    const state = {
      schemaVersion: 1 as const,
      tasks: [
        {
          ...runtimeTask(values),
          reservation: {
            schemaVersion: 1 as const,
            id: "other-reservation",
            taskId: "reset-task",
            ownerSessionId: "other-session",
            phase: "reserved" as const,
            createdAt: "2030-01-02T03:04:05.000Z",
          },
        },
      ],
      presentations: [],
    };
    await writeRuntimeState(runtimeFile(values.home), state);
    const store = createTaskStore({
      directory: join(values.home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: () => "reset-task",
    });
    const before = await store.read("reset-task");
    const runner = nativeResetRunner([{ record: values.recordA, agentStatus: "working" }]);

    await expect(
      resetCoordinators(runner.run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA],
        force: true,
      }),
    ).rejects.toThrow();

    expect(await store.read("reset-task")).toEqual(before);
    expect(await readRuntimeState(runtimeFile(values.home))).toEqual(state);
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
  } finally {
    await cleanup(values.root);
  }
});

test("force reset closes the latest retained worker generation without cancelling completed work", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const oldEndpoint: Endpoint = { ...endpoint("tandem", "retained-worker"), role: "scout" };
    const currentEndpoint = { ...oldEndpoint, generation: 1 };
    await seedTask(values.home, values.repoA, "scout", [oldEndpoint, currentEndpoint]);
    const store = createTaskStore({
      directory: join(values.home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: () => "reset-task",
    });
    const task = await store.read("reset-task");
    if (task === undefined) throw new Error("missing fixture task");
    const completed = await store.update(task.id, task.revision, (current) => ({
      ...current,
      generation: 1,
      stage: "completed",
      revision: current.revision + 1,
    }));
    const oldJob = {
      ...runtimeWorkerJob(values),
      role: "scout" as const,
      endpoint: oldEndpoint,
      phase: "consumed" as const,
    };
    const currentJob = {
      ...oldJob,
      id: "new-job",
      generation: 1,
      endpoint: currentEndpoint,
      jobPath: join(values.home, "jobs", "new-job.json"),
    };
    await mkdir(dirname(currentJob.jobPath), { recursive: true });
    await writeWorkerTerminal(currentJob.jobPath, {
      schemaVersion: 1,
      jobId: currentJob.id,
      taskId: task.id,
      generation: 1,
      role: "scout",
      cwd: values.worktreeA,
      pid: 1234,
      phase: "busy",
      completed: true,
      heartbeatAt: new Date().toISOString(),
    });
    await writeRuntimeState(runtimeFile(values.home), {
      schemaVersion: 1,
      tasks: [
        {
          ...runtimeTask(values),
          worktree: values.recordA.worktree,
          endpoints: [oldEndpoint, currentEndpoint],
          jobs: [oldJob, currentJob],
        },
      ],
      presentations: [],
    });
    const worker = { ...values.recordA, endpoint: currentEndpoint };
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "working" },
      { record: worker, agentStatus: "working" },
    ]);

    await resetCoordinators(runner.run, {
      home: values.home,
      sessionId: "tandem",
      repoPaths: [values.repoA],
      force: true,
    });

    expect(runner.panes.get(currentEndpoint.paneId)?.present).toBe(false);
    expect(await store.read(task.id)).toEqual(completed);
    expect((await readRuntimeState(runtimeFile(values.home))).tasks[0]?.endpoints).toEqual([]);
  } finally {
    await cleanup(values.root);
  }
});

test("force reset does not treat a job path argument as validation process ownership", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const worker: Endpoint = { ...endpoint("tandem", "validation-pane"), role: "implementer" };
    await seedTask(values.home, values.repoA, "scout", [worker]);
    const job = {
      ...runtimeWorkerJob(values),
      kind: "validation" as const,
      role: "validation" as const,
      endpoint: worker,
    };
    await writeRuntimeState(runtimeFile(values.home), {
      schemaVersion: 1,
      tasks: [{ ...runtimeTask(values), endpoints: [worker], jobs: [job] }],
      presentations: [],
    });
    const foreign = { ...values.recordA, endpoint: worker };
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "working" },
      { record: foreign, agentStatus: "working" },
    ]);
    const run: CommandRunner = (request) =>
      request.argv[4] === "process-info" && request.argv[6] === worker.paneId
        ? Promise.resolve(
            result(
              processPayload(foreign, [
                { pid: 1234, name: "vim", argv: ["vim", job.jobPath], argv0: "vim" },
              ]),
            ),
          )
        : runner.run(request);

    await expect(
      resetCoordinators(run, {
        home: values.home,
        sessionId: "tandem",
        repoPaths: [values.repoA],
        force: true,
      }),
    ).rejects.toThrow();

    expect(runner.panes.get(worker.paneId)?.present).toBe(true);
    expect(runner.panes.get(values.recordA.endpoint.paneId)?.present).toBe(true);
  } finally {
    await cleanup(values.root);
  }
});

test("force reset ends stale presentations while preserving their artifacts", async () => {
  const values = await fixture();
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    await seedTask(values.home, values.repoA, "scout");
    const cwd = join(values.home, "presentations", "reset-presentation");
    await mkdir(cwd, { recursive: true });
    const recordPath = join(cwd, "record.json");
    const artifactPath = join(cwd, "artifact.html");
    const worker: Endpoint = {
      ...endpoint("tandem", "missing-presentation"),
      role: "presentation",
    };
    const job = {
      ...runtimeWorkerJob(values),
      role: "presentation" as const,
      cwd,
      jobPath: join(cwd, "job.json"),
      resultPath: join(cwd, "result.json"),
      endpoint: worker,
    };
    await writeFile(
      recordPath,
      JSON.stringify({
        id: "reset-presentation",
        taskId: "reset-task",
        generation: 0,
        cwd,
        artifactPath,
        jobPath: job.jobPath,
        resultPath: job.resultPath,
        status: "running",
        endpoint: worker,
        createdAt: "2030-01-02T03:04:05.000Z",
        updatedAt: "2030-01-02T03:04:05.000Z",
      }),
    );
    await writeFile(artifactPath, "<main>keep this presentation</main>");
    await writeRuntimeState(runtimeFile(values.home), {
      schemaVersion: 1,
      tasks: [runtimeTask(values)],
      presentations: [
        {
          schemaVersion: 1,
          id: "reset-presentation",
          taskId: "reset-task",
          recordPath,
          job,
          endpoint: worker,
        },
      ],
    });
    const runner = nativeResetRunner([{ record: values.recordA, agentStatus: "working" }]);

    await resetCoordinators(runner.run, {
      home: values.home,
      sessionId: "tandem",
      repoPaths: [values.repoA],
      force: true,
    });

    expect(JSON.parse(await readFile(recordPath, "utf8")).status).toBe("failed");
    expect((await readRuntimeState(runtimeFile(values.home))).presentations[0]?.job?.phase).toBe(
      "failed",
    );
    expect(await readFile(artifactPath, "utf8")).toBe("<main>keep this presentation</main>");
  } finally {
    await cleanup(values.root);
  }
});

test("force reset reaps detached validation commands before closing their pane", async () => {
  const values = await fixture();
  let process: Bun.Subprocess | undefined;
  let commandPid: number | undefined;
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const worker: Endpoint = { ...endpoint("tandem", "validation-pane"), role: "implementer" };
    await seedTask(values.home, values.repoA, "scout", [worker]);
    const store = createTaskStore({
      directory: join(values.home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: () => "reset-task",
    });
    const task = await store.read("reset-task");
    if (task === undefined) throw new Error("missing validation fixture task");
    await store.update(task.id, task.revision, (current) => ({
      ...current,
      stage: "validating",
      revision: current.revision + 1,
    }));
    const operation = {
      schemaVersion: 1 as const,
      id: "reset-operation",
      taskId: "reset-task",
      kind: "validation" as const,
      role: "validation" as const,
      generation: 0,
      inputHead: "abc123",
      policyDigest: "reset-policy",
      instructionRevision: 0,
      jobId: "reset-job",
      phase: "running" as const,
      fencingRevision: 1,
      claimOwner: "reset-test",
      createdAt: "2030-01-02T03:04:05.000Z",
      effects: [],
    };
    const job = {
      ...runtimeWorkerJob(values),
      operationId: operation.id,
      kind: "validation" as const,
      role: "validation" as const,
      endpoint: worker,
      head: operation.inputHead,
    };
    await mkdir(dirname(job.jobPath), { recursive: true });
    const pidPath = join(dirname(job.jobPath), "command.pid");
    await writeFile(
      job.jobPath,
      JSON.stringify({
        schemaVersion: 1,
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        repoPath: job.cwd,
        head: job.head,
        contract: "final",
        policyDigest: "policy-digest",
        surfaces: ["example.ts"],
        resultPath: job.resultPath,
        execution: {
          schemaVersion: 1,
          home: values.home,
          operationId: operation.id,
          fencingRevision: operation.fencingRevision,
          claimOwner: operation.claimOwner,
        },
        commands: [
          {
            name: "owned validation command",
            surfaces: ["example.ts"],
            timeoutMs: 30_000,
            argv: [
              "bun",
              "-e",
              `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); await Bun.sleep(30000);`,
            ],
          },
        ],
      }),
    );
    await writeRuntimeState(runtimeFile(values.home), {
      schemaVersion: 1,
      tasks: [{ ...runtimeTask(values), endpoints: [worker], operation, jobs: [job] }],
      presentations: [],
    });
    const workerPath = fileURLToPath(new URL("../../src/validation-worker.ts", import.meta.url));
    const argv = ["bun", workerPath, job.jobPath];
    const validation = Bun.spawn(argv, {
      cwd: job.cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    process = validation;
    const deadline = Date.now() + 5_000;
    while (!(await Bun.file(pidPath).exists()) && Date.now() < deadline) await Bun.sleep(10);
    commandPid = Number(await readFile(pidPath, "utf8"));
    if (!Number.isSafeInteger(commandPid) || commandPid <= 0)
      throw new Error("invalid owned command PID");
    globalThis.process.kill(commandPid, 0);
    const workerRecord = { ...values.recordA, endpoint: worker };
    const runner = nativeResetRunner([
      { record: values.recordA, agentStatus: "working" },
      { record: workerRecord, agentStatus: "working" },
    ]);
    const run: CommandRunner = async (request) => {
      if (request.argv[4] === "process-info" && request.argv[6] === worker.paneId) {
        return result(
          processPayload(
            workerRecord,
            validation.exitCode === null
              ? [{ pid: validation.pid, name: "bun", argv, argv0: "bun" }]
              : [{ pid: validation.pid, name: "zsh", argv: ["-zsh"], argv0: "zsh" }],
          ),
        );
      }
      if (request.argv[5] === worker.paneId) {
        if (request.argv[4] === "send-keys") {
          validation.kill("SIGINT");
          return result(JSON.stringify({ result: { type: "ok" } }));
        }
        if (request.argv[4] === "close" && validation.exitCode === null) {
          validation.kill("SIGKILL");
        }
      }
      return runner.run(request);
    };

    await resetCoordinators(run, {
      home: values.home,
      sessionId: "tandem",
      repoPaths: [values.repoA],
      force: true,
    });
    await validation.exited;

    expect(() => globalThis.process.kill(commandPid as number, 0)).toThrow();
    commandPid = undefined;
    expect(runner.panes.get(worker.paneId)?.present).toBe(false);
  } finally {
    if (process !== undefined) {
      if (process.exitCode === null) process.kill("SIGKILL");
      await process.exited;
    }
    if (commandPid !== undefined) {
      try {
        globalThis.process.kill(-commandPid, "SIGKILL");
      } catch (error) {
        expect(error).toHaveProperty("code", "ESRCH");
      }
    }
    await cleanup(values.root);
  }
}, 10_000);

test("coordinator source resolution fetches origin/main before selecting a new revision", async () => {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    if (request.argv.slice(3).join(" ") === "remote") return result("origin\n");
    if (request.argv.slice(3).join(" ") === "fetch origin refs/heads/main:refs/remotes/origin/main")
      return result();
    if (
      request.argv.slice(3).join(" ") === "rev-parse --verify refs/remotes/origin/main^{commit}"
    ) {
      return result("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n");
    }
    throw new Error(`unexpected command ${request.argv.join(" ")}`);
  };

  await expect(resolveCoordinatorSourceHead(run, "/repo")).resolves.toEqual({
    head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    localOnly: false,
  });
  expect(calls.map((request) => request.argv.slice(3))).toEqual([
    ["remote"],
    ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"],
    ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
  ]);
});

test("coordinator source resolution reports repositories without origin as explicitly local-only", async () => {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    if (request.argv.slice(3).join(" ") === "remote") return result("\n");
    if (request.argv.slice(3).join(" ") === "rev-parse HEAD") {
      return result("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    }
    throw new Error(`unexpected command ${request.argv.join(" ")}`);
  };

  await expect(resolveCoordinatorSourceHead(run, "/repo")).resolves.toEqual({
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    localOnly: true,
  });
  expect(calls.map((request) => request.argv.slice(3))).toEqual([
    ["remote"],
    ["rev-parse", "HEAD"],
  ]);
});

test("coordinator source resolution fails closed when configured origin/main cannot be fetched", async () => {
  const run: CommandRunner = async (request) => {
    if (request.argv.slice(3).join(" ") === "remote") return result("origin\n");
    if (
      request.argv.slice(3).join(" ") === "fetch origin refs/heads/main:refs/remotes/origin/main"
    ) {
      return result("", 1, "remote unavailable");
    }
    throw new Error(`unexpected command ${request.argv.join(" ")}`);
  };

  await expect(resolveCoordinatorSourceHead(run, "/repo")).rejects.toThrow(
    "git fetch origin/main failed",
  );
});

test("persists source refresh intent before switching and recovers an interrupted checkout", async () => {
  const setup = await sourceRefreshFixture();
  const { values, sourceHeadA, sourceHeadB } = setup;
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    let interruptAfterSwitch = true;
    const runner = sourceRefreshRunner(values.recordA, async () => {
      if (interruptAfterSwitch) {
        interruptAfterSwitch = false;
        throw new Error("simulated interruption after checkout switch");
      }
    });
    const input = {
      home: values.home,
      sessionId: "tandem",
      repoPath: values.repoA,
      sourceRepoPath: values.worktreeA,
      run: runner.run,
    };

    await expect(refreshCoordinatorSource(input)).rejects.toThrow(
      "simulated interruption after checkout switch",
    );
    expect(await runGitFixtureCommand(values.worktreeA, ["rev-parse", "HEAD"])).toBe(sourceHeadB);
    expect(await runGitFixtureCommand(values.repoA, ["rev-parse", "HEAD"])).toBe(sourceHeadA);
    const interrupted = await listCoordinatorRecords(values.home, "tandem");
    expect(interrupted).toEqual([
      {
        ...values.recordA,
        pendingSourceRefresh: {
          leaseId: values.recordA.worktree.leaseId,
          leaseHolder: values.recordA.worktree.leaseHolder,
          fromHead: sourceHeadA,
          toHead: sourceHeadB,
        },
      },
    ]);

    await expect(refreshCoordinatorSource(input)).resolves.toEqual({
      head: sourceHeadB,
      localOnly: false,
      previousHead: sourceHeadB,
      changed: false,
    });
    expect(await runGitFixtureCommand(values.worktreeA, ["rev-parse", "HEAD"])).toBe(sourceHeadB);
    expect(await runGitFixtureCommand(values.worktreeA, ["status", "--porcelain"])).toBe("");
    expect(await runGitFixtureCommand(values.repoA, ["rev-parse", "HEAD"])).toBe(sourceHeadA);
    expect(await listCoordinatorRecords(values.home, "tandem")).toEqual([
      {
        ...values.recordA,
        worktree: { ...values.recordA.worktree, baseHead: sourceHeadB },
      },
    ]);
  } finally {
    await cleanup(values.root);
  }
});

test("refuses a dirty owned source checkout without discarding its file or lease", async () => {
  const setup = await sourceRefreshFixture();
  const { values, sourceHeadA } = setup;
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const dirtyFile = join(values.worktreeA, "keep-me.txt");
    await writeFile(dirtyFile, "do not discard\n");
    const runner = sourceRefreshRunner(values.recordA);

    await expect(
      refreshCoordinatorSource({
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
        sourceRepoPath: values.worktreeA,
        run: runner.run,
      }),
    ).rejects.toThrow("is dirty or has unmerged paths");
    expect(await readFile(dirtyFile, "utf8")).toBe("do not discard\n");
    expect(await runGitFixtureCommand(values.worktreeA, ["rev-parse", "HEAD"])).toBe(sourceHeadA);
    expect(await listCoordinatorRecords(values.home, "tandem")).toEqual([values.recordA]);
  } finally {
    await cleanup(values.root);
  }
});

test("refuses a clean owned checkout when the requested source path mismatches its lease", async () => {
  const setup = await sourceRefreshFixture();
  const { values, sourceHeadA } = setup;
  try {
    await saveCoordinatorRecord(values.home, values.recordA);
    const runner = sourceRefreshRunner(values.recordA);

    await expect(
      refreshCoordinatorSource({
        home: values.home,
        sessionId: "tandem",
        repoPath: values.repoA,
        sourceRepoPath: values.worktreeB,
        run: runner.run,
      }),
    ).rejects.toThrow("does not match expected source checkout");
    expect(await runGitFixtureCommand(values.worktreeA, ["rev-parse", "HEAD"])).toBe(sourceHeadA);
    expect(await listCoordinatorRecords(values.home, "tandem")).toEqual([values.recordA]);
  } finally {
    await cleanup(values.root);
  }
});
