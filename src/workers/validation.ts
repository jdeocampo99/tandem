import * as path from "node:path";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  ValidationCommand,
  ValidationEvidence,
} from "../contracts.ts";

/** Runs selected policy commands sequentially through an argv-only runner and returns head-bound evidence. */
export type ValidationOptions = Readonly<{
  repoPath: string;
  head: string;
  surfaces: readonly string[];
  commands: readonly ValidationCommand[];
  run: CommandRunner;
  signal?: AbortSignal;
}>;

export class ValidationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ValidationConfigurationError";
  }
}

class ValidationTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ValidationTimeoutError";
  }
}

class ValidationCancelledError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ValidationCancelledError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRepositoryPath(repoPath: string): string {
  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    throw new TypeError("repoPath must be a non-empty string");
  }
  return path.resolve(repoPath);
}

function readHead(head: string): string {
  if (typeof head !== "string" || head.trim().length === 0) {
    throw new TypeError("head must be a non-empty string");
  }
  return head;
}

function readSurfaces(surfaces: readonly string[]): readonly string[] {
  if (!Array.isArray(surfaces)) {
    throw new TypeError("surfaces must be an array of strings");
  }
  const parsed: string[] = [];
  for (let index = 0; index < surfaces.length; index += 1) {
    const surface = surfaces[index];
    if (typeof surface !== "string" || surface.length === 0) {
      throw new TypeError(`surfaces[${index}] must be a non-empty string`);
    }
    parsed.push(surface);
  }
  return parsed;
}

function readCommand(command: ValidationCommand, index: number): ValidationCommand {
  if (!isRecord(command)) {
    throw new TypeError(`commands[${index}] must be an object`);
  }
  if (typeof command.name !== "string" || command.name.trim().length === 0) {
    throw new TypeError(`commands[${index}].name must be a non-empty string`);
  }
  if (!Array.isArray(command.argv) || command.argv.length === 0) {
    throw new TypeError(`commands[${index}].argv must be a non-empty array`);
  }
  const argv: string[] = [];
  for (let argumentIndex = 0; argumentIndex < command.argv.length; argumentIndex += 1) {
    const argument = command.argv[argumentIndex];
    if (typeof argument !== "string" || argument.length === 0) {
      throw new TypeError(`commands[${index}].argv[${argumentIndex}] must be a non-empty string`);
    }
    argv.push(argument);
  }
  if (!Array.isArray(command.surfaces)) {
    throw new TypeError(`commands[${index}].surfaces must be an array of strings`);
  }
  const surfaces: string[] = [];
  for (let surfaceIndex = 0; surfaceIndex < command.surfaces.length; surfaceIndex += 1) {
    const surface = command.surfaces[surfaceIndex];
    if (typeof surface !== "string" || surface.length === 0) {
      throw new TypeError(
        `commands[${index}].surfaces[${surfaceIndex}] must be a non-empty string`,
      );
    }
    surfaces.push(surface);
  }
  if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0) {
    throw new TypeError(`commands[${index}].timeoutMs must be a positive integer`);
  }

  return {
    name: command.name,
    argv,
    surfaces,
    timeoutMs: command.timeoutMs,
  };
}

export function commandMatchesSurfaces(
  command: ValidationCommand,
  surfaces: readonly string[],
): boolean {
  if (command.surfaces.length === 0 || command.surfaces.includes("*") || surfaces.includes("*")) {
    return true;
  }
  return command.surfaces.some((surface) => surfaces.includes(surface));
}

function cancellationMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return fallback;
}

function isAbortLike(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.name === "CommandAbortedError" ||
    error.name === "ValidationCancelledError" ||
    error.code === "ABORT_ERR" ||
    error.code === "ECANCELED"
  );
}

function isTimeout(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return (
    error.name === "ValidationTimeoutError" ||
    error.name === "TimeoutError" ||
    error.name === "CommandTimeoutError" ||
    error.code === "ETIMEDOUT"
  );
}

function cancellationEvidence(
  command: ValidationCommand,
  head: string,
  message: string,
  exitCode: number,
): ValidationEvidence {
  return {
    name: command.name,
    argv: [...command.argv],
    exitCode,
    stdout: "",
    stderr: message,
    head,
  };
}

function resultEvidence(
  command: ValidationCommand,
  head: string,
  result: CommandResult,
): ValidationEvidence {
  return {
    name: command.name,
    argv: [...command.argv],
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    head,
  };
}

type CommandInterruption = Readonly<{
  kind: "timeout" | "cancelled";
  error: Error;
}>;

