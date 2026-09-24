import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { runCommand } from "../adapters/commands.ts";
import {
  createHerdrStatusReporter,
  type HerdrAgentState,
  type HerdrStatusReporter,
} from "../adapters/herdr-status.ts";
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

/** The lines a PR review's comments may anchor on, read from the diff the run was given. */
async function reviewAnchors(
  job: WorkerJob,
): Promise<ReadonlyMap<string, ReadonlySet<number>> | undefined> {
  const diffPath = job.prReview?.diffPath;
  if (diffPath === undefined || job.prReview?.structuredReport !== true) return undefined;
  return commentableLines(await readFile(diffPath, "utf8"));
}

type Zod = ExtensionAPI["zod"];
type ToolBlock = { block: true; reason: string };
type SubmitReportToolResult = {
  content: { type: "text"; text: string }[];
  details: undefined;
  isError?: true;
};

function reviewResultSchema(z: Zod) {
  return z
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
}

/** The `submit_report` parameters for one role: presentations add an artifact, reviewers a review. */
function submitReportParameters(z: Zod, role: WorkerRole) {
  const reviews = role === "reviewer";
  return z
    .object({
      outcome: z.enum(outcomesFor(role)),
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
      ...(role === "presentation"
        ? {
            artifactPath: z
              .string()
              .optional()
              .describe("Required for completed: the absolute path of the written artifact."),
          }
        : {}),
      ...(reviews
        ? {
            review: reviewResultSchema(z)
              .optional()
              .describe("Required for completed: the ReviewResult."),
          }
        : {}),
    })
    .strict();
}

function toolText(text: string): { type: "text"; text: string }[] {
  return [{ type: "text", text }];
}

/** What `submit_report` tells the worker once its report is accepted. */
export function submittedReportText(result: WorkerResult, reviewRound: number | undefined): string {
  if (result.review !== undefined) {
    return `${reviewSummary(result.review, reviewRound)}\n\nEnd your turn by replying with exactly this summary and nothing else.`;
  }
  return result.error === undefined
    ? `Report submitted with status ${result.status}.`
    : `Report submitted with status ${result.status}: ${result.error}`;
}

export type WorkerToolGuardState = Readonly<{
  readonly delegatedSettled: boolean;
  readonly timeoutRequested: boolean;
  readonly pauseRequested: boolean;
  readonly phase: WorkerTerminalState["phase"];
  readonly completed: boolean;
}>;

/** Once the delegated work is settled, timed out, or paused, only read-only tools may run. */
export function workerToolRefusal(
  state: WorkerToolGuardState,
  toolName: string,
): ToolBlock | undefined {
  const open =
    !state.delegatedSettled &&
    !state.timeoutRequested &&
    !state.pauseRequested &&
    state.phase !== "paused" &&
    !state.completed;
  if (open || READ_ONLY_TOOLS[toolName] === true) return undefined;
  return {
    block: true,
    reason: "worker terminal is paused or completed; mutating tools are disabled",
  };
}

/** A PR reviewer's shell may only read; anything else is refused with the reason. */
export function reviewShellRefusal(
  prReview: boolean,
  event: Readonly<{ toolName: string; input: unknown }>,
): ToolBlock | undefined {
  if (!prReview || event.toolName !== "bash") return undefined;
  const command =
    typeof event.input === "object" && event.input !== null && "command" in event.input
      ? event.input.command
      : undefined;
  const refusal =
    typeof command === "string" ? readOnlyCommandRefusal(command) : "bash needs a command";
  return refusal === undefined ? undefined : { block: true, reason: refusal };
}

export type WorkerPaneStatusInput = Readonly<{
  readonly paused: boolean;
  readonly waitingForAnswer: boolean;
  readonly agentActive: boolean;
  readonly settled: HerdrAgentState;
  readonly settledMessage: string | undefined;
}>;

