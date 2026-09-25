import { copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { runCommand } from "../adapters/commands.ts";
import { createHerdrStatusReporter, type HerdrAgentState } from "../adapters/herdr-status.ts";
import type { Finding, ReviewResult } from "../contracts.ts";
import { commentableLines } from "../pr-review/diff.ts";
import { readOnlyCommandRefusal } from "../pr-review/shell.ts";
import { readWorkerReceipt } from "../tasks/communication-persistence.ts";
import { findingHeadline, isBlockingFinding } from "../tasks/findings.ts";
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
  assertSelectedModel,
  expectedModelParts,
  nativeAgentEndAborted,
  nativeAgentEndFailure,
  outcomesFor,
  ReportRejection,
  resolveSubmittedReport,
  type SubmittedReport,
  WorkerOutputError,
} from "./protocol.ts";
import {
  addReplyUsage,
  COPY_ASSET_TOOL,
  type ReplyUsage,
  readWorkerTerminalCommand,
  replyUsage,
  SUBMIT_REPORT_TOOL,
  taskUsage,
  traceWorkerTurn,
  WORKER_JOB_PATH_ENV,
  type WorkerTerminalCommand,
  type WorkerTerminalJob,
  type WorkerTerminalState,
  type WorkerTokenTally,
  writeWorkerTerminal,
  writeWorkerTokenTally,
} from "./terminal.ts";

const TERMINAL_HEARTBEAT_MS = 1_000;
const TERMINAL_POLL_MS = 250;
const BUSY_AFTER_RESULT_TRACE_MS = 60_000;
const IDLE_AFTER_RESULT_GRACE_MS = 30_000;
// ponytail: fixed window; healthy workers peaked at 3 minutes without a tool call in recorded traces.
const STALLED_TURN_MINUTES = 5;
const STALLED_TURN_MS = STALLED_TURN_MINUTES * 60_000;
const STALL_REMINDER_ENTRY = "tandem-stall-reminder";
const STALL_REMINDER = `Tandem stopped your turn: you went ${STALLED_TURN_MINUTES} minutes without calling a tool. Do not wait on a background command; its result can be lost. Check its output directly, run commands in the foreground, or finish and call ${SUBMIT_REPORT_TOOL}.`;
const READ_ONLY_TOOLS: Readonly<Record<string, true>> = {
  read: true,
  grep: true,
  glob: true,
  web_search: true,
};
/** The tools a scout may use only on the mockup Tandem asked it to draw. */
const MOCKUP_WRITE_TOOLS: Readonly<Record<string, true>> = {
  write: true,
  edit: true,
  [COPY_ASSET_TOOL]: true,
};
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
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

/**
 * An abort the extension did not request came from the person at the pane pressing Esc to redirect
 * the worker. That is a hand-off, not a failure: the worker stays live with its tools and still
 * delivers its result through submit_report.
 */
export function userInterruptedTurn(event: unknown, extensionAborted: boolean): boolean {
  return !extensionAborted && nativeAgentEndAborted(event);
}

/**
 * OMP wakes an idle agent with an `async-result` message when a backgrounded command finishes.
 * After the report is submitted that wake would hold the pane busy for nothing, while a person
 * typing or a Tandem inbox update (appended as a synthetic message) is still a real request.
 */
export function isBackgroundResultWake(messages: readonly AgentMessage[]): boolean {
  const latest = messages.findLast((message) => !("synthetic" in message && message.synthetic));
  return (
    latest !== undefined &&
    latest.role === "custom" &&
    "customType" in latest &&
    latest.customType === "async-result"
  );
}

export type IdleAfterResultInput = Readonly<{
  readonly completed: boolean;
  readonly phase: WorkerTerminalState["phase"];
  readonly ompIdle: boolean;
  readonly pendingMessages: boolean;
  /** When OMP was first seen idle in this stretch, or undefined when it was not. */
  readonly idleSince: number | undefined;
  readonly now: number;
}>;

