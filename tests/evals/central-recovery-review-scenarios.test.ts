import { expect, test } from "bun:test";
import { join } from "node:path";
import { interruptEndpoint } from "../../src/adapters/herdr.ts";
import type { Endpoint, ResolvedPolicy, ReviewResult } from "../../src/contracts.ts";
import { RESTART_QUESTION_ID_PREFIX } from "../../src/recovery/central.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import type { DurableJob, RuntimeRecoveryState } from "../../src/runtime/schema.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import {
  workerReceiptPath,
  writeWorkerReceipt,
} from "../../src/tasks/communication-persistence.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NEXT_HEAD,
  SCENARIO_NOW,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

/**
 * A policy with at least one validation command, so the final acceptance manifest this eval drives a
 * review through to completion is well-formed (the shared `SCENARIO_POLICY` deliberately configures
 * none, which is fine for the other evals but would make `finish-review` unreachable here).
 */
const REVIEW_POLICY: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "scenario/coordinator", thinking: "low" },
      scout: { model: "scenario/scout", thinking: "low" },
      implementer: { model: "scenario/implementer", thinking: "low" },
      reviewer: { model: "scenario/reviewer", thinking: "low" },
      presentation: { model: "scenario/presentation", thinking: "low" },
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [{ name: "smoke", argv: ["true"], surfaces: ["*"], timeoutMs: 1_000 }],
    setupCommands: [],
    maxWorkers: 2,
    maxFixRounds: 1,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

/** A job that "ran" beyond the startup grace period before it died, so the same-failure-class guard
 *  never trips on a zero-elapsed fixture. */
const RAN_FOR_THIRTY_SECONDS = new Date(Date.parse(SCENARIO_NOW) + 30_000).toISOString();

/**
 * The exact durable job a dead reviewer/verifier leaves behind once its pane has already been
 * reconciled: a terminal, quarantined job with no owned endpoint. This is the state central
 * recovery's `reviewing` re-entry is meant to pick up from.
 */
function deadReviewJob(
  world: ScenarioWorld,
  cwd: string,
  lens: "behavior" | "design" | "coverage" | "verification",
): DurableJob {
  const id = `${lens}-job`;
  const directory = join(world.home, "jobs", SCENARIO_TASK_ID, "0", id);
  return {
    schemaVersion: 1,
    id,
    taskId: SCENARIO_TASK_ID,
    generation: 0,
    role: lens === "verification" ? "verifier" : "reviewer",
    kind: "worker",
    cwd,
    jobPath: join(directory, "job.json"),
    resultPath: join(directory, "result.json"),
    attempt: 1,
    phase: "failed",
    launchAttempted: true,
    createdAt: SCENARIO_NOW,
    consumedAt: RAN_FOR_THIRTY_SECONDS,
    reviewLens: lens,
    head: SCENARIO_HEAD,
    error: "owned endpoint disappeared before a durable result was written",
  };
}

function completedReview(lens: "behavior" | "design" | "coverage"): ReviewResult {
  return {
    lens,
    head: SCENARIO_HEAD,
    generation: 0,
    pass: true,
    findings: [],
    summary: `${lens} passed`,
    mode: "review_existing_head",
  };
}

async function seedStuckReview(
  world: ScenarioWorld,
  options: Readonly<{ readonly recovery?: RuntimeRecoveryState }> = {},
) {
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  const job = deadReviewJob(world, lease.path, "verification");
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
    reviews: [completedReview("behavior"), completedReview("design"), completedReview("coverage")],
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
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      worktree: lease,
      endpoints: [],
      jobs: [job],
      reviewMode: "review_existing_head",
      operation: {
        schemaVersion: 1,
        id: "operation-dead",
        taskId: SCENARIO_TASK_ID,
        kind: "verification",
        role: "verifier",
        generation: 0,
        inputHead: SCENARIO_HEAD,
        policyDigest: policyIdentity(REVIEW_POLICY),
        instructionRevision: 0,
        jobId: job.id,
        phase: "quarantined",
        fencingRevision: 1,
        claimOwner: "scenario-controller",
        createdAt: SCENARIO_NOW,
        effects: [],
        error: "owned endpoint disappeared before a durable result was written",
      },
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    }),
  );
  return { lease, job };
}

