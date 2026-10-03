import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelSpec, ResolvedPolicy } from "../../src/contracts.ts";
import {
  type CoordinatorLaunchDependencies,
  type CoordinatorLaunchRequest,
  launchCoordinator,
} from "../../src/coordinator/launch.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { restartCoordinator } from "../../src/coordinator/restart.ts";
import { sidecarSocketPath } from "../../src/harness/claude-code/socket.ts";
import { DEFAULT_HARNESS, parseHarnessName } from "../../src/harness/contract.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { parseWorkerJob, type WorkerJob } from "../../src/workers/jobs.ts";
import {
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

function policyWith(models: Partial<ResolvedPolicy["config"]["models"]>): ResolvedPolicy {
  return {
    ...SCENARIO_POLICY,
    config: { ...SCENARIO_POLICY.config, models: { ...SCENARIO_POLICY.config.models, ...models } },
  };
}

async function launchedScoutSpec(world: ScenarioWorld, policy: ResolvedPolicy): Promise<WorkerJob> {
  await seedScenarioTask(world, { kind: "scout", policy });
  await seedScenarioRuntime(world, scenarioRuntimeTask());
  const service = createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
  });
  try {
    await service.tick();
    const snapshot = await world.snapshot();
    const job = snapshot.runtime.tasks
      .find((entry) => entry.taskId === SCENARIO_TASK_ID)
      ?.jobs.at(-1);
    if (job === undefined) throw new Error("the scout did not launch");
    return parseWorkerJob(JSON.parse(await readFile(job.jobPath, "utf8")));
  } finally {
    await service.shutdown();
  }
}

const CLAUDE_CODE_SONNET: ModelSpec = { model: "claude-code/sonnet", thinking: "high" };
const CLAUDE_CODE_OPUS: ModelSpec = { model: "claude-code/opus", thinking: "high" };

test("a scout on a Claude Code model gets a Claude Code job while the coordinator stays on OMP", async () => {
  await withScenario({}, async (world) => {
    const spec = await launchedScoutSpec(world, policyWith({ scout: CLAUDE_CODE_SONNET }));
    expect(spec.model).toEqual(CLAUDE_CODE_SONNET);
    expect(spec.harness).toBe(parseHarnessName("claude-code", "harness"));
  });
});

test("a scout pinned to a Claude Code model launches although OMP's listing lacks it", async () => {
  const ompModels = [
    {
      provider: "openai-codex",
      id: "gpt-5.6",
      selector: "openai-codex/gpt-5.6",
      thinking: ["high"],
    },
  ];
  await withScenario({ ompModels }, async (world) => {
    const spec = await launchedScoutSpec(world, policyWith({ scout: CLAUDE_CODE_SONNET }));
    expect(spec.harness).toBe(parseHarnessName("claude-code", "harness"));
  });
});

test("a Claude Code coordinator leaves an OMP scout's job on OMP", async () => {
  await withScenario({}, async (world) => {
    const spec = await launchedScoutSpec(world, policyWith({ coordinator: CLAUDE_CODE_OPUS }));
    expect(spec.model).toEqual(SCENARIO_POLICY.config.models.scout);
    expect(spec.harness).toBe(DEFAULT_HARNESS);
  });
});

const CLAUDE_CODE_COORDINATOR: CoordinatorLaunchRequest["model"] = CLAUDE_CODE_OPUS;

function claudeCodeRequest(world: ScenarioWorld): CoordinatorLaunchRequest {
  return {
    cwd: world.repoPath,
    repo: world.repoPath,
    home: world.home,
    poolRoot: world.poolRoot,
    sessionId: world.sessionId,
    model: CLAUDE_CODE_COORDINATOR,
    continueSession: true,
    headless: true,
    noAttach: true,
  };
}

type FakeClaudeCode = Readonly<{
  ready: boolean;
  probes: string[];
  /** Claude Code saved the conversation (a first prompt was sent); absent means it did. */
  saved?: boolean;
}>;

/**
 * A clock the ready wait's sleeps move, a sidecar that answers when `ready` says so, and a
 * Claude Code that saved the conversation unless `saved` says otherwise.
 */
