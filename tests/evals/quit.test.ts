import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner, Endpoint } from "../../src/contracts.ts";
import { launchCoordinator } from "../../src/coordinator/launch.ts";
import { quitQuestion, quitTandem, readQuitPlan } from "../../src/coordinator/quit.ts";
import type { CoordinatorRecord } from "../../src/coordinator/record.ts";
import { listCoordinatorRecords } from "../../src/coordinator/registry.ts";
import { runTerminal } from "../../src/main.ts";
import { nativeAct } from "../../src/native/actions.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import type { DurableJob } from "../../src/runtime/schema.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend } from "../../src/terminal-backend/contract.ts";
import {
  SCENARIO_NOW,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const VALIDATION_WORKER = fileURLToPath(new URL("../../src/validation-worker.ts", import.meta.url));

type Quitting = Readonly<{
  run: CommandRunner;
  terminal: TerminalBackend;
  record: CoordinatorRecord;
  /** The id of every Tern session the run killed. */
  killed: readonly string[];
}>;

/** Launches one Tern coordinator in the scenario and records every session kill. */
async function launched(world: ScenarioWorld): Promise<Quitting> {
  const killed: string[] = [];
  const run: CommandRunner = async (request) => {
    if (request.argv[1] === "kill" && request.argv[2] === "session")
      killed.push(request.argv[3] ?? "");
    return world.run(request);
  };
  const terminal = terminalBackend(run, { home: world.home, terminal: "tern" });
  await launchCoordinator(
    {
      cwd: world.repoPath,
      repo: world.repoPath,
      home: world.home,
      poolRoot: world.poolRoot,
      sessionId: world.sessionId,
      model: undefined,
      continueSession: false,
      headless: true,
      noAttach: true,
    },
    {
      run,
      terminal,
      startPersistent: async () => undefined,
      runInteractive: async () => {
        throw new Error("interactive launch forbidden");
      },
      sleep: async () => {},
      processEnvironment: {},
    },
  );
  const [record] = await listCoordinatorRecords(world.home, world.sessionId);
  if (record === undefined || record.endpoint.terminalSessionId === undefined)
    throw new Error("the launch recorded no Tern coordinator");
  return { run, terminal, record, killed };
}

/** A pane the user opened in a Tern session of their own, which Tandem never recorded. */
async function foreignSession(world: ScenarioWorld, name: string): Promise<string> {
  const created = await world.run({
    argv: ["tern", "new", "session", name, "--cwd", world.repoPath],
    cwd: world.repoPath,
  });
  const { session, block } = JSON.parse(created.stdout) as { session: string; block: string };
  expect(world.paneIsPresent(block)).toBe(true);
  return `${session}:${block}`;
}

/** A task whose validation runs in a pane of the coordinator's own Tern session. */
async function workingTask(world: ScenarioWorld, record: CoordinatorRecord, title: string) {
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  const endpoint: Endpoint = {
    ...world.openPane({ paneId: "8001", cwd: lease.path, anchor: record.endpoint }),
    ...(record.endpoint.terminalSessionId === undefined
      ? {}
      : { terminalSessionId: record.endpoint.terminalSessionId }),
    role: "reviewer",
  };
  const jobPath = join(lease.path, "validation", "job.json");
  await mkdir(join(lease.path, "validation"), { recursive: true });
  world.replaceForeground("8001", ["bun", VALIDATION_WORKER, jobPath]);
  const job: DurableJob = {
    schemaVersion: 1,
    id: "job-1",
    taskId: SCENARIO_TASK_ID,
    generation: 0,
    role: "validation",
    kind: "validation",
    cwd: lease.path,
    jobPath,
    resultPath: join(lease.path, "validation", "result.json"),
    attempt: 1,
    phase: "running",
    launchAttempted: true,
    createdAt: SCENARIO_NOW,
    endpoint,
  };
  await seedScenarioTask(world, {
    kind: "implementation",
    title,
    stage: "validating",
    worktree: lease,
    endpoints: [endpoint],
  });
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({ worktree: lease, endpoints: [endpoint], jobs: [job] }),
  );
  return { endpoint, job };
}

