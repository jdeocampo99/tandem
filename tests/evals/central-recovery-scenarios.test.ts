import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../../src/contracts.ts";
import {
  MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
  RESTART_QUESTION_ID_PREFIX,
} from "../../src/recovery/central.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type { DurableJob } from "../../src/runtime/schema.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NEXT_HEAD,
  SCENARIO_NOW,
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioOperation,
  scenarioReservation,
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

/**
 * The `awaiting-fixes` -> `implementing` seam: `WorkerWorkflow.beginFixes` admits the fix round
 * (spending its one review round and bumping generation) before it ever touches a pane. When the
 * pane it expected to reuse turns out to be gone, that admission is not undone or blocked; the task
 * is simply left at `implementing` with nothing owned, which is exactly the shape central recovery's
 * already-wired `implementing` re-entry expects.
 */
test("central recovery relaunches a fixer whose carried-forward pane is already gone, without spending a second code-fix round", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "awaiting-fixes",
      reviewHead: SCENARIO_HEAD,
      reviewRound: 0,
      worktree: lease,
      endpoints: [],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [], jobs: [] }),
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

    // --- Tick 1: begin-fixes admits the fix round; the carried-forward pane is gone, so the task
    // lands at `implementing` unblocked instead of blocked. ---
    await service.tick();
    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("implementing");
    expect(task.reviewRound).toBe(1);
    expect(task.generation).toBe(1);
    let snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.jobs.some(activeRuntimeJob)).toBe(false);
    expect(
      snapshot.runtime.tasks[0]?.reservation === undefined ||
        snapshot.runtime.tasks[0]?.reservation.phase === "released",
    ).toBe(true);

    // --- Tick 2: nothing ever ran this generation, so central recovery's implementing-stage
    // re-entry trivially proves death and relaunches a fresh pane and worker. ---
    await service.tick();
    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("implementing");
    expect(task.reviewRound).toBe(1); // the code-fix round was never spent a second time
    expect(task.notifications.some((entry) => entry.message.includes("Restart 1 of 2"))).toBe(true);
    snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.recovery?.restarts).toBe(1);
    expect(snapshot.runtime.tasks[0]?.recovery?.restartGeneration).toBe(1);
    const job = snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob);
    if (job === undefined) throw new Error("central recovery did not launch the fixer");
    expect(job.endpoint).toBeDefined();
    const jobSpec = JSON.parse(await readFile(job.jobPath, "utf8")) as { prompt: string };
    // The relaunch's own admission never overwrote the fix round's persisted context path, so the
    // fresh worker is still told to read the same findings.
    expect(jobSpec.prompt).toContain("bounded fix round");

    await service.shutdown();
  });
}, 20_000);

test("central recovery asks once a fix round's restart budget is exhausted, still without spending a second code-fix round", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "awaiting-fixes",
      reviewHead: SCENARIO_HEAD,
      reviewRound: 0,
      worktree: lease,
      endpoints: [],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [], jobs: [] }),
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

    // Tick 1: begin-fixes admits the fix round; the pane is gone.
    await service.tick();

    // Tick 2: restart 1 of 2.
    await service.tick();
    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.reviewRound).toBe(1);
    let snapshot = await world.snapshot();
    let job = snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob);
    if (job === undefined) throw new Error("expected a job after restart 1");

    // That relaunched worker dies too; reconciliation already cleared its pane.
    await reduceToStuckImplementing(world, job.id);

    // Tick 3: restart 2 of 2, still the same generation and still one spent review round.
    await service.tick();
    task = await service.get(SCENARIO_TASK_ID);
    expect(task.reviewRound).toBe(1);
    expect(task.notifications.some((entry) => entry.message.includes("Restart 2 of 2"))).toBe(true);
    snapshot = await world.snapshot();
    job = snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob);
    if (job === undefined) throw new Error("expected a job after restart 2");

    // Dies a third time; the automatic restart budget for this generation is exhausted.
    await reduceToStuckImplementing(world, job.id);
    await service.tick();
    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.reviewRound).toBe(1);
    expect(task.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);
    snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.recovery?.restarts).toBe(
      MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
    );
    // Asking never discards work: the worktree lease is still retained, never released.
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    expect(snapshot.resources.released).not.toContain(`worktree:${lease.leaseId}`);

    await service.shutdown();
  });
}, 20_000);

