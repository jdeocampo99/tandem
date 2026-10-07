import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { boardView } from "../../src/board/view.ts";
import type { CommandRunner, QuickScopeReport, TaskRecord } from "../../src/contracts.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { appendTaskMessage } from "../../src/tasks/communication-protocol.ts";
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

test("an open scope question refuses resume and restart, so nothing implements without Proceed", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await askScope(world, service);

    await expect(service.resume(SCENARIO_TASK_ID)).rejects.toThrow(
      '"Proceed", "Convert to request", "Cancel"',
    );
    await expect(service.restart(SCENARIO_TASK_ID)).rejects.toThrow("unanswered question");

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.communication?.question?.id).toBe("job-1");
    expect(task.quick?.scopeExtendedAt).toBeUndefined();

    // Proceed is the one way on: it records the stretched scope, then resumes.
    await service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text: "Proceed" });
    expect((await service.get(SCENARIO_TASK_ID)).stage).not.toBe("blocked");
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

test("Cancel or Convert whose worker cannot be proven stopped is refused and keeps the question open", async () => {
  for (const text of ["Cancel", "Convert to request"]) {
    await withScenario({}, async (world) => {
      const service = serviceFor(world);
      await askScope(world, service);
      world.failAt({ boundary: "herdr", action: "herdr pane process-info" });

      await expect(
        service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text }),
      ).rejects.toThrow("could not be stopped yet");

      const task = await service.get(SCENARIO_TASK_ID);
      expect(task.stage).toBe("blocked");
      expect(task.communication?.question?.id).toBe("job-1");
      expect(task.notifications.some((entry) => entry.message.includes("Converted"))).toBe(false);

      // Once the pane can be proven stopped, the same answer goes through.
      await service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text });
      const answered = await service.get(SCENARIO_TASK_ID);
      expect(answered.stage).toBe("cancelled");
      expect(answered.communication?.question).toBeUndefined();
      expect(answered.notifications.some((entry) => entry.message.includes("Converted"))).toBe(
        text === "Convert to request",
      );
      await service.shutdown();
    });
  }
});

/** The answer's first write alone, as a crash right after it would leave the task. */
async function recordAnswerOnly(world: ScenarioWorld, choice: "proceed" | "convert" | "cancel") {
  const task = await world.store.read(SCENARIO_TASK_ID);
  if (task?.quick === undefined) throw new Error("the scenario task is not quick");
  const quick = task.quick;
  await world.store.update(task.id, task.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    quick: {
      ...quick,
      scopeAnswer: { choice, at: SCENARIO_NOW },
      ...(choice === "proceed" ? { scopeExtendedAt: SCENARIO_NOW } : {}),
    },
  }));
}

/** What a finished answer changed; a second finish must leave every count alone. */
async function answerEffects(service: TandemService) {
  const task = await service.get(SCENARIO_TASK_ID);
  return {
    stage: task.stage,
    question: task.communication?.question?.id,
    answers: task.communication?.messages.filter((entry) => entry.kind === "answer").length ?? 0,
    handoffs: task.notifications.filter((entry) => entry.message.includes("Converted")).length,
  };
}

test("a crash after a scope answer is recorded is finished once by the next tick", async () => {
  for (const choice of ["proceed", "convert", "cancel"] as const) {
    await withScenario({}, async (world) => {
      const service = serviceFor(world);
      await askScope(world, service);
      await recordAnswerOnly(world, choice);
      expect((await service.get(SCENARIO_TASK_ID)).communication?.question?.id).toBe("job-1");

      await service.tick();
      const finished = await answerEffects(service);
      expect(finished.question).toBeUndefined();
      if (choice === "proceed") {
        expect(finished.answers).toBe(1);
        expect(finished.stage).not.toBe("cancelled");
      } else {
        expect(finished.stage).toBe("cancelled");
        expect(finished.answers).toBe(0);
        expect(finished.handoffs).toBe(choice === "convert" ? 1 : 0);
      }

      // A finished answer is never applied again, by a tick or by answering again.
      await service.tick();
      await expect(
        service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text: "Cancel" }),
      ).rejects.toThrow();
      expect(await answerEffects(service)).toEqual(finished);
      await service.shutdown();
    });
  }
});

