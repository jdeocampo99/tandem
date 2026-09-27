import { isAbsolute, relative, resolve } from "node:path";
import type { HerdrAgentState } from "../adapters/herdr-status.ts";
import {
  MAX_RESEARCH_DECISION_TEXT_BYTES,
  type Finding,
  type ReviewResult,
  type WorkerReceipt,
} from "../contracts.ts";
import { openSteps, type TodoItem } from "../playbooks/progress.ts";
import { commentableLines } from "../pr-review/diff.ts";
import { readOnlyCommandRefusal } from "../pr-review/shell.ts";
import { findingHeadline, isBlockingFinding } from "../tasks/findings.ts";
import {
  parseWorkerResult,
  type WorkerJob,
  type WorkerQuestion,
  type WorkerResult,
  type WorkerRole,
  type WorkerStatus,
} from "../workers/jobs.ts";
import {
  ReportRejection,
  resolveSubmittedReport,
  type SubmittedReport,
  uncommittedWorkRejection,
  WorkerOutputError,
} from "../workers/protocol.ts";
import {
  addReplyUsage,
  COPY_ASSET_TOOL,
  type ReplyUsage,
  SUBMIT_REPORT_TOOL,
  type WorkerTerminalCommand,
  type WorkerTerminalState,
  type WorkerTokenTally,
  WORKER_RESEARCH_FOLLOW_UP_TOOL,
} from "../workers/terminal.ts";
import { validationCommandRefusal } from "../workers/validation-commands.ts";
import type {
  Cancel,
  SessionDeps,
  SessionEvent,
  SessionHost,
  ToolCall,
  ToolDecision,
  ToolKind,
  ToolOutcome,
  UsageCounts,
} from "./events.ts";

// ponytail: fixed window; healthy workers peaked at 3 minutes without a tool call in recorded traces.
const STALLED_TURN_MINUTES = 5;
const STALLED_TURN_MS = STALLED_TURN_MINUTES * 60_000;
const IDLE_AFTER_RESULT_GRACE_MS = 30_000;
const READ_ONLY_KINDS: ReadonlySet<ToolKind> = new Set(["read", "search", "web-search"]);
/** The tools a scout may use only on the mockup Tandem asked it to draw. */
const MOCKUP_WRITE_KINDS: ReadonlySet<ToolKind> = new Set(["write", "edit", "copy-asset"]);

/**
 * A turn that goes the whole window without streaming output or starting or finishing a tool is
 * stuck, typically waiting on a background command whose result never arrived. A running tool is
 * progress.
 */
export function turnStalled(
  input: Readonly<{
    turnActive: boolean;
    toolsRunning: number;
    /** When the current turn started, the model last streamed output, or a tool started or finished. */
    lastActivityAt: number;
    now: number;
  }>,
): boolean {
  return (
    input.turnActive &&
    input.toolsRunning === 0 &&
    input.now - input.lastActivityAt >= STALLED_TURN_MS
  );
}

/**
 * After submit_report, the harness can end the turn with willContinue while a background command
 * it started (such as a dev server) is still running, then wait for that command forever. A
 * submitted worker whose pane reads idle, with nothing queued, for the whole grace period is done.
 */
export function idleAfterResult(
  input: Readonly<{
    completed: boolean;
    phase: WorkerTerminalState["phase"];
    paneIdle: boolean;
    pendingMessages: boolean;
    /** When the pane was first seen idle in this stretch, or undefined when it was not. */
    idleSince: number | undefined;
    now: number;
  }>,
): Readonly<{ idleSince: number | undefined; settle: boolean }> {
  if (!input.completed || input.phase !== "busy" || !input.paneIdle || input.pendingMessages) {
    return { idleSince: undefined, settle: false };
  }
  const idleSince = input.idleSince ?? input.now;
  const settle = input.now - idleSince >= IDLE_AFTER_RESULT_GRACE_MS;
  return { idleSince: settle ? undefined : idleSince, settle };
}

/**
 * What a turn that ended without `submit_report` means. One the person at the pane started is
 * conversation. One Tandem started (the brief, a steer, a reminder) gets one reminder; a second
 * fails the job so central recovery restarts it or asks the user, instead of sitting idle unseen.
 */
export function reportlessTurnEnd(
  input: Readonly<{ humanTurn: boolean; reminded: boolean }>,
): "conversation" | "remind" | "fail" {
  if (input.humanTurn) return "conversation";
  return input.reminded ? "fail" : "remind";
}

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

/** What `submit_report` tells the worker once its report is accepted. */
export function submittedReportText(result: WorkerResult, reviewRound: number | undefined): string {
  if (result.review !== undefined) {
    return `${reviewSummary(result.review, reviewRound)}\n\nEnd your turn by replying with exactly this summary and nothing else.`;
  }
  return result.error === undefined
    ? `Report submitted with status ${result.status}.`
    : `Report submitted with status ${result.status}: ${result.error}`;
}

