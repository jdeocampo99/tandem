import { readFile } from "node:fs/promises";
import { runCommand } from "./adapters/commands.ts";
import type {
  CheckOrigin,
  CommandRunner,
  ValidationCommand,
  ValidationContractName,
  ValidationEvidence,
} from "./contracts.ts";
import { writeJsonAtomically } from "./runtime/persistence.ts";
import {
  absolutePath,
  isRecord,
  nonNegativeInteger,
  singleLine as parseSingleLine,
  positiveInteger,
  text,
} from "./runtime/schema.ts";
import { ValidationConfigurationError } from "./tasks/acceptance.ts";
import { terminalBackend } from "./terminal-backend/compose.ts";
import {
  claimExecutionStart,
  type ExecutionAdmission,
  type ExecutionGateInput,
  type ExecutionIdentity,
} from "./workers/execution-gate.ts";
import { runValidation } from "./workers/validation.ts";

/** One contract run handed to the runner: which checks, under which contract and identity. */
export type ValidationJob = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly repoPath: string;
  readonly head: string;
  readonly contract: ValidationContractName;
  readonly policyDigest: string;
  readonly surfaces: readonly string[];
  readonly commands: readonly ValidationCommand[];
  readonly resultPath: string;
  readonly execution?: ExecutionIdentity;
}>;

export type ValidationResultStatus = "completed" | "failed";

export type ValidationResult = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly head: string;
  readonly contract: ValidationContractName;
  readonly policyDigest: string;
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
  readonly executionGate?: (
    input: ExecutionGateInput,
  ) => ExecutionAdmission | PromiseLike<ExecutionAdmission>;
}>;

function singleLine(value: unknown, field: string): string {
  return parseSingleLine(value, field, { lineMessage: `${field} must be single-line` });
}

function absolute(value: unknown, field: string): string {
  return absolutePath(value, field, { lineMessage: `${field} must be single-line` });
}

function parseExecution(value: unknown): ExecutionIdentity {
  if (!isRecord(value)) throw new TypeError("execution must be an object");
  for (const key of Object.keys(value)) {
    if (!["schemaVersion", "home", "operationId", "fencingRevision", "claimOwner"].includes(key)) {
      throw new TypeError(`execution contains unknown field ${key}`);
    }
  }
  if (value.schemaVersion !== 1) throw new TypeError("execution.schemaVersion must be 1");
  return {
    schemaVersion: 1,
    home: absolute(value.home, "execution.home"),
    operationId: singleLine(value.operationId, "execution.operationId"),
    fencingRevision: positiveInteger(value.fencingRevision, "execution.fencingRevision"),
    claimOwner: singleLine(value.claimOwner, "execution.claimOwner"),
  };
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
  const timeoutMs = positiveInteger(value.timeoutMs, `commands[${index}].timeoutMs`);
  return { name, argv, surfaces, timeoutMs };
}

function contractName(value: unknown, field: string): ValidationContractName {
  if (value !== "iteration" && value !== "final") {
    throw new TypeError(`${field} must be iteration or final`);
  }
  return value;
}

function checkOrigin(value: unknown, field: string): CheckOrigin {
  if (value !== "local" && value !== "github") {
    throw new TypeError(`${field} must be local or github`);
  }
  return value;
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
  const execution = value.execution === undefined ? undefined : parseExecution(value.execution);
  return {
    schemaVersion: 1,
    id: singleLine(value.id, "id"),
    taskId: singleLine(value.taskId, "taskId"),
    generation: nonNegativeInteger(value.generation, "generation"),
    repoPath: absolute(value.repoPath, "repoPath"),
    head: singleLine(value.head, "head"),
    contract: contractName(value.contract, "contract"),
    policyDigest: singleLine(value.policyDigest, "policyDigest"),
    surfaces,
    commands,
    resultPath: absolute(value.resultPath, "resultPath"),
    ...(execution === undefined ? {} : { execution }),
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
    contract: job.contract,
    origin: "local",
    policyDigest: job.policyDigest,
  };
}

