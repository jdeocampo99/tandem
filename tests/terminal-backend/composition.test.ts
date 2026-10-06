import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRequest, CommandRunner } from "../../src/contracts.ts";
import { openProject } from "../../src/coordinator/open-project.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import {
  terminalBackend,
  terminalContext,
  terminalContextFor,
  terminalLaunchEnvironment,
} from "../../src/terminal-backend/compose.ts";
import { withScenario } from "../evals/scenario.ts";

test("Tern alerts use the recorded helper and refuse missing or foreign ownership", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const writes: CommandRequest[] = [];
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      if (request.argv[0] === "ps" && request.argv[2] === "tty=")
        return { code: 0, stdout: "ttys99999\n", stderr: "" };
      if (request.argv[0] === process.execPath && request.argv[3] === "/dev/ttys99999") {
        writes.push(request);
        return { code: 0, stdout: "", stderr: "" };
      }
      return world.run(request);
    };
    const terminal = terminalBackend(run, { home: world.home });
    const alert = () =>
      terminal.notify({
        sessionId: world.sessionId,
        cwd: world.repoPath,
        title: "Needs you",
        body: "Review ready",
      });
    await expect(alert()).rejects.toThrow("requires a recorded Tandem-owned pane");
    expect(calls).toHaveLength(0);
    const { endpoint } = await terminal.createWorkspace({
      sessionId: world.sessionId,
      cwd: world.repoPath,
      label: "coordinator",
      role: "coordinator",
      generation: 0,
    });
    const worktree = await world.grantLease({ name: "alerts", holder: "coordinator" });
    const record = {
      schemaVersion: 1 as const,
      repoPath: world.repoPath,
      endpoint,
      worktree,
      command: ["omp"],
      harness: DEFAULT_HARNESS,
    };
    const { notificationPane, ...coordinator } = endpoint;
    expect(notificationPane).toBeDefined();
    await saveCoordinatorRecord(world.home, {
      ...record,
      endpoint: coordinator,
    });
    const beforeCoordinatorAlert = calls.length;
    await expect(alert()).rejects.toThrow("requires a recorded Tandem-owned pane");
    expect(calls).toHaveLength(beforeCoordinatorAlert);
    expect(writes).toHaveLength(0);
    await saveCoordinatorRecord(world.home, record);
    const beforeHelperAlert = calls.length;
    await alert();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.argv[4]).toBe("\x1b]777;notify;Needs you;Review ready\x07");
    const alertCalls = calls.slice(beforeHelperAlert);
    expect(
      alertCalls.some((call) => call.argv.includes(notificationPane?.paneId ?? "missing")),
    ).toBe(true);
    expect(alertCalls.some((call) => call.argv.includes(endpoint.paneId))).toBe(false);
    await saveCoordinatorRecord(world.home, {
      ...record,
      endpoint: { ...endpoint, terminal: "herdr" },
    });
    const before = calls.length;
    await expect(alert()).rejects.toThrow("quarantined herdr endpoint under tern");
    const foreignHelper = terminalBackend(run, {
      home: world.home,
      tern: {
        notificationEndpoint: async () => ({ ...endpoint, terminal: "herdr" }),
      },
    });
    await expect(
      foreignHelper.notify({
        sessionId: world.sessionId,
        cwd: world.repoPath,
        title: "Needs you",
        body: "Review ready",
      }),
    ).rejects.toThrow("quarantined herdr endpoint under tern");
    await expect(
      openProject(async () => ({ code: 0, stdout: "", stderr: "" }), terminal, {
        repoPath: world.repoPath,
        home: world.home,
        sessionId: world.sessionId,
        poolRoot: world.poolRoot,
      }),
    ).rejects.toThrow("quarantined herdr endpoint under tern");
    expect(calls).toHaveLength(before);
    expect(writes).toHaveLength(1);
    const path = recordPath(world.home, world.sessionId, world.repoPath);
    await writeFile(
      path,
      JSON.stringify({ ...record, endpoint: { ...endpoint, terminal: undefined } }),
    );
    expect((await readCoordinatorRecord(path))?.endpoint.terminal).toBe("herdr");
  });
});

