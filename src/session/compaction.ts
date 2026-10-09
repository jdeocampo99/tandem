import type { TandemEnvironmentSource } from "../config/environment.ts";
import type { TaskRecord } from "../contracts.ts";
import { isTerminalTask } from "../service/records.ts";
import type { SessionDeps, SessionHost } from "./events.ts";

/** Context size, in tokens, past which an idle coordinator compacts once a task finishes. */
export const DEFAULT_COORDINATOR_COMPACT_TOKENS = 128_000;

/** `TANDEM_COORDINATOR_COMPACT_TOKENS`: a whole token count, or `0` to leave compaction to OMP. */
export function coordinatorCompactTokens(source: TandemEnvironmentSource): number {
  const raw = source.TANDEM_COORDINATOR_COMPACT_TOKENS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_COORDINATOR_COMPACT_TOKENS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_COORDINATOR_COMPACT_TOKENS;
}

/**
 * Finished implementation tasks. A finished scout is left out: its report usually opens the
 * conversation about what to build next, so it is the wrong moment to drop chat history.
 */
export function finishedTaskIds(tasks: readonly TaskRecord[]): Set<string> {
  return new Set(
    tasks.filter((task) => task.kind !== "scout" && isTerminalTask(task)).map((task) => task.id),
  );
}

function waitsOnUser(task: TaskRecord): boolean {
  return (
    task.stage === "blocked" ||
    task.stage === "paused" ||
    task.stage === "awaiting-approval" ||
    task.stage === "ready" ||
    task.notifications.some((notification) => !notification.acknowledged)
  );
}

/**
 * Whether the coordinator is at a safe point to compact early: a task finished since the last
 * compaction, the coordinator is idle, and no task in this repository is waiting on the user.
 * Running tasks do not block it; their state is re-added from the durable digest.
 */
export function atCompactionBoundary(
  tasks: readonly TaskRecord[],
  state: Readonly<{ readonly taskFinished: boolean; readonly idle: boolean }>,
): boolean {
  return state.taskFinished && state.idle && !tasks.some(waitsOnUser);
}

/** Compacts once per newly finished non-scout task, when the coordinator is idle and over budget. */
export class EarlyCompaction {
  private knownFinished: Set<string> | undefined;
  private taskFinished = false;
  private compacting: boolean = false;

  constructor(
    private readonly compactTokens: number,
    private readonly host: SessionHost,
    private readonly logError: SessionDeps["logError"],
  ) {}

  /** Uses every listed task, like the digest and notifications, because this coordinator sees them all. */
  compactIfAtBoundary(tasks: readonly TaskRecord[], idle: boolean): void {
    if (this.compactTokens === 0 || !this.host.capabilities.proactiveCompaction) return;
    const finished = finishedTaskIds(tasks);
    const previous = this.knownFinished;
    if (previous !== undefined && [...finished].some((id) => !previous.has(id))) {
      this.taskFinished = true;
    }
    this.knownFinished = finished;
    if (
      this.compacting ||
      !atCompactionBoundary(tasks, { taskFinished: this.taskFinished, idle })
    ) {
      return;
    }
    // The boundary is used up either way, so a later unrelated idle moment never compacts.
    this.taskFinished = false;
    const tokens = this.host.contextTokens();
    if (tokens === undefined || tokens < this.compactTokens) return;
    this.compacting = true;
    // Not awaited: compaction re-enters the session through `compacted`, which reconciles, and
    // this runs inside `reconcile`.
    void this.host
      .perform({ type: "compact" })
      .catch((error: unknown) => this.logError("Tandem extension operation failed", error))
      .finally(() => {
        this.compacting = false;
      });
  }
}
