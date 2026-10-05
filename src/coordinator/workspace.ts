import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  closeEndpoint,
  type HerdrPaneInspection,
  inspectEndpoint,
  listWorkspaces,
} from "../adapters/herdr.ts";
import { AdapterCommandError, EndpointBusyError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandRunner } from "../contracts.ts";
import {
  assertStoppedCoordinatorShell,
  commandErrorCode,
  isMissingEndpointError,
  parseJson,
  readSessionSnapshot,
} from "./ownership.ts";
import { closeCoordinatorPanel } from "./panel.ts";
import { type CoordinatorRecord, canonicalPath, isRecord } from "./record.ts";

export type CoordinatorWorkspaceOutcome = "closed" | "already-clear" | "retained" | "quarantined";

/** What happened to a superseded coordinator's Herdr workspace, and why. */
export type CoordinatorWorkspaceRetirement = Readonly<{
  readonly outcome: CoordinatorWorkspaceOutcome;
  readonly reason?: string;
  /** Pane ids left open in a retained workspace, besides the coordinator's own. */
  readonly extraPaneIds?: readonly string[];
}>;

export type RetiredRecord = Pick<CoordinatorRecord, "repoPath" | "endpoint" | "worktree">;

/** Short enough to read in Herdr's narrow sidebar; task workspaces nest under it with "└ ". */
export function coordinatorWorkspaceLabel(repoPath: string): string {
  return `◆ ${basename(repoPath)}`;
}

/**
 * Whether a label is one Tandem generated for this repository's coordinator. Workspaces opened
 * before the short label still carry the long one and must retire the same way.
 */
function isCoordinatorWorkspaceLabel(label: string, repoPath: string): boolean {
  return (
    label === coordinatorWorkspaceLabel(repoPath) ||
    label === `Tandem coordinator · ${basename(repoPath)}`
  );
}

function retainedWorkspaceLabel(repoPath: string): string {
  return `◇ ${basename(repoPath)} (old)`;
}

async function currentWorkspaceLabel(
  run: CommandRunner,
  record: RetiredRecord,
): Promise<string | undefined> {
  const { sessionId, workspaceId } = record.endpoint;
  const request: CommandRequest = {
    argv: ["herdr", "--session", sessionId, "workspace", "get", workspaceId],
    cwd: record.repoPath,
  };
  const current = await run(request);
  if (current.code !== 0) {
    const code = commandErrorCode(current.stdout, current.stderr);
    if (
      code === "workspace_not_found" ||
      code === "session_not_found" ||
      code === "server_not_running"
    )
      return undefined;
    throw new AdapterCommandError("herdr workspace get", request, current);
  }
  const value = parseJson(current.stdout, "herdr workspace get");
  if (
    !isRecord(value) ||
    !isRecord(value.result) ||
    value.result.type !== "workspace_info" ||
    !isRecord(value.result.workspace) ||
    value.result.workspace.workspace_id !== workspaceId ||
    typeof value.result.workspace.label !== "string"
  ) {
    throw new Error("Herdr returned an unknown coordinator workspace identity");
  }
  return value.result.workspace.label;
}

async function renameToRetained(run: CommandRunner, record: RetiredRecord): Promise<void> {
  const { sessionId, workspaceId } = record.endpoint;
  const label = retainedWorkspaceLabel(record.repoPath);
  const request: CommandRequest = {
    argv: ["herdr", "--session", sessionId, "workspace", "rename", workspaceId, label],
    cwd: record.repoPath,
  };
  const renamed = await run(request);
  if (renamed.code !== 0) throw new AdapterCommandError("herdr workspace rename", request, renamed);
  const acknowledgement = parseJson(renamed.stdout, "herdr workspace rename");
  if (
    !isRecord(acknowledgement) ||
    !isRecord(acknowledgement.result) ||
    acknowledgement.result.type !== "workspace_info" ||
    !isRecord(acknowledgement.result.workspace) ||
    acknowledgement.result.workspace.workspace_id !== workspaceId ||
    acknowledgement.result.workspace.label !== label
  ) {
    throw new Error("Herdr did not acknowledge the retained workspace label");
  }
}

async function siblingPaneIds(
  run: CommandRunner,
  record: RetiredRecord,
): Promise<readonly string[]> {
  const panes = await readSessionSnapshot(
    run,
    record.endpoint.sessionId,
    record.worktree.path,
    true,
  );
  return panes
    .filter(
      (pane) =>
        pane.workspaceId === record.endpoint.workspaceId && pane.paneId !== record.endpoint.paneId,
    )
    .map((pane) => pane.paneId);
}

type StopProof =
  | Readonly<{ readonly status: "already-closed" }>
  | Readonly<{ readonly status: "owned-and-stopped" }>
  | Readonly<{ readonly status: "quarantine"; readonly reason: string }>;

