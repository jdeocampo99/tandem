import type { SteerTaskInput, TaskCommunicationView, TaskRecord } from "../contracts.ts";
import type { PrWatcherDependencies } from "../pr-watch/watcher.ts";
import type { TaskEvent } from "../tasks/lifecycle.ts";
import type { TaskStore } from "../tasks/store.ts";

type PrWatchTaskDependencies = Readonly<{
  readonly sourceRepoPath: string | undefined;
  readonly store: Pick<TaskStore, "read">;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
  readonly steer: (input: SteerTaskInput) => Promise<TaskCommunicationView>;
  readonly transition: (taskId: string, event: TaskEvent) => Promise<TaskRecord>;
}>;

/** The project that runs a task owns its watcher's steering and merge transitions. */
export function prWatchTaskCallbacks(
  deps: PrWatchTaskDependencies,
): Pick<PrWatcherDependencies, "steerTask" | "recordMerged"> {
  return {
    async steerTask(taskId, instruction) {
      if (deps.sourceRepoPath === undefined) return false;
      const task = await deps.store.read(taskId);
      if (task === undefined || !(await deps.taskInScope(task))) return false;
      await deps.steer({ taskId, text: instruction });
      return true;
    },
    async recordMerged(taskId, head) {
      const task = await deps.store.read(taskId);
      if (task === undefined || !(await deps.taskInScope(task))) return;
      if (task.stage !== "ready" || task.pullRequest === undefined) return;
      await deps.transition(task.id, {
        type: "merged-on-github",
        pullRequest: { ...task.pullRequest, state: "merged", head: head ?? task.pullRequest.head },
      });
    },
  };
}
