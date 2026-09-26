import { expect, test } from "bun:test";
import { basename } from "node:path";
import {
  REQUEST_USAGE_EVENT_SCHEMA_VERSION,
  type RequestUsageEvent,
  requestUsageEventKey,
} from "../../src/runtime/usage.ts";
import { createRequestUsageLedger } from "../../src/runtime/usage-ledger.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { SCENARIO_NOW, SCENARIO_POLICY, withScenario } from "../evals/scenario.ts";

const REQUEST_ID = "req-1";

function implementationWork(taskId: string, amountMicros: number): RequestUsageEvent {
  const identity = { requestId: REQUEST_ID, taskId, operationId: `implement-${taskId}` };
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({ kind: "work", identity, discriminator: "settled" }),
    kind: "work",
    workKind: "implementation",
    identity,
    startedAt: SCENARIO_NOW,
    endedAt: SCENARIO_NOW,
    status: "succeeded",
    tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
    charge: {
      provenance: "actual",
      currency: "USD",
      amountMicros,
      pricingSource: "test",
      pricingVersion: 1,
    },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
  };
}

test("report assembles every task in scope, filters by creation, and reads shared usage", async () => {
  await withScenario({}, async (world) => {
    const create = (id: string, objective: string) =>
      world.store.create({
        id,
        repoPath: world.repoPath,
        kind: "implementation",
        objective,
        acceptanceCriteria: ["the report shows it"],
        surfaces: ["report"],
        policy: SCENARIO_POLICY,
        requestId: REQUEST_ID,
      });
    await create("task-1", "First change\nwith more detail");
    world.advanceClock(2 * 24 * 60);
    const later = world.clock();
    await create("task-2", "Second change");
    await createRequestUsageLedger({ home: world.home, clock: world.clock }).record([
      implementationWork("task-1", 1_500),
      implementationWork("task-2", 2_500),
    ]);
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    try {
      const all = await service.report();
      expect(all.generatedAt).toBe(later);
      expect(all.since).toBeUndefined();
      expect(all.scopeLabel).toBe(basename(world.repoPath));
      expect(all.unreadableEvents).toBe(0);
      // Both wait on approval; the older task has waited two days longer, so it sorts first.
      expect(all.tasks.map((task) => [task.id, task.title, task.costMicros])).toEqual([
        ["task-1", "First change", 1_500],
        ["task-2", "Second change", 2_500],
      ]);

      const recent = await service.report({ since: later });
      expect(recent.since).toBe(later);
      expect(recent.tasks.map((task) => task.id)).toEqual(["task-2"]);

      await expect(service.report({ since: "yesterday" })).rejects.toThrow(
        "report since must be an ISO timestamp",
      );
    } finally {
      await service.shutdown();
    }
  });
});