function resultFor(
  job: ValidationJob,
  now: () => string,
  status: ValidationResultStatus,
  evidence: readonly ValidationEvidence[],
  error?: string,
): ValidationResult {
  const result: ValidationResult = {
    schemaVersion: 1,
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    head: job.head,
    contract: job.contract,
    policyDigest: job.policyDigest,
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
    if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))
      throw new TypeError(`evidence[${index}].exitCode must be an integer`);
    evidence.push({
      name: singleLine(entry.name, `evidence[${index}].name`),
      argv,
      exitCode,
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
      contract: contractName(entry.contract, `evidence[${index}].contract`),
      origin: checkOrigin(entry.origin, `evidence[${index}].origin`),
      policyDigest: singleLine(entry.policyDigest, `evidence[${index}].policyDigest`),
    });
  }
  const error = value.error === undefined ? undefined : text(value.error, "error");
  return {
    schemaVersion: 1,
    id: singleLine(value.id, "id"),
    taskId: singleLine(value.taskId, "taskId"),
    generation: nonNegativeInteger(value.generation, "generation"),
    head: singleLine(value.head, "head"),
    contract: contractName(value.contract, "contract"),
    policyDigest: singleLine(value.policyDigest, "policyDigest"),
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
    readonly contract: ValidationContractName;
    readonly policyDigest: string;
  }>,
): Promise<ValidationResult> {
  const resultPath = absolute(path, "resultPath");
  const contents = await readFile(resultPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new TypeError(`validation result is invalid JSON: ${describeError(error)}`);
  }
  const result = validateResult(parsed);
  if (
    result.id !== expected.id ||
    result.taskId !== expected.taskId ||
    result.generation !== expected.generation ||
    result.head !== expected.head ||
    result.contract !== expected.contract ||
    result.policyDigest !== expected.policyDigest
  ) {
    throw new Error("validation result identity, contract, or HEAD does not match the job");
  }
  for (const evidence of result.evidence) {
    if (
      evidence.head !== expected.head ||
      evidence.contract !== expected.contract ||
      evidence.policyDigest !== expected.policyDigest
    ) {
      throw new Error("validation evidence is not bound to the expected contract identity");
    }
  }
  if (
    result.status === "completed" &&
    (result.evidence.length === 0 || result.evidence.some((entry) => entry.exitCode !== 0))
  ) {
    throw new Error("validation result marked completed without all passing evidence");
  }
  return result;
}
async function existingValidationResult(job: ValidationJob): Promise<ValidationResult | undefined> {
  try {
    return await readValidationResult(job.resultPath, {
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      head: job.head,
      contract: job.contract,
      policyDigest: job.policyDigest,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function runValidationJob(
  input: ValidationJob,
  options: ValidationWorkerOptions = {},
): Promise<ValidationResult> {
  const job = parseValidationJob(input);
  const now = options.now ?? (() => new Date().toISOString());
  const prior = await existingValidationResult(job);
  if (prior !== undefined) return prior;
  if (job.execution === undefined) {
    return resultFor(
      job,
      now,
      "failed",
      [failureEvidence(job, "execution refused: validation job has no execution admission", 125)],
      "execution refused: validation job has no execution admission",
    );
  }
  const gateInput: ExecutionGateInput = {
    execution: job.execution,
    jobId: job.id,
    taskId: job.taskId,
    generation: job.generation,
    command: "validation",
    cwd: job.repoPath,
    resultPath: job.resultPath,
    inputHead: job.head,
  };
  let admission: ExecutionAdmission;
  try {
    const gate = options.executionGate ?? claimExecutionStart;
    admission = await gate(gateInput);
  } catch (error) {
    const message = `execution refused: ${describeError(error)}`;
    return resultFor(job, now, "failed", [failureEvidence(job, message, 125)], message);
  }
  if (!admission.admitted) {
    const message = `execution refused: ${admission.reason ?? "validation execution was refused"}`;
    return resultFor(job, now, "failed", [failureEvidence(job, message, 125)], message);
  }
  const run = options.run ?? runCommand;
  const writeResult = options.writeResult ?? writeJsonAtomically;
  const statusReporter = terminalBackend(runCommand, {
    home: job.execution.home,
  }).agentStatusReporter({
    cwd: job.repoPath,
    agentLabel: `tandem-validation-${job.taskId.slice(0, 8)}`,
  });
  await statusReporter?.report("working");
  try {
    let result: ValidationResult;
    try {
      const evidence = await runValidation({
        repoPath: job.repoPath,
        contract: job.contract,
        identity: {
          head: job.head,
          generation: job.generation,
          policyDigest: job.policyDigest,
        },
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
      validated.head !== job.head ||
      validated.contract !== job.contract ||
      validated.policyDigest !== job.policyDigest
    ) {
      throw new Error("validation worker produced an identity mismatch");
    }
    await writeResult(job.resultPath, validated);
    await statusReporter?.report(
      validated.status === "completed" ? "idle" : "blocked",
      validated.error,
    );
    return validated;
  } catch (error) {
    await statusReporter?.report("blocked", describeError(error));
    throw error;
  } finally {
    await statusReporter?.release();
  }
}
async function readJobFile(path: string): Promise<ValidationJob> {
  const jobPath = absolute(path, "jobPath");
  const contents = await readFile(jobPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
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
    if (result.status === "failed" && result.error?.startsWith("execution refused:") === true) {
      process.stderr.write(`${result.error}\n`);
      return 1;
    }
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
