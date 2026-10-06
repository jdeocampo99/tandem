import { expect, test } from "bun:test";
import { join } from "node:path";
import { Readable } from "node:stream";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runTerminal } from "../../src/main.ts";
import { Outcome } from "../../src/native/contract.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

/** A PR comment from the task page: the project's coordinator owns pane 101, the click's origin. */
async function comment(world: ScenarioWorld, service: TandemService, text: string) {
  const lease = await world.grantLease({ name: "coordinator", holder: "coordinator:test" });
  const pane = world.openPane({ paneId: "101", cwd: lease.path });
  const command = ["omp", "--cwd", lease.path, "--session-dir", join(world.home, "conversation")];
  world.replaceForeground("101", command);
  await saveCoordinatorRecord(world.home, {
    schemaVersion: 1,
    repoPath: world.repoPath,
    endpoint: { ...pane, role: "coordinator" },
    command,
    harness: DEFAULT_HARNESS,
    worktree: lease,
  });
  const output: string[] = [];
  await runTerminal(["native", "act"], {
    input: Readable.from([
      JSON.stringify({
        v: 1,
        origin: { pane: "101", cwd: lease.path },
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
    await withScenario({}, async (world) => {
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
  await withScenario({}, async (world) => {
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
