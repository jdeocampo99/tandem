import * as path from "node:path";
import {
  type AgentRole,
  type InstructionChannel,
  MODEL_ROLE_ORDER,
  type ThinkingLevel,
} from "../contracts.ts";
export type PolicyRecord = Readonly<Record<string, unknown>>;

export const INSTRUCTION_CHANNELS = [
  "implementation",
  "validation",
  "review",
] as const satisfies readonly InstructionChannel[];

export const INSTRUCTION_CHANNEL_KEYS: Readonly<Record<InstructionChannel, true>> = {
  implementation: true,
  validation: true,
  review: true,
};

export const MODEL_KEYS: Readonly<Record<string, true>> = {
  model: true,
  thinking: true,
};
export const AGENT_ROLE_KEYS: Readonly<Record<AgentRole, true>> = Object.fromEntries(
  MODEL_ROLE_ORDER.map((role) => [role, true] as const),
) as Readonly<Record<AgentRole, true>>;

export const THINKING_LEVELS: Readonly<Record<ThinkingLevel, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};

const MODEL_SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*\/[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u;

export function isRecord(value: unknown): value is PolicyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasKey(value: PolicyRecord, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function assertKnownKeys(
  value: PolicyRecord,
  allowed: Readonly<Record<string, true>>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed[key] !== true) {
      throw new TypeError(`${field} contains unknown key ${JSON.stringify(key)}`);
    }
  }
}

export function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (hasDisallowedControlCharacter(value, false)) {
    throw new TypeError(`${field} contains a control character or line break`);
  }
  return value.trim();
}

export function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

export function hasDisallowedControlCharacter(
  value: string,
  allowInstructionWhitespace: boolean,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code !== 0x7f) {
      continue;
    }
    if (allowInstructionWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) {
      continue;
    }
    return true;
  }
  return false;
}

export function readInstruction(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (hasDisallowedControlCharacter(value, true)) {
    throw new TypeError(`${field} contains a control character`);
  }
  return value.trim();
}

export function readThinkingLevel(value: unknown, field: string): ThinkingLevel {
  if (typeof value !== "string" || THINKING_LEVELS[value as ThinkingLevel] !== true) {
    throw new TypeError(`${field} must be a supported thinking level`);
  }
  return value as ThinkingLevel;
}

export function readModelSelector(value: unknown, field: string): string {
  if (typeof value !== "string" || !MODEL_SELECTOR_PATTERN.test(value)) {
    throw new TypeError(`${field} must be an exact provider/model selector`);
  }
  return value;
}

export function readChannel(value: unknown, field: string): InstructionChannel {
  if (typeof value !== "string" || !INSTRUCTION_CHANNELS.includes(value as InstructionChannel)) {
    throw new TypeError(`${field} must name a supported instruction channel`);
  }
  return value as InstructionChannel;
}

export function readInstructionList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of strings`);
  }

  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    entries.push(readInstruction(value[index], `${field}[${index}]`));
  }
  return entries;
}

export function normalizeRelativeReference(value: unknown, field: string): string {
  const reference = readNonEmptyString(value, field);
  if (
    path.posix.isAbsolute(reference) ||
    path.win32.isAbsolute(reference) ||
    reference.includes("\\")
  ) {
    throw new TypeError(`${field} must be a relative POSIX path inside the repository`);
  }
  const normalized = path.posix.normalize(reference);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError(`${field} must stay inside the repository`);
  }
  return normalized;
}

export function readReferenceList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of relative file references`);
  }

  const references: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    references.push(normalizeRelativeReference(value[index], `${field}[${index}]`));
  }
  return references;
}

export function readChannels<T>(
  value: unknown,
  field: string,
  readList: (value: unknown, field: string) => readonly T[],
): Partial<Record<InstructionChannel, readonly T[]>> {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object keyed by instruction channel`);
  }
  assertKnownKeys(value, INSTRUCTION_CHANNEL_KEYS, field);

  const channels: Partial<Record<InstructionChannel, readonly T[]>> = {};
  for (const key of Object.keys(value)) {
    const channel = readChannel(key, `${field}.${key}`);
    channels[channel] = readList(value[key], `${field}.${channel}`);
  }
  return channels;
}

export function cloneChannels<T>(
  channels: Readonly<Record<InstructionChannel, readonly T[]>>,
): Record<InstructionChannel, readonly T[]> {
  return {
    implementation: [...channels.implementation],
    validation: [...channels.validation],
    review: [...channels.review],
  };
}

export function deduplicateStrings(entries: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}
export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new TypeError(`${source} must contain valid JSON: ${detail}`);
  }
}
