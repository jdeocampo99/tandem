import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { IdFactory } from "../contracts.ts";
import type { TaskStore } from "../tasks/store.ts";
import { absolutePath, emptyRuntimeState, parseRuntimeState, type RuntimeState } from "./schema.ts";

export type RuntimeMutation = (state: RuntimeState) => RuntimeState | PromiseLike<RuntimeState>;

function describeFailure(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

export function runtimeFile(home: string): string {
  const root = resolve(home);
  if (!isAbsolute(root)) throw new TypeError("home must resolve to an absolute directory");
  return join(root, "runtime.json");
}

export function jobsDirectory(home: string): string {
  return join(resolve(home), "jobs");
}

export function taskJobsDirectory(home: string, taskId: string): string {
  return join(jobsDirectory(home), taskId);
}

export function presentationsDirectory(home: string): string {
  return join(resolve(home), "presentations");
}

export function taskSessionDirectory(home: string, taskId: string): string {
  return join(resolve(home), "sessions", taskId);
}

export async function readRuntimeState(path: string): Promise<RuntimeState> {
  const runtimePath = absolutePath(path, "runtime path");
  let contents: string;
  try {
    contents = await readFile(runtimePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      !Array.isArray(error) &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return emptyRuntimeState();
    }
    throw new Error(`could not read runtime state at ${runtimePath}: ${describeFailure(error)}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`runtime state at ${runtimePath} is invalid JSON: ${describeFailure(error)}`, {
      cause: error,
    });
  }
  return parseRuntimeState(parsed, runtimePath);
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const destination = absolutePath(path, "destination path");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeTextAtomically(path: string, value: string): Promise<void> {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError("text value must be a string without NUL characters");
  }
  const destination = absolutePath(path, "destination path");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeRuntimeState(path: string, state: RuntimeState): Promise<void> {
  const parsed = parseRuntimeState(state, "runtime state");
  await writeJsonAtomically(path, parsed);
}

export async function updateRuntimeState(
  store: TaskStore,
  path: string,
  mutation: RuntimeMutation,
): Promise<RuntimeState> {
  if (typeof mutation !== "function") throw new TypeError("runtime mutation must be a function");
  return store.exclusive(async () => {
    const current = await readRuntimeState(path);
    const next = parseRuntimeState(await mutation(current), "runtime state mutation");
    await writeRuntimeState(path, next);
    return next;
  });
}
export function defaultIdFactory(): IdFactory {
  return () => randomUUID();
}
