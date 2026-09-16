import type { CommandRequest, CommandResult, CommandRunner } from "./contracts.ts";

export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

type TerminationReason = "aborted" | "timeout";
type CommandErrorReason = TerminationReason | "spawn" | "output" | "stdin" | "signal";
type CapturingSubprocess = Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;

const TERMINATION_GRACE_MS = 100;

function describeRequest(request: CommandRequest): string {
  return `${JSON.stringify(request.argv)} in ${JSON.stringify(request.cwd)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  if (overrides !== undefined) {
    Object.assign(environment, overrides);
  }
  return environment;
}

async function captureOutput(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<string> {
  if (stream === null || stream === undefined) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;

  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value = part.value;
      const remaining = maxBytes - capturedBytes;
      if (remaining <= 0) continue;
      const captured = value.byteLength <= remaining ? value : value.slice(0, remaining);
      chunks.push(captured);
      capturedBytes += captured.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isBrokenPipe(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  return code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END";
}

function isProcessGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ESRCH";
}

function signalOwnedSubprocess(child: CapturingSubprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  process.kill(-child.pid, signal);
}

export class CommandExecutionError extends Error {
  readonly request: CommandRequest;
  readonly reason: CommandErrorReason;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;

  constructor(
    message: string,
    request: CommandRequest,
    reason: CommandErrorReason,
    stdout = "",
    stderr = "",
    exitCode: number | undefined = undefined,
    signal: string | undefined = undefined,
  ) {
    super(message);
    this.name = "CommandExecutionError";
    this.request = request;
    this.reason = reason;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class CommandAbortedError extends CommandExecutionError {
  constructor(
    request: CommandRequest,
    stdout = "",
    stderr = "",
    exitCode: number | undefined = undefined,
  ) {
    super(
      `command aborted: ${describeRequest(request)}`,
      request,
      "aborted",
      stdout,
      stderr,
      exitCode,
    );
    this.name = "CommandAbortedError";
  }
}

export class CommandTimeoutError extends CommandExecutionError {
  readonly timeoutMs: number;

  constructor(
    request: CommandRequest,
    timeoutMs: number,
    stdout = "",
    stderr = "",
    exitCode: number | undefined = undefined,
  ) {
    super(
      `command timed out after ${timeoutMs}ms: ${describeRequest(request)}`,
      request,
      "timeout",
      stdout,
      stderr,
      exitCode,
    );
    this.name = "CommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class CommandSignaledError extends CommandExecutionError {
  constructor(
    request: CommandRequest,
    signal: string,
    stdout = "",
    stderr = "",
    exitCode: number | undefined = undefined,
  ) {
    super(
      `command terminated by ${signal}: ${describeRequest(request)}`,
      request,
      "signal",
      stdout,
      stderr,
      exitCode,
      signal,
    );
    this.name = "CommandSignaledError";
  }
}

export class CommandStartError extends CommandExecutionError {
  constructor(request: CommandRequest, cause: unknown) {
    super(
      `command could not start (${describeRequest(request)}): ${describeError(cause)}`,
      request,
      "spawn",
    );
    this.name = "CommandStartError";
  }
}

export class CommandOutputError extends CommandExecutionError {
  constructor(request: CommandRequest, cause: unknown) {
    super(
      `command output could not be captured (${describeRequest(request)}): ${describeError(cause)}`,
      request,
      "output",
    );
    this.name = "CommandOutputError";
  }
}

export function quoteShellArgument(value: string): string {
  if (value.includes("\0")) {
    throw new TypeError("shell arguments cannot contain NUL bytes");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function quoteShellCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new TypeError("a shell command requires at least one argument");
  return argv.map((argument) => quoteShellArgument(argument)).join(" ");
}

export const runCommand: CommandRunner = async (request): Promise<CommandResult> => {
  if (request.argv.length === 0) throw new TypeError("command argv cannot be empty");
  if (request.argv.some((argument) => typeof argument !== "string")) {
    throw new TypeError("command argv entries must be strings");
  }
  if (request.cwd.length === 0) throw new TypeError("command cwd cannot be empty");
  if (
    request.timeoutMs !== undefined &&
    (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 0)
  ) {
    throw new TypeError("command timeoutMs must be a finite non-negative number");
  }
  if (request.signal?.aborted === true) {
    throw new CommandAbortedError(request);
  }

  let child: CapturingSubprocess;
  try {
    child = Bun.spawn({
      cmd: [...request.argv],
      cwd: request.cwd,
      detached: true,
      env: mergeEnvironment(request.env),
      stdin: request.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new CommandStartError(request, error);
  }

  let termination: TerminationReason | undefined;
  let terminationStarted = false;
  let forceKillHandle: Timer | undefined;
  let forceKillPromise: Promise<void> | undefined;
  let killError: unknown;
  const terminate = (reason: TerminationReason): void => {
    termination ??= reason;
    if (terminationStarted) return;
    terminationStarted = true;
    try {
      signalOwnedSubprocess(child, "SIGTERM");
    } catch (error) {
      if (!isProcessGone(error)) killError = error;
    }
    forceKillPromise = new Promise<void>((resolve) => {
      forceKillHandle = setTimeout(() => {
        forceKillHandle = undefined;
        try {
          signalOwnedSubprocess(child, "SIGKILL");
        } catch (error) {
          if (!isProcessGone(error)) killError ??= error;
        } finally {
          resolve();
        }
      }, TERMINATION_GRACE_MS);
    });
  };

  const signal = request.signal;
  const onAbort = (): void => terminate("aborted");
  if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });

  let timeoutHandle: Timer | undefined;
  if (request.timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => terminate("timeout"), request.timeoutMs);
  }
  const cleanup = (): void => {
    clearTimeout(timeoutHandle);
    clearTimeout(forceKillHandle);
    signal?.removeEventListener("abort", onAbort);
  };

  const stdoutPromise = captureOutput(child.stdout, MAX_CAPTURE_BYTES);
  const stderrPromise = captureOutput(child.stderr, MAX_CAPTURE_BYTES);
  const stdin = request.stdin;
  const stdinPromise =
    stdin === undefined
      ? Promise.resolve(undefined)
      : (async (): Promise<unknown> => {
          try {
            if (child.stdin === undefined) {
              return new Error("spawned command did not provide a writable stdin pipe");
            }
            await child.stdin.write(stdin);
            child.stdin.end();
            return undefined;
          } catch (error) {
            if (isBrokenPipe(error)) return undefined;
            return error;
          }
        })();

  let exitCode: number;
  try {
    exitCode = await child.exited;
  } catch (error) {
    terminate("aborted");
    await Promise.allSettled([stdoutPromise, stderrPromise, stdinPromise, child.exited]);
    if (forceKillPromise !== undefined) await forceKillPromise;
    cleanup();
    throw new CommandExecutionError(
      `command did not report an exit (${describeRequest(request)}): ${describeError(error)}`,
      request,
      "spawn",
    );
  }

  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  } catch (error) {
    terminate("aborted");
    await Promise.allSettled([stdoutPromise, stderrPromise, stdinPromise, child.exited]);
    if (forceKillPromise !== undefined) await forceKillPromise;
    cleanup();
    throw new CommandOutputError(request, error);
  }

  const stdinError = await stdinPromise;
  if (forceKillPromise !== undefined) await forceKillPromise;
  cleanup();
  if (termination === "timeout") {
    const detail = killError === undefined ? "" : `: ${describeError(killError)}`;
    throw new CommandTimeoutError(
      request,
      request.timeoutMs ?? 0,
      stdout,
      `${stderr}${detail}`,
      exitCode,
    );
  }
  if (termination === "aborted") {
    const detail = killError === undefined ? "" : `: ${describeError(killError)}`;
    throw new CommandAbortedError(request, stdout, `${stderr}${detail}`, exitCode);
  }

  const signalCode = child.signalCode;
  if (signalCode !== null && signalCode !== undefined) {
    throw new CommandSignaledError(request, String(signalCode), stdout, stderr, exitCode);
  }
  if (stdinError !== undefined) {
    throw new CommandExecutionError(
      `command stdin failed (${describeRequest(request)}): ${describeError(stdinError)}`,
      request,
      "stdin",
      stdout,
      stderr,
      exitCode,
    );
  }

  return { code: exitCode, stdout, stderr };
};
