import { runCommand } from "../adapters/commands.ts";
import { resolveTandemEnvironment } from "../config/environment.ts";
import { readHomeSettings } from "../config/home-settings.ts";
import { DEFAULT_TERMINAL_SESSION_ID } from "../terminal/environment.ts";
import { installTerminalPlugin, savedTerminal } from "./compose.ts";
import { setUpHerdrIntegration } from "./herdr/setup.ts";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const environment = resolveTandemEnvironment(process.env, {
    cwd,
    sessionId: DEFAULT_TERMINAL_SESSION_ID,
  });
  if (savedTerminal(await readHomeSettings(environment.home)) === "herdr") {
    await setUpHerdrIntegration();
    return;
  }
  await installTerminalPlugin(environment.home, {
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
    print: (text) => process.stdout.write(text),
  });
  process.stdout.write("✓ Tandem's Tern views and shortcuts are ready\n");
}

if (import.meta.main) await main();