const quitCli = (world: ScenarioWorld, quitting: Quitting, extra: readonly string[] = []) => {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    out,
    err,
    asked,
    run: (argv: readonly string[], answers: readonly string[] = [], tty = false) => {
      const remaining = [...answers];
      return runTerminal(
        ["quit", "--home", world.home, "--session", world.sessionId, ...extra, ...argv],
        {
          cwd: world.repoPath,
          processEnvironment: {},
          run: quitting.run,
          terminal: quitting.terminal,
          ...(tty
            ? {
                prompt: async (question: string) => {
                  asked.push(question);
                  return remaining.shift() ?? "no";
                },
              }
            : { isTTY: false }),
          stdout: (text) => out.push(text),
          stderr: (text) => err.push(text),
        },
      );
    },
  };
};

test("quit with nothing running stops the coordinator and kills only the Tern session Tandem created", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    const { record } = quitting;
    const theirs = await foreignSession(world, "my scratch session");
    const [theirSession, theirPane] = theirs.split(":");
    const ownedPanes = [record.endpoint.paneId, record.endpoint.notificationPane?.paneId ?? ""];
    for (const paneId of ownedPanes) expect(world.paneIsPresent(paneId)).toBe(true);

    const report = await quitTandem(quitting.run, quitting.terminal, {
      home: world.home,
      sessionId: world.sessionId,
    });

    expect(report.coordinators.map((stopped) => stopped.repoPath)).toEqual([world.repoPath]);
    for (const paneId of ownedPanes) expect(world.paneIsPresent(paneId)).toBe(false);
    expect(world.paneIsPresent(theirPane ?? "")).toBe(true);
    expect(quitting.killed).toEqual([record.endpoint.terminalSessionId ?? ""]);
    expect(quitting.killed).not.toContain(theirSession ?? "");
    // The record stays, so the next launch replaces the stopped coordinator and resumes its chat.
    expect(await listCoordinatorRecords(world.home, world.sessionId)).toEqual([record]);
  });
});

test("a pane Tandem does not own in its session keeps the session and the pane", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    const { record } = quitting;
    const theirs = world.openPane({
      paneId: "7002",
      cwd: world.repoPath,
      terminalSessionId: record.endpoint.terminalSessionId ?? "",
    });

    await quitTandem(quitting.run, quitting.terminal, {
      home: world.home,
      sessionId: world.sessionId,
    });

    expect(world.paneIsPresent(record.endpoint.paneId)).toBe(false);
    expect(world.paneIsPresent(theirs.paneId)).toBe(true);
    expect(quitting.killed).toEqual([]);
  });
});

test("quit with no coordinator or terminal server says nothing is running and changes nothing", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    await quitTandem(quitting.run, quitting.terminal, {
      home: world.home,
      sessionId: world.sessionId,
    });
    const killed = [...quitting.killed];
    const cli = quitCli(world, quitting);
    expect((await cli.run([], [], false)).status).toBe("quit");
    expect(cli.out.join("")).toContain("nothing to quit");
    expect(quitting.killed).toEqual(killed);
  });
});

