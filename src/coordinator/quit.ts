import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CommandRunner, TaskRecord } from "../contracts.ts";
import { activeRuntimeJob } from "../runtime/activity.ts";
import { createTaskStore, type TaskStoreTransaction } from "../tasks/store.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { withCoordinatorLaunchLock } from "./lock.ts";
import { type CoordinatorRecord, canonicalHome, sessionText } from "./record.ts";
import { listCoordinatorRecords } from "./registry.ts";
import {
  closeForceCoordinators,
  collectForceEndpoints,
  type ForceEndpoint,
  findLiveCoordinators,
  forceCloseEndpoint,
  proveForceEndpoint,
  type ResetScope,
  type RetiredCoordinator,
  readResetSelection,
} from "./reset.ts";

const MAX_TITLE_LENGTH = 60;

/** Where a quit acts: every coordinator Tandem recorded for this home and session. */
export type QuitScope = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  /** The terminal pane the caller runs in; a quit that would close it refuses instead. */
  readonly insidePaneId?: string;
}>;

/** A task with a live worker, validation, or review that quitting would stop. */
export type WorkingTask = Readonly<{ readonly id: string; readonly title: string }>;

/** What a quit would close, proven against durable records and the live terminal. */
export type QuitPlan = Readonly<{
  readonly scope: ResetScope;
  readonly coordinators: readonly CoordinatorRecord[];
  /** Panes of tasks' workers and retained terminals that are still live. */
  readonly endpoints: readonly ForceEndpoint[];
  readonly working: readonly WorkingTask[];
}>;

export type QuitReport = Readonly<{
  readonly coordinators: readonly RetiredCoordinator[];
  readonly closedPanes: number;
}>;

function taskTitle(task: TaskRecord): string {
  const text = (task.title ?? task.objective).replace(/\s+/gu, " ").trim();
  return text.length <= MAX_TITLE_LENGTH ? text : `${text.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

/** The tasks whose active job still has a live pane; a job whose pane is gone is not running. */
export function workingTasks(
  tasksById: ReadonlyMap<string, TaskRecord>,
  live: readonly ForceEndpoint[],
): readonly WorkingTask[] {
  const working = new Map<string, WorkingTask>();
  for (const entry of live) {
    const job = entry.job;
    if (job === undefined || !activeRuntimeJob(job)) continue;
    const task = tasksById.get(job.taskId);
    if (task !== undefined) working.set(task.id, { id: task.id, title: taskTitle(task) });
  }
  return [...working.values()];
}

/** The question quit asks before stopping working tasks. */
export function quitQuestion(working: readonly WorkingTask[]): string {
  const count = working.length;
  const titles = working.map((task) => task.title).join(", ");
  return `${count} task${count === 1 ? " is" : "s are"} working: ${titles}. Quit anyway? They restart where they can next time you run tandem.`;
}

export function quitHasNothingToStop(plan: QuitPlan): boolean {
  return plan.coordinators.length === 0 && plan.endpoints.length === 0;
}

function assertNotClosingOwnPane(plan: QuitPlan, insidePaneId: string | undefined): void {
  if (insidePaneId === undefined) return;
  const own = [
    ...plan.coordinators.flatMap((record) => [
      record.endpoint.paneId,
      ...(record.endpoint.notificationPane === undefined
        ? []
        : [record.endpoint.notificationPane.paneId]),
    ]),
    ...plan.endpoints.map((entry) => entry.endpoint.paneId),
  ];
  if (own.includes(insidePaneId)) {
    throw new Error(
      "tandem quit would close the pane it is running in; run it from another pane or terminal, or use the Tandem panel or palette",
    );
  }
}

async function planQuit(
  run: CommandRunner,
  terminal: TerminalBackend,
  scope: QuitScope,
  transaction: TaskStoreTransaction,
): Promise<QuitPlan> {
  if (!(await terminal.sessionRunning({ sessionId: scope.sessionId, cwd: scope.home }))) {
    return {
      scope: { home: scope.home, sessionId: scope.sessionId, repoPaths: [] },
      coordinators: [],
      endpoints: [],
      working: [],
    };
  }
  const records = await listCoordinatorRecords(scope.home, scope.sessionId);
  const resetScope: ResetScope = {
    home: scope.home,
    sessionId: scope.sessionId,
    repoPaths: [...new Set(records.map((record) => record.repoPath))],
  };
  const selection = await readResetSelection(resetScope, transaction);
  const coordinators = await findLiveCoordinators(run, terminal, resetScope);
  const collected = await collectForceEndpoints(terminal, scope.sessionId, selection, []);
  const endpoints: ForceEndpoint[] = [];
  for (const entry of collected.values()) {
    if (await proveForceEndpoint(terminal, entry)) endpoints.push(entry);
  }
  const plan: QuitPlan = {
    scope: resetScope,
    coordinators,
    endpoints,
    working: workingTasks(selection.tasksById, endpoints),
  };
  assertNotClosingOwnPane(plan, scope.insidePaneId);
  return plan;
}

async function withQuitTransaction<Result>(
  scope: QuitScope,
  operation: (home: string, transaction: TaskStoreTransaction) => Promise<Result>,
): Promise<Result> {
  const home = await canonicalHome(scope.home);
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: () => new Date().toISOString(),
    idFactory: randomUUID,
  });
  return store.serialized((transaction) => operation(home, transaction));
}

/** Reads what a quit would stop without changing anything. */
export async function readQuitPlan(
  run: CommandRunner,
  terminal: TerminalBackend,
  input: QuitScope,
): Promise<QuitPlan> {
  const sessionId = sessionText(input.sessionId);
  return withQuitTransaction(input, (home, transaction) =>
    planQuit(run, terminal, { ...input, home, sessionId }, transaction),
  );
}

function partialFailure(
  error: unknown,
  stopped: readonly RetiredCoordinator[],
  closedPanes: number,
): unknown {
  if (stopped.length === 0 && closedPanes === 0) return error;
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(
    `quit closed ${stopped.length} coordinator(s) (${stopped.map((record) => record.repoPath).join(", ")}) and ${closedPanes} worker pane(s) before failing: ${cause}. Run tandem quit again to finish.`,
    { cause: error },
  );
}

/**
 * Stops every saved project's coordinator, then closes each worker pane Tandem recorded, which
 * also closes the Tern session Tandem created once its last pane is gone. Coordinators go first so
 * no scheduler relaunches a worker meanwhile. Tasks, worktrees, branches, PRs, chats and runtime
 * records are left as they are: a worker killed here is recovered as a lost resource at the next
 * launch. A pane Tandem cannot prove its own is never closed, and the quit refuses before closing
 * anything when ownership is ambiguous.
 */
export async function quitTandem(
  run: CommandRunner,
  terminal: TerminalBackend,
  input: QuitScope,
): Promise<QuitReport> {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  const sessionId = sessionText(input.sessionId);
  const home = await canonicalHome(input.home);
  return withCoordinatorLaunchLock(home, sessionId, () =>
    withQuitTransaction({ ...input, home }, async (_home, transaction) => {
      const plan = await planQuit(run, terminal, { ...input, home, sessionId }, transaction);
      const stopped: RetiredCoordinator[] = [];
      let closedPanes = 0;
      try {
        await closeForceCoordinators(run, terminal, plan.scope, plan.coordinators, stopped);
        for (const entry of plan.endpoints) {
          await forceCloseEndpoint(terminal, entry);
          closedPanes += 1;
        }
      } catch (error) {
        throw partialFailure(error, stopped, closedPanes);
      }
      return { coordinators: stopped, closedPanes };
    }),
  );
}
