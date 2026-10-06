import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint, TaskRecord } from "../contracts.ts";
import { databasePath, withStateLock } from "../runtime/database.ts";
import { defaultIdFactory, readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import type { RuntimeState } from "../runtime/schema.ts";
import { createTaskStore } from "../tasks/store.ts";
import type { TerminalBackend, WorkspaceListing } from "../terminal-backend/contract.ts";
import { type CoordinatorRecord, canonicalPath } from "./record.ts";
import { listCoordinatorRecords } from "./registry.ts";

/** One repository's task workspaces, in the order they should follow its coordinator. */
export type RenestGroup = Readonly<{
  readonly repoPath: string;
  readonly coordinatorWorkspaceId: string;
  readonly workspaces: readonly Readonly<{
    readonly workspaceId: string;
    readonly taskId: string;
  }>[];
}>;

/** One workspace to move so that it sits directly after `afterWorkspaceId`. */
export type RenestMove = Readonly<{
  readonly repoPath: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly afterWorkspaceId: string;
}>;

/**
 * A workspace carrying Tandem's task label that no durable record names any more. Reported only:
 * a label is never ownership proof, so Tandem does not close it.
 */
export type LeftoverWorkspace = Readonly<{ readonly workspaceId: string; readonly label: string }>;

/** What re-nesting planned, what it moved, and why anything was skipped. */
export type RenestReport = Readonly<{
  readonly planned: readonly RenestMove[];
  readonly moved: number;
  readonly warnings: readonly string[];
  readonly leftovers: readonly LeftoverWorkspace[];
}>;

/** The prefix Tandem gives every task and presentation workspace label. */
const TASK_WORKSPACE_MARKER = "└ ";

/**
 * How long re-nesting waits for the state lock. A coordinator that has just started runs its first
 * scheduler pass under that lock, and re-nesting runs right then, so the usual 5 seconds is too short.
 */
const STATE_LOCK_WAIT_MS = 30_000;

const EMPTY: RenestReport = { planned: [], moved: 0, warnings: [], leftovers: [] };

/**
 * Herdr's `workspace.move` inserts at a gap in the list as it was before the move: index i means
 * "before the workspace now at i". Mirrors that so a plan can be checked without Herdr.
 */
function applyMove(order: readonly string[], workspaceId: string, gap: number): string[] {
  const next: string[] = [];
  order.forEach((id, index) => {
    if (index === gap) next.push(workspaceId);
    if (id !== workspaceId) next.push(id);
  });
  if (gap >= order.length) next.push(workspaceId);
  return next;
}

/**
 * Decides, without touching Herdr, which workspaces must move so each coordinator is followed
 * directly by its own task workspaces in the given order. Already-nested workspaces never move.
 */
export function planRenest(
  liveOrder: readonly string[],
  groups: readonly RenestGroup[],
): readonly RenestMove[] {
  let order = [...liveOrder];
  const moves: RenestMove[] = [];
  for (const group of groups) {
    let previous = group.coordinatorWorkspaceId;
    for (const { workspaceId, taskId } of group.workspaces) {
      const after = order.indexOf(previous);
      if (order[after + 1] !== workspaceId) {
        moves.push({ repoPath: group.repoPath, taskId, workspaceId, afterWorkspaceId: previous });
        order = applyMove(order, workspaceId, after + 1);
      }
      previous = workspaceId;
    }
  }
  return moves;
}

type Durable = Readonly<{ readonly tasks: readonly TaskRecord[]; readonly state: RuntimeState }>;

/** Reads task records and runtime state together under one state lock, waiting up to `waitMs`. */
async function readDurable(home: string, waitMs: number): Promise<Durable> {
  try {
    if (!(await lstat(databasePath(home))).isFile()) {
      return { tasks: [], state: await readRuntimeState(runtimeFile(home)) };
    }
  } catch {
    return { tasks: [], state: await readRuntimeState(runtimeFile(home)) };
  }
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: () => new Date().toISOString(),
    idFactory: defaultIdFactory(),
  });
  return withStateLock(
    home,
    async () => ({ tasks: await store.list(), state: await readRuntimeState(runtimeFile(home)) }),
    waitMs,
  );
}

