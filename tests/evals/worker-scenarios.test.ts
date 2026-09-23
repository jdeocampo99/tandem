import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResolvedPolicy, WorktreeLease } from "../../src/contracts.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NEXT_HEAD,
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

/** A policy with one real validation command, so `startValidation` gets past config planning. */
const VALIDATING_POLICY: ResolvedPolicy = {
  ...SCENARIO_POLICY,
  config: {
    ...SCENARIO_POLICY.config,
    validationCommands: [{ name: "smoke", argv: ["true"], surfaces: ["*"], timeoutMs: 5_000 }],
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
  });
}

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

test("a pane still busy with the previous worker defers the launch and retries once it frees", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    const job = scenarioJob({
      home: world.home,
      role: "implementer",
      cwd: lease.path,
      endpoint,
      phase: "reserved",
    });
    const previous = { ...job, id: "job-0", phase: "consumed" as const, launchAttempted: true };
    await mkdir(dirname(job.jobPath), { recursive: true });
    await writeFile(
      job.jobPath,
      JSON.stringify({ id: job.id, taskId: job.taskId, generation: job.generation, execution: {} }),
    );
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
        jobs: [previous, job],
        operation: scenarioOperation(job, {
          phase: "admitted",
          policyDigest: policyIdentity(SCENARIO_POLICY),
        }),
        reservation: scenarioReservation(),
      }),
    );
    // The previous worker woke after submitting and still holds the pane's foreground.
    world.replaceForeground("pane-1", ["omp"]);
    const service = serviceFor(world);

    await service.tick();
    const deferred = await world.snapshot();
    const runtime = deferred.runtime.tasks[0];
    expect((await service.get(SCENARIO_TASK_ID)).stage).toBe("implementing");
    expect(runtime?.operation?.phase).toBe("admitted");
    expect(runtime?.operation?.effects).toEqual([]);
    expect(runtime?.jobs.find((entry) => entry.id === job.id)).toMatchObject({
      phase: "reserved",
      launchAttempted: false,
    });
    expect(deferred.trace.filter((event) => event.action === "herdr pane run")).toHaveLength(0);

    world.replaceForeground("pane-1", ["sh"]);
    await service.tick();
    const launched = await world.snapshot();
    expect((await service.get(SCENARIO_TASK_ID)).stage).toBe("implementing");
    expect(launched.runtime.tasks[0]?.operation?.phase).toBe("running");
    expect(launched.trace.filter((event) => event.action === "herdr pane run")).toHaveLength(1);
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

    // One tick fully consumes the written result and blocks the task; a second tick is no longer a
    // no-op once blocked (central recovery's own blocked-task re-entry would pick a `worker-failed`
    // cause like this one back up automatically, exactly as tests/evals/central-recovery-scenarios.
    // test.ts covers), so this asserts the block itself right where it lands.
    await service.tick();

    const snapshot = await world.snapshot();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause?.detail).toContain("timed out");
    expect(task.blockCause).toMatchObject({
      group: "unusable-result",
      kind: "worker-failed",
      jobId: "job-1",
    });
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
    expect(snapshot.runtime.tasks[0]?.lastError ?? task.blockCause?.detail).toContain(
      "worker result rejected",
    );
    expect(snapshot.resources.failed).toContain("job:job-1");
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.released).toContain("reservation:reservation-1");
    await service.shutdown();
  });
});

