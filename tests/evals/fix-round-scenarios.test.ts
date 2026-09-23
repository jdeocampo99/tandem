import { expect, test } from "bun:test";
import type { Finding, ResolvedPolicy, ReviewResult } from "../../src/contracts.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { fixRoundBudget, KEEP_FIXING_QUESTION_ID_PREFIX } from "../../src/tasks/findings.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NEXT_HEAD,
  SCENARIO_NOW,
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioJob,
  scenarioOperation,
  scenarioReservation,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const THREE_ROUND_POLICY: ResolvedPolicy = {
  ...SCENARIO_POLICY,
  config: { ...SCENARIO_POLICY.config, maxFixRounds: 3 },
};

const STUCK_FINDING: Finding = {
  id: "f-1",
  severity: "P1",
  verdict: "confirmed",
  file: "src/scenario.ts",
  description: "The handler still swallows the timeout error.",
};

function reviewAt(head: string, generation: number): ReviewResult {
  return {
    lens: "review",
    head,
    generation,
    pass: false,
    findings: [STUCK_FINDING],
    summary: "one blocker",
  };
}

function serviceFor(world: ScenarioWorld): TandemService {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
    workerTimeoutMs: 1_500,
  });
}

test("a spent fix-round budget asks Keep fixing?, and yes runs the next round in the same task and worktree", async () => {
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
      reviewRound: SCENARIO_POLICY.config.maxFixRounds,
      worktree: lease,
      endpoints: [endpoint],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, endpoints: [endpoint], jobs: [] }),
    );
    const service = serviceFor(world);

    await service.tick();
    let task = await service.get(SCENARIO_TASK_ID);
    const question = task.communication?.question;
    expect(task.stage).toBe("blocked");
    expect(task.blockCause?.kind).toBe("fix-rounds-exhausted");
    expect(question?.id.startsWith(KEEP_FIXING_QUESTION_ID_PREFIX)).toBe(true);
    expect(question?.text).toBe(
      'Keep fixing "exercise one durable scenario path"? It used all 1 fix rounds.',
    );
    if (question === undefined) throw new Error("expected the Keep fixing? question");

    await service.answer({ taskId: SCENARIO_TASK_ID, questionId: question.id, text: "yes" });

    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("implementing");
    expect(task.reviewRound).toBe(2);
    expect(task.worktree?.leaseId).toBe(lease.leaseId);
    expect(task.communication?.question).toBeUndefined();
    const snapshot = await world.snapshot();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob)?.cwd).toBe(lease.path);
    expect(snapshot.trace.some((event) => event.action === "treehouse get")).toBe(false);
    await service.shutdown();
  });
}, 20_000);

test("no leaves the task blocked with its worktree kept", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "awaiting-fixes",
      reviewHead: SCENARIO_HEAD,
      reviewRound: SCENARIO_POLICY.config.maxFixRounds,
      worktree: lease,
      endpoints: [],
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask({ worktree: lease }));
    const service = serviceFor(world);

    await service.tick();
    const questionId = (await service.get(SCENARIO_TASK_ID)).communication?.question?.id ?? "";
    await expect(
      service.answer({ taskId: SCENARIO_TASK_ID, questionId, text: "sure" }),
    ).rejects.toThrow('only accepts "yes" or "no"');
    await service.answer({ taskId: SCENARIO_TASK_ID, questionId, text: "no" });

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.reviewRound).toBe(SCENARIO_POLICY.config.maxFixRounds);
    expect(task.fixRoundGrants).toBeUndefined();
    expect(task.communication?.question).toBeUndefined();
    expect((await world.snapshot()).resources.retained).toContain(`worktree:${lease.leaseId}`);
    await service.shutdown();
  });
}, 20_000);

test("the same finding back unchanged after a fix round asks early instead of spending rounds", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      policy: THREE_ROUND_POLICY,
      stage: "awaiting-fixes",
      reviewHead: SCENARIO_NEXT_HEAD,
      reviewRound: 1,
      generation: 1,
      reviews: [reviewAt(SCENARIO_HEAD, 0), reviewAt(SCENARIO_NEXT_HEAD, 1)],
      worktree: lease,
      endpoints: [],
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask({ worktree: lease }));
    const service = serviceFor(world);

    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.reviewRound).toBe(1);
    expect(task.communication?.question?.text).toBe(
      'Keep fixing "exercise one durable scenario path"? The same finding came back: The handler still swallows the timeout error.',
    );
    const snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.jobs.some(activeRuntimeJob)).toBe(false);
    await service.shutdown();
  });
}, 20_000);

test("a fix round that makes no commit hands its round back, and the unchanged review then asks", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    // The fix round starts from the reviewed commit and ends there: nothing new was committed.
    world.patchCheckout(lease.path, { head: SCENARIO_NEXT_HEAD });
    const endpoint = {
      ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
      role: "implementer" as const,
      generation: 1,
    };
    const job = scenarioJob({
      home: world.home,
      role: "implementer",
      cwd: lease.path,
      endpoint,
      generation: 1,
    });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "implementing",
      reviewRound: 1,
      generation: 1,
      reviews: [reviewAt(SCENARIO_NEXT_HEAD, 0)],
      worktree: lease,
      endpoints: [endpoint],
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        endpoints: [endpoint],
        jobs: [job],
        operation: scenarioOperation(job, { inputHead: SCENARIO_NEXT_HEAD }),
        reservation: scenarioReservation(),
      }),
    );
    await persistWorkerResult(job.resultPath, {
      id: job.id,
      taskId: SCENARIO_TASK_ID,
      generation: 1,
      role: "implementer",
      status: "completed",
      text: "Nothing left to change.",
      finishedAt: SCENARIO_NOW,
    });
    const service = serviceFor(world);

    await service.tick();

    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.reviewHead).toBe(SCENARIO_NEXT_HEAD);
    expect(task.reviewRound).toBe(1);
    expect(task.fixRoundGrants).toEqual([{ generation: 1, rounds: 1, reason: "no-commit" }]);
    expect(fixRoundBudget(task)).toBe(SCENARIO_POLICY.config.maxFixRounds + 1);

    // The review of the unchanged commit reports the same blocker; the next tick asks instead of
    // spending the handed-back round on another identical attempt.
    task = await world.store.update(task.id, task.revision, (current) => {
      const { previousStage: _stage, blockReason: _reason, blockCause: _cause, ...rest } = current;
      return {
        ...rest,
        revision: current.revision + 1,
        stage: "awaiting-fixes",
        reviews: [...current.reviews, reviewAt(SCENARIO_NEXT_HEAD, 1)],
      };
    });
    await service.tick();
    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.reviewRound).toBe(1);
    expect(task.communication?.question?.text).toContain("The same finding came back");
    await service.shutdown();
  });
}, 20_000);
