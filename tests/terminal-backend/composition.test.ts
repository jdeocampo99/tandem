import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHomeSettings } from "../../src/config/home-settings.ts";
import type { CommandRunner } from "../../src/contracts.ts";
import { openProject } from "../../src/coordinator/open-project.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import {
  savedTerminal,
  terminalBackend,
  terminalContext,
  terminalContextFor,
} from "../../src/terminal-backend/compose.ts";
import { withScenario } from "../evals/scenario.ts";

test("an absent terminal setting selects Tern, and settings can still name Herdr", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-terminal-default-"));
  const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
  try {
    expect(savedTerminal(await readHomeSettings(home))).toBe("tern");
    expect(terminalBackend(run, { home }).name).toBe("tern");
    await writeFile(join(home, "settings.toml"), 'terminal = "herdr"\n');
    expect(terminalBackend(run, { home }).name).toBe("herdr");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit Tern selection overrides saved Herdr and alerts reach only the recorded helper", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "herdr"\n');
    const terminal = terminalBackend(world.run, { terminal: "tern", home: world.home });
    const alert = () =>
      terminal.notify({
        sessionId: world.sessionId,
        cwd: world.repoPath,
        title: "Needs you",
        body: "Review ready",
      });
    await expect(alert()).rejects.toThrow("requires a recorded Tandem-owned pane");
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
    if (notificationPane === undefined) throw new Error("Tern coordinator has no helper pane");
    await saveCoordinatorRecord(world.home, { ...record, endpoint: coordinator });
    await expect(alert()).rejects.toThrow("requires a recorded Tandem-owned pane");
    expect(world.ttyWrites()).toEqual([]);
    await saveCoordinatorRecord(world.home, record);
    await alert();
    expect(world.ttyWrites()).toEqual([
      { paneId: notificationPane.paneId, text: "\x1b]777;notify;Needs you;Review ready\x07" },
    ]);
    await saveCoordinatorRecord(world.home, {
      ...record,
      endpoint: { ...endpoint, terminal: "herdr" },
    });
    await expect(alert()).rejects.toThrow('set terminal = "herdr" in Tandem\'s settings.toml');
    const foreignHelper = terminalBackend(world.run, {
      terminal: "tern",
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
    ).rejects.toThrow('set terminal = "herdr" in Tandem\'s settings.toml');
    await expect(
      openProject(async () => ({ code: 0, stdout: "", stderr: "" }), terminal, {
        repoPath: world.repoPath,
        home: world.home,
        sessionId: world.sessionId,
        poolRoot: world.poolRoot,
      }),
    ).rejects.toThrow('set terminal = "herdr" in Tandem\'s settings.toml');
    expect(world.ttyWrites()).toHaveLength(1);
    const path = recordPath(world.home, world.sessionId, world.repoPath);
    await writeFile(
      path,
      JSON.stringify({ ...record, endpoint: { ...endpoint, terminal: undefined } }),
    );
    expect((await readCoordinatorRecord(path))?.endpoint.terminal).toBe("herdr");
  });
});

test("only Tern hosts native views, and the saved choice decides which terminal answers", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const settings = join(world.home, "settings.toml");
    await writeFile(settings, 'terminal = "herdr"\n');
    const saved = terminalBackend(world.run, { home: world.home });
    expect(saved.name).toBe("herdr");
    expect(saved.views).toBeUndefined();
    await writeFile(settings, 'terminal = "tern"\n');
    expect(saved.name).toBe("tern");
    expect(saved.views).toBeDefined();
    expect(await saved.fences.list(world.home)).toEqual({ fences: [], failures: [] });
    expect(
      terminalBackend(world.run, { terminal: "herdr", home: world.home }).views,
    ).toBeUndefined();
  });
});

test("Tern launch context needs its injected workspace and namespace, a user's own Tern pane is outside, and mixed contexts fail closed", () => {
  const tern = { TERN_PANE: "42", TANDEM_SESSION: "daemon", TANDEM_TERN_WORKSPACE_ID: "tab" };
  expect(terminalContext.inheritedPane(tern)).toEqual({
    status: "inside",
    sessionId: "daemon",
    workspaceId: "tab",
    paneId: "42",
  });
  expect(terminalContext.inheritedPane({ TERN_PANE: "42" }).status).toBe("outside");
  expect(
    terminalContext.inheritedPane({ TERN_PANE: "42", TANDEM_TERN_WORKSPACE_ID: "tab" }).status,
  ).toBe("invalid");
  const herdr = {
    HERDR_ENV: "1",
    HERDR_SESSION: "other",
    HERDR_WORKSPACE_ID: "other-tab",
    HERDR_PANE_ID: "42",
  };
  expect(terminalContext.inheritedPane({ ...herdr, ...tern }).status).toBe("invalid");
  expect(terminalContextFor("tern").inheritedPane(herdr).status).toBe("outside");
  const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
  const env = terminalBackend(run, { terminal: "tern" }).launchEnvironment({
    overrides: {},
    inherited: { ...herdr, ...tern, PATH: "/bin" },
  });
  expect(terminalContext.inheritedPane(env)).toEqual({
    status: "inside",
    sessionId: "daemon",
    workspaceId: "tab",
    paneId: "42",
  });
  expect(env.PATH).toBe("/bin");
});

test("a worker launch runs in its own Tern workspace even when the parent context is supplied", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const terminal = terminalBackend(world.run, { home: world.home });
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
      command: ["env"],
      env: { TANDEM_SESSION: "foreign", TANDEM_TERN_WORKSPACE_ID: parent.endpoint.workspaceId },
    });
    const shell = Bun.spawnSync(
      ["/bin/sh", "-c", world.ranLines(worker.endpoint.paneId).join("\n")],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
    );
    const seen = Object.fromEntries(
      shell.stdout
        .toString()
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(terminalContext.inheritedPane(seen)).toEqual({
      status: "inside",
      sessionId: world.sessionId,
      workspaceId: worker.endpoint.workspaceId,
      paneId: worker.endpoint.paneId,
    });
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
