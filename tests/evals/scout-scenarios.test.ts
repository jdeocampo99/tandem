import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createTandemService } from "../../src/service/controller.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_NOW,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioJob,
  scenarioOperation,
  scenarioReservation,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const REPORT_TEXT = "The scout findings that must outlive every cleanup decision.";

async function seedRunningScout(world: ScenarioWorld): Promise<string> {
  const lease = world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  const endpoint = {
    ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
    role: "scout" as const,
  };
  const job = scenarioJob({ home: world.home, role: "scout", cwd: lease.path, endpoint });
  await seedScenarioTask(world, {
    kind: "scout",
    stage: "scouting",
    worktree: lease,
    endpoints: [endpoint],
  });
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      worktree: lease,
      endpoints: [endpoint],
      jobs: [job],
      operation: scenarioOperation(job),
      reservation: scenarioReservation(),
    }),
  );
  await persistWorkerResult(job.resultPath, {
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: "scout",
    status: "completed",
    text: REPORT_TEXT,
    finishedAt: SCENARIO_NOW,
  });
  return lease.path;
}

test("completed scout persists its report and releases the pane and lease it proved idle", async () => {
  await withScenario({}, async (world) => {
    await seedRunningScout(world);
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });

    await service.tick();
    const completed = await service.get(SCENARIO_TASK_ID);
    expect(completed.stage).toBe("completed");
    expect(completed.reportPath).toBeDefined();

    await service.tick();
    const snapshot = await world.snapshot();
    expect(await readFile(completed.reportPath ?? "", "utf8")).toBe(REPORT_TEXT);
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.released).toContain("pane:pane-1");
    expect(snapshot.resources.released).toContain("lease:lease-1");
    expect(snapshot.resources.released).toContain("job:job-1");
    expect(snapshot.resources.quarantined).toEqual([]);
    expect(snapshot.runtime.tasks[0]?.worktree).toBeUndefined();
    await service.shutdown();
  });
});

test("unmerged scout work keeps its worktree and report instead of being cleaned up", async () => {
  await withScenario({}, async (world) => {
    const worktreePath = await seedRunningScout(world);
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });

    await service.tick();
    world.patchCheckout(worktreePath, { unmerged: true });
    await service.tick();

    const snapshot = await world.snapshot();
    const completed = await service.get(SCENARIO_TASK_ID);
    expect(completed.stage).toBe("completed");
    expect(await readFile(completed.reportPath ?? "", "utf8")).toBe(REPORT_TEXT);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.runtime.tasks[0]?.lastError).toContain("retained worktree");
    expect(world.trace().some((event) => event.action === "treehouse return")).toBe(false);
    await service.shutdown();
  });
});

test("a refusing Treehouse boundary retains the scout lease and never discards it", async () => {
  await withScenario({}, async (world) => {
    await seedRunningScout(world);
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    world.failAt({ boundary: "treehouse", action: "treehouse return", times: 2 });

    await service.tick();
    await service.tick();

    const snapshot = await world.snapshot();
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.runtime.tasks[0]?.lastError).toContain("retained worktree");
    expect(
      snapshot.trace.some((event) => event.boundary === "treehouse" && event.outcome === "refused"),
    ).toBe(true);
    await service.shutdown();
  });
});