test("an implementer result that cannot be applied to a diverged task blocks with a lost-resource cause", async () => {
  await withScenario({}, async (world) => {
    const { service, lease, resultPath } = await seedRunningImplementation(world);
    const seeded = await world.store.read(SCENARIO_TASK_ID);
    if (seeded === undefined) throw new Error("scenario task missing");
    await world.store.update(seeded.id, seeded.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: world.clock(),
      stage: "validating",
    }));
    world.patchCheckout(lease.path, { head: SCENARIO_NEXT_HEAD });
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
      group: "lost-resource",
      kind: "persistence-failed",
      jobId: "job-1",
    });
    expect(task.blockCause?.detail).toContain("durable result could not be applied");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("a scout whose checkout cannot be verified blocks with a lost-resource cause", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
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
      text: "Findings.",
      finishedAt: SCENARIO_NOW,
    });
    world.failAt({ boundary: "git", action: "git rev-parse HEAD", times: 1 });
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "lost-resource",
      kind: "checkout-unverifiable",
      jobId: "job-1",
    });
    expect(task.blockCause?.detail).toContain("scout checkout could not be verified");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("a reviewer result launched against a stale instruction blocks with an unusable-result cause", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "reviewer" as const,
    };
    const job = {
      ...scenarioJob({ home: world.home, role: "reviewer", cwd: lease.path, endpoint }),
      instructionRevision: 5,
      reviewLens: "behavior" as const,
      head: SCENARIO_HEAD,
    };
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "reviewing",
      worktree: lease,
      endpoints: [endpoint],
      reviewHead: SCENARIO_HEAD,
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
      role: "reviewer",
      status: "completed",
      text: "Looks fine.",
      finishedAt: SCENARIO_NOW,
      review: {
        lens: "behavior",
        head: SCENARIO_HEAD,
        generation: job.generation,
        pass: true,
        findings: [],
        summary: "Looks fine.",
      },
    });
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "unusable-result",
      kind: "stale-review-state",
      jobId: "job-1",
    });
    expect(task.blockCause?.detail).toBe(
      "review result was launched for an older instruction revision",
    );
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("validation with no configured commands refuses with a user-decision cause", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "validating",
      worktree: lease,
      reviewHead: SCENARIO_HEAD,
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask({ worktree: lease }));
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "user-decision",
      kind: "validation-config-refused",
    });
    expect(task.blockCause?.detail).toContain("validation refused");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("validation without a reviewed HEAD refuses with a user-decision cause", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "validating",
      worktree: lease,
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask({ worktree: lease }));
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "user-decision",
      kind: "prerequisite-not-met",
    });
    expect(task.blockCause?.detail).toBe("validation requires a task worktree and reviewed HEAD");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("validation whose runtime lost its worktree blocks with a lost-resource cause", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "validating",
      worktree: lease,
      reviewHead: SCENARIO_HEAD,
      policy: VALIDATING_POLICY,
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask());
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "lost-resource",
      kind: "resource-lost",
    });
    expect(task.blockCause?.detail).toBe("validation runtime lost its worktree");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("a reviewing task whose pane ownership cannot be proven blocks with a safety-stop cause", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "reviewer" as const,
    };
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "reviewing",
      worktree: lease,
      endpoints: [endpoint],
      reviewHead: SCENARIO_HEAD,
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [endpoint] }),
    );
    world.failAt({ boundary: "herdr", action: "herdr pane process-info", times: 1 });
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "safety-stop",
      kind: "ownership-unprovable",
      paneId: "pane-1",
    });
    expect(task.blockCause?.detail).toContain("ownership could not be proven");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("a reviewing task with an unresolved failed lens blocks with an unusable-result cause", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "reviewer" as const,
    };
    const failedJob = {
      ...scenarioJob({ home: world.home, role: "reviewer", cwd: lease.path, endpoint }),
      phase: "failed" as const,
      reviewLens: "behavior" as const,
      head: SCENARIO_HEAD,
      error: "the review worker reported a genuine content failure",
    };
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "reviewing",
      worktree: lease,
      endpoints: [endpoint],
      reviewHead: SCENARIO_HEAD,
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [endpoint], jobs: [failedJob] }),
    );
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "unusable-result",
      kind: "review-lens-failed",
    });
    expect(task.blockCause?.detail).toBe("the review worker reported a genuine content failure");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("a queued task whose worktree allocation fails blocks with a lost-resource cause", async () => {
  await withScenario({}, async (world) => {
    await seedScenarioTask(world, { kind: "implementation", stage: "queued" });
    await seedScenarioRuntime(world, scenarioRuntimeTask());
    world.failAt({ boundary: "treehouse", action: "treehouse get", times: 1 });
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "lost-resource",
      kind: "allocation-failed",
    });
    expect(task.blockCause?.detail).toContain("worktree allocation failed");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("a queued task whose scope approval is missing at launch blocks with a lost-resource cause", async () => {
  await withScenario({}, async (world) => {
    const seeded = await seedScenarioTask(world, { kind: "implementation", stage: "queued" });
    await seedScenarioRuntime(world, scenarioRuntimeTask());
    await world.store.update(seeded.id, seeded.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: world.clock(),
      scopeApproved: false,
    }));
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "lost-resource",
      kind: "transition-failed",
    });
    expect(task.blockCause?.detail).toContain("task start transition failed");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("a worker job with no durable endpoint identity is quarantined with a safety-stop cause", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const seededEndpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    const { endpoint: _endpoint, ...jobWithoutEndpoint } = scenarioJob({
      home: world.home,
      role: "implementer",
      cwd: lease.path,
      endpoint: seededEndpoint,
    });
    const job = { ...jobWithoutEndpoint, createdAt: "2029-12-31T23:59:00.000Z" };
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "implementing",
      worktree: lease,
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        jobs: [job],
        operation: scenarioOperation(job),
        reservation: scenarioReservation(),
      }),
    );
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.blockCause).toMatchObject({
      group: "safety-stop",
      kind: "quarantined-unknown-outcome",
      jobId: "job-1",
    });
    expect(task.blockCause?.detail).toBe("worker job has no durable endpoint identity");
    expect(task.blockCause?.summary).toBe(task.blockReason);
    await service.shutdown();
  });
});

