import { expect, test } from "bun:test";
import type {
  RequestBriefContent,
  RequestBudgetPolicy,
  ResolvedPolicy,
} from "../../src/contracts.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import { createTandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_POLICY,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const BRIEF: RequestBriefContent = {
  goal: "Govern what one request is allowed to spend",
  scope: ["src/runtime"],
  constraints: ["never economize to fit a cap"],
  nonGoals: ["no provider hard cap"],
  acceptanceCriteria: ["work stops for an explicit decision before it overspends"],
  recommendedApproach: "Reserve conservative exposure atomically with runtime admission",
  keyDecisions: ["an unset amount is unknown, not unlimited"],
  openQuestions: [],
  researchLinks: [],
};

function policyWithBudget(requestBudget: RequestBudgetPolicy): ResolvedPolicy {
  return { ...SCENARIO_POLICY, config: { ...SCENARIO_POLICY.config, requestBudget } };
}

function budgetDecisionNotices(messages: readonly string[]): readonly string[] {
  return messages.filter((message) => message.startsWith("Spending decision "));
}

test("a request whose next step cannot fit stops before launch and asks exactly once", async () => {
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
      policy: policyWithBudget({ capMicros: 100_000, operationEstimateMicros: 500_000 }),
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask());

    await service.tick();
    await service.tick();

    const stopped = await service.get(task.id);
    const stoppedSpend = await service.requestSpend(requestId);
    expect(stoppedSpend.pause?.reason).toBe("cap-would-be-exceeded");
    expect(stoppedSpend.pause?.nextStepMicros).toBe(500_000);
    expect(stoppedSpend.exposure.reservedMicros).toBe(0);
    expect(budgetDecisionNotices(stopped.notifications.map((entry) => entry.message))).toHaveLength(
      1,
    );
    const runtime = (await readRuntimeState(runtimeFile(world.home))).tasks[0];
    expect(stopped.stage).toBe("queued");
    expect(runtime?.operation).toBeUndefined();
    expect(runtime?.reservation).toBeUndefined();

    const decisionId = stoppedSpend.pause?.decisionId ?? "";
    const authorized = await service.authorizeRequestSpend({
      requestId,
      decisionId,
      capMicros: 10_000_000,
    });
    expect(authorized.pause).toBeUndefined();
    expect(authorized.approval?.previousCapMicros).toBe(100_000);
    expect(authorized.cap).toEqual({ source: "request-approval", capMicros: 10_000_000 });

    await service.tick();
    const resumed = await service.requestSpend(requestId);
    expect(resumed.pause).toBeUndefined();
    expect(resumed.exposure.reservedMicros).toBe(500_000);
    expect(resumed.reservations).toHaveLength(1);
    await service.shutdown();
  });
});

test("a request with no standing cap runs ungoverned and asks nothing", async () => {
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
      policy: policyWithBudget({ capMicros: "unset", operationEstimateMicros: "unset" }),
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask());

    await service.tick();

    const spend = await service.requestSpend(requestId);
    expect(spend.cap.source).toBe("none");
    expect(spend.pause).toBeUndefined();
    expect(spend.reservations).toEqual([]);
    expect(spend.exposure.totalMicros).toBe(0);

    const runtimeState = await readRuntimeState(runtimeFile(world.home));
    expect(runtimeState.requestBudgets ?? []).toEqual([]);
    expect(runtimeState.tasks[0]?.operation).toBeDefined();
    const admitted = await service.get(task.id);
    expect(budgetDecisionNotices(admitted.notifications.map((entry) => entry.message))).toEqual([]);
    await service.shutdown();
  });
});
