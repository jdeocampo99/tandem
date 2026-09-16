import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./commands.ts";
import {
  formatTaskMessages,
  MAX_TASK_MESSAGE_CHARS,
  readTaskInbox,
  readWorkerReceipt,
} from "./communication.ts";
import type { CommandRequest, CommandResult, CommandRunner, ReviewResult } from "./contracts.ts";
import {
  parseReviewResult,
  parseWorkerJob,
  parseWorkerResult,
  persistWorkerResult,
  type WorkerJob,
  type WorkerQuestion,
  type WorkerResult,
  type WorkerRole,
  type WorkerStatus,
} from "./jobs.ts";
import { WORKER_CONTROL_ENV } from "./worker-control.ts";

export type WorkerClock = () => string;

export type WorkerResultWriter = (resultPath: string, result: WorkerResult) => void | Promise<void>;

export type WorkerRunOptions = Readonly<{
  readonly run?: CommandRunner;
  readonly now?: WorkerClock;
  readonly signal?: AbortSignal;
  readonly writeResult?: WorkerResultWriter;
}>;

type JsonObject = Readonly<Record<string, unknown>>;

type ParsedOmpOutput = Readonly<{
  readonly text: string;
}>;

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

class WorkerOutputError extends Error {
  readonly outputText: string;

  constructor(message: string, outputText = "") {
    super(message);
    this.name = "WorkerOutputError";
    this.outputText = outputText;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ExpectedModel = Readonly<{
  readonly selector: string;
  readonly provider: string;
  readonly id: string;
}>;

type ModelObservation = Readonly<{
  readonly provider?: string;
  readonly model?: string;
}>;

function expectedModelParts(selector: string): ExpectedModel {
  const separator = selector.indexOf("/");
  return {
    selector,
    provider: selector.slice(0, separator),
    id: selector.slice(separator + 1),
  };
}

function modelObservation(value: unknown): ModelObservation | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  let provider: string | undefined =
    typeof value.provider === "string" ? value.provider : undefined;
  let model: string | undefined;
  if (typeof value.model === "string") {
    model = value.model;
  } else if (isJsonObject(value.model)) {
    if (provider === undefined && typeof value.model.provider === "string") {
      provider = value.model.provider;
    }
    if (typeof value.model.id === "string") {
      model = value.model.id;
    } else if (typeof value.model.name === "string") {
      model = value.model.name;
    } else if (typeof value.model.model === "string") {
      model = value.model.model;
    }
  }
  if (provider === undefined && model === undefined) {
    return undefined;
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

function modelMismatchReason(event: JsonObject, expected: ExpectedModel): string | undefined {
  const values: unknown[] = [event, event.message, event.metadata];
  if (Array.isArray(event.messages)) {
    values.push(...event.messages);
  }
  for (const value of values) {
    const observation = modelObservation(value);
    if (observation === undefined) {
      continue;
    }
    if (observation.provider !== undefined && observation.provider !== expected.provider) {
      return `OMP selected provider ${observation.provider}, expected ${expected.provider}`;
    }
    if (
      observation.model !== undefined &&
      observation.model !== expected.id &&
      observation.model !== expected.selector
    ) {
      return `OMP selected model ${observation.model}, expected ${expected.selector}`;
    }
  }
  return undefined;
}

function toolsForRole(role: WorkerRole): string {
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

function readEventFailure(event: JsonObject): string | undefined {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  if (type.includes("error") || type.includes("abort") || type.includes("cancel")) {
    return describeFailure(
      event.error ?? event.message,
      `OMP emitted ${type || "a failure event"}`,
    );
  }

  const status = typeof event.status === "string" ? event.status.toLowerCase() : "";
  if (status === "error" || status === "failed" || status === "aborted" || status === "cancelled") {
    return describeFailure(event.error ?? event.message, `OMP reported status ${status}`);
  }
  if (event.isError === true || event.aborted === true || event.cancelled === true) {
    return describeFailure(event.error ?? event.message, "OMP reported an unsuccessful turn");
  }
  if (event.error !== undefined && event.error !== null && event.error !== "") {
    return describeFailure(event.error, "OMP reported a provider error");
  }
  if (
    isJsonObject(event.message) &&
    event.message.error !== undefined &&
    event.message.error !== null &&
    event.message.error !== ""
  ) {
    return describeFailure(event.message.error, "OMP reported a provider error");
  }

  const stopReason = stopReasonFrom(event);
  if (stopReason === "error" || stopReason === "aborted" || stopReason === "cancelled") {
    return `OMP stopped with ${stopReason}`;
  }
  return undefined;
}

function describeFailure(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (isJsonObject(value) && typeof value.message === "string" && value.message.trim().length > 0) {
    return value.message.trim();
  }
  return fallback;
}

function stopReasonFrom(event: JsonObject): string | undefined {
  if (typeof event.stopReason === "string") {
    return event.stopReason.toLowerCase();
  }
  if (isJsonObject(event.message) && typeof event.message.stopReason === "string") {
    return event.message.stopReason.toLowerCase();
  }
  if (Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (isJsonObject(message) && typeof message.stopReason === "string") {
        return message.stopReason.toLowerCase();
      }
    }
  }
  return undefined;
}
function assistantMessageText(message: unknown): string | undefined {
  if (!isJsonObject(message) || message.role !== "assistant") {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (!isJsonObject(block)) {
      continue;
    }
    if (block.type === "text" || block.type === "output_text") {
      if (typeof block.text !== "string") {
        throw new WorkerOutputError("OMP assistant text block is malformed");
      }
      textBlocks.push(block.text);
    }
  }
  return textBlocks.length === 0 ? undefined : textBlocks.join("");
}

function finalAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const finalMessage = messages[messages.length - 1];
  return assistantMessageText(finalMessage);
}

function parseJsonLines(stdout: string): readonly JsonObject[] {
  if (typeof stdout !== "string") {
    throw new WorkerOutputError("OMP stdout is not text");
  }
  const events: JsonObject[] = [];
  const lines = stdout.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new WorkerOutputError(
        `OMP JSONL line ${index + 1} is malformed: ${error instanceof Error ? error.message : "parse failure"}`,
      );
    }
    if (!isJsonObject(parsed)) {
      throw new WorkerOutputError(`OMP JSONL line ${index + 1} must be an object`);
    }
    events.push(parsed);
  }
  if (events.length === 0) {
    throw new WorkerOutputError("OMP returned no JSON events");
  }
  return events;
}

