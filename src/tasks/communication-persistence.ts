import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { TaskInbox, WorkerReceipt } from "../contracts.ts";
import {
  isRecord,
  parseTaskInbox,
  parseWorkerReceipt,
  readIdentifier,
  readNonNegativeInteger,
  readSafeTaskId,
  readSingleLine,
} from "./communication-protocol.ts";

const TASK_INBOX_FILE = "inbox.json";
const WORKER_RECEIPT_FILE = "communication.json";

function absolutePath(value: unknown, field: string): string {
  const path = readSingleLine(value, field, 4_096);
  if (!isAbsolute(path)) throw new TypeError(`${field} must be an absolute path`);
  return resolve(path);
}

export function taskInboxPath(home: string, taskId: string): string {
  const root = absolutePath(home, "home");
  const safeTaskId = readSafeTaskId(taskId, "taskId");
  return join(root, "communications", safeTaskId, TASK_INBOX_FILE);
}

export function workerReceiptPath(jobPath: string): string {
  return join(dirname(absolutePath(jobPath, "jobPath")), WORKER_RECEIPT_FILE);
}
function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function assertPrivateTarget(path: string, absentOkay: boolean): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink())
      throw new Error(`communication target must not be a symlink: ${path}`);
    if (!entry.isFile()) throw new Error(`communication target must be a regular file: ${path}`);
  } catch (error) {
    if (absentOkay && isMissing(error)) return;
    throw error;
  }
}

async function writePrivateJson(pathInput: string, value: unknown): Promise<void> {
  const path = absolutePath(pathInput, "path");
  await assertPrivateTarget(path, true);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readPrivateJson(pathInput: string): Promise<unknown | undefined> {
  const path = absolutePath(pathInput, "path");
  await assertPrivateTarget(path, true);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TypeError(
      `communication file at ${path} is not valid JSON: ${error instanceof Error ? error.message : "parse failure"}`,
    );
  }
}

export async function readTaskInbox(path: string): Promise<TaskInbox | undefined> {
  const parsed = await readPrivateJson(path);
  return parsed === undefined ? undefined : parseTaskInbox(parsed);
}

export async function writeTaskInbox(path: string, inbox: TaskInbox): Promise<void> {
  const validated = parseTaskInbox(inbox);
  await writePrivateJson(path, validated);
}
export async function readWorkerReceipt(
  path: string,
  expected: Readonly<{ jobId: string; taskId: string; generation: number }>,
): Promise<WorkerReceipt | undefined> {
  const jobId = readIdentifier(expected.jobId, "expected.jobId");
  const taskId = readIdentifier(expected.taskId, "expected.taskId");
  const generation = readNonNegativeInteger(expected.generation, "expected.generation");
  const parsed = await readPrivateJson(path);
  if (parsed === undefined) return undefined;
  const receipt = parseWorkerReceipt(parsed);
  if (receipt.jobId !== jobId || receipt.taskId !== taskId || receipt.generation !== generation) {
    throw new Error("worker receipt identity does not match the expected worker");
  }
  return receipt;
}

export async function writeWorkerReceipt(path: string, receipt: WorkerReceipt): Promise<void> {
  const validated = parseWorkerReceipt(receipt);
  await writePrivateJson(path, validated);
}
