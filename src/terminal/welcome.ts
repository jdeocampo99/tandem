import { promptPane, WELCOME_PANE_VARIABLE } from "../adapters/herdr.ts";
import type { TandemEnvironmentSource } from "../config/environment.ts";
import type { CommandRunner } from "../contracts.ts";
import { isCloseKey } from "./process.ts";

/** The popup's frame shows this as its title (`herdr-plugin/herdr-plugin.toml`), so it prints once. */
const WELCOME_TITLE = "Welcome to Tandem";

const WELCOME_BODY = `Tandem runs a team of agents on your repos. They
research, write code, review it, and open draft PRs.
You approve each step.

prefix+t shows status anytime.`;

/** What Enter sends to the Tandem coordinator; its setup context has it open the setup page. */
export const WELCOME_PROMPT = "Onboard me to Tandem";

/**
 * The welcome with its title, for places without the popup's frame: the chat and a plain terminal.
 * There is no Enter to press there, so it says what to type.
 */
export const WELCOME_TEXT = `${WELCOME_TITLE}\n\n${WELCOME_BODY}\n\nTo start, say "${WELCOME_PROMPT}".`;

type WelcomeKey = "start" | "close";

/** Waits for Enter (start) or Esc, q, or Ctrl-C (close); without a terminal it closes at once. */
export function readWelcomeKey(input: NodeJS.ReadableStream): Promise<WelcomeKey> {
  const tty = input as NodeJS.ReadableStream & {
    readonly isTTY?: unknown;
    readonly setRawMode?: (raw: boolean) => unknown;
  };
  if (tty.isTTY !== true || typeof tty.setRawMode !== "function") {
    return Promise.resolve("close");
  }
  const setRawMode = tty.setRawMode.bind(tty);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      const key = chunk.toString();
      const pressed: WelcomeKey | undefined =
        key === "\r" || key === "\n" ? "start" : isCloseKey(key) ? "close" : undefined;
      if (pressed === undefined) return;
      input.off("data", onData);
      setRawMode(false);
      input.pause();
      resolve(pressed);
    };
    setRawMode(true);
    input.on("data", onData);
    input.resume();
  });
}

/**
 * `tandem welcome`: the popup the Tandem coordinator opens while no other project is set up. Enter
 * sends the onboarding prompt to that coordinator's pane. Outside the popup it only prints.
 */
export async function runWelcome(
  deps: Readonly<{
    readonly input: NodeJS.ReadableStream;
    readonly stdout: (text: string) => void;
    readonly run: CommandRunner;
    readonly environment: TandemEnvironmentSource;
    readonly cwd: string;
  }>,
): Promise<void> {
  const paneId = deps.environment[WELCOME_PANE_VARIABLE];
  const sessionId = deps.environment.HERDR_SESSION ?? deps.environment.HERDR_SESSION_NAME;
  if (paneId === undefined || sessionId === undefined) {
    deps.stdout(`${WELCOME_TEXT}\n`);
    return;
  }
  deps.stdout(`${WELCOME_BODY}\n\nPress Enter to start, or Esc to close.`);
  if ((await readWelcomeKey(deps.input)) === "close") return;
  await promptPane(deps.run, { sessionId, cwd: deps.cwd, paneId, text: WELCOME_PROMPT });
}