test("a working task makes quit ask, and the answer decides whether anything closes", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    const { endpoint } = await workingTask(world, quitting.record, "Port the board");
    const plan = await readQuitPlan(quitting.run, quitting.terminal, {
      home: world.home,
      sessionId: world.sessionId,
    });
    expect(plan.working).toEqual([{ id: SCENARIO_TASK_ID, title: "Port the board" }]);
    const question = quitQuestion(plan.working);
    expect(question).toBe(
      "1 task is working: Port the board. Quit anyway? They restart where they can next time you run tandem.",
    );

    // No terminal and no --yes: refuse, naming --yes, and touch nothing.
    const silent = quitCli(world, quitting);
    const refused = await silent.run([], [], false);
    expect(refused.status).toBe("error");
    expect(refused.error?.message).toContain("--yes");
    // A person who declines changes nothing either.
    const declining = quitCli(world, quitting);
    expect((await declining.run([], ["no"], true)).status).toBe("cancelled");
    expect(declining.asked).toEqual([question]);
    for (const paneId of [quitting.record.endpoint.paneId, endpoint.paneId])
      expect(world.paneIsPresent(paneId)).toBe(true);
    expect(quitting.killed).toEqual([]);

    // --yes answers the question; a typed yes does too.
    const answering = quitCli(world, quitting);
    expect((await answering.run([], ["yes"], true)).status).toBe("quit");
    expect(answering.out.join("")).toContain("stopped 1 coordinator and closed 1 worker pane");
    for (const paneId of [quitting.record.endpoint.paneId, endpoint.paneId])
      expect(world.paneIsPresent(paneId)).toBe(false);
    expect(quitting.killed).toEqual([quitting.record.endpoint.terminalSessionId ?? ""]);
    // Durable state is kept as it was: the task still validates, so recovery restarts its worker.
    expect((await world.store.list()).map((task) => task.stage)).toEqual(["validating"]);
    const runtime = await readRuntimeState(runtimeFile(world.home));
    expect(runtime.tasks[0]?.jobs.map((job) => job.phase)).toEqual(["running"]);
  });
});

test("--yes quits past working tasks without asking", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    const { endpoint } = await workingTask(world, quitting.record, "Port the board");
    const cli = quitCli(world, quitting);
    expect((await cli.run(["--yes"], [], false)).status).toBe("quit");
    expect(cli.asked).toEqual([]);
    expect(world.paneIsPresent(endpoint.paneId)).toBe(false);
  });
});

test("quit refuses to close the pane it is running in", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    const cli = quitCli(world, quitting);
    const inside = await runTerminal(
      ["quit", "--home", world.home, "--session", world.sessionId, "--yes"],
      {
        cwd: world.repoPath,
        processEnvironment: {
          TERN_PANE: quitting.record.endpoint.paneId,
          TANDEM_TERN_WORKSPACE_ID: quitting.record.endpoint.workspaceId,
          TANDEM_SESSION: world.sessionId,
        },
        run: quitting.run,
        terminal: quitting.terminal,
        stdout: (text) => cli.out.push(text),
        stderr: (text) => cli.err.push(text),
      },
    );
    expect(inside.status).toBe("error");
    expect(inside.error?.message).toContain("would close the pane it is running in");
    expect(world.paneIsPresent(quitting.record.endpoint.paneId)).toBe(true);
    expect(quitting.killed).toEqual([]);
  });
});

/** The envelope Luau's `rt.act` writes for a click in the coordinator's own pane. */
function quitEnvelope(record: CoordinatorRecord, confirmed: boolean): string {
  return JSON.stringify({
    v: 1,
    origin: { pane: record.endpoint.paneId, cwd: record.worktree.path },
    action: { verb: "quit", confirmed },
  });
}

test("the native quit action asks first, then hands the quit to a detached tandem quit", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    const { endpoint } = await workingTask(world, quitting.record, "Port the board");
    const started: { argv: readonly string[]; cwd: string; log?: string | undefined }[] = [];
    const act = (confirmed: boolean) =>
      nativeAct(quitEnvelope(quitting.record, confirmed), {
        cwd: world.repoPath,
        processEnvironment: { TANDEM_HOME: world.home },
        run: quitting.run,
        terminal: quitting.terminal,
        startQuit: async (request) => {
          started.push(request);
          return undefined;
        },
      });

    const asked = await act(false);
    expect(asked).toEqual({
      status: "confirm",
      notice: {
        code: "quit-confirm",
        text: "1 task is working: Port the board. Quit anyway? They restart where they can next time you run tandem.",
      },
    });
    expect(started).toEqual([]);
    expect(world.paneIsPresent(endpoint.paneId)).toBe(true);

    // A start that reports no process is a failure the click shows, not a silent quit.
    expect((await act(true)).status).toBe("refused");
    expect(started).toHaveLength(1);
    const [request] = started;
    expect(request?.argv.slice(2)).toEqual([
      "quit",
      "--yes",
      "--home",
      world.home,
      "--session",
      world.sessionId,
    ]);
    expect(request?.log).toBe(join(world.home, "quit.log"));
    // Nothing closed in the click's own process: its pane is about to die.
    expect(world.paneIsPresent(quitting.record.endpoint.paneId)).toBe(true);
  });
});