/** The Herdr status a worker pane shows: paused, waiting for an answer, working, or its outcome. */
export function workerPaneStatus(
  input: Readonly<{
    paused: boolean;
    waitingForAnswer: boolean;
    agentActive: boolean;
    settled: HerdrAgentState;
    settledMessage: string | undefined;
  }>,
): Readonly<{ state: HerdrAgentState; message: string | undefined }> {
  if (input.paused) return { state: "blocked", message: "Worker paused" };
  if (input.waitingForAnswer) return { state: "blocked", message: "Waiting for your answer" };
  if (input.agentActive) return { state: "working", message: undefined };
  return { state: input.settled, message: input.settledMessage };
}

/**
 * Whether a scout's write, edit, or copy-asset call targets the mockup it was asked to draw.
 * `undefined` means the tool is not one of those; a scout writes nothing else, ever.
 */
export function mockupWriteDecision(
  input: Readonly<{
    role: WorkerRole;
    call: ToolCall;
    cwd: string;
    artifactDir: string | undefined;
  }>,
): ToolDecision | undefined {
  const { call, artifactDir } = input;
  if (input.role !== "scout" || !MOCKUP_WRITE_KINDS.has(call.kind)) return undefined;
  if (artifactDir === undefined) {
    return { block: true, reason: "A scout writes only the mockup Tandem asks it to draw." };
  }
  if (call.kind === "copy-asset") return { block: false };
  if (call.path === undefined || call.path.trim().length === 0) {
    return { block: true, reason: `${call.name} needs a path` };
  }
  if (!isWithin(artifactDir, resolve(input.cwd, call.path))) {
    return { block: true, reason: `Write only inside the mockup folder ${artifactDir}.` };
  }
  return { block: false };
}

/**
 * Once the delegated work is settled, timed out, or paused, only read-only tools and the to-do
 * list (the worker's own scratch notes) may run.
 */
export function workerToolRefusal(
  state: Readonly<{
    delegatedSettled: boolean;
    timeoutRequested: boolean;
    pauseRequested: boolean;
    phase: WorkerTerminalState["phase"];
    completed: boolean;
  }>,
  kind: ToolKind,
): string | undefined {
  const open =
    !state.delegatedSettled &&
    !state.timeoutRequested &&
    !state.pauseRequested &&
    state.phase !== "paused" &&
    !state.completed;
  if (open || READ_ONLY_KINDS.has(kind) || kind === "todo") return undefined;
  return "worker terminal is paused or completed; mutating tools are disabled";
}

/** Why a PR reviewer's shell call is refused: its shell may only read. */
export function reviewShellRefusal(prReview: boolean, call: ToolCall): string | undefined {
  if (!prReview || call.kind !== "shell") return undefined;
  return call.command === undefined
    ? `${call.name} needs a command`
    : readOnlyCommandRefusal(call.command);
}

/** Why an implementer's shell call is refused: it runs a pinned validation command itself. */
export function implementerShellRefusal(
  validationCommands: readonly string[] | undefined,
  call: ToolCall,
): string | undefined {
  if (validationCommands === undefined || call.kind !== "shell" || call.command === undefined) {
    return undefined;
  }
  return validationCommandRefusal(validationCommands, call.command);
}

/** What a worker session needs from the pane it runs in. */
export type WorkerHost = Pick<SessionHost, "perform" | "paneState" | "assertSelectedModel">;

export type WorkerDeps = Pick<SessionDeps, "clock" | "timers" | "status"> &
  Readonly<{
    host: WorkerHost;
    job: WorkerJob;
    pid: number;
    /** The job's durable terminal state, control command, and token tally files. */
    terminal: Readonly<{
      readCommand(): Promise<WorkerTerminalCommand | undefined>;
      writeState(state: WorkerTerminalState): Promise<void>;
      writeTokenTally(tally: WorkerTokenTally): Promise<void>;
    }>;
    persistResult(result: WorkerResult): Promise<void>;
    readReceipt(receiptPath: string): Promise<WorkerReceipt | undefined>;
    /** `git status --porcelain=v1` of `cwd`, or undefined when git cannot report it. */
    gitStatus(cwd: string): Promise<string | undefined>;
    readFile(path: string): Promise<string>;
    /** Copies `from` in the checkout to `artifactDir/name`; returns the target path. */
    copyAsset(
      input: Readonly<{ cwd: string; artifactDir: string; from: string; name: string }>,
    ): Promise<string>;
    /** Writes one answer for the active, completed-scout follow-up command. */
    submitResearchFollowUp(input: Readonly<{
      readonly decisionId: string;
      readonly resultPath: string;
      readonly answer: string;
    }>): Promise<void>;
    trace(event: string, detail?: Readonly<Record<string, unknown>>): void;
  }>;

