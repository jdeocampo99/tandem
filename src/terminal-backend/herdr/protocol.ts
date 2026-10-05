import {
  AdapterCommandError,
  checkedPath,
  checkedText,
  EndpointOwnershipError,
  isRecord,
} from "../../adapters/primitives.ts";
import type { CommandRequest, CommandResult } from "../../contracts.ts";

export function herdrRequest(
  sessionId: string,
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): CommandRequest {
  return {
    argv: ["herdr", "--session", checkedText(sessionId, "sessionId"), ...args],
    cwd: checkedPath(cwd, "cwd"),
    ...(env === undefined ? {} : { env }),
  };
}

/** Parses a Herdr JSON answer, naming the command when it is not JSON. */
export function parseAnswer(value: string, operation: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `${operation} returned invalid JSON: ${error instanceof Error ? error.message : "parse failure"}`,
    );
  }
}

function nativeErrorCode(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !isRecord(parsed.error) || typeof parsed.error.code !== "string") {
      return undefined;
    }
    return parsed.error.code;
  } catch {
    return undefined;
  }
}

/** The `error.code` Herdr printed on either stream, such as "pane_not_found". */
export function errorCode(result: CommandResult): string | undefined {
  return nativeErrorCode(result.stdout) ?? nativeErrorCode(result.stderr);
}

/** Herdr's structured answer that the pane does not exist. */
export function isPaneNotFound(result: CommandResult): boolean {
  if (result.code === 0) return false;
  try {
    const payload: unknown = JSON.parse(result.stderr);
    return isRecord(payload) && isRecord(payload.error) && payload.error.code === "pane_not_found";
  } catch {
    return false;
  }
}

/** Like `isPaneNotFound`, also accepting the plain-text answers older Herdr builds print. */
export function isPaneMissing(result: CommandResult): boolean {
  if (result.code === 0) return false;
  if (errorCode(result) === "pane_not_found") return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /no such pane/.test(output) || /pane.*(?:not found|does not exist|missing)/.test(output);
}

export function isSessionMissing(result: CommandResult): boolean {
  if (result.code === 0) return false;
  const code = errorCode(result);
  if (code === "server_not_running" || code === "session_not_found") return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    /no such session/.test(output) ||
    /session.*(?:not found|does not exist|not running|missing)/.test(output) ||
    /server[_ -]?(?:not[_ -]?running|unavailable|not[_ -]?found)/.test(output) ||
    /no herdr server is running/.test(output)
  );
}

export function isPaneGone(error: unknown): boolean {
  if (error instanceof EndpointOwnershipError) return error.reason === "missing";
  return error instanceof AdapterCommandError && isPaneMissing(error.result);
}

export function isEndpointGone(error: unknown): boolean {
  if (error instanceof EndpointOwnershipError) return error.reason === "missing";
  if (!(error instanceof AdapterCommandError)) return false;
  const code = errorCode(error.result);
  if (
    code === "server_not_running" ||
    code === "session_not_found" ||
    code === "workspace_not_found" ||
    code === "tab_not_found" ||
    code === "pane_not_found"
  ) {
    return true;
  }
  const output = `${error.result.stdout}\n${error.result.stderr}`.toLowerCase();
  return (
    /(?:pane|session)[-_ ]?(?:not|does not exist|could not be found|unknown)[-_ ]?found/.test(
      output,
    ) ||
    /no such (?:pane|session)/.test(output) ||
    /(?:pane|session).*(?:not found|does not exist|missing)/.test(output)
  );
}
