import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndpointOwnershipError } from "../../src/adapters/primitives.ts";
import type { CommandRunner, Endpoint, WorktreeLease } from "../../src/contracts.ts";
import { retireCoordinatorWorkspace } from "../../src/coordinator/workspace.ts";
import { recoverEndpointFromLaunch } from "../../src/tasks/endpoint-launch.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { storedEndpointTerminal } from "../../src/terminal-backend/identity.ts";

for (const [chosen, selection] of [
  ["herdr", "saved"],
  ["herdr", "explicit"],
  ["tern", "saved"],
  ["tern", "explicit"],
] as const) {
  test(`${selection} ${chosen} quarantines the other terminal's identical ids without contacting it`, async () => {
    const home = await mkdtemp(join(tmpdir(), "tandem-terminal-"));
    const calls: unknown[] = [];
    const forbidden: CommandRunner = async (request) => {
      calls.push(request);
      throw new Error("foreign ids reached the runner");
    };
    const endpoint: Endpoint = {
      terminal: chosen === "herdr" ? "tern" : "herdr",
      sessionId: "same",
      workspaceId: "same",
      tabId: "same",
      paneId: "same",
      role: "coordinator",
      generation: 0,
    };
    const lease: WorktreeLease = {
      root: home,
      path: home,
      name: "lease",
      branch: "test",
      baseHead: "a".repeat(40),
      leaseId: "lease",
      leaseHolder: "holder",
      leasedAt: "2026-10-06T00:00:00.000Z",
    };
    try {
      const saved = selection === "saved" ? chosen : endpoint.terminal;
      await writeFile(join(home, "settings.toml"), `terminal = "${saved}"\n`);
      const terminal = terminalBackend(forbidden, {
        ...(selection === "explicit" ? { terminal: chosen } : {}),
        home,
        createTern: () => ({ ...terminalBackend(forbidden), name: "tern" }),
      });
      const result = await retireCoordinatorWorkspace(terminal, home, {
        repoPath: home,
        endpoint,
        worktree: lease,
      });
      expect(result.outcome).toBe("quarantined");
      expect(result.reason).toContain(`${endpoint.terminal} endpoint under ${chosen}`);
      for (const operation of [
        () => terminal.inspect({ endpoint, cwd: home }),
        () => terminal.close({ endpoint, cwd: home, force: true }),
        () => terminal.closeOwned({ endpoint, cwd: home }),
        () => terminal.runCommand({ endpoint, cwd: home, command: ["true"] }),
        () => terminal.sendKeys({ endpoint, cwd: home, keys: ["ctrl+c"] }),
        () => terminal.interrupt({ endpoint, cwd: home }),
        () =>
          terminal.splitBeside({ anchor: endpoint, cwd: home, role: "reviewer", generation: 0 }),
        () => terminal.openPanel({ coordinator: endpoint, cwd: home, project: home }),
        () => terminal.isPanelOpen({ coordinator: endpoint, cwd: home, panelPaneId: "same" }),
        () =>
          terminal.openView({
            coordinator: endpoint,
            cwd: home,
            home,
            view: { kind: "task", taskId: "task" },
          }),
      ])
        await expect(operation()).rejects.toBeInstanceOf(EndpointOwnershipError);
      const recovery = await recoverEndpointFromLaunch(terminal, {
        terminal: endpoint.terminal,
        schemaVersion: 1,
        reservationId: "reserved",
        sessionId: "same",
        taskName: "task",
        workspaceLabel: "task",
        cwd: home,
        role: "implementer",
        generation: 0,
        createdAt: "2026-10-06T00:00:00.000Z",
      });
      expect(recovery.status).toBe("ambiguous");
      expect(calls).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("old records remain Herdr and unknown terminal names fail closed", () => {
  expect(storedEndpointTerminal(undefined, "endpoint")).toBe("herdr");
  expect(storedEndpointTerminal("tern", "endpoint")).toBe("tern");
  expect(() => storedEndpointTerminal("other", "endpoint")).toThrow(
    'terminal must be "herdr" or "tern"',
  );
});

test("an uncertain adapter effect remains quarantined after later calls and terminal selection", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-terminal-"));
  const endpoint: Endpoint = {
    terminal: "tern",
    sessionId: "session",
    workspaceId: "workspace",
    tabId: "tab",
    paneId: "pane",
    role: "implementer",
    generation: 0,
  };
  let effects = 0;
  const forbidden: CommandRunner = async () => {
    throw new Error("unexpected external command");
  };
  try {
    await writeFile(join(home, "settings.toml"), 'terminal = "tern"\n');
    const terminal = terminalBackend(forbidden, {
      home,
      createTern: () => {
        let quarantined = false;
        return {
          ...terminalBackend(forbidden),
          name: "tern",
          runCommand: async () => {
            if (quarantined) throw new Error("effect is quarantined");
            effects += 1;
            quarantined = true;
            throw new Error("effect outcome is unknown");
          },
        };
      },
    });
    const launch = () => terminal.runCommand({ endpoint, cwd: home, command: ["agent"] });
    await expect(launch()).rejects.toThrow("outcome is unknown");
    await expect(launch()).rejects.toThrow("quarantined");
    await writeFile(join(home, "settings.toml"), 'terminal = "herdr"\n');
    expect(terminal.name).toBe("herdr");
    await writeFile(join(home, "settings.toml"), 'terminal = "tern"\n');
    await expect(launch()).rejects.toThrow("quarantined");
    expect(effects).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
