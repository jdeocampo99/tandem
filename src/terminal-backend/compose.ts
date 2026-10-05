import type { CommandRunner } from "../contracts.ts";
import type { TerminalBackend, TerminalContext } from "./contract.ts";
import { type HerdrBackendOptions, herdrBackend } from "./herdr/backend.ts";
import { HERDR_CONTEXT } from "./herdr/context.ts";
import { type TernBackendOptions, ternBackend } from "./tern/backend.ts";

/**
 * The one place Tandem picks its terminal: Herdr is the default implementation of the port. Every
 * composition root builds its backend here from the command runner it already injects.
 */
export function terminalBackend(
  run: CommandRunner,
  options: Readonly<{
    terminal?: "herdr" | "tern";
    herdr?: HerdrBackendOptions;
    tern?: TernBackendOptions;
  }> = {},
): TerminalBackend {
  return options.terminal === "tern"
    ? ternBackend(run, options.tern)
    : herdrBackend(run, options.herdr);
}

/** How a process reads its inherited terminal pane from its environment; pure, so imported. */
export const terminalContext: TerminalContext = HERDR_CONTEXT;
