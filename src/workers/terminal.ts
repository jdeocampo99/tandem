import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { link, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isAgentRole } from "../contracts.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import type { EndpointInspection } from "../terminal-backend/contract.ts";
import type { LegacyWorkerRole, WorkerJob } from "./jobs.ts";

export const WORKER_JOB_PATH_ENV = "TANDEM_WORKER_JOB_PATH";
/** The only channel a worker uses to deliver its delegated result. */
export const SUBMIT_REPORT_TOOL = "submit_report";
/** A scout's only way to put a repository file (such as an image) next to its mockup. */
export const COPY_ASSET_TOOL = "copy_asset";
const HEARTBEAT_MAX_AGE_MS = 30_000;
const CONTROL_TIMEOUT_MS = 10_000;
const CONTROL_POLL_MS = 50;

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

type WorkerIdentity = Pick<WorkerJob, "id" | "taskId" | "generation">;

function terminalPath(jobPath: string): string {
  if (!isAbsolute(jobPath) || jobPath.includes("\0")) {
    throw new TypeError("worker job path must be absolute without NUL characters");
  }
  return `${jobPath}.terminal.json`;
}

function commandPath(jobPath: string): string {
  return `${terminalPath(jobPath)}.command`;
}

/**
 * Appends one timestamped line to the job's turn trace (`job.json.trace.jsonl`), so a worker that
 * stays busy after submitting shows which lifecycle step never finished. Never throws.
 */
export function traceWorkerTurn(
  jobPath: string,
  event: string,
  detail: Readonly<Record<string, unknown>> = {},
): void {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail });
    appendFileSync(`${jobPath}.trace.jsonl`, `${line}\n`, { mode: 0o600 });
  } catch {
    // Tracing is diagnostic only; a failed write must not disturb the worker.
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n\0]/u.test(value);
}

function timestamp(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

function assertIdentity(value: Record<string, unknown>, expected: WorkerIdentity): void {
  if (
    value.jobId !== expected.id ||
    value.taskId !== expected.taskId ||
    value.generation !== expected.generation
  ) {
    throw new Error("interactive worker terminal identity is stale");
  }
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseTerminal(value: unknown): WorkerTerminalState {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !text(value.jobId) ||
    !text(value.taskId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    // ponytail: "verifier" stays accepted so an interactive terminal already open for a job with
    // the removed role still decodes; see LegacyWorkerRole.
    ((!isAgentRole(value.role) || value.role === "coordinator") && value.role !== "verifier") ||
    !text(value.cwd) ||
    !isAbsolute(value.cwd) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.phase !== "string" ||
    !["starting", "busy", "idle", "paused", "closing", "closed"].includes(value.phase) ||
    typeof value.completed !== "boolean" ||
    !timestamp(value.heartbeatAt) ||
    (value.commandId !== undefined && !text(value.commandId)) ||
    (value.settledCommandId !== undefined && !text(value.settledCommandId))
  ) {
    throw new TypeError("interactive worker terminal state is malformed");
  }
  return value as WorkerTerminalState;
}

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

export function addReplyUsage(
  tally: WorkerTokenTally | undefined,
  reply: ReplyUsage,
): WorkerTokenTally {
  return {
    schemaVersion: 1,
    provider: reply.provider,
    model: reply.model,
    inputTokens: (tally?.inputTokens ?? 0) + reply.input,
    outputTokens: (tally?.outputTokens ?? 0) + reply.output,
    cacheReadTokens: (tally?.cacheReadTokens ?? 0) + reply.cacheRead,
    cacheWriteTokens: (tally?.cacheWriteTokens ?? 0) + reply.cacheWrite,
    costUsd: (tally?.costUsd ?? 0) + reply.costUsd,
    replies: (tally?.replies ?? 0) + 1,
  };
}

/** The usage an OMP assistant message reports, or undefined for any other message. */
export function replyUsage(message: unknown): ReplyUsage | undefined {
  if (!record(message) || message.role !== "assistant") return undefined;
  return usageCounts(
    message.usage,
    typeof message.provider === "string" ? message.provider : "unknown",
    typeof message.model === "string" ? message.model : "unknown",
  );
}

/**
 * The usage all subagents of one OMP `task` call reported, from the tool result's aggregated
 * `details.usage`. It is attributed to the worker's own provider and model, since the tally keeps one.
 */
export function taskUsage(
  result: unknown,
  tally: WorkerTokenTally | undefined,
): ReplyUsage | undefined {
  if (!record(result) || !record(result.details)) return undefined;
  return usageCounts(result.details.usage, tally?.provider ?? "unknown", tally?.model ?? "unknown");
}

function usageCounts(usage: unknown, provider: string, model: string): ReplyUsage | undefined {
  if (!record(usage)) return undefined;
  const cost = record(usage.cost) ? usage.cost.total : 0;
  const counts = [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, cost];
  if (!counts.every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0)) {
    return undefined;
  }
  return {
    provider,
    model,
    input: usage.input as number,
    output: usage.output as number,
    cacheRead: (usage.cacheRead ?? 0) as number,
    cacheWrite: (usage.cacheWrite ?? 0) as number,
    costUsd: cost as number,
  };
}

export async function writeWorkerTokenTally(
  jobPath: string,
  tally: WorkerTokenTally,
): Promise<void> {
  await writeJsonAtomically(`${jobPath}.usage.json`, tally);
}

/** The worker's token tally, or undefined when it recorded none or the file is unreadable. */
export async function readWorkerTokenTally(jobPath: string): Promise<WorkerTokenTally | undefined> {
  try {
    const value: unknown = await readOptionalJson(`${jobPath}.usage.json`);
    if (!record(value) || value.schemaVersion !== 1) return undefined;
    const numbers = [
      value.inputTokens,
      value.outputTokens,
      value.cacheReadTokens,
      value.cacheWriteTokens,
      value.costUsd,
      value.replies,
    ];
    if (!text(value.provider) || !text(value.model)) return undefined;
    if (
      !numbers.every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0)
    ) {
      return undefined;
    }
    return value as WorkerTokenTally;
  } catch {
    return undefined;
  }
}

