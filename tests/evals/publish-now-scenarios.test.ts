import { expect, test } from "bun:test";
import type { FindingLedgerEntry } from "../../src/contracts.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NEXT_HEAD,
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

const OPEN_FINDING: FindingLedgerEntry = {
  id: "f-1",
  lens: "review",
  severity: "P1",
  verdict: "confirmed",
  description: "Retries never stop after cancel.",
  file: "src/retry.ts",
  line: 12,
  status: "unresolved",
  raisedAt: { head: SCENARIO_NEXT_HEAD, generation: 0, reviewRound: 0 },
  statusAt: { head: SCENARIO_NEXT_HEAD, generation: 0, reviewRound: 0 },
};

const SUMMARY = { tldr: ["Adds retries."], what: ["Retry loop."], why: ["Flaky calls."] };

const PUBLISH_INPUT = {
  repository: "acme/repo",
  title: "Add retries",
  base: "main",
  summary: SUMMARY,
};

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

/** A task mid-review: a reviewer is running in its pane and one finding is still open. */
async function seedMidReview(world: ScenarioWorld): Promise<void> {
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  world.patchCheckout(lease.path, { head: SCENARIO_NEXT_HEAD });
  const endpoint = {
    ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
    role: "reviewer" as const,
  };
  world.replaceForeground("pane-1", ["omp", "--mode", "interactive"]);
  const job = {
    ...scenarioJob({ home: world.home, role: "reviewer", cwd: lease.path, endpoint }),
    reviewLens: "review" as const,
    head: SCENARIO_NEXT_HEAD,
  };
  const task = await seedScenarioTask(world, {
    kind: "implementation",
    stage: "reviewing",
    reviewHead: SCENARIO_NEXT_HEAD,
    worktree: lease,
    endpoints: [endpoint],
  });
  await world.store.update(task.id, task.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    findingLedger: [OPEN_FINDING],
  }));
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      worktree: lease,
      endpoints: [endpoint],
      jobs: [job],
      operation: scenarioOperation(job, { kind: "review", inputHead: SCENARIO_NEXT_HEAD }),
      reservation: scenarioReservation(),
    }),
  );
}

test("publish now stops the reviewer, makes the task ready, and lists open findings in the PR", async () => {
  await withScenario({}, async (world) => {
    await seedMidReview(world);
    const service = serviceFor(world);

    // Publication itself needs GitHub, which the scenario does not fake; the task is already ready.
    await expect(
      service.publishNow(SCENARIO_TASK_ID, { ...PUBLISH_INPUT, approved: true }),
    ).rejects.toThrow("delivery preflight refused publication");

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("ready");
    expect(task.reviewHead).toBe(SCENARIO_NEXT_HEAD);
    expect(task.reviewSkippedHead).toBe(SCENARIO_NEXT_HEAD);
    const snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.jobs.some(activeRuntimeJob)).toBe(false);
    expect(snapshot.runtime.tasks[0]?.stopRequest).toBeUndefined();
    expect(snapshot.resources.failed).toContain("job:job-1");
    expect(snapshot.trace.some((event) => event.action === "herdr pane send-keys")).toBe(true);

    const description = await service.describePr(SCENARIO_TASK_ID, SUMMARY);
    expect(description).toContain("Review was skipped");
    expect(description).toContain(
      "# Known open review findings\n- P1: Retries never stop after cancel. (src/retry.ts:12)",
    );
    await service.shutdown();
  });
});

test("without the explicit publish-now action the task stays in review", async () => {
  await withScenario({}, async (world) => {
    await seedMidReview(world);
    const service = serviceFor(world);

    await expect(
      service.publishNow(SCENARIO_TASK_ID, { ...PUBLISH_INPUT, approved: false }),
    ).rejects.toThrow("requires explicit caller approval");
    await expect(
      service.publish(SCENARIO_TASK_ID, { ...PUBLISH_INPUT, approved: true }),
    ).rejects.toThrow();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("reviewing");
    expect(task.reviewSkippedHead).toBeUndefined();
    const snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.jobs.some(activeRuntimeJob)).toBe(true);
    expect(snapshot.trace.some((event) => event.action === "herdr pane send-keys")).toBe(false);
    await service.shutdown();
  });
});

test("publish now refuses a task with nothing committed beyond its base", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "awaiting-fixes",
      reviewHead: SCENARIO_HEAD,
      worktree: lease,
      endpoints: [],
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask({ worktree: lease }));
    const service = serviceFor(world);

    await expect(
      service.publishNow(SCENARIO_TASK_ID, { ...PUBLISH_INPUT, approved: true }),
    ).rejects.toThrow("no clean commit beyond its base");
    expect((await service.get(SCENARIO_TASK_ID)).stage).toBe("awaiting-fixes");
    await service.shutdown();
  });
});