test("a crash after Convert cancelled the task but before the handoff is finished with one handoff", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await askScope(world, service);
    await recordAnswerOnly(world, "convert");
    expect((await service.cancel(SCENARIO_TASK_ID, "crash test")).stage).toBe("cancelled");

    await service.tick();
    await service.tick();
    expect(await answerEffects(service)).toEqual({
      stage: "cancelled",
      question: undefined,
      answers: 0,
      handoffs: 1,
    });
    await service.shutdown();
  });
});

test("a different answer after one is recorded finishes the recorded one and is refused", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await askScope(world, service);
    await recordAnswerOnly(world, "cancel");

    await expect(
      service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text: "Proceed" }),
    ).rejects.toThrow('already answered "Cancel"');
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("cancelled");
    expect(task.quick?.scopeExtendedAt).toBeUndefined();
    expect(task.communication?.question).toBeUndefined();
    await service.shutdown();
  });
});

test("a crash between Proceed's answer and its resume is resumed once by the next tick", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await askScope(world, service);
    await recordAnswerOnly(world, "proceed");
    // The worker was told and the question closed, but the resume after it was lost.
    const task = await world.store.read(SCENARIO_TASK_ID);
    if (task?.communication === undefined) throw new Error("the scope question was not asked");
    const communication = appendTaskMessage(task.communication, {
      id: "answer-1",
      kind: "answer",
      text: "Proceed",
      createdAt: SCENARIO_NOW,
      replyTo: "job-1",
    });
    await world.store.update(task.id, task.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      communication,
    }));
    expect((await service.get(SCENARIO_TASK_ID)).stage).toBe("blocked");

    await service.tick();
    const resumed = await answerEffects(service);
    expect(resumed.stage).not.toBe("blocked");
    expect(resumed.answers).toBe(1);
    await service.tick();
    expect(await answerEffects(service)).toEqual(resumed);
    // Resumed as the answer, once, not by recovery spending a restart.
    const { events } = await readTimeline(world.home, SCENARIO_TASK_ID);
    const unblocked = events.filter((event) => event.type === "unblocked");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]).toMatchObject({ cause: "Its question was answered." });
    expect(events.some((event) => event.type === "restarted")).toBe(false);
    await service.shutdown();
  });
});

test("a completed Proceed is not resumed again by a tick", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    await askScope(world, service);
    await service.answer({ taskId: SCENARIO_TASK_ID, questionId: "job-1", text: "Proceed" });
    const answered = await service.get(SCENARIO_TASK_ID);
    expect(answered.stage).not.toBe("blocked");
    await service.tick();
    const ticked = await service.get(SCENARIO_TASK_ID);
    expect(ticked.stage).toBe(answered.stage);
    expect(ticked.communication?.messages.length).toBe(answered.communication?.messages.length);
    await service.shutdown();
  });
});

test("a quick task whose Start stopped before approval is cancelled by a tick after the grace", async () => {
  await withScenario({}, async (world) => {
    const service = serviceFor(world);
    const created = await service.create({
      repoPath: world.repoPath,
      kind: "implementation",
      objective: TEXT,
      acceptanceCriteria: [],
      surfaces: ["*"],
    });
    expect(created.stage).toBe("awaiting-approval");
    await world.store.update(created.id, created.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      quick: quickApproval({ text: TEXT, at: SCENARIO_NOW }),
    }));

    await service.tick();
    expect((await service.get(created.id)).stage).toBe("awaiting-approval");
    world.advanceClock(1);
    await service.tick();
    const cancelled = await service.get(created.id);
    expect(cancelled.stage).toBe("cancelled");
    expect(JSON.stringify(cancelled)).toContain("Quick task did not finish starting");
    await service.shutdown();
  });
});
