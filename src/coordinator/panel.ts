import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeEndpoint, inspectEndpoint, TANDEM_HERDR_PLUGIN } from "../adapters/herdr.ts";
import { AdapterCommandError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandResult, CommandRunner, Endpoint } from "../contracts.ts";
import { ensurePrivateDirectoryTree } from "./lock.ts";
import { assertStoppedCoordinatorShell, commandErrorCode, parseJson } from "./ownership.ts";
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

type PanelRecord = Pick<CoordinatorRecord, "repoPath" | "endpoint" | "worktree">;

/**
 * What closing a coordinator's panel did. `busy` and `failed` leave the pane alone; `busy` is a
 * shell Herdr restored in the panel's place that is still running something, such as its startup.
 */
export type PanelClosing =
  | Readonly<{ readonly outcome: "none" }>
  | Readonly<{ readonly outcome: "closed"; readonly paneId: string }>
  | Readonly<{ readonly outcome: "busy"; readonly reason: string }>
  | Readonly<{ readonly outcome: "failed"; readonly reason: string }>;

/**
 * The recorded panel pane as it is now. After a server restart Herdr reopens a plugin pane as a
 * plain shell with the same title and no plugin behind it; only its processes tell them apart.
 */
type RecordedPanel =
  | Readonly<{ readonly kind: "gone" }>
  | Readonly<{ readonly kind: "running" }>
  | Readonly<{ readonly kind: "idle-shell"; readonly endpoint: Endpoint }>;

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
 * records the new pane; the panel keeps its own width. Returns why it could not, so a panel
 * never blocks its coordinator.
 */
export async function openPanelBeside(
  run: CommandRunner,
  home: string,
  record: PanelRecord,
): Promise<string | undefined> {
  try {
    const recorded = await readPanelPaneId(home, record);
    const panel: RecordedPanel =
      recorded === undefined ? { kind: "gone" } : await readRecordedPanel(run, record, recorded);
    if (panel.kind === "running") return undefined;
    if (panel.kind === "idle-shell") {
      await closeEndpoint(run, { endpoint: panel.endpoint, cwd: record.worktree.path });
    }
    const panelPaneId = await openPanelPane(run, record);
    await savePanelPaneId(home, record, panelPaneId);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Closes a coordinator's recorded panel, so a lone panel never keeps a retired workspace alive.
 * A shell Herdr restored in the panel's place closes only once it is proven an idle shell, the
 * proof the coordinator's own pane gets; `plugin pane close` refuses any other pane no plugin
 * owns. Never throws.
 */
export async function closeCoordinatorPanel(
  run: CommandRunner,
  home: string,
  record: PanelRecord,
): Promise<PanelClosing> {
  const paneId = await readPanelPaneId(home, record);
  if (paneId === undefined) return { outcome: "none" };
  try {
    const panel = await readRecordedPanel(run, record, paneId);
    if (panel.kind === "gone") return { outcome: "none" };
    if (panel.kind === "idle-shell") {
      await closeEndpoint(run, { endpoint: panel.endpoint, cwd: record.worktree.path });
    } else {
      const request = herdr(record, ["plugin", "pane", "close", paneId]);
      const closed = await run(request);
      if (closed.code !== 0 && errorCode(closed) === "plugin_pane_not_found") {
        return {
          outcome: "busy",
          reason: `panel pane ${JSON.stringify(paneId)} is a restored shell still running a program`,
        };
      }
      if (closed.code !== 0) {
        throw new AdapterCommandError("herdr plugin pane close", request, closed);
      }
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

async function readRecordedPanel(
  run: CommandRunner,
  record: PanelRecord,
  panelPaneId: string,
): Promise<RecordedPanel> {
  const request = herdr(record, ["pane", "get", panelPaneId]);
  const result = await run(request);
  if (result.code !== 0) {
    if (errorCode(result) === "pane_not_found") return { kind: "gone" };
    throw new AdapterCommandError("herdr pane get", request, result);
  }
  const paneGet = parseJson(result.stdout, "herdr pane get");
  if (!isCoordinatorPanel(paneGet, record.endpoint.workspaceId, panelPaneId)) {
    return { kind: "gone" };
  }
  const pane = isRecord(paneGet) && isRecord(paneGet.result) ? paneGet.result.pane : undefined;
  const tabId = isRecord(pane) && typeof pane.tab_id === "string" ? pane.tab_id : undefined;
  if (tabId === undefined) throw new Error("herdr pane get returned no tab for the panel");
  const endpoint: Endpoint = { ...record.endpoint, tabId, paneId: panelPaneId };
  const inspection = await inspectEndpoint(run, { endpoint, cwd: record.worktree.path });
  try {
    assertStoppedCoordinatorShell(inspection);
  } catch {
    return { kind: "running" };
  }
  return { kind: "idle-shell", endpoint };
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