export async function readWorkerTerminal(
  job: WorkerTerminalJob,
): Promise<WorkerTerminalState | undefined> {
  const value = await readOptionalJson(terminalPath(job.jobPath));
  if (value === undefined) return undefined;
  const state = parseTerminal(value);
  assertIdentity(state, job);
  if (state.role !== job.role || resolve(state.cwd) !== resolve(job.cwd)) {
    throw new Error("interactive worker terminal role or working directory does not match");
  }
  return state;
}

export async function writeWorkerTerminal(
  jobPath: string,
  state: WorkerTerminalState,
): Promise<void> {
  await writeJsonAtomically(terminalPath(jobPath), parseTerminal(state));
}

function absoluteText(value: unknown): value is string {
  return text(value) && isAbsolute(value);
}

function parseCommand(value: unknown, job: WorkerIdentity): WorkerTerminalCommand {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !text(value.id) ||
    (value.action !== "pause" && value.action !== "close" && value.action !== "mockup") ||
    !timestamp(value.expiresAt) ||
    (value.action === "mockup") !== (value.mockup !== undefined) ||
    (value.mockup !== undefined &&
      (!record(value.mockup) ||
        !absoluteText(value.mockup.briefPath) ||
        !absoluteText(value.mockup.artifactDir)))
  ) {
    throw new TypeError("interactive worker terminal command is malformed");
  }
  assertIdentity(value, job);
  return value as WorkerTerminalCommand;
}

export async function readWorkerTerminalCommand(
  jobPath: string,
  job: WorkerIdentity,
): Promise<WorkerTerminalCommand | undefined> {
  const value = await readOptionalJson(commandPath(jobPath));
  if (value === undefined) return undefined;
  const command = parseCommand(value, job);
  return Date.parse(command.expiresAt) > Date.now() ? command : undefined;
}

