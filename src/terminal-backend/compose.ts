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
  const [{ canonicalPath }, { findRecordedOwner }] = await Promise.all([
    import("../coordinator/record.ts"),
    import("../coordinator/recorded-owner.ts"),
  ]);
  const found = await findRecordedOwner(home, {
    by: "project",
    sessionId: target.sessionId,
    path: await canonicalPath(target.cwd, "notification cwd"),
    terminal: "any",
  });
  if (found.status === "ambiguous")
    throw new AdapterError("Tern alert project owner is ambiguous", "tern notify");
  if (found.status === "none") return undefined;
  const owner = found.record.endpoint;
  assertTerminalEndpoint("tern", owner);
  return ternNotificationEndpoint(owner);
}

/** An absent `terminal` setting means Tern; Herdr runs only when settings say so. */
export function savedTerminal(settings: HomeSettings): TerminalName {
  return settings.terminal ?? "tern";
}

/**
 * The only place the saved terminal chooses an implementation. The choice is read once, when the
 * port is composed: no Tandem action changes it, and a process keeps the terminal it started with.
 */
export function terminalBackend(
  run: CommandRunner,
  options: TerminalComposition = {},
): TerminalBackend {
  const home = options.home;
  const chosen =
    options.terminal ?? (home === undefined ? "tern" : savedTerminal(readHomeSettingsSync(home)));
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
  return guardTerminalIdentity(backend);
}

/** A launch uses its selected backend's context, so foreign inherited ids are ignored. */
export function terminalContextFor(terminal: TerminalName): TerminalContext {
  return terminal === "tern" ? TERN_CONTEXT : HERDR_CONTEXT;
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
  inWindow: (source) => TERN_CONTEXT.inWindow(source) || HERDR_CONTEXT.inWindow(source),
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