function parseOmpOutput(stdout: string, expectedModel: ExpectedModel): ParsedOmpOutput {
  const events = parseJsonLines(stdout);
  let terminalText: string | undefined;
  let terminalSeen = false;
  let nonTerminalFailure: string | undefined;
  for (const event of events) {
    const terminalEvent = event.type === "agent_end" && event.willContinue !== true;
    const mismatch = modelMismatchReason(event, expectedModel);
    if (mismatch !== undefined) {
      throw new WorkerOutputError(mismatch);
    }
    const failure = readEventFailure(event);
    if (!terminalEvent) {
      if (failure !== undefined && nonTerminalFailure === undefined) {
        nonTerminalFailure = failure;
      }
      continue;
    }
    if (failure !== undefined) {
      throw new WorkerOutputError(failure);
    }
    const terminalCandidate = finalAssistantText(event.messages);
    terminalSeen = true;
    if (terminalCandidate === undefined || terminalCandidate.trim().length === 0) {
      throw new WorkerOutputError("OMP terminal agent_end has no final assistant text");
    }
    terminalText = terminalCandidate;
  }
  if (!terminalSeen) {
    if (nonTerminalFailure !== undefined) {
      throw new WorkerOutputError(nonTerminalFailure);
    }
    throw new WorkerOutputError("OMP output did not include a terminal agent_end event");
  }
  if (terminalText === undefined) {
    throw new WorkerOutputError("OMP terminal agent_end has no final assistant text");
  }
  return { text: terminalText };
}

function readCommandResult(value: unknown): CommandResult {
  if (!isJsonObject(value)) {
    throw new WorkerOutputError("command runner returned a malformed result");
  }
  if (typeof value.code !== "number" || !Number.isInteger(value.code)) {
    throw new WorkerOutputError("command runner result has an invalid exit code");
  }
  if (typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    throw new WorkerOutputError("command runner result has invalid output fields");
  }
  if (value.code !== 0) {
    throw new WorkerOutputError(`OMP exited with code ${value.code}`);
  }
  return { code: value.code, stdout: value.stdout, stderr: value.stderr };
}