export async function requestWorkerTerminalCommand(
  job: WorkerTerminalJob,
  action: "pause" | "close",
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<void> {
  await publishCommand(
    job,
    { id: randomUUID(), action },
    (state, id) =>
      state.commandId === id &&
      (state.phase === "closed" ||
        (action === "close" && state.phase === "closing") ||
        (action === "pause" && state.phase === "paused")),
    timeoutMs,
  );
}

/**
 * Asks a finished scout to start a mockup turn. Resolves once the worker has taken the request;
 * `id` is stable per request, so a retry after an unobserved acknowledgement is ignored.
 */
export async function requestWorkerMockup(
  job: WorkerTerminalJob,
  id: string,
  mockup: WorkerMockupRequest,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<void> {
  const current = await readWorkerTerminal(job);
  if (current?.commandId === id || current?.settledCommandId === id) return;
  await publishCommand(
    job,
    { id, action: "mockup", mockup },
    (state) => state.commandId === id || state.settledCommandId === id,
    timeoutMs,
  );
}

async function publishCommand(
  job: WorkerTerminalJob,
  request: Pick<WorkerTerminalCommand, "id" | "action" | "mockup">,
  acknowledged: (state: WorkerTerminalState, id: string) => boolean,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("interactive worker control timeout must be positive");
  }
  const path = commandPath(job.jobPath);
  const prior = await readOptionalJson(path);
  if (prior !== undefined) {
    const command = parseCommand(prior, job);
    if (Date.parse(command.expiresAt) > Date.now()) {
      throw new Error("an interactive worker control request is already pending");
    }
    await rm(path);
  }
  const deadline = Date.now() + timeoutMs;
  const command: WorkerTerminalCommand = {
    schemaVersion: 1,
    id: request.id,
    jobId: job.id,
    taskId: job.taskId,
    generation: job.generation,
    action: request.action,
    expiresAt: new Date(deadline).toISOString(),
    ...(request.mockup === undefined ? {} : { mockup: request.mockup }),
  };
  const temporary = `${path}.${command.id}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(command)}\n`, { flag: "wx", mode: 0o600 });
    // Publish atomically without replacing another coordinator's pending request.
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  try {
    while (true) {
      const state = await readWorkerTerminal(job);
      if (state !== undefined && acknowledged(state, command.id)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `interactive worker did not acknowledge ${request.action}; its terminal was preserved`,
        );
      }
      await Bun.sleep(CONTROL_POLL_MS);
    }
  } finally {
    const current = await readOptionalJson(path);
    if (record(current) && current.id === command.id) await rm(path, { force: true });
  }
}

export async function liveWorkerTerminal(
  inspection: EndpointInspection,
  job: WorkerTerminalJob,
): Promise<WorkerTerminalState | undefined> {
  if (!inspection.activeWorker || job.role === "validation") return undefined;
  const terminal = await readWorkerTerminal(job);
  if (terminal === undefined || terminal.phase === "closed") return undefined;
  if (!inspection.processInfo.foregroundProcesses.some((process) => process.pid === terminal.pid)) {
    throw new Error("interactive worker PID is not in the owned pane's foreground process group");
  }
  const cwd = inspection.pane.foregroundCwd;
  if (cwd === undefined) throw new Error("interactive worker foreground directory is unavailable");
  if (resolve(cwd) !== resolve(job.cwd)) {
    const [actual, expected] = await Promise.all([realpath(cwd), realpath(job.cwd)]);
    if (actual !== expected) throw new Error("interactive worker left its owned working directory");
  }
  const age = Date.now() - Date.parse(terminal.heartbeatAt);
  if (age < -HEARTBEAT_MAX_AGE_MS || age > HEARTBEAT_MAX_AGE_MS) {
    throw new Error("interactive worker terminal heartbeat is stale");
  }
  return terminal;
}

export async function workerDelegationStopped(
  inspection: EndpointInspection,
  job?: WorkerTerminalJob,
): Promise<boolean> {
  if (!inspection.activeWorker) return true;
  if (job === undefined) return false;
  const terminal = await liveWorkerTerminal(inspection, job);
  return terminal !== undefined && (terminal.completed || terminal.phase === "paused");
}

const MAX_TASK_WORKSPACE_TITLE_LENGTH = 32;
const workspaceGraphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

function normalizeWorkspaceText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateWorkspaceText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = "…";
  const available = Math.max(0, maxLength - suffix.length);
  let output = "";
  for (const segment of workspaceGraphemes.segment(value)) {
    if (output.length + segment.segment.length > available) break;
    output += segment.segment;
  }
  return `${output}${suffix}`;
}

/** Names a task's sidebar workspace by its short title, or by its objective on older tasks. */
export function taskWorkspaceLabel(task: Readonly<{ title?: string; objective: string }>): string {
  const title = normalizeWorkspaceText(task.title ?? "");
  const name = title.length === 0 ? normalizeWorkspaceText(task.objective) : title;
  if (name.length === 0) throw new TypeError("task title or objective must be non-empty text");
  return `└ ${truncateWorkspaceText(name, MAX_TASK_WORKSPACE_TITLE_LENGTH)}`;
}
