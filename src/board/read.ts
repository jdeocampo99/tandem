import { join } from "node:path";
import type { Clock } from "../contracts.ts";
import { withPrWatches } from "../pr-watch/store.ts";
import { createRequestBriefStore } from "../requests/store.ts";
import { withStateTransaction } from "../runtime/database.ts";
import { defaultIdFactory } from "../runtime/persistence.ts";
import { createTaskStore } from "../tasks/store.ts";
import { StoreLockTimeoutError } from "../tasks/store-errors.ts";
import { readRegisteredProjects } from "../terminal/projects.ts";
import { type BoardView, boardView } from "./view.ts";

/** How often the live board re-reads saved state. */
const BOARD_REFRESH_MS = 2_000;

/** The board across every onboarded project, from one read of `state.sqlite`; never GitHub. */
export async function readBoard(home: string, clock: Clock): Promise<BoardView> {
  const idFactory = defaultIdFactory();
  const tasks = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  const briefs = createRequestBriefStore({ home, clock, idFactory });
  const projects = await readRegisteredProjects(home);
  const state = await withStateTransaction(home, async () => ({
    projects,
    tasks: await tasks.list(),
    briefs: await briefs.list(),
    ...(await withPrWatches(home, ({ watches, poll }) => ({ watches, poll }))),
  }));
  return boardView(state, clock());
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
