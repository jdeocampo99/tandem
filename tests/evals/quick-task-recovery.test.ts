import { expect, test } from "bun:test";
import type { TandemService } from "../../src/service/controller.ts";
import { appendTaskMessage } from "../../src/tasks/communication-protocol.ts";
import { quickApproval } from "../../src/tasks/quick.ts";
import { readTimeline } from "../../src/tasks/timeline-store.ts";
import { askScope, serviceFor, TEXT } from "./quick-task-world.ts";
import { SCENARIO_NOW, SCENARIO_TASK_ID, type ScenarioWorld, withScenario } from "./scenario.ts";

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
