import { AdapterError } from "../adapters/primitives.ts";
import type { TandemEnvironmentSource } from "../config/environment.ts";
import { type HomeSettings, readHomeSettingsSync } from "../config/home-settings.ts";
import type { CommandRunner, TerminalName } from "../contracts.ts";
import type { SessionTarget, TerminalBackend, TerminalContext } from "./contract.ts";
import { type HerdrBackendOptions, herdrBackend } from "./herdr/backend.ts";
import { HERDR_CONTEXT } from "./herdr/context.ts";
import { assertTerminalEndpoint, guardTerminalIdentity } from "./identity.ts";
import { type TernBackendOptions, ternBackend, ternNotificationEndpoint } from "./tern/backend.ts";
import { TERN_CONTEXT } from "./tern/context.ts";
import {
  ensureTernPlugin,
  reloadTernPlugin,
  restoreTernPluginPreferences,
  type TernPluginDependencies,
  TernRequiredError,
} from "./tern/plugin.ts";

export type TerminalComposition = Readonly<{
  /** Overrides saved settings; without either choice, Tern is the default. */
  terminal?: TerminalName;
  /** Explicit Tandem home supplies saved settings and durable notification ownership. */
  home?: string;
  herdr?: HerdrBackendOptions;
  tern?: TernBackendOptions;
}>;

/** Resolve the dedicated helper from the one durable project owner, never a substitute pane. */
async function notificationEndpointFor(home: string, target: SessionTarget) {
  // Keep coordinator harness imports out of validation and worker startup.
  const [{ canonicalPath }, { listCoordinatorRecords }] = await Promise.all([
    import("../coordinator/record.ts"),
    import("../coordinator/registry.ts"),
  ]);
  const cwd = await canonicalPath(target.cwd, "notification cwd");
  const records = (await listCoordinatorRecords(home, target.sessionId)).filter(
    (record) => record.repoPath === cwd || record.worktree.path === cwd,
  );
  if (records.length > 1)
    throw new AdapterError("Tern alert project owner is ambiguous", "tern notify");
  const owner = records[0]?.endpoint;
  if (owner === undefined) return undefined;
  assertTerminalEndpoint("tern", owner);
  return ternNotificationEndpoint(owner);
}

/** An absent `terminal` setting means Tern; Herdr runs only when settings say so. */
export function savedTerminal(settings: HomeSettings): TerminalName {
  return settings.terminal ?? "tern";
}

/** The only place the saved terminal chooses an implementation. */
export function terminalBackend(
  run: CommandRunner,
  options: TerminalComposition = {},
): TerminalBackend {
  // Keep each adapter's ownership and uncertain-effect ledger across successive calls.
  const backends = new Map<TerminalName, TerminalBackend>();
  const select = (): TerminalBackend => {
    const chosen =
      options.terminal ??
      (options.home === undefined ? "tern" : savedTerminal(readHomeSettingsSync(options.home)));
    const cached = backends.get(chosen);
    if (cached !== undefined) return cached;
    const home = options.home;
    const notificationEndpoint =
      options.tern?.notificationEndpoint ??
      (home === undefined
        ? undefined
        : (target: SessionTarget) => notificationEndpointFor(home, target));
    const backend =
      chosen === "herdr"
        ? herdrBackend(run, options.herdr)
        : ternBackend(run, {
            ...options.tern,
            ...(home === undefined ? {} : { home }),
            ...(notificationEndpoint === undefined
              ? {}
              : {
                  notificationEndpoint: async (target) => {
                    const endpoint = await notificationEndpoint(target);
                    if (endpoint !== undefined) assertTerminalEndpoint("tern", endpoint);
                    return endpoint;
                  },
                }),
          });
    if (backend.name !== chosen)
      throw new Error(`terminal factory returned ${backend.name} for ${chosen}`);
    const guarded = guardTerminalIdentity(backend);
    backends.set(chosen, guarded);
    return guarded;
  };
  return {
    get name() {
      return select().name;
    },
    get views() {
      return select().views;
    },
    quarantinedPanes: (home) => select().quarantinedPanes(home),
    clearPaneQuarantine: (pane, conclusive) => select().clearPaneQuarantine(pane, conclusive),
    inspect: (input) => select().inspect(input),
    runCommand: (input) => select().runCommand(input),
    sendKeys: (input) => select().sendKeys(input),
    interrupt: (input) => select().interrupt(input),
    close: (input) => select().close(input),
    closeOwned: (input) => select().closeOwned(input),
    isPaneGone: (input) => select().isPaneGone(input),
    isEndpointGone: (input) => select().isEndpointGone(input),
    createWorkspace: (input) => select().createWorkspace(input),
    splitBeside: (input) => select().splitBeside(input),
    listWorkspaces: (input) => select().listWorkspaces(input),
    orderWorkspaceAfter: (input) => select().orderWorkspaceAfter(input),
    workspaceLabel: (input) => select().workspaceLabel(input),
    renameWorkspace: (input) => select().renameWorkspace(input),
    listPanes: (input) => select().listPanes(input),
    snapshot: (input) => select().snapshot(input),
    focusWorkspace: (input) => select().focusWorkspace(input),
    focusAgent: (input) => select().focusAgent(input),
    sessionRunning: (input) => select().sessionRunning(input),
    sessionDetail: (input) => select().sessionDetail(input),
    serverCommand: (input) => select().serverCommand(input),
    clientCommand: (input) => select().clientCommand(input),
    checkInstall: (input) => select().checkInstall(input),
    notify: (input) => select().notify(input),
    openWelcome: (input) => select().openWelcome(input),
    promptAgent: (input) => select().promptAgent(input),
    openPanel: (input) => select().openPanel(input),
    isPanelOpen: (input) => select().isPanelOpen(input),
    closePanel: (input) => select().closePanel(input),
    fitPanel: (input) => select().fitPanel(input),
    agentStatusReporter: (input) => select().agentStatusReporter(input),
  };
}

