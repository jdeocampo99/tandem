import { expect, test } from "bun:test";
import { NativeAlerts } from "../../src/board/native-alerts.ts";
import { boardView } from "../../src/board/view.ts";
import type { DurableExecutionRoutingPause } from "../../src/runtime/schema.ts";
import { transitionStoredTask } from "../../src/tasks/store.ts";
import { recordTimelineEvents } from "../../src/tasks/timeline-store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { seedScenarioTask, withScenario } from "../evals/scenario.ts";
import { state } from "./fixtures.ts";

test("durable native alerts emit each blocked/question/draft transition once, including across relaunch", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const task = await seedScenarioTask(world, { kind: "implementation", stage: "implementing" });
    let rejectNext = false;
    const notices: { title: string; body: string }[] = [];
    const deps = {
      home: world.home,
      clock: world.clock,
      run: world.run,
      terminal: {
        ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
        notify: async (target: { title: string; body: string }) => {
          notices.push(target);
          if (rejectNext) throw new Error("unknown delivery");
        },
      },
    };
    let alerts = new NativeAlerts(deps);
    const observe = () =>
      alerts.observe(
        {
          version: 1,
          writtenAt: world.clock(),
          board: boardView(state({ projects: [world.repoPath] }), world.clock()),
          coordinators: [],
        },
        world.repoPath,
        world.sessionId,
      );
    await observe();
    expect(notices).toHaveLength(0);
    const asked = await world.store.update(task.id, task.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: world.clock(),
      communication: {
        revision: 0,
        messages: [],
        question: { id: "scope", text: "Should I change the scope?" },
      },
    }));
    await observe();
    await observe();
    expect(notices.map((notice) => notice.title)).toEqual(["Tandem: Needs you"]);
    const blocked = await transitionStoredTask(
      world.store,
      task.id,
      asked.revision,
      { type: "block", reason: "same problems twice" },
      { now: world.clock(), notificationId: "block" },
    );
    await observe();
    await observe();
    expect(notices.map((notice) => notice.title)).toEqual(["Tandem: Needs you", "Tandem: Stuck"]);
    alerts = new NativeAlerts(deps);
    await observe();
    expect(notices).toHaveLength(2);
    const ready = await world.store.update(task.id, blocked.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: world.clock(),
      pullRequest: {
        repository: "acme/app",
        number: 281,
        state: "draft",
        head: "abc",
        base: "main",
      },
    }));
    await observe();
    await observe();
    expect(notices.map((notice) => notice.title)).toEqual([
      "Tandem: Needs you",
      "Tandem: Stuck",
      "Tandem: Done",
    ]);
    rejectNext = true;
    await world.store.update(task.id, ready.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: world.clock(),
      communication: {
        revision: 0,
        messages: [],
        question: { id: "new-question", text: "A new decision?" },
      },
    }));
    await observe();
    expect(notices).toHaveLength(4);
    alerts = new NativeAlerts(deps);
    await observe();
    await observe();
    expect(notices).toHaveLength(4);
  });
});

for (const stage of ["queued", "scouting"] as const) {
  test(`model routing questions in ${stage} are claimed by decision id across arrival and relaunch`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      const task = await seedScenarioTask(world, { kind: "scout", stage });
      const notices: { title: string; body: string }[] = [];
      const deps = {
        home: world.home,
        clock: world.clock,
        run: world.run,
        terminal: {
          ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
          notify: async (notice: { title: string; body: string }) => {
            notices.push(notice);
          },
        },
      };
      let alerts = new NativeAlerts(deps);
      let pauses: DurableExecutionRoutingPause[] = [];
      const observe = () =>
        alerts.observe(
          {
            version: 1,
            writtenAt: world.clock(),
            coordinators: [],
            board: boardView(
              state({ projects: [world.repoPath], tasks: [task], routingPauses: pauses }),
              world.clock(),
            ),
          },
          world.repoPath,
          world.sessionId,
        );
      await observe();
      pauses = [
        {
          schemaVersion: 1,
          decisionId: "routing-1",
          reason: "pinned-model-absent-from-catalogue",
          taskId: task.id,
          generation: task.generation,
          jobId: "job-routing",
          operationId: "op-routing",
          role: "scout",
          attempt: 0,
          policyDigest: "fixture-policy",
          inputHead: "fixture-head",
          pinnedSelector: "openai-codex/gpt-6-luna",
          pinnedThinking: "xhigh",
          evidenceGaps: ["incumbent-absent-from-catalogue"],
          enabledProviders: ["openai-codex"],
          usageSource: "no-governing-request",
          observedAt: world.clock(),
        },
      ];
      await recordTimelineEvents(world.home, [
        {
          taskId: task.id,
          at: world.clock(),
          type: "admission-waiting",
          reason: "routing-question",
        },
      ]);
      // Relaunch before the first observation of arrival: the durable cursor must not drop it.
      alerts = new NativeAlerts(deps);
      await observe();
      await observe();
      expect(notices).toHaveLength(1);
      expect(notices[0]?.title).toBe("Tandem: Needs you");
      alerts = new NativeAlerts(deps);
      const pause = pauses[0];
      if (!pause) throw new Error("missing pause");
      pauses = [{ ...pause, pinnedSelector: "another/model" }];
      await observe();
      pauses = [];
      await observe();
      pauses = [pause];
      await observe();
      expect(notices).toHaveLength(1);
      pauses = [{ ...pause, decisionId: "routing-2" }];
      await Promise.all([
        observe(),
        new NativeAlerts(deps).observe(
          {
            version: 1,
            writtenAt: world.clock(),
            coordinators: [],
            board: boardView(
              state({ projects: [world.repoPath], tasks: [task], routingPauses: pauses }),
              world.clock(),
            ),
          },
          world.repoPath,
          world.sessionId,
        ),
      ]);
      expect(notices).toHaveLength(2);
      alerts = new NativeAlerts(deps);
      await observe();
      expect(notices).toHaveLength(2);
    });
  });
}