test("central recovery relaunches a fixer that dies mid-fix, keeping the same findings and never spending a second code-fix round", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
    };
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "awaiting-fixes",
      reviewHead: SCENARIO_HEAD,
      reviewRound: 0,
      worktree: lease,
      endpoints: [endpoint],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [endpoint], jobs: [] }),
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

    // --- Tick 1: begin-fixes reuses the still-owned pane and launches the fixer for real. ---
    await service.tick();
    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("implementing");
    expect(task.reviewRound).toBe(1);
    let snapshot = await world.snapshot();
    const fixerJob = snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob);
    if (fixerJob === undefined) throw new Error("expected the fixer to launch");
    const fixerJobSpec = JSON.parse(await readFile(fixerJob.jobPath, "utf8")) as { prompt: string };
    expect(fixerJobSpec.prompt).toContain("bounded fix round");

    // --- The fixer dies mid-fix; reconciliation already cleared its pane. ---
    await reduceToStuckImplementing(world, fixerJob.id);

    // --- Tick 2: this is exactly the already-wired `implementing`-stage re-entry (no awaiting-fixes
    // -specific code runs here at all), and it relaunches the fixer with the same findings. ---
    await service.tick();
    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("implementing");
    expect(task.reviewRound).toBe(1); // never spent a second code-fix round
    expect(task.notifications.some((entry) => entry.message.includes("Restart 1 of 2"))).toBe(true);
    snapshot = await world.snapshot();
    const relaunchedJob = snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob);
    if (relaunchedJob === undefined) throw new Error("central recovery did not relaunch the fixer");
    expect(relaunchedJob.id).not.toBe(fixerJob.id);
    const relaunchedSpec = JSON.parse(await readFile(relaunchedJob.jobPath, "utf8")) as {
      prompt: string;
    };
    expect(relaunchedSpec.prompt).toContain("bounded fix round");

    await service.shutdown();
  });
}, 20_000);

/**
 * Reproduces the incident this slice closes two gaps for: an implementer commits cleanly and then
 * its worker dies before reporting a result; the continuation attempt into the same pane is left
 * quarantined; the task ends up `blocked` with a legacy free-text reason (no typed `BlockCause`,
 * exactly what a block recorded before the typed-cause migration looks like). Central recovery must
 * reach this task without anyone asking (gap 1), and once it proves the worker dead it must adopt the
 * commit already sitting in the worktree instead of paying for a worker to redo it (gap 2). The
 * incident's worktree was actually left detached, not on the task branch; that specific shape (branch
 * creation, fast-forward, and refusing a diverged branch) is exercised at the unit level in
 * tests/recovery/central-recover-blocked.test.ts, since the branch-repair git sequencing it needs is
 * finer-grained than this scenario's shared git fake models. This eval covers the on-branch case
 * end to end through a real `service.tick()`.
 */
