import { isAbsolute } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
  parseTaskMessageBatch,
  TASK_COMMUNICATION_MARKER,
  type TaskMessageBatch,
} from "../tasks/communication-protocol.ts";

const MAX_TOOL_NAME_CHARS = 256;
type JsonRecord = Record<string, unknown>;

export type WorkerControlConfig = Readonly<{
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly inboxPath: string;
  readonly receiptPath: string;
  readonly initialRevision: number;
}>;

export type Marker = Readonly<{
  readonly raw: string;
  readonly prefix: string;
  readonly batch: TaskMessageBatch;
}>;

export type MarkerInsertion = { inserted: boolean };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSingleLine(value: unknown, field: string, maxChars = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  if (value.includes("\0") || /[\r\n\u2028\u2029]/u.test(value)) {
    throw new TypeError(`${field} must be a single-line value without NUL characters`);
  }
  if (value.length > maxChars) throw new TypeError(`${field} exceeds its character limit`);
  return value;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function readAbsolutePath(value: unknown, field: string): string {
  const path = readSingleLine(value, field);
  if (!isAbsolute(path)) throw new TypeError(`${field} must be an absolute path`);
  return path;
}

export function parseWorkerControlConfig(
  value: string | undefined,
): WorkerControlConfig | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(
      `worker control configuration is not valid JSON: ${error instanceof Error ? error.message : "parse failure"}`,
    );
  }
  if (!isRecord(parsed)) throw new TypeError("worker control configuration must be an object");
  const allowed = new Set([
    "schemaVersion",
    "jobId",
    "taskId",
    "generation",
    "inboxPath",
    "receiptPath",
    "initialRevision",
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new TypeError(`worker control configuration contains ${key}`);
  }
  if (parsed.schemaVersion !== 1) throw new TypeError("worker control schemaVersion must be 1");
  const jobId = readSingleLine(parsed.jobId, "jobId");
  const taskId = readSingleLine(parsed.taskId, "taskId");
  const generation = readNonNegativeInteger(parsed.generation, "generation");
  const inboxPath = readAbsolutePath(parsed.inboxPath, "inboxPath");
  const receiptPath = readAbsolutePath(parsed.receiptPath, "receiptPath");
  const initialRevision = readNonNegativeInteger(parsed.initialRevision, "initialRevision");
  return { schemaVersion: 1, jobId, taskId, generation, inboxPath, receiptPath, initialRevision };
}

function extractText(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    texts.push(block.text);
  }
  return texts;
}

export function markersFromText(text: string): readonly Marker[] {
  const markers: Marker[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const markerStart = line.indexOf(`${TASK_COMMUNICATION_MARKER} `);
    if (markerStart < 0) continue;
    const prefix = line.slice(0, markerStart);
    if (prefix.trim().length !== 0 && prefix.trim() !== "-") continue;
    const payload = line.slice(markerStart + TASK_COMMUNICATION_MARKER.length + 1);
    try {
      const parsed = JSON.parse(payload) as unknown;
      const batch = parseTaskMessageBatch(parsed);
      markers.push({ raw: line, prefix, batch });
    } catch {
      // An unrecognized marker is not proof of a provider-bound message.
    }
  }
  return markers;
}

export function markersFromMessages(messages: readonly AgentMessage[]): readonly Marker[] {
  const markers: Marker[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user") continue;
    for (const text of extractText(message.content)) markers.push(...markersFromText(text));
  }
  return markers;
}

export function collapseTextMarkers(
  text: string,
  taskId: string,
  replacement: string,
  insertion: MarkerInsertion,
): Readonly<{ text: string; found: boolean }> {
  let found = false;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const marker = markersFromText(line).find((candidate) => candidate.batch.taskId === taskId);
    if (marker === undefined) {
      lines.push(line);
      continue;
    }
    found = true;
    if (!insertion.inserted) {
      lines.push(`${marker.prefix}${replacement}`);
      insertion.inserted = true;
    }
  }
  return { text: lines.join("\n"), found };
}

export function collapseMessageMarkers(
  message: AgentMessage,
  taskId: string,
  replacement: string,
  insertion: MarkerInsertion,
): Readonly<{ message?: AgentMessage; found: boolean }> {
  if (!isRecord(message) || message.role !== "user") return { message, found: false };
  if (typeof message.content === "string") {
    const collapsed = collapseTextMarkers(message.content, taskId, replacement, insertion);
    if (!collapsed.found) return { message, found: false };
    return collapsed.text.trim().length === 0
      ? { found: true }
      : { message: { ...message, content: collapsed.text } as AgentMessage, found: true };
  }
  if (!Array.isArray(message.content)) return { message, found: false };
  let found = false;
  const content = message.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return [block];
    }
    const collapsed = collapseTextMarkers(block.text, taskId, replacement, insertion);
    if (!collapsed.found) return [block];
    found = true;
    if (collapsed.text.trim().length === 0) return [];
    return [{ ...block, text: collapsed.text }];
  });
  if (!found) return { message, found: false };
  if (content.length === 0) return { found: true };
  return { message: { ...message, content } as AgentMessage, found: true };
}

export function toolName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOOL_NAME_CHARS) {
    return undefined;
  }
  if (value.includes("\0") || /[\r\n\u2028\u2029]/u.test(value)) return undefined;
  return value;
}