type AgentEnd = Extract<SessionEvent, { type: "agentEnd" }>;
type ToolEnd = Extract<SessionEvent, { type: "toolEnd" }>;

const TERMINAL_HEARTBEAT_MS = 1_000;
const TERMINAL_POLL_MS = 250;
const BUSY_AFTER_RESULT_TRACE_MS = 60_000;
const REPORT_REMINDER = `Your turn ended without calling ${SUBMIT_REPORT_TOOL}, so Tandem has no report from this job. Reports earlier in this conversation belong to earlier jobs and do not count. Call ${SUBMIT_REPORT_TOOL} now; if you are stuck or need a decision, report that outcome.`;
const STALL_REMINDER = `Tandem stopped your turn: you went ${STALLED_TURN_MINUTES} minutes without calling a tool. Do not wait on a background command; its result can be lost. Check its output directly, run commands in the foreground, or finish and call ${SUBMIT_REPORT_TOOL}.`;

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

/**
 * One delegated worker pane: mirrors its lifecycle into the durable terminal state, delivers the
 * result submitted through `submit_report`, and enforces pause, close, timeout, and stall control.
 */
export class WorkerSession {
  private readonly job: WorkerJob;
  private closed = false;
  private resultPublished = false;
  private delegatedSettled = false;
  private timeoutRequested = false;
  private selfAborted = false;
  private pauseCommand: WorkerTerminalCommand | undefined;
  private closingCommand: WorkerTerminalCommand | undefined;
  // The mockup and focused research turns in progress, plus the last settled command id.
  private mockupCommand: WorkerTerminalCommand | undefined;
  private researchFollowUpCommand: WorkerTerminalCommand | undefined;
  private researchFollowUpSubmitted = false;
  private settledCommandId: string | undefined;
  private writeQueue = Promise.resolve();
  private currentState: WorkerTerminalState;
  private cancelTimeout: Cancel | undefined;
  private agentActive = false;
  private settledStatus: HerdrAgentState = "idle";
  private statusMessage: string | undefined;
  private readonly waitingInputs = new Set<string>();
  private readonly runningTools = new Set<string>();
  private turnActive = false;
  private lastActivityAt: number;
  private stallReminded = false;
  private stallAbortPending = false;
  private reportReminded = false;
  // Whether the person at the pane typed the message that started the current run.
  private humanTurn = false;
  private idleSince: number | undefined;
  private tokenTally: WorkerTokenTally | undefined;
  private tallyWrites = Promise.resolve();
  private lastBusyTraceAt = 0;
  // The worker's own to-do list as its latest `todo` call left it; scratch state, never task state.
  private todos: readonly TodoItem[] | undefined;

  constructor(private readonly deps: WorkerDeps) {
    this.job = deps.job;
    this.lastActivityAt = deps.clock.now();
    this.currentState = this.terminalState("starting", false);
  }

  async start(): Promise<void> {
    await this.deps.terminal.writeState(this.terminalState("starting", false));
  }

  /** Whether the pane is closing, when only the harness's exit key may reach it. */
  get closing(): boolean {
    return this.closingCommand !== undefined;
  }

  guardToolCall(call: ToolCall): ToolDecision {
    const write = mockupWriteDecision({
      role: this.job.role,
      call,
      cwd: this.job.cwd,
      artifactDir: this.mockupArtifactDir(),
    });
    if (write !== undefined) return write;
    if (call.kind === "research-follow-up") {
      const request = this.researchFollowUpCommand?.researchFollowUp;
      return this.job.role === "scout" && request !== undefined && !this.researchFollowUpSubmitted
        ? { block: false }
        : {
            block: true,
            reason: `${WORKER_RESEARCH_FOLLOW_UP_TOOL} only works during a focused research follow-up`,
          };
    }
    const refusal =
      workerToolRefusal(
        {
          delegatedSettled: this.delegatedSettled,
          timeoutRequested: this.timeoutRequested,
          pauseRequested: this.pauseCommand !== undefined,
          phase: this.currentState.phase,
          completed: this.currentState.completed,
        },
        call.kind,
      ) ??
      reviewShellRefusal(this.job.prReview !== undefined, call) ??
      implementerShellRefusal(this.job.validationCommands, call);
    return refusal === undefined ? { block: false } : { block: true, reason: refusal };
  }

