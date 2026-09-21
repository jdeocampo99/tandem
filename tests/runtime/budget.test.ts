import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Clock,
  RequestBudgetPolicy,
  ResolvedPolicy,
  TaskRecord,
} from "../../src/contracts.ts";
import {
  observeRequestCharges,
  type RequestSpendAdmission,
  requestBudgetFor,
  requestOperationSettlements,
  withRequestBudget,
} from "../../src/runtime/budget.ts";
import { createRequestSpendGate, type RequestSpendGate } from "../../src/runtime/budget-gate.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import type { DurableOperation, RuntimeState, RuntimeTaskState } from "../../src/runtime/schema.ts";
import { chargeMicrosForTokens, JEV_PRICING_SNAPSHOT } from "../../src/runtime/usage.ts";
import { providerSampleEvent } from "../../src/runtime/usage-events.ts";
import { createRequestUsageLedger } from "../../src/runtime/usage-ledger.ts";
import { createTaskStore, type TaskStore } from "../../src/tasks/store.ts";

const REQUEST_ID = "req-budget";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE_POLICY: RequestBudgetPolicy = {
  capMicros: 1_000_000,
  operationEstimateMicros: 400_000,
};

type BudgetWorld = Readonly<{
  readonly home: string;
  readonly store: TaskStore;
  readonly gate: RequestSpendGate;
  readonly recordSample: (input: SampleInput) => Promise<void>;
  readonly restart: () => RequestSpendGate;
  readonly admit: (task: TaskRecord, operationId: string) => Promise<RequestSpendAdmission>;
  readonly state: () => Promise<RuntimeState>;
}>;

type SampleInput = Readonly<{
  readonly operationId: string;
  readonly inputTokens: number | "unavailable";
  readonly priced: boolean;
}>;

function steppedClock(): Clock {
  let current = Date.UTC(2030, 0, 1);
  return () => {
    current += 1_000;
    return new Date(current).toISOString();
  };
}

function resolvedPolicy(requestBudget: RequestBudgetPolicy): ResolvedPolicy {
  return {
    config: {
      version: 1,
      models: {
        coordinator: { model: "budget/coordinator", thinking: "low" },
        scout: { model: "budget/scout", thinking: "low" },
        implementer: { model: "budget/implementer", thinking: "low" },
        reviewer: { model: "budget/reviewer", thinking: "low" },
        verifier: { model: "budget/verifier", thinking: "low" },
        presentation: { model: "budget/presentation", thinking: "low" },
      },
      instructions: { implementation: [], validation: [], review: [] },
      instructionFiles: { implementation: [], validation: [], review: [] },
      validationCommands: [],
      maxWorkers: 3,
      maxFixRounds: 1,
      reviewLevels: {
        reducedRouting: false,
        deepScrutiny: false,
        jevAssistance: "off",
        sourceTransmission: false,
      },
      requestBudget,
    },
    guidance: { implementation: [], validation: [], review: [] },
  };
}

function runtimeTask(taskId: string, operations: readonly DurableOperation[]): RuntimeTaskState {
  return {
    schemaVersion: 1,
    taskId,
    sourceCheckpoint: { head: HEAD, base: HEAD, diff: "", dirty: false, unmerged: false },
    taskName: `budget-${taskId}`,
    endpoints: [],
    jobs: [],
    ...(operations.length === 0 ? {} : { operationHistory: operations }),
  };
}

function settledOperation(operationId: string, taskId: string): DurableOperation {
  return {
    schemaVersion: 1,
    id: operationId,
    taskId,
    kind: "implementation",
    role: "implementer",
    generation: 0,
    inputHead: HEAD,
    policyDigest: "budget-policy",
    instructionRevision: 1,
    jobId: `job-${operationId}`,
    phase: "completed",
    fencingRevision: 1,
    claimOwner: "budget",
    createdAt: "2030-01-01T00:00:00.000Z",
    effects: [],
    resultConsumedAt: "2030-01-01T00:10:00.000Z",
  };
}

