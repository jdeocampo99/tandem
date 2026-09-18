import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { readWorkerReceipt } from "../tasks/communication-persistence.ts";
import {
  parseWorkerJob,
  parseWorkerResult,
  persistWorkerResult,
  type WorkerJob,
  type WorkerQuestion,
  type WorkerResult,
  type WorkerRole,
  type WorkerStatus,
} from "./jobs.ts";
import {
  artifactPathFromText,
  expectedModelParts,
  nativeAgentEndWillContinue,
  parseNativeAgentEnd,
  parseReviewWorkerText,
  readNativeEventFailure,
  reportedOutcome,
  reportedQuestion,
  WorkerOutputError,
} from "./protocol.ts";
import {
  readWorkerTerminalCommand,
  WORKER_JOB_PATH_ENV,
  type WorkerTerminalCommand,
  type WorkerTerminalJob,
  type WorkerTerminalState,
  writeWorkerTerminal,
} from "./terminal.ts";

const TERMINAL_HEARTBEAT_MS = 1_000;
const TERMINAL_POLL_MS = 250;
const READ_ONLY_TOOLS: Readonly<Record<string, true>> = {
  read: true,
  grep: true,
  glob: true,
  web_search: true,
};
function now(): string {
  return new Date().toISOString();
}

async function readJob(path: string): Promise<WorkerJob> {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  return parseWorkerJob(value);
}

type NativeWorkerIdentity = WorkerTerminalJob & Readonly<{ role: WorkerRole }>;

function workerIdentity(job: WorkerJob, jobPath: string): NativeWorkerIdentity {
  return {
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    cwd: job.cwd,
    jobPath,
  };
}

function resultFor(
  job: WorkerJob,
  status: WorkerStatus,
  text: string,
  extras: Readonly<{
    readonly review?: WorkerResult["review"];
    readonly artifactPath?: string;
    readonly error?: string;
    readonly instructionRevision?: number;
    readonly question?: WorkerQuestion;
  }> = {},
): WorkerResult {
  return parseWorkerResult({
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    status,
    text,
    ...extras,
    finishedAt: now(),
  });
}

function failureFor(job: WorkerJob, error: unknown, text = ""): WorkerResult {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : typeof error === "string" && error.trim().length > 0
        ? error.trim()
        : "worker execution failed";
  return resultFor(job, "failed", text, { error: message });
}

async function instructionRevision(job: WorkerJob, required: boolean): Promise<number | undefined> {
  if (job.communication === undefined) return undefined;
  try {
    const receipt = await readWorkerReceipt(job.communication.receiptPath, {
      jobId: job.id,
      taskId: job.taskId,
      generation: job.generation,
    });
    if (receipt === undefined || receipt.phase === "starting") {
      throw new WorkerOutputError("worker communication receipt has no lifecycle proof");
    }
    if (receipt.appliedRevision < job.communication.initialRevision) {
      throw new WorkerOutputError(
        `worker communication receipt applied revision ${receipt.appliedRevision} is older than ${job.communication.initialRevision}`,
      );
    }
    return receipt.appliedRevision;
  } catch (error) {
    if (required) throw error;
    return undefined;
  }
}

function terminalState(
  identity: NativeWorkerIdentity,
  phase: WorkerTerminalState["phase"],
  completed: boolean,
  commandId?: string,
): WorkerTerminalState {
  return {
    schemaVersion: 1,
    jobId: identity.id,
    taskId: identity.taskId,
    generation: identity.generation,
    role: identity.role,
    cwd: identity.cwd,
    pid: process.pid,
    phase,
    completed,
    heartbeatAt: now(),
    ...(commandId === undefined ? {} : { commandId }),
  };
}

