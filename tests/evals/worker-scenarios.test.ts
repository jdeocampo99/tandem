import { expect, test } from "bun:test";
import type { WorktreeLease } from "../../src/contracts.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_NEXT_HEAD,
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

type RunningImplementation = Readonly<{
  readonly service: TandemService;
  readonly lease: WorktreeLease;
  readonly resultPath: string;
}>;

async function seedRunningImplementation(world: ScenarioWorld): Promise<RunningImplementation> {
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
  return {
    service: createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
      workerTimeoutMs: 1_500,
    }),
    lease,
    resultPath: job.resultPath,
  };
}

test("pause retains every owned worker resource and resume dispatches one continuation", async () => {
  await withScenario({}, async (world) => {
    const { service } = await seedRunningImplementation(world);

    const paused = await service.pause(SCENARIO_TASK_ID, "operator paused the scenario");
    const held = await world.snapshot();
    expect(paused.stage).toBe("paused");
    expect(held.resources.retained).toContain("lease:lease-1");
    expect(held.resources.retained).toContain("endpoint:pane-1");
    expect(held.resources.retained).toContain("reservation:reservation-1");
    expect(held.resources.released).not.toContain("lease:lease-1");

    const resumed = await service.resume(SCENARIO_TASK_ID);
    const after = await world.snapshot();
    expect(resumed.stage).toBe("implementing");
    expect(after.resources.retained).toContain("lease:lease-1");
    expect(after.runtime.tasks[0]?.jobs.filter(activeRuntimeJob)).toHaveLength(1);
    expect(after.trace.filter((event) => event.action === "herdr pane run")).toHaveLength(1);
    await service.shutdown();
  });
});

test("a timed-out worker result blocks the task and preserves its unlanded worktree", async () => {
  await withScenario({}, async (world) => {
    const { service, resultPath } = await seedRunningImplementation(world);
    await persistWorkerResult(resultPath, {
      id: "job-1",
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      role: "implementer",
      status: "failed",
      text: "Partial implementation notes captured before the deadline.",
      error: "worker timed out after 1500ms",
      finishedAt: SCENARIO_NOW,
    });

    await service.tick();
    await service.tick();

    const snapshot = await world.snapshot();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockReason).toContain("timed out");
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.quarantined).toContain(`task:${SCENARIO_TASK_ID}`);
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
    await service.shutdown();
  });
});

test("an implementer that reports done without a new clean checkpoint blocks with a typed unusable-result cause", async () => {
  await withScenario({}, async (world) => {
    const { service, resultPath } = await seedRunningImplementation(world);
    // The checkout is left exactly where seedRunningImplementation put it (unchanged head, clean),
    // so it still matches the worktree's own base head: nothing was committed.
    await persistWorkerResult(resultPath, {
      id: "job-1",
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      role: "implementer",
      status: "completed",
      text: "Done.",
      finishedAt: SCENARIO_NOW,
    });

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "unusable-result",
      kind: "no-clean-checkpoint",
      jobId: "job-1",
    });
    expect(task.blockReason).toBe(task.blockCause?.summary);
    await service.shutdown();
  });
});

test("a stale worker result is rejected without advancing the task or releasing its worktree", async () => {
  await withScenario({}, async (world) => {
    const { service, resultPath } = await seedRunningImplementation(world);
    await persistWorkerResult(resultPath, {
      id: "job-1",
      taskId: SCENARIO_TASK_ID,
      generation: 7,
      role: "implementer",
      status: "completed",
      text: "A result written by a superseded generation.",
      finishedAt: SCENARIO_NOW,
    });
    world.patchCheckout(world.repoPath, { head: SCENARIO_NEXT_HEAD });

    await service.tick();

    const snapshot = await world.snapshot();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.generation).toBe(0);
    expect(snapshot.runtime.tasks[0]?.lastError ?? task.blockReason).toContain(
      "worker result rejected",
    );
    expect(snapshot.resources.failed).toContain("job:job-1");
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.released).toContain("reservation:reservation-1");
    await service.shutdown();
  });
});