  async submitReport(submission: SubmittedReport): Promise<ToolOutcome> {
    const result = await this.submittedResult(submission);
    if (result instanceof ReportRejection) {
      return {
        text: `Report rejected: ${result.message}. Fix it and call ${SUBMIT_REPORT_TOOL} again.`,
        isError: true,
      };
    }
    await this.settle(result);
    return { text: submittedReportText(result, this.job.review?.round), isError: false };
  }

  async copyAsset(from: string, name: string): Promise<ToolOutcome> {
    const artifactDir = this.mockupArtifactDir();
    if (artifactDir === undefined) {
      return { text: `${COPY_ASSET_TOOL} only works while drawing a mockup.`, isError: true };
    }
    try {
      const target = await this.deps.copyAsset({ cwd: this.job.cwd, artifactDir, from, name });
      return { text: `Copied to ${target}; reference it as ./${name}.`, isError: false };
    } catch (error) {
      return { text: `${COPY_ASSET_TOOL} failed: ${describeError(error)}`, isError: true };
    }
  }

  async submitResearchFollowUp(answer: string): Promise<ToolOutcome> {
    const request = this.researchFollowUpCommand?.researchFollowUp;
    if (
      request === undefined ||
      this.researchFollowUpSubmitted ||
      typeof answer !== "string" ||
      answer.trim().length === 0 ||
      answer.includes("\0") ||
      Buffer.byteLength(answer, "utf8") > MAX_RESEARCH_DECISION_TEXT_BYTES
    ) {
      return {
        text: `${WORKER_RESEARCH_FOLLOW_UP_TOOL} needs one non-empty answer during the active research follow-up.`,
        isError: true,
      };
    }
    try {
      await this.deps.submitResearchFollowUp({
        decisionId: request.decisionId,
        resultPath: request.resultPath,
        answer,
      });
      this.researchFollowUpSubmitted = true;
      return { text: "Research follow-up answer submitted.", isError: false };
    } catch (error) {
      return {
        text: `${WORKER_RESEARCH_FOLLOW_UP_TOOL} failed: ${describeError(error)}`,
        isError: true,
      };
    }
  }
  async onSessionStart(): Promise<void> {
    this.deps.trace("session_start");
    await this.persistState("busy", false);
    this.agentActive = true;
    void this.reportStatus();
    this.deps.timers.every(TERMINAL_POLL_MS, () => {
      void this.pollControl().catch((error) => {
        void this.abortWithReason(
          `interactive worker control polling failed: ${describeError(error)}`,
        );
      });
    });
    this.deps.timers.every(TERMINAL_HEARTBEAT_MS, () => this.heartbeat());
    if (this.job.timeoutMs !== undefined) {
      this.cancelTimeout = this.deps.timers.after(this.job.timeoutMs, () => {
        void this.timeout().catch(() => this.abort());
      });
    }
  }

  /** The person at the pane submitted a message. */
  onHumanInput(): void {
    this.humanTurn = true;
  }

  onAgentStart(): void {
    this.deps.trace("agent_start", { resultPublished: this.resultPublished });
    this.markBusy();
    void this.reportStatus();
  }

  onTurnStart(): void {
    this.deps.trace("turn_start");
    this.turnActive = true;
    this.lastActivityAt = this.deps.clock.now();
    this.markBusy();
    void this.reportStatus();
  }

  // A long reply, such as a whole artifact written in one tool call, streams for minutes before
  // the tool starts; streaming is progress.
  onStreaming(): void {
    this.lastActivityAt = this.deps.clock.now();
  }

  onToolStart(call: ToolCall): void {
    this.deps.trace("tool_start", { tool: call.name });
    this.runningTools.add(call.id);
    this.lastActivityAt = this.deps.clock.now();
    this.markBusy();
    if (call.kind === "ask") this.waitingInputs.add(call.id);
    void this.reportStatus();
  }

  onToolEnd(event: Pick<ToolEnd, "call" | "subagentUsage" | "todos">): void {
    this.deps.trace("tool_end", { tool: event.call.name });
    if (event.subagentUsage !== undefined)
      this.recordUsage(this.subagentReply(event.subagentUsage));
    if (event.todos !== undefined) this.todos = event.todos;
    this.runningTools.delete(event.call.id);
    this.lastActivityAt = this.deps.clock.now();
    void this.persistState("busy", this.currentState.completed).catch(() => this.abort());
    this.waitingInputs.delete(event.call.id);
    void this.reportStatus();
  }

  onTurnEnd(usage: ReplyUsage | undefined): void {
    this.deps.trace("turn_end");
    this.turnActive = false;
    this.runningTools.clear();
    if (usage !== undefined) this.recordUsage(usage);
    void this.persistState("idle", this.currentState.completed).catch(() => this.abort());
  }