/**
 * A real Tandem home: the authoritative SQLite state, the accounting ledger, and the task store
 * the admission lock runs under. Nothing here is faked, so a refusal, a reservation, and a restart
 * are the ones the runtime would actually produce.
 */
async function withBudgetWorld(
  run: (world: BudgetWorld, tasks: readonly TaskRecord[]) => Promise<void>,
  budget: RequestBudgetPolicy = BASE_POLICY,
  taskIds: readonly string[] = ["task-1"],
): Promise<void> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "tandem-budget-")));
  const clock = steppedClock();
  let sequence = 0;
  const idFactory = (): string => {
    sequence += 1;
    return `budget-id-${sequence}`;
  };
  const store = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  const ledger = createRequestUsageLedger({ home, clock });
  const path = runtimeFile(home);
  const newGate = (): RequestSpendGate =>
    createRequestSpendGate({
      runtimePath: path,
      store,
      clock,
      readRequestUsage: (requestId) => ledger.read(requestId),
      readAgreementRevision: async () => 1,
    });
  const gate = newGate();
  const tasks: TaskRecord[] = [];
  for (const taskId of taskIds) {
    tasks.push(
      await store.create({
        id: taskId,
        repoPath: home,
        kind: "implementation",
        objective: "spend under a standing cap",
        acceptanceCriteria: ["the cap governs admission"],
        surfaces: ["runtime"],
        policy: resolvedPolicy(budget),
        requestId: REQUEST_ID,
      }),
    );
  }
  await writeRuntimeState(path, {
    schemaVersion: 1,
    tasks: taskIds.map((taskId) => runtimeTask(taskId, [])),
    presentations: [],
  });
  const admit = async (task: TaskRecord, operationId: string): Promise<RequestSpendAdmission> =>
    store.exclusive(async () => {
      const state = await readRuntimeState(path);
      const admission = await gate.decideAdmission({ task, state, operationId });
      if (admission === undefined) throw new Error("an ungoverned task reached the budget gate");
      await writeRuntimeState(path, withRequestBudget(state, admission.budget));
      return admission;
    });
  await run(
    {
      home,
      store,
      gate,
      restart: newGate,
      admit,
      state: () => readRuntimeState(path),
      recordSample: async ({ operationId, inputTokens, priced }) => {
        const event = providerSampleEvent({
          requestId: REQUEST_ID,
          workKind: "implementation",
          usage: {
            schemaVersion: 1,
            provider: "typesafe",
            model: "jev",
            inputTokens,
            outputTokens: inputTokens === "unavailable" ? "unavailable" : 0,
            durationMs: 1_000,
            timedOut: false,
            reason: "budget test sample",
            pricing: priced ? JEV_PRICING_SNAPSHOT : "unavailable",
          },
          startedAt: "2030-01-01T00:00:00.000Z",
          endedAt: "2030-01-01T00:01:00.000Z",
          sampleIdentity: operationId,
          taskId: "task-1",
          role: "implementer",
        });
        if (event === undefined) throw new Error("the sample produced no accounting event");
        await ledger.record([{ ...event, identity: { ...event.identity, operationId } }]);
      },
    },
    tasks,
  );
}

test("a second admission is refused when the combined exposure cannot fit", async () => {
  await withBudgetWorld(
    async (world, tasks) => {
      const task = tasks[0];
      if (task === undefined) throw new Error("the world seeded no task");
      const [first, second] = await Promise.all([
        world.admit(task, "op-a"),
        world.admit(task, "op-b"),
      ]);
      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(["admitted", "paused"]);

      const budget = requestBudgetFor(await world.state(), REQUEST_ID);
      expect(budget?.reservations).toHaveLength(1);
      expect(budget?.reservations[0]?.estimatedMicros).toBe(400_000);
      expect(budget?.pause?.reason).toBe("cap-would-be-exceeded");
      expect(budget?.pause?.reservedMicros).toBe(400_000);
    },
    { capMicros: 500_000, operationEstimateMicros: 400_000 },
  );
});

