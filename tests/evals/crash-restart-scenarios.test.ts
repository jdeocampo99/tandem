import { expect, test } from "bun:test";
import type { Endpoint, ResolvedPolicy, WorktreeLease } from "../../src/contracts.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import type { DurableJob } from "../../src/runtime/schema.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NOW,
  SCENARIO_POLICY,
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

/**
 * A terminal-host crash (Herdr restarting) kills every worker: panes come back as fresh shells or
 * not at all. A dead worker is a known outcome, so each is restarted within the restart budget
 * instead of quarantined for a person.
 */

const REVIEW_POLICY: ResolvedPolicy = {
  ...SCENARIO_POLICY,
  config: {
    ...SCENARIO_POLICY.config,
    validationCommands: [{ name: "smoke", argv: ["true"], surfaces: ["*"], timeoutMs: 1_000 }],
  },
};

function serviceFor(world: ScenarioWorld): TandemService {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
    workerTimeoutMs: 1_500,
  });
}

async function seedRunningJob(
  world: ScenarioWorld,
  lease: WorktreeLease,
  job: DurableJob,
  endpoint: Endpoint,
  reviewMode?: "review_existing_head",
): Promise<void> {
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      worktree: lease,
      endpoints: [endpoint],
      jobs: [job],
      operation: scenarioOperation(job),
      reservation: scenarioReservation(),
      ...(reviewMode === undefined ? {} : { reviewMode }),
    }),
  );
}

async function replacementJob(world: ScenarioWorld, deadJobId: string): Promise<DurableJob> {
  const snapshot = await world.snapshot();
  const job = snapshot.runtime.tasks[0]?.jobs.find(
    (entry) => entry.id !== deadJobId && activeRuntimeJob(entry),
  );
  if (job === undefined) throw new Error("no replacement job was launched");
  return job;
}

test("an implementer whose pane came back as a fresh shell after a crash is restarted, not quarantined", async () => {
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
    await seedRunningJob(world, lease, job, endpoint);
    const service = serviceFor(world);

    // The crash: the pane survives with the same id, running a fresh shell, and no result.
    world.replaceForeground("pane-1", ["sh"]);
    world.advanceClock(5);
    await service.tick();

    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.blockCause).toMatchObject({ group: "lost-resource", jobId: job.id });
    let snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.operation?.phase).toBe("failed");

    await service.tick();

    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("implementing");
    expect(task.notifications.some((entry) => entry.message.includes("Restart 1 of 2"))).toBe(true);
    snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.recovery?.restarts).toBe(1);
    expect((await replacementJob(world, job.id)).endpoint).toBeDefined();
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    await service.shutdown();
  });
}, 20_000);

test("a reviewer whose pane vanished in a crash is restarted, not failed as a review", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-review", cwd: lease.path }),
      paneId: "pane-gone",
      role: "reviewer" as const,
    };
    const job: DurableJob = {
      ...scenarioJob({ home: world.home, role: "reviewer", cwd: lease.path, endpoint }),
      reviewLens: "review",
      head: SCENARIO_HEAD,
    };
    const seeded = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "reviewing",
      worktree: lease,
      reviewHead: SCENARIO_HEAD,
      policy: REVIEW_POLICY,
    });
    await world.store.update(SCENARIO_TASK_ID, seeded.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: SCENARIO_NOW,
      validationEvidence: [
        {
          name: "smoke",
          argv: ["true"],
          exitCode: 0,
          stdout: "",
          stderr: "",
          head: SCENARIO_HEAD,
          contract: "final",
          origin: "local",
          policyDigest: policyIdentity(REVIEW_POLICY),
        },
      ],
    }));
    await seedRunningJob(world, lease, job, endpoint, "review_existing_head");
    const service = serviceFor(world);

    // The crash: the reviewer's pane is gone and no result was written.
    world.advanceClock(5);
    await service.tick();

    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.blockCause).toMatchObject({ group: "lost-resource", jobId: job.id });

    await service.tick();

    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("reviewing");
    expect(task.blockCause).toBeUndefined();
    expect(task.notifications.some((entry) => entry.message.includes("Restart 1 of 2"))).toBe(true);
    const replacement = await replacementJob(world, job.id);
    expect(replacement.reviewLens).toBe("review");
    expect(replacement.head).toBe(SCENARIO_HEAD);
    expect((await world.snapshot()).resources.quarantined).toEqual([]);
    await service.shutdown();
  });
}, 20_000);