  /**
   * A background command finishing after the report was submitted would hold the pane busy for
   * nothing, so that wake is stopped. It is not the session's own abort: the turn ends quietly.
   */
  onContextBuild(backgroundResultWake: boolean): void {
    if (this.resultPublished && backgroundResultWake) {
      void this.deps.host.perform({ type: "abort" });
    }
  }

  async onAgentEnd(event: Omit<AgentEnd, "type">): Promise<void> {
    this.deps.trace("agent_end", {
      willContinue: event.willContinue,
      resultPublished: this.resultPublished,
    });
    this.agentActive = event.willContinue;
    const humanTurn = this.humanTurn;
    if (!event.willContinue) this.humanTurn = false;
    const resumingAfterStall = this.stallAbortPending;
    if (resumingAfterStall) {
      await this.remindAfterStall();
      this.agentActive = true;
    }
    if (event.willContinue || resumingAfterStall) {
      await this.persistState("busy", this.currentState.completed);
      await this.reportStatus();
    } else if (this.researchFollowUpCommand !== undefined) {
      if (this.researchFollowUpSubmitted) await this.settleResearchFollowUpTurn();
      else await this.abandonResearchFollowUpTurn();
      await this.reportStatus();
    } else if (this.mockupCommand !== undefined) {
      await this.settleMockupTurn();
      await this.reportStatus();
    } else if (this.resultPublished) {
      await this.persistState(this.settledPhase(), true, this.pauseCommand?.id);
      this.deps.trace("agent_end_persisted", { phase: this.currentState.phase });
      await this.reportStatus();
    } else {
      await this.settleTurn(event, humanTurn);
    }
    this.deps.trace("agent_end_done", { phase: this.currentState.phase });
  }

  async onShutdown(): Promise<void> {
    this.deps.trace("session_shutdown");
    this.closed = true;
    this.cancelTimeout = undefined;
    try {
      await this.persistState("closed", this.currentState.completed, this.closingCommand?.id);
    } finally {
      await this.deps.status?.release();
    }
  }

  /** The folder the scout is drawing a mockup in right now, if it is. */
  private mockupArtifactDir(): string | undefined {
    return this.mockupCommand?.mockup?.artifactDir;
  }

  private terminalState(
    phase: WorkerTerminalState["phase"],
    completed: boolean,
    commandId?: string,
  ): WorkerTerminalState {
    return {
      schemaVersion: 1,
      jobId: this.job.id,
      taskId: this.job.taskId,
      generation: this.job.generation,
      role: this.job.role,
      cwd: this.job.cwd,
      pid: this.deps.pid,
      phase,
      completed,
      heartbeatAt: this.isoNow(),
      ...(commandId === undefined ? {} : { commandId }),
      ...(this.settledCommandId === undefined ? {} : { settledCommandId: this.settledCommandId }),
    };
  }

  private isoNow(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }

  private result(
    status: WorkerStatus,
    text: string,
    extras: Readonly<{
      review?: WorkerResult["review"];
      artifactPath?: string;
      error?: string;
      instructionRevision?: number;
      question?: WorkerQuestion;
    }> = {},
  ): WorkerResult {
    return parseWorkerResult({
      id: this.job.id,
      taskId: this.job.taskId,
      generation: this.job.generation,
      role: this.job.role,
      status,
      text,
      ...extras,
      finishedAt: this.isoNow(),
    });
  }

  private failure(error: unknown): WorkerResult {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : typeof error === "string" && error.trim().length > 0
          ? error.trim()
          : "worker execution failed";
    return this.result("failed", "", { error: message });
  }

  private timeoutFailure(): WorkerResult {
    return this.failure(`worker timed out after ${this.job.timeoutMs}ms`);
  }

  /** An abort the session asked for; `selfAborted` tells it apart from the person pressing Esc. */
  private abort(): void {
    this.selfAborted = true;
    void this.deps.host.perform({ type: "abort" });
  }

  private paneBusy(): boolean {
    const pane = this.deps.host.paneState();
    return !pane.idle || pane.pendingMessages || pane.draft;
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
    return this.deps.status?.report(status.state, status.message);
  }