/** One workspace a task's durable records name: its own panes or a presentation it drew. */
type TaskWorkspace = Readonly<{ readonly taskId: string; readonly endpoint: Endpoint }>;

/**
 * Every task and presentation workspace durable records name, in sidebar order: oldest task first,
 * each task's own panes before its presentations. Runtime entries whose task record is gone come
 * last. This is the one list of Tandem's task workspaces, for both nesting and leftover reports.
 */
function taskWorkspaces({ tasks, state }: Durable): readonly TaskWorkspace[] {
  const recorded = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const taskIds = [
    ...new Set([
      ...recorded.map((task) => task.id),
      ...state.tasks.map((task) => task.taskId),
      ...state.presentations.map((presentation) => presentation.taskId),
    ]),
  ];
  return taskIds.flatMap((taskId) =>
    [
      ...(recorded.find((task) => task.id === taskId)?.endpoints ?? []),
      ...(state.tasks.find((task) => task.taskId === taskId)?.endpoints ?? []),
      ...state.presentations.flatMap((presentation) =>
        presentation.taskId === taskId && presentation.endpoint !== undefined
          ? [presentation.endpoint]
          : [],
      ),
    ].map((endpoint) => ({ taskId, endpoint })),
  );
}

/** Labels of worker and presentation workspaces whose launch is still in flight. */
function launchingLabels({ state }: Durable): ReadonlySet<string> {
  return new Set(
    [...state.tasks, ...state.presentations].flatMap((entry) =>
      entry.endpointLaunch === undefined ? [] : [entry.endpointLaunch.workspaceLabel],
    ),
  );
}

/**
 * Lists Tandem-labelled workspaces that no durable record names: not a coordinator's, not any
 * task's or presentation's endpoint, and not a worker launch still in flight under that label.
 */
function leftoverWorkspaces(
  live: readonly WorkspaceListing[],
  coordinatorWorkspaceIds: Iterable<string>,
  owned: readonly TaskWorkspace[],
  launching: ReadonlySet<string>,
): readonly LeftoverWorkspace[] {
  const named = new Set([
    ...coordinatorWorkspaceIds,
    ...owned.map(({ endpoint }) => endpoint.workspaceId),
  ]);
  return live.flatMap(({ workspaceId, label }) => {
    if (label === undefined || !label.startsWith(TASK_WORKSPACE_MARKER)) return [];
    return named.has(workspaceId) || launching.has(label) ? [] : [{ workspaceId, label }];
  });
}

/**
 * Groups the session's live task workspaces under their repository's live coordinator. A workspace
 * is proven Tandem's when exactly one repository's tasks name it, it is not a coordinator's own
 * workspace, and it appears once in the live list; anything else is left where it is.
 */
function groupUnderCoordinators(
  input: Readonly<{
    readonly owned: readonly TaskWorkspace[];
    /** Each task's canonical repository path; a task missing here has no record to place it by. */
    readonly repoPathByTask: ReadonlyMap<string, string>;
    readonly sessionId: string;
    readonly coordinators: readonly CoordinatorRecord[];
    readonly liveOrder: readonly string[];
  }>,
): Readonly<{ groups: readonly RenestGroup[]; warnings: readonly string[] }> {
  const live = (id: string) => input.liveOrder.filter((entry) => entry === id).length === 1;
  const coordinators = input.coordinators.filter((record) => live(record.endpoint.workspaceId));
  const coordinatorWorkspaces = new Set(coordinators.map((record) => record.endpoint.workspaceId));
  const owners = new Map<string, { repoPath: string; taskId: string }>();
  const contested = new Set<string>();
  for (const { taskId, endpoint } of input.owned) {
    const repoPath = input.repoPathByTask.get(taskId);
    const id = endpoint.workspaceId;
    if (repoPath === undefined || endpoint.sessionId !== input.sessionId) continue;
    if (!live(id) || coordinatorWorkspaces.has(id)) continue;
    const owner = owners.get(id);
    if (owner === undefined) owners.set(id, { repoPath, taskId });
    else if (owner.repoPath !== repoPath) contested.add(id);
  }
  const warnings = [...contested].map(
    (id) => `left workspace ${id} in place: tasks from more than one project name it`,
  );
  const groups = coordinators.map((record) => ({
    repoPath: record.repoPath,
    coordinatorWorkspaceId: record.endpoint.workspaceId,
    workspaces: [...owners.entries()]
      .filter(([id, owner]) => owner.repoPath === record.repoPath && !contested.has(id))
      .map(([workspaceId, owner]) => ({ workspaceId, taskId: owner.taskId })),
  }));
  return { groups, warnings };
}