/** The Herdr status a worker pane shows: paused, waiting for an answer, working, or its outcome. */
export function workerPaneStatus(
  input: WorkerPaneStatusInput,
): Readonly<{ state: HerdrAgentState; message: string | undefined }> {
  if (input.paused) return { state: "blocked", message: "Worker paused" };
  if (input.waitingForAnswer) return { state: "blocked", message: "Waiting for your answer" };
  if (input.agentActive) return { state: "working", message: undefined };
  return { state: input.settled, message: input.settledMessage };
}

/** The pane has something in flight: a turn, queued input, or an editor draft. */
function paneBusy(ctx: ExtensionContext): boolean {
  return !ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText().trim().length > 0;
}

type WorkerTerminalDependencies = Readonly<{
  readonly job: WorkerJob;
  readonly jobPath: string;
  readonly statusReporter: HerdrStatusReporter | undefined;
  /** Queues the stall reminder as the worker's next turn. */
  readonly sendStallReminder: () => void;
}>;

/**
 * One delegated worker pane: mirrors its lifecycle into the durable terminal state, delivers the
 * result submitted through `submit_report`, and enforces pause, close, timeout, and stall control.
 */
class WorkerTerminalSession {
  private readonly job: WorkerJob;
  private readonly jobPath: string;
  private readonly identity: NativeWorkerIdentity;
  private readonly statusReporter: HerdrStatusReporter | undefined;
  private readonly sendStallReminder: () => void;
  private closed = false;
  private resultPublished = false;
  private delegatedSettled = false;
  private timeoutRequested = false;
  private extensionAborted = false;
  private pauseCommand: WorkerTerminalCommand | undefined;
  private closingCommand: WorkerTerminalCommand | undefined;
  private writeQueue = Promise.resolve();
  private currentState: WorkerTerminalState;
  private timeoutTimer: Timer | undefined;
  private agentActive = false;
  private settledStatus: HerdrAgentState = "idle";
  private statusMessage: string | undefined;
  private readonly waitingInputs = new Set<string>();
  private readonly runningTools = new Set<string>();
  private turnActive = false;
  private lastActivityAt = Date.now();
  private stallReminded = false;
  private stallAbortPending = false;
  private ompIdleSince: number | undefined;
  private tokenTally: WorkerTokenTally | undefined;
  private tallyWrites = Promise.resolve();
  private lastBusyTraceAt = 0;

  constructor(dependencies: WorkerTerminalDependencies) {
    this.job = dependencies.job;
    this.jobPath = dependencies.jobPath;
    this.identity = workerIdentity(dependencies.job, dependencies.jobPath);
    this.statusReporter = dependencies.statusReporter;
    this.sendStallReminder = dependencies.sendStallReminder;
    this.currentState = terminalState(this.identity, "starting", false);
  }

  async start(): Promise<void> {
    await writeWorkerTerminal(this.jobPath, terminalState(this.identity, "starting", false));
  }

  private trace(event: string, detail?: Readonly<Record<string, unknown>>): void {
    traceWorkerTurn(this.jobPath, event, detail);
  }

  private abort(ctx: ExtensionContext): void {
    this.extensionAborted = true;
    ctx.abort();
  }

  private settledPhase(): WorkerTerminalState["phase"] {
    return this.pauseCommand === undefined ? "idle" : "paused";
  }

  private reportStatus(): Promise<void> | undefined {
    const status = workerPaneStatus({
      paused: this.pauseCommand !== undefined,
      waitingForAnswer: this.waitingInputs.size > 0,
      agentActive: this.agentActive,
      settled: this.settledStatus,
      settledMessage: this.statusMessage,
    });
    return this.statusReporter?.report(status.state, status.message);
  }