test("central recovery relaunches a dead legacy review lens as the current merged review, which completes the round", async () => {
  await withScenario({}, async (world) => {
    const { lease, job } = await seedStuckReview(world);
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

    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("reviewing");
    expect(task.notifications.some((entry) => entry.message.includes("Restart 1 of 2"))).toBe(true);
    // The three legacy-lens reviews recorded before the merge are untouched, and no longer required.
    expect(task.reviews).toHaveLength(3);
    expect(task.reviews.every((review) => review.lens !== "review")).toBe(true);

    const state = await readRuntimeState(runtimeFile(world.home));
    const runtime = state.tasks.find((entry) => entry.taskId === SCENARIO_TASK_ID);
    expect(runtime?.recovery?.restarts).toBe(1);
    // Recovery clears the dead legacy job and lets the normal launch path relaunch the round; that
    // path now always requests the single merged "review" lens, not the dead job's legacy lens.
    const replacement = runtime?.jobs.find(
      (entry) => entry.id !== job.id && entry.reviewLens === "review",
    );
    if (replacement === undefined)
      throw new Error("central recovery did not relaunch the review round");
    expect(activeRuntimeJob(replacement)).toBe(true);
    expect(replacement.head).toBe(SCENARIO_HEAD);
    expect(replacement.endpoint).toBeDefined();
    const endpoint = replacement.endpoint as Endpoint;

    // The relaunched review now "finishes": its pane goes quiet and a durable, passing result lands.
    await interruptEndpoint(world.run, { endpoint, cwd: lease.path });
    await writeWorkerReceipt(workerReceiptPath(replacement.jobPath), {
      schemaVersion: 1,
      jobId: replacement.id,
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      receivedRevision: replacement.instructionRevision ?? 0,
      appliedRevision: replacement.instructionRevision ?? 0,
      heartbeatAt: SCENARIO_NOW,
      progressAt: SCENARIO_NOW,
      phase: "finished",
    });
    await persistWorkerResult(replacement.resultPath, {
      id: replacement.id,
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      role: "reviewer",
      status: "completed",
      text: "Review passed.",
      instructionRevision: replacement.instructionRevision ?? 0,
      review: {
        lens: "review",
        head: SCENARIO_HEAD,
        generation: 0,
        pass: true,
        findings: [],
        summary: "review passed",
        mode: "review_existing_head",
      },
      finishedAt: SCENARIO_NOW,
    });

    await service.tick();
    await service.tick();

    task = await service.get(SCENARIO_TASK_ID);
    expect(task.reviews).toHaveLength(4);
    expect(task.reviews.some((review) => review.lens === "review")).toBe(true);
    expect(task.stage).not.toBe("reviewing");

    const snapshot = await world.snapshot();
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    await service.shutdown();
  });
}, 20_000);

test("reviewing restart budget exhausted asks instead of relaunching again", async () => {
  await withScenario({}, async (world) => {
    const { lease } = await seedStuckReview(world, {
      recovery: {
        schemaVersion: 1,
        validationRetries: 0,
        restarts: 2,
        restartGeneration: 0,
      },
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

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);
    expect(task.communication?.revision ?? 0).toBe(0);

    const state = await readRuntimeState(runtimeFile(world.home));
    const runtime = state.tasks.find((entry) => entry.taskId === SCENARIO_TASK_ID);
    expect(runtime?.recovery?.restarts).toBe(2);
    const snapshot = await world.snapshot();
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    expect(snapshot.resources.released).not.toContain(`worktree:${lease.leaseId}`);
    await service.shutdown();
  });
}, 20_000);

test("a worktree that has moved off the reviewed HEAD is never relaunched against; central recovery asks", async () => {
  await withScenario({}, async (world) => {
    const { lease, job } = await seedStuckReview(world);
    world.patchCheckout(lease.path, { head: SCENARIO_NEXT_HEAD });
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
    expect(task.stage).toBe("blocked");
    expect(task.communication?.question?.id.startsWith(RESTART_QUESTION_ID_PREFIX)).toBe(true);

    const state = await readRuntimeState(runtimeFile(world.home));
    const runtime = state.tasks.find((entry) => entry.taskId === SCENARIO_TASK_ID);
    // No replacement job was launched: the only job on record is still the original dead one.
    expect(runtime?.jobs.map((entry) => entry.id)).toEqual([job.id]);
    expect(runtime?.recovery?.restarts ?? 0).toBe(0);
    await service.shutdown();
  });
}, 20_000);
