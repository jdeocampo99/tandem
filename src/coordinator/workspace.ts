import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { EndpointBusyError } from "../adapters/primitives.ts";
import type { EndpointInspection, TerminalBackend } from "../terminal-backend/contract.ts";
import { assertTerminalEndpoint } from "../terminal-backend/identity.ts";
import { assertStoppedCoordinatorShell } from "./ownership.ts";
import { closeCoordinatorPanel } from "./panel.ts";
import { type CoordinatorRecord, canonicalPath } from "./record.ts";

export type CoordinatorWorkspaceOutcome = "closed" | "already-clear" | "retained" | "quarantined";

/** What happened to a superseded coordinator's workspace, and why. */
export type CoordinatorWorkspaceRetirement = Readonly<{
  readonly outcome: CoordinatorWorkspaceOutcome;
  readonly reason?: string;
  /** Pane ids left open in a retained workspace, besides the coordinator's own. */
  readonly extraPaneIds?: readonly string[];
}>;

export type RetiredRecord = Pick<CoordinatorRecord, "repoPath" | "endpoint" | "worktree">;

/** Short enough to read in a narrow sidebar; task workspaces nest under it with "└ ". */
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

async function siblingPaneIds(
  terminal: TerminalBackend,
  record: RetiredRecord,
): Promise<readonly string[]> {
  const panes = await terminal.snapshot({
    sessionId: record.endpoint.sessionId,
    cwd: record.worktree.path,
    allowMissingSession: true,
  });
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
  terminal: TerminalBackend,
  record: RetiredRecord,
): Promise<StopProof> {
  let inspection: EndpointInspection;
  try {
    inspection = await terminal.inspect({
      endpoint: record.endpoint,
      cwd: record.worktree.path,
    });
  } catch (error) {
    if (terminal.isEndpointGone(error)) return { status: "already-closed" };
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
 * Retires a superseded or stopped coordinator's workspace after a launch, restart, or stop has
 * already proven it is safe to replace.
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
  terminal: TerminalBackend,
  home: string,
  record: RetiredRecord,
): Promise<CoordinatorWorkspaceRetirement> {
  try {
    assertTerminalEndpoint(terminal.name, record.endpoint);
  } catch (error) {
    return {
      outcome: "quarantined",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const label = await terminal.workspaceLabel({
    sessionId: record.endpoint.sessionId,
    cwd: record.repoPath,
    workspaceId: record.endpoint.workspaceId,
  });
  if (label === undefined) return { outcome: "already-clear" };

  const withExtras = (
    retirement: CoordinatorWorkspaceRetirement,
    extraPaneIds: readonly string[],
  ): CoordinatorWorkspaceRetirement =>
    extraPaneIds.length === 0 ? retirement : { ...retirement, extraPaneIds };

  if (!isCoordinatorWorkspaceLabel(label, record.repoPath)) {
    return withExtras(
      { outcome: "retained", reason: "workspace has a custom label" },
      await siblingPaneIds(terminal, record),
    );
  }

  const proof = await proveCoordinatorStopped(terminal, record);
  if (proof.status === "quarantine") {
    return { outcome: "quarantined", reason: proof.reason };
  }
  const panel = await closeCoordinatorPanel(terminal, home, record);
  const extraPaneIds = (await siblingPaneIds(terminal, record)).filter(
    (paneId) => panel.outcome !== "closed" || paneId !== panel.paneId,
  );
  if (proof.status === "owned-and-stopped") {
    try {
      await terminal.close({ endpoint: record.endpoint, cwd: record.worktree.path });
    } catch (error) {
      if (!(error instanceof EndpointBusyError)) throw error;
      return { outcome: "quarantined", reason: error.message };
    }
  }

  if (extraPaneIds.length > 0) {
    await terminal.renameWorkspace({
      sessionId: record.endpoint.sessionId,
      cwd: record.repoPath,
      workspaceId: record.endpoint.workspaceId,
      label: `◇ ${basename(record.repoPath)} (old)`,
    });
    const reason =
      panel.outcome === "failed"
        ? "panel could not be closed"
        : "extra panes still share this workspace";
    return withExtras({ outcome: "retained", reason }, extraPaneIds);
  }
  return { outcome: "closed" };
}

/**
 * Coordinator panes the terminal restored from its saved session that no Tandem record names, as
 * records to retire: a reset or replaced home lost the records, but Herdr still reopens their
 * workspaces as plain shells when its server starts. Only a pane in a workspace with this
 * repository's generated label, sitting in the worktree this launch just leased, counts.
 */
export async function findRestoredCoordinatorPanes(
  terminal: TerminalBackend,
  input: Readonly<{
    readonly sessionId: string;
    readonly repoPath: string;
    readonly worktree: RetiredRecord["worktree"];
  }>,
): Promise<readonly RetiredRecord[]> {
  const { sessionId, repoPath, worktree } = input;
  const labelled = new Set(
    (await terminal.listWorkspaces({ sessionId, cwd: worktree.path }))
      .filter(({ label }) => label !== undefined && isCoordinatorWorkspaceLabel(label, repoPath))
      .map(({ workspaceId }) => workspaceId),
  );
  if (labelled.size === 0) return [];
  const physical = (path: string) => realpath(path).catch(() => path);
  const leased = await physical(worktree.path);
  const restored: RetiredRecord[] = [];
  for (const pane of await terminal.listPanes({ sessionId, cwd: worktree.path })) {
    if (!labelled.has(pane.workspaceId) || (await physical(pane.cwd)) !== leased) continue;
    restored.push({
      repoPath,
      worktree,
      endpoint: {
        terminal: terminal.name,
        sessionId,
        workspaceId: pane.workspaceId,
        tabId: pane.tabId,
        paneId: pane.paneId,
        role: "coordinator",
        generation: 0,
      },
    });
  }
  return restored;
}