/** A launch uses its selected backend's context, so foreign inherited ids are ignored. */
export function terminalContextFor(terminal: TerminalName): TerminalContext {
  return terminal === "tern" ? TERN_CONTEXT : HERDR_CONTEXT;
}

/** A newly launched terminal must not inherit the other terminal's pane identity. */
export function terminalLaunchEnvironment(
  terminal: TerminalName,
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const foreign = terminalContextFor(terminal === "tern" ? "herdr" : "tern").variables;
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !foreign.includes(name)),
  );
}

function inheritedContext(source: TandemEnvironmentSource): TerminalContext | undefined {
  const herdr = HERDR_CONTEXT.inheritedPane(source).status !== "outside";
  const tern = TERN_CONTEXT.inheritedPane(source).status !== "outside";
  if (herdr && tern) return undefined;
  return tern ? TERN_CONTEXT : HERDR_CONTEXT;
}

/** Pure inherited context detection; mixed terminal identities never select a pane. */
export const terminalContext: TerminalContext = {
  variables: [...new Set([...HERDR_CONTEXT.variables, ...TERN_CONTEXT.variables])],
  inheritedPane: (source) =>
    inheritedContext(source)?.inheritedPane(source) ?? {
      status: "invalid",
      reason: "Both Herdr and Tern pane contexts are present; ownership is ambiguous",
    },
  sessionName: (source) => inheritedContext(source)?.sessionName(source),
  workspaceId: (source) => inheritedContext(source)?.workspaceId(source),
  paneInSession: (source, sessionId) => inheritedContext(source)?.paneInSession(source, sessionId),
  focus: (source) => inheritedContext(source)?.focus(source) ?? {},
  panelPaneId: (source) => inheritedContext(source)?.panelPaneId(source),
  welcomePaneId: (source) => inheritedContext(source)?.welcomePaneId(source),
};

/**
 * Links Tandem's views into Tern, unless settings explicitly choose Herdr, in which case Tern's
 * preferences Tandem changed are restored. Throws when Tern cannot be used.
 */
export async function installTerminalPlugin(
  home: string,
  dependencies: TernPluginDependencies,
): Promise<void> {
  if (savedTerminal(readHomeSettingsSync(home)) === "herdr") {
    await restoreTernPluginPreferences(dependencies);
    return;
  }
  if (!(await ensureTernPlugin(dependencies))) throw new TernRequiredError();
}

/** Refresh window bindings only for the selected terminal, after a successful update. */
export async function reloadTerminalPlugin(
  home: string,
  dependencies: TernPluginDependencies,
): Promise<boolean> {
  if (savedTerminal(readHomeSettingsSync(home)) === "tern") return reloadTernPlugin(dependencies);
  await restoreTernPluginPreferences(dependencies);
  return false;
}