/** Each task's repository path with symlinks resolved, so it compares with a coordinator's. */
async function canonicalRepoPaths(
  tasks: readonly TaskRecord[],
): Promise<ReadonlyMap<string, string>> {
  const paths = new Map<string, string>();
  for (const task of tasks) paths.set(task.id, await canonicalPath(task.repoPath, "task repoPath"));
  return paths;
}

/**
 * Puts every Tandem task and presentation workspace in a Herdr session back directly under its
 * repository's coordinator. Display-only: it never closes, renames, or creates anything, never
 * touches a workspace Tandem cannot prove is its own, and turns every failure into a warning.
 */
export async function renestWorkspaces(
  terminal: TerminalBackend,
  input: Readonly<{
    readonly home: string;
    readonly sessionId: string;
    readonly cwd: string;
    /** Without apply, only the plan is returned and Herdr is only read. */
    readonly apply: boolean;
    /** How long to wait for the state lock; defaults to 30 seconds. */
    readonly lockWaitMs?: number;
  }>,
): Promise<RenestReport> {
  const warnings: string[] = [];
  const failed = (what: string, error: unknown): RenestReport => ({
    ...EMPTY,
    warnings: [`could not read ${what}: ${error instanceof Error ? error.message : String(error)}`],
  });
  let records: readonly CoordinatorRecord[];
  let durable: Durable;
  try {
    records = await listCoordinatorRecords(input.home, input.sessionId);
    // No recorded coordinator means nothing to nest under, so Herdr is not even asked.
    if (records.length === 0) return EMPTY;
    for (const record of records) {
      if (record.endpoint.terminal !== terminal.name)
        warnings.push(
          `quarantined ${record.endpoint.terminal} coordinator ${record.repoPath} under ${terminal.name}`,
        );
    }
    records = records.filter((record) => record.endpoint.terminal === terminal.name);
    if (records.length === 0) return { ...EMPTY, warnings };
    durable = await readDurable(input.home, input.lockWaitMs ?? STATE_LOCK_WAIT_MS);
  } catch (error) {
    return failed("Tandem's task records", error);
  }
  let live: readonly WorkspaceListing[];
  try {
    live = await terminal.listWorkspaces({ sessionId: input.sessionId, cwd: input.cwd });
  } catch (error) {
    return failed("Herdr workspaces", error);
  }
  const liveOrder = live.map((workspace) => workspace.workspaceId);
  const recorded = taskWorkspaces(durable);
  for (const { endpoint } of recorded) {
    if (endpoint.terminal !== terminal.name)
      warnings.push(
        `quarantined ${endpoint.terminal} pane ${endpoint.paneId} under ${terminal.name}`,
      );
  }
  const owned = recorded.filter(({ endpoint }) => endpoint.terminal === terminal.name);
  const leftovers = leftoverWorkspaces(
    live,
    records.map((record) => record.endpoint.workspaceId),
    owned,
    launchingLabels(durable),
  );
  let planned: readonly RenestMove[];
  try {
    const grouped = groupUnderCoordinators({
      owned,
      repoPathByTask: await canonicalRepoPaths(durable.tasks),
      sessionId: input.sessionId,
      coordinators: records,
      liveOrder,
    });
    warnings.push(...grouped.warnings);
    planned = planRenest(liveOrder, grouped.groups);
  } catch (error) {
    return failed("Tandem's task records", error);
  }
  if (!input.apply) return { planned, moved: 0, warnings, leftovers };
  let moved = 0;
  for (const move of planned) {
    const failures = await terminal.orderWorkspaceAfter({
      sessionId: input.sessionId,
      cwd: input.cwd,
      workspaceId: move.workspaceId,
      parentWorkspaceId: move.afterWorkspaceId,
    });
    if (failures.length === 0) moved += 1;
    else warnings.push(...failures);
  }
  return { planned, moved, warnings, leftovers };
}
