import { join } from "node:path";
import type { Clock, IsoTimestamp, TaskRecord } from "../contracts.ts";
import { withPrWatches } from "../pr-watch/store.ts";
import { recoveryCounters, restartsUsedThisGeneration } from "../recovery/central-reentry.ts";
import { createRequestBriefStore } from "../requests/store.ts";
import {
  activeRuntimeJob,
  currentPrimaryJobs,
  latestPrimaryReceipt,
  taskRuntime,
} from "../runtime/activity.ts";
import { withStateTransaction } from "../runtime/database.ts";
import { defaultIdFactory, readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import type { RuntimeState } from "../runtime/schema.ts";
import { createRequestUsageLedger, readTaskUsage } from "../runtime/usage-ledger.ts";
import { createTaskStore } from "../tasks/store.ts";
import { StoreLockTimeoutError } from "../tasks/store-errors.ts";
import { readTimeline } from "../tasks/timeline-store.ts";
import { type TaskRollup, taskCost, taskRollup } from "../tasks/trace.ts";
import { readRegisteredProjects } from "../terminal/projects.ts";
import { readWorkerActivity, type WorkerActivity } from "../workers/worker-activity.ts";
import {
  type BoardView,
  boardView,
  finishedWithinWeek,
  isRunningStage,
  type WorkerPane,
  withinWeek,
} from "./view.ts";

/** How often the live board re-reads saved state. */
const BOARD_REFRESH_MS = 2_000;

/** The board across every onboarded project, from one read of `state.sqlite`; never GitHub. */
export async function readBoard(home: string, clock: Clock): Promise<BoardView> {
  const idFactory = defaultIdFactory();
  const tasks = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  const briefs = createRequestBriefStore({ home, clock, idFactory });
  const projects = await readRegisteredProjects(home);
  const now = clock();
  const state = await withStateTransaction(home, async () => {
    const saved = await tasks.list();
    const runtime = await readRuntimeState(runtimeFile(home));
    return {
      projects,
      tasks: saved,
      briefs: await briefs.list(),
      routingPauses: runtime.tasks.flatMap((entry) =>
        entry.routingPause === undefined ? [] : [entry.routingPause],
      ),
      ...(await withPrWatches(home, ({ watches, poll }) => ({ watches, poll }))),
      finishedThisWeek: await weekRollups(home, clock, saved, now),
      progressAt: await progressTimes(saved, runtime),
      workerPanes: workerPanes(saved, runtime),
      activities: await workerActivities(saved, runtime),
      restarts: restartsSpent(saved, runtime),
    };
  });
  return boardView(state, now);
}

/** When each running task's worker last made progress, from its newest receipt. */
async function progressTimes(
  tasks: readonly TaskRecord[],
  runtime: RuntimeState,
): Promise<ReadonlyMap<string, IsoTimestamp>> {
  const times = new Map<string, IsoTimestamp>();
  for (const task of tasks) {
    if (!isRunningStage(task.stage)) continue;
    const receipt = await latestPrimaryReceipt(task, taskRuntime(runtime, task.id));
    if (receipt !== undefined) times.set(task.id, receipt.progressAt);
  }
  return times;
}

/** What each running task's newest primary worker with an activity file is doing. */
async function workerActivities(
  tasks: readonly TaskRecord[],
  runtime: RuntimeState,
): Promise<ReadonlyMap<string, WorkerActivity>> {
  const activities = new Map<string, WorkerActivity>();
  for (const task of tasks) {
    if (!isRunningStage(task.stage)) continue;
    for (const job of currentPrimaryJobs(task, taskRuntime(runtime, task.id))) {
      if (job.receiptPath === undefined) continue;
      const activity = await readWorkerActivity(job.receiptPath);
      if (activity === undefined) continue;
      activities.set(task.id, activity);
      break;
    }
  }
  return activities;
}

/** Where each running task's live primary worker runs, from its job's Herdr endpoint. */
function workerPanes(
  tasks: readonly TaskRecord[],
  runtime: RuntimeState,
): ReadonlyMap<string, WorkerPane> {
  const panes = new Map<string, WorkerPane>();
  for (const task of tasks) {
    if (!isRunningStage(task.stage)) continue;
    const endpoint = currentPrimaryJobs(task, taskRuntime(runtime, task.id)).find(
      (job) => activeRuntimeJob(job) && job.endpoint !== undefined,
    )?.endpoint;
    if (endpoint === undefined) continue;
    panes.set(task.id, {
      terminal: endpoint.terminal,
      workspaceId: endpoint.workspaceId,
      paneId: endpoint.paneId,
    });
  }
  return panes;
}

/** The automatic restarts recovery spent on each blocked task's current generation. */
function restartsSpent(
  tasks: readonly TaskRecord[],
  runtime: RuntimeState,
): ReadonlyMap<string, number> {
  const restarts = new Map<string, number>();
  for (const task of tasks) {
    if (task.stage !== "blocked") continue;
    const used = restartsUsedThisGeneration(
      recoveryCounters(taskRuntime(runtime, task.id)),
      task.generation,
    );
    if (used > 0) restarts.set(task.id, used);
  }
  return restarts;
}

/** Rollups, with cost, of the tasks whose timeline says they finished in the last 7 days. */
async function weekRollups(
  home: string,
  clock: Clock,
  tasks: readonly TaskRecord[],
  now: string,
): Promise<readonly TaskRollup[]> {
  const ledger = createRequestUsageLedger({ home, clock });
  const rollups: TaskRollup[] = [];
  // A task that finished this week was also updated this week, so older ones need no timeline read.
  for (const task of tasks) {
    if (task.stage !== "completed" && task.stage !== "merged") continue;
    if (!withinWeek(task.updatedAt, now)) continue;
    const { events } = await readTimeline(home, task.id);
    if (!finishedWithinWeek(events, now)) continue;
    const cost = taskCost(await readTaskUsage(ledger, task), task.id);
    rollups.push(taskRollup(task.id, events, now, cost));
  }
  return rollups;
}

/**
 * Draws the board until `closed` settles, or forever without it: renders it every
 * {@link BOARD_REFRESH_MS} and draws only when the text changed. A round that finds the state
 * locked by another Tandem is skipped; the next one reads again. Closing cuts the current sleep
 * short, so nothing keeps the process waiting.
 */
export async function runLiveBoard(
  deps: Readonly<{
    readonly render: () => Promise<string>;
    readonly draw: (text: string) => void;
    readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly closed?: Promise<void>;
  }>,
): Promise<void> {
  const close = new AbortController();
  void deps.closed?.then(() => close.abort());
  let shown: string | undefined;
  while (!close.signal.aborted) {
    const text = await deps.render().catch((error: unknown) => {
      if (error instanceof StoreLockTimeoutError) return shown;
      throw error;
    });
    if (close.signal.aborted) return;
    if (text !== undefined && text !== shown) {
      deps.draw(text);
      shown = text;
    }
    await deps.sleep(BOARD_REFRESH_MS, close.signal);
  }
}
