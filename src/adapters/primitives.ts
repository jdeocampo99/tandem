import { resolve } from "node:path";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  WorktreeLease,
} from "../contracts.ts";

export type WorktreeAdapterOptions = Readonly<{
  realpath?: (path: string) => Promise<string>;
}>;

export type JsonRecord = Record<string, unknown>;
type GitCommand = readonly [string, ...string[]];
export class AdapterError extends Error {
  readonly operation: string;
  override readonly cause: unknown;

  constructor(message: string, operation: string, cause: unknown = undefined) {
    super(message);
    this.name = "AdapterError";
    this.operation = operation;
    this.cause = cause;
  }
}

export class AdapterCommandError extends AdapterError {
  readonly request: CommandRequest;
  readonly result: CommandResult;

  constructor(operation: string, request: CommandRequest, result: CommandResult) {
    super(
      `${operation} exited with code ${result.code}: ${JSON.stringify(request.argv)} in ${JSON.stringify(request.cwd)}${
        result.stderr.length === 0 ? "" : `; ${result.stderr.trim()}`
      }`,
      operation,
    );
    this.name = "AdapterCommandError";
    this.request = request;
    this.result = result;
  }
}

export class AdapterProtocolError extends AdapterError {
  readonly response: string;

  constructor(operation: string, message: string, response: string) {
    super(`${operation} returned malformed data: ${message}`, operation);
    this.name = "AdapterProtocolError";
    this.response = response;
  }
}

export class EndpointOwnershipError extends AdapterError {
  readonly endpoint: Endpoint;
  readonly reason: "missing" | "mismatch";

  constructor(endpoint: Endpoint, message: string, reason: "missing" | "mismatch" = "mismatch") {
    super(
      `endpoint ownership refused for pane ${endpoint.paneId}: ${message}`,
      `${endpoint.terminal} endpoint ownership`,
    );
    this.name = "EndpointOwnershipError";
    this.endpoint = endpoint;
    this.reason = reason;
  }
}

export class EndpointBusyError extends AdapterError {
  readonly endpoint: Endpoint;

  constructor(endpoint: Endpoint) {
    super(
      `endpoint ${endpoint.paneId} still has an active foreground worker; interrupt it before closing`,
      "herdr endpoint close",
    );
    this.name = "EndpointBusyError";
    this.endpoint = endpoint;
  }
}

export class LeaseSafetyError extends AdapterError {
  readonly lease: WorktreeLease;

  constructor(message: string, lease: WorktreeLease, cause: unknown = undefined) {
    super(`${message}; lease preserved at ${lease.path}`, "treehouse lease safety", cause);
    this.name = "LeaseSafetyError";
    this.lease = lease;
  }
}

/** A release refused because a live process still has its working directory in the worktree. */
export class WorktreeInUseError extends LeaseSafetyError {
  constructor(processes: readonly string[], lease: WorktreeLease) {
    super(`a running process is using this worktree (${processes.join(", ")})`, lease);
    this.name = "WorktreeInUseError";
  }
}

export class ApprovalRequiredError extends AdapterError {
  constructor(operation: string) {
    super(`${operation} requires explicit caller approval`, operation);
    this.name = "ApprovalRequiredError";
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(response: string, operation: string): unknown {
  try {
    return JSON.parse(response);
  } catch (error) {
    throw new AdapterProtocolError(
      operation,
      error instanceof Error ? error.message : String(error),
      response,
    );
  }
}

export function requiredRecord(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): JsonRecord {
  if (!isRecord(value)) {
    throw new AdapterProtocolError(operation, `${field} must be an object`, response);
  }
  return value;
}

export function requiredString(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterProtocolError(operation, `${field} must be a non-empty string`, response);
  }
  return value;
}

export function requiredInteger(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AdapterProtocolError(operation, `${field} must be a non-negative integer`, response);
  }
  return value;
}
export function optionalString(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a non-empty string when present`,
      response,
    );
  }
  return value;
}

export function optionalInteger(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a non-negative integer when present`,
      response,
    );
  }
  return value;
}

export function requireSuccess(
  runResult: CommandResult,
  request: CommandRequest,
  operation: string,
): CommandResult {
  if (runResult.code !== 0) throw new AdapterCommandError(operation, request, runResult);
  return runResult;
}

export async function runChecked(
  run: CommandRunner,
  request: CommandRequest,
  operation: string,
): Promise<CommandResult> {
  const result = await run(request);
  return requireSuccess(result, request, operation);
}

export async function readGitText(
  run: CommandRunner,
  cwd: string,
  args: GitCommand,
  operation: string,
): Promise<string> {
  const checkedCwd = checkedPath(cwd, "cwd");
  const request: CommandRequest = {
    argv: ["git", "-C", checkedCwd, ...args],
    cwd: checkedCwd,
  };
  const result = await runChecked(run, request, operation);
  const text = result.stdout.trim();
  if (text.length === 0)
    throw new AdapterProtocolError(operation, "git returned empty stdout", result.stdout);
  return text;
}

export function checkedText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  return value;
}

export function checkedPath(value: unknown, field: string): string {
  return resolve(checkedText(value, field));
}

export function checkedGeneration(value: unknown, field = "generation"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}