test("an uncertain-outcome routing pause stops blocking once that attempt settles as a failure", async () => {
  for (const settled of [false, true]) {
    await withScenario({}, async (world) => {
      await seedScenarioTask(world, { kind: "implementation", stage: "queued" });
      const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
      const endpoint = {
        ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
        role: "implementer" as const,
      };
      const prior = scenarioJob({
        home: world.home,
        role: "implementer",
        cwd: lease.path,
        endpoint,
        phase: "failed",
      });
      const policyDigest = policyIdentity(SCENARIO_POLICY);
      await seedScenarioRuntime(
        world,
        scenarioRuntimeTask({
          jobs: [prior],
          operation: scenarioOperation(prior, {
            phase: settled ? "failed" : "quarantined",
            policyDigest,
          }),
          routingPause: {
            schemaVersion: 1,
            decisionId: "routing-uncertain",
            reason: "prior-outcome-uncertain",
            taskId: SCENARIO_TASK_ID,
            jobId: prior.id,
            operationId: "operation-1",
            role: "implementer",
            generation: 0,
            attempt: 2,
            policyDigest,
            inputHead: SCENARIO_HEAD,
            pinnedSelector: SCENARIO_POLICY.config.models.implementer.model,
            pinnedThinking: SCENARIO_POLICY.config.models.implementer.thinking,
            evidenceGaps: [],
            enabledProviders: [],
            usageSource: "no-governing-request",
            limits: { maxWorkers: SCENARIO_POLICY.config.maxWorkers },
            observedAt: SCENARIO_NOW,
          },
        }),
      );
      const service = serviceFor(world);

      await service.tick();

      const runtime = (await world.snapshot()).runtime.tasks[0];
      expect(runtime?.routingPause === undefined).toBe(settled);
      expect(runtime?.jobs.some(activeRuntimeJob)).toBe(settled);
      await service.shutdown();
    });
  }
});