test("an independent task under the same request cannot walk past the budget pause", async () => {
  await withBudgetWorld(
    async (world, tasks) => {
      const [first, second] = tasks;
      if (first === undefined || second === undefined) throw new Error("two tasks were expected");
      expect((await world.admit(first, "op-a")).outcome).toBe("admitted");
      const stopped = await world.admit(first, "op-b");
      expect(stopped.outcome).toBe("paused");

      const independent = await world.admit(second, "op-c");
      expect(independent.outcome).toBe("paused");
      if (independent.outcome !== "paused" || stopped.outcome !== "paused") return;
      expect(independent.raised).toBe(false);
      expect(independent.pause.decisionId).toBe(stopped.pause.decisionId);

      const budget = requestBudgetFor(await world.state(), REQUEST_ID);
      expect(budget?.reservations.map((entry) => entry.operationId)).toEqual(["op-a"]);
    },
    { capMicros: 500_000, operationEstimateMicros: 400_000 },
    ["task-1", "task-2"],
  );
});

test("a request with no configured cap pauses instead of running unlimited", async () => {
  await withBudgetWorld(
    async (world, tasks) => {
      const task = tasks[0];
      if (task === undefined) throw new Error("the world seeded no task");
      const admission = await world.admit(task, "op-a");
      expect(admission.outcome).toBe("paused");
      if (admission.outcome !== "paused") return;
      expect(admission.pause.reason).toBe("no-configured-cap");
      expect(admission.pause.capMicros).toBe("unset");

      const readout = await world.gate.readSpend(REQUEST_ID);
      expect(readout.cap.source).toBe("none");
      expect(readout.exposure.reservedMicros).toBe(0);
    },
    { capMicros: "unset", operationEstimateMicros: "unset" },
  );
});

test("an authorization is bound to its decision and is required again once superseded", async () => {
  await withBudgetWorld(
    async (world, tasks) => {
      const task = tasks[0];
      if (task === undefined) throw new Error("the world seeded no task");
      const stopped = await world.admit(task, "op-a");
      if (stopped.outcome !== "paused") throw new Error("the first admission should have paused");

      await expect(
        world.gate.authorizeSpend({
          requestId: REQUEST_ID,
          decisionId: "spend-not-this-one",
          capMicros: 5_000_000,
        }),
      ).rejects.toThrow(/not the pending decision/u);
      await expect(
        world.gate.authorizeSpend({
          requestId: REQUEST_ID,
          decisionId: stopped.pause.decisionId,
          capMicros: 10_000,
        }),
      ).rejects.toThrow(/would lower it/u);

      const authorized = await world.gate.authorizeSpend({
        requestId: REQUEST_ID,
        decisionId: stopped.pause.decisionId,
        capMicros: 5_000_000,
      });
      expect(authorized.pause).toBeUndefined();
      expect(authorized.approval?.capMicros).toBe(5_000_000);
      expect((await world.admit(task, "op-a")).outcome).toBe("admitted");

      const tightened = await world.store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        policy: resolvedPolicy({ capMicros: 200_000, operationEstimateMicros: 400_000 }),
      }));
      const rechecked = await world.admit(tightened, "op-b");
      expect(rechecked.outcome).toBe("paused");
      if (rechecked.outcome !== "paused") return;
      expect(rechecked.pause.decisionId).not.toBe(stopped.pause.decisionId);
      expect((await world.gate.readSpend(REQUEST_ID)).pause?.reason).toBe("cap-would-be-exceeded");
    },
    { capMicros: 100_000, operationEstimateMicros: 400_000 },
  );
});

