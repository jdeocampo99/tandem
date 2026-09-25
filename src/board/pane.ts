import { fileURLToPath } from "node:url";
import { sendCommand, splitBesidePane } from "../adapters/herdr.ts";
import type { CommandRunner, Endpoint } from "../contracts.ts";
import { readSessionSnapshot } from "../coordinator/ownership.ts";

export type BoardPaneDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly home: string;
  readonly sessionId: string;
  /** The coordinator's own pane; the board opens as a split beside it and never touches it. */
  readonly coordinatorPaneId: string;
}>;

/** The terminal command that draws the live board for this Tandem home. */
export function boardCommand(home: string): readonly string[] {
  return ["bun", fileURLToPath(new URL("../main.ts", import.meta.url)), "board", "--home", home];
}

/**
 * Makes sure the board is on screen: keeps `shown` while that pane still exists, whatever the user
 * left running in it, and otherwise opens `tandem board` in a new split beside the coordinator.
 * Returns the pane showing the board.
 */
export async function showBoardPane(
  deps: BoardPaneDependencies,
  cwd: string,
  shown: Endpoint | undefined,
): Promise<Endpoint> {
  if (shown !== undefined) {
    const panes = await readSessionSnapshot(deps.run, deps.sessionId, cwd, true);
    if (panes.some((pane) => pane.paneId === shown.paneId)) return shown;
  }
  const { endpoint } = await splitBesidePane(deps.run, {
    sessionId: deps.sessionId,
    cwd,
    anchorPaneId: deps.coordinatorPaneId,
    role: "coordinator",
    generation: 0,
  });
  await sendCommand(deps.run, { endpoint, cwd, command: boardCommand(deps.home) });
  return endpoint;
}