/** Proves the coordinator's own pane exactly matches its recorded worktree and has stopped. */
async function proveCoordinatorStopped(
  run: CommandRunner,
  record: RetiredRecord,
): Promise<StopProof> {
  let inspection: HerdrPaneInspection;
  try {
    inspection = await inspectEndpoint(run, {
      endpoint: record.endpoint,
      cwd: record.worktree.path,
    });
  } catch (error) {
    if (isMissingEndpointError(error)) return { status: "already-closed" };
    throw error;
  }
  if (inspection.pane.foregroundCwd === undefined) {
    return {
      status: "quarantine",
      reason: `coordinator pane ${JSON.stringify(record.endpoint.paneId)} reported no foreground working directory`,
    };
  }
  const foregroundCwd = await canonicalPath(inspection.pane.foregroundCwd, "coordinator pane cwd");
  if (foregroundCwd !== record.worktree.path) {
    return {
      status: "quarantine",
      reason: `coordinator pane ${JSON.stringify(record.endpoint.paneId)} cwd ${JSON.stringify(
        foregroundCwd,
      )} no longer matches its recorded worktree ${JSON.stringify(record.worktree.path)}`,
    };
  }
  try {
    assertStoppedCoordinatorShell(inspection);
  } catch (error) {
    return {
      status: "quarantine",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: "owned-and-stopped" };
}

/**
 * Retires a superseded or stopped coordinator's Herdr workspace after a launch, restart, or
 * stop has already proven it is safe to replace.
 *
 * Closes the coordinator's recorded panel, then its own pane, which removes the workspace once
 * it was the last pane. A workspace is retained instead (its generated label renamed to "◇ <repo>
 * (old)") only when another pane still shares the workspace and keeps it alive.
 * A custom label, or ownership that cannot be proven exactly and as stopped, is left entirely
 * untouched and reported rather than closed or renamed.
 *
 * There is no explicit-retention option: nothing in Tandem yet asks a user whether to keep a
 * coordinator's workspace, so that knob would have no caller. Add one only alongside a real
 * surface for it.
 */
export async function retireCoordinatorWorkspace(
  run: CommandRunner,
  home: string,
  record: RetiredRecord,
): Promise<CoordinatorWorkspaceRetirement> {
  const label = await currentWorkspaceLabel(run, record);
  if (label === undefined) return { outcome: "already-clear" };

  const withExtras = (
    retirement: CoordinatorWorkspaceRetirement,
    extraPaneIds: readonly string[],
  ): CoordinatorWorkspaceRetirement =>
    extraPaneIds.length === 0 ? retirement : { ...retirement, extraPaneIds };

  if (!isCoordinatorWorkspaceLabel(label, record.repoPath)) {
    return withExtras(
      { outcome: "retained", reason: "workspace has a custom label" },
      await siblingPaneIds(run, record),
    );
  }

  const proof = await proveCoordinatorStopped(run, record);
  if (proof.status === "quarantine") {
    return { outcome: "quarantined", reason: proof.reason };
  }
  const panel = await closeCoordinatorPanel(run, home, record);
  const extraPaneIds = (await siblingPaneIds(run, record)).filter(
    (paneId) => panel.outcome !== "closed" || paneId !== panel.paneId,
  );
  if (proof.status === "owned-and-stopped") {
    try {
      await closeEndpoint(run, { endpoint: record.endpoint, cwd: record.worktree.path });
    } catch (error) {
      if (!(error instanceof EndpointBusyError)) throw error;
      return { outcome: "quarantined", reason: error.message };
    }
  }

  if (extraPaneIds.length > 0) {
    await renameToRetained(run, record);
    const reason =
      panel.outcome === "failed"
        ? "panel could not be closed"
        : "extra panes still share this workspace";
    return withExtras({ outcome: "retained", reason }, extraPaneIds);
  }
  return { outcome: "closed" };
}

/**
 * Coordinator panes Herdr restored from its saved session that no Tandem record names, as records
 * to retire: a reset or replaced home lost the records, but Herdr still reopens their workspaces
 * as plain shells when its server starts. Only a pane in a workspace with this repository's
 * generated label, sitting in the worktree this launch just leased, counts.
 */
export async function findRestoredCoordinatorPanes(
  run: CommandRunner,
  input: Readonly<{
    readonly sessionId: string;
    readonly repoPath: string;
    readonly worktree: RetiredRecord["worktree"];
  }>,
): Promise<readonly RetiredRecord[]> {
  const { sessionId, repoPath, worktree } = input;
  const labelled = new Set(
    (await listWorkspaces(run, sessionId, worktree.path))
      .filter(({ label }) => label !== undefined && isCoordinatorWorkspaceLabel(label, repoPath))
      .map(({ workspaceId }) => workspaceId),
  );
  if (labelled.size === 0) return [];
  const request: CommandRequest = {
    argv: ["herdr", "--session", sessionId, "pane", "list"],
    cwd: worktree.path,
  };
  const listed = await run(request);
  if (listed.code !== 0) throw new AdapterCommandError("herdr pane list", request, listed);
  const value = parseJson(listed.stdout, "herdr pane list");
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.panes)) {
    throw new Error("herdr pane list returned an unknown pane list");
  }
  const physical = (path: string) => realpath(path).catch(() => path);
  const leased = await physical(worktree.path);
  const restored: RetiredRecord[] = [];
  for (const pane of value.result.panes) {
    if (
      !isRecord(pane) ||
      typeof pane.workspace_id !== "string" ||
      typeof pane.tab_id !== "string" ||
      typeof pane.pane_id !== "string" ||
      typeof pane.cwd !== "string" ||
      !labelled.has(pane.workspace_id) ||
      (await physical(pane.cwd)) !== leased
    ) {
      continue;
    }
    restored.push({
      repoPath,
      worktree,
      endpoint: {
        sessionId,
        workspaceId: pane.workspace_id,
        tabId: pane.tab_id,
        paneId: pane.pane_id,
        role: "coordinator",
        generation: 0,
      },
    });
  }
  return restored;
}
