import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "./adapters/commands.ts";
import { environmentForContext } from "./config/environment.ts";
import type { LaunchIo } from "./harness/contract.ts";
import { launchIo } from "./harness/launch-io.ts";
import { harnessFor } from "./harness/resolve.ts";
import {
  defaultRunInteractive,
  defaultSleep,
  type RunInteractive,
} from "./terminal/cli-process.ts";
import { runWorkerAgent } from "./workers/agent.ts";
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

export type WorkerClock = () => string;
export type WorkerResultWriter = (resultPath: string, result: WorkerResult) => void | Promise<void>;
export type WorkerRunOptions = Readonly<{
  readonly run?: RunInteractive;
  readonly now?: WorkerClock;
  readonly writeResult?: WorkerResultWriter;
  readonly executionGate?: (
    input: ExecutionGateInput,
  ) => ExecutionAdmission | PromiseLike<ExecutionAdmission>;
  /** The effects the harness's conversation choice and ready wait use. */
  readonly launchIo?: LaunchIo;
  /** The Tandem home, where a Claude Code worker's sidecar listens. */
  readonly home?: string;
}>;

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "worker execution failed";
}

function failureResult(job: WorkerJob, error: unknown, now: WorkerClock): WorkerResult {
  return parseWorkerResult({
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    status: "failed",
    text: "",
    error: failureMessage(error),
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

async function executionRefusal(
  job: WorkerJob,
  gate: NonNullable<WorkerRunOptions["executionGate"]>,
): Promise<string | undefined> {
  if (job.execution === undefined) {
    return "execution refused: worker job has no execution admission";
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
    admission = await gate(gateInput);
  } catch (error) {
    return `execution refused: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!admission.admitted) {
    return `execution refused: ${admission.reason ?? "worker execution was refused"}`;
  }

  return undefined;
}

async function finishWorkerJob(
  job: WorkerJob,
  error: unknown,
  effects: Readonly<{ now: WorkerClock; writeResult: WorkerResultWriter }>,
): Promise<WorkerResult> {
  const completed = await existingResult(job);
  if (completed !== undefined) return completed;
  const result = failureResult(job, error, effects.now);
  await effects.writeResult(job.resultPath, result);
  return result;
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
  const refusal = await executionRefusal(job, options.executionGate ?? claimExecutionStart);
  if (refusal !== undefined) return failureResult(job, refusal, now);

  const writeResult = options.writeResult ?? persistWorkerResult;
  const run = options.run ?? defaultRunInteractive;
  const harness = harnessFor(job.harness);
  let childExit: number;
  try {
    childExit = await runWorkerAgent(
      { job, jobPath: absoluteJobPath, harness },
      {
        run,
        runCommand,
        launchContext: () => ({
          io: options.launchIo ?? launchIo({ sleep: defaultSleep }),
          home:
            options.home ?? environmentForContext({}, { cwd: job.cwd, sessionId: "tandem" }).home,
        }),
      },
    );
  } catch (error) {
    return finishWorkerJob(job, error, { now, writeResult });
  }

  return finishWorkerJob(
    job,
    childExit === 0
      ? `${harness.displayName} exited without persisting a worker result`
      : `${harness.displayName} exited with code ${childExit}`,
    { now, writeResult },
  );
}

async function readJobFile(jobPath: string): Promise<WorkerJob> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(jobPath, "utf8"));
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
  if (result.status === "failed" && result.error?.startsWith("execution refused:")) {
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