  private async persistState(
    phase: WorkerTerminalState["phase"],
    completed = this.currentState.completed,
    commandId = this.currentState.commandId,
  ): Promise<void> {
    if (this.closed && phase !== "closed") return;
    const next = terminalState(this.identity, phase, completed, commandId);
    this.currentState = next;
    const write = this.writeQueue.then(() => writeWorkerTerminal(this.jobPath, next));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  /** Marks the pane busy; a failed state write aborts it. */
  private markBusy(ctx: ExtensionContext): void {
    void this.persistState("busy", this.currentState.completed).catch(() => this.abort(ctx));
    this.agentActive = true;
  }

  private settleIdleAfterResult(ctx: ExtensionContext): void {
    const decision = idleAfterResult({
      completed: this.currentState.completed,
      phase: this.currentState.phase,
      ompIdle: ctx.isIdle(),
      pendingMessages: ctx.hasPendingMessages(),
      idleSince: this.ompIdleSince,
      now: Date.now(),
    });
    this.ompIdleSince = decision.idleSince;
    if (!decision.settle) return;
    this.trace("idle_after_result");
    this.agentActive = false;
    void this.persistState(this.settledPhase(), true, this.pauseCommand?.id).catch(() =>
      this.abort(ctx),
    );
  }

  // The first stall stops the turn and reminds the worker; a second fails the job so central
  // recovery restarts it or asks the user.
  private checkStalledTurn(ctx: ExtensionContext): void {
    if (
      this.resultPublished ||
      this.timeoutRequested ||
      this.pauseCommand !== undefined ||
      this.stallAbortPending
    ) {
      return;
    }
    const stalled = turnStalled({
      turnActive: this.turnActive,
      toolsRunning: this.runningTools.size,
      lastActivityAt: this.lastActivityAt,
      now: Date.now(),
    });
    if (!stalled) return;
    this.trace("stalled_turn", { reminded: this.stallReminded });
    if (this.stallReminded) {
      void this.abortWithReason(
        ctx,
        `worker stalled: no tool call for ${STALLED_TURN_MINUTES} minutes, again after a reminder`,
      );
      return;
    }
    this.stallReminded = true;
    this.stallAbortPending = true;
    this.abort(ctx);
  }

  // While a submitted worker still reads busy, record what OMP itself reports, at most once a minute.
  private traceBusyAfterResult(ctx: ExtensionContext): void {
    if (!this.currentState.completed || this.currentState.phase !== "busy") return;
    if (Date.now() - this.lastBusyTraceAt < BUSY_AFTER_RESULT_TRACE_MS) return;
    this.lastBusyTraceAt = Date.now();
    this.trace("busy_after_result", {
      ompIdle: ctx.isIdle(),
      pendingMessages: ctx.hasPendingMessages(),
      agentActive: this.agentActive,
    });
  }

  private async persistResult(result: WorkerResult): Promise<void> {
    this.agentActive = false;
    this.settledStatus = result.status === "completed" ? "idle" : "blocked";
    this.statusMessage = result.error ?? result.question?.text;
    try {
      await persistWorkerResult(this.job.resultPath, result);
    } catch (error) {
      this.settledStatus = "blocked";
      this.statusMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      try {
        await this.persistState(this.settledPhase(), true, this.pauseCommand?.id);
      } finally {
        await this.reportStatus();
      }
    }
  }

  private async settle(result: WorkerResult, ctx: ExtensionContext): Promise<void> {
    this.trace("result_published", { status: result.status });
    this.resultPublished = true;
    this.delegatedSettled = true;
    if (this.timeoutTimer !== undefined) {
      ctx.clearTimer(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    await this.persistResult(result);
  }

  // A ReportRejection goes back to the worker to fix; anything else is the job's result.
  private async submittedResult(
    submission: SubmittedReport,
    ctx: ExtensionContext,
  ): Promise<WorkerResult | ReportRejection> {
    const job = this.job;
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
  }

  async submitReport(
    submission: SubmittedReport,
    ctx: ExtensionContext,
  ): Promise<SubmitReportToolResult> {
    const result = await this.submittedResult(submission, ctx);
    if (result instanceof ReportRejection) {
      return {
        content: toolText(
          `Report rejected: ${result.message}. Fix it and call ${SUBMIT_REPORT_TOOL} again.`,
        ),
        details: undefined,
        isError: true,
      };
    }
    await this.settle(result, ctx);
    return {
      content: toolText(submittedReportText(result, this.job.review?.round)),
      details: undefined,
    };
  }

  // The delegated result comes only from submit_report, so conversation turns never become it.
  private async settleTurn(event: unknown, ctx: ExtensionContext): Promise<void> {
    if (this.pauseCommand !== undefined) {
      await this.persistState("paused", this.currentState.completed, this.pauseCommand.id);
      await this.reportStatus();
      return;
    }
    if (this.timeoutRequested) {
      await this.settle(
        failureFor(this.job, `worker timed out after ${this.job.timeoutMs}ms`),
        ctx,
      );
      return;
    }
    if (userInterruptedTurn(event, this.extensionAborted)) {
      await this.persistState("idle", false);
      await this.reportStatus();
      return;
    }
    let failure: string | undefined;
    try {
      failure = nativeAgentEndFailure(event, expectedModelParts(this.job.model.model));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== undefined) {
      await this.settle(failureFor(this.job, failure), ctx);
      return;
    }
    await this.persistState("idle", false);
    await this.reportStatus();
  }

  /**
   * Applies `planAbortWithReason`'s decision and then aborts. Best-effort: if the write that just
   * failed (heartbeat/control polling) keeps failing here too, the pane still aborts rather than
   * hanging.
   */
  private async abortWithReason(ctx: ExtensionContext, reason: string): Promise<void> {
    const plan = planAbortWithReason(
      this.job,
      { resultPublished: this.resultPublished, delegatedSettled: this.delegatedSettled },
      reason,
    );
    if (plan.shouldPersistResult && plan.result !== undefined) {
      this.resultPublished = true;
      this.delegatedSettled = true;
      try {
        await this.persistResult(plan.result);
      } catch {
        // Best effort only; the durable write already failed once for this pane.
      }
    }
    this.abort(ctx);
  }

  private async timeout(ctx: ExtensionContext): Promise<void> {
    if (this.delegatedSettled || this.resultPublished || this.timeoutRequested) return;
    this.timeoutRequested = true;
    const wasIdle = ctx.isIdle();
    this.abort(ctx);
    if (!wasIdle) return;
    await this.settle(failureFor(this.job, `worker timed out after ${this.job.timeoutMs}ms`), ctx);
  }

  private async pause(command: WorkerTerminalCommand, ctx: ExtensionContext): Promise<void> {
    this.pauseCommand = command;
    if (this.timeoutTimer !== undefined) {
      ctx.clearTimer(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    if (!ctx.isIdle()) {
      this.abort(ctx);
      return;
    }
    if (!this.closed) {
      await this.persistState("paused", this.currentState.completed, command.id);
    }
    await this.reportStatus();
  }

  /** A close request is honored only for a paused or completed pane with nothing in flight. */
  private async acceptClose(command: WorkerTerminalCommand, ctx: ExtensionContext): Promise<void> {
    if (this.currentState.phase !== "paused" && !this.currentState.completed) return;
    if (paneBusy(ctx)) return;
    const confirmed = await readWorkerTerminalCommand(this.jobPath, this.identity);
    if (confirmed?.id !== command.id || confirmed.action !== "close") return;
    if (paneBusy(ctx)) return;
    this.closingCommand = confirmed;
    await this.persistState("closing", true, confirmed.id);
  }

  private async pollControl(ctx: ExtensionContext): Promise<void> {
    if (this.closed) return;
    if (
      this.closingCommand !== undefined &&
      Date.parse(this.closingCommand.expiresAt) <= Date.now()
    ) {
      this.closingCommand = undefined;
      await this.persistState(this.settledPhase(), this.currentState.completed);
    }
    const command = await readWorkerTerminalCommand(this.jobPath, this.identity);
    if (command === undefined) return;
    if (command.id === this.currentState.commandId || command.id === this.pauseCommand?.id) return;
    this.trace("control", { action: command.action, phase: this.currentState.phase });
    if (command.action === "pause") await this.pause(command, ctx);
    else await this.acceptClose(command, ctx);
  }

  guardToolCall(event: Readonly<{ toolName: string; input: unknown }>): ToolBlock | undefined {
    return (
      workerToolRefusal(
        {
          delegatedSettled: this.delegatedSettled,
          timeoutRequested: this.timeoutRequested,
          pauseRequested: this.pauseCommand !== undefined,
          phase: this.currentState.phase,
          completed: this.currentState.completed,
        },
        event.toolName,
      ) ?? reviewShellRefusal(this.job.prReview !== undefined, event)
    );
  }

  private recordUsage(usage: ReplyUsage | undefined): void {
    if (usage === undefined) return;
    this.tokenTally = addReplyUsage(this.tokenTally, usage);
    const tally = this.tokenTally;
    this.tallyWrites = this.tallyWrites
      .then(() => writeWorkerTokenTally(this.jobPath, tally))
      // Token accounting is informational; a failed write must not disturb the worker.
      .catch(() => undefined);
  }

  private heartbeat(ctx: ExtensionContext): void {
    this.traceBusyAfterResult(ctx);
    this.settleIdleAfterResult(ctx);
    this.checkStalledTurn(ctx);
    void this.persistState(this.currentState.phase, this.currentState.completed).catch((error) => {
      void this.abortWithReason(
        ctx,
        `interactive worker heartbeat could not be persisted: ${describeExtensionError(error)}`,
      );
    });
    void this.reportStatus();
  }

  async onSessionStart(ctx: ExtensionContext): Promise<void> {
    this.trace("session_start");
    // Freeze an empty editor before the controller sends the native exit key.
    // ctx.shutdown() alone does not wake OMP's idle interactive input loop.
    ctx.ui.onTerminalInput((data) =>
      this.closingCommand !== undefined && !matchesKey(data, "ctrl+d")
        ? { consume: true }
        : undefined,
    );
    await this.persistState("busy", false);
    this.agentActive = true;
    void this.reportStatus();
    ctx.setInterval(() => {
      void this.pollControl(ctx).catch((error) => {
        void this.abortWithReason(
          ctx,
          `interactive worker control polling failed: ${describeExtensionError(error)}`,
        );
      });
    }, TERMINAL_POLL_MS);
    ctx.setInterval(() => this.heartbeat(ctx), TERMINAL_HEARTBEAT_MS);
    if (this.job.timeoutMs !== undefined) {
      this.timeoutTimer = ctx.setTimeout(() => {
        void this.timeout(ctx).catch(() => this.abort(ctx));
      }, this.job.timeoutMs);
    }
  }

  onAgentStart(ctx: ExtensionContext): void {
    this.trace("agent_start", { resultPublished: this.resultPublished });
    this.markBusy(ctx);
    void this.reportStatus();
  }

  onTurnStart(ctx: ExtensionContext): void {
    this.trace("turn_start");
    this.turnActive = true;
    this.lastActivityAt = Date.now();
    this.markBusy(ctx);
    void this.reportStatus();
  }

  // A long reply, such as a whole artifact written in one tool call, streams for minutes before
  // the tool starts; streaming is progress.
  onMessageUpdate(): void {
    this.lastActivityAt = Date.now();
  }

  onToolStart(
    event: Readonly<{ toolName: string; toolCallId: string }>,
    ctx: ExtensionContext,
  ): void {
    this.trace("tool_start", { tool: event.toolName });
    this.runningTools.add(event.toolCallId);
    this.lastActivityAt = Date.now();
    this.markBusy(ctx);
    if (event.toolName === "ask") this.waitingInputs.add(event.toolCallId);
    void this.reportStatus();
  }

  onToolEnd(
    event: Readonly<{ toolName: string; toolCallId: string; result: unknown }>,
    ctx: ExtensionContext,
  ): void {
    this.trace("tool_end", { tool: event.toolName });
    if (event.toolName === "task") this.recordUsage(taskUsage(event.result, this.tokenTally));
    this.runningTools.delete(event.toolCallId);
    this.lastActivityAt = Date.now();
    void this.persistState("busy", this.currentState.completed).catch(() => this.abort(ctx));
    this.waitingInputs.delete(event.toolCallId);
    void this.reportStatus();
  }

  onTurnEnd(message: unknown, ctx: ExtensionContext): void {
    this.trace("turn_end");
    this.turnActive = false;
    this.runningTools.clear();
    this.recordUsage(replyUsage(message));
    void this.persistState("idle", this.currentState.completed).catch(() => this.abort(ctx));
  }

  onContext(messages: readonly AgentMessage[], ctx: ExtensionContext): void {
    const latest = messages.at(-1);
    this.trace("context", {
      messages: messages.length,
      latest: latest === undefined ? undefined : latest.role,
    });
    if (this.resultPublished && isBackgroundResultWake(messages)) ctx.abort();
  }

  /** The watchdog's own abort: the worker keeps going with the reminder, not a failure. */
  private remindAfterStall(): void {
    this.stallAbortPending = false;
    this.extensionAborted = false;
    this.sendStallReminder();
  }

  private async persistBusy(): Promise<void> {
    await this.persistState("busy", this.currentState.completed);
    await this.reportStatus();
  }

  async onAgentEnd(
    event: Readonly<{ willContinue?: boolean }>,
    ctx: ExtensionContext,
  ): Promise<void> {
    this.trace("agent_end", {
      willContinue: event.willContinue,
      resultPublished: this.resultPublished,
    });
    this.agentActive = event.willContinue === true;
    const resumingAfterStall = this.stallAbortPending;
    if (resumingAfterStall) {
      this.remindAfterStall();
      this.agentActive = true;
    }
    if (event.willContinue === true || resumingAfterStall) {
      await this.persistBusy();
    } else if (this.resultPublished) {
      await this.persistState(this.settledPhase(), true, this.pauseCommand?.id);
      this.trace("agent_end_persisted", { phase: this.currentState.phase });
      await this.reportStatus();
    } else {
      await this.settleTurn(event, ctx);
    }
    this.trace("agent_end_done", { phase: this.currentState.phase });
  }

  async onShutdown(): Promise<void> {
    this.trace("session_shutdown");
    this.closed = true;
    this.timeoutTimer = undefined;
    try {
      await this.persistState("closed", this.currentState.completed, this.closingCommand?.id);
    } finally {
      await this.statusReporter?.release();
    }
  }
}

export async function registerWorkerTerminalExtension(pi: ExtensionAPI): Promise<void> {
  const jobPath = process.env[WORKER_JOB_PATH_ENV];
  if (jobPath === undefined || jobPath.trim().length === 0) return;
  const job = await readJob(jobPath);
  const session = new WorkerTerminalSession({
    job,
    jobPath,
    statusReporter: createHerdrStatusReporter(runCommand, {
      cwd: job.cwd,
      agentLabel: `tandem-${job.role}-${job.taskId.slice(0, 8)}`,
    }),
    sendStallReminder: () =>
      pi.sendMessage(
        {
          customType: STALL_REMINDER_ENTRY,
          content: STALL_REMINDER,
          display: true,
          attribution: "agent",
        },
        { deliverAs: "nextTurn", triggerTurn: true },
      ),
  });
  await session.start();

  pi.registerTool({
    name: SUBMIT_REPORT_TOOL,
    label: "Submit report",
    description:
      "Submit your final report to the Tandem coordinator once the delegated work is done. Only this call delivers the report; ordinary replies are conversation. A rejected submission explains what to fix; correct it and call again.",
    parameters: submitReportParameters(pi.zod, job.role),
    strict: true,
    loadMode: "essential",
    approval: "read",
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) => session.submitReport(params, ctx),
  });
  pi.on("tool_call", (event) => session.guardToolCall(event));
  pi.on("session_start", (_event, ctx) => session.onSessionStart(ctx));
  pi.on("agent_start", (_event, ctx) => session.onAgentStart(ctx));
  pi.on("turn_start", (_event, ctx) => session.onTurnStart(ctx));
  pi.on("message_update", () => session.onMessageUpdate());
  pi.on("tool_execution_start", (event, ctx) => session.onToolStart(event, ctx));
  pi.on("tool_execution_end", (event, ctx) => session.onToolEnd(event, ctx));
  pi.on("turn_end", (event, ctx) => session.onTurnEnd(event.message, ctx));
  pi.on("context", (event, ctx) => session.onContext(event.messages, ctx));
  pi.on("agent_end", (event, ctx) => session.onAgentEnd(event, ctx));
  pi.on("session_shutdown", () => session.onShutdown());
}
