import { expect, test } from "bun:test";
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

function serviceFor(world: ScenarioWorld) {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
  });
}

test("a foreign pane identity refuses resume and leaves the paused task untouched", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      workspaceId: "workspace-foreign",
      role: "implementer" as const,
    };
    const job = scenarioJob({ home: world.home, role: "implementer", cwd: lease.path, endpoint });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "paused",
      previousStage: "implementing",
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
    const service = serviceFor(world);

    await expect(service.resume(SCENARIO_TASK_ID)).rejects.toThrow(/cannot resume/i);

    const snapshot = await world.snapshot();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("paused");
    expect(task.generation).toBe(0);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain("endpoint:pane-1");
    expect(snapshot.resources.retained).toContain("reservation:reservation-1");
    expect(snapshot.trace.some((event) => event.action === "herdr pane run")).toBe(false);
    await service.shutdown();
  });
});

test("a lease whose recorded holder no longer matches is retained rather than returned", async () => {
  await withScenario({}, async (world) => {
    const granted = await world.grantLease({
      name: "scenario-task",
      holder: "another-coordinator",
    });
    const lease = { ...granted, leaseHolder: "scenario-holder" };
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
      researchContinuation: {
        schemaVersion: 1,
        disposition: "report-only",
        selectedBy: "explicit",
      },
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
      text: "Findings that outlive an ambiguous lease.",
      finishedAt: SCENARIO_NOW,
    });
    const service = serviceFor(world);

    await service.tick();
    await service.tick();

    const snapshot = await world.snapshot();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("completed");
    expect(task.cleanup?.status).toBe("quarantined");
    expect(snapshot.resources.quarantined).toContain(`cleanup:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain("worktree:lease-1");
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
    await service.shutdown();
  });
});

test("an unreadable Herdr pane fences the task without releasing its capacity", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    const job = scenarioJob({ home: world.home, role: "implementer", cwd: lease.path, endpoint });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "implementing",
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
    const service = serviceFor(world);
    world.failAt({
      boundary: "herdr",
      action: "herdr pane process-info",
      times: 4,
      stderr: "herdr lost the pane process table",
    });

    await service.tick();

    const snapshot = await world.snapshot();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause?.kind).toBe("transition-failed");
    expect(task.blockCause?.detail).toContain("scheduler failure");
    expect(snapshot.resources.quarantined).toContain(`task:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain("reservation:reservation-1");
    expect(snapshot.resources.retained).toContain("job:job-1");
    expect(world.paneIsPresent("pane-1")).toBe(true);
    await service.shutdown();
  });
});
