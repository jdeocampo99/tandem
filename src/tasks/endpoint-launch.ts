import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommandRunner, Endpoint } from "../contracts.ts";
import type { DurableEndpointLaunch } from "../runtime/schema.ts";
import { absoluteDirectory, describeError, isRecord, singleLine } from "../service/records.ts";

type HerdrWorkspaceObservation = Readonly<{
  readonly workspaceId: string;
  readonly activeTabId: string;
  readonly label: string;
}>;
type HerdrPaneObservation = Readonly<{
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly foregroundCwd: string | undefined;
}>;
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

function parseHerdrPayload(raw: string, operation: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) throw new Error(`${operation} returned a non-object response`);
  return parsed;
}

async function readHerdrPayload(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
  args: readonly string[],
  operation: string,
): Promise<Record<string, unknown>> {
  const result = await run({
    argv: ["herdr", "--session", singleLine(sessionId, "sessionId"), ...args],
    cwd: absoluteDirectory(cwd, "cwd"),
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim().length === 0 ? result.stdout.trim() : result.stderr.trim();
    throw new Error(`${operation} failed with exit code ${result.code}: ${detail}`);
  }
  return parseHerdrPayload(result.stdout, operation);
}

function herdrResult(payload: Record<string, unknown>, operation: string): Record<string, unknown> {
  const result = payload.result;
  if (!isRecord(result)) throw new Error(`${operation} response.result must be an object`);
  return result;
}

function requiredHerdrText(value: unknown, field: string, operation: string): string {
  try {
    return singleLine(value, field);
  } catch (error) {
    throw new Error(`${operation} ${field} is invalid: ${describeError(error)}`, { cause: error });
  }
}

function parseHerdrWorkspaces(
  payload: Record<string, unknown>,
  operation: string,
): readonly HerdrWorkspaceObservation[] {
  const workspaces = herdrResult(payload, operation).workspaces;
  if (!Array.isArray(workspaces))
    throw new Error(`${operation} response.result.workspaces must be an array`);
  return workspaces.map((value, index) => {
    if (!isRecord(value)) throw new Error(`${operation} workspace ${index} must be an object`);
    return {
      workspaceId: requiredHerdrText(
        value.workspace_id,
        `workspace[${index}].workspace_id`,
        operation,
      ),
      activeTabId: requiredHerdrText(
        value.active_tab_id,
        `workspace[${index}].active_tab_id`,
        operation,
      ),
      label: requiredHerdrText(value.label, `workspace[${index}].label`, operation),
    };
  });
}

function parseHerdrPanes(
  payload: Record<string, unknown>,
  operation: string,
): readonly HerdrPaneObservation[] {
  const panes = herdrResult(payload, operation).panes;
  if (!Array.isArray(panes)) throw new Error(`${operation} response.result.panes must be an array`);
  return panes.map((value, index) => {
    if (!isRecord(value)) throw new Error(`${operation} pane ${index} must be an object`);
    const foregroundCwd =
      value.foreground_cwd === undefined
        ? undefined
        : requiredHerdrText(value.foreground_cwd, `pane[${index}].foreground_cwd`, operation);
    return {
      paneId: requiredHerdrText(value.pane_id, `pane[${index}].pane_id`, operation),
      tabId: requiredHerdrText(value.tab_id, `pane[${index}].tab_id`, operation),
      workspaceId: requiredHerdrText(value.workspace_id, `pane[${index}].workspace_id`, operation),
      cwd: requiredHerdrText(value.cwd, `pane[${index}].cwd`, operation),
      foregroundCwd,
    };
  });
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
  run: CommandRunner,
  intent: DurableEndpointLaunch,
): Promise<LaunchLookup<readonly HerdrWorkspaceObservation[]>> {
  let workspaces: readonly HerdrWorkspaceObservation[];
  try {
    workspaces = parseHerdrWorkspaces(
      await readHerdrPayload(
        run,
        intent.sessionId,
        intent.cwd,
        ["workspace", "list"],
        "herdr workspace list",
      ),
      "herdr workspace list",
    );
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
  pane: HerdrPaneObservation,
  workspace: HerdrWorkspaceObservation,
  cwd: string,
): Promise<boolean> {
  if (pane.workspaceId !== workspace.workspaceId || pane.tabId !== workspace.activeTabId) {
    return false;
  }
  if (!(await samePhysicalDirectory(cwd, pane.cwd))) return false;
  return pane.foregroundCwd === undefined || samePhysicalDirectory(cwd, pane.foregroundCwd);
}

async function findLaunchRootPane(
  run: CommandRunner,
  intent: DurableEndpointLaunch,
  workspace: HerdrWorkspaceObservation,
): Promise<LaunchLookup<HerdrPaneObservation>> {
  let panes: readonly HerdrPaneObservation[];
  try {
    panes = parseHerdrPanes(
      await readHerdrPayload(
        run,
        intent.sessionId,
        intent.cwd,
        ["pane", "list", "--workspace", workspace.workspaceId],
        "herdr pane list",
      ),
      "herdr pane list",
    );
  } catch (error) {
    return { status: "pending", detail: `pane recovery is unavailable: ${describeError(error)}` };
  }
  const candidates: HerdrPaneObservation[] = [];
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
 * Finds the one Herdr pane a recorded launch intent created, or explains why it cannot yet.
 * Workspaces sharing the label are told apart by a root pane in the launch's worktree.
 */
export async function recoverEndpointFromLaunch(
  run: CommandRunner,
  intent: DurableEndpointLaunch,
): Promise<EndpointLaunchRecovery> {
  const workspaces = await findLaunchWorkspaces(run, intent);
  if (workspaces.status !== "found") return workspaces;
  const found: Readonly<{ workspace: HerdrWorkspaceObservation; pane: HerdrPaneObservation }>[] =
    [];
  const unresolved: UnresolvedLaunch[] = [];
  for (const workspace of workspaces.value) {
    const pane = await findLaunchRootPane(run, intent, workspace);
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