test("a saved pause with a reason routing no longer raises doesn't block; the pinned model relaunches", async () => {
  await withScenario({}, async (world) => {
    await seedScenarioTask(world, { kind: "implementation", stage: "queued" });
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    const prior = scenarioJob({
      home: world.home,
      role: "implementer",
      cwd: lease.path,
      endpoint,
      phase: "failed",
    });
    const policyDigest = policyIdentity(SCENARIO_POLICY);
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        jobs: [prior],
        operation: scenarioOperation(prior, { phase: "failed", policyDigest }),
        // Saved by an older Tandem that asked instead of keeping the pinned model.
        routingPause: {
          schemaVersion: 1,
          decisionId: "routing-unmeasured",
          reason: "usage-evidence-unmeasured",
          taskId: SCENARIO_TASK_ID,
          jobId: prior.id,
          operationId: "operation-1",
          role: "implementer",
          generation: 0,
          attempt: 2,
          policyDigest,
          inputHead: SCENARIO_HEAD,
          pinnedSelector: SCENARIO_POLICY.config.models.implementer.model,
          pinnedThinking: SCENARIO_POLICY.config.models.implementer.thinking,
          evidenceGaps: [],
          enabledProviders: [],
          usageSource: "no-governing-request",
          limits: { maxWorkers: SCENARIO_POLICY.config.maxWorkers },
          observedAt: SCENARIO_NOW,
        },
      }),
    );
    const service = serviceFor(world);

    await service.tick();

    const runtime = (await world.snapshot()).runtime.tasks[0];
    expect(runtime?.routingPause).toBeUndefined();
    expect(runtime?.jobs.some(activeRuntimeJob)).toBe(true);
    await service.shutdown();
  });
});

test("steering a task whose review launch was quarantined settles that launch instead of leaving it uncertain", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const implementer = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    const reviewer = {
      ...world.openPane({ paneId: "pane-2", cwd: lease.path }),
      role: "reviewer" as const,
    };
    const prior = scenarioJob({
      home: world.home,
      role: "reviewer",
      cwd: lease.path,
      endpoint: reviewer,
      phase: "failed",
    });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "reviewing",
      reviewHead: SCENARIO_HEAD,
      worktree: lease,
      endpoints: [implementer, reviewer],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        endpoints: [implementer, reviewer],
        jobs: [prior],
        operation: scenarioOperation(prior, { phase: "quarantined" }),
        reservation: scenarioReservation(),
      }),
    );
    const service = serviceFor(world);

    await service.steer({ taskId: SCENARIO_TASK_ID, text: "Keep the current scope." });

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.generation).toBe(1);
    const runtime = (await world.snapshot()).runtime.tasks[0];
    // Every owned pane was proven stopped before the redirect, which answers the uncertainty.
    const settled = [...(runtime?.operationHistory ?? []), runtime?.operation].find(
      (operation) => operation?.id === "operation-1",
    );
    expect(settled?.phase).toBe("failed");
    await service.shutdown();
  });
});

test("a failed attempt with no governing request relaunches on the pinned model even when a cheaper model is listed", async () => {
  const pinned = SCENARIO_POLICY.config.models.implementer.model;
  const listed = (selector: string, cost: number) => ({
    selector,
    id: selector,
    provider: "scenario",
    thinking: ["low"],
    cost: { input: cost, output: cost },
  });
  const ompModels = [
    ...Object.values(SCENARIO_POLICY.config.models).map((spec) => listed(spec.model, 2)),
    listed("scenario/cheaper", 1),
  ];
  await withScenario({ ompModels }, async (world) => {
    const service = serviceFor(world);
    await service.configureModels({
      repoPath: world.repoPath,
      models: SCENARIO_POLICY.config.models,
      enabledProviders: ["scenario"],
    });
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    const prior = scenarioJob({
      home: world.home,
      role: "implementer",
      cwd: lease.path,
      endpoint,
      phase: "failed",
    });
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
        jobs: [prior],
        operation: scenarioOperation(prior, {
          phase: "failed",
          policyDigest: policyIdentity(SCENARIO_POLICY),
        }),
      }),
    );

    await service.tick();

    const runtime = (await world.snapshot()).runtime.tasks[0];
    expect(runtime?.routingPause).toBeUndefined();
    expect(runtime?.jobs.some(activeRuntimeJob)).toBe(true);
    expect(runtime?.operation?.routing?.basis).toBe("pinned-policy");
    expect(runtime?.operation?.routing?.selector).toBe(pinned);
    await service.shutdown();
  });
});
