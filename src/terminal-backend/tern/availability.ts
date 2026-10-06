import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStartError, CommandTimeoutError } from "../../adapters/commands.ts";
import type { CommandRunner } from "../../contracts.ts";
import type { TerminalAvailability } from "../contract.ts";

export const TERN_EXECUTABLE = "/Applications/Tern.app/Contents/MacOS/tern";
export type TernAvailabilityOptions = Readonly<{
  binary?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}>;
const PROBE_TIMEOUT_MS = 8_000;
const CONTROL_TIMEOUT_MS = 1_000;

function missingExecutable(error: unknown): boolean {
  return (
    (error instanceof CommandStartError && error.message.includes("Executable not found")) ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
  );
}

/** The native account gate requires a brief owned window; headless Tern uses synthetic accounts. */
export async function probeTern(
  run: CommandRunner,
  options: TernAvailabilityOptions = {},
): Promise<TerminalAvailability> {
  const binary = options.binary ?? Bun.which("tern") ?? TERN_EXECUTABLE;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = now() + PROBE_TIMEOUT_MS;
  const budgetStop = new AbortController();
  const budgetTimer = setTimeout(() => budgetStop.abort(), PROBE_TIMEOUT_MS);
  const daemonStop = new AbortController();
  const windowStop = new AbortController();
  let root: string | undefined;
  let daemon: Promise<unknown> | undefined;
  let window: Promise<unknown> | undefined;
  let quit: (() => ReturnType<CommandRunner>) | undefined;
  let result: TerminalAvailability;
  let cleanupFailed = false;
  let quitFailed = false;
  let timedOut = false;
  const remaining = () => {
    const milliseconds = deadline - now();
    if (milliseconds <= 0) budgetStop.abort();
    budgetStop.signal.throwIfAborted();
    return milliseconds;
  };
  const inspect = async (): Promise<TerminalAvailability> => {
    try {
      const version = await run({
        argv: [binary, "--version"],
        cwd: tmpdir(),
        timeoutMs: Math.min(3_000, remaining()),
        signal: budgetStop.signal,
      });
      if (version.code === 127) return { status: "missing" };
      if (version.code !== 0)
        return { status: "unknown", reason: "Tern's installation could not be confirmed." };
    } catch (error) {
      if (missingExecutable(error)) return { status: "missing" };
      throw error;
    }
    // Retain the allocation before realpath, so even a canonicalization failure is cleaned up.
    root = await mkdtemp(join(tmpdir(), "td-tern-"));
    root = await realpath(root);
    const cwd = root;
    const control = join(cwd, "c.sock");
    const env = {
      TERN_CONFIG_DIR: join(cwd, "config"),
      TERN_DAEMON_SOCKET: join(cwd, "d.sock"),
      TANDEM_HOME: join(cwd, "home"),
      ZDOTDIR: join(cwd, "zdot"),
      STENCIL_LOG_DIR: join(cwd, "logs"),
    };
    const call = (args: readonly string[]) =>
      run({
        argv: [binary, ...args],
        cwd,
        env,
        timeoutMs: Math.min(CONTROL_TIMEOUT_MS, remaining()),
        signal: budgetStop.signal,
      });
    await Promise.all(
      Object.values(env)
        .filter((path) => path !== env.TERN_DAEMON_SOCKET)
        .map((path) => mkdir(path)),
    );
    daemon = run({
      argv: [binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET],
      cwd,
      env,
      signal: AbortSignal.any([daemonStop.signal, budgetStop.signal]),
      timeoutMs: remaining(),
    }).catch(() => undefined);
    let ready = false;
    const daemonDeadline = Math.min(deadline, now() + 2_000);
    while (now() < daemonDeadline) {
      try {
        ready = (await call(["ls", "--json"])).code === 0;
      } catch {
        /* Daemon is starting; its deadline still applies. */
      }
      if (ready) break;
      await sleep(50);
    }
    if (!ready) return { status: "unknown", reason: "Tern could not start in time." };
    // This is our own control socket. A failed quit still falls back to owned process-group abort.
    quit = async () =>
      run({
        argv: [binary, "ctl", "--control", control, "quit"],
        cwd,
        env,
        timeoutMs: CONTROL_TIMEOUT_MS,
      });
    window = run({
      argv: [binary, "--control", control, "--dir", cwd],
      cwd,
      env,
      signal: AbortSignal.any([windowStop.signal, budgetStop.signal]),
      timeoutMs: remaining(),
    }).catch(() => undefined);
    const windowDeadline = Math.min(deadline, now() + 3_000);
    while (now() < windowDeadline) {
      try {
        const response = await call(["ctl", "--control", control, "state"]);
        if (response.code === 0) {
          const value: unknown = JSON.parse(response.stdout);
          if (typeof value === "object" && value !== null && "gate" in value) {
            const gate = value.gate;
            if (typeof gate === "object" && gate !== null && "signed_in" in gate) {
              if (gate.signed_in === true) return { status: "ready" };
              if (gate.signed_in === false) return { status: "signedOut" };
            }
          }
        }
      } catch {
        /* The isolated window is starting; its deadline still applies. */
      }
      await sleep(50);
    }
    return { status: "unknown", reason: "Tern's sign-in state could not be confirmed in time." };
  };
  try {
    result = await inspect();
  } catch (error) {
    result = {
      status: "unknown",
      reason:
        error instanceof CommandTimeoutError
          ? "Tern's availability check timed out."
          : "Tern could not be checked.",
    };
  } finally {
    timedOut = budgetStop.signal.aborted || now() >= deadline;
    clearTimeout(budgetTimer);
    if (quit !== undefined)
      quitFailed = await quit().then(
        (response) => response.code !== 0,
        () => true,
      );
    windowStop.abort();
    daemonStop.abort();
    await Promise.allSettled([window, daemon]);
    if (root !== undefined)
      await rm(root, { recursive: true, force: true }).catch(() => {
        cleanupFailed = true;
      });
  }
  if (cleanupFailed)
    return {
      status: "unknown",
      reason: "Tern's availability check could not clean up its temporary files.",
    };
  if (quitFailed)
    return { status: "unknown", reason: "Tern's availability window could not close normally." };
  return timedOut ? { status: "unknown", reason: "Tern's availability check timed out." } : result;
}
