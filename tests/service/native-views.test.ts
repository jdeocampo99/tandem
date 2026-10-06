import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { nativeViewsPath } from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { state } from "../board/fixtures.ts";
import { seedScenarioTask, withScenario } from "../evals/scenario.ts";

const published = z.object({
  version: z.literal(1),
  kind: z.literal("panel"),
  revision: z.string(),
  model: z.object({
    writtenAt: z.string(),
    summary: z.object({ terminal: z.literal("tern"), sessionId: z.string() }),
    tasks: z.record(z.string(), z.object({ stage: z.string() })),
  }),
});

for (const [terminal, homeTerminal, publishes] of [
  ["tern", "tern", true],
  ["herdr", "herdr", false],
  ["herdr", "tern", false],
] as const) {
  test(`controller ${homeTerminal} home ${publishes ? "publishes" : "omits"} native views for ${terminal} endpoints`, async () => {
    await withScenario({ terminal }, async (world) => {
      await writeFile(join(world.home, "settings.toml"), `terminal = "${homeTerminal}"\n`);
      const endpoint = world.openPane({ paneId: "2001", cwd: world.repoPath });
      await saveCoordinatorRecord(world.home, {
        schemaVersion: 1,
        repoPath: world.repoPath,
        endpoint: { ...endpoint, role: "coordinator" },
        worktree: await world.grantLease({ name: "coordinator", holder: "coordinator" }),
        harness: DEFAULT_HARNESS,
        command: ["omp"],
      });
      const service = createTandemService({
        home: world.home,
        sessionId: world.sessionId,
        coordinatorPaneId: endpoint.paneId,
        run: world.run,
        clock: world.clock,
        idFactory: world.idFactory,
      });
      try {
        await service.writeBoardSnapshot(
          boardView(state({ projects: [world.repoPath] }), world.clock()),
        );
      } finally {
        await service.shutdown();
      }
      const path = nativeViewsPath(world.home, world.repoPath);
      if (publishes) {
        const view = published.parse(JSON.parse(await readFile(path, "utf8")));
        expect(view.model.summary).toEqual({ terminal: "tern", sessionId: endpoint.sessionId });
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      } else {
        await expect(stat(join(world.home, "native-views"))).rejects.toHaveProperty(
          "code",
          "ENOENT",
        );
      }
    });
  });
}

test("slow finished-task inspection leaves controller ticks free and coalesces pending publications", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const endpoint = world.openPane({ paneId: "2002", cwd: world.repoPath });
    const worktree = await world.grantLease({ name: "finished", holder: "finished" });
    const task = await seedScenarioTask(world, { kind: "scout", stage: "completed", worktree });
    await saveCoordinatorRecord(world.home, {
      schemaVersion: 1,
      repoPath: world.repoPath,
      endpoint: { ...endpoint, role: "coordinator" },
      worktree,
      harness: DEFAULT_HARNESS,
      command: ["omp"],
    });
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let held = false;
    let checkpoints = 0;
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      coordinatorPaneId: endpoint.paneId,
      clock: world.clock,
      idFactory: world.idFactory,
      run: async (request) => {
        if (request.argv[0] === "git") {
          if (request.argv.includes("status")) checkpoints++;
          if (!held) {
            held = true;
            started.resolve();
            await gate.promise;
          }
        }
        return world.run(request);
      },
    });
    const board = () => boardView(state({ projects: [world.repoPath] }), world.clock());
    try {
      // This returns before the first inspection is allowed to complete.
      await service.writeBoardSnapshot(board());
      await started.promise;
      for (let tick = 0; tick < 3; tick++) {
        world.advanceClock(1);
        await service.writeBoardSnapshot(board());
      }
      gate.resolve();
      await service.shutdown();
      const view = published.parse(
        JSON.parse(await readFile(nativeViewsPath(world.home, world.repoPath), "utf8")),
      );
      expect(view.model.writtenAt).toBe(world.clock());
      expect(view.model.tasks[task.id]?.stage).toBe("completed");
      expect(checkpoints).toBe(2);
    } finally {
      gate.resolve();
      await service.shutdown();
    }
  });
});
