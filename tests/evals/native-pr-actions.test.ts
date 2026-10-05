import { expect, test } from "bun:test";
import { runTerminal } from "../../src/main.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { createTandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_TASK_ID,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

for (const state of ["draft", "open"] as const) {
  test(`a native comment on a ready ${state} PR starts a fix generation after its worker finished`, async () => {
    await withScenario({}, async (world) => {
      const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
      await seedScenarioTask(world, {
        kind: "implementation",
        stage: "ready",
        reviewHead: SCENARIO_HEAD,
        worktree: lease,
        endpoints: [],
        pullRequest: {
          repository: "owner/repo",
          number: 42,
          state,
          head: SCENARIO_HEAD,
          base: "main",
        },
      });
      await seedScenarioRuntime(
        world,
        scenarioRuntimeTask({ worktree: lease, endpoints: [], jobs: [] }),
      );
      const service = createTandemService({
        home: world.home,
        sessionId: world.sessionId,
        poolRoot: world.poolRoot,
        run: world.run,
        clock: world.clock,
        idFactory: world.idFactory,
        workerTimeoutMs: 1500,
      });
      try {
        const result = await runTerminal(
          ["native", "pr-comment", SCENARIO_TASK_ID, "--text", "Fix src/view.ts:12"],
          {
            cwd: world.repoPath,
            processEnvironment: { TANDEM_HOME: world.home, TANDEM_SESSION: world.sessionId },
            run: world.run,
            service,
            stdout: () => {},
            stderr: () => {},
          },
        );
        expect(result.exitCode).toBe(0);
        const task = await service.get(SCENARIO_TASK_ID);
        expect(task.stage).toBe("implementing");
        expect(task.generation).toBe(1);
        expect(task.worktree?.leaseId).toBe(lease.leaseId);
        expect(task.communication?.messages[0]?.text).toContain(
          "PR fix request: Fix src/view.ts:12",
        );
        const snapshot = await world.snapshot();
        expect(snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob)?.generation).toBe(1);
        expect(snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob)?.cwd).toBe(lease.path);
        expect(snapshot.trace.some((event) => event.action === "treehouse get")).toBe(false);
      } finally {
        await service.shutdown();
      }
    });
  }, 20_000);
}

test("a ready PR whose fix cannot start reports the saved feedback and blocker", async () => {
  await withScenario({}, async (world) => {
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "ready",
      endpoints: [],
      pullRequest: {
        repository: "owner/repo",
        number: 42,
        state: "open",
        head: SCENARIO_HEAD,
        base: "main",
      },
    });
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    try {
      const result = await runTerminal(
        ["native", "pr-comment", SCENARIO_TASK_ID, "--text", "Fix this"],
        {
          cwd: world.repoPath,
          processEnvironment: { TANDEM_HOME: world.home, TANDEM_SESSION: world.sessionId },
          run: world.run,
          service,
          stdout: () => {},
          stderr: () => {},
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain(
        "PR feedback was saved, but the worker could not start fixing",
      );
      expect(result.error?.message).toContain("no reviewed work");
      expect((await service.get(SCENARIO_TASK_ID)).communication?.messages[0]?.text).toContain(
        "PR fix request: Fix this",
      );
    } finally {
      await service.shutdown();
    }
  });
});