const SEVERITY_ORDER: Readonly<Record<Finding["severity"], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/**
 * What a reviewer's pane shows once its review is submitted: the round, the verdict, and one line
 * per finding, most severe first. The full review stays in the durable result.
 */
export function reviewSummary(review: ReviewResult, round: number | undefined): string {
  const title = round === undefined ? "Review" : `Review round ${round}`;
  const count = review.findings.length;
  if (count === 0) return `${title}: approved, no findings.`;
  const verdict = review.findings.some(isBlockingFinding) ? "changes needed" : "approved";
  const lines = [...review.findings]
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
    .map((finding) => {
      const location =
        finding.file === undefined
          ? ""
          : ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})`;
      const unconfirmed = finding.verdict === "plausible" ? " [unconfirmed]" : "";
      return `- ${finding.severity} ${findingHeadline(finding.description)}${location}${unconfirmed}`;
    });
  return [
    `${title}: ${verdict}, ${count === 1 ? "1 finding" : `${count} findings`}`,
    ...lines,
  ].join("\n");
}

export type StalledTurnInput = Readonly<{
  readonly turnActive: boolean;
  readonly toolsRunning: number;
  /** When the current turn started, the model last streamed output, or a tool started or finished. */
  readonly lastActivityAt: number;
  readonly now: number;
}>;

/**
 * A turn that goes the whole window without streaming output or starting or finishing a tool is
 * stuck, typically waiting on a background command whose result never arrived. A running tool is
 * progress.
 */
export function turnStalled(input: StalledTurnInput): boolean {
  return (
    input.turnActive &&
    input.toolsRunning === 0 &&
    input.now - input.lastActivityAt >= STALLED_TURN_MS
  );
}

/**
 * After submit_report, OMP ends the turn with willContinue while a background command it started
 * (such as a dev server) is still running, then waits for that command forever. A submitted worker
 * that OMP itself reports idle, with nothing queued, for the whole grace period is done.
 */
export function idleAfterResult(
  input: IdleAfterResultInput,
): Readonly<{ readonly idleSince: number | undefined; readonly settle: boolean }> {
  if (!input.completed || input.phase !== "busy" || !input.ompIdle || input.pendingMessages) {
    return { idleSince: undefined, settle: false };
  }
  const idleSince = input.idleSince ?? input.now;
  const settle = input.now - idleSince >= IDLE_AFTER_RESULT_GRACE_MS;
  return { idleSince: settle ? undefined : idleSince, settle };
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
  settledCommandId?: string,
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
    ...(settledCommandId === undefined ? {} : { settledCommandId }),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * Whether a scout's write, edit, or copy_asset call targets the mockup it was asked to draw.
 * `undefined` means the tool is not one of those; a scout writes nothing else, ever.
 */
export function mockupWriteDecision(
  input: Readonly<{
    role: WorkerRole;
    toolName: string;
    toolInput: unknown;
    cwd: string;
    artifactDir: string | undefined;
  }>,
): "allow" | { block: true; reason: string } | undefined {
  if (input.role !== "scout" || MOCKUP_WRITE_TOOLS[input.toolName] !== true) return undefined;
  if (input.artifactDir === undefined) {
    return { block: true, reason: "A scout writes only the mockup Tandem asks it to draw." };
  }
  const args =
    typeof input.toolInput === "object" && input.toolInput !== null
      ? (input.toolInput as Record<string, unknown>)
      : {};
  if (input.toolName === COPY_ASSET_TOOL) return "allow";
  const path = args.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    return { block: true, reason: `${input.toolName} needs a path` };
  }
  if (!isWithin(input.artifactDir, resolve(input.cwd, path))) {
    return {
      block: true,
      reason: `Write only inside the mockup folder ${input.artifactDir}.`,
    };
  }
  return "allow";
}

/** Copies one file from the scout's checkout next to its mockup, byte for byte. */
export async function copyMockupAsset(
  input: Readonly<{ cwd: string; artifactDir: string; from: string; name: string }>,
): Promise<string> {
  if (!ASSET_NAME.test(input.name)) {
    throw new Error("name must be a plain file name such as jr-thinking.webp");
  }
  const [root, source] = await Promise.all([
    realpath(input.cwd),
    realpath(resolve(input.cwd, input.from)),
  ]);
  if (!isWithin(root, source))
    throw new Error("from must be a file inside the repository checkout");
  const entry = await lstat(source);
  if (!entry.isFile()) throw new Error("from must be a regular file");
  if (entry.size > MAX_ASSET_BYTES) throw new Error("from is larger than 20 MB");
  const target = resolve(input.artifactDir, input.name);
  if (basename(target) !== input.name) throw new Error("name must be a plain file name");
  await copyFile(source, target);
  return target;
}

/** The lines a PR review's comments may anchor on, read from the diff the run was given. */
async function reviewAnchors(
  job: WorkerJob,
): Promise<ReadonlyMap<string, ReadonlySet<number>> | undefined> {
  const diffPath = job.prReview?.diffPath;
  if (diffPath === undefined || job.prReview?.structuredReport !== true) return undefined;
  return commentableLines(await readFile(diffPath, "utf8"));
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
  // The mockup turn in progress, and the last one that finished.
  let mockupCommand: WorkerTerminalCommand | undefined;
  let settledMockupId: string | undefined;
  let resultPublished = false;
  let delegatedSettled = false;
  let timeoutRequested = false;
  let extensionAborted = false;
  let pauseCommand: WorkerTerminalCommand | undefined;
  let closingCommand: WorkerTerminalCommand | undefined;
  let writeQueue = Promise.resolve();
  let currentState: WorkerTerminalState = terminalState(identity, "starting", false);
  let timeoutTimer: Timer | undefined;
  let agentActive = false;
  let settledStatus: HerdrAgentState = "idle";
  let statusMessage: string | undefined;
  const waitingInputs = new Set<string>();
  const runningTools = new Set<string>();
  let turnActive = false;
  let lastActivityAt = Date.now();
  let stallReminded = false;
  let stallAbortPending = false;
  const abort = (ctx: ExtensionContext): void => {
    extensionAborted = true;
    ctx.abort();
  };
  const reportStatus = (): Promise<void> | undefined => {
    if (pauseCommand !== undefined) return statusReporter?.report("blocked", "Worker paused");
    if (waitingInputs.size > 0) return statusReporter?.report("blocked", "Waiting for your answer");
    return statusReporter?.report(
      agentActive ? "working" : settledStatus,
      agentActive ? undefined : statusMessage,
    );
  };
  let ompIdleSince: number | undefined;
  let tokenTally: WorkerTokenTally | undefined;
  let tallyWrites = Promise.resolve();
  const settleIdleAfterResult = (ctx: ExtensionContext): void => {
    const decision = idleAfterResult({
      completed: currentState.completed,
      phase: currentState.phase,
      ompIdle: ctx.isIdle(),
      pendingMessages: ctx.hasPendingMessages(),
      idleSince: ompIdleSince,
      now: Date.now(),
    });
    ompIdleSince = decision.idleSince;
    if (!decision.settle) return;
    traceWorkerTurn(jobPath, "idle_after_result");
    agentActive = false;
    // A mockup turn that never started or never ended cleanly still has to settle.
    if (mockupCommand !== undefined) {
      void settleMockupTurn().catch(() => abort(ctx));
      return;
    }
    void persistState(pauseCommand === undefined ? "idle" : "paused", true, pauseCommand?.id).catch(
      () => abort(ctx),
    );
  };
  // The first stall stops the turn and reminds the worker; a second fails the job so central
  // recovery restarts it or asks the user.
  const checkStalledTurn = (ctx: ExtensionContext): void => {
    if (resultPublished || timeoutRequested || pauseCommand !== undefined || stallAbortPending) {
      return;
    }
    const stalled = turnStalled({
      turnActive,
      toolsRunning: runningTools.size,
      lastActivityAt,
      now: Date.now(),
    });
    if (!stalled) return;
    traceWorkerTurn(jobPath, "stalled_turn", { reminded: stallReminded });
    if (stallReminded) {
      void abortWithReason(
        ctx,
        `worker stalled: no tool call for ${STALLED_TURN_MINUTES} minutes, again after a reminder`,
      );
      return;
    }
    stallReminded = true;
    stallAbortPending = true;
    abort(ctx);
  };
  let lastBusyTraceAt = 0;
  // While a submitted worker still reads busy, record what OMP itself reports, at most once a minute.
  const traceBusyAfterResult = (ctx: ExtensionContext): void => {
    if (!currentState.completed || currentState.phase !== "busy") return;
    if (Date.now() - lastBusyTraceAt < BUSY_AFTER_RESULT_TRACE_MS) return;
    lastBusyTraceAt = Date.now();
    traceWorkerTurn(jobPath, "busy_after_result", {
      ompIdle: ctx.isIdle(),
      pendingMessages: ctx.hasPendingMessages(),
      agentActive,
    });
  };
  const persistState = async (
    phase: WorkerTerminalState["phase"],
    completed = currentState.completed,
    commandId = currentState.commandId,
  ): Promise<void> => {
    if (closed && phase !== "closed") return;
    const next = terminalState(identity, phase, completed, commandId, settledMockupId);
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
  const settle = async (result: WorkerResult, ctx: ExtensionContext): Promise<void> => {
    traceWorkerTurn(jobPath, "result_published", { status: result.status });
    resultPublished = true;
    delegatedSettled = true;
    if (timeoutTimer !== undefined) {
      ctx.clearTimer(timeoutTimer);
      timeoutTimer = undefined;
    }
    await persistResult(result);
  };
  // A ReportRejection goes back to the worker to fix; anything else is the job's result.
  const submittedResult = async (
    submission: SubmittedReport,
    ctx: ExtensionContext,
  ): Promise<WorkerResult | ReportRejection> => {
    try {
      assertSelectedModel(expectedModelParts(job.model.model), ctx.model);
      const report = resolveSubmittedReport(job, submission, await reviewAnchors(job));
      const revision = await instructionRevision(job, report.status !== "failed");
      return resultFor(job, report.status, report.text, {
        ...(report.error === undefined ? {} : { error: report.error }),
        ...(report.question === undefined ? {} : { question: report.question }),
        ...(report.artifactPath === undefined ? {} : { artifactPath: report.artifactPath }),
        ...(report.review === undefined ? {} : { review: report.review }),
        ...(revision === undefined ? {} : { instructionRevision: revision }),
      });
    } catch (error) {
      if (error instanceof ReportRejection) return error;
      return failureFor(job, error);
    }
  };
  // The delegated result comes only from submit_report, so conversation turns never become it.
  const settleTurn = async (event: unknown, ctx: ExtensionContext): Promise<void> => {
    if (pauseCommand !== undefined) {
      await persistState("paused", currentState.completed, pauseCommand.id);
      await reportStatus();
      return;
    }
    if (timeoutRequested) {
      await settle(failureFor(job, `worker timed out after ${job.timeoutMs}ms`), ctx);
      return;
    }
    if (userInterruptedTurn(event, extensionAborted)) {
      await persistState("idle", false);
      await reportStatus();
      return;
    }
    let failure: string | undefined;
    try {
      failure = nativeAgentEndFailure(event, expectedModelParts(job.model.model));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== undefined) {
      await settle(failureFor(job, failure), ctx);
      return;
    }
    await persistState("idle", false);
    await reportStatus();
  };

  const z = pi.zod;
  const reviews = job.role === "reviewer";
  const reviewSchema = z
    .object({
      lens: z.enum(["review"]),
      head: z.string(),
      generation: z.number().int().nonnegative(),
      pass: z.boolean(),
      findings: z.array(
        z
          .object({
            id: z.string(),
            severity: z.enum(["P0", "P1", "P2", "P3"]),
            verdict: z.enum(["confirmed", "plausible"]),
            file: z.string().optional(),
            line: z.number().int().positive().optional(),
            description: z.string(),
          })
          .strict(),
      ),
      summary: z.string(),
    })
    .strict();
  pi.registerTool({
    name: SUBMIT_REPORT_TOOL,
    label: "Submit report",
    description:
      "Submit your final report to the Tandem coordinator once the delegated work is done. Only this call delivers the report; ordinary replies are conversation. A rejected submission explains what to fix; correct it and call again.",
    parameters: z
      .object({
        outcome: z.enum(outcomesFor(job.role)),
        report: z
          .string()
          .optional()
          .describe(
            reviews
              ? "Optional context for a needs-decision or failed outcome."
              : "The full report body in Markdown.",
          ),
        question: z
          .string()
          .optional()
          .describe("Required for needs-decision: one bounded single-line question."),
        recommendation: z
          .string()
          .optional()
          .describe("Optional for needs-decision: one bounded single-line recommendation."),
        ...(job.role === "presentation"
          ? {
              artifactPath: z
                .string()
                .optional()
                .describe("Required for completed: the absolute path of the written artifact."),
            }
          : {}),
        ...(reviews
          ? {
              review: reviewSchema.optional().describe("Required for completed: the ReviewResult."),
            }
          : {}),
      })
      .strict(),
    strict: true,
    loadMode: "essential",
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await submittedResult(params, ctx);
      if (result instanceof ReportRejection) {
        return {
          content: [
            {
              type: "text",
              text: `Report rejected: ${result.message}. Fix it and call ${SUBMIT_REPORT_TOOL} again.`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      await settle(result, ctx);
      const summary =
        result.review !== undefined
          ? `${reviewSummary(result.review, job.review?.round)}\n\nEnd your turn by replying with exactly this summary and nothing else.`
          : result.error === undefined
            ? `Report submitted with status ${result.status}.`
            : `Report submitted with status ${result.status}: ${result.error}`;
      return { content: [{ type: "text", text: summary }], details: undefined };
    },
  });

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
    abort(ctx);
  };

  const timeout = async (ctx: ExtensionContext): Promise<void> => {
    if (delegatedSettled || resultPublished || timeoutRequested) return;
    timeoutRequested = true;
    const wasIdle = ctx.isIdle();
    abort(ctx);
    if (!wasIdle) return;
    await settle(failureFor(job, `worker timed out after ${job.timeoutMs}ms`), ctx);
  };

  const finishPause = async (): Promise<void> => {
    if (pauseCommand === undefined || closed) return;
    await persistState("paused", currentState.completed, pauseCommand.id);
  };

  // A finished scout takes a mockup request only while nothing else is happening in its pane,
  // so it never interrupts the person typing there.
  const startMockupTurn = async (
    command: WorkerTerminalCommand,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const request = command.mockup;
    if (
      request === undefined ||
      job.role !== "scout" ||
      command.id === settledMockupId ||
      mockupCommand !== undefined ||
      pauseCommand !== undefined ||
      closingCommand !== undefined ||
      !currentState.completed ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      ctx.ui.getEditorText().trim().length > 0
    ) {
      return;
    }
    const brief = await readFile(request.briefPath, "utf8");
    traceWorkerTurn(jobPath, "control", { action: "mockup", phase: currentState.phase });
    mockupCommand = command;
    agentActive = true;
    await persistState("busy", true, command.id);
    await reportStatus();
    pi.sendUserMessage(brief);
  };

  const settleMockupTurn = async (): Promise<void> => {
    if (mockupCommand === undefined) return;
    settledMockupId = mockupCommand.id;
    mockupCommand = undefined;
    await persistState(pauseCommand === undefined ? "idle" : "paused", true, pauseCommand?.id);
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
    if (command.action === "mockup") {
      await startMockupTurn(command, ctx);
      return;
    }
    traceWorkerTurn(jobPath, "control", { action: command.action, phase: currentState.phase });
    if (command.action === "pause") {
      pauseCommand = command;
      if (timeoutTimer !== undefined) {
        ctx.clearTimer(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (!ctx.isIdle()) abort(ctx);
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

  /** A PR reviewer's shell may only read; anything else is refused with the reason. */
  const guardReviewShell = (
    event: Readonly<{ toolName: string; input: unknown }>,
  ): { block: true; reason: string } | undefined => {
    if (job.prReview === undefined || event.toolName !== "bash") return undefined;
    const command =
      typeof event.input === "object" && event.input !== null && "command" in event.input
        ? event.input.command
        : undefined;
    const refusal =
      typeof command === "string" ? readOnlyCommandRefusal(command) : "bash needs a command";
    return refusal === undefined ? undefined : { block: true, reason: refusal };
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

  pi.on("tool_call", (event) => {
    const write = mockupWriteDecision({
      role: job.role,
      toolName: event.toolName,
      toolInput: event.input,
      cwd: job.cwd,
      artifactDir: mockupCommand?.mockup?.artifactDir,
    });
    if (write !== undefined) return write === "allow" ? undefined : write;
    return guardTool(event.toolName) ?? guardReviewShell(event);
  });

  if (job.role === "scout") {
    pi.registerTool({
      name: COPY_ASSET_TOOL,
      label: "Copy asset",
      description:
        "Copy an image, font, or other file from the repository checkout into the mockup folder, byte for byte, so the mockup can load it by relative path (for example ./jr-thinking.webp). Only works while drawing a mockup.",
      parameters: z
        .object({
          from: z.string().describe("Path of the file in the repository checkout."),
          name: z.string().describe("Plain file name to save it as in the mockup folder."),
        })
        .strict(),
      strict: true,
      approval: "read",
      async execute(_toolCallId, params) {
        const artifactDir = mockupCommand?.mockup?.artifactDir;
        if (artifactDir === undefined) {
          return {
            content: [{ type: "text", text: "copy_asset only works while drawing a mockup." }],
            details: undefined,
            isError: true,
          };
        }
        try {
          const target = await copyMockupAsset({
            cwd: job.cwd,
            artifactDir,
            from: params.from,
            name: params.name,
          });
          return {
            content: [
              { type: "text", text: `Copied to ${target}; reference it as ./${params.name}.` },
            ],
            details: undefined,
          };
        } catch (error) {
          return {
            content: [
              { type: "text", text: `copy_asset failed: ${describeExtensionError(error)}` },
            ],
            details: undefined,
            isError: true,
          };
        }
      },
    });
  }

  const recordUsage = (usage: ReplyUsage | undefined): void => {
    if (usage === undefined) return;
    tokenTally = addReplyUsage(tokenTally, usage);
    const tally = tokenTally;
    tallyWrites = tallyWrites
      .then(() => writeWorkerTokenTally(jobPath, tally))
      // Token accounting is informational; a failed write must not disturb the worker.
      .catch(() => undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    traceWorkerTurn(jobPath, "session_start");
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
      traceBusyAfterResult(ctx);
      settleIdleAfterResult(ctx);
      checkStalledTurn(ctx);
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
        void timeout(ctx).catch(() => abort(ctx));
      }, job.timeoutMs);
    }
  });
  pi.on("agent_start", (_event, ctx) => {
    traceWorkerTurn(jobPath, "agent_start", { resultPublished });
    void persistState("busy", currentState.completed).catch(() => abort(ctx));
    agentActive = true;
    void reportStatus();
  });
  pi.on("turn_start", (_event, ctx) => {
    traceWorkerTurn(jobPath, "turn_start");
    turnActive = true;
    lastActivityAt = Date.now();
    void persistState("busy", currentState.completed).catch(() => abort(ctx));
    agentActive = true;
    void reportStatus();
  });
  // A long reply, such as a whole artifact written in one tool call, streams for minutes before
  // the tool starts; streaming is progress.
  pi.on("message_update", () => {
    lastActivityAt = Date.now();
  });
  pi.on("tool_execution_start", (event, ctx) => {
    traceWorkerTurn(jobPath, "tool_start", { tool: event.toolName });
    runningTools.add(event.toolCallId);
    lastActivityAt = Date.now();
    void persistState("busy", currentState.completed).catch(() => abort(ctx));
    agentActive = true;
    if (event.toolName === "ask") waitingInputs.add(event.toolCallId);
    void reportStatus();
  });
  pi.on("tool_execution_end", (event, ctx) => {
    traceWorkerTurn(jobPath, "tool_end", { tool: event.toolName });
    if (event.toolName === "task") recordUsage(taskUsage(event.result, tokenTally));
    runningTools.delete(event.toolCallId);
    lastActivityAt = Date.now();
    void persistState("busy", currentState.completed).catch(() => abort(ctx));
    waitingInputs.delete(event.toolCallId);
    void reportStatus();
  });
  pi.on("turn_end", (event, ctx) => {
    traceWorkerTurn(jobPath, "turn_end");
    turnActive = false;
    runningTools.clear();
    recordUsage(replyUsage(event.message));
    void persistState("idle", currentState.completed).catch(() => abort(ctx));
  });
  pi.on("context", (event, ctx) => {
    const latest = event.messages.at(-1);
    traceWorkerTurn(jobPath, "context", {
      messages: event.messages.length,
      latest: latest === undefined ? undefined : latest.role,
    });
    if (resultPublished && isBackgroundResultWake(event.messages)) ctx.abort();
  });
  pi.on("agent_end", async (event, ctx) => {
    traceWorkerTurn(jobPath, "agent_end", { willContinue: event.willContinue, resultPublished });
    agentActive = event.willContinue === true;
    if (stallAbortPending) {
      // The watchdog's own abort: the worker keeps going with the reminder, not a failure.
      stallAbortPending = false;
      extensionAborted = false;
      pi.sendMessage(
        {
          customType: STALL_REMINDER_ENTRY,
          content: STALL_REMINDER,
          display: true,
          attribution: "agent",
        },
        { deliverAs: "nextTurn", triggerTurn: true },
      );
      if (event.willContinue !== true) {
        agentActive = true;
        await persistState("busy", currentState.completed);
        await reportStatus();
        traceWorkerTurn(jobPath, "agent_end_done", { phase: currentState.phase });
        return;
      }
    }
    if (event.willContinue === true) {
      await persistState("busy", currentState.completed);
      await reportStatus();
      traceWorkerTurn(jobPath, "agent_end_done", { phase: currentState.phase });
      return;
    }
    if (mockupCommand !== undefined) {
      await settleMockupTurn();
      await reportStatus();
      traceWorkerTurn(jobPath, "agent_end_done", { phase: currentState.phase });
      return;
    }
    if (resultPublished) {
      await persistState(pauseCommand === undefined ? "idle" : "paused", true, pauseCommand?.id);
      traceWorkerTurn(jobPath, "agent_end_persisted", { phase: currentState.phase });
      await reportStatus();
      traceWorkerTurn(jobPath, "agent_end_done", { phase: currentState.phase });
      return;
    }
    await settleTurn(event, ctx);
    traceWorkerTurn(jobPath, "agent_end_done", { phase: currentState.phase });
  });
  pi.on("session_shutdown", async () => {
    traceWorkerTurn(jobPath, "session_shutdown");
    closed = true;
    if (timeoutTimer !== undefined) timeoutTimer = undefined;
    try {
      await persistState("closed", currentState.completed, closingCommand?.id);
    } finally {
      await statusReporter?.release();
    }
  });
}
