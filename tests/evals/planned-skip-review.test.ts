import { expect, test } from "bun:test";
import type { RequestBriefContent, ResolvedPolicy } from "../../src/contracts.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const BRIEF: RequestBriefContent = {
  goal: "Fix a typo in the retry message",
  scope: ["src/retry.ts"],
  constraints: [],
  nonGoals: [],
  acceptanceCriteria: ["bun test passes"],
  manualVerification: [],
  recommendedApproach: "Edit the string",
  keyDecisions: [],
  openQuestions: [],
  researchLinks: [],
};

const POLICY: ResolvedPolicy = {
  ...SCENARIO_POLICY,
  config: {
    ...SCENARIO_POLICY.config,
    validationCommands: [{ name: "smoke", argv: ["true"], surfaces: ["*"], timeoutMs: 1_000 }],
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

/** An approved brief and a task whose validation passed, now waiting for its first reviewer. */
async function seedValidatedTask(
  world: ScenarioWorld,
  service: TandemService,
  skipReview: boolean,
) {
  const drafted = await service.draftRequestBrief({
    repoPath: world.repoPath,
    content: skipReview ? { ...BRIEF, skipReview: true } : BRIEF,
    reviewPane: false,
  });
  await service.approveRequestBrief({
    requestId: drafted.record.id,
    briefRevision: drafted.record.draft.revision,
    contentDigest: drafted.record.draft.contentDigest,
  });
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  await seedScenarioTask(world, {
    kind: "implementation",
    stage: "reviewing",
    requestId: drafted.record.id,
    reviewHead: SCENARIO_HEAD,
    worktree: lease,
    policy: POLICY,
  });
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({ worktree: lease, endpoints: [], reviewMode: "review_existing_head" }),
  );
}

test("a brief approved without review makes validated work ready without launching a reviewer", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await seedValidatedTask(world, service, true);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("ready");
    expect(task.reviewSkippedHead).toBe(SCENARIO_HEAD);
    expect(task.reviews).toHaveLength(0);
    expect(task.reviewLevel).toBeDefined();
    const summary = { tldr: ["Fixes a typo."], what: ["One string."], why: ["It was wrong."] };
    expect(await service.describePr(SCENARIO_TASK_ID, summary)).toContain(
      `Review was skipped at the user's request at HEAD ${SCENARIO_HEAD}.`,
    );
    await service.shutdown();
  });
});

test("a brief that says nothing about review still reviews the work", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await seedValidatedTask(world, service, false);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("reviewing");
    expect(task.reviewSkippedHead).toBeUndefined();
    const runtime = (await readRuntimeState(runtimeFile(world.home))).tasks[0];
    expect(runtime?.endpoints.some((endpoint) => endpoint.role === "reviewer")).toBe(true);
    await service.shutdown();
  });
});
