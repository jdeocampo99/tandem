import type { TandemEnvironmentSource } from "../../config/environment.ts";
import type { InheritedPane, TerminalContext } from "../contract.ts";
import { PANE_IDENTITY_VARIABLES } from "../identity.ts";
import { PANEL_ENTRYPOINT, WELCOME_PANE_VARIABLE } from "./ui.ts";

function inheritedPane(source: TandemEnvironmentSource): InheritedPane {
  const sessionId = source.HERDR_SESSION ?? source.HERDR_SESSION_NAME;
  const workspaceId = source.HERDR_WORKSPACE_ID;
  const paneId = source.HERDR_PANE_ID;
  const active = source.HERDR_ENV === "1" || source.HERDR_ENV === "true";
  if (!active) {
    return sessionId === undefined && workspaceId === undefined && paneId === undefined
      ? { status: "outside" }
      : {
          status: "invalid",
          reason:
            "Herdr identity variables are present while HERDR_ENV is inactive; refusing to guess the active pane",
        };
  }
  if (sessionId === undefined || workspaceId === undefined || paneId === undefined) {
    return {
      status: "invalid",
      reason:
        "existing Herdr context is incomplete; require HERDR_SESSION, HERDR_WORKSPACE_ID, and HERDR_PANE_ID",
    };
  }
  return { status: "inside", sessionId, workspaceId, paneId };
}

/**
 * The pane Herdr says this process runs in, only when Herdr is active and its session is the
 * Tandem session; a pane id from another session would name a pane Tandem cannot address.
 */
function paneInSession(source: TandemEnvironmentSource, sessionId: string): string | undefined {
  const active = source.HERDR_ENV?.trim().toLowerCase();
  if (active !== "1" && active !== "true") return undefined;
  const herdrSession = (source.HERDR_SESSION ?? source.HERDR_SESSION_NAME)?.trim();
  if (herdrSession !== sessionId) return undefined;
  const paneId = source.HERDR_PANE_ID?.trim();
  return paneId === undefined || paneId.length === 0 || paneId.includes("\0") ? undefined : paneId;
}

/**
 * Where Herdr's focus is, from what it hands a plugin pane, plugin action, or popup command.
 * `HERDR_WORKSPACE_ID` is not used: the Herdr server inherits the first coordinator's.
 */
function focus(source: TandemEnvironmentSource): Readonly<{ workspaceId?: string; cwd?: string }> {
  let context: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(source.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    if (typeof parsed === "object" && parsed !== null) context = parsed as Record<string, unknown>;
  } catch {
    // No context; the active-pane variables or the caller's directory decide.
  }
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const workspaceId = source.HERDR_ACTIVE_WORKSPACE_ID ?? text(context.workspace_id);
  const cwd = text(context.focused_pane_cwd) ?? source.HERDR_ACTIVE_PANE_CWD;
  return {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

export const HERDR_CONTEXT: TerminalContext = {
  variables: PANE_IDENTITY_VARIABLES.herdr,
  inheritedPane,
  inWindow: (source) => inheritedPane(source).status === "inside",
  sessionName: (source) => source.HERDR_SESSION ?? source.HERDR_SESSION_NAME,
  workspaceId: (source) => source.HERDR_WORKSPACE_ID,
  paneInSession,
  focus,
  panelPaneId: (source) =>
    source.HERDR_PLUGIN_ENTRYPOINT_ID === PANEL_ENTRYPOINT ? source.HERDR_PANE_ID : undefined,
  welcomePaneId: (source) => source[WELCOME_PANE_VARIABLE],
};
