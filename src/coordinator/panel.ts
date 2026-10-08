import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../runtime/schema.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { ensurePrivateDirectoryTree } from "./lock.ts";
import {
  type CoordinatorRecord,
  canonicalHome,
  digest,
  registrySessionDirectory,
} from "./record.ts";

type PanelRecord = Pick<CoordinatorRecord, "repoPath" | "endpoint" | "worktree">;

/** What closing a coordinator's panel did; `failed` leaves the panel and its workspace alone. */
export type PanelClosing =
  | Readonly<{ readonly outcome: "none" }>
  | Readonly<{ readonly outcome: "closed"; readonly paneId: string }>
  | Readonly<{ readonly outcome: "failed"; readonly reason: string }>;

/**
 * Where a coordinator's panel pane id is kept: beside its record in the registry, but not in it,
 * so a Tandem that predates the panel still reads the record.
 */
async function panelFile(home: string, record: PanelRecord): Promise<string> {
  return join(
    registrySessionDirectory(await canonicalHome(home), record.endpoint.sessionId),
    `${digest(record.repoPath)}.panel`,
  );
}

/** The recorded panel pane id; a missing or unreadable file means no panel was recorded. */
export async function readPanelPaneId(
  home: string,
  record: PanelRecord,
): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(await panelFile(home, record), "utf8"));
    return isRecord(value) && typeof value.paneId === "string" ? value.paneId : undefined;
  } catch {
    return undefined;
  }
}

async function savePanelPaneId(home: string, record: PanelRecord, paneId: string): Promise<void> {
  const path = await panelFile(home, record);
  await ensurePrivateDirectoryTree(join(path, ".."), "coordinator registry directory");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ paneId })}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Opens the Tandem panel right of the coordinator unless its recorded panel is still there, and
 * records the new pane; the panel keeps its own width. Returns why it could not, so a panel
 * never blocks its coordinator.
 */
export async function openPanelBeside(
  terminal: TerminalBackend,
  home: string,
  record: PanelRecord,
): Promise<string | undefined> {
  try {
    const recorded = await readPanelPaneId(home, record);
    if (
      recorded !== undefined &&
      (await terminal.isPanelOpen({
        coordinator: record.endpoint,
        cwd: record.worktree.path,
        panelPaneId: recorded,
      }))
    ) {
      return undefined;
    }
    const panelPaneId = await terminal.openPanel({
      coordinator: record.endpoint,
      cwd: record.worktree.path,
      project: record.repoPath,
    });
    await savePanelPaneId(home, record, panelPaneId);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Closes a coordinator's recorded panel, so a lone panel never keeps a retired workspace alive. Never throws. */
export async function closeCoordinatorPanel(
  terminal: TerminalBackend,
  home: string,
  record: PanelRecord,
): Promise<PanelClosing> {
  const paneId = await readPanelPaneId(home, record);
  if (paneId === undefined) return { outcome: "none" };
  try {
    const open = await terminal.isPanelOpen({
      coordinator: record.endpoint,
      cwd: record.worktree.path,
      panelPaneId: paneId,
    });
    if (!open) return { outcome: "none" };
    await terminal.closePanel({
      sessionId: record.endpoint.sessionId,
      cwd: record.worktree.path,
      panelPaneId: paneId,
    });
    await rm(await panelFile(home, record), { force: true });
    return { outcome: "closed", paneId };
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
