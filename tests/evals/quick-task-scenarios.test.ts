import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { boardView } from "../../src/board/view.ts";
import type { CommandRunner, QuickScopeReport, TaskRecord } from "../../src/contracts.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { quickApproval, quickScopeQuestionText } from "../../src/tasks/quick.ts";
import { readTimeline } from "../../src/tasks/timeline-store.ts";
import { persistWorkerResult, type WorkerJob } from "../../src/workers/jobs.ts";
import { state } from "../board/fixtures.ts";
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
  withScenario,
} from "./scenario.ts";

const TEXT = "Rename the Save button to Save draft on the settings page";
const SCOPE: QuickScopeReport = {
  files: 14,
  areas: ["billing", "settings"],
  decision: "whether drafts expire",
  plan: "turn it into a request with a brief",
};

function serviceFor(world: ScenarioWorld, run: CommandRunner = world.run): TandemService {
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

test("Start records the user's approval and dispatches an ordinary implementation task", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);

    await expect(
      service.startQuickTask({ repoPath: world.repoPath, text: "fix it" }),
    ).rejects.toThrow("Describe the change in a sentence or two.");
    expect(await service.list()).toHaveLength(0);

    const task = await service.startQuickTask({
      repoPath: world.repoPath,
      text: `  ${TEXT}\n`,
    });
    expect(task.stage).toBe("queued");
    expect(task.scopeApproved).toBe(true);
    expect(task.kind).toBe("implementation");
    expect(task.objective).toBe(TEXT);
    expect(task.title).toBe(TEXT);
    expect(task.requestId).toBeUndefined();
    expect(task.requiredStages).toEqual({ validation: true, review: true });
    expect(task.quick).toEqual(quickApproval({ text: TEXT, at: SCENARIO_NOW }));
    const { events } = await readTimeline(world.home, task.id);
    expect(events.map((event) => event.type)).toEqual([
      "created",
      "quick-approved",
      "stage-changed",
    ]);

    await service.tick();
    const started = await service.get(task.id);
    expect(started.stage).toBe("implementing");
    const jobPath = (await world.snapshot()).runtime.tasks[0]?.jobs[0]?.jobPath;
    if (jobPath === undefined) throw new Error("the quick task's implementer job was not written");
    const job = JSON.parse(await readFile(jobPath, "utf8")) as WorkerJob;
    expect(job.quickScope).toBe("may-ask");
    expect(job.prompt).toContain("This is a quick task");
    await service.shutdown();
  });
});

test("a quick task whose approval fails is cancelled, never left waiting for an approval", async () => {
  await withScenario({}, async (world) => {
    // The source's HEAD moves once the task is recorded, between creation and approval.
    const run: CommandRunner = async (request) => {
      const [, , , verb, reference] = request.argv;
      if (verb === "rev-parse" && reference === "HEAD" && (await world.store.list()).length > 0)
        return { code: 0, stdout: "moved-head\n", stderr: "" };
      return world.run(request);
    };
    const service = serviceFor(world, run);
    const failure = service.startQuickTask({ repoPath: world.repoPath, text: TEXT });
    await expect(failure).rejects.toThrow("Quick task could not start: source checkpoint");
    const [task] = await service.list();
    if (task === undefined) throw new Error("the quick task was not recorded");
    await expect(failure).rejects.toThrow(`Task ${task.id} was cancelled`);
    expect(task.stage).toBe("cancelled");
    expect(task.scopeApproved).toBe(false);
    await service.shutdown();
  });
});

/** A quick task whose implementer is running, and the path its result lands at. */
async function runningQuickTask(world: ScenarioWorld) {
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
async function askScope(world: ScenarioWorld, service: TandemService): Promise<TaskRecord> {
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

test("the scope question is a question in Needs you, asked once, never a silent block", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    const asked = await askScope(world, service);

    expect(asked.stage).toBe("blocked");
    expect(asked.communication?.question).toMatchObject({ id: "job-1", scope: SCOPE });
    expect(asked.quick?.scopeQuestionId).toBe("job-1");
    const board = boardView(state({ projects: [world.repoPath], tasks: [asked] }), SCENARIO_NOW);
    expect(board.needsYou).toHaveLength(1);
    expect(board.needsYou[0]).toMatchObject({
      cause: "question",
      text: "Scope exceeds quick task",
    });

    await expect(
      service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text: "sure" }),
    ).rejects.toThrow('"Proceed", "Convert to request", "Cancel"');
    expect((await service.get(SCENARIO_TASK_ID)).communication?.question?.id).toBe("job-1");
    await service.shutdown();
  });
});

test("Convert to request cancels the quick task and hands its words and findings to the coordinator", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await askScope(world, service);

    await service.answer({
      taskId: SCENARIO_TASK_ID,
      questionId: "job-1",
      text: "Convert to request",
    });

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("cancelled");
    expect(task.communication?.question).toBeUndefined();
    const handoff = task.notifications.findLast((entry) => entry.kind === "coordinator");
    expect(handoff?.message).toContain(`${SCENARIO_TASK_ID} · Converted to a request`);
    expect(handoff?.message).toContain(JSON.stringify(TEXT));
    expect(handoff?.message).toContain("Affects 14 files across billing and settings.");
    await service.shutdown();
  });
});

test("Cancel cancels the quick task through the ordinary cancel path", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await askScope(world, service);

    await service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text: "Cancel" });

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("cancelled");
    expect(task.communication?.question).toBeUndefined();
    expect(task.notifications.some((entry) => entry.message.includes("Converted"))).toBe(false);
    await service.shutdown();
  });
});

test("Proceed records the stretched scope for review and tells the worker not to ask again", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await askScope(world, service);

    await service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text: "Proceed" });

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.quick?.scopeExtendedAt).toBe(SCENARIO_NOW);
    expect(task.quick?.scopeQuestionId).toBe("job-1");
    expect(task.communication?.question).toBeUndefined();
    expect(task.communication?.messages.at(-1)).toMatchObject({
      kind: "answer",
      replyTo: "job-1",
    });
    expect(task.communication?.messages.at(-1)?.text).toContain("Do not ask about scope again");
    const { events } = await readTimeline(world.home, SCENARIO_TASK_ID);
    expect(events.some((event) => event.type === "quick-scope-extended")).toBe(true);
    await service.shutdown();
  });
});
