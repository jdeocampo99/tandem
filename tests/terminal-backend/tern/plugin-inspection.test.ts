import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { findRunningCoordinator } from "../../../src/coordinator/ownership.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { withScenario } from "../../evals/scenario.ts";

test("live Tandem plugin blocks expose no agent or shell process", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({
      paneId: "48",
      cwd: world.repoPath,
      blockProgram: "tandem.panel",
    });
    const inspection = await ternBackend(world.run, world.tern).inspect({
      endpoint,
      cwd: world.repoPath,
    });
    expect(inspection.activeWorker).toBe(false);
    expect(inspection.processInfo.foregroundProcesses).toEqual([]);
    expect(inspection.processInfo.shellPid).toBeUndefined();
    expect(inspection.processInfo.foregroundProcessGroupId).toBeUndefined();
  });
});

test("discovery skips a live plugin block and reaches the real legacy coordinator", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const panel = world.openPane({
      paneId: "48",
      cwd: world.repoPath,
      blockProgram: "tandem.panel",
    });
    const coordinator = world.openPane({ paneId: "49", cwd: world.repoPath });
    world.replaceForeground(coordinator.paneId, [
      "omp",
      "--extension",
      fileURLToPath(new URL("../../../src/harness/omp/extension.ts", import.meta.url)),
      "--cwd",
      world.repoPath,
    ]);
    await expect(
      findRunningCoordinator(world.run, ternBackend(world.run, world.tern), {
        home: world.home,
        sessionId: world.sessionId,
        repoPath: world.repoPath,
      }),
    ).rejects.toThrow(`pre-registry Tandem coordinator`);
    expect(world.paneIsPresent(panel.paneId)).toBe(true);
    expect(world.paneIsPresent(coordinator.paneId)).toBe(true);
    expect(world.trace().some((event) => event.action === "tern close")).toBe(false);
  });
});

test("coordinator discovery skips a browser block Tern's daemon cannot inspect", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const owner = world.openPane({ paneId: "48", cwd: world.repoPath });
    const opened = await world.run({
      argv: [
        "tern",
        "browser",
        JSON.stringify({ op: "open", owner: Number(owner.paneId), url: "http://localhost:61440/" }),
        "--json",
      ],
      cwd: world.repoPath,
    });
    const browser: string = JSON.parse(opened.stdout).ok.block;
    const coordinator = world.openPane({ paneId: "49", cwd: world.repoPath });
    world.replaceForeground(coordinator.paneId, [
      "omp",
      "--extension",
      fileURLToPath(new URL("../../../src/harness/omp/extension.ts", import.meta.url)),
      "--cwd",
      world.repoPath,
    ]);
    const terminal = ternBackend(world.run, world.tern);
    const inspection = await terminal.inspect({
      endpoint: { ...owner, paneId: browser },
      cwd: world.repoPath,
    });
    expect(inspection.activeWorker).toBe(false);
    expect(inspection.processInfo.foregroundProcesses).toEqual([]);
    await expect(
      findRunningCoordinator(world.run, terminal, {
        home: world.home,
        sessionId: world.sessionId,
        repoPath: world.repoPath,
      }),
    ).rejects.toThrow(`pre-registry Tandem coordinator`);
  });
});

for (const program of [
  "",
  "sh",
  "foreign.panel",
  "tandem",
  "tandem.panel --fake",
  "/tandem.panel",
]) {
  test(`childless ${JSON.stringify(program)} panes fail closed despite a Tandem title`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      const endpoint = world.openPane({
        paneId: "48",
        cwd: world.repoPath,
        blockProgram: program,
      });
      world.titlePane(endpoint.paneId, "tandem.panel");
      const terminal = ternBackend(world.run, world.tern);
      await expect(terminal.inspect({ endpoint, cwd: world.repoPath })).rejects.toThrow(
        "live block has no child process",
      );
      await expect(
        findRunningCoordinator(world.run, terminal, {
          home: world.home,
          sessionId: world.sessionId,
          repoPath: world.repoPath,
        }),
      ).rejects.toThrow("live block has no child process");
      expect(world.paneIsPresent(endpoint.paneId)).toBe(true);
    });
  });
}

test("Tandem program identity never bypasses contradictory foreground evidence", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({
      paneId: "48",
      cwd: world.repoPath,
      blockProgram: "tandem.panel",
    });
    world.replaceForeground(endpoint.paneId, ["omp"]);
    await expect(
      ternBackend(world.run, world.tern).inspect({ endpoint, cwd: world.repoPath }),
    ).rejects.toThrow("live block has no child process");
  });
});

test("a Tandem-named shell with a worker remains busy", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "48", cwd: world.repoPath });
    world.titlePane(endpoint.paneId, "tandem.panel");
    world.replaceForeground(endpoint.paneId, ["omp"]);
    const terminal = ternBackend(world.run, world.tern);
    expect((await terminal.inspect({ endpoint, cwd: world.repoPath })).activeWorker).toBe(true);
    await expect(terminal.close({ endpoint, cwd: world.repoPath })).rejects.toThrow(
      "active foreground worker",
    );
  });
});
