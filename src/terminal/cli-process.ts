import { closeSync, openSync } from "node:fs";
import { lstat } from "node:fs/promises";
import type { TandemEnvironmentSource } from "../config/environment.ts";

export type PathStat = Readonly<{
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}>;

export type PersistentProcess = Readonly<{
  readonly pid: number;
  readonly exited: Promise<number>;
}>;

export type StartPersistent = (
  request: Readonly<{
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    /** A file that receives the child's output; without it the output is dropped. */
    readonly log?: string;
  }>,
) => Promise<PersistentProcess | undefined>;

export type RunInteractive = (
  request: Readonly<{
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    /** Inherited variables the child must not see. */
    readonly unset?: readonly string[];
    readonly timeoutMs?: number;
    /** Aborting stops the child with SIGTERM. */
    readonly signal?: AbortSignal;
  }>,
) => Promise<number>;

export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type CliSignal = "SIGINT" | "SIGTERM";
export type CliSignalListener = () => void;
export type CliSignalSource = Readonly<{
  readonly on: (signal: CliSignal, listener: CliSignalListener) => void;
  readonly removeListener: (signal: CliSignal, listener: CliSignalListener) => void;
}>;

export function mergeInheritedEnvironment(
  inherited: TandemEnvironmentSource,
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) environment[key] = value;
  return environment;
}

export async function defaultStatPath(path: string): Promise<PathStat> {
  return lstat(path);
}

export const defaultStartPersistent: StartPersistent = async (request) => {
  // One descriptor for both streams keeps their writes in order; two opens would overwrite each other.
  const log = request.log === undefined ? undefined : openSync(request.log, "w", 0o600);
  const output = log ?? "ignore";
  try {
    const child = Bun.spawn({
      cmd: [...request.argv],
      cwd: request.cwd,
      ...(request.env === undefined
        ? {}
        : { env: { ...mergeInheritedEnvironment({}, request.env) } }),
      stdin: "ignore",
      stdout: output,
      stderr: output,
      detached: true,
    });
    // Bun keeps the parent alive until a spawned child exits; the server must outlive the launcher.
    child.unref();
    return { pid: child.pid, exited: child.exited };
  } finally {
    if (log !== undefined) closeSync(log);
  }
};

export const defaultRunInteractive: RunInteractive = async (request) => {
  const unset = request.unset ?? [];
  const child = Bun.spawn({
    cmd: [...request.argv],
    cwd: request.cwd,
    ...(request.env === undefined && unset.length === 0
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(mergeInheritedEnvironment({}, request.env ?? {})).filter(
              ([name]) => !unset.includes(name),
            ),
          ),
        }),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
  });
  const stop = () => child.kill("SIGTERM");
  request.signal?.addEventListener("abort", stop, { once: true });
  try {
    return await child.exited;
  } finally {
    request.signal?.removeEventListener("abort", stop);
  }
};

export const defaultSleep: Sleep = async (milliseconds, signal) => {
  await new Promise<void>((resolvePromise) => {
    let timer: Timer | undefined;
    let onAbort: () => void = () => undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (): void => {
      cleanup();
      resolvePromise();
    };
    onAbort = (): void => finish();
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(finish, milliseconds);
  });
};

export const defaultCliSignalSource: CliSignalSource = {
  on: (signal, listener) => {
    process.on(signal, listener);
  },
  removeListener: (signal, listener) => {
    process.removeListener(signal, listener);
  },
};

export class CliInterruptError extends Error {
  readonly signal: CliSignal;

  constructor(signal: CliSignal) {
    super(`CLI interrupted by ${signal}`);
    this.name = "CliInterruptError";
    this.signal = signal;
  }
}

export type WatchControl = {
  stopped: boolean;
  sleepController: AbortController;
  wake: (() => void) | undefined;
};

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(
    reason === undefined
      ? "CLI operation interrupted"
      : `CLI operation interrupted: ${String(reason)}`,
  );
}

export async function waitForWatchDelay(
  sleep: Sleep,
  milliseconds: number,
  control: WatchControl,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (control.stopped || signal?.aborted) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let onAbort: () => void = () => undefined;
    let wake: () => void = () => undefined;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      if (control.wake === wake) control.wake = undefined;
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    onAbort = (): void => {
      control.sleepController.abort(signal?.reason);
      finish(resolve);
    };
    wake = (): void => {
      control.sleepController.abort(new Error("CLI watch interrupted"));
      finish(resolve);
    };
    control.wake = wake;
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    void sleep(milliseconds, control.sleepController.signal).then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
