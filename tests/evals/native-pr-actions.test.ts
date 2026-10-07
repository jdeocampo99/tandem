import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { nativePrFile } from "../../src/board/native-views.ts";
import { runTerminal } from "../../src/main.ts";
import { blockArgs, Outcome } from "../../src/native/contract.ts";
import { viewDetailPath, viewIndexPath } from "../../src/native/store.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { prIndexEntry, publishFixture } from "../native/view-files.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  seedTernProject,
  withScenario,
} from "./scenario.ts";

/**
 * A PR comment from the PR pane: the project's Tern coordinator owns pane 101, and pane 103 is the
 * `tandem.pr` block it opened for the task's published PR, the click's origin. A `worker` sender
 * is a shell in the project's session (pane 104) that pipes the same envelope with its own pane.
 */
async function comment(
  world: ScenarioWorld,
  service: TandemService,
  text: string,
  sender: "block" | "worker" = "block",
) {
  const project = await seedTernProject(world, { coordinatorPaneId: "101", helperPaneId: "102" });
  world.routeTernOpen(async () => {
    throw new Error("A PR comment opens no view");
  });
  await publishFixture(world.home, world.repoPath, {
    pullRequests: prIndexEntry("owner/repo", 42, SCENARIO_TASK_ID),
  });
  const args = blockArgs(
    viewDetailPath(world.home, world.repoPath, nativePrFile("owner/repo", 42)),
    {
      coordinator: project.coordinator.paneId,
      cwd: project.worktree.path,
      home: world.home,
      index: viewIndexPath(world.home, world.repoPath),
    },
  );
  world.openPane({
    paneId: "103",
    cwd: project.worktree.path,
    blockProgram: "tandem.pr",
    blockArgs: args,
    anchor: project.coordinator,
  });
  if (sender === "worker")
    world.openPane({ paneId: "104", cwd: project.worktree.path, terminalSessionId: "100" });
  const output: string[] = [];
  await runTerminal(["native", "act"], {
    input: Readable.from([
      JSON.stringify({
        v: 1,
        origin: { pane: sender === "block" ? "103" : "104", ctx: args[1] },
        action: { verb: "pr-comment", taskId: SCENARIO_TASK_ID, text },
      }),
    ]),
    cwd: world.repoPath,
    processEnvironment: {
      TANDEM_HOME: world.home,
      TANDEM_SESSION: world.sessionId,
      TANDEM_POOL_ROOT: world.poolRoot,
    },
    run: world.run,
    service,
    stdout: (value) => output.push(value),
    stderr: () => {},
  });
  return Outcome.parse(JSON.parse(output.join("")));
}

for (const state of ["draft", "open"] as const) {
  test(`a PR comment on a ready ${state} PR starts a fix generation after its worker finished`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
      await seedScenarioTask(world, {
        kind: "implementation",
        stage: "ready",
        reviewHead: SCENARIO_HEAD,
        worktree: lease,
        endpoints: [],
        pullRequest: {
          repository: "owner/repo",
          number: 42,
          state,
          head: SCENARIO_HEAD,
          base: "main",
        },
      });
      await seedScenarioRuntime(
        world,
        scenarioRuntimeTask({ worktree: lease, endpoints: [], jobs: [] }),
      );
      const service = createTandemService({
        home: world.home,
        sessionId: world.sessionId,
        poolRoot: world.poolRoot,
        run: world.run,
        clock: world.clock,
        idFactory: world.idFactory,
        workerTimeoutMs: 1500,
      });
      try {
        expect(await comment(world, service, "Fix src/view.ts:12")).toEqual({ status: "done" });
        const task = await service.get(SCENARIO_TASK_ID);
        expect(task.stage).toBe("implementing");
        expect(task.generation).toBe(1);
        expect(task.worktree?.leaseId).toBe(lease.leaseId);
        expect(task.communication?.messages[0]?.text).toContain(
          "PR fix request: Fix src/view.ts:12",
        );
        const snapshot = await world.snapshot();
        expect(snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob)?.generation).toBe(1);
        expect(snapshot.runtime.tasks[0]?.jobs.find(activeRuntimeJob)?.cwd).toBe(lease.path);
        expect(snapshot.trace.some((event) => event.action === "treehouse get")).toBe(false);
      } finally {
        await service.shutdown();
      }
    });
  }, 20_000);
}

test("a ready PR whose fix cannot start reports the saved feedback and blocker", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "ready",
      endpoints: [],
      pullRequest: {
        repository: "owner/repo",
        number: 42,
        state: "open",
        head: SCENARIO_HEAD,
        base: "main",
      },
    });
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    try {
      const result = await comment(world, service, "Fix this");
      // The direction is saved; a refusal would invite sending it again.
      expect(result.status).toBe("kept");
      expect(result.notice?.code).toBe("feedback-saved");
      expect(result.notice?.text).toContain(
        "PR feedback was saved, but the worker could not start fixing",
      );
      expect(result.notice?.text).toContain("no reviewed work");
      expect((await service.get(SCENARIO_TASK_ID)).communication?.messages[0]?.text).toContain(
        "PR fix request: Fix this",
      );
    } finally {
      await service.shutdown();
    }
  });
});

test("a worker shell in the project's session cannot pass its PR comment off as the user's click", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "ready",
      endpoints: [],
      pullRequest: {
        repository: "owner/repo",
        number: 42,
        state: "open",
        head: SCENARIO_HEAD,
        base: "main",
      },
    });
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    try {
      const result = await comment(world, service, "Widen the scope", "worker");
      expect(result.status).toBe("refused");
      expect(result.notice?.code).toBe("origin-unproven");
      const task = await service.get(SCENARIO_TASK_ID);
      expect(task.communication?.messages ?? []).toEqual([]);
      expect(task.stage).toBe("ready");
    } finally {
      await service.shutdown();
    }
  });
});
