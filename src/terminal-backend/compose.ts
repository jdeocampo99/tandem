import type { CommandRunner } from "../contracts.ts";
import type { TerminalBackend, TerminalBackendOptions, TerminalContext } from "./contract.ts";
import { herdrBackend } from "./herdr/backend.ts";
import { HERDR_CONTEXT } from "./herdr/context.ts";
import { ensureTernPlugin, reloadTernPlugin, type TernPluginDependencies } from "./tern/plugin.ts";

/**
 * The one place Tandem picks its terminal: Herdr is the only implementation of the port. Every
 * composition root builds its backend here from the command runner it already injects.
 */
export function terminalBackend(
  run: CommandRunner,
  options: TerminalBackendOptions = {},
): TerminalBackend {
  return herdrBackend(run, options);
}

/** How a process reads its inherited terminal pane from its environment; pure, so imported. */
export const terminalContext: TerminalContext = HERDR_CONTEXT;

/** Onboarding uses the same composition boundary as backend selection. */
export async function installTerminalPlugin(
  terminal: TerminalBackend,
  dependencies: TernPluginDependencies,
): Promise<boolean> {
  return terminal.name === "Tern" ? ensureTernPlugin(dependencies) : true;
}

/** Refresh window bindings only for the selected terminal, after a successful update. */
export async function reloadTerminalPlugin(
  terminal: TerminalBackend,
  dependencies: TernPluginDependencies,
): Promise<boolean> {
  return terminal.name === "Tern" ? reloadTernPlugin(dependencies) : false;
}
