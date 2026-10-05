import { type HomeSettings, readHomeSettingsSync } from "../config/home-settings.ts";
import type { CommandRunner, TerminalName } from "../contracts.ts";
import type { TerminalBackend, TerminalContext } from "./contract.ts";
import { type HerdrBackendOptions, herdrBackend } from "./herdr/backend.ts";
import { HERDR_CONTEXT } from "./herdr/context.ts";
import { guardTerminalIdentity } from "./identity.ts";
import { probeTern } from "./tern/availability.ts";
import {
  ensureTernPlugin,
  reloadTernPlugin,
  restoreTernPluginPreferences,
  type TernPluginDependencies,
} from "./tern/plugin.ts";

export type TerminalComposition = Readonly<{
  /** Explicit Tandem home; omitted for isolated tests, which keep Herdr. */
  home?: string;
  herdr?: HerdrBackendOptions;
  /** Filled by the stacked Tern adapter; absence refuses Tern before any terminal effect. */
  tern?: (run: CommandRunner) => TerminalBackend;
}>;

/** The saved choice shown by onboarding; an absent preference keeps Herdr until confirmed. */
export function savedTerminalPreference(settings: HomeSettings) {
  return { terminal: settings.terminal ?? "herdr", chosen: settings.terminal !== undefined };
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
      options.home === undefined
        ? "herdr"
        : savedTerminalPreference(readHomeSettingsSync(options.home)).terminal;
    const cached = backends.get(chosen);
    if (cached !== undefined) return cached;
    const backend = chosen === "herdr" ? herdrBackend(run, options.herdr) : options.tern?.(run);
    if (backend === undefined)
      throw new Error("Tern's terminal backend is unavailable in this build; choose Herdr.");
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

/** How a process reads its inherited terminal pane from its environment; pure, so imported. */
export const terminalContext: TerminalContext = HERDR_CONTEXT;

/** Onboarding checks availability through the same terminal composition boundary. */
export const ternAvailability = probeTern;

/** Onboarding uses the same composition boundary as backend selection. */
export async function installTerminalPlugin(
  home: string,
  dependencies: TernPluginDependencies,
): Promise<boolean> {
  const selected = readHomeSettingsSync(home).terminal;
  if (selected === "tern") return ensureTernPlugin(dependencies);
  if (selected === "herdr") await restoreTernPluginPreferences(dependencies);
  return true;
}

/** Refresh window bindings only for the selected terminal, after a successful update. */
export async function reloadTerminalPlugin(
  home: string,
  dependencies: TernPluginDependencies,
): Promise<boolean> {
  const selected = readHomeSettingsSync(home).terminal;
  if (selected === "tern") return reloadTernPlugin(dependencies);
  if (selected === "herdr") await restoreTernPluginPreferences(dependencies);
  return false;
}
