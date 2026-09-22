import { expect, test } from "bun:test";
import { join } from "node:path";
import { RESTART_QUESTION_ID_PREFIX } from "../../src/recovery/central.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type { DurableJob } from "../../src/runtime/schema.ts";
import { createTandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_NEXT_HEAD,
  SCENARIO_NOW,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

/** The scenario clock is frozen at SCENARIO_NOW; a job that "ran" beyond the startup grace period
 *  before it died needs its own later consumedAt so the same-failure-class guard reads it as such. */
const RAN_FOR_THIRTY_SECONDS = new Date(Date.parse(SCENARIO_NOW) + 30_000).toISOString();

/**
 * The exact durable job a dead worker leaves behind once the disappearance of its pane has already
 * been reconciled: a terminal, settled job with no owned endpoint. This is the state central
 * recovery's implementing-stage re-entry is meant to pick up from (controller.ts's "task is
 * implementing but its worker endpoint is missing" dead end before this slice).
 */
function deadJob(world: ScenarioWorld, cwd: string, id: string): DurableJob {
  const directory = join(world.home, "jobs", SCENARIO_TASK_ID, "0", id);
  return {
    schemaVersion: 1,
    id,
    taskId: SCENARIO_TASK_ID,
    generation: 0,
    role: "implementer",
    kind: "worker",
    cwd,
    jobPath: join(directory, "job.json"),
    resultPath: join(directory, "result.json"),
    attempt: 1,
    phase: "failed",
    launchAttempted: true,
    createdAt: SCENARIO_NOW,
    consumedAt: RAN_FOR_THIRTY_SECONDS,
    error: "worker aborted without a logged reason",
  };
}

/** Finds the job central recovery's real relaunch just created (any job that is not the dead one). */
async function activeJobAfterRelaunch(
  world: ScenarioWorld,
  deadJobId: string,
): Promise<DurableJob> {
  const state = await readRuntimeState(runtimeFile(world.home));
  const runtime = state.tasks.find((entry) => entry.taskId === SCENARIO_TASK_ID);
  const job = runtime?.jobs.find((entry) => entry.id !== deadJobId && activeRuntimeJob(entry));
  if (job === undefined) throw new Error("central recovery did not launch a replacement job");
  return job;
}

/**
 * Represents what an already-reconciled dead worker looks like for the NEXT restart: its pane is
 * gone, its own job is terminal, and the task is back at `implementing` with no owned endpoint.
 * Reconciling a genuinely dead pane and returning a blocked task to its working stage are both
 * existing, separately-tested mechanisms; this only advances the clock on them so the same
 * dead-worker shape recurs without re-deriving that machinery inside this eval.
 */
async function reduceToStuckImplementing(world: ScenarioWorld, liveJobId: string): Promise<void> {
  const current = await world.store.read(SCENARIO_TASK_ID);
  if (current === undefined) throw new Error("scenario task is missing");
  await world.store.update(current.id, current.revision, (entry) => ({
    ...entry,
    revision: entry.revision + 1,
    updatedAt: SCENARIO_NOW,
    stage: "implementing",
    endpoints: [],
  }));
  const state = await readRuntimeState(runtimeFile(world.home));
  await writeRuntimeState(runtimeFile(world.home), {
    ...state,
    tasks: state.tasks.map((entry) =>
      entry.taskId !== SCENARIO_TASK_ID
        ? entry
        : {
            ...entry,
            endpoints: [],
            jobs: entry.jobs.map((job) =>
              job.id === liveJobId
                ? {
                    ...job,
                    phase: "failed" as const,
                    consumedAt: RAN_FOR_THIRTY_SECONDS,
                    error: "worker aborted without a logged reason",
                  }
                : job,
            ),
            // Settling a job's outcome also settles the operation and reservation that admitted
            // it, exactly as consumeJob/failJob do for a real result; central recovery's own
            // "no active job or reservation" guard depends on that being true.
            ...(entry.operation === undefined
              ? {}
              : { operation: { ...entry.operation, phase: "failed" as const } }),
            ...(entry.reservation === undefined
              ? {}
              : {
                  reservation: {
                    ...entry.reservation,
                    phase: "released" as const,
                    releasedAt: SCENARIO_NOW,
                  },
                }),
          },
    ),
  });
}

test("central recovery restarts a dead implementer twice, then asks a bounded question on the third", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const job1 = deadJob(world, lease.path, "job-1");
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "implementing",
      worktree: lease,
      endpoints: [],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [], jobs: [job1] }),
    );

    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
      workerTimeoutMs: 1_500,
    });

    // --- Restart 1 of 2: a real pane and a real durable job are launched. ---
    await service.tick();
    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("implementing");
    expect(task.notifications.some((entry) => entry.message.includes("Restart 1 of 2"))).toBe(true);
    let snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.recovery?.restarts).toBe(1);
    expect(snapshot.runtime.tasks[0]?.recovery?.restartGeneration).toBe(0);
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    const job2 = await activeJobAfterRelaunch(world, job1.id);
    expect(job2.id).not.toBe(job1.id);
    expect(job2.endpoint).toBeDefined();

    // --- The second worker aborts too, "later"; reconciliation already cleared its pane. ---
    await reduceToStuckImplementing(world, job2.id);

    // --- Restart 2 of 2: central recovery relaunches again, still inside budget. ---
    await service.tick();
    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("implementing");
    expect(task.notifications.some((entry) => entry.message.includes("Restart 2 of 2"))).toBe(true);
    snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.recovery?.restarts).toBe(2);
    const job3 = await activeJobAfterRelaunch(world, job2.id);
    expect(job3.id).not.toBe(job2.id);
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);

    // --- The third abort exhausts the automatic restart budget; central recovery asks instead. ---
    await reduceToStuckImplementing(world, job3.id);
    await service.tick();
    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);
    expect(task.communication?.revision ?? 0).toBe(0);
    snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.recovery?.restarts).toBe(2);
    // Asking never discards work: the worktree lease is still retained, never released.
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    expect(snapshot.resources.released).not.toContain(`worktree:${lease.leaseId}`);
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);

    await service.shutdown();
  });
}, 20_000);

test("central recovery notes a moved source repository HEAD on re-entry without refusing", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const job1 = deadJob(world, lease.path, "job-1");
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "implementing",
      worktree: lease,
      endpoints: [],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [], jobs: [job1] }),
    );
    // The source repository moved on since this task's worktree was pinned.
    world.patchCheckout(world.repoPath, { head: SCENARIO_NEXT_HEAD });

    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
      workerTimeoutMs: 1_500,
    });

    await service.tick();
    const task = await service.get(SCENARIO_TASK_ID);
    // Re-entry never refuses on the drift: the worker still relaunches.
    expect(task.stage).toBe("implementing");
    const notice = task.notifications.find((entry) => entry.message.includes("Restart 1 of 2"));
    expect(notice?.message).toContain("source repository has moved");
    // No hashes/IDs leak into the plain-English notice; those live only in the durable effect.
    expect(notice?.message).not.toContain(SCENARIO_NEXT_HEAD);

    const state = await readRuntimeState(runtimeFile(world.home));
    const operation = state.tasks[0]?.operation;
    const driftEffect = operation?.effects.find((effect) => effect.id.startsWith("source-drift:"));
    expect(driftEffect).toBeDefined();
    expect(driftEffect?.receipt).toContain(SCENARIO_NEXT_HEAD);

    await service.shutdown();
  });
}, 20_000);
