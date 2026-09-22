import { expect, test } from "bun:test";
import type { RequestBriefContent } from "../../src/contracts.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import { JEV_PRICING_SNAPSHOT } from "../../src/runtime/usage.ts";
import { providerSampleEvent } from "../../src/runtime/usage-events.ts";
import { createRequestUsageLedger } from "../../src/runtime/usage-ledger.ts";
import { createTandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_POLICY,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const BRIEF: RequestBriefContent = {
  goal: "Route execution economically without economizing to fit",
  scope: ["src/workers"],
  constraints: ["a premium tier always needs a decision"],
  nonGoals: ["no per-turn model optimization"],
  acceptanceCriteria: ["rerouting never resolves a spending decision"],
  recommendedApproach: "Resolve routing only after the spending checkpoint admits the operation",
  keyDecisions: ["unmeasured usage is unknown, not small"],
  openQuestions: [],
  researchLinks: [],
};

/**
 * One provider sample carrying no operation identity and no published price, which is what review
 * assistance leaves behind: unaccounted work nothing in the budget stands for.
 */
async function recordUnaccountedSample(world: ScenarioWorld, requestId: string): Promise<void> {
  const event = providerSampleEvent({
    requestId,
    workKind: "review",
    usage: {
      schemaVersion: 1,
      provider: "typesafe",
      model: "jev",
      inputTokens: "unavailable",
      outputTokens: "unavailable",
      durationMs: 1_000,
      timedOut: false,
      reason: "routing scenario sample",
      pricing: JEV_PRICING_SNAPSHOT,
    },
    startedAt: "2030-01-01T00:00:00.000Z",
    endedAt: "2030-01-01T00:01:00.000Z",
    sampleIdentity: "review-assistance-1",
    role: "reviewer",
  });
  if (event === undefined) throw new Error("the sample produced no accounting event");
  await createRequestUsageLedger({ home: world.home, clock: world.clock }).record([event]);
}

test("the same request reaches routing and records a transition once its usage is accounted for", async () => {
  await withScenario({}, async (world) => {
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    const drafted = await service.draftRequestBrief({
      repoPath: world.repoPath,
      content: BRIEF,
      reviewPane: false,
    });
    const requestId = drafted.record.id;
    await service.approveRequestBrief({
      requestId,
      briefRevision: drafted.record.draft.revision,
      contentDigest: drafted.record.draft.contentDigest,
    });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "queued",
      requestId,
      policy: SCENARIO_POLICY,
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask());

    await service.tick();

    const runtime = (await readRuntimeState(runtimeFile(world.home))).tasks[0];
    const routing = runtime?.operation?.routing;
    expect(routing?.basis).toBe("pinned-policy");
    expect(routing?.selector).toBe(SCENARIO_POLICY.config.models.implementer.model);
    expect(routing?.requestId).toBe(requestId);
    expect(routing?.evidence.usageSource).toBe("request-ledger");
    await service.shutdown();
  });
});

test("an unaccounted spending decision stops the task before routing is ever resolved", async () => {
  await withScenario({}, async (world) => {
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    const drafted = await service.draftRequestBrief({
      repoPath: world.repoPath,
      content: BRIEF,
      reviewPane: false,
    });
    const requestId = drafted.record.id;
    await service.approveRequestBrief({
      requestId,
      briefRevision: drafted.record.draft.revision,
      contentDigest: drafted.record.draft.contentDigest,
    });
    const task = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "queued",
      requestId,
      policy: SCENARIO_POLICY,
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask());
    await recordUnaccountedSample(world, requestId);

    await service.tick();
    await service.tick();

    const spend = await service.requestSpend(requestId);
    expect(spend.pause?.reason).toBe("exposure-unaccounted");
    expect(spend.exposure.unaccountedSamples).toBe(1);

    const runtime = (await readRuntimeState(runtimeFile(world.home))).tasks[0];
    expect(runtime?.operation).toBeUndefined();
    expect(runtime?.reservation).toBeUndefined();
    expect(runtime?.routingPause).toBeUndefined();

    const stopped = await service.get(task.id);
    const messages = stopped.notifications.map((entry) => entry.message);
    expect(messages.filter((message) => message.includes("Spending on "))).toHaveLength(1);
    expect(
      messages.filter((message) => message.includes("Tandem paused a model change")),
    ).toHaveLength(0);
    await service.shutdown();
  });
});
