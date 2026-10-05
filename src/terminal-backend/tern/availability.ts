import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../../contracts.ts";
import type { TerminalAvailability } from "../contract.ts";

export const TERN_EXECUTABLE = "/Applications/Tern.app/Contents/MacOS/tern";

/** Check the window's account gate in a private daemon, without inspecting any user's pane. */
export async function probeTern(
  run: CommandRunner,
  timing: Readonly<{ now?: () => number; sleep?: (milliseconds: number) => Promise<unknown> }> = {},
): Promise<TerminalAvailability> {
  const now = timing.now ?? Date.now;
  const sleep = timing.sleep ?? Bun.sleep;
  try {
    const version = await run({
      argv: [TERN_EXECUTABLE, "--version"],
      cwd: tmpdir(),
      timeoutMs: 3_000,
    });
    if (version.code !== 0) return { status: "missing" };
  } catch {
    return { status: "missing" };
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "td-tern-")));
  const control = join(root, "c.sock");
  const env = {
    TERN_CONFIG_DIR: join(root, "config"),
    TERN_DAEMON_SOCKET: join(root, "d.sock"),
    TANDEM_HOME: join(root, "home"),
    ZDOTDIR: join(root, "zdot"),
    STENCIL_LOG_DIR: join(root, "logs"),
  };
  const daemonStop = new AbortController();
  const windowStop = new AbortController();
  let daemon: Promise<unknown> | undefined;
  let window: Promise<unknown> | undefined;
  const call = (args: readonly string[]) =>
    run({ argv: [TERN_EXECUTABLE, ...args], cwd: root, env, timeoutMs: 1_000 });
  try {
    await Promise.all(
      Object.values(env)
        .filter((path) => path !== env.TERN_DAEMON_SOCKET)
        .map((path) => mkdir(path)),
    );
    daemon = run({
      argv: [TERN_EXECUTABLE, "daemon", "--socket", env.TERN_DAEMON_SOCKET],
      cwd: root,
      env,
      signal: daemonStop.signal,
      timeoutMs: 10_000,
    }).catch(() => undefined);
    let ready = false;
    const daemonDeadline = now() + 2_000;
    while (now() < daemonDeadline) {
      try {
        ready = (await call(["ls", "--json"])).code === 0;
      } catch {
        /* Daemon is starting. */
      }
      if (ready) break;
      await sleep(50);
    }
    if (!ready) return { status: "unknown", reason: "Tern could not start." };
    window = run({
      argv: [TERN_EXECUTABLE, "--control", control, "--dir", root],
      cwd: root,
      env,
      signal: windowStop.signal,
      timeoutMs: 8_000,
    }).catch(() => undefined);
    const windowDeadline = now() + 3_000;
    while (now() < windowDeadline) {
      try {
        const result = await call(["ctl", "--control", control, "state"]);
        if (result.code === 0) {
          const value: unknown = JSON.parse(result.stdout);
          if (typeof value === "object" && value !== null && "gate" in value) {
            const gate = value.gate;
            if (typeof gate === "object" && gate !== null && "signed_in" in gate) {
              if (gate.signed_in === true) return { status: "ready" };
              if (gate.signed_in === false)
                return {
                  status: "signedOut",
                };
            }
          }
        }
      } catch {
        /* The isolated window is starting. */
      }
      await sleep(50);
    }
    return {
      status: "unknown",
      reason: "Tern's sign-in state could not be confirmed.",
    };
  } catch {
    return { status: "unknown", reason: "Tern could not be checked." };
  } finally {
    if (window !== undefined)
      await call(["ctl", "--control", control, "quit"]).catch(() => undefined);
    windowStop.abort();
    await window;
    daemonStop.abort();
    await daemon;
    await rm(root, { recursive: true, force: true });
  }
}
