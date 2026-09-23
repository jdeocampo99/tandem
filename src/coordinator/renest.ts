import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  type HerdrAdapterOptions,
  type HerdrWorkspace,
  listWorkspaces,
  moveWorkspaceAfterParent,
} from "../adapters/herdr.ts";
import type { CommandRunner, TaskRecord } from "../contracts.ts";
import { databasePath, withStateLock } from "../runtime/database.ts";
import { defaultIdFactory, readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import type { RuntimeState } from "../runtime/schema.ts";
import { createTaskStore } from "../tasks/store.ts";
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

/**
 * Lists Tandem-labelled workspaces that no durable record names: not a coordinator's, not any
 * task's or presentation's endpoint, and not a worker launch still in flight under that label.
 */
function leftoverWorkspaces(
  live: readonly HerdrWorkspace[],
  records: readonly CoordinatorRecord[],
  durable: Durable,
): readonly LeftoverWorkspace[] {
  const named = new Set<string>(records.map((record) => record.endpoint.workspaceId));
  const launching = new Set<string>();
  for (const task of durable.tasks) {
    for (const endpoint of task.endpoints ?? []) named.add(endpoint.workspaceId);
  }
  for (const task of durable.state.tasks) {
    for (const endpoint of task.endpoints) named.add(endpoint.workspaceId);
    if (task.endpointLaunch !== undefined) launching.add(task.endpointLaunch.workspaceLabel);
  }
  for (const presentation of durable.state.presentations) {
    if (presentation.endpoint !== undefined) named.add(presentation.endpoint.workspaceId);
    if (presentation.endpointLaunch !== undefined) {
      launching.add(presentation.endpointLaunch.workspaceLabel);
    }
  }
  return live.flatMap(({ workspaceId, label }) => {
    if (label === undefined || !label.startsWith(TASK_WORKSPACE_MARKER)) return [];
    return named.has(workspaceId) || launching.has(label) ? [] : [{ workspaceId, label }];
  });
}

/**
 * Groups the session's live task workspaces under their repository's live coordinator, from
 * durable records only. A workspace is proven Tandem's when exactly one repository's task records
 * name it, it is not a coordinator's own workspace, and it appears once in the live list; anything
 * else is left where it is.
 */
async function observeGroups(
  durable: Durable,
  sessionId: string,
  records: readonly CoordinatorRecord[],
  liveOrder: readonly string[],
): Promise<Readonly<{ groups: readonly RenestGroup[]; warnings: readonly string[] }>> {
  const live = (id: string) => liveOrder.filter((entry) => entry === id).length === 1;
  const coordinators = records.filter((record) => live(record.endpoint.workspaceId));
  const coordinatorWorkspaces = new Set(coordinators.map((record) => record.endpoint.workspaceId));
  const { state } = durable;
  const tasks = [...durable.tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const owners = new Map<string, { repoPath: string; taskId: string }>();
  const contested = new Set<string>();
  for (const task of tasks) {
    const repoPath = await canonicalPath(task.repoPath, "task repoPath");
    const endpoints = state.tasks.find((entry) => entry.taskId === task.id)?.endpoints ?? [];
    for (const endpoint of endpoints) {
      const id = endpoint.workspaceId;
      if (endpoint.sessionId !== sessionId || !live(id) || coordinatorWorkspaces.has(id)) continue;
      const owner = owners.get(id);
      if (owner === undefined) owners.set(id, { repoPath, taskId: task.id });
      else if (owner.repoPath !== repoPath) contested.add(id);
    }
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

/**
 * Puts every Tandem task workspace in a Herdr session back directly under its repository's
 * coordinator. Display-only: it never closes, renames, or creates anything, never touches a
 * workspace Tandem cannot prove is its own, and turns every failure into a warning.
 */
export async function renestWorkspaces(
  run: CommandRunner,
  input: Readonly<{
    readonly home: string;
    readonly sessionId: string;
    readonly cwd: string;
    /** Without apply, only the plan is returned and Herdr is only read. */
    readonly apply: boolean;
    /** How long to wait for the state lock; defaults to 30 seconds. */
    readonly lockWaitMs?: number;
  }>,
  options: HerdrAdapterOptions = {},
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
    durable = await readDurable(input.home, input.lockWaitMs ?? STATE_LOCK_WAIT_MS);
  } catch (error) {
    return failed("Tandem's task records", error);
  }
  let live: readonly HerdrWorkspace[];
  try {
    live = await listWorkspaces(run, input.sessionId, input.cwd);
  } catch (error) {
    return failed("Herdr workspaces", error);
  }
  const liveOrder = live.map((workspace) => workspace.workspaceId);
  const leftovers = leftoverWorkspaces(live, records, durable);
  let planned: readonly RenestMove[];
  try {
    const observed = await observeGroups(durable, input.sessionId, records, liveOrder);
    warnings.push(...observed.warnings);
    planned = planRenest(liveOrder, observed.groups);
  } catch (error) {
    return failed("Tandem's task records", error);
  }
  if (!input.apply) return { planned, moved: 0, warnings, leftovers };
  let moved = 0;
  for (const move of planned) {
    const failures = await moveWorkspaceAfterParent(
      run,
      {
        sessionId: input.sessionId,
        cwd: input.cwd,
        workspaceId: move.workspaceId,
        parentWorkspaceId: move.afterWorkspaceId,
      },
      options,
    );
    if (failures.length === 0) moved += 1;
    else warnings.push(...failures);
  }
  return { planned, moved, warnings, leftovers };
}
