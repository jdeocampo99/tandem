import { expect, test } from "bun:test";
import { createTandemService } from "../../src/service/controller.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_TASK_ID,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

test("a redirect blocks when a reviewer becomes active after preparation without interrupting it", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const reviewer = {
      ...world.openPane({ paneId: "pane-reviewer", cwd: lease.path }),
      role: "reviewer" as const,
    };
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "reviewing",
      reviewHead: SCENARIO_HEAD,
      worktree: lease,
      endpoints: [reviewer],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [reviewer] }),
    );
    const backend = terminalBackend(world.run, { terminal: "herdr" });
    let inspections = 0;
    let interrupts = 0;
    const terminal = {
      ...backend,
      inspect: async (input: Parameters<typeof backend.inspect>[0]) => {
        const inspection = await backend.inspect(input);
        if (input.endpoint.paneId === reviewer.paneId && ++inspections === 2) {
          world.replaceForeground(reviewer.paneId, ["omp"]);
        }
        return inspection;
      },
      interrupt: async (input: Parameters<typeof backend.interrupt>[0]) => {
        interrupts++;
        return backend.interrupt(input);
      },
    };
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
      terminal,
    });
    try {
      await service.steer({ taskId: SCENARIO_TASK_ID, text: "Keep the current scope." });

      const task = await service.get(SCENARIO_TASK_ID);
      expect(task.stage).toBe("blocked");
      expect(task.generation).toBe(0);
      expect(task.blockCause?.detail).toContain("active foreground worker");
      expect(world.paneIsPresent(reviewer.paneId)).toBe(true);
      expect(interrupts).toBe(0);
      expect(world.trace().some((event) => event.action === "herdr pane send-keys")).toBe(false);
      expect(world.trace().some((event) => event.action === "kill")).toBe(false);
    } finally {
      await service.shutdown();
    }
  });
});
