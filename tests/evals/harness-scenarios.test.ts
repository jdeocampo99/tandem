import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ModelSpec, ResolvedPolicy } from "../../src/contracts.ts";
import { DEFAULT_HARNESS, parseHarnessName } from "../../src/harness/contract.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { parseWorkerJob, type WorkerJob } from "../../src/workers/jobs.ts";
import {
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

function policyWith(models: Partial<ResolvedPolicy["config"]["models"]>): ResolvedPolicy {
  return {
    ...SCENARIO_POLICY,
    config: { ...SCENARIO_POLICY.config, models: { ...SCENARIO_POLICY.config.models, ...models } },
  };
}

async function launchedScoutSpec(world: ScenarioWorld, policy: ResolvedPolicy): Promise<WorkerJob> {
  await seedScenarioTask(world, { kind: "scout", policy });
  await seedScenarioRuntime(world, scenarioRuntimeTask());
  const service = createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
  });
  try {
    await service.tick();
    const snapshot = await world.snapshot();
    const job = snapshot.runtime.tasks
      .find((entry) => entry.taskId === SCENARIO_TASK_ID)
      ?.jobs.at(-1);
    if (job === undefined) throw new Error("the scout did not launch");
    return parseWorkerJob(JSON.parse(await readFile(job.jobPath, "utf8")));
  } finally {
    await service.shutdown();
  }
}

const CLAUDE_CODE_SONNET: ModelSpec = { model: "claude-code/sonnet", thinking: "high" };
const CLAUDE_CODE_OPUS: ModelSpec = { model: "claude-code/opus", thinking: "high" };

test("a scout on a Claude Code model gets a Claude Code job while the coordinator stays on OMP", async () => {
  await withScenario({}, async (world) => {
    const spec = await launchedScoutSpec(world, policyWith({ scout: CLAUDE_CODE_SONNET }));
    expect(spec.model).toEqual(CLAUDE_CODE_SONNET);
    expect(spec.harness).toBe(parseHarnessName("claude-code", "harness"));
  });
});

test("a Claude Code coordinator leaves an OMP scout's job on OMP", async () => {
  await withScenario({}, async (world) => {
    const spec = await launchedScoutSpec(world, policyWith({ coordinator: CLAUDE_CODE_OPUS }));
    expect(spec.model).toEqual(SCENARIO_POLICY.config.models.scout);
    expect(spec.harness).toBe(DEFAULT_HARNESS);
  });
});
