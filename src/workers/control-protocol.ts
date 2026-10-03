import { isAbsolute } from "node:path";
import type { TaskInbox, WorkerReceipt } from "../contracts.ts";
import { parseTaskMessageBatch, type TaskMessageBatch } from "../tasks/communication-protocol.ts";

export const WORKER_CONTROL_ENV = "TANDEM_WORKER_CONTROL";

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

export function toolName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOOL_NAME_CHARS) {
    return undefined;
  }
  if (value.includes("\0") || /[\r\n\u2028\u2029]/u.test(value)) return undefined;
  return value;
}

/** The inbox's messages as a batch, or undefined when it holds none. */
export function inboxMessageBatch(
  taskId: string,
  inbox: TaskInbox | undefined,
): TaskMessageBatch | undefined {
  if (inbox === undefined || inbox.revision === 0 || inbox.messages.length === 0) return undefined;
  return parseTaskMessageBatch({ taskId, revision: inbox.revision, messages: inbox.messages });
}

/** The incoming batch when it is at least as new as the retained one, otherwise the retained one. */
export function atLeastAsNewBatch(
  incoming: TaskMessageBatch | undefined,
  retained: TaskMessageBatch | undefined,
): TaskMessageBatch | undefined {
  if (incoming === undefined) return retained;
  return retained === undefined || incoming.revision >= retained.revision ? incoming : retained;
}

export type ReceiptActivity = Readonly<{
  readonly phase: WorkerReceipt["phase"];
  readonly tool?: string | undefined;
  /** Whether the activity is progress, not just a heartbeat. */
  readonly meaningful: boolean;
}>;

/**
 * The receipt after an activity observation, and whether it changed phase or tool, which is
 * written immediately rather than waiting for the write interval.
 */
export function touchedReceipt(
  receipt: WorkerReceipt,
  activity: ReceiptActivity,
  now: string,
): Readonly<{ receipt: WorkerReceipt; changed: boolean }> {
  const { phase, tool } = activity;
  const phaseChanged = receipt.phase !== phase;
  const toolChanged = phase === "tool" && receipt.tool !== tool;
  const { tool: _previousTool, ...withoutTool } = receipt;
  return {
    receipt: {
      ...withoutTool,
      heartbeatAt: now,
      progressAt: activity.meaningful ? now : receipt.progressAt,
      phase,
      ...(phase === "tool" && tool !== undefined ? { tool } : {}),
    },
    changed: phaseChanged || toolChanged,
  };
}
