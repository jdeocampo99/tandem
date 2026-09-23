import { expect, test } from "bun:test";
import { createTandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_TASK_ID,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "../evals/scenario.ts";

test("inspection is a JSON-safe, read-only view of one task's durable state", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "blocked",
      previousStage: "implementing",
      reviewHead: SCENARIO_HEAD,
      worktree: lease,
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask({ worktree: lease }));
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    const before = await world.snapshot();

    const value = await service.inspect(SCENARIO_TASK_ID);

    expect(value.taskId).toBe(SCENARIO_TASK_ID);
    expect(value.stage).toBe("blocked");
    expect(value.blocked).toBe(true);
    expect(value.review.reviewedHead).toBe(SCENARIO_HEAD);
    expect(value.worktree.preserved).toBe(true);
    expect(value.jobs).toEqual([]);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    expect((await world.snapshot()).runtime).toEqual(before.runtime);
    await service.shutdown();
  });
});