function claudeCodeDependencies(
  world: ScenarioWorld,
  sidecar: FakeClaudeCode,
): CoordinatorLaunchDependencies {
  let clock = 0;
  return {
    run: world.run,
    startPersistent: async () => undefined,
    runInteractive: async () => {
      throw new Error("a headless launch runs the coordinator in a Herdr pane");
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    answersHealth: async (socket) => {
      sidecar.probes.push(socket);
      return sidecar.ready;
    },
    exists: async () => sidecar.saved ?? true,
    processEnvironment: {},
  };
}

function conversationOf(command: readonly string[]): string {
  const flag = command.findIndex((value) => value === "--session-id" || value === "--resume");
  const id = command[flag + 1];
  if (flag === -1 || id === undefined) throw new Error("the command names no conversation");
  return id;
}

async function readBootstrap(world: ScenarioWorld): Promise<string> {
  const directory = join(world.home, "coordinator-scripts");
  const [script] = await readdir(directory);
  if (script === undefined) throw new Error("no coordinator script was written");
  return readFile(join(directory, script), "utf8");
}

test("a Claude Code coordinator starts a conversation, waits for its sidecar, and resumes it next time", async () => {
  await withScenario({}, async (world) => {
    const sidecar = { ready: true, probes: [] as string[] };
    const first = await launchCoordinator(
      claudeCodeRequest(world),
      claudeCodeDependencies(world, sidecar),
    );

    const id = conversationOf(first.command);
    expect(first.command.slice(0, 1)).toEqual(["claude"]);
    expect(first.command).toContain("--session-id");
    expect(sidecar.probes).toEqual([sidecarSocketPath(world.home, id)]);
    const record = await readCoordinatorRecord(
      recordPath(world.home, world.sessionId, world.repoPath),
    );
    expect(record?.harness).toBe(parseHarnessName("claude-code", "harness"));
    const script = await readBootstrap(world);
    expect(script).toContain("'DISABLE_GROWTHBOOK=1'");
    expect(script).toContain("'env' '-u' 'CLAUDECODE' '-u' 'CLAUDE_CODE_CHILD_SESSION'");
    expect(script).toContain(`'--resume' '${id}'`);
    const sessions = join(world.home, "coordinator-sessions");
    const [key] = await readdir(sessions);
    expect(await readFile(join(sessions, key ?? "", "claude-code-conversation"), "utf8")).toBe(
      `${id}\n`,
    );

    const second = await restartCoordinator(
      claudeCodeRequest(world),
      claudeCodeDependencies(world, sidecar),
    );
    expect(second.restarted).toBe(true);
    expect(second.command).toContain("--resume");
    expect(conversationOf(second.command)).toBe(id);
    expect(world.paneIsPresent(first.paneId ?? "")).toBe(false);
  });
});

test("a Claude Code coordinator quit before its first message starts again under the same id", async () => {
  await withScenario({}, async (world) => {
    const sidecar = { ready: true, probes: [] as string[], saved: false };
    const first = await launchCoordinator(
      claudeCodeRequest(world),
      claudeCodeDependencies(world, sidecar),
    );
    const id = conversationOf(first.command);

    const second = await restartCoordinator(
      claudeCodeRequest(world),
      claudeCodeDependencies(world, sidecar),
    );
    expect(second.restarted).toBe(true);
    // Claude Code has nothing to resume, so --resume would print "No conversation found" and
    // exit; the same id starts fresh instead and the record keeps naming it.
    expect(second.command).toContain("--session-id");
    expect(second.command).not.toContain("--resume");
    expect(conversationOf(second.command)).toBe(id);
  });
});

test("a Claude Code coordinator that never loads Tandem's plugin is stopped and its launch undone", async () => {
  await withScenario({}, async (world) => {
    const sidecar = { ready: false, probes: [] as string[] };
    const launch = launchCoordinator(
      claudeCodeRequest(world),
      claudeCodeDependencies(world, sidecar),
    );

    await expect(launch).rejects.toThrow(
      `Claude Code started but did not load Tandem's plugin within 30 seconds`,
    );
    await expect(launch).rejects.toThrow(`run \`claude\` once in ${world.repoPath}`);
    const snapshot = await world.snapshot();
    expect(snapshot.trace.some((event) => event.action === "kill")).toBe(true);
    expect(snapshot.resources.released).toContain("lease:lease-1");
    expect(snapshot.resources.quarantined).toEqual([]);
    expect(await readdir(join(world.home, "coordinator-sessions")).catch(() => [])).toEqual([]);
  });
});

test("a direct Claude Code coordinator that never gets ready is stopped in the caller's pane", async () => {
  await withScenario({}, async (world) => {
    const caller = world.openPane({ paneId: "caller", cwd: world.repoPath });
    let exit: (code: number) => void = () => undefined;
    const environments: Array<Readonly<Record<string, string>> | undefined> = [];
    const dependencies = claudeCodeDependencies(world, { ready: false, probes: [] });
    const launch = launchCoordinator(
      { ...claudeCodeRequest(world), headless: false, noAttach: false },
      {
        ...dependencies,
        run: async (request) => {
          if (request.argv[0] === "kill") exit(143);
          return world.run(request);
        },
        processEnvironment: {
          HERDR_ENV: "1",
          HERDR_SESSION: world.sessionId,
          HERDR_WORKSPACE_ID: caller.workspaceId,
          HERDR_PANE_ID: caller.paneId,
          CLAUDE_CODE_CHILD_SESSION: "1",
        },
        runInteractive: (request) => {
          environments.push(request.env);
          world.replaceForeground(caller.paneId, request.argv);
          return new Promise((resolve) => {
            exit = resolve;
          });
        },
      },
    );

    await expect(launch).rejects.toThrow("did not load Tandem's plugin");
    expect(environments.map((environment) => environment?.DISABLE_GROWTHBOOK)).toEqual(["1"]);
    expect(environments.map((environment) => environment?.CLAUDE_CODE_CHILD_SESSION)).toEqual([
      undefined,
    ]);
    const snapshot = await world.snapshot();
    expect(snapshot.trace.filter((event) => event.action === "kill")).toHaveLength(1);
    expect(snapshot.resources.released).toContain("lease:lease-1");
  });
});
