import type { CommandRunner } from "../../contracts.ts";
import type { TerminalBackend } from "../contract.ts";
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

export type HerdrBackendOptions = Readonly<{ moveWorkspace?: WorkspaceMover }>;

/** The terminal port over `herdr --session <session>` commands sent through `run`. */
export function herdrBackend(
  run: CommandRunner,
  options: HerdrBackendOptions = {},
): TerminalBackend {
  return {
    name: "herdr",
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
    checkInstall: (target) => checkInstall(run, target),
    notify: (target) => notify(run, target),
    openWelcome: (target) => openWelcome(run, target),
    promptAgent: (target) => promptAgent(run, target),
    openPanel: (input) => openPanel(run, input),
    isPanelOpen: (input) => isPanelOpen(run, input),
    closePanel: (target) => closePanel(run, target),
    fitPanel: async (target) => ({ fittedWidth: await fitPanel(run, target), warnings: [] }),
    agentStatusReporter: (input) => agentStatusReporter(run, input),
  };
}
