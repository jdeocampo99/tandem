import { expect, test } from "bun:test";
import type { PullRequestMetadata, SteerTaskInput, TaskStage } from "../../src/contracts.ts";
import { prWatchTaskCallbacks } from "../../src/service/pr-watch-tasks.ts";
import { type TaskEvent, transitionTask } from "../../src/tasks/lifecycle.ts";
import { type ScenarioWorld, seedScenarioTask, withScenario } from "../evals/scenario.ts";

const pullRequest: PullRequestMetadata = {
  repository: "acme/app",
  number: 7,
  state: "open",
  head: "recorded-head",
  base: "main",
  url: "https://github.com/acme/app/pull/7",
  title: "Keep the task moving",
};

function callbacksFor(
  world: ScenarioWorld,
  overrides: Partial<Parameters<typeof prWatchTaskCallbacks>[0]> = {},
) {
  const effects: string[] = [];
  const directions: SteerTaskInput[] = [];
  const transitions: TaskEvent[] = [];
  const callbacks = prWatchTaskCallbacks({
    sourceRepoPath: world.repoPath,
    store: {
      read: async (id) => {
        effects.push("read");
        return world.store.read(id);
      },
    },
    taskInScope: async (task) => {
      effects.push("scope");
      return task.repoPath === world.repoPath;
    },
    steer: async (input) => {
      effects.push("steer");
      directions.push(input);
      return { taskId: input.taskId, stage: "implementing", revision: 1, messages: [] };
    },
    transition: async (id, event) => {
      effects.push("transition");
      transitions.push(event);
      const task = await world.store.read(id);
      if (task === undefined) throw new Error(`missing test task ${id}`);
      return world.store.update(id, task.revision, (current) =>
        transitionTask(current, event, { now: world.clock(), notificationId: world.idFactory() }),
      );
    },
    ...overrides,
  });
  return { callbacks, effects, directions, transitions };
}

test("steering without a coordinator project does not read the task", async () => {
  await withScenario({}, async (world) => {
    const { callbacks, effects } = callbacksFor(world, { sourceRepoPath: undefined });
    expect(await callbacks.steerTask("task-1", "resolve conflicts")).toBe(false);
    expect(effects).toEqual([]);
  });
});

test("missing and foreign tasks receive neither directions nor merge transitions", async () => {
  await withScenario({}, async (world) => {
    const foreign = await seedScenarioTask(world, {
      kind: "implementation",
      repoPath: "/another/project",
      stage: "ready",
      pullRequest,
    });
    const { callbacks, effects, directions, transitions } = callbacksFor(world);
    expect(await callbacks.steerTask("missing-task", "resolve conflicts")).toBe(false);
    await callbacks.recordMerged("missing-task", "remote-head");
    expect(effects).toEqual(["read", "read"]);
    effects.length = 0;
    expect(await callbacks.steerTask(foreign.id, "resolve conflicts")).toBe(false);
    await callbacks.recordMerged(foreign.id, "remote-head");
    expect(effects).toEqual(["read", "scope", "read", "scope"]);
    expect(directions).toEqual([]);
    expect(transitions).toEqual([]);
    expect(await world.store.read(foreign.id)).toEqual(foreign);
  });
});

test("steering waits for the scoped task's direction to finish", async () => {
  await withScenario({}, async (world) => {
    const task = await seedScenarioTask(world, { kind: "implementation", stage: "ready" });
    const done = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<SteerTaskInput>();
    const { callbacks, effects } = callbacksFor(world, {
      steer: async (input) => {
        entered.resolve(input);
        await done.promise;
        return { taskId: input.taskId, stage: "implementing", revision: 1, messages: [] };
      },
    });
    let settled = false;
    const steering = callbacks.steerTask(task.id, "  merge origin/main\nresolve conflicts  ");
    void steering.then(() => {
      settled = true;
    });
    expect(await entered.promise).toEqual({
      taskId: task.id,
      text: "  merge origin/main\nresolve conflicts  ",
    });
    expect(effects).toEqual(["read", "scope"]);
    expect(settled).toBe(false);
    done.resolve();
    expect(await steering).toBe(true);
    expect(settled).toBe(true);
  });
});

test("only a ready task with a pull request records a merge", async () => {
  await withScenario({}, async (world) => {
    const stages: readonly TaskStage[] = [
      "queued",
      "implementing",
      "paused",
      "cancelled",
      "merged",
    ];
    const { callbacks, effects, transitions } = callbacksFor(world);
    for (const stage of stages) {
      const task = await seedScenarioTask(world, {
        id: `task-${stage}`,
        kind: "implementation",
        stage,
        pullRequest,
      });
      await callbacks.recordMerged(task.id, "remote-head");
      expect(await world.store.read(task.id)).toEqual(task);
    }
    const noPr = await seedScenarioTask(world, { kind: "implementation", stage: "ready" });
    await callbacks.recordMerged(noPr.id, "remote-head");
    expect(await world.store.read(noPr.id)).toEqual(noPr);
    expect(effects).toEqual(
      Array.from({ length: stages.length + 1 }, () => ["read", "scope"]).flat(),
    );
    expect(transitions).toEqual([]);
  });
});

test("merge recording retains metadata and uses the observed head or the recorded fallback", async () => {
  await withScenario({}, async (world) => {
    const { callbacks, transitions } = callbacksFor(world, { sourceRepoPath: undefined });
    for (const head of ["remote-head", undefined]) {
      const task = await seedScenarioTask(world, {
        id: head === undefined ? "task-fallback" : "task-observed",
        kind: "implementation",
        stage: "ready",
        pullRequest,
      });
      await callbacks.recordMerged(task.id, head);
      expect(transitions.at(-1)).toEqual({
        type: "merged-on-github",
        pullRequest: { ...pullRequest, state: "merged", head: head ?? pullRequest.head },
      });
      const merged = await world.store.read(task.id);
      expect(merged?.stage).toBe("merged");
      expect(merged?.pullRequest).toEqual({
        ...pullRequest,
        state: "merged",
        head: head ?? pullRequest.head,
      });
    }
  });
});

test("read, scope, steering and merge errors propagate to the watcher", async () => {
  await withScenario({}, async (world) => {
    const task = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "ready",
      pullRequest,
    });
    const failure = new Error("task callback failed");
    const fail = async (): Promise<never> => {
      throw failure;
    };
    for (const overrides of [{ store: { read: fail } }, { taskInScope: fail }]) {
      const { callbacks, directions, transitions } = callbacksFor(world, overrides);
      await expect(callbacks.steerTask(task.id, "resolve conflicts")).rejects.toBe(failure);
      await expect(callbacks.recordMerged(task.id, "remote-head")).rejects.toBe(failure);
      expect(directions).toEqual([]);
      expect(transitions).toEqual([]);
    }
    const steering = callbacksFor(world, { steer: fail });
    await expect(steering.callbacks.steerTask(task.id, "resolve conflicts")).rejects.toBe(failure);
    const merging = callbacksFor(world, { transition: fail });
    await expect(merging.callbacks.recordMerged(task.id, "remote-head")).rejects.toBe(failure);
    expect(await world.store.read(task.id)).toEqual(task);
  });
});
