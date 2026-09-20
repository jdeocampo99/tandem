import * as path from "node:path";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  ContractIdentity,
  ValidationCommand,
  ValidationContractName,
  ValidationEvidence,
} from "../contracts.ts";
import { ValidationConfigurationError } from "../tasks/acceptance.ts";

/**
 * Runs the commands one validation contract selected, sequentially through an argv-only runner, and
 * returns evidence stamped with that contract and the code and policy identity it is pinned to.
 */
export type ValidationOptions = Readonly<{
  repoPath: string;
  contract: ValidationContractName;
  identity: ContractIdentity;
  commands: readonly ValidationCommand[];
  run: CommandRunner;
  signal?: AbortSignal;
}>;

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

/** The contract a run executes under; every evidence record is stamped with it. */
type ContractRun = Readonly<{
  contract: ValidationContractName;
  identity: ContractIdentity;
}>;

function readContractRun(options: ValidationOptions): ContractRun {
  if (options.contract !== "iteration" && options.contract !== "final") {
    throw new TypeError("contract must be iteration or final");
  }
  const identity = options.identity;
  if (!isRecord(identity)) {
    throw new TypeError("identity must be a contract identity");
  }
  if (typeof identity.head !== "string" || identity.head.trim().length === 0) {
    throw new TypeError("identity.head must be a non-empty string");
  }
  if (typeof identity.policyDigest !== "string" || identity.policyDigest.trim().length === 0) {
    throw new TypeError("identity.policyDigest must be a non-empty string");
  }
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 0) {
    throw new TypeError("identity.generation must be a non-negative integer");
  }
  return { contract: options.contract, identity: options.identity };
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
  run: ContractRun,
  message: string,
  exitCode: number,
): ValidationEvidence {
  return {
    name: command.name,
    argv: [...command.argv],
    exitCode,
    stdout: "",
    stderr: message,
    head: run.identity.head,
    contract: run.contract,
    origin: "local",
    policyDigest: run.identity.policyDigest,
  };
}

function resultEvidence(
  command: ValidationCommand,
  run: ContractRun,
  result: CommandResult,
): ValidationEvidence {
  return {
    name: command.name,
    argv: [...command.argv],
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    head: run.identity.head,
    contract: run.contract,
    origin: "local",
    policyDigest: run.identity.policyDigest,
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
  contractRun: ContractRun,
  interruption: CommandInterruption,
): { evidence: ValidationEvidence; stop: true } {
  const timeout = interruption.kind === "timeout";
  return {
    evidence: cancellationEvidence(
      command,
      contractRun,
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
  contractRun: ContractRun,
  run: CommandRunner,
  signal: AbortSignal | undefined,
): Promise<{ evidence: ValidationEvidence; stop: boolean }> {
  if (signal?.aborted) {
    return {
      evidence: cancellationEvidence(
        command,
        contractRun,
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
      return interruptedOutcome(command, contractRun, initialInterruption);
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
      return interruptedOutcome(command, contractRun, interruption);
    }

    const evidence = resultEvidence(command, contractRun, result);
    return { evidence, stop: result.code !== 0 };
  } catch (error) {
    const interruption = lifetime.interruption();
    if (interruption !== undefined) {
      return interruptedOutcome(command, contractRun, interruption);
    }
    if (isTimeout(error)) {
      return {
        evidence: cancellationEvidence(
          command,
          contractRun,
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
          contractRun,
          cancellationMessage(signal?.reason ?? error, "validation was cancelled"),
          130,
        ),
        stop: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      evidence: cancellationEvidence(command, contractRun, message, 127),
      stop: true,
    };
  } finally {
    lifetime.dispose();
  }
}

/**
 * Executes the contract's commands in declaration order and stops after the first non-zero or
 * cancelled result. Surface selection belongs to the contract planner, so an empty command list
 * reaching the runner is a configuration failure rather than a pass.
 */
export async function runValidation(
  options: ValidationOptions,
): Promise<readonly ValidationEvidence[]> {
  const repoPath = readRepositoryPath(options.repoPath);
  const contractRun = readContractRun(options);
  if (typeof options.run !== "function") {
    throw new TypeError("run must be an argv command runner");
  }
  if (!Array.isArray(options.commands)) {
    throw new TypeError("commands must be an array");
  }

  const selected: ValidationCommand[] = [];
  for (let index = 0; index < options.commands.length; index += 1) {
    selected.push(readCommand(options.commands[index], index));
  }
  if (selected.length === 0) {
    throw new ValidationConfigurationError(
      `the ${contractRun.contract} contract selected no validation commands`,
    );
  }

  const evidence: ValidationEvidence[] = [];
  for (const command of selected) {
    const outcome = await runCommand(command, repoPath, contractRun, options.run, options.signal);
    evidence.push(outcome.evidence);
    if (outcome.stop) {
      break;
    }
  }
  return evidence;
}
