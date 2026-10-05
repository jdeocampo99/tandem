import { createInterface } from "node:readline/promises";
import { runCommand } from "../adapters/commands.ts";
import { resolveTandemEnvironment } from "../config/environment.ts";
import { readHomeSettings } from "../config/home-settings.ts";
import { DEFAULT_TERMINAL_SESSION_ID } from "../terminal/environment.ts";
import { installTerminalPlugin, savedTerminalPreference } from "./compose.ts";
import { setUpHerdrIntegration } from "./herdr/setup.ts";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const environment = resolveTandemEnvironment(process.env, {
    cwd,
    sessionId: DEFAULT_TERMINAL_SESSION_ID,
  });
  if (savedTerminalPreference(await readHomeSettings(environment.home)).terminal !== "tern") {
    await setUpHerdrIntegration();
    return;
  }
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const linked = await installTerminalPlugin(environment.home, {
    run: runCommand,
    cwd,
    env: {
      ...(process.env.TERN_CONFIG_DIR === undefined
        ? {}
        : { TERN_CONFIG_DIR: process.env.TERN_CONFIG_DIR }),
      ...(process.env.TERN_DAEMON_SOCKET === undefined
        ? {}
        : { TERN_DAEMON_SOCKET: process.env.TERN_DAEMON_SOCKET }),
    },
    ...(interactive
      ? {
          confirm: async (question: string) => {
            const readline = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return /^y(es)?$/iu.test((await readline.question(`${question} [y/N] `)).trim());
            } finally {
              readline.close();
            }
          },
        }
      : {}),
    print: (text) => process.stdout.write(text),
  });
  process.stdout.write(
    linked
      ? "✓ Tandem's Tern views and shortcuts are ready\n"
      : "Tandem left Tern's views and shortcuts unchanged; rerun setup.sh to add them later.\n",
  );
}

if (import.meta.main) await main();
