import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Endpoint } from "../contracts.ts";
import type { DurableEndpointLaunch } from "../runtime/schema.ts";
import { describeError } from "../service/records.ts";
import type {
  PaneListing,
  TerminalBackend,
  WorkspaceListing,
} from "../terminal-backend/contract.ts";

type UnresolvedLaunch =
  | Readonly<{ readonly status: "pending"; readonly detail: string }>
  | Readonly<{ readonly status: "ambiguous"; readonly detail: string }>;
type EndpointLaunchRecovery =
  | Readonly<{ readonly status: "recovered"; readonly endpoint: Endpoint }>
  | UnresolvedLaunch;
type LaunchLookup<Value> =
  | Readonly<{ readonly status: "found"; readonly value: Value }>
  | UnresolvedLaunch;

/** True when `left` records exactly the launch identity `right` does. */
export function sameEndpointLaunch(
  left: DurableEndpointLaunch | undefined,
  right: DurableEndpointLaunch,
): boolean {
  return (
    left !== undefined &&
    left.schemaVersion === right.schemaVersion &&
    left.reservationId === right.reservationId &&
    left.operationId === right.operationId &&
    left.sessionId === right.sessionId &&
    left.taskName === right.taskName &&
    left.workspaceLabel === right.workspaceLabel &&
    left.cwd === right.cwd &&
    left.role === right.role &&
    left.generation === right.generation &&
    left.createdAt === right.createdAt &&
    left.parentWorkspaceId === right.parentWorkspaceId
  );
}

async function samePhysicalDirectory(expected: string, actual: string): Promise<boolean> {
  try {
    const [expectedPath, actualPath] = await Promise.all([realpath(expected), realpath(actual)]);
    return expectedPath === actualPath;
  } catch {
    return resolve(expected) === resolve(actual);
  }
}

/** Lists the workspaces carrying the launch's label; task titles need not be unique. */
async function findLaunchWorkspaces(
  terminal: TerminalBackend,
  intent: DurableEndpointLaunch,
): Promise<LaunchLookup<readonly WorkspaceListing[]>> {
  let workspaces: readonly WorkspaceListing[];
  try {
    workspaces = await terminal.listWorkspaces({
      sessionId: intent.sessionId,
      cwd: intent.cwd,
      complete: true,
    });
  } catch (error) {
    return {
      status: "pending",
      detail: `workspace recovery is unavailable: ${describeError(error)}`,
    };
  }
  const matches = workspaces.filter((workspace) => workspace.label === intent.workspaceLabel);
  if (matches.length === 0) {
    return {
      status: "pending",
      detail: `no Herdr workspace has label ${JSON.stringify(intent.workspaceLabel)}`,
    };
  }
  return { status: "found", value: matches };
}

/** A root pane sits on the workspace's active tab with its shell, and any foreground, in `cwd`. */
async function isLaunchRootPane(
  pane: PaneListing,
  workspace: WorkspaceListing,
  cwd: string,
): Promise<boolean> {
  if (pane.workspaceId !== workspace.workspaceId || pane.tabId !== workspace.activeTabId) {
    return false;
  }
  if (!(await samePhysicalDirectory(cwd, pane.cwd))) return false;
  return pane.foregroundCwd === undefined || samePhysicalDirectory(cwd, pane.foregroundCwd);
}

async function findLaunchRootPane(
  terminal: TerminalBackend,
  intent: DurableEndpointLaunch,
  workspace: WorkspaceListing,
): Promise<LaunchLookup<PaneListing>> {
  let panes: readonly PaneListing[];
  try {
    panes = await terminal.listPanes({
      sessionId: intent.sessionId,
      cwd: intent.cwd,
      workspaceId: workspace.workspaceId,
      complete: true,
    });
  } catch (error) {
    return { status: "pending", detail: `pane recovery is unavailable: ${describeError(error)}` };
  }
  const candidates: PaneListing[] = [];
  for (const pane of panes) {
    if (await isLaunchRootPane(pane, workspace, intent.cwd)) candidates.push(pane);
  }
  if (candidates.length === 0) {
    return {
      status: "pending",
      detail: `workspace ${workspace.workspaceId} has no unique root pane at ${intent.cwd}`,
    };
  }
  if (candidates.length !== 1) {
    return {
      status: "ambiguous",
      detail: `workspace ${workspace.workspaceId} has ${candidates.length} matching root panes`,
    };
  }
  const pane = candidates[0];
  if (pane === undefined)
    return { status: "pending", detail: "Herdr root pane recovery returned no pane" };
  return { status: "found", value: pane };
}

/**
 * Finds the one pane a recorded launch intent created, or explains why it cannot yet.
 * Workspaces sharing the label are told apart by a root pane in the launch's worktree.
 */
export async function recoverEndpointFromLaunch(
  terminal: TerminalBackend,
  intent: DurableEndpointLaunch,
): Promise<EndpointLaunchRecovery> {
  const workspaces = await findLaunchWorkspaces(terminal, intent);
  if (workspaces.status !== "found") return workspaces;
  const found: Readonly<{ workspace: WorkspaceListing; pane: PaneListing }>[] = [];
  const unresolved: UnresolvedLaunch[] = [];
  for (const workspace of workspaces.value) {
    const pane = await findLaunchRootPane(terminal, intent, workspace);
    if (pane.status === "found") found.push({ workspace, pane: pane.value });
    else unresolved.push(pane);
  }
  const ambiguous = unresolved.find((lookup) => lookup.status === "ambiguous");
  if (ambiguous !== undefined) return ambiguous;
  if (found.length > 1) {
    return {
      status: "ambiguous",
      detail: `${found.length} Herdr workspaces labelled ${JSON.stringify(intent.workspaceLabel)} have a root pane at ${intent.cwd}`,
    };
  }
  const match = found[0];
  if (match === undefined) {
    return unresolved[0] ?? { status: "pending", detail: "Herdr workspace recovery found no pane" };
  }
  return {
    status: "recovered",
    endpoint: {
      sessionId: intent.sessionId,
      workspaceId: match.workspace.workspaceId,
      tabId: match.pane.tabId,
      paneId: match.pane.paneId,
      role: intent.role,
      generation: intent.generation,
    },
  };
}