function parseReviewWorkerText(job: WorkerJob, text: string): ReviewResult {
  if (job.review === undefined) {
    throw new WorkerOutputError("review worker job is missing review identity", text);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new WorkerOutputError(
      `review worker output is not strict JSON: ${error instanceof Error ? error.message : "parse failure"}`,
      text,
    );
  }
  let review: ReviewResult;
  try {
    review = parseReviewResult(value);
  } catch (error) {
    throw new WorkerOutputError(
      `review worker output does not match ReviewResult: ${error instanceof Error ? error.message : "invalid review"}`,
      text,
    );
  }
  if (
    review.head !== job.review.head ||
    review.lens !== job.review.lens ||
    review.generation !== job.generation
  ) {
    throw new WorkerOutputError(
      "review worker output identity does not match the worker job",
      text,
    );
  }
  return review;
}

type ReportedOutcome = Readonly<{
  readonly status: WorkerStatus;
  readonly error?: string;
}>;

function reportedOutcome(role: WorkerRole, text: string): ReportedOutcome {
  if (role !== "implementer") {
    return { status: "completed" };
  }
  const matches = [
    ...text.matchAll(/^\s*Outcome\s*:\s*(implemented|needs-decision|failed)\s*$/gim),
  ];
  if (matches.length !== 1) {
    return {
      status: "failed",
      error:
        "implementer output must include exactly one Outcome: implemented|needs-decision|failed line",
    };
  }
  const outcome = matches[0]?.[1]?.toLowerCase();
  if (outcome === "needs-decision") {
    return { status: "needs-decision" };
  }
  if (outcome === "failed") {
    return { status: "failed", error: "implementer reported a failed outcome" };
  }
  return { status: "completed" };
}

type ReportedQuestion = Readonly<{
  readonly question?: WorkerQuestion;
  readonly error?: string;
}>;

function reportedQuestion(role: WorkerRole, status: WorkerStatus, text: string): ReportedQuestion {
  if (role !== "implementer" || status !== "needs-decision") return {};
  const questionMatches = [...text.matchAll(/^\s*Question\s*:\s*([^\r\n]+?)\s*$/gim)];
  if (questionMatches.length !== 1) {
    return {
      error: "needs-decision implementer output must include exactly one Question: <text> line",
    };
  }
  const questionText = questionMatches[0]?.[1]?.trim();
  if (questionText === undefined || questionText.length === 0) {
    return { error: "needs-decision Question: line must contain text" };
  }
  if (questionText.length > MAX_TASK_MESSAGE_CHARS) {
    return {
      error: `needs-decision question exceeds the ${MAX_TASK_MESSAGE_CHARS}-character limit`,
    };
  }

  const recommendationMatches = [...text.matchAll(/^\s*Recommendation\s*:\s*([^\r\n]+?)\s*$/gim)];
  if (recommendationMatches.length > 1) {
    return {
      error: "needs-decision implementer output may include at most one Recommendation: line",
    };
  }
  const recommendation = recommendationMatches[0]?.[1]?.trim();
  if (recommendation !== undefined && recommendation.length > MAX_TASK_MESSAGE_CHARS) {
    return {
      error: `needs-decision recommendation exceeds the ${MAX_TASK_MESSAGE_CHARS}-character limit`,
    };
  }
  return {
    question: {
      text: questionText,
      ...(recommendation === undefined || recommendation.length === 0 ? {} : { recommendation }),
    },
  };
}

type ReportedArtifact = Readonly<{
  readonly artifactPath?: string;
  readonly error?: string;
}>;

function artifactPathFromText(role: WorkerRole, text: string): ReportedArtifact {
  if (role !== "presentation") {
    return {};
  }
  const matches = [...text.matchAll(/^\s*Artifact\s*:\s*(\/[^\r\n]+?)\s*$/gim)];
  const capturedPath = matches[0]?.[1];
  if (matches.length !== 1 || capturedPath === undefined) {
    return {
      error: "presentation output must include exactly one Artifact: <absolute path> line",
    };
  }
  const candidate = capturedPath.replace(/[.,;:)\]}]+$/u, "");
  if (!isAbsolute(candidate)) {
    return { error: "presentation Artifact path must be absolute" };
  }
  return { artifactPath: candidate };
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
