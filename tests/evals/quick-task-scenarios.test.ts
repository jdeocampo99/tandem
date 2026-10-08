import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { boardView } from "../../src/board/view.ts";
import type { CommandRunner } from "../../src/contracts.ts";
import { quickApproval } from "../../src/tasks/quick.ts";
import { readTimeline } from "../../src/tasks/timeline-store.ts";
import { parseWorkerJob } from "../../src/workers/jobs.ts";
import { state } from "../board/fixtures.ts";
import { askScope, SCOPE, serviceFor, TEXT } from "./quick-task-world.ts";
import { SCENARIO_NOW, SCENARIO_TASK_ID, withScenario } from "./scenario.ts";

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
    const job = parseWorkerJob(JSON.parse(await readFile(jobPath, "utf8")));
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