test("the detached quit a native click starts runs the same quit and closes everything", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    const { endpoint } = await workingTask(world, quitting.record, "Port the board");
    const outcome = await nativeAct(quitEnvelope(quitting.record, true), {
      cwd: world.repoPath,
      processEnvironment: { TANDEM_HOME: world.home },
      run: quitting.run,
      terminal: quitting.terminal,
      startQuit: async (request) => {
        // What the detached child would run: the same CLI, in its own process.
        const [, , ...argv] = request.argv;
        const result = await runTerminal(argv, {
          cwd: request.cwd,
          processEnvironment: {},
          run: quitting.run,
          terminal: quitting.terminal,
          stdout: () => undefined,
          stderr: () => undefined,
        });
        expect(result.status).toBe("quit");
        return { pid: 1, exited: Promise.resolve(0) };
      },
    });
    expect(outcome).toEqual({ status: "done" });
    expect(world.paneIsPresent(quitting.record.endpoint.paneId)).toBe(false);
    expect(world.paneIsPresent(endpoint.paneId)).toBe(false);
    expect(quitting.killed).toEqual([quitting.record.endpoint.terminalSessionId ?? ""]);
  });
});

test("the next launch after a quit replaces the stopped coordinator and keeps its lease", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const first = await launched(world);
    await quitTandem(first.run, first.terminal, { home: world.home, sessionId: world.sessionId });
    const second = await launched(world);
    expect(second.record.endpoint.paneId).not.toBe(first.record.endpoint.paneId);
    expect(second.record.worktree.leaseId).toBe(first.record.worktree.leaseId);
    expect(world.paneIsPresent(second.record.endpoint.paneId)).toBe(true);
  });
});

test("under Herdr, quit closes the coordinator through the same owned-close path", async () => {
  await withScenario({}, async (world) => {
    const terminal = terminalBackend(world.run, { home: world.home, terminal: "herdr" });
    await launchCoordinator(
      {
        cwd: world.repoPath,
        repo: world.repoPath,
        home: world.home,
        poolRoot: world.poolRoot,
        sessionId: world.sessionId,
        model: undefined,
        continueSession: false,
        headless: true,
        noAttach: true,
      },
      {
        run: world.run,
        terminal,
        startPersistent: async () => undefined,
        runInteractive: async () => {
          throw new Error("interactive launch forbidden");
        },
        sleep: async () => {},
        processEnvironment: {},
      },
    );
    const [record] = await listCoordinatorRecords(world.home, world.sessionId);
    if (record === undefined) throw new Error("the launch recorded no coordinator");
    expect(world.paneIsPresent(record.endpoint.paneId)).toBe(true);

    const report = await quitTandem(world.run, terminal, {
      home: world.home,
      sessionId: world.sessionId,
    });

    expect(report.coordinators.map((stopped) => stopped.workspaceRetirement.outcome)).toEqual([
      "closed",
    ]);
    expect(world.paneIsPresent(record.endpoint.paneId)).toBe(false);
    expect(await listCoordinatorRecords(world.home, world.sessionId)).toEqual([record]);
  });
});

test("a job whose pane is already gone is not working, so quit does not ask about it", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const quitting = await launched(world);
    const { endpoint } = await workingTask(world, quitting.record, "Port the board");
    world.removePane(endpoint.paneId);
    const plan = await readQuitPlan(quitting.run, quitting.terminal, {
      home: world.home,
      sessionId: world.sessionId,
    });
    expect(plan.working).toEqual([]);
    const cli = quitCli(world, quitting);
    expect((await cli.run([], [], false)).status).toBe("quit");
    expect(cli.asked).toEqual([]);
    expect(world.paneIsPresent(quitting.record.endpoint.paneId)).toBe(false);
  });
});
