import { basename } from "node:path";
import { closeEndpoint, type HerdrPaneInspection, inspectEndpoint } from "../adapters/herdr.ts";
import { AdapterCommandError, EndpointBusyError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandRunner } from "../contracts.ts";
import {
  assertStoppedCoordinatorShell,
  commandErrorCode,
  isMissingEndpointError,
  parseJson,
  readSessionSnapshot,
} from "./ownership.ts";
import { type CoordinatorRecord, canonicalPath, isRecord } from "./record.ts";

export type CoordinatorWorkspaceOutcome = "closed" | "already-clear" | "retained" | "quarantined";

/** What happened to a superseded coordinator's Herdr workspace, and why. */
export type CoordinatorWorkspaceRetirement = Readonly<{
  readonly outcome: CoordinatorWorkspaceOutcome;
  readonly reason?: string;
  /** Pane ids left open in a retained workspace, besides the coordinator's own. */
  readonly extraPaneIds?: readonly string[];
}>;

export type RetireCoordinatorWorkspaceOptions = Readonly<{
  /** Explicit user request to keep the workspace instead of closing it. */
  readonly retain?: boolean;
}>;

type RetiredRecord = Pick<CoordinatorRecord, "repoPath" | "endpoint" | "worktree">;

export function coordinatorWorkspaceLabel(repoPath: string): string {
  return `Tandem coordinator · ${basename(repoPath)}`;
}

function retainedWorkspaceLabel(repoPath: string): string {
  return `Retained terminals · ${basename(repoPath)}`;
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
 * Closes the coordinator's own pane by default, which removes the workspace once it was the
 * last pane. A workspace is retained (its generated label renamed to "Retained terminals ·
 * <repo>") only when the caller explicitly asks for that, or when other panes still share the
 * workspace and keep it alive. A custom label, or ownership that cannot be proven exactly and
 * as stopped, is left entirely untouched and reported rather than closed or renamed.
 */
export async function retireCoordinatorWorkspace(
  run: CommandRunner,
  record: RetiredRecord,
  options: RetireCoordinatorWorkspaceOptions = {},
): Promise<CoordinatorWorkspaceRetirement> {
  const label = await currentWorkspaceLabel(run, record);
  if (label === undefined) return { outcome: "already-clear" };

  const extraPaneIds = await siblingPaneIds(run, record);
  const withExtras = (
    retirement: CoordinatorWorkspaceRetirement,
  ): CoordinatorWorkspaceRetirement =>
    extraPaneIds.length === 0 ? retirement : { ...retirement, extraPaneIds };

  if (label !== coordinatorWorkspaceLabel(record.repoPath)) {
    return withExtras({ outcome: "retained", reason: "workspace has a custom label" });
  }

  if (options.retain === true) {
    await renameToRetained(run, record);
    return withExtras({ outcome: "retained", reason: "retention was explicitly requested" });
  }

  const proof = await proveCoordinatorStopped(run, record);
  if (proof.status === "quarantine") {
    return { outcome: "quarantined", reason: proof.reason };
  }
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
    return withExtras({ outcome: "retained", reason: "extra panes still share this workspace" });
  }
  return { outcome: "closed" };
}
