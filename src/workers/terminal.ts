import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { link, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import type { EndpointInspection } from "../terminal-backend/contract.ts";
import * as records from "./terminal-records.ts";

export type {
  ReplyUsage,
  WorkerMockupRequest,
  WorkerTerminalCommand,
  WorkerTerminalJob,
  WorkerTerminalState,
  WorkerTokenTally,
} from "./terminal-records.ts";

export type WorkerControlTiming = Readonly<{
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  createId?: () => string;
}>;

export const WORKER_JOB_PATH_ENV = "TANDEM_WORKER_JOB_PATH";
/** The only channel a worker uses to deliver its delegated result. */
export const SUBMIT_REPORT_TOOL = "submit_report";
/** A scout's only way to put a repository file (such as an image) next to its mockup. */
export const COPY_ASSET_TOOL = "copy_asset";
const HEARTBEAT_MAX_AGE_MS = 30_000;
const CONTROL_TIMEOUT_MS = 10_000;
const CONTROL_POLL_MS = 50;

/**
 * Appends one timestamped line to the job's turn trace (`job.json.trace.jsonl`), so a worker that
 * stays busy after submitting shows which lifecycle step never finished. Never throws.
 */
export function traceWorkerTurn(
  jobPath: string,
  event: string,
  detail: Readonly<Record<string, unknown>> = {},
  now: () => number = Date.now,
): void {
  try {
    const line = JSON.stringify({ at: new Date(now()).toISOString(), event, ...detail });
    appendFileSync(`${jobPath}.trace.jsonl`, `${line}\n`, { mode: 0o600 });
  } catch {
    // Tracing is diagnostic only; a failed write must not disturb the worker.
  }
}

export function addReplyUsage(
  tally: records.WorkerTokenTally | undefined,
  reply: records.ReplyUsage,
): records.WorkerTokenTally {
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
export function replyUsage(message: unknown): records.ReplyUsage | undefined {
  if (!records.record(message) || message.role !== "assistant") return undefined;
  return records.usageCounts(
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
  tally: records.WorkerTokenTally | undefined,
): records.ReplyUsage | undefined {
  if (!records.record(result) || !records.record(result.details)) return undefined;
  return records.usageCounts(
    result.details.usage,
    tally?.provider ?? "unknown",
    tally?.model ?? "unknown",
  );
}

export async function writeWorkerTokenTally(
  jobPath: string,
  tally: records.WorkerTokenTally,
): Promise<void> {
  await writeJsonAtomically(`${jobPath}.usage.json`, tally);
}

/** The worker's token tally, or undefined when it recorded none or the file is unreadable. */
export async function readWorkerTokenTally(
  jobPath: string,
): Promise<records.WorkerTokenTally | undefined> {
  try {
    const value = await records.readOptionalJson(`${jobPath}.usage.json`);
    return records.isTokenTally(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function readWorkerTerminal(
  job: records.WorkerTerminalJob,
): Promise<records.WorkerTerminalState | undefined> {
  const value = await records.readOptionalJson(records.terminalPath(job.jobPath));
  if (value === undefined) return undefined;
  const state = records.parseTerminal(value);
  records.assertIdentity(state, job);
  if (state.role !== job.role || resolve(state.cwd) !== resolve(job.cwd)) {
    throw new Error("interactive worker terminal role or working directory does not match");
  }
  return state;
}

export async function writeWorkerTerminal(
  jobPath: string,
  state: records.WorkerTerminalState,
): Promise<void> {
  await writeJsonAtomically(records.terminalPath(jobPath), records.parseTerminal(state));
}

export async function readWorkerTerminalCommand(
  jobPath: string,
  job: records.WorkerIdentity,
  now: () => number = Date.now,
): Promise<records.WorkerTerminalCommand | undefined> {
  const value = await records.readOptionalJson(records.commandPath(jobPath));
  if (value === undefined) return undefined;
  const command = records.parseCommand(value, job);
  return Date.parse(command.expiresAt) > now() ? command : undefined;
}

export async function requestWorkerTerminalCommand(
  job: records.WorkerTerminalJob,
  action: "pause" | "close",
  timeoutMs = CONTROL_TIMEOUT_MS,
  timing: WorkerControlTiming = {},
): Promise<void> {
  await publishCommand(
    job,
    { id: (timing.createId ?? randomUUID)(), action },
    (state, id) =>
      state.commandId === id &&
      (state.phase === "closed" ||
        (action === "close" && state.phase === "closing") ||
        (action === "pause" && state.phase === "paused")),
    { timeoutMs, ...timing },
  );
}

/**
 * Asks a finished scout to start a mockup turn. Resolves once the worker has taken the request;
 * `id` is stable per request, so a retry after an unobserved acknowledgement is ignored.
 */
export async function requestWorkerMockup(
  job: records.WorkerTerminalJob,
  id: string,
  mockup: records.WorkerMockupRequest,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<void> {
  const current = await readWorkerTerminal(job);
  if (current?.commandId === id || current?.settledCommandId === id) return;
  await publishCommand(
    job,
    { id, action: "mockup", mockup },
    (state) => state.commandId === id || state.settledCommandId === id,
    { timeoutMs },
  );
}

async function publishCommand(
  job: records.WorkerTerminalJob,
  request: Pick<records.WorkerTerminalCommand, "id" | "action" | "mockup">,
  acknowledged: (state: records.WorkerTerminalState, id: string) => boolean,
  timing: WorkerControlTiming & Readonly<{ timeoutMs: number }>,
): Promise<void> {
  const { timeoutMs, now = Date.now, sleep = Bun.sleep } = timing;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("interactive worker control timeout must be positive");
  }
  const path = records.commandPath(job.jobPath);
  const prior = await records.readOptionalJson(path);
  if (prior !== undefined) {
    const command = records.parseCommand(prior, job);
    if (Date.parse(command.expiresAt) > now()) {
      throw new Error("an interactive worker control request is already pending");
    }
    await rm(path);
  }
  const deadline = now() + timeoutMs;
  const command: records.WorkerTerminalCommand = {
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
    for (;;) {
      const state = await readWorkerTerminal(job);
      if (state !== undefined && acknowledged(state, command.id)) return;
      if (now() >= deadline) {
        throw new Error(
          `interactive worker did not acknowledge ${request.action}; its terminal was preserved`,
        );
      }
      await sleep(CONTROL_POLL_MS);
    }
  } finally {
    const current = await records.readOptionalJson(path);
    if (records.record(current) && current.id === command.id) await rm(path, { force: true });
  }
}

export async function liveWorkerTerminal(
  inspection: EndpointInspection,
  job: records.WorkerTerminalJob,
  now: () => number = Date.now,
): Promise<records.WorkerTerminalState | undefined> {
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
  const age = now() - Date.parse(terminal.heartbeatAt);
  if (age < -HEARTBEAT_MAX_AGE_MS || age > HEARTBEAT_MAX_AGE_MS) {
    throw new Error("interactive worker terminal heartbeat is stale");
  }
  return terminal;
}

export async function workerDelegationStopped(
  inspection: EndpointInspection,
  job?: records.WorkerTerminalJob,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!inspection.activeWorker) return true;
  if (job === undefined) return false;
  const terminal = await liveWorkerTerminal(inspection, job, now);
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
