import { expect, test } from "bun:test";
import { join } from "node:path";
import { runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioJob,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

function serviceFor(world: ScenarioWorld): TandemService {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
  });
}

/** An implementing task whose worktree holds uncommitted changes, so a plain release keeps it. */
async function seedDirtyImplementation(world: ScenarioWorld): Promise<string> {
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  world.patchCheckout(lease.path, { dirty: true });
  await seedScenarioTask(world, {
    kind: "implementation",
    stage: "implementing",
    worktree: lease,
    endpoints: [],
  });
  await seedScenarioRuntime(world, scenarioRuntimeTask({ worktree: lease }));
  return `lease:${lease.leaseId}`;
}

test("cancel keeps a dirty worktree", async () => {
  await withScenario({}, async (world) => {
    const lease = await seedDirtyImplementation(world);
    const service = serviceFor(world);

    await service.cancel(SCENARIO_TASK_ID, "no longer needed");
    await service.tick();

    expect((await world.snapshot()).resources.retained).toContain(lease);
    await service.shutdown();
  });
});

test("cancel with discard deletes the dirty worktree in the cleanup that follows", async () => {
  await withScenario({}, async (world) => {
    const lease = await seedDirtyImplementation(world);
    const service = serviceFor(world);

    const cancelled = await service.cancel(SCENARIO_TASK_ID, "throw it away", { discard: true });
    expect(cancelled.stage).toBe("cancelled");
    await service.tick();

    expect((await world.snapshot()).resources.released).toContain(lease);
    await service.shutdown();
  });
});

test("cancel with discard on an already-cancelled task deletes its kept worktree", async () => {
  await withScenario({}, async (world) => {
    const lease = await seedDirtyImplementation(world);
    const service = serviceFor(world);
    await service.cancel(SCENARIO_TASK_ID, "no longer needed");
    await service.tick();

    await service.cancel(SCENARIO_TASK_ID, "throw it away", { discard: true });

    expect((await world.snapshot()).resources.released).toContain(lease);
    await service.shutdown();
  });
});

test("cleanup with discard closes a pane whose worker will not exit", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    world.replaceForeground("pane-1", ["omp", "--mode", "interactive"]);
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "ready",
      worktree: lease,
      endpoints: [endpoint],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        endpoints: [endpoint],
        jobs: [
          scenarioJob({
            home: world.home,
            role: "implementer",
            cwd: lease.path,
            endpoint,
            phase: "consumed",
          }),
        ],
      }),
    );
    const service = serviceFor(world);

    await service.cleanup(SCENARIO_TASK_ID, { discard: true, destructiveApproval: true });

    expect(world.paneIsPresent("pane-1")).toBe(false);
    expect((await world.snapshot()).resources.released).toContain(`lease:${lease.leaseId}`);
    await service.shutdown();
  });
});

test("cleanup without discard still refuses a busy worker pane", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    world.replaceForeground("pane-1", ["omp", "--mode", "interactive"]);
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "ready",
      worktree: lease,
      endpoints: [endpoint],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        endpoints: [endpoint],
        jobs: [
          scenarioJob({
            home: world.home,
            role: "implementer",
            cwd: lease.path,
            endpoint,
            phase: "consumed",
          }),
        ],
      }),
    );
    const service = serviceFor(world);

    await expect(service.cleanup(SCENARIO_TASK_ID)).rejects.toThrow();

    expect(world.paneIsPresent("pane-1")).toBe(true);
    await service.shutdown();
  });
});

test("cleanup closes a failed mockup pane and leaves a running one", async () => {
  await withScenario({}, async (world) => {
    await seedScenarioTask(world, { kind: "scout", stage: "completed", endpoints: [] });
    const presentation = (paneId: string, phase: "consumed" | "running") => {
      const cwd = join(world.home, "presentations", paneId);
      const endpoint = { ...world.openPane({ paneId, cwd }), role: "presentation" as const };
      world.replaceForeground(paneId, ["omp", "--mode", "interactive"]);
      return {
        schemaVersion: 1 as const,
        id: `presentation-${paneId}`,
        taskId: SCENARIO_TASK_ID,
        recordPath: join(cwd, "record.json"),
        job: {
          ...scenarioJob({ home: world.home, role: "presentation", cwd, endpoint, phase }),
          id: paneId,
        },
        endpoint,
      };
    };
    await writeRuntimeState(runtimeFile(world.home), {
      schemaVersion: 1,
      tasks: [scenarioRuntimeTask()],
      presentations: [
        presentation("failed-pane", "consumed"),
        presentation("running-pane", "running"),
      ],
    });
    const service = serviceFor(world);

    await service.cleanup(SCENARIO_TASK_ID);

    expect(world.paneIsPresent("failed-pane")).toBe(false);
    expect(world.paneIsPresent("running-pane")).toBe(true);
    await service.shutdown();
  });
});
