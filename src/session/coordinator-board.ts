import { type BoardRow, type BoardView, notifiesUser } from "../board/view.ts";
import type { TandemService } from "../service/controller.ts";
import type { CoordinatorDeps } from "./coordinator.ts";
import { isInRepository } from "./coordinator-status.ts";

/** Publishes each board heartbeat and notifies once when this project's rows newly need the user. */
export class CoordinatorBoard {
  private needsYouSeen: ReadonlySet<string> | undefined;
  private snapshotFailing = false;

  constructor(
    private readonly deps: Pick<CoordinatorDeps, "environment" | "realpath" | "logError">,
  ) {}

  async publish(service: TandemService, board: BoardView): Promise<void> {
    await this.notifyOnArrival(service, board.needsYou);
    await this.saveBoardSnapshot(service, board);
  }

  /**
   * Sends one Herdr notification when rows of this project's that {@link notifiesUser} accepts
   * land in "Needs you". What was already there when the coordinator started counts as seen, so a
   * relaunch notifies nothing.
   */
  private async notifyOnArrival(service: TandemService, rows: readonly BoardRow[]): Promise<void> {
    const current = new Map<string, BoardRow>();
    if (rows.length > 0) {
      const repo = await this.deps.realpath(this.deps.environment.repo);
      for (const row of rows) {
        if (row.repoPath === undefined || !notifiesUser(row)) continue;
        if (await isInRepository(row.repoPath, repo, this.deps.realpath)) current.set(row.key, row);
      }
    }
    const seen = this.needsYouSeen;
    this.needsYouSeen = new Set(current.keys());
    if (seen === undefined) return;
    const arrived = [...current.values()].filter((row) => !seen.has(row.key));
    if (arrived.length === 0) return;
    await service
      .notifyNeedsYou(this.deps.environment.repo, arrived)
      .catch((error: unknown) =>
        this.deps.logError("Tandem could not show a Herdr notification", error),
      );
  }

  /**
   * Writes the panel's snapshot on every reconcile, since its age tells panels a coordinator is
   * alive. A failure never blocks the reconcile and is logged once until a write succeeds again.
   */
  private async saveBoardSnapshot(service: TandemService, board: BoardView): Promise<void> {
    try {
      await service.writeBoardSnapshot(board);
      this.snapshotFailing = false;
    } catch (error) {
      if (!this.snapshotFailing) {
        this.deps.logError("Tandem could not save the board for the panel", error);
      }
      this.snapshotFailing = true;
    }
  }
}
