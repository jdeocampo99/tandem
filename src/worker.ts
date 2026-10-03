import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommandRequest } from "./contracts.ts";
import type { AgentKind, Harness } from "./harness/contract.ts";
import { harnessFor } from "./harness/resolve.ts";
import { readTaskInbox } from "./tasks/communication-persistence.ts";
import { formatTaskMessages } from "./tasks/communication-protocol.ts";
import { defaultRunInteractive, type RunInteractive } from "./terminal/cli-process.ts";
import { WORKER_CONTROL_ENV } from "./workers/control-protocol.ts";
import {
  claimExecutionStart,
  type ExecutionAdmission,
  type ExecutionGateInput,
} from "./workers/execution-gate.ts";
import {
  parseWorkerJob,
  parseWorkerResult,
  persistWorkerResult,
  readWorkerResult,
  type WorkerJob,
  type WorkerResult,
} from "./workers/jobs.ts";
import { WORKER_JOB_PATH_ENV } from "./workers/terminal.ts";

export type WorkerClock = () => string;
export type WorkerResultWriter = (resultPath: string, result: WorkerResult) => void | Promise<void>;
export type WorkerRunOptions = Readonly<{
  readonly run?: RunInteractive;
  readonly now?: WorkerClock;
  readonly writeResult?: WorkerResultWriter;
  readonly executionGate?: (
    input: ExecutionGateInput,
  ) => ExecutionAdmission | PromiseLike<ExecutionAdmission>;
}>;

async function promptWithInitialCommunication(job: WorkerJob): Promise<string> {
  if (job.communication === undefined) return job.prompt;
  const inbox = await readTaskInbox(job.communication.inboxPath);
  if (inbox === undefined) {
    if (job.communication.initialRevision > 0) {
      throw new Error("configured task communication inbox is missing");
    }
    return job.prompt;
  }
  if (inbox.taskId !== job.taskId) {
    throw new Error("configured task communication inbox belongs to a different task");
  }
  if (inbox.revision < job.communication.initialRevision) {
    throw new Error("configured task communication inbox is older than the worker snapshot");
  }
  if (inbox.revision === 0 || inbox.messages.length === 0) return job.prompt;
  const marker = formatTaskMessages(job.taskId, inbox.revision, inbox.messages);
  return job.prompt.includes(marker) ? job.prompt : `${job.prompt}\n\n${marker}`;
}

function agentForJob(job: WorkerJob): AgentKind {
  return job.prReview === undefined ? job.role : "pr-reviewer";
}

function workerEnvironment(job: WorkerJob, jobPath: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { [WORKER_JOB_PATH_ENV]: jobPath };
  if (job.communication !== undefined) {
    environment[WORKER_CONTROL_ENV] = JSON.stringify({
      schemaVersion: 1,
      jobId: job.id,
      taskId: job.taskId,
      generation: job.generation,
      inboxPath: job.communication.inboxPath,
      receiptPath: job.communication.receiptPath,
      initialRevision: job.communication.initialRevision,
    });
  }
  return environment;
}

function buildWorkerCommand(
  harness: Harness,
  job: WorkerJob,
  prompt: string,
  jobPath: string,
): CommandRequest {
  const environment = workerEnvironment(job, jobPath);
  return {
    argv: harness.command({
      agent: agentForJob(job),
      cwd: job.cwd,
      model: job.model,
      conversation:
        job.sessionDirectory === undefined
          ? { kind: "none" }
          : { kind: "saved", directory: job.sessionDirectory, resume: true },
      prompt,
    }),
    cwd: job.cwd,
    env: environment,
  };
}

function failureResult(job: WorkerJob, error: unknown, now: WorkerClock): WorkerResult {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : typeof error === "string" && error.trim().length > 0
        ? error.trim()
        : "worker execution failed";
  return parseWorkerResult({
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    status: "failed",
    text: "",
    error: message,
    finishedAt: now(),
  });
}

async function existingResult(job: WorkerJob): Promise<WorkerResult | undefined> {
  try {
    return await readWorkerResult(job.resultPath, {
      id: job.id,
      taskId: job.taskId,
      generation: job.generation,
      role: job.role,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Prepares the worktree (e.g. installs dependencies) in the worker's own pane so the output is
 * visible and the coordinator never blocks on it. Reruns on every launch; installers are idempotent.
 */
async function runSetup(job: WorkerJob, run: RunInteractive): Promise<void> {
  for (const command of job.setup ?? []) {
    const exit = await run({ argv: command.argv, cwd: job.cwd, timeoutMs: command.timeoutMs });
    if (exit !== 0) {
      throw new Error(
        `worktree setup command ${JSON.stringify(command.name)} (${command.argv.join(" ")}) exited with code ${exit}`,
      );
    }
  }
}

export async function runWorkerJob(
  jobPath: string,
  options: WorkerRunOptions = {},
): Promise<WorkerResult> {
  const absoluteJobPath = resolve(jobPath);
  const job = await readJobFile(absoluteJobPath);
  const now = options.now ?? (() => new Date().toISOString());
  const prior = await existingResult(job);
  if (prior !== undefined) return prior;
  if (job.execution === undefined) {
    return failureResult(job, "execution refused: worker job has no execution admission", now);
  }
  const gateInput: ExecutionGateInput = {
    execution: job.execution,
    jobId: job.id,
    taskId: job.taskId,
    generation: job.generation,
    command: "worker",
    cwd: job.cwd,
    resultPath: job.resultPath,
    resolvedModel: job.model,
    ...(job.review === undefined ? {} : { inputHead: job.review.head }),
  };
  let admission: ExecutionAdmission;
  try {
    const gate = options.executionGate ?? claimExecutionStart;
    admission = await gate(gateInput);
  } catch (error) {
    return failureResult(
      job,
      `execution refused: ${error instanceof Error ? error.message : String(error)}`,
      now,
    );
  }
  if (!admission.admitted) {
    return failureResult(
      job,
      `execution refused: ${admission.reason ?? "worker execution was refused"}`,
      now,
    );
  }

  const writeResult = options.writeResult ?? persistWorkerResult;
  const run = options.run ?? defaultRunInteractive;
  let childExit: number;
  try {
    const harness = harnessFor(job.harness);
    await runSetup(job, run);
    const prompt = await promptWithInitialCommunication(job);
    childExit = await run(buildWorkerCommand(harness, job, prompt, absoluteJobPath));
  } catch (error) {
    const completed = await existingResult(job);
    if (completed !== undefined) return completed;
    const result = failureResult(job, error, now);
    await writeResult(job.resultPath, result);
    return result;
  }

  const completed = await existingResult(job);
  if (completed !== undefined) return completed;
  const result = failureResult(
    job,
    childExit === 0
      ? "OMP exited without persisting a worker result"
      : `OMP exited with code ${childExit}`,
    now,
  );
  await writeResult(job.resultPath, result);
  return result;
}

async function readJobFile(jobPath: string): Promise<WorkerJob> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(jobPath, "utf8")) as unknown;
  } catch (error) {
    throw new TypeError(
      `worker job file is not valid JSON: ${error instanceof Error ? error.message : "parse failure"}`,
    );
  }
  return parseWorkerJob(parsed);
}

async function runCli(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1 || argv[0] === undefined || argv[0].trim().length === 0) {
    throw new TypeError("usage: bun src/worker.ts JOB_JSON_PATH");
  }
  const result = await runWorkerJob(argv[0]);
  if (result.status === "failed" && result.error?.startsWith("execution refused:") === true) {
    process.stderr.write(`${result.error}\n`);
  }
  return result.status === "failed" ? 1 : 0;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "worker failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
