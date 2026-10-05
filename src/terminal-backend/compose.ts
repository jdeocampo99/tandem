import type { CommandRunner } from "../contracts.ts";
import type { TerminalBackend, TerminalBackendOptions, TerminalContext } from "./contract.ts";
import { herdrBackend } from "./herdr/backend.ts";
import { HERDR_CONTEXT } from "./herdr/context.ts";

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
