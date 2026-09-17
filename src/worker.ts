import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runCommand } from "./adapters/commands.ts";
import type { CommandRequest, CommandRunner, ReviewResult } from "./contracts.ts";
import { readTaskInbox, readWorkerReceipt } from "./tasks/communication-persistence.ts";
import { formatTaskMessages } from "./tasks/communication-protocol.ts";
import { WORKER_CONTROL_ENV } from "./worker-control.ts";
import {
  parseWorkerJob,
  parseWorkerResult,
  persistWorkerResult,
  type WorkerJob,
  type WorkerQuestion,
  type WorkerResult,
  type WorkerRole,
  type WorkerStatus,
} from "./workers/jobs.ts";
import {
  artifactPathFromText,
  expectedModelParts,
  parseOmpOutput,
  parseReviewWorkerText,
  readCommandResult,
  reportedOutcome,
  reportedQuestion,
  WorkerOutputError,
} from "./workers/protocol.ts";

export type WorkerClock = () => string;

export type WorkerResultWriter = (resultPath: string, result: WorkerResult) => void | Promise<void>;

export type WorkerRunOptions = Readonly<{
  readonly run?: CommandRunner;
  readonly now?: WorkerClock;
  readonly signal?: AbortSignal;
  readonly writeResult?: WorkerResultWriter;
}>;

const SCOUT_TOOLS = ["read", "grep", "glob", "web_search"] as const;
const READ_ONLY_TOOLS = ["read", "grep", "glob"] as const;
const IMPLEMENTER_TOOLS = ["read", "grep", "glob", "edit", "write", "bash"] as const;
const PRESENTATION_TOOLS = ["read", "grep", "glob", "write", "edit"] as const;

const WORKER_CONFIG_PATH = fileURLToPath(new URL("./worker-config.yml", import.meta.url));
const WORKER_CONTROL_PATH = fileURLToPath(new URL("./worker-control.ts", import.meta.url));

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
  if (job.prompt.includes(marker)) return job.prompt;
  return `${job.prompt}\n\n${marker}`;
}

function workerControlEnvironment(job: WorkerJob): Readonly<Record<string, string>> | undefined {
  if (job.communication === undefined) return undefined;
  return {
    [WORKER_CONTROL_ENV]: JSON.stringify({
      schemaVersion: 1,
      jobId: job.id,
      taskId: job.taskId,
      generation: job.generation,
      inboxPath: job.communication.inboxPath,
      receiptPath: job.communication.receiptPath,
      initialRevision: job.communication.initialRevision,
    }),
  };
}

function toolsForRole(role: WorkerRole): string {
  if (role === "scout") {
    return SCOUT_TOOLS.join(",");
  }
  if (role === "implementer") {
    return IMPLEMENTER_TOOLS.join(",");
  }
  if (role === "presentation") {
    return PRESENTATION_TOOLS.join(",");
  }
  return READ_ONLY_TOOLS.join(",");
}

function maxTimeSeconds(timeoutMs: number): string {
  return String(Math.max(1, Math.ceil(timeoutMs / 1000)));
}

