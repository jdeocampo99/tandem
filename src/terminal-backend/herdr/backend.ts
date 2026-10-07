import type { CommandRunner } from "../../contracts.ts";
import type { LaunchEnvironmentInput, TerminalBackend } from "../contract.ts";
import { withoutForeignPaneIdentity } from "../identity.ts";
import {
  close,
  closeOwned,
  createWorkspace,
  inspect,
  interrupt,
  promptAgent,
  runCommand,
  sendKeys,
  splitBeside,
} from "./endpoints.ts";
import { checkInstall } from "./install.ts";
import { isEndpointGone, isPaneGone } from "./protocol.ts";
import { agentStatusReporter } from "./status.ts";
import {
  closePanel,
  fitPanel,
  focusAgent,
  isPanelOpen,
  notify,
  openPanel,
  openWelcome,
} from "./ui.ts";
import {
  focusWorkspace,
  listPanes,
  listWorkspaces,
  orderWorkspaceAfter,
  renameWorkspace,
  sessionDetail,
  sessionRunning,
  snapshot,
  type WorkspaceMover,
  workspaceLabel,
} from "./workspaces.ts";

// Herdr panes inherit the server's environment, so a pane gets the same environment as the server.
function launchEnvironment({ overrides, inherited }: LaunchEnvironmentInput) {
  return withoutForeignPaneIdentity("herdr", { ...inherited, ...overrides });
}

export type HerdrBackendOptions = Readonly<{ moveWorkspace?: WorkspaceMover }>;

/** The terminal port over `herdr --session <session>` commands sent through `run`. */
export function herdrBackend(
  run: CommandRunner,
  options: HerdrBackendOptions = {},
): TerminalBackend {
  return {
    name: "herdr",
    fences: {
      list: async () => ({ fences: [], failures: [] }),
      settle: async (fence) => ({
        status: "kept",
        reason: `Herdr keeps no ${fence.kind} records, so it never listed ${fence.path}`,
      }),
    },
    inspect: (target) => inspect(run, target),
    runCommand: (target) => runCommand(run, target),
    sendKeys: (target) => sendKeys(run, target),
    interrupt: (target) => interrupt(run, target),
    close: (target) => close(run, target),
    closeOwned: (target) => closeOwned(run, target),
    isPaneGone,
    isEndpointGone,
    createWorkspace: (target) => createWorkspace(run, target, options.moveWorkspace),
    splitBeside: (input) => splitBeside(run, input),
    listWorkspaces: (target) => listWorkspaces(run, target),
    orderWorkspaceAfter: (target) => orderWorkspaceAfter(run, target, options.moveWorkspace),
    workspaceLabel: (target) => workspaceLabel(run, target),
    renameWorkspace: (target) => renameWorkspace(run, target),
    listPanes: (target) => listPanes(run, target),
    snapshot: (target) => snapshot(run, target),
    focusWorkspace: (target) => focusWorkspace(run, target),
    focusAgent: (target) => focusAgent(run, target),
    sessionRunning: (target) => sessionRunning(run, target),
    sessionDetail: (target) => sessionDetail(run, target),
    serverCommand: (sessionId) => ["herdr", "--session", sessionId, "server"],
    clientCommand: (sessionId) => ["herdr", "--session", sessionId],
    launchEnvironment,
    paneEnvironment: launchEnvironment,
    // Herdr exports its own pane identity into every pane it starts.
    paneIdentity: () => ({}),
    checkInstall: (target) => checkInstall(run, target),
    notify: (target) => notify(run, target),
    openWelcome: (target) => openWelcome(run, target),
    // Herdr has no native blocks, so setup runs in the coordinator's chat.
    openSetup: async () => false,
    promptAgent: (target) => promptAgent(run, target),
    openPanel: (input) => openPanel(run, input),
    isPanelOpen: (input) => isPanelOpen(run, input),
    closePanel: (target) => closePanel(run, target),
    fitPanel: async (target) => ({
      fittedWidth: await fitPanel(run, target),
      warnings: [],
    }),
    agentStatusReporter: (input) => agentStatusReporter(run, input),
  };
}
