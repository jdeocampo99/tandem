import type { TerminalContext } from "../contract.ts";
import { PANE_IDENTITY_VARIABLES } from "../identity.ts";

/** Tern exports only a pane id. Tandem launch context supplies the daemon and tab ids. */
export const TERN_CONTEXT: TerminalContext = {
  variables: PANE_IDENTITY_VARIABLES.tern,
  inheritedPane: (source) => {
    const workspaceId = source.TANDEM_TERN_WORKSPACE_ID;
    // Tandem marks the panes it launches; any other Tern pane is the user's own shell.
    if (source.TERN_PANE === undefined || workspaceId === undefined) return { status: "outside" };
    const sessionId = source.TANDEM_SESSION;
    if (!sessionId || !workspaceId || !/^[1-9]\d*$/u.test(source.TERN_PANE))
      return {
        status: "invalid",
        reason: "Tern pane context requires a recorded Tandem daemon and tab identity",
      };
    return { status: "inside", sessionId, workspaceId, paneId: source.TERN_PANE };
  },
  // `tern focus` shows a block in every window, so any Tern pane already sees the coordinator.
  inWindow: (source) => source.TERN_PANE !== undefined,
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
