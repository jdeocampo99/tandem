import type { TerminalContext } from "../contract.ts";

/** Tern exports only a pane id. Tandem launch context supplies the daemon and tab ids. */
export const TERN_CONTEXT: TerminalContext = {
  variables: [
    "TERN_PANE",
    "TERN_PANE_SOCKET",
    "TERN_WINDOW_KEY",
    "TERN_WINDOW_SOCKET",
    "TANDEM_TERN_WORKSPACE_ID",
  ],
  inheritedPane: (source) => {
    if (source.TERN_PANE === undefined) return { status: "outside" };
    const sessionId = source.TANDEM_SESSION;
    const workspaceId = source.TANDEM_TERN_WORKSPACE_ID;
    if (!sessionId || !workspaceId || !/^[1-9]\d*$/u.test(source.TERN_PANE))
      return {
        status: "invalid",
        reason: "Tern pane context requires a recorded Tandem daemon and tab identity",
      };
    return { status: "inside", sessionId, workspaceId, paneId: source.TERN_PANE };
  },
  sessionName: (source) => source.TANDEM_SESSION,
  workspaceId: (source) => source.TANDEM_TERN_WORKSPACE_ID,
  paneInSession: (source, sessionId) =>
    source.TANDEM_SESSION === sessionId &&
    source.TANDEM_TERN_WORKSPACE_ID !== undefined &&
    /^[1-9]\d*$/u.test(source.TERN_PANE ?? "")
      ? source.TERN_PANE
      : undefined,
  focus: (source) => ({
    ...(source.TANDEM_TERN_WORKSPACE_ID === undefined
      ? {}
      : { workspaceId: source.TANDEM_TERN_WORKSPACE_ID }),
  }),
  panelPaneId: () => undefined,
  welcomePaneId: () => undefined,
};
