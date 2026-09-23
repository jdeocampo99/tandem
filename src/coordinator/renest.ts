import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  type HerdrAdapterOptions,
  listWorkspaceOrder,
  moveWorkspaceAfterParent,
} from "../adapters/herdr.ts";
import type { CommandRunner, TaskRecord } from "../contracts.ts";
import { databasePath } from "../runtime/database.ts";
import { defaultIdFactory, readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
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

/** What re-nesting planned, what it moved, and why anything was skipped. */
export type RenestReport = Readonly<{
  readonly planned: readonly RenestMove[];
  readonly moved: number;
  readonly warnings: readonly string[];
}>;

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

async function readTasks(home: string): Promise<readonly TaskRecord[]> {
  try {
    if (!(await lstat(databasePath(home))).isFile()) return [];
  } catch {
    return [];
  }
  return createTaskStore({
    directory: join(home, "tasks"),
    clock: () => new Date().toISOString(),
    idFactory: defaultIdFactory(),
  }).list();
}

/**
 * Groups the session's live task workspaces under their repository's live coordinator, from
 * durable records only. A workspace is proven Tandem's when exactly one repository's task records
 * name it, it is not a coordinator's own workspace, and it appears once in the live list; anything
 * else is left where it is.
 */
async function observeGroups(
  home: string,
  sessionId: string,
  records: readonly CoordinatorRecord[],
  liveOrder: readonly string[],
): Promise<Readonly<{ groups: readonly RenestGroup[]; warnings: readonly string[] }>> {
  const live = (id: string) => liveOrder.filter((entry) => entry === id).length === 1;
  const coordinators = records.filter((record) => live(record.endpoint.workspaceId));
  const coordinatorWorkspaces = new Set(coordinators.map((record) => record.endpoint.workspaceId));
  const state = await readRuntimeState(runtimeFile(home));
  const tasks = [...(await readTasks(home))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
  }>,
  options: HerdrAdapterOptions = {},
): Promise<RenestReport> {
  const warnings: string[] = [];
  let planned: readonly RenestMove[];
  try {
    // No recorded coordinator means nothing to nest under, so Herdr is not even asked.
    const records = await listCoordinatorRecords(input.home, input.sessionId);
    if (records.length === 0) return { planned: [], moved: 0, warnings: [] };
    const liveOrder = await listWorkspaceOrder(run, input.sessionId, input.cwd);
    const observed = await observeGroups(input.home, input.sessionId, records, liveOrder);
    warnings.push(...observed.warnings);
    planned = planRenest(liveOrder, observed.groups);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { planned: [], moved: 0, warnings: [`could not read Herdr workspaces: ${reason}`] };
  }
  if (!input.apply) return { planned, moved: 0, warnings };
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
  return { planned, moved, warnings };
}
