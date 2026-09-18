import { randomUUID } from "node:crypto";
import { link, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { HerdrPaneInspection } from "../adapters/herdr.ts";
import { isAgentRole } from "../contracts.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import type { WorkerJob, WorkerRole } from "./jobs.ts";

export const WORKER_JOB_PATH_ENV = "TANDEM_WORKER_JOB_PATH";
const HEARTBEAT_MAX_AGE_MS = 30_000;
const CONTROL_TIMEOUT_MS = 10_000;
const CONTROL_POLL_MS = 50;

export type WorkerTerminalJob = Readonly<{
  id: string;
  taskId: string;
  generation: number;
  role: WorkerRole | "validation";
  cwd: string;
  jobPath: string;
}>;

export type WorkerTerminalState = Readonly<{
  schemaVersion: 1;
  jobId: string;
  taskId: string;
  generation: number;
  role: WorkerRole;
  cwd: string;
  pid: number;
  phase: "starting" | "busy" | "idle" | "paused" | "closing" | "closed";
  completed: boolean;
  heartbeatAt: string;
  commandId?: string;
}>;

export type WorkerTerminalCommand = Readonly<{
  schemaVersion: 1;
  id: string;
  jobId: string;
  taskId: string;
  generation: number;
  action: "pause" | "close";
  expiresAt: string;
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
    !isAgentRole(value.role) ||
    value.role === "coordinator" ||
    !text(value.cwd) ||
    !isAbsolute(value.cwd) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.phase !== "string" ||
    !["starting", "busy", "idle", "paused", "closing", "closed"].includes(value.phase) ||
    typeof value.completed !== "boolean" ||
    !timestamp(value.heartbeatAt) ||
    (value.commandId !== undefined && !text(value.commandId))
  ) {
    throw new TypeError("interactive worker terminal state is malformed");
  }
  return value as WorkerTerminalState;
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

function parseCommand(value: unknown, job: WorkerIdentity): WorkerTerminalCommand {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !text(value.id) ||
    (value.action !== "pause" && value.action !== "close") ||
    !timestamp(value.expiresAt)
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
    id: randomUUID(),
    jobId: job.id,
    taskId: job.taskId,
    generation: job.generation,
    action,
    expiresAt: new Date(deadline).toISOString(),
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
      if (
        state?.commandId === command.id &&
        (state.phase === "closed" ||
          (action === "close" && state.phase === "closing") ||
          (action === "pause" && state.phase === "paused"))
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `interactive worker did not acknowledge ${action}; its terminal was preserved`,
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
  inspection: HerdrPaneInspection,
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
  inspection: HerdrPaneInspection,
  job?: WorkerTerminalJob,
): Promise<boolean> {
  if (!inspection.activeWorker) return true;
  if (job === undefined) return false;
  const terminal = await liveWorkerTerminal(inspection, job);
  return terminal !== undefined && (terminal.completed || terminal.phase === "paused");
}
