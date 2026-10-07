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
import { withScenario } from "../evals/scenario.ts";

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
      });
      const result = await retireCoordinatorWorkspace(terminal, home, {
        repoPath: home,
        endpoint,
        worktree: lease,
      });
      expect(result.outcome).toBe("quarantined");
      expect(result.reason).toContain(
        `it is a ${endpoint.terminal} pane but this Tandem home uses ${chosen}`,
      );
      const views = terminal.views;
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
        ...(views === undefined
          ? []
          : [
              () =>
                views.close({
                  coordinator: endpoint,
                  cwd: home,
                  home,
                  origin: { paneId: "4" },
                  view: { kind: "brief", requestId: "req-1" },
                }),
              () =>
                views.open({
                  coordinator: endpoint,
                  cwd: home,
                  home,
                  view: { kind: "task", taskId: "task" },
                }),
            ]),
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
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "42", cwd: world.repoPath });
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    world.failAt({ boundary: "tern", action: "tern run" });
    const terminal = terminalBackend(world.run, { home: world.home });
    const launch = () => terminal.runCommand({ endpoint, cwd: world.repoPath, command: ["agent"] });
    await expect(launch()).rejects.toThrow("outcome is unknown");
    await expect(launch()).rejects.toThrow("outcome is unknown");
    await writeFile(join(world.home, "settings.toml"), 'terminal = "herdr"\n');
    expect(terminal.name).toBe("herdr");
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    await expect(launch()).rejects.toThrow("outcome is unknown");
    expect(world.trace().filter((event) => event.action === "tern run")).toHaveLength(1);
    expect(world.paneIsPresent(endpoint.paneId)).toBe(true);
  });
});