function buildWorkerCommand(job: WorkerJob, prompt: string, signal?: AbortSignal): CommandRequest {
  const communicationArgs = job.communication === undefined ? [] : ["-e", WORKER_CONTROL_PATH];
  const timeoutArgs =
    job.timeoutMs === undefined ? [] : ["--max-time", maxTimeSeconds(job.timeoutMs)];
  const environment = workerControlEnvironment(job);
  return {
    argv: [
      "omp",
      "-p",
      "--model",
      job.model.model,
      "--thinking",
      job.model.thinking,
      "--no-prewalk",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-title",
      ...communicationArgs,
      ...(job.sessionDirectory === undefined
        ? ["--no-session"]
        : ["--session-dir", job.sessionDirectory, "--continue"]),
      "--config",
      WORKER_CONFIG_PATH,
      "--mode",
      "json",
      "--cwd",
      job.cwd,
      "--tools",
      toolsForRole(job.role),
      ...timeoutArgs,
      prompt,
    ],
    cwd: job.cwd,
    ...(environment === undefined ? {} : { env: environment }),
    ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

async function verifiedInstructionRevision(job: WorkerJob): Promise<number | undefined> {
  if (job.communication === undefined) return undefined;
  const receipt = await readWorkerReceipt(job.communication.receiptPath, {
    jobId: job.id,
    taskId: job.taskId,
    generation: job.generation,
  });
  if (receipt === undefined) {
    throw new WorkerOutputError("worker communication receipt is missing");
  }
  if (receipt.phase === "starting") {
    throw new WorkerOutputError("worker communication receipt has no lifecycle proof");
  }
  if (receipt.appliedRevision < job.communication.initialRevision) {
    throw new WorkerOutputError(
      `worker communication receipt applied revision ${receipt.appliedRevision} is older than ${job.communication.initialRevision}`,
    );
  }
  return receipt.appliedRevision;
}

async function optionalInstructionRevision(job: WorkerJob): Promise<number | undefined> {
  try {
    return await verifiedInstructionRevision(job);
  } catch {
    return undefined;
  }
}

function finishResult(
  job: WorkerJob,
  status: WorkerStatus,
  text: string,
  now: WorkerClock,
  extras: Readonly<{
    readonly review?: ReviewResult;
    readonly artifactPath?: string;
    readonly error?: string;
    readonly instructionRevision?: number;
    readonly question?: WorkerQuestion;
  }> = {},
): WorkerResult {
  const result = {
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    status,
    text,
    ...extras,
    finishedAt: now(),
  };
  return parseWorkerResult(result);
}

function failureResult(
  job: WorkerJob,
  error: unknown,
  now: WorkerClock,
  outputText = "",
): WorkerResult {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : typeof error === "string" && error.trim().length > 0
        ? error.trim()
        : "worker execution failed";
  return finishResult(job, "failed", outputText, now, { error: message });
}

export async function runWorkerJob(
  jobInput: WorkerJob,
  options: WorkerRunOptions = {},
): Promise<WorkerResult> {
  const job = parseWorkerJob(jobInput);
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => new Date().toISOString());
  const writeResult = options.writeResult ?? persistWorkerResult;

  let result: WorkerResult;
  try {
    const prompt = await promptWithInitialCommunication(job);
    const commandResult = readCommandResult(
      await run(buildWorkerCommand(job, prompt, options.signal)),
    );
    const output = parseOmpOutput(commandResult.stdout, expectedModelParts(job.model.model));
    if (job.role === "reviewer" || job.role === "verifier") {
      const review = parseReviewWorkerText(job, output.text);
      const instructionRevision = await verifiedInstructionRevision(job);
      result = finishResult(job, "completed", output.text, now, {
        review,
        ...(instructionRevision === undefined ? {} : { instructionRevision }),
      });
    } else {
      const outcome = reportedOutcome(job.role, output.text);
      const question = reportedQuestion(job.role, outcome.status, output.text);
      const artifact = artifactPathFromText(job.role, output.text);
      const error = outcome.error ?? question.error ?? artifact.error;
      const status = error === undefined ? outcome.status : "failed";
      const outcomeExtras: Readonly<{
        readonly error?: string;
        readonly question?: WorkerQuestion;
      }> =
        error === undefined
          ? question.question === undefined
            ? {}
            : { question: question.question }
          : { error };
      const instructionRevision =
        status === "failed"
          ? await optionalInstructionRevision(job)
          : await verifiedInstructionRevision(job);
      result = finishResult(job, status, output.text, now, {
        ...(artifact.artifactPath === undefined ? {} : { artifactPath: artifact.artifactPath }),
        ...outcomeExtras,
        ...(instructionRevision === undefined ? {} : { instructionRevision }),
      });
    }
  } catch (error) {
    const outputText = error instanceof WorkerOutputError ? error.outputText : "";
    result = failureResult(job, error, now, outputText);
  }

  await writeResult(job.resultPath, result);
  return result;
}

async function readJobFile(jobPath: string): Promise<WorkerJob> {
  const contents = await readFile(jobPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
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

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const job = await readJobFile(argv[0]);
    const result = await runWorkerJob(job, { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "failed" ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
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