  private async persistState(
    phase: WorkerTerminalState["phase"],
    completed = this.currentState.completed,
    commandId = this.currentState.commandId,
  ): Promise<void> {
    if (this.closed && phase !== "closed") return;
    const next = this.terminalState(phase, completed, commandId);
    this.currentState = next;
    const write = this.writeQueue.then(() => this.deps.terminal.writeState(next));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  /** Marks the pane busy; a failed state write aborts it. */
  private markBusy(): void {
    void this.persistState("busy", this.currentState.completed).catch(() => this.abort());
    this.agentActive = true;
  }

  private settleIdleAfterResult(): void {
    const pane = this.deps.host.paneState();
    const decision = idleAfterResult({
      completed: this.currentState.completed,
      phase: this.currentState.phase,
      paneIdle: pane.idle,
      pendingMessages: pane.pendingMessages,
      idleSince: this.idleSince,
      now: this.deps.clock.now(),
    });
    this.idleSince = decision.idleSince;
    if (!decision.settle) return;
    this.deps.trace("idle_after_result");
    this.agentActive = false;
    // A mockup turn that never started or never ended cleanly still has to settle.
    if (this.researchFollowUpCommand !== undefined) {
      if (this.researchFollowUpSubmitted) {
        void this.settleResearchFollowUpTurn().catch(() => this.abort());
      } else {
        void this.abandonResearchFollowUpTurn().catch(() => this.abort());
      }
      return;
    }
    if (this.mockupCommand !== undefined) {
      void this.settleMockupTurn().catch(() => this.abort());
      return;
    }
    void this.persistState(this.settledPhase(), true, this.pauseCommand?.id).catch(() =>
      this.abort(),
    );
  }

  // The first stall stops the turn and reminds the worker; a second fails the job so central
  // recovery restarts it or asks the user.
  private checkStalledTurn(): void {
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
      now: this.deps.clock.now(),
    });
    if (!stalled) return;
    this.deps.trace("stalled_turn", { reminded: this.stallReminded });
    if (this.stallReminded) {
      void this.abortWithReason(
        `worker stalled: no tool call for ${STALLED_TURN_MINUTES} minutes, again after a reminder`,
      );
      return;
    }
    this.stallReminded = true;
    this.stallAbortPending = true;
    this.abort();
  }

  // While a submitted worker still reads busy, record what the pane reports, at most once a minute.
  private traceBusyAfterResult(): void {
    if (!this.currentState.completed || this.currentState.phase !== "busy") return;
    const now = this.deps.clock.now();
    if (now - this.lastBusyTraceAt < BUSY_AFTER_RESULT_TRACE_MS) return;
    this.lastBusyTraceAt = now;
    const pane = this.deps.host.paneState();
    this.deps.trace("busy_after_result", {
      paneIdle: pane.idle,
      pendingMessages: pane.pendingMessages,
      agentActive: this.agentActive,
    });
  }

  private async persistResult(result: WorkerResult): Promise<void> {
    this.agentActive = false;
    this.settledStatus = result.status === "completed" ? "idle" : "blocked";
    this.statusMessage = result.error ?? result.question?.text;
    try {
      await this.deps.persistResult(result);
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

  private async settle(result: WorkerResult): Promise<void> {
    this.deps.trace("result_published", { status: result.status });
    this.resultPublished = true;
    this.delegatedSettled = true;
    this.cancelTimeout?.();
    this.cancelTimeout = undefined;
    await this.persistResult(result);
  }

  // A ReportRejection goes back to the worker to fix; anything else is the job's result.
  private async submittedResult(
    submission: SubmittedReport,
  ): Promise<WorkerResult | ReportRejection> {
    const job = this.job;
    try {
      this.deps.host.assertSelectedModel(job.model.model);
      if (job.role === "implementer" && submission.outcome === "implemented") {
        const status = await this.deps.gitStatus(job.cwd);
        const uncommitted = status === undefined ? undefined : uncommittedWorkRejection(status);
        if (uncommitted !== undefined) return uncommitted;
        const open = openSteps(job.playbookSteps ?? [], this.todos);
        if (open.length > 0) {
          return new ReportRejection(
            `these playbook steps are still open in your to-do list: ${open.join("; ")}. Finish them, or drop any that do not apply with the todo tool and give the reason in your report`,
          );
        }
      }
      const report = resolveSubmittedReport(job, submission, await this.reviewAnchors());
      const revision = await this.instructionRevision(report.status !== "failed");
      return this.result(report.status, report.text, {
        ...(report.error === undefined ? {} : { error: report.error }),
        ...(report.question === undefined ? {} : { question: report.question }),
        ...(report.artifactPath === undefined ? {} : { artifactPath: report.artifactPath }),
        ...(report.review === undefined ? {} : { review: report.review }),
        ...(revision === undefined ? {} : { instructionRevision: revision }),
      });
    } catch (error) {
      if (error instanceof ReportRejection) return error;
      return this.failure(error);
    }
  }

  /** The lines a PR review's comments may anchor on, read from the diff the run was given. */
  private async reviewAnchors(): Promise<ReadonlyMap<string, ReadonlySet<number>> | undefined> {
    const diffPath = this.job.prReview?.diffPath;
    if (diffPath === undefined || this.job.prReview?.structuredReport !== true) return undefined;
    return commentableLines(await this.deps.readFile(diffPath));
  }

  /** The steering revision the worker's receipt proves it applied; `required` makes a gap fatal. */
  private async instructionRevision(required: boolean): Promise<number | undefined> {
    const communication = this.job.communication;
    if (communication === undefined) return undefined;
    try {
      const receipt = await this.deps.readReceipt(communication.receiptPath);
      if (receipt === undefined || receipt.phase === "starting") {
        throw new WorkerOutputError("worker communication receipt has no lifecycle proof");
      }
      if (receipt.appliedRevision < communication.initialRevision) {
        throw new WorkerOutputError(
          `worker communication receipt applied revision ${receipt.appliedRevision} is older than ${communication.initialRevision}`,
        );
      }
      return receipt.appliedRevision;
    } catch (error) {
      if (required) throw error;
      return undefined;
    }
  }

  // The delegated result comes only from submit_report, so conversation turns never become it.
  private async settleTurn(event: Omit<AgentEnd, "type">, humanTurn: boolean): Promise<void> {
    if (this.pauseCommand !== undefined) {
      await this.persistState("paused", this.currentState.completed, this.pauseCommand.id);
      await this.reportStatus();
      return;
    }
    if (this.timeoutRequested) {
      await this.settle(this.timeoutFailure());
      return;
    }
    // An abort the session did not request came from the person at the pane pressing Esc to
    // redirect the worker. That is a hand-off, not a failure: the worker stays live with its tools
    // and still delivers its result through submit_report.
    if (event.interrupted && !this.selfAborted) {
      await this.persistState("idle", false);
      await this.reportStatus();
      return;
    }
    if (event.failure !== undefined) {
      await this.settle(this.failure(event.failure));
      return;
    }
    const next = reportlessTurnEnd({ humanTurn, reminded: this.reportReminded });
    this.deps.trace("reportless_turn_end", { next });
    if (next === "fail") {
      await this.settle(
        this.failure(
          `worker ended its turn without calling ${SUBMIT_REPORT_TOOL}, again after a reminder`,
        ),
      );
      return;
    }
    await this.persistState("idle", false);
    await this.reportStatus();
    if (next === "remind") {
      this.reportReminded = true;
      await this.deps.host.perform({
        type: "deliver",
        source: "report-reminder",
        text: REPORT_REMINDER,
        timing: "nextTurn",
        triggerTurn: true,
      });
    }
  }

  /**
   * Persists a durable failure carrying the real reason, exactly once and only while no result is
   * published, then aborts, so a later recovery notice can say what happened instead of a bare
   * "aborted". Best-effort: if the write that just failed keeps failing, the pane still aborts.
   */
  private async abortWithReason(reason: string): Promise<void> {
    if (!this.resultPublished && !this.delegatedSettled) {
      this.resultPublished = true;
      this.delegatedSettled = true;
      try {
        await this.persistResult(this.failure(reason));
      } catch {
        // Best effort only; the durable write already failed once for this pane.
      }
    }
    this.abort();
  }

  private async timeout(): Promise<void> {
    if (this.delegatedSettled || this.resultPublished || this.timeoutRequested) return;
    this.timeoutRequested = true;
    const wasIdle = this.deps.host.paneState().idle;
    this.abort();
    if (!wasIdle) return;
    await this.settle(this.timeoutFailure());
  }

  private async pause(command: WorkerTerminalCommand): Promise<void> {
    this.pauseCommand = command;
    this.cancelTimeout?.();
    this.cancelTimeout = undefined;
    if (!this.deps.host.paneState().idle) {
      this.abort();
      return;
    }
    if (!this.closed) {
      await this.persistState("paused", this.currentState.completed, command.id);
    }
    await this.reportStatus();
  }

  /** A close request is honored only for a paused or completed pane with nothing in flight. */
  private async acceptClose(command: WorkerTerminalCommand): Promise<void> {
    if (this.currentState.phase !== "paused" && !this.currentState.completed) return;
    if (this.paneBusy()) return;
    const confirmed = await this.deps.terminal.readCommand();
    if (confirmed?.id !== command.id || confirmed.action !== "close") return;
    if (this.paneBusy()) return;
    this.closingCommand = confirmed;
    await this.persistState("closing", true, confirmed.id);
  }

  // A finished scout takes a mockup request only while nothing else is happening in its pane,
  // so it never interrupts the person typing there.
  private async startMockupTurn(command: WorkerTerminalCommand): Promise<void> {
    const request = command.mockup;
    if (
      request === undefined ||
      this.job.role !== "scout" ||
      command.id === this.settledCommandId ||
      this.mockupCommand !== undefined ||
      this.researchFollowUpCommand !== undefined ||
      this.pauseCommand !== undefined ||
      this.closingCommand !== undefined ||
      !this.currentState.completed ||
      this.paneBusy()
    ) {
      return;
    }
    const brief = await this.deps.readFile(request.briefPath);
    this.deps.trace("control", { action: "mockup", phase: this.currentState.phase });
    this.mockupCommand = command;
    this.agentActive = true;
    await this.persistState("busy", true, command.id);
    await this.reportStatus();
    await this.deps.host.perform({ type: "promptAsUser", text: brief });
  }

  private async settleMockupTurn(): Promise<void> {
    if (this.mockupCommand === undefined) return;
    this.settledCommandId = this.mockupCommand.id;
    this.mockupCommand = undefined;
    await this.persistState(this.settledPhase(), true, this.pauseCommand?.id);
  }

  private async startResearchFollowUpTurn(command: WorkerTerminalCommand): Promise<void> {
    const request = command.researchFollowUp;
    if (
      request === undefined ||
      this.job.role !== "scout" ||
      command.id === this.settledCommandId ||
      this.researchFollowUpCommand !== undefined ||
      this.mockupCommand !== undefined ||
      this.pauseCommand !== undefined ||
      this.closingCommand !== undefined ||
      !this.currentState.completed ||
      this.paneBusy()
    ) {
      return;
    }
    const brief = await this.deps.readFile(request.briefPath);
    this.deps.trace("control", { action: "research-follow-up", phase: this.currentState.phase });
    this.researchFollowUpCommand = command;
    this.researchFollowUpSubmitted = false;
    this.agentActive = true;
    await this.persistState("busy", true, command.id);
    await this.reportStatus();
    await this.deps.host.perform({ type: "promptAsUser", text: brief });
  }

  private async settleResearchFollowUpTurn(): Promise<void> {
    const command = this.researchFollowUpCommand;
    if (command === undefined || !this.researchFollowUpSubmitted) return;
    this.settledCommandId = command.id;
    this.researchFollowUpCommand = undefined;
    this.researchFollowUpSubmitted = false;
    await this.persistState(this.settledPhase(), true, this.pauseCommand?.id);
  }

  private async abandonResearchFollowUpTurn(): Promise<void> {
    if (this.researchFollowUpCommand === undefined) return;
    this.researchFollowUpCommand = undefined;
    this.researchFollowUpSubmitted = false;
    await this.persistState(this.settledPhase(), true, undefined);
  }

  private async pollControl(): Promise<void> {
    if (this.closed) return;
    if (
      this.closingCommand !== undefined &&
      Date.parse(this.closingCommand.expiresAt) <= this.deps.clock.now()
    ) {
      this.closingCommand = undefined;
      await this.persistState(this.settledPhase(), this.currentState.completed);
    }
    const command = await this.deps.terminal.readCommand();
    if (command === undefined) return;
    if (command.id === this.currentState.commandId || command.id === this.pauseCommand?.id) return;
    if (command.action === "research-follow-up") {
      await this.startResearchFollowUpTurn(command);
      return;
    }
    if (command.action === "mockup") {
      await this.startMockupTurn(command);
      return;
    }
    this.deps.trace("control", { action: command.action, phase: this.currentState.phase });
    if (command.action === "pause") await this.pause(command);
    else await this.acceptClose(command);
  }

  /** Subagent counts are attributed to the worker's own provider and model; the tally keeps one. */
  private subagentReply(counts: UsageCounts): ReplyUsage {
    return {
      provider: this.tokenTally?.provider ?? "unknown",
      model: this.tokenTally?.model ?? "unknown",
      ...counts,
    };
  }

  private recordUsage(usage: ReplyUsage): void {
    this.tokenTally = addReplyUsage(this.tokenTally, usage);
    const tally = this.tokenTally;
    this.tallyWrites = this.tallyWrites
      .then(() => this.deps.terminal.writeTokenTally(tally))
      // Token accounting is informational; a failed write must not disturb the worker.
      .catch(() => undefined);
  }

  private heartbeat(): void {
    this.traceBusyAfterResult();
    this.settleIdleAfterResult();
    this.checkStalledTurn();
    void this.persistState(this.currentState.phase, this.currentState.completed).catch((error) => {
      void this.abortWithReason(
        `interactive worker heartbeat could not be persisted: ${describeError(error)}`,
      );
    });
    void this.reportStatus();
  }

  /** The watchdog's own abort: the worker keeps going with the reminder, not a failure. */
  private async remindAfterStall(): Promise<void> {
    this.stallAbortPending = false;
    this.selfAborted = false;
    await this.deps.host.perform({
      type: "deliver",
      source: "stall-reminder",
      text: STALL_REMINDER,
      timing: "nextTurn",
      triggerTurn: true,
    });
  }
}
