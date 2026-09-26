import { join } from "node:path";
import type { Clock, TaskRecord } from "../contracts.ts";
import { withPrWatches } from "../pr-watch/store.ts";
import { createRequestBriefStore } from "../requests/store.ts";
import { withStateTransaction } from "../runtime/database.ts";
import { defaultIdFactory } from "../runtime/persistence.ts";
import { createRequestUsageLedger, readTaskUsage } from "../runtime/usage-ledger.ts";
import { createTaskStore } from "../tasks/store.ts";
import { StoreLockTimeoutError } from "../tasks/store-errors.ts";
import { readTimeline } from "../tasks/timeline-store.ts";
import { type TaskRollup, taskCost, taskRollup } from "../tasks/trace.ts";
import { readRegisteredProjects } from "../terminal/projects.ts";
import { type BoardView, boardView, finishedWithinWeek, withinWeek } from "./view.ts";

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
    return {
      projects,
      tasks: saved,
      briefs: await briefs.list(),
      ...(await withPrWatches(home, ({ watches, poll }) => ({ watches, poll }))),
      finishedThisWeek: await weekRollups(home, clock, saved, now),
    };
  });
  return boardView(state, now);
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
 * Draws the board until the process is interrupted: renders it every {@link BOARD_REFRESH_MS} and
 * draws only when the text changed. A round that finds the state locked by another Tandem is
 * skipped; the next one reads again.
 */
export async function runLiveBoard(
  deps: Readonly<{
    readonly render: () => Promise<string>;
    readonly draw: (text: string) => void;
    readonly sleep: (ms: number) => Promise<void>;
  }>,
): Promise<never> {
  let shown: string | undefined;
  while (true) {
    const text = await deps.render().catch((error: unknown) => {
      if (error instanceof StoreLockTimeoutError) return shown;
      throw error;
    });
    if (text !== undefined && text !== shown) {
      deps.draw(text);
      shown = text;
    }
    await deps.sleep(BOARD_REFRESH_MS);
  }
}