test("a restart reconciles reservations without double counting or losing one", async () => {
  await withBudgetWorld(
    async (world, tasks) => {
      const task = tasks[0];
      if (task === undefined) throw new Error("the world seeded no task");
      expect((await world.admit(task, "op-priced")).outcome).toBe("admitted");
      expect((await world.admit(task, "op-unpriced")).outcome).toBe("admitted");
      expect((await world.admit(task, "op-running")).outcome).toBe("admitted");

      const priced = settledOperation("op-priced", task.id);
      const unpriced = settledOperation("op-unpriced", task.id);
      const running = { ...settledOperation("op-running", task.id), phase: "running" as const };
      const state = await world.state();
      await writeRuntimeState(runtimeFile(world.home), {
        ...state,
        tasks: [{ ...runtimeTask(task.id, [priced, unpriced]), operation: running }],
      });
      await world.recordSample({ operationId: "op-priced", inputTokens: 2_000_000, priced: true });
      await world.recordSample({
        operationId: "op-unpriced",
        inputTokens: "unavailable",
        priced: false,
      });

      const restarted = world.restart();
      const settlements = requestOperationSettlements({
        operationHistory: [priced, unpriced],
        operation: running,
      });
      await restarted.reconcileReservations({ requestId: REQUEST_ID, settlements });
      await restarted.reconcileReservations({ requestId: REQUEST_ID, settlements });

      const readout = await restarted.readSpend(REQUEST_ID);
      const chargedMicros = chargeMicrosForTokens(
        { inputTokens: 2_000_000, outputTokens: 0 },
        JEV_PRICING_SNAPSHOT,
      );
      if (chargedMicros === "unavailable") throw new Error("the priced sample carried no charge");
      expect(readout.reservations.map((entry) => entry.operationId).sort()).toEqual([
        "op-running",
        "op-unpriced",
      ]);
      expect(readout.reservations.find((entry) => entry.operationId === "op-unpriced")?.basis).toBe(
        "settled-estimate",
      );
      expect(readout.reservations.find((entry) => entry.operationId === "op-running")?.basis).toBe(
        "in-flight",
      );
      expect(readout.exposure.committedMicros).toBe(chargedMicros);
      expect(readout.exposure.reservedMicros).toBe(800_000);
      expect(readout.reconciledAt).toBeDefined();
    },
    { capMicros: 5_000_000, operationEstimateMicros: 400_000 },
  );
});

test("an unreported charge is counted as unmeasured rather than as zero cash", async () => {
  await withBudgetWorld(
    async (world, tasks) => {
      const task = tasks[0];
      if (task === undefined) throw new Error("the world seeded no task");
      expect((await world.admit(task, "op-a")).outcome).toBe("admitted");
      await world.recordSample({ operationId: "op-a", inputTokens: "unavailable", priced: false });

      const readout = await world.gate.readSpend(REQUEST_ID);
      expect(readout.charges.amountMicros).toBe(0);
      expect(readout.charges.actualSamples).toBe(0);
      expect(readout.charges.unavailableSamples).toBe(1);
      expect(readout.exposure.unpricedSamples).toBe(1);
      expect(readout.exposure.reservedMicros).toBe(400_000);
      expect(readout.exposure.totalMicros).toBe(400_000);
      expect(readout.quota.unavailableSamples).toBe(1);
      expect(readout.quota.entries).toEqual([]);
    },
    { capMicros: 5_000_000, operationEstimateMicros: 400_000 },
  );
});

test("the observation names only the operations the ledger actually priced", async () => {
  await withBudgetWorld(
    async (world, tasks) => {
      const task = tasks[0];
      if (task === undefined) throw new Error("the world seeded no task");
      expect((await world.admit(task, "op-priced")).outcome).toBe("admitted");
      await world.recordSample({ operationId: "op-priced", inputTokens: 1_000_000, priced: true });
      await world.recordSample({
        operationId: "op-free",
        inputTokens: "unavailable",
        priced: false,
      });

      const ledgerHome = world.home;
      const readout = observeRequestCharges(
        REQUEST_ID,
        await createRequestUsageLedger({ home: ledgerHome, clock: steppedClock() }).read(
          REQUEST_ID,
        ),
      );
      expect(readout.pricedOperationIds).toEqual(["op-priced"]);
    },
    { capMicros: 5_000_000, operationEstimateMicros: 400_000 },
  );
});
