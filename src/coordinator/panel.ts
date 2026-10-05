import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TANDEM_HERDR_PLUGIN } from "../adapters/herdr.ts";
import { AdapterCommandError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandResult, CommandRunner } from "../contracts.ts";
import { ensurePrivateDirectoryTree } from "./lock.ts";
import { commandErrorCode, parseJson } from "./ownership.ts";
import {
  type CoordinatorRecord,
  canonicalHome,
  digest,
  isRecord,
  registrySessionDirectory,
} from "./record.ts";

export const PANEL_ENTRYPOINT = "panel";
/** The pane title `herdr-plugin/herdr-plugin.toml` gives the panel, which Herdr shows as its label. */
export const PANEL_TITLE = "Tandem panel";
export const PANEL_COLUMNS = 46;

type PanelRecord = Pick<CoordinatorRecord, "repoPath" | "endpoint" | "worktree">;

export type PaneWidth = Readonly<{ readonly paneId: string; readonly width: number }>;

/** What closing a coordinator's panel did; `failed` leaves the panel and its workspace alone. */
export type PanelClosing =
  | Readonly<{ readonly outcome: "none" }>
  | Readonly<{ readonly outcome: "closed"; readonly paneId: string }>
  | Readonly<{ readonly outcome: "failed"; readonly reason: string }>;

/**
 * How far to move the border between the coordinator and the panel to its right so the panel is
 * `PANEL_COLUMNS` wide, as a fraction of their combined width; undefined when it already fits.
 * Herdr has no width option for a split, only this ratio move.
 */
export function panelResizeAmount(
  panes: readonly PaneWidth[],
  coordinatorPaneId: string,
  panelPaneId: string,
): number | undefined {
  const coordinator = panes.find((pane) => pane.paneId === coordinatorPaneId)?.width;
  const panel = panes.find((pane) => pane.paneId === panelPaneId)?.width;
  if (coordinator === undefined || panel === undefined || panel <= PANEL_COLUMNS) return undefined;
  return (panel - PANEL_COLUMNS) / (coordinator + panel);
}

/**
 * Whether Herdr's `pane get` answer is the panel pane in the coordinator's workspace, carrying the
 * panel's title. Herdr's pane list cannot tell plugin panes apart, so the title stands in.
 */
export function isCoordinatorPanel(
  paneGet: unknown,
  workspaceId: string,
  panelPaneId: string,
): boolean {
  const pane = isRecord(paneGet) && isRecord(paneGet.result) ? paneGet.result.pane : undefined;
  return (
    isRecord(pane) &&
    pane.pane_id === panelPaneId &&
    pane.workspace_id === workspaceId &&
    pane.label === PANEL_TITLE
  );
}

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
 * records the new pane. Returns why it could not, so a panel never blocks its coordinator.
 */
export async function openPanelBeside(
  run: CommandRunner,
  home: string,
  record: PanelRecord,
): Promise<string | undefined> {
  try {
    const recorded = await readPanelPaneId(home, record);
    if (recorded !== undefined && (await panelStillOpen(run, record, recorded))) return undefined;
    const panelPaneId = await openPanelPane(run, record);
    await savePanelPaneId(home, record, panelPaneId);
    await fitPanel(run, record, panelPaneId);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Closes a coordinator's recorded panel, so a lone panel never keeps a retired workspace alive.
 * `plugin pane close` refuses panes no plugin owns, which backs up the title check. Never throws.
 */
export async function closeCoordinatorPanel(
  run: CommandRunner,
  home: string,
  record: PanelRecord,
): Promise<PanelClosing> {
  const paneId = await readPanelPaneId(home, record);
  if (paneId === undefined) return { outcome: "none" };
  try {
    if (!(await panelStillOpen(run, record, paneId))) return { outcome: "none" };
    const request = herdr(record, ["plugin", "pane", "close", paneId]);
    const closed = await run(request);
    if (closed.code !== 0 && errorCode(closed) !== "plugin_pane_not_found") {
      throw new AdapterCommandError("herdr plugin pane close", request, closed);
    }
    await rm(await panelFile(home, record), { force: true });
    return { outcome: "closed", paneId };
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

function herdr(record: PanelRecord, args: readonly string[]): CommandRequest {
  return {
    argv: ["herdr", "--session", record.endpoint.sessionId, ...args],
    cwd: record.worktree.path,
  };
}

function errorCode(result: CommandResult): string | undefined {
  return commandErrorCode(result.stdout, result.stderr);
}

async function checked(
  run: CommandRunner,
  request: CommandRequest,
  operation: string,
): Promise<unknown> {
  const result = await run(request);
  if (result.code !== 0) throw new AdapterCommandError(operation, request, result);
  return parseJson(result.stdout, operation);
}

async function panelStillOpen(
  run: CommandRunner,
  record: PanelRecord,
  panelPaneId: string,
): Promise<boolean> {
  const request = herdr(record, ["pane", "get", panelPaneId]);
  const result = await run(request);
  if (result.code !== 0) {
    if (errorCode(result) === "pane_not_found") return false;
    throw new AdapterCommandError("herdr pane get", request, result);
  }
  return isCoordinatorPanel(
    parseJson(result.stdout, "herdr pane get"),
    record.endpoint.workspaceId,
    panelPaneId,
  );
}

/** Herdr refuses `--workspace` together with `--target-pane`; the pane names the workspace. */
async function openPanelPane(run: CommandRunner, record: PanelRecord): Promise<string> {
  const opened = await checked(
    run,
    herdr(record, [
      "plugin",
      "pane",
      "open",
      "--plugin",
      TANDEM_HERDR_PLUGIN,
      "--entrypoint",
      PANEL_ENTRYPOINT,
      "--placement",
      "split",
      "--target-pane",
      record.endpoint.paneId,
      "--direction",
      "right",
      "--no-focus",
      "--env",
      `TANDEM_PANEL_PROJECT=${record.repoPath}`,
    ]),
    "herdr plugin pane open",
  );
  const pluginPane =
    isRecord(opened) && isRecord(opened.result) ? opened.result.plugin_pane : undefined;
  const pane = isRecord(pluginPane) ? pluginPane.pane : undefined;
  if (!isRecord(pane) || typeof pane.pane_id !== "string") {
    throw new Error("herdr plugin pane open returned no pane id");
  }
  return pane.pane_id;
}

async function fitPanel(
  run: CommandRunner,
  record: PanelRecord,
  panelPaneId: string,
): Promise<void> {
  const layout = await checked(
    run,
    herdr(record, ["pane", "layout", "--pane", record.endpoint.paneId]),
    "herdr pane layout",
  );
  const panes =
    isRecord(layout) && isRecord(layout.result) && isRecord(layout.result.layout)
      ? layout.result.layout.panes
      : undefined;
  const widths = (Array.isArray(panes) ? panes : []).flatMap((pane): PaneWidth[] =>
    isRecord(pane) &&
    typeof pane.pane_id === "string" &&
    isRecord(pane.rect) &&
    typeof pane.rect.width === "number"
      ? [{ paneId: pane.pane_id, width: pane.rect.width }]
      : [],
  );
  const amount = panelResizeAmount(widths, record.endpoint.paneId, panelPaneId);
  if (amount === undefined) return;
  await checked(
    run,
    herdr(record, [
      "pane",
      "resize",
      "--pane",
      record.endpoint.paneId,
      "--direction",
      "right",
      "--amount",
      amount.toFixed(4),
    ]),
    "herdr pane resize",
  );
}