test("a scheduler tick recovers a blocked quarantine-and-stale-instruction incident by adopting the worker's finished commit", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    // The worker committed on the task branch before OMP aborted: a clean worktree at a new commit
    // strictly ahead of the task's base.
    const adoptedHead = "7862bd03abcdef7862bd03abcdef7862bd03ab";
    world.patchCheckout(lease.path, { head: adoptedHead, dirty: false, unmerged: false });

    const staleReason =
      "stale worker instruction: worker result omitted canonical instruction revision";
    const job1 = deadJob(world, lease.path, "job-1");
    const staleJob: DurableJob = { ...job1, error: staleReason };
    const operation = scenarioOperation(staleJob, { phase: "quarantined" });

    const seeded = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "blocked",
      previousStage: "implementing",
      worktree: lease,
      endpoints: [],
    });
    // A legacy block: free text only, no typed `blockCause` (exactly what predates the typed-cause
    // migration looks like durably).
    await world.store.update(seeded.id, seeded.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: SCENARIO_NOW,
      blockReason: staleReason,
    }));
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [], jobs: [staleJob], operation }),
    );

    // The scenario's own git fake approximates `merge-base --is-ancestor` by reference equality; it
    // has no real commit graph to check a genuinely new commit's ancestry against. Only the exact
    // base/adopted pair this scenario constructs is special-cased; every other command still goes
    // through the scenario's own fake untouched.
    const run: CommandRunner = async (request) => {
      const argv = request.argv;
      if (
        argv[0] === "git" &&
        argv.includes("merge-base") &&
        argv.includes("--is-ancestor") &&
        argv.at(-2) === SCENARIO_HEAD &&
        argv.at(-1) === adoptedHead
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return world.run(request);
    };

    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run,
      clock: world.clock,
      idFactory: world.idFactory,
      workerTimeoutMs: 1_500,
    });

    // One scheduler tick, no user action: proves the worker dead, settles the quarantine, and adopts
    // the already-finished commit instead of relaunching a worker.
    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("validating");
    expect(task.reviewHead).toBe(adoptedHead);
    expect(task.blockReason).toBeUndefined();
    expect(
      task.notifications.some((entry) =>
        entry.message.includes("sending that commit to checks and review instead of redoing it"),
      ),
    ).toBe(true);

    const snapshot = await world.snapshot();
    // The quarantined operation is settled once death is proven, exactly like any other re-entry.
    expect(snapshot.runtime.tasks[0]?.operation?.phase).toBe("failed");
    // No worker was relaunched: the incident's own commit was reused, not redone.
    expect(snapshot.runtime.tasks[0]?.jobs.some(activeRuntimeJob)).toBe(false);
    // The worktree and its branch are preserved throughout, never released or recreated.
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    expect(snapshot.resources.released).not.toContain(`worktree:${lease.leaseId}`);

    await service.shutdown();
  });
}, 20_000);

/**
 * TAG-1036's shape: a launch was left uncertain, recovery later settled it as a known failure, and
 * the task sits blocked with its pane gone. The coordinator's restart must relaunch in the same
 * task, never leave it idle or push toward a new task.
 */
test("restarting a blocked task whose uncertain launch has settled relaunches it in the same task", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const job1 = deadJob(world, lease.path, "job-1");
    const seeded = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "blocked",
      previousStage: "implementing",
      worktree: lease,
      endpoints: [],
    });
    await world.store.update(seeded.id, seeded.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: SCENARIO_NOW,
      blockReason: "Tandem couldn't confirm the last launch, so it paused the task.",
      blockCause: {
        group: "safety-stop",
        kind: "quarantined-unknown-outcome",
        summary: "Tandem couldn't confirm the last launch, so it paused the task.",
        detail: "worker launch could not be proven",
        jobId: job1.id,
      },
    }));
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        endpoints: [],
        jobs: [job1],
        // Once uncertain, now settled: the operation failed and its reservation was released.
        operation: scenarioOperation(job1, { phase: "failed" }),
        reservation: scenarioReservation({ phase: "released", releasedAt: SCENARIO_NOW }),
      }),
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

    const restarted = await service.restart(SCENARIO_TASK_ID);

    expect(restarted.id).toBe(SCENARIO_TASK_ID);
    expect(restarted.stage).toBe("implementing");
    const replacement = await activeJobAfterRelaunch(world, job1.id);
    expect(replacement.endpoint).toBeDefined();
    expect((await service.list()).map((task) => task.id)).toEqual([SCENARIO_TASK_ID]);
    const snapshot = await world.snapshot();
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    await service.shutdown();
  });
}, 20_000);

/**
 * The same incident one step earlier: the launch is still quarantined and holds its reservation,
 * and its pane is gone. Restart proves nothing Tandem owns is running, which answers the
 * uncertainty, so it relaunches instead of pausing on "I can't tell what the last attempt did".
 */
