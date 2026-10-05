import {
  AdapterCommandError,
  checkedText,
  isRecord,
  runChecked,
} from "../../adapters/primitives.ts";
import type { CommandRequest, CommandRunner, Endpoint } from "../../contracts.ts";
import type { SessionTarget } from "../contract.ts";
import { errorCode, herdrRequest, parseAnswer } from "./protocol.ts";

/** The Herdr plugin Tandem ships (`herdr-plugin/`), and the entrypoints it declares. */
export const TANDEM_HERDR_PLUGIN = "tandem.ui";
const WELCOME_ENTRYPOINT = "welcome";
export const PANEL_ENTRYPOINT = "panel";
/** How the welcome popup learns which pane to prompt: a popup has no `HERDR_PANE_ID`. */
export const WELCOME_PANE_VARIABLE = "TANDEM_WELCOME_PANE";
/** The pane title `herdr-plugin/herdr-plugin.toml` gives the panel, which Herdr shows as its label. */
const PANEL_TITLE = "Tandem panel";

/**
 * Shows a notification through the user's Herdr toast settings (in-app, system, terminal, or off),
 * with Herdr's needs-input sound.
 */
export async function notify(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ title: string; body: string }>,
): Promise<void> {
  const args = ["notification", "show", input.title, "--body", input.body, "--sound", "request"];
  await runChecked(run, herdrRequest(input.sessionId, input.cwd, args), "herdr notification show");
}

export async function openWelcome(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ paneId: string }>,
): Promise<void> {
  const paneId = checkedText(input.paneId, "paneId");
  await runChecked(
    run,
    herdrRequest(input.sessionId, input.cwd, [
      "plugin",
      "pane",
      "open",
      "--plugin",
      TANDEM_HERDR_PLUGIN,
      "--entrypoint",
      WELCOME_ENTRYPOINT,
      "--env",
      `${WELCOME_PANE_VARIABLE}=${paneId}`,
    ]),
    "herdr plugin pane open",
  );
}

/** Focuses the exact pane; Herdr allows it only for panes it knows run an agent. */
export async function focusAgent(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ paneId: string }>,
): Promise<boolean> {
  const result = await run(
    herdrRequest(input.sessionId, input.cwd, ["agent", "focus", input.paneId]),
  );
  return result.code === 0;
}

async function checked(
  run: CommandRunner,
  request: CommandRequest,
  operation: string,
): Promise<unknown> {
  const result = await run(request);
  if (result.code !== 0) throw new AdapterCommandError(operation, request, result);
  return parseAnswer(result.stdout, operation);
}

/** Herdr refuses `--workspace` together with `--target-pane`; the pane names the workspace. */
export async function openPanel(
  run: CommandRunner,
  input: Readonly<{ coordinator: Endpoint; cwd: string; project: string }>,
): Promise<string> {
  const opened = await checked(
    run,
    herdrRequest(input.coordinator.sessionId, input.cwd, [
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
      input.coordinator.paneId,
      "--direction",
      "right",
      "--no-focus",
      "--env",
      `TANDEM_PANEL_PROJECT=${input.project}`,
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

export async function isPanelOpen(
  run: CommandRunner,
  input: Readonly<{ coordinator: Endpoint; cwd: string; panelPaneId: string }>,
): Promise<boolean> {
  const request = herdrRequest(input.coordinator.sessionId, input.cwd, [
    "pane",
    "get",
    input.panelPaneId,
  ]);
  const result = await run(request);
  if (result.code !== 0) {
    if (errorCode(result) === "pane_not_found") return false;
    throw new AdapterCommandError("herdr pane get", request, result);
  }
  return isCoordinatorPanel(
    parseAnswer(result.stdout, "herdr pane get"),
    input.coordinator.workspaceId,
    input.panelPaneId,
  );
}

/** `plugin pane close` refuses panes no plugin owns, which backs up the title check. */
export async function closePanel(
  run: CommandRunner,
  input: SessionTarget & Readonly<{ panelPaneId: string }>,
): Promise<void> {
  const request = herdrRequest(input.sessionId, input.cwd, [
    "plugin",
    "pane",
    "close",
    input.panelPaneId,
  ]);
  const closed = await run(request);
  if (closed.code !== 0 && errorCode(closed) !== "plugin_pane_not_found") {
    throw new AdapterCommandError("herdr plugin pane close", request, closed);
  }
}

/** A move of the border left of the panel, as a fraction of the split's width. */
export type PanelResize = Readonly<{
  /** The window width this fit is for; the panel refits only once it changes. */
  readonly areaWidth: number;
  readonly direction: "left" | "right";
  /** 0 when the panel already fits. */
  readonly amount: number;
}>;

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

function rect(value: unknown): Rect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
    ? { x, y, width, height }
    : undefined;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * How to bring the panel back to `columns` wide, from `herdr pane layout`, or undefined to leave it
 * alone. Herdr splits keep a ratio, so the panel refits whenever the window width changes (a
 * client attaches or the terminal resizes) and never when only the border moved, which is the user
 * dragging it. It never takes more than half its split.
 */
export function panelResize(
  layout: unknown,
  paneId: string,
  fittedAreaWidth: number | undefined,
  columns: number,
): PanelResize | undefined {
  const fields =
    isRecord(layout) && isRecord(layout.result) && isRecord(layout.result.layout)
      ? layout.result.layout
      : undefined;
  const areaWidth = rect(fields?.area)?.width;
  if (areaWidth === undefined || areaWidth === fittedAreaWidth) return undefined;
  const own = rect(records(fields?.panes).find((pane) => pane.pane_id === paneId)?.rect);
  if (own === undefined) return undefined;
  const split = records(fields?.splits)
    .flatMap((entry) => {
      const bounds = rect(entry.rect);
      return entry.direction === "right" && bounds !== undefined ? [bounds] : [];
    })
    .filter(
      (bounds) =>
        bounds.x < own.x &&
        bounds.x + bounds.width === own.x + own.width &&
        bounds.y <= own.y &&
        own.y + own.height <= bounds.y + bounds.height,
    )
    .sort((a, b) => b.x - a.x)[0];
  if (split === undefined) return undefined;
  const target = Math.min(columns, Math.floor(split.width / 2));
  return {
    areaWidth,
    direction: own.width > target ? "right" : "left",
    amount: Math.abs(own.width - target) / split.width,
  };
}

export async function fitPanel(
  run: CommandRunner,
  input: SessionTarget &
    Readonly<{ paneId: string; columns: number; fittedWidth: number | undefined }>,
): Promise<number | undefined> {
  const { sessionId, cwd, paneId, fittedWidth } = input;
  const layout = await run(herdrRequest(sessionId, cwd, ["pane", "layout", "--pane", paneId]));
  if (layout.code !== 0) return fittedWidth;
  const resize = panelResize(JSON.parse(layout.stdout), paneId, fittedWidth, input.columns);
  if (resize === undefined) return fittedWidth;
  if (resize.amount === 0) return resize.areaWidth;
  const resized = await run(
    herdrRequest(sessionId, cwd, [
      "pane",
      "resize",
      "--pane",
      paneId,
      "--direction",
      resize.direction,
      "--amount",
      resize.amount.toFixed(4),
    ]),
  );
  return resized.code === 0 ? resize.areaWidth : fittedWidth;
}
