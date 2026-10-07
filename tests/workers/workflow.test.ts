import { expect, test } from "bun:test";
import type { BlockCause } from "../../src/contracts.ts";
import { taskRuntime } from "../../src/runtime/activity.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import type { DurableOperation } from "../../src/runtime/schema.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import { transitionStoredTask } from "../../src/tasks/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { WorkerWorkflow } from "../../src/workers/workflow.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NOW,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioReservation,
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
    terminal: terminalBackend(world.run, { terminal: "herdr" }),
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
    recordRequestUsage: async () => {},
    readRequestUsage: unused("readRequestUsage"),
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

// The interleaving behind a flaky two-controller dispatch: one coordinator admits an operation,
// another takes it over before the first appends its job. The first must not append a job only
// the new owner may launch, or neither launches it.
test("a coordinator whose operation was taken over leaves the launch to the new owner", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const endpoint = world.openPane({ paneId: "pane-1", cwd: lease.path });
    const task = await seedScenarioTask(world, {
      kind: "scout",
      stage: "scouting",
      worktree: lease,
      endpoints: [endpoint],
    });
    const operation: DurableOperation = {
      schemaVersion: 1,
      id: "operation-1",
      taskId: SCENARIO_TASK_ID,
      kind: "scout",
      role: "scout",
      generation: 0,
      inputHead: SCENARIO_HEAD,
      policyDigest: policyIdentity(task.policy),
      instructionRevision: 0,
      jobId: "job-1",
      phase: "admitted",
      fencingRevision: 1,
      claimOwner: "first-owner",
      createdAt: SCENARIO_NOW,
      effects: [],
    };
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        endpoints: [endpoint],
        operation,
        reservation: scenarioReservation({ phase: "reserved" }),
      }),
    );
    const blocks: RecordedBlock[] = [];
    const stale = workflowFor(world, blocks);
    const owner = workflowFor(world, blocks);
    const jobs = async () =>
      taskRuntime(await readRuntimeState(runtimeFile(world.home)), SCENARIO_TASK_ID)?.jobs ?? [];

    const claimed = await owner.claimOperation(SCENARIO_TASK_ID);
    if (claimed === undefined) throw new Error("the owner did not take the operation over");
    await stale.launchAgent(task, claimed, endpoint, "scout");
    expect(await jobs()).toEqual([]);

    await owner.launchAgent(task, claimed, endpoint, "scout");
    const launched = await jobs();
    expect(launched).toHaveLength(1);
    expect(launched[0]?.launchAttempted).toBe(true);
    expect(blocks).toEqual([]);
  });
});
