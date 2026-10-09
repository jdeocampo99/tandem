import type { CommandRunner, QuickScopeReport, TaskRecord } from "../../src/contracts.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { quickApproval } from "../../src/tasks/quick.ts";
import { quickScopeQuestionText } from "../../src/tasks/quick-scope.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_NOW,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioJob,
  scenarioOperation,
  scenarioReservation,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
} from "./scenario.ts";

export const TEXT = "Rename the Save button to Save draft on the settings page";
export const SCOPE: QuickScopeReport = {
  files: 14,
  areas: ["billing", "settings"],
  decision: "whether drafts expire",
  plan: "turn it into a request with a brief",
};

export function serviceFor(world: ScenarioWorld, run: CommandRunner = world.run): TandemService {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run,
    clock: world.clock,
    idFactory: world.idFactory,
    workerTimeoutMs: 1_500,
  });
}

/** A quick task whose implementer is running, and the path its result lands at. */
export async function runningQuickTask(world: ScenarioWorld) {
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  const endpoint = {
    ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
    role: "implementer" as const,
  };
  const job = scenarioJob({ home: world.home, role: "implementer", cwd: lease.path, endpoint });
  const seeded = await seedScenarioTask(world, {
    kind: "implementation",
    stage: "implementing",
    worktree: lease,
    endpoints: [endpoint],
  });
  await world.store.update(seeded.id, seeded.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    quick: quickApproval({ text: TEXT, at: SCENARIO_NOW }),
  }));
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      worktree: lease,
      endpoints: [endpoint],
      jobs: [job],
      operation: scenarioOperation(job),
      reservation: scenarioReservation(),
    }),
  );
  return job.resultPath;
}

/** The worker stops before changing anything and asks the one scope question. */
export async function askScope(world: ScenarioWorld, service: TandemService): Promise<TaskRecord> {
  await persistWorkerResult(await runningQuickTask(world), {
    id: "job-1",
    taskId: SCENARIO_TASK_ID,
    generation: 0,
    role: "implementer",
    status: "needs-decision",
    text: "Outcome: needs-decision",
    question: { text: quickScopeQuestionText(SCOPE), scope: SCOPE },
    finishedAt: SCENARIO_NOW,
  });
  await service.tick();
  return service.get(SCENARIO_TASK_ID);
}
