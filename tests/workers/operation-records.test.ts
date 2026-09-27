import { expect, test } from "bun:test";
import { STOPPED_BEFORE_RESULT_REASON } from "../../src/recovery/central-review.ts";
import { runtimeFile } from "../../src/runtime/persistence.ts";
import type { DurableJob } from "../../src/runtime/schema.ts";
import { claimOf, type OperationClaim } from "../../src/workers/operation-claim.ts";
import { OperationRecords } from "../../src/workers/operation-records.ts";
import {
  SCENARIO_NOW,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioJob,
  scenarioOperation,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "../evals/scenario.ts";

type Seeded = Readonly<{
  readonly records: OperationRecords;
  readonly running: DurableJob;
  readonly claim: OperationClaim;
  readonly blocked: string[];
}>;

/** Seeds a task whose one job the caller last saw running, stored as `storedPhase` now. */
async function seed(world: ScenarioWorld, storedPhase: DurableJob["phase"]): Promise<Seeded> {
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  const endpoint = {
    ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
    role: "implementer" as const,
  };
  const running = scenarioJob({ home: world.home, role: "implementer", cwd: lease.path, endpoint });
  const stored: DurableJob =
    storedPhase === "running"
      ? running
      : { ...running, phase: storedPhase, error: STOPPED_BEFORE_RESULT_REASON };
  const operation = scenarioOperation(running);
  await seedScenarioTask(world, { kind: "implementation", stage: "implementing", worktree: lease });
  await seedScenarioRuntime(world, scenarioRuntimeTask({ jobs: [stored], operation }));
  const blocked: string[] = [];
  const records = new OperationRecords({
    home: world.home,
    store: world.store,
    runtimePath: runtimeFile(world.home),
    clock: world.clock,
    context: () => ({ now: SCENARIO_NOW, notificationId: "notification-1" }),
    getTask: async (taskId) => {
      const task = await world.store.read(taskId);
      if (task === undefined) throw new Error("scenario task is missing");
      return task;
    },
    runtimeFor: async (taskId) =>
      (await world.snapshot()).runtime.tasks.find((entry) => entry.taskId === taskId),
    blockTask: async (taskId, reason) => {
      blocked.push(reason);
      const task = await world.store.read(taskId);
      if (task === undefined) throw new Error("scenario task is missing");
      return task;
    },
  });
  const claim = claimOf(operation);
  if (claim === undefined) throw new Error("scenario operation has no claim");
  return { records, running, claim, blocked };
}

test("failJob leaves a job a restart already settled untouched", async () => {
  await withScenario({}, async (world) => {
    const { records, running, claim, blocked } = await seed(world, "failed");
    const task = await world.store.read(SCENARIO_TASK_ID);
    if (task === undefined) throw new Error("scenario task is missing");

    await records.failJob(task, running, "owned endpoint disappeared", claim, true, true);

    const runtime = (await world.snapshot()).runtime.tasks[0];
    expect(blocked).toEqual([]);
    expect(runtime?.operation?.phase).toBe("running");
    expect(runtime?.jobs[0]?.error).toBe(STOPPED_BEFORE_RESULT_REASON);
  });
});

test("failJob still fails a job that is active", async () => {
  await withScenario({}, async (world) => {
    const { records, running, claim, blocked } = await seed(world, "running");
    const task = await world.store.read(SCENARIO_TASK_ID);
    if (task === undefined) throw new Error("scenario task is missing");

    await records.failJob(task, running, "owned endpoint disappeared", claim, true, false);

    const runtime = (await world.snapshot()).runtime.tasks[0];
    expect(blocked).toEqual(["owned endpoint disappeared"]);
    expect(runtime?.operation?.phase).toBe("failed");
    expect(runtime?.jobs[0]).toMatchObject({
      phase: "failed",
      error: "owned endpoint disappeared",
    });
  });
});
