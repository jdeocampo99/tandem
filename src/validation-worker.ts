import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runCommand } from "./adapters/commands.ts";
import type { CommandRunner, ValidationCommand, ValidationEvidence } from "./contracts.ts";
import { writeJsonAtomically } from "./runtime/persistence.ts";
import { runValidation, ValidationConfigurationError } from "./workers/validation.ts";

export type ValidationJob = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly repoPath: string;
  readonly head: string;
  readonly surfaces: readonly string[];
  readonly commands: readonly ValidationCommand[];
  readonly resultPath: string;
}>;

export type ValidationResultStatus = "completed" | "failed";

export type ValidationResult = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly head: string;
  readonly status: ValidationResultStatus;
  readonly evidence: readonly ValidationEvidence[];
  readonly finishedAt: string;
  readonly error?: string;
}>;

export type ValidationWorkerOptions = Readonly<{
  readonly run?: CommandRunner;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
  readonly writeResult?: (path: string, result: ValidationResult) => void | Promise<void>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty string without NUL characters`);
  }
  return value;
}

function singleLine(value: unknown, field: string): string {
  const result = text(value, field);
  if (/[\r\n\u2028\u2029]/u.test(result)) throw new TypeError(`${field} must be single-line`);
  return result;
}

function absolute(value: unknown, field: string): string {
  const result = singleLine(value, field);
  if (!isAbsolute(result)) throw new TypeError(`${field} must be absolute`);
  return resolve(result);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function parseCommand(value: unknown, index: number): ValidationCommand {
  if (!isRecord(value)) throw new TypeError(`commands[${index}] must be an object`);
  const name = singleLine(value.name, `commands[${index}].name`);
  if (!Array.isArray(value.argv) || value.argv.length === 0) {
    throw new TypeError(`commands[${index}].argv must be a non-empty array`);
  }
  const argv: string[] = [];
  for (let argumentIndex = 0; argumentIndex < value.argv.length; argumentIndex += 1) {
    argv.push(singleLine(value.argv[argumentIndex], `commands[${index}].argv[${argumentIndex}]`));
  }
  if (!Array.isArray(value.surfaces)) {
    throw new TypeError(`commands[${index}].surfaces must be an array`);
  }
  const surfaces: string[] = [];
  for (let surfaceIndex = 0; surfaceIndex < value.surfaces.length; surfaceIndex += 1) {
    surfaces.push(
      singleLine(value.surfaces[surfaceIndex], `commands[${index}].surfaces[${surfaceIndex}]`),
    );
  }
  const timeoutMs = value.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) {
    throw new TypeError(`commands[${index}].timeoutMs must be a positive integer`);
  }
  return { name, argv, surfaces, timeoutMs: timeoutMs as number };
}

export function parseValidationJob(value: unknown): ValidationJob {
  if (!isRecord(value)) throw new TypeError("validation job must be an object");
  if (value.schemaVersion !== 1) throw new TypeError("validation job schemaVersion must be 1");
  if (!Array.isArray(value.surfaces)) throw new TypeError("surfaces must be an array");
  const surfaces: string[] = [];
  for (let index = 0; index < value.surfaces.length; index += 1) {
    surfaces.push(singleLine(value.surfaces[index], `surfaces[${index}]`));
  }
  if (!Array.isArray(value.commands)) throw new TypeError("commands must be an array");
  const commands = value.commands.map(parseCommand);
  return {
    schemaVersion: 1,
    id: singleLine(value.id, "id"),
    taskId: singleLine(value.taskId, "taskId"),
    generation: nonNegativeInteger(value.generation, "generation"),
    repoPath: absolute(value.repoPath, "repoPath"),
    head: singleLine(value.head, "head"),
    surfaces,
    commands,
    resultPath: absolute(value.resultPath, "resultPath"),
  };
}

function failureEvidence(
  job: ValidationJob,
  message: string,
  exitCode: number,
): ValidationEvidence {
  return {
    name: "validation-worker",
    argv: [],
    exitCode,
    stdout: "",
    stderr: message,
    head: job.head,
  };
}

function resultFor(
  job: ValidationJob,
  now: () => string,
  status: ValidationResultStatus,
  evidence: readonly ValidationEvidence[],
  error?: string,
): ValidationResult {
  const result = {
    schemaVersion: 1 as const,
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    head: job.head,
    status,
    evidence: evidence.map((entry) => ({ ...entry, argv: [...entry.argv] })),
    finishedAt: now(),
    ...(error === undefined ? {} : { error }),
  };
  return result;
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function validateResult(value: unknown): ValidationResult {
  if (!isRecord(value)) throw new TypeError("validation result must be an object");
  if (value.schemaVersion !== 1) throw new TypeError("validation result schemaVersion must be 1");
  const status =
    value.status === "completed" || value.status === "failed" ? value.status : undefined;
  if (status === undefined) throw new TypeError("validation result status is invalid");
  if (!Array.isArray(value.evidence))
    throw new TypeError("validation result evidence must be an array");
  const evidence: ValidationEvidence[] = [];
  for (let index = 0; index < value.evidence.length; index += 1) {
    const entry = value.evidence[index];
    if (!isRecord(entry)) throw new TypeError(`evidence[${index}] must be an object`);
    if (!Array.isArray(entry.argv)) throw new TypeError(`evidence[${index}].argv must be an array`);
    const argv: string[] = [];
    for (let argumentIndex = 0; argumentIndex < entry.argv.length; argumentIndex += 1) {
      argv.push(singleLine(entry.argv[argumentIndex], `evidence[${index}].argv[${argumentIndex}]`));
    }
    const exitCode = entry.exitCode;
    if (!Number.isSafeInteger(exitCode))
      throw new TypeError(`evidence[${index}].exitCode must be an integer`);
    evidence.push({
      name: singleLine(entry.name, `evidence[${index}].name`),
      argv,
      exitCode: exitCode as number,
      stdout:
        typeof entry.stdout === "string"
          ? entry.stdout
          : (() => {
              throw new TypeError(`evidence[${index}].stdout must be text`);
            })(),
      stderr:
        typeof entry.stderr === "string"
          ? entry.stderr
          : (() => {
              throw new TypeError(`evidence[${index}].stderr must be text`);
            })(),
      head: singleLine(entry.head, `evidence[${index}].head`),
    });
  }
  const error = value.error === undefined ? undefined : text(value.error, "error");
  return {
    schemaVersion: 1,
    id: singleLine(value.id, "id"),
    taskId: singleLine(value.taskId, "taskId"),
    generation: nonNegativeInteger(value.generation, "generation"),
    head: singleLine(value.head, "head"),
    status,
    evidence,
    finishedAt: singleLine(value.finishedAt, "finishedAt"),
    ...(error === undefined ? {} : { error }),
  };
}

export async function readValidationResult(
  path: string,
  expected: Readonly<{
    readonly id: string;
    readonly taskId: string;
    readonly generation: number;
    readonly head: string;
  }>,
): Promise<ValidationResult> {
  const resultPath = absolute(path, "resultPath");
  const contents = await readFile(resultPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TypeError(`validation result is invalid JSON: ${describeError(error)}`);
  }
  const result = validateResult(parsed);
  if (
    result.id !== expected.id ||
    result.taskId !== expected.taskId ||
    result.generation !== expected.generation ||
    result.head !== expected.head
  ) {
    throw new Error("validation result identity or HEAD does not match the job");
  }
  for (const evidence of result.evidence) {
    if (evidence.head !== expected.head)
      throw new Error("validation evidence is not bound to the expected HEAD");
  }
  if (
    result.status === "completed" &&
    (result.evidence.length === 0 || result.evidence.some((entry) => entry.exitCode !== 0))
  ) {
    throw new Error("validation result marked completed without all passing evidence");
  }
  return result;
}

export async function runValidationJob(
  input: ValidationJob,
  options: ValidationWorkerOptions = {},
): Promise<ValidationResult> {
  const job = parseValidationJob(input);
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => new Date().toISOString());
  const writeResult = options.writeResult ?? writeJsonAtomically;
  let result: ValidationResult;
  try {
    const evidence = await runValidation({
      repoPath: job.repoPath,
      head: job.head,
      surfaces: job.surfaces,
      commands: job.commands,
      run,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const status: ValidationResultStatus =
      evidence.length > 0 && evidence.every((entry) => entry.exitCode === 0)
        ? "completed"
        : "failed";
    result = resultFor(
      job,
      now,
      status,
      evidence,
      status === "failed" ? "validation command failed" : undefined,
    );
  } catch (error) {
    const message = describeError(error);
    const evidence = failureEvidence(
      job,
      message,
      error instanceof ValidationConfigurationError ? 78 : 127,
    );
    result = resultFor(job, now, "failed", [evidence], message);
  }
  const validated = validateResult(result);
  if (
    validated.id !== job.id ||
    validated.taskId !== job.taskId ||
    validated.generation !== job.generation ||
    validated.head !== job.head
  ) {
    throw new Error("validation worker produced an identity mismatch");
  }
  await writeResult(job.resultPath, validated);
  return validated;
}

async function readJobFile(path: string): Promise<ValidationJob> {
  const jobPath = absolute(path, "jobPath");
  const contents = await readFile(jobPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TypeError(`validation job is invalid JSON: ${describeError(error)}`);
  }
  return parseValidationJob(parsed);
}

async function runCli(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1 || argv[0] === undefined)
    throw new TypeError("usage: bun src/validation-worker.ts JOB_JSON_PATH");
  const controller = new AbortController();
  const abort = (): void => controller.abort("validation worker interrupted");
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const job = await readJobFile(argv[0]);
    const result = await runValidationJob(job, { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "completed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${describeError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
