import { expect, test } from "bun:test";
import type { Clock, RequestBriefContent } from "../../src/contracts.ts";
import type { DurableJob, DurableOperation } from "../../src/runtime/schema.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const MINUTE_MS = 60_000;
const START_MS = Date.UTC(2030, 0, 1, 0, 0);

const BRIEF: RequestBriefContent = {
  goal: "Account for everything one request cost and how long it took",
  scope: ["src/runtime"],
  constraints: ["accounting never authorizes or blocks work"],
  nonGoals: ["no second ledger"],
  acceptanceCriteria: ["a completed request produces one wall-clock receipt"],
  manualVerification: [],
  recommendedApproach: "Append durable facts keyed by a stable event identity",
  keyDecisions: ["unavailable is never summed as zero"],
  openQuestions: [],
  researchLinks: [],
};

/** A clock the test advances deliberately, so wall-clock assertions stay exact. */
function steppedClock(): Readonly<{ clock: Clock; advance: (minutes: number) => void }> {
  let current = START_MS;
  return {
    clock: () => new Date(current).toISOString(),
    advance: (minutes) => {
      current += minutes * MINUTE_MS;
    },
  };
}

function at(minutes: number): string {
  return new Date(START_MS + minutes * MINUTE_MS).toISOString();
}

function settledOperation(
  input: Readonly<{
    readonly id: string;
    readonly kind: DurableOperation["kind"];
    readonly role: DurableOperation["role"];
    readonly fromMinutes: number;
    readonly toMinutes: number;
  }>,
): DurableOperation {
  return {
    schemaVersion: 1,
    id: input.id,
    taskId: SCENARIO_TASK_ID,
    kind: input.kind,
    role: input.role,
    generation: 0,
    inputHead: SCENARIO_HEAD,
    policyDigest: "scenario-policy",
    instructionRevision: 1,
    jobId: `job-${input.id}`,
    phase: "completed",
    fencingRevision: 1,
    claimOwner: "scenario",
    createdAt: at(input.fromMinutes),
    effects: [],
    resultConsumedAt: at(input.toMinutes),
  };
}

function consumedJob(operation: DurableOperation): DurableJob {
  return {
    schemaVersion: 1,
    id: operation.jobId,
    taskId: SCENARIO_TASK_ID,
    generation: 0,
    role: operation.role,
    kind: "worker",
    cwd: "/tmp/scenario",
    jobPath: `/tmp/${operation.jobId}.json`,
    resultPath: `/tmp/${operation.jobId}-result.json`,
    attempt: 1,
    phase: "consumed",
    launchAttempted: true,
    createdAt: operation.createdAt,
    consumedAt: operation.resultConsumedAt ?? operation.createdAt,
    operationId: operation.id,
  };
}

async function seedOverlappingWork(world: ScenarioWorld): Promise<void> {
  const operations = [
    settledOperation({
      id: "op-implementation",
      kind: "implementation",
      role: "implementer",
      fromMinutes: 5,
      toMinutes: 25,
    }),
    settledOperation({
      id: "op-review",
      kind: "review",
      role: "reviewer",
      fromMinutes: 15,
      toMinutes: 35,
    }),
  ];
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      operationHistory: operations,
      jobs: operations.map(consumedJob),
    }),
  );
}

test("a settled request produces one wall-clock receipt that parallel work cannot inflate", async () => {
  await withScenario({}, async (world) => {
    const { clock, advance } = steppedClock();
    const service: TandemService = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock,
      idFactory: world.idFactory,
    });
    const drafted = await service.draftRequestBrief({
      repoPath: world.repoPath,
      content: BRIEF,
      reviewPane: false,
    });
    const requestId = drafted.record.id;
    const task = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "queued",
      requestId,
    });
    await seedOverlappingWork(world);

    advance(45);
    await service.cancel(task.id, "the coordinator settled this request");
    await service.tick();
    const receipt = await service.requestReceipt(requestId);
    await service.shutdown();

    expect(receipt.status).toBe("cancelled");
    expect(receipt.timing.intakeAt).toBe(at(0));
    expect(receipt.timing.elapsedMs).toBe(45 * MINUTE_MS);
    expect(receipt.timing.activeMs).toBe(30 * MINUTE_MS);
    expect(receipt.timing.overlappingMs).toBe(10 * MINUTE_MS);
    expect(receipt.timing.waitingMs).toBe(15 * MINUTE_MS);
    expect(receipt.breakdown.byWorkKind.map((total) => total.workKind)).toEqual([
      "implementation",
      "review",
    ]);
  });
});

test("child agent work is accounted with unavailable cost rather than as free work", async () => {
  await withScenario({}, async (world) => {
    const { clock, advance } = steppedClock();
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock,
      idFactory: world.idFactory,
    });
    const drafted = await service.draftRequestBrief({
      repoPath: world.repoPath,
      content: BRIEF,
      reviewPane: false,
    });
    const task = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "queued",
      requestId: drafted.record.id,
    });
    await seedOverlappingWork(world);

    advance(45);
    await service.cancel(task.id, "the coordinator settled this request");
    await service.tick();
    const receipt = await service.requestReceipt(drafted.record.id);
    await service.shutdown();

    expect(receipt.charges.amountMicros).toBe(0);
    expect(receipt.charges.actualSamples).toBe(0);
    expect(receipt.charges.unavailableSamples).toBe(2);
    expect(receipt.tokens.unavailableSamples).toBe(2);
    expect(receipt.quota.entries).toEqual([]);
    expect(receipt.quota.unavailableSamples).toBe(2);
  });
});

test("reconciling the same durable state again does not double count or move delivery", async () => {
  await withScenario({}, async (world) => {
    const { clock, advance } = steppedClock();
    const options = {
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock,
      idFactory: world.idFactory,
    };
    const service = createTandemService(options);
    const drafted = await service.draftRequestBrief({
      repoPath: world.repoPath,
      content: BRIEF,
      reviewPane: false,
    });
    const requestId = drafted.record.id;
    const task = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "queued",
      requestId,
    });
    await seedOverlappingWork(world);
    advance(45);
    await service.cancel(task.id, "the coordinator settled this request");
    await service.tick();
    const first = await service.requestReceipt(requestId);
    await service.shutdown();

    const restarted = createTandemService(options);
    advance(30);
    await restarted.tick();
    const replayed = await restarted.requestReceipt(requestId);
    await restarted.shutdown();

    expect(replayed.timing).toEqual(first.timing);
    expect(replayed.breakdown.byWorkKind).toEqual(first.breakdown.byWorkKind);
    expect(replayed.breakdown.duplicateSamples).toBe(0);
    expect(replayed.breakdown.malformedSamples).toBe(0);
  });
});