type CommandLifetime = Readonly<{
  signal: AbortSignal;
  interruption: () => CommandInterruption | undefined;
  dispose: () => void;
}>;

function makeCommandLifetime(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): CommandLifetime {
  const controller = new AbortController();
  let interruption: CommandInterruption | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const interrupt = (next: CommandInterruption): void => {
    if (interruption !== undefined) return;
    interruption = next;
    controller.abort(next.error);
  };
  const abortForCaller = (): void => {
    interrupt({
      kind: "cancelled",
      error: new ValidationCancelledError(
        cancellationMessage(callerSignal?.reason, "validation was cancelled"),
      ),
    });
  };

  callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  if (callerSignal?.aborted) {
    abortForCaller();
  } else {
    timeoutId = setTimeout(() => {
      interrupt({
        kind: "timeout",
        error: new ValidationTimeoutError(`validation command timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    interruption: () => interruption,
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", abortForCaller);
    },
  };
}

function interruptedOutcome(
  command: ValidationCommand,
  head: string,
  interruption: CommandInterruption,
): { evidence: ValidationEvidence; stop: true } {
  const timeout = interruption.kind === "timeout";
  return {
    evidence: cancellationEvidence(
      command,
      head,
      cancellationMessage(
        interruption.error,
        timeout
          ? `validation command timed out after ${command.timeoutMs}ms`
          : "validation was cancelled",
      ),
      timeout ? 124 : 130,
    ),
    stop: true,
  };
}

async function runCommand(
  command: ValidationCommand,
  repoPath: string,
  head: string,
  run: CommandRunner,
  signal: AbortSignal | undefined,
): Promise<{ evidence: ValidationEvidence; stop: boolean }> {
  if (signal?.aborted) {
    return {
      evidence: cancellationEvidence(
        command,
        head,
        cancellationMessage(signal.reason, "validation was cancelled"),
        130,
      ),
      stop: true,
    };
  }

  const lifetime = makeCommandLifetime(command.timeoutMs, signal);
  try {
    const initialInterruption = lifetime.interruption();
    if (initialInterruption !== undefined) {
      return interruptedOutcome(command, head, initialInterruption);
    }

    const request: CommandRequest = {
      argv: [...command.argv],
      cwd: repoPath,
      timeoutMs: command.timeoutMs,
      signal: lifetime.signal,
    };
    const result = await run(request);
    const interruption = lifetime.interruption();
    if (interruption !== undefined) {
      return interruptedOutcome(command, head, interruption);
    }

    const evidence = resultEvidence(command, head, result);
    return { evidence, stop: result.code !== 0 };
  } catch (error) {
    const interruption = lifetime.interruption();
    if (interruption !== undefined) {
      return interruptedOutcome(command, head, interruption);
    }
    if (isTimeout(error)) {
      return {
        evidence: cancellationEvidence(
          command,
          head,
          cancellationMessage(error, `validation command timed out after ${command.timeoutMs}ms`),
          124,
        ),
        stop: true,
      };
    }
    if (signal?.aborted || isAbortLike(error)) {
      return {
        evidence: cancellationEvidence(
          command,
          head,
          cancellationMessage(signal?.reason ?? error, "validation was cancelled"),
          130,
        ),
        stop: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      evidence: cancellationEvidence(command, head, message, 127),
      stop: true,
    };
  } finally {
    lifetime.dispose();
  }
}

/** Executes matching commands in declaration order and stops after the first non-zero or cancelled result. */
export async function runValidation(
  options: ValidationOptions,
): Promise<readonly ValidationEvidence[]> {
  const repoPath = readRepositoryPath(options.repoPath);
  const head = readHead(options.head);
  const surfaces = readSurfaces(options.surfaces);
  if (typeof options.run !== "function") {
    throw new TypeError("run must be an argv command runner");
  }
  if (!Array.isArray(options.commands)) {
    throw new TypeError("commands must be an array");
  }

  const selected: ValidationCommand[] = [];
  for (let index = 0; index < options.commands.length; index += 1) {
    const command = readCommand(options.commands[index], index);
    if (commandMatchesSurfaces(command, surfaces)) {
      selected.push(command);
    }
  }
  if (selected.length === 0) {
    throw new ValidationConfigurationError(
      surfaces.length === 0
        ? "no validation commands are configured"
        : `no validation commands match surfaces: ${surfaces.join(", ")}`,
    );
  }

  const evidence: ValidationEvidence[] = [];
  for (const command of selected) {
    const outcome = await runCommand(command, repoPath, head, options.run, options.signal);
    evidence.push(outcome.evidence);
    if (outcome.stop) {
      break;
    }
  }
  return evidence;
}
