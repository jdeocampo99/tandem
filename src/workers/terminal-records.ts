import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isAgentRole } from "../contracts.ts";
import type { LegacyWorkerRole, WorkerJob } from "./jobs.ts";

export type WorkerTerminalJob = Readonly<{
  id: string;
  taskId: string;
  generation: number;
  role: LegacyWorkerRole | "validation";
  cwd: string;
  jobPath: string;
}>;

export type WorkerTerminalState = Readonly<{
  schemaVersion: 1;
  jobId: string;
  taskId: string;
  generation: number;
  role: LegacyWorkerRole;
  cwd: string;
  pid: number;
  phase: "starting" | "busy" | "idle" | "paused" | "closing" | "closed";
  completed: boolean;
  heartbeatAt: string;
  commandId?: string;
  /** The last mockup request whose turn has finished. */
  settledCommandId?: string;
}>;

/** Asks a finished scout to draw or revise the mockup at `artifactDir` from the brief file. */
export type WorkerMockupRequest = Readonly<{
  briefPath: string;
  artifactDir: string;
}>;

export type WorkerTerminalCommand = Readonly<{
  schemaVersion: 1;
  id: string;
  jobId: string;
  taskId: string;
  generation: number;
  action: "pause" | "close" | "mockup";
  expiresAt: string;
  /** Present exactly when `action` is `mockup`. */
  mockup?: WorkerMockupRequest;
}>;

/**
 * The tokens one worker's model replies reported, summed as OMP delivers them. `costUsd` is OMP's
 * own estimate from its model price table, not a bill: a subscription account is not charged it.
 */
export type WorkerTokenTally = Readonly<{
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly replies: number;
}>;

/** The token counts one model reply reported, as OMP's assistant message carries them. */
export type ReplyUsage = Readonly<{
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
}>;

export type WorkerIdentity = Pick<WorkerJob, "id" | "taskId" | "generation">;

export function terminalPath(jobPath: string): string {
  if (!isAbsolute(jobPath) || jobPath.includes("\0")) {
    throw new TypeError("worker job path must be absolute without NUL characters");
  }
  return `${jobPath}.terminal.json`;
}

export function commandPath(jobPath: string): string {
  return `${terminalPath(jobPath)}.command`;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n\0]/u.test(value);
}

function timestamp(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

export function assertIdentity(
  value: Record<string, unknown>,
  expected: WorkerIdentity,
): asserts value is Record<string, unknown> &
  Pick<WorkerTerminalState, "jobId" | "taskId" | "generation"> {
  if (
    value.jobId !== expected.id ||
    value.taskId !== expected.taskId ||
    value.generation !== expected.generation
  ) {
    throw new Error("interactive worker terminal identity is stale");
  }
}

export async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isTerminal(value: unknown): value is WorkerTerminalState {
  if (!record(value)) return false;
  return (
    value.schemaVersion === 1 &&
    text(value.jobId) &&
    text(value.taskId) &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    // "verifier" remains readable for an already-open legacy worker.
    ((isAgentRole(value.role) && value.role !== "coordinator") || value.role === "verifier") &&
    text(value.cwd) &&
    isAbsolute(value.cwd) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.phase === "string" &&
    ["starting", "busy", "idle", "paused", "closing", "closed"].includes(value.phase) &&
    typeof value.completed === "boolean" &&
    timestamp(value.heartbeatAt) &&
    (value.commandId === undefined || text(value.commandId)) &&
    (value.settledCommandId === undefined || text(value.settledCommandId))
  );
}

export function parseTerminal(value: unknown): WorkerTerminalState {
  if (!isTerminal(value)) throw new TypeError("interactive worker terminal state is malformed");
  return value;
}

function absoluteText(value: unknown): value is string {
  return text(value) && isAbsolute(value);
}

function isCommand(
  value: unknown,
): value is Record<string, unknown> &
  Omit<WorkerTerminalCommand, "jobId" | "taskId" | "generation"> {
  if (!record(value)) return false;
  return (
    value.schemaVersion === 1 &&
    text(value.id) &&
    (value.action === "pause" || value.action === "close" || value.action === "mockup") &&
    timestamp(value.expiresAt) &&
    (value.action === "mockup") === (value.mockup !== undefined) &&
    (value.mockup === undefined ||
      (record(value.mockup) &&
        absoluteText(value.mockup.briefPath) &&
        absoluteText(value.mockup.artifactDir)))
  );
}

export function parseCommand(value: unknown, job: WorkerIdentity): WorkerTerminalCommand {
  if (!isCommand(value)) throw new TypeError("interactive worker terminal command is malformed");
  assertIdentity(value, job);
  return value;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function usageCounts(
  usage: unknown,
  provider: string,
  model: string,
): ReplyUsage | undefined {
  if (!record(usage)) return undefined;
  const { input, output } = usage;
  const costUsd = record(usage.cost) ? usage.cost.total : 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  if (!count(input) || !count(output) || !count(cacheRead) || !count(cacheWrite) || !count(costUsd))
    return undefined;
  return { provider, model, input, output, cacheRead, cacheWrite, costUsd };
}

function isTokenTally(value: unknown): value is WorkerTokenTally {
  if (!record(value) || value.schemaVersion !== 1) return false;
  return (
    text(value.provider) &&
    text(value.model) &&
    count(value.inputTokens) &&
    count(value.outputTokens) &&
    count(value.cacheReadTokens) &&
    count(value.cacheWriteTokens) &&
    count(value.costUsd) &&
    count(value.replies)
  );
}

export function parseTokenTally(value: unknown): WorkerTokenTally | undefined {
  return isTokenTally(value) ? value : undefined;
}