test("Tern launch context needs its injected workspace and namespace, and mixed contexts fail closed", () => {
  const tern = { TERN_PANE: "42", TANDEM_SESSION: "daemon", TANDEM_TERN_WORKSPACE_ID: "tab" };
  expect(terminalContext.inheritedPane(tern)).toEqual({
    status: "inside",
    sessionId: "daemon",
    workspaceId: "tab",
    paneId: "42",
  });
  expect(terminalContext.inheritedPane({ TERN_PANE: "42" }).status).toBe("invalid");
  const herdr = {
    HERDR_ENV: "1",
    HERDR_SESSION: "other",
    HERDR_WORKSPACE_ID: "other-tab",
    HERDR_PANE_ID: "42",
  };
  expect(terminalContext.inheritedPane({ ...herdr, ...tern }).status).toBe("invalid");
  expect(terminalContextFor("tern").inheritedPane(herdr).status).toBe("outside");
  const env = terminalLaunchEnvironment("tern", { ...herdr, ...tern, PATH: "/bin" });
  expect(terminalContext.inheritedPane(env)).toEqual({
    status: "inside",
    sessionId: "daemon",
    workspaceId: "tab",
    paneId: "42",
  });
  expect(env.PATH).toBe("/bin");
});

test("a worker launch gets its own Tern workspace even when the parent context is supplied", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const commands: string[] = [];
    const terminal = terminalBackend(
      async (request) => {
        if (request.argv[1] === "run") commands.push(request.argv[3] ?? "");
        return world.run(request);
      },
      { home: world.home },
    );
    const session = { sessionId: world.sessionId, cwd: world.repoPath };
    const parent = await terminal.createWorkspace({
      ...session,
      label: "coordinator",
      role: "coordinator",
      generation: 0,
    });
    const worker = await terminal.createWorkspace({
      ...session,
      label: "worker",
      role: "implementer",
      generation: 1,
      parentWorkspaceId: parent.endpoint.workspaceId,
    });
    await terminal.runCommand({
      endpoint: worker.endpoint,
      cwd: world.repoPath,
      command: ["bun", "worker.ts", "job.json"],
      env: { TANDEM_SESSION: "foreign", TANDEM_TERN_WORKSPACE_ID: parent.endpoint.workspaceId },
    });
    const launch = commands.find((command) => command.includes("'worker.ts'"));
    expect(launch).toBeDefined();
    expect(launch).toContain(`'TANDEM_SESSION=${world.sessionId}'`);
    expect(launch).toContain(`'TANDEM_TERN_WORKSPACE_ID=${worker.endpoint.workspaceId}'`);
    expect(launch).not.toContain(`'TANDEM_TERN_WORKSPACE_ID=${parent.endpoint.workspaceId}'`);
    expect(commands).toContain(
      `'export' 'TANDEM_SESSION=${world.sessionId}' 'TANDEM_TERN_WORKSPACE_ID=${worker.endpoint.workspaceId}' 'TERN_PANE=${worker.endpoint.paneId}'`,
    );
  });
});

test("the explicit factory choice builds Tern with an isolated home whose saved choice is Herdr", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "herdr"\n');
    const terminal = terminalBackend(world.run, { terminal: "tern", home: world.home });
    const created = await terminal.createWorkspace({
      sessionId: world.sessionId,
      cwd: world.repoPath,
      label: "worker",
      role: "implementer",
      generation: 1,
    });
    expect(created.endpoint.terminal).toBe("tern");
    expect(
      (await terminal.inspect({ endpoint: created.endpoint, cwd: world.repoPath })).pane.paneId,
    ).toBe(created.endpoint.paneId);
    expect(terminal.name).toBe("tern");
  });
});
