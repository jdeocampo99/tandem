import { expect, test } from "bun:test";
import type { BlockCause } from "../../src/contracts.ts";
import { taskRuntime } from "../../src/runtime/activity.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import { reviewAssistanceRuntime } from "../../src/tasks/review-assistance.ts";
import { transitionStoredTask } from "../../src/tasks/store.ts";
import { WorkerWorkflow } from "../../src/workers/workflow.ts";
import {
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "../evals/scenario.ts";

type RecordedBlock = Readonly<{ readonly reason: string; readonly cause?: BlockCause }>;

function unused(name: string): () => never {
  return () => {
    throw new Error(`${name} is not part of this scenario`);
  };
}

function workflowFor(world: ScenarioWorld, blocks: RecordedBlock[]): WorkerWorkflow {
  const runtimePath = runtimeFile(world.home);
  const getTask = async (taskId: string) => {
    const task = await world.store.read(taskId);
    if (task === undefined) throw new Error(`task ${taskId} is missing`);
    return task;
  };
  const context = () => ({ now: world.clock(), notificationId: world.idFactory() });
  return new WorkerWorkflow({
    home: world.home,
    sessionId: world.sessionId,
    parentWorkspaceId: undefined,
    poolRoot: world.poolRoot,
    workerTimeoutMs: undefined,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
    store: world.store,
    runtimePath,
    workerPath: "/unused/worker.ts",
    validationWorkerPath: "/unused/validation-worker.ts",
    getTask,
    taskInScope: async () => true,
    runtimeFor: async (taskId) => taskRuntime(await readRuntimeState(runtimePath), taskId),
    readState: () => readRuntimeState(runtimePath),
    resultExists: unused("resultExists"),
    updateTask: unused("updateTask"),
    transition: unused("transition"),
    context,
    blockTask: async (taskId, reason, cause) => {
      blocks.push({ reason, ...(cause === undefined ? {} : { cause }) });
      const task = await getTask(taskId);
      if (task.stage === "blocked") return task;
      return transitionStoredTask(
        world.store,
        taskId,
        task.revision,
        { type: "block", reason, ...(cause === undefined ? {} : { cause }) },
        context(),
      );
    },
    publishTaskInbox: unused("publishTaskInbox"),
    removeEndpoint: unused("removeEndpoint"),
    setRuntimeError: unused("setRuntimeError"),
    maintainPoolForAllocation: async () => true,
    reviewAssistance: reviewAssistanceRuntime({ timeoutMs: 1 }),
    recordRequestUsage: async () => {},
    readRequestUsage: unused("readRequestUsage"),
    briefSkipsReview: async () => false,
    readModelCatalogue: unused("readModelCatalogue"),
  });
}

test("a failed worktree allocation blocks the task once with the allocation failure", async () => {
  await withScenario({}, async (world) => {
    const task = await seedScenarioTask(world, { kind: "implementation", stage: "queued" });
    await seedScenarioRuntime(world, scenarioRuntimeTask());
    world.failAt({ boundary: "treehouse", action: "treehouse get", times: 1 });
    const blocks: RecordedBlock[] = [];

    await workflowFor(world, blocks).startQueuedTask(task);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.reason).toStartWith("worktree allocation failed: ");
    expect(blocks[0]?.cause).toMatchObject({ group: "lost-resource", kind: "allocation-failed" });
    const blocked = await world.store.read(SCENARIO_TASK_ID);
    expect(blocked?.stage).toBe("blocked");
    expect(blocked?.blockCause?.detail).toStartWith("worktree allocation failed: ");
  });
});
