import { isRecord } from "../adapters/primitives.ts";
import type { CreatableTaskKind, ThinkingLevel } from "../contracts.ts";
import type { CliInvocation, MergeMethod } from "./cli-arguments.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
];
const TASK_KINDS: readonly CreatableTaskKind[] = ["scout", "implementation"];
const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliConsentError";
  }
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(`${field} must be non-empty text`);
  }
  if (value.includes("\0")) throw new CliUsageError(`${field} must not contain NUL characters`);
  return value.trim();
}

function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

export function pathText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(`${field} must be non-empty text`);
  }
  if (value.includes("\0")) throw new CliUsageError(`${field} must not contain NUL characters`);
  if (hasPathControlCharacter(value)) {
    throw new CliUsageError(`${field} must not contain control characters`);
  }
  return value;
}

export function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${field} must be a positive integer`);
  }
  return parsed;
}

function supportedValue<Value extends string>(
  value: string,
  values: readonly Value[],
  field: string,
): Value {
  const supported = values.find((candidate) => candidate === value);
  if (supported === undefined) {
    throw new CliUsageError(`unsupported ${field} ${JSON.stringify(value)}`);
  }
  return supported;
}

export function parseThinking(value: string): ThinkingLevel {
  return supportedValue(value, THINKING_LEVELS, "thinking level");
}

export function parseTaskKind(value: string): CreatableTaskKind {
  return supportedValue(value, TASK_KINDS, "task kind");
}

export function parseMergeMethod(value: string): MergeMethod {
  return supportedValue(value, MERGE_METHODS, "merge method");
}

export function requiredPositionOrOption(
  invocation: CliInvocation,
  option: string | undefined,
  position: number,
  field: string,
): string {
  if (option !== undefined && invocation.positionals[position] !== undefined) {
    throw new CliUsageError(`${field} was provided both as an option and a positional argument`);
  }
  return text(option ?? invocation.positionals[position], field);
}

export function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value))
    throw new CliUsageError(`${field} must be an array of non-empty strings`);
  const entries: unknown[] = value;
  if (entries.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new CliUsageError(`${field} must be an array of non-empty strings`);
  }
  return entries.map((entry) => text(entry, field));
}

export function parseJsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CliUsageError(
      `${field} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new CliUsageError(`${field} must be a JSON object`);
  }
  return parsed;
}
