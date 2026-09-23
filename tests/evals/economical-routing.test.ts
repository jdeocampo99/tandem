import { expect, test } from "bun:test";
import type { RequestBriefContent } from "../../src/contracts.ts";
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
  goal: "Route execution economically without economizing to fit",
  scope: ["src/workers"],
  constraints: ["a premium tier always needs a decision"],
  nonGoals: ["no per-turn model optimization"],
  acceptanceCriteria: ["rerouting never resolves a spending decision"],
  manualVerification: [],
  recommendedApproach: "Resolve routing only after the spending checkpoint admits the operation",
  keyDecisions: ["unmeasured usage is unknown, not small"],
  openQuestions: [],
  researchLinks: [],
};

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