test("restarting a blocked task with a still-quarantined launch relaunches once its panes are proven stopped", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const job1 = deadJob(world, lease.path, "job-1");
    const seeded = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "blocked",
      previousStage: "implementing",
      worktree: lease,
      endpoints: [],
    });
    await world.store.update(seeded.id, seeded.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: SCENARIO_NOW,
      blockReason: "Tandem couldn't confirm the worker started.",
      blockCause: {
        group: "safety-stop",
        kind: "quarantined-unknown-outcome",
        summary: "Tandem couldn't confirm the worker started.",
        detail: "worker launch could not be proven after launch intent",
        jobId: job1.id,
      },
    }));
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        endpoints: [],
        jobs: [job1],
        operation: scenarioOperation(job1, { phase: "quarantined" }),
        reservation: scenarioReservation(),
      }),
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

    const restarted = await service.restart(SCENARIO_TASK_ID);

    expect(restarted.stage).toBe("implementing");
    const replacement = await activeJobAfterRelaunch(world, job1.id);
    expect(replacement.endpoint).toBeDefined();
    const runtime = (await world.snapshot()).runtime.tasks[0];
    expect(runtime?.routingPause).toBeUndefined();
    expect(runtime?.operationHistory?.find((entry) => entry.id === "operation-1")?.phase).toBe(
      "failed",
    );
    await service.shutdown();
  });
}, 20_000);

test("a refused relaunch says why in plain English instead of a generic refusal", async () => {
  const cases = [
    {
      name: "worker limit",
      expected: `The worker limit (${SCENARIO_POLICY.config.maxWorkers}) is reached.`,
    },
    {
      name: "routing question",
      expected: "A routing question is waiting: That model isn't listed right now.",
    },
  ] as const;
  for (const entry of cases) {
    await withScenario({}, async (world) => {
      const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
      const job1 = deadJob(world, lease.path, "job-1");
      await seedScenarioTask(world, {
        kind: "implementation",
        stage: "implementing",
        worktree: lease,
        endpoints: [],
      });
      const task = scenarioRuntimeTask({
        worktree: lease,
        endpoints: [],
        jobs: [job1],
        ...(entry.name === "routing question"
          ? {
              routingPause: {
                schemaVersion: 1 as const,
                decisionId: "routing-absent",
                reason: "pinned-model-absent-from-catalogue" as const,
                taskId: SCENARIO_TASK_ID,
                jobId: job1.id,
                operationId: "operation-0",
                role: "implementer" as const,
                generation: 0,
                attempt: 1,
                policyDigest: policyIdentity(SCENARIO_POLICY),
                inputHead: SCENARIO_HEAD,
                pinnedSelector: SCENARIO_POLICY.config.models.implementer.model,
                pinnedThinking: SCENARIO_POLICY.config.models.implementer.thinking,
                evidenceGaps: [],
                enabledProviders: [],
                usageSource: "no-governing-request" as const,
                limits: { maxWorkers: SCENARIO_POLICY.config.maxWorkers },
                observedAt: SCENARIO_NOW,
              },
            }
          : {}),
      });
      // Other work already holds every worker slot.
      const others = Array.from({ length: SCENARIO_POLICY.config.maxWorkers }, (_, index) =>
        scenarioRuntimeTask({
          taskId: `other-${index}`,
          reservation: scenarioReservation({
            id: `other-reservation-${index}`,
            taskId: `other-${index}`,
          }),
        }),
      );
      await writeRuntimeState(runtimeFile(world.home), {
        schemaVersion: 1,
        tasks: entry.name === "worker limit" ? [task, ...others] : [task],
        presentations: [],
      });
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

      const blocked = await service.get(SCENARIO_TASK_ID);
      expect(blocked.stage, entry.name).toBe("blocked");
      expect(blocked.blockReason, entry.name).toBe(entry.expected);
      expect(blocked.notifications.at(-1)?.message, entry.name).toContain(entry.expected);
      await service.shutdown();
    });
  }
}, 20_000);
