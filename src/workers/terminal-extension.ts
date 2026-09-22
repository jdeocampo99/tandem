import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { runCommand } from "../adapters/commands.ts";
import { createHerdrStatusReporter, type HerdrAgentState } from "../adapters/herdr-status.ts";
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

function describeExtensionError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
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

export type AbortWithReasonState = Readonly<{
  readonly resultPublished: boolean;
  readonly delegatedSettled: boolean;
}>;

export type AbortWithReasonPlan = Readonly<{
  /** Whether this call is the one that should persist a durable failure result before aborting. */
  readonly shouldPersistResult: boolean;
  /** The failure result to persist; present exactly when `shouldPersistResult` is true. */
  readonly result?: WorkerResult;
}>;

/**
 * The pure decision behind aborting on a heartbeat/control-poll write failure: persist a durable
 * failure result carrying the real reason exactly once, before the pane aborts, so a later recovery
 * notice can say what actually happened instead of a bare "aborted" with no cause. A result already
 * published or a delegated agent-end already settled means the extension must not publish a second,
 * conflicting result. Extracted as a pure function so this decision is testable without a full OMP
 * extension-context harness.
 */
export function planAbortWithReason(
  job: WorkerJob,
  state: AbortWithReasonState,
  reason: string,
): AbortWithReasonPlan {
  if (state.resultPublished || state.delegatedSettled) return { shouldPersistResult: false };
  return { shouldPersistResult: true, result: failureFor(job, reason) };
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
  const statusReporter = createHerdrStatusReporter(runCommand, {
    cwd: job.cwd,
    agentLabel: `tandem-${job.role}-${job.taskId.slice(0, 8)}`,
  });
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
  let agentActive = false;
  let settledStatus: HerdrAgentState = "idle";
  let statusMessage: string | undefined;
  const waitingInputs = new Set<string>();
  const reportStatus = (): Promise<void> | undefined => {
    if (pauseCommand !== undefined) return statusReporter?.report("blocked", "Worker paused");
    if (waitingInputs.size > 0) return statusReporter?.report("blocked", "Waiting for your answer");
    return statusReporter?.report(
      agentActive ? "working" : settledStatus,
      agentActive ? undefined : statusMessage,
    );
  };
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
    agentActive = false;
    settledStatus = result.status === "completed" ? "idle" : "blocked";
    statusMessage = result.error ?? result.question?.text;
    try {
      await persistWorkerResult(job.resultPath, result);
    } catch (error) {
      settledStatus = "blocked";
      statusMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      try {
        await persistState(pauseCommand === undefined ? "idle" : "paused", true, pauseCommand?.id);
      } finally {
        await reportStatus();
      }
    }
  };
  const publish = async (event: unknown, ctx: ExtensionContext): Promise<void> => {
    if (resultPublished || nativeAgentEndWillContinue(event)) return;
    if (pauseCommand !== undefined) {
      await persistState("paused", currentState.completed, pauseCommand.id);
      await reportStatus();
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
      const outcome = reportedOutcome(job.role, parsed.text);
      const question = reportedQuestion(job.role, outcome.status, parsed.text);
      if (job.role === "reviewer" || job.role === "verifier") {
        if (outcome.status === "needs-decision" || outcome.error !== undefined) {
          const error = outcome.error ?? question.error;
          const status = error === undefined ? "needs-decision" : "failed";
          const revision = await instructionRevision(job, status !== "failed");
          result = resultFor(job, status, parsed.text, {
            ...(question.question === undefined ? {} : { question: question.question }),
            ...(error === undefined ? {} : { error }),
            ...(revision === undefined ? {} : { instructionRevision: revision }),
          });
        } else {
          const review = parseReviewWorkerText(job, parsed.text);
          const revision = await instructionRevision(job, true);
          result = resultFor(job, "completed", parsed.text, {
            review,
            ...(revision === undefined ? {} : { instructionRevision: revision }),
          });
        }
      } else {
        const artifact =
          outcome.status === "completed" ? artifactPathFromText(job.role, parsed.text) : {};
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

  /**
   * Applies `planAbortWithReason`'s decision and then aborts. Best-effort: if the write that just
   * failed (heartbeat/control polling) keeps failing here too, the pane still aborts rather than
   * hanging.
   */
  const abortWithReason = async (ctx: ExtensionContext, reason: string): Promise<void> => {
    const plan = planAbortWithReason(job, { resultPublished, delegatedSettled }, reason);
    if (plan.shouldPersistResult && plan.result !== undefined) {
      resultPublished = true;
      delegatedSettled = true;
      try {
        await persistResult(plan.result);
      } catch {
        // Best effort only; the durable write already failed once for this pane.
      }
    }
    ctx.abort();
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
      else {
        await finishPause();
        await reportStatus();
      }
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
    agentActive = true;
    void reportStatus();
    ctx.setInterval(() => {
      void pollControl(ctx).catch((error) => {
        void abortWithReason(
          ctx,
          `interactive worker control polling failed: ${describeExtensionError(error)}`,
        );
      });
    }, TERMINAL_POLL_MS);
    ctx.setInterval(() => {
      void persistState(currentState.phase, currentState.completed).catch((error) => {
        void abortWithReason(
          ctx,
          `interactive worker heartbeat could not be persisted: ${describeExtensionError(error)}`,
        );
      });
      void reportStatus();
    }, TERMINAL_HEARTBEAT_MS);
    if (job.timeoutMs !== undefined) {
      timeoutTimer = ctx.setTimeout(() => {
        void timeout(ctx).catch(() => ctx.abort());
      }, job.timeoutMs);
    }
  });
  pi.on("agent_start", (_event, ctx) => {
    void persistState("busy", currentState.completed).catch(() => ctx.abort());
    agentActive = true;
    void reportStatus();
  });
  pi.on("turn_start", (_event, ctx) => {
    void persistState("busy", currentState.completed).catch(() => ctx.abort());
    agentActive = true;
    void reportStatus();
  });
  pi.on("tool_execution_start", (event, ctx) => {
    void persistState("busy", currentState.completed).catch(() => ctx.abort());
    agentActive = true;
    if (event.toolName === "ask") waitingInputs.add(event.toolCallId);
    void reportStatus();
  });
  pi.on("tool_execution_end", (event, ctx) => {
    void persistState("busy", currentState.completed).catch(() => ctx.abort());
    waitingInputs.delete(event.toolCallId);
    void reportStatus();
  });
  pi.on("turn_end", (_event, ctx) => {
    void persistState("idle", currentState.completed).catch(() => ctx.abort());
  });
  pi.on("agent_end", async (event, ctx) => {
    agentActive = event.willContinue === true;
    if (event.willContinue === true) {
      await persistState("busy", currentState.completed);
      await reportStatus();
      return;
    }
    if (resultPublished) {
      await persistState(pauseCommand === undefined ? "idle" : "paused", true, pauseCommand?.id);
      await reportStatus();
      return;
    }
    await publish(event, ctx);
    if (!resultPublished && pauseCommand === undefined) await persistState("idle", false);
  });
  pi.on("session_shutdown", async () => {
    closed = true;
    if (timeoutTimer !== undefined) timeoutTimer = undefined;
    try {
      await persistState("closed", currentState.completed, closingCommand?.id);
    } finally {
      await statusReporter?.release();
    }
  });
}