export async function registerWorkerTerminalExtension(pi: ExtensionAPI): Promise<void> {
  const jobPath = process.env[WORKER_JOB_PATH_ENV];
  if (jobPath === undefined || jobPath.trim().length === 0) return;
  const job = await readJob(jobPath);
  const identity = workerIdentity(job, jobPath);
  await writeWorkerTerminal(jobPath, terminalState(identity, "starting", false));

  let closed = false;
  let resultPublished = false;
  let delegatedSettled = false;
  let timeoutRequested = false;
  let pauseCommand: WorkerTerminalCommand | undefined;
  let closingCommand: WorkerTerminalCommand | undefined;
  let writeQueue = Promise.resolve();
  let currentState: WorkerTerminalState = terminalState(identity, "starting", false);
  let timeoutTimer: Timer | undefined;

  const persistState = async (
    phase: WorkerTerminalState["phase"],
    completed = currentState.completed,
    commandId = currentState.commandId,
  ): Promise<void> => {
    if (closed && phase !== "closed") return;
    const next = terminalState(identity, phase, completed, commandId);
    currentState = next;
    const write = writeQueue.then(() => writeWorkerTerminal(jobPath, next));
    writeQueue = write.catch(() => undefined);
    await write;
  };
  const persistResult = async (result: WorkerResult): Promise<void> => {
    try {
      await persistWorkerResult(job.resultPath, result);
    } finally {
      await persistState(pauseCommand === undefined ? "idle" : "paused", true, pauseCommand?.id);
    }
  };
  const publish = async (event: unknown, ctx: ExtensionContext): Promise<void> => {
    if (resultPublished || nativeAgentEndWillContinue(event)) return;
    if (pauseCommand !== undefined) {
      await persistState("paused", currentState.completed, pauseCommand.id);
      return;
    }
    if (timeoutRequested) {
      resultPublished = true;
      delegatedSettled = true;
      const result = failureFor(job, `worker timed out after ${job.timeoutMs}ms`);
      await persistResult(result);
      return;
    }
    resultPublished = true;
    delegatedSettled = true;
    if (timeoutTimer !== undefined) {
      ctx.clearTimer(timeoutTimer);
      timeoutTimer = undefined;
    }
    let result: WorkerResult;
    try {
      const failure = readNativeEventFailure(event);
      if (failure !== undefined) throw new WorkerOutputError(failure);
      const parsed = parseNativeAgentEnd(event, expectedModelParts(job.model.model), ctx.model);
      if (job.role === "reviewer" || job.role === "verifier") {
        const review = parseReviewWorkerText(job, parsed.text);
        const revision = await instructionRevision(job, true);
        result = resultFor(job, "completed", parsed.text, {
          review,
          ...(revision === undefined ? {} : { instructionRevision: revision }),
        });
      } else {
        const outcome = reportedOutcome(job.role, parsed.text);
        const question = reportedQuestion(job.role, outcome.status, parsed.text);
        const artifact = artifactPathFromText(job.role, parsed.text);
        const error = outcome.error ?? question.error ?? artifact.error;
        const status = error === undefined ? outcome.status : "failed";
        const extras =
          error === undefined
            ? question.question === undefined
              ? {}
              : { question: question.question }
            : { error };
        const revision = await instructionRevision(job, status !== "failed");
        result = resultFor(job, status, parsed.text, {
          ...(artifact.artifactPath === undefined ? {} : { artifactPath: artifact.artifactPath }),
          ...extras,
          ...(revision === undefined ? {} : { instructionRevision: revision }),
        });
      }
    } catch (error) {
      const text = error instanceof WorkerOutputError ? error.outputText : "";
      result = failureFor(job, error, text);
    }
    await persistResult(result);
  };

  const timeout = async (ctx: ExtensionContext): Promise<void> => {
    if (delegatedSettled || resultPublished || timeoutRequested) return;
    timeoutRequested = true;
    const wasIdle = ctx.isIdle();
    ctx.abort();
    if (!wasIdle) return;
    resultPublished = true;
    delegatedSettled = true;
    const result = failureFor(job, `worker timed out after ${job.timeoutMs}ms`);
    await persistResult(result);
  };

  const finishPause = async (): Promise<void> => {
    if (pauseCommand === undefined || closed) return;
    await persistState("paused", currentState.completed, pauseCommand.id);
  };

  const pollControl = async (ctx: ExtensionContext): Promise<void> => {
    if (closed) return;
    if (closingCommand !== undefined && Date.parse(closingCommand.expiresAt) <= Date.now()) {
      closingCommand = undefined;
      await persistState(pauseCommand === undefined ? "idle" : "paused", currentState.completed);
    }
    const command = await readWorkerTerminalCommand(jobPath, identity);
    if (command === undefined) return;
    if (command.id === currentState.commandId || command.id === pauseCommand?.id) return;
    if (command.action === "pause") {
      pauseCommand = command;
      if (timeoutTimer !== undefined) {
        ctx.clearTimer(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (!ctx.isIdle()) ctx.abort();
      else await finishPause();
      return;
    }
    if (currentState.phase !== "paused" && !currentState.completed) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText().trim().length > 0)
      return;
    const confirmed = await readWorkerTerminalCommand(jobPath, identity);
    if (confirmed?.id !== command.id || confirmed.action !== "close") return;
    if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText().trim().length > 0)
      return;
    closingCommand = confirmed;
    await persistState("closing", true, confirmed.id);
  };

  const guardTool = (toolName: string): { block: true; reason: string } | undefined => {
    if (
      !delegatedSettled &&
      !timeoutRequested &&
      pauseCommand === undefined &&
      currentState.phase !== "paused" &&
      !currentState.completed
    ) {
      return undefined;
    }
    if (READ_ONLY_TOOLS[toolName] === true) return undefined;
    return {
      block: true,
      reason: "worker terminal is paused or completed; mutating tools are disabled",
    };
  };

  pi.on("tool_call", (event) => guardTool(event.toolName));

  pi.on("session_start", async (_event, ctx) => {
    // Freeze an empty editor before the controller sends the native exit key.
    // ctx.shutdown() alone does not wake OMP's idle interactive input loop.
    ctx.ui.onTerminalInput((data) =>
      closingCommand !== undefined && !matchesKey(data, "ctrl+d") ? { consume: true } : undefined,
    );
    await persistState("busy", false);
    ctx.setInterval(() => {
      void pollControl(ctx).catch(() => ctx.abort());
    }, TERMINAL_POLL_MS);
    ctx.setInterval(() => {
      void persistState(currentState.phase, currentState.completed).catch(() => ctx.abort());
    }, TERMINAL_HEARTBEAT_MS);
    if (job.timeoutMs !== undefined) {
      timeoutTimer = ctx.setTimeout(() => {
        void timeout(ctx).catch(() => ctx.abort());
      }, job.timeoutMs);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    void persistState("busy", currentState.completed).catch(() => ctx.abort());
  });
  pi.on("turn_start", (_event, ctx) => {
    void persistState("busy", currentState.completed).catch(() => ctx.abort());
  });
  pi.on("tool_execution_start", (_event, ctx) => {
    void persistState("busy", currentState.completed).catch(() => ctx.abort());
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    void persistState("busy", currentState.completed).catch(() => ctx.abort());
  });
  pi.on("turn_end", (_event, ctx) => {
    void persistState("idle", currentState.completed).catch(() => ctx.abort());
  });
  pi.on("agent_end", async (event, ctx) => {
    if (event.willContinue === true) {
      await persistState("busy", currentState.completed);
      return;
    }
    if (resultPublished) {
      await persistState(pauseCommand === undefined ? "idle" : "paused", true, pauseCommand?.id);
      return;
    }
    await publish(event, ctx);
    if (!resultPublished && pauseCommand === undefined) await persistState("idle", false);
  });
  pi.on("session_shutdown", async () => {
    closed = true;
    if (timeoutTimer !== undefined) timeoutTimer = undefined;
    await persistState("closed", currentState.completed, closingCommand?.id);
  });
}
