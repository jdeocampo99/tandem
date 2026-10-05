import type { HerdrAgentState, HerdrStatusReporter } from "../adapters/herdr-status.ts";
import { type BoardRow, notifiesUser } from "../board/view.ts";
import {
  coordinatorSourceGuidance,
  type TandemBoundaryEnvironment,
} from "../config/environment.ts";
import type { TaskRecord } from "../contracts.ts";
import {
  COORDINATOR_INSTRUCTIONS,
  COORDINATOR_TOOL_GUIDANCE,
  TANDEM_COORDINATOR_INSTRUCTIONS,
} from "../instructions.ts";
import type { CoordinatorUsageEntry } from "../runtime/usage-receipt.ts";
import type { SourceRefreshResult, TandemService } from "../service/controller.ts";
import { isMissing, isTerminalTask } from "../service/records.ts";
import { fixRoundBudget, ledgerBlockers } from "../tasks/findings.ts";
import { recordedReviewLevel } from "../tasks/review-levels.ts";
import { StoreLockTimeoutError } from "../tasks/store-errors.ts";
import { WELCOME_TEXT } from "../terminal/welcome.ts";
import type { ReplyUsage } from "../workers/terminal.ts";
import { atCompactionBoundary, finishedTaskIds } from "./compaction.ts";
import type { CoordinatorMessage } from "./coordinator-reply.ts";
import type {
  Cancel,
  CoordinatorTurnAction,
  ReplyFor,
  SessionDeps,
  SessionEvent,
  SessionHost,
  ToolCall,
} from "./events.ts";
import {
  deliverInvestigationQuestions,
  deliverPendingNotifications,
  deliverPrWatchNotices,
  type ResearchReportReader,
} from "./notifications.ts";
import { OnboardingGuide } from "./onboarding-guide.ts";
import { ReviewPageListeners } from "./review-page.ts";
import { buildDurableDigest } from "./summary.ts";

export type CoordinatorDeps = SessionDeps &
  Readonly<{
    environment: TandemBoundaryEnvironment;
    /** Called once, on first use, so a bad service configuration fails where it is needed. */
    createService(): TandemService;
    realpath(path: string): Promise<string>;
    /** Whether this coordinator's project is the Tandem checkout itself. */
    isTandemCheckout(): Promise<boolean>;
    /** Opens the welcome popup over the Herdr session, pointed at this coordinator's pane. */
    openWelcome(): Promise<void>;
    readReport: ResearchReportReader;
    appendUsage(entry: CoordinatorUsageEntry): Promise<void>;
    /** Context size that triggers early compaction; `0` leaves compaction to the harness. */
    compactTokens: number;
    tickIntervalMs: number;
  }>;

type Reply<T extends SessionEvent["type"]> = ReplyFor<Extract<SessionEvent, { type: T }>>;

/** Status-line summary of an in-progress review cycle, or `undefined` outside one. */
export function reviewStatus(task: TaskRecord): string | undefined {
  if (task.stage !== "reviewing" && task.stage !== "awaiting-fixes") return undefined;
  const current = task.reviews.filter(
    (review) => review.head === task.reviewHead && review.generation === task.generation,
  );
  const failed = current.filter((review) => !review.pass).map((review) => review.lens);
  const blockers = ledgerBlockers(task.findingLedger ?? [], recordedReviewLevel(task).level).length;
  const parts = [
    task.reviewRound === 0
      ? task.stage
      : `${task.stage} fix ${task.reviewRound}/${fixRoundBudget(task)}`,
  ];
  if (failed.length > 0) parts.push(`${failed.join(",")} fail`);
  if (blockers > 0) parts.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** What the coordinator is told about its source checkout after a successful refresh. */
export function sourceRefreshStatus(refreshed: SourceRefreshResult | undefined): string {
  if (refreshed?.changed === true) {
    return `Coordinator source advanced from ${refreshed.previousHead} to ${refreshed.head}; earlier file observations and repository guidance may be stale. Existing tasks remain pinned to their captured commits.`;
  }
  if (refreshed?.localOnly) {
    return "Coordinator source is local-only; no origin/main refresh is configured. Existing tasks remain pinned to their captured commits.";
  }
  return "Coordinator source is current for this turn. Existing tasks remain pinned to their captured commits.";
}

const INITIAL_SOURCE_STATUS =
  "Source is refreshed only at the start of a new coordinator turn; tasks already created remain pinned to their captured commit.";

const OPERATION_FAILED = "Tandem extension operation failed";

/**
 * A thread the model never closed counts as over once the user has been quiet this long, so what
 * is waiting reaches them when they are most likely away.
 */
export const THREAD_IDLE_MS = 30 * 60 * 1_000;

function sourceRefreshBlockedStatus(message: string): string {
  return `SOURCE REFRESH BLOCKED: ${message}. Do not create or launch new work until the coordinator source refresh succeeds.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The standing coordinator context: instructions, source boundary and freshness, the digest, and
 * one line listing the project's workstreams once the user has named any.
 */
function coordinatorContext(
  environment: TandemBoundaryEnvironment,
  tandemContext: readonly string[],
  sourceStatus: string,
  digest: string,
  workstreams: readonly string[],
): string[] {
  return [
    COORDINATOR_INSTRUCTIONS,
    COORDINATOR_TOOL_GUIDANCE,
    ...tandemContext,
    coordinatorSourceGuidance(environment),
    sourceStatus,
    digest,
    ...(workstreams.length === 0 ? [] : [`Workstreams: ${workstreams.join(" · ")}`]),
  ];
}

/** Workstream notes only add context, so notes that cannot be read never hold up a turn. */
async function workstreamLines(service: TandemService, repo: string): Promise<readonly string[]> {
  try {
    return await service.memoryList(repo);
  } catch {
    return [];
  }
}

/** Whether a path is this already-resolved repository; a missing checkout is not. */
async function isInRepository(
  repoPath: string,
  repo: string,
  realpath: CoordinatorDeps["realpath"],
): Promise<boolean> {
  if (repoPath === repo) return true;
  const resolved = await realpath(repoPath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  return resolved === repo;
}

type TaskStatus = Readonly<{ state: HerdrAgentState; message: string | undefined }>;

/**
 * The coordinator pane's task status: the first open task in this repository waiting on someone,
 * otherwise the last one working, otherwise idle.
 */
async function coordinatorTaskStatus(
  tasks: readonly TaskRecord[],
  repo: string,
  realpath: CoordinatorDeps["realpath"],
): Promise<TaskStatus> {
  let status: TaskStatus = { state: "idle", message: undefined };
  for (const task of tasks) {
    if (isTerminalTask(task) || task.stage === "ready") continue;
    if (!(await isInRepository(task.repoPath, repo, realpath))) continue;
    if (task.stage === "blocked" || task.stage === "paused" || task.stage === "awaiting-approval") {
      return { state: "blocked", message: task.blockReason ?? `${task.stage}: ${task.objective}` };
    }
    status = {
      state: "working",
      message: reviewStatus(task) ?? `${task.stage}: ${task.objective}`,
    };
  }
  return status;
}

/** The Herdr status of the coordinator pane: waiting for an answer, working, or its tasks' state. */
class CoordinatorStatus {
  agentActive = false;
  private taskState: HerdrAgentState = "idle";
  private taskMessage: string | undefined;
  private readonly waitingInputs = new Set<string>();

  constructor(readonly reporter: HerdrStatusReporter | undefined) {}

  get waitingForInput(): boolean {
    return this.waitingInputs.size > 0;
  }

  report(): void {
    if (this.waitingInputs.size > 0) {
      void this.reporter?.report("blocked", "Waiting for your answer");
    } else if (this.agentActive) {
      void this.reporter?.report("working", this.taskMessage);
    } else {
      void this.reporter?.report(this.taskState, this.taskMessage);
    }
  }

  setTasks(status: TaskStatus): void {
    this.taskState = status.state;
    this.taskMessage = status.message;
  }

  block(message: string): void {
    this.setTasks({ state: "blocked", message });
  }

  toolStarted(call: ToolCall): void {
    this.agentActive = true;
    if (call.kind === "ask") this.waitingInputs.add(call.id);
    this.report();
  }

  toolEnded(call: ToolCall): void {
    this.waitingInputs.delete(call.id);
    this.report();
  }
}

/** Compacts once per newly finished non-scout task, when the coordinator is idle and over budget. */
class EarlyCompaction {
  private knownFinished: Set<string> | undefined;
  private taskFinished = false;
  private compacting = false;

  constructor(
    private readonly compactTokens: number,
    private readonly host: SessionHost,
    private readonly logError: SessionDeps["logError"],
  ) {}

  /** Uses every listed task, like the digest and notifications, because this coordinator sees them all. */
  compactIfAtBoundary(tasks: readonly TaskRecord[], idle: boolean): void {
    if (this.compactTokens === 0 || !this.host.capabilities.proactiveCompaction) return;
    const finished = finishedTaskIds(tasks);
    const previous = this.knownFinished;
    if (previous !== undefined && [...finished].some((id) => !previous.has(id))) {
      this.taskFinished = true;
    }
    this.knownFinished = finished;
    if (
      this.compacting ||
      !atCompactionBoundary(tasks, { taskFinished: this.taskFinished, idle })
    ) {
      return;
    }
    // The boundary is used up either way, so a later unrelated idle moment never compacts.
    this.taskFinished = false;
    const tokens = this.host.contextTokens();
    if (tokens === undefined || tokens < this.compactTokens) return;
    this.compacting = true;
    // Not awaited: compaction re-enters the session through `compacted`, which reconciles, and
    // this runs inside `reconcile`.
    void this.host
      .perform({ type: "compact" })
      .catch((error: unknown) => this.logError(OPERATION_FAILED, error))
      .finally(() => {
        this.compacting = false;
      });
  }
}

/** One coordinator conversation: its scheduler, notifications, status, and compaction state. */
export class CoordinatorSession {
  private readonly status: CoordinatorStatus;
  private readonly compaction: EarlyCompaction;
  private readonly deliveredNotifications = new Set<string>();
  private readonly unacknowledgedNotifications = new Set<string>();
  /** Notifications held back while a thread is open, which the user was told are waiting. */
  private readonly heldNotifications = new Set<string>();
  /** "Needs you" keys already notified or there at start; unset until the first reconcile. */
  private needsYouSeen: ReadonlySet<string> | undefined;
  /** When the user last took part in the open thread; unset when no thread is open. */
  private threadActiveAt: number | undefined;

  /** The current agent run's actions; any non-trace action keeps final reconcile enabled. */
  private turnAction: CoordinatorTurnAction | undefined;
  private createdService: TandemService | undefined;
  private isTandemCheckout: Promise<boolean> | undefined;
  private onboardingGuide: OnboardingGuide | undefined;
  private readonly reviewPages: ReviewPageListeners;
  private cancelTick: Cancel | undefined;
  private reconcileInFlight: Promise<void> | undefined;
  /** This project's "Needs you" rows at the last reconcile; unset until the first one. */
  private sourceStatus = INITIAL_SOURCE_STATUS;
  private shuttingDown = false;

  constructor(private readonly deps: CoordinatorDeps) {
    this.status = new CoordinatorStatus(deps.status);
    this.compaction = new EarlyCompaction(deps.compactTokens, deps.host, deps.logError);
    this.reviewPages = new ReviewPageListeners({
      host: deps.host,
      service: () => this.service(),
      logError: (message, error) => deps.logError(message, error),
    });
  }

  service(): TandemService {
    this.createdService ??= this.deps.createService();
    return this.createdService;
  }

  /**
   * What only the Tandem coordinator reads: its instructions, and where first-time setup stands,
   * read fresh each time. Setup state that cannot be read is left out rather than guessed.
   */
  private async tandemContext(): Promise<readonly string[]> {
    if (!(await this.tandemCheckout())) return [];
    const setup = await this.onboarding()
      .context()
      .catch(() => []);
    return [TANDEM_COORDINATOR_INSTRUCTIONS, ...setup];
  }

  private onboarding(): OnboardingGuide {
    this.onboardingGuide ??= new OnboardingGuide({
      host: this.deps.host,
      service: () => this.service(),
      repo: this.deps.environment.repo,
      logError: (message, error) => this.deps.logError(message, error),
    });
    return this.onboardingGuide;
  }

  private tandemCheckout(): Promise<boolean> {
    this.isTandemCheckout ??= this.deps.isTandemCheckout();
    return this.isTandemCheckout;
  }

  /** An unreadable task list counts as research running, so the guard fails closed. */
  async researchRunning(): Promise<boolean> {
    try {
      const repo = await this.deps.realpath(this.deps.environment.repo);
      for (const task of await this.service().list()) {
        const researching =
          task.kind === "scout" && (task.stage === "queued" || task.stage === "scouting");
        if (researching && (await isInRepository(task.repoPath, repo, this.deps.realpath)))
          return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  /** Runs one reconcile at a time; a call while one is in flight joins it. */
  reconcile(runTick: boolean): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.reconcileInFlight !== undefined) return this.reconcileInFlight;
    this.reconcileInFlight = this.reconcileOnce(runTick).finally(() => {
      this.reconcileInFlight = undefined;
    });
    return this.reconcileInFlight;
  }

  async sessionStart(): Promise<void> {
    if (this.shuttingDown) return;
    this.status.report();
    if (this.cancelTick === undefined) {
      const interval = this.deps.tickIntervalMs;
      if (!Number.isFinite(interval) || interval <= 0)
        throw new TypeError("tickIntervalMs must be a positive finite number");
      this.cancelTick = this.deps.timers.every(interval, () => {
        void this.reconcile(true).catch((error) => this.deps.logError(OPERATION_FAILED, error));
      });
    }
    await this.reconcile(true);
    await this.welcome().catch((error) => this.deps.logError(OPERATION_FAILED, error));
    if (await this.tandemCheckout()) {
      await this.onboarding()
        .sessionStart()
        .catch((error) => this.deps.logError(OPERATION_FAILED, error));
    }
  }

  /**
   * The Tandem coordinator greets the user while no other project is set up. When the popup cannot
   * open (an older Herdr, or the plugin is not linked), the same words arrive in the chat instead.
   */
  private async welcome(): Promise<void> {
    if (!(await this.tandemCheckout())) return;
    const repo = await this.deps.realpath(this.deps.environment.repo);
    const { projects } = await this.service().board();
    if (projects.some((project) => project !== repo)) return;
    try {
      await this.deps.openWelcome();
    } catch {
      await this.deps.host.perform({
        type: "deliver",
        source: "notification",
        text: WELCOME_TEXT,
        timing: "nextTurn",
        triggerTurn: false,
      });
    }
  }

  async agentStart(): Promise<Reply<"agentStart">> {
    const service = this.service();
    try {
      this.sourceStatus = sourceRefreshStatus(await service.refreshSource?.());
      this.status.agentActive = true;
    } catch (error) {
      const message = errorMessage(error);
      this.status.block(message);
      this.sourceStatus = sourceRefreshBlockedStatus(message);
    }
    this.status.report();
    const digest = buildDurableDigest(await service.list());
    const workstreams = await workstreamLines(service, this.deps.environment.repo);
    return {
      systemContext: coordinatorContext(
        this.deps.environment,
        await this.tandemContext(),
        this.sourceStatus,
        digest,
        workstreams,
      ),
    };
  }

  turnStart(): void {
    this.status.agentActive = true;
    this.status.report();
  }

  toolStart(call: ToolCall): void {
    this.status.toolStarted(call);
  }

  toolEnd(call: ToolCall): void {
    this.status.toolEnded(call);
    // Answering the model's question is taking part, like typing a message.
    if (call.kind === "ask") this.userPrompt();
  }

  /** Records whether this agent run can safely omit final reconciliation. */
  recordTurnAction(action: CoordinatorTurnAction): void {
    if (action === "other" || this.turnAction === undefined) this.turnAction = action;
  }

  /** The user's message reached the model: a thread opens, or the open one continues. */
  userPrompt(): void {
    this.threadActiveAt = this.deps.clock.now();
  }

  /** The model finished the thread; what waited for it arrives at the next reconcile. */
  closeThread(): void {
    this.threadActiveAt = undefined;
  }

  private threadOpen(): boolean {
    return (
      this.threadActiveAt !== undefined &&
      this.deps.clock.now() - this.threadActiveAt < THREAD_IDLE_MS
    );
  }

  /** Records the coordinator's own model usage; a failed ledger write is ignored. */
  async turnEnd(usage: ReplyUsage | undefined): Promise<void> {
    if (usage === undefined) return;
    const { repo } = this.deps.environment;
    await this.deps
      .appendUsage({
        at: new Date(this.deps.clock.now()).toISOString(),
        repoPath: await this.deps.realpath(repo).catch(() => repo),
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: usage.output,
        costUsd: usage.costUsd,
      })
      .catch(() => undefined);
  }

  async agentEnd(
    willContinue: boolean,
    messages: () => readonly CoordinatorMessage[] = () => [],
  ): Promise<void> {
    this.status.agentActive = willContinue;
    this.status.report();
    this.onboardingGuide?.agentEnd({ willContinue, messages });
    this.reviewPages.agentEnd({ willContinue, messages });
    if (!willContinue) {
      const traceOnly = this.turnAction === "trace";
      this.turnAction = undefined;
      if (!traceOnly) await this.reconcile(false);
    }
  }

  async compacting(): Promise<Reply<"compacting">> {
    const digest = buildDurableDigest(await this.service().list());
    const workstreams = await workstreamLines(this.service(), this.deps.environment.repo);
    return {
      context: coordinatorContext(
        this.deps.environment,
        await this.tandemContext(),
        this.sourceStatus,
        digest,
        workstreams,
      ),
      preserve: { tandemDigest: digest },
    };
  }

  async compacted(): Promise<void> {
    await this.reconcile(true);
    const digest = buildDurableDigest(await this.service().list());
    await this.deps.host.perform({
      type: "recordEntry",
      entryType: "tandem-digest",
      data: { digest },
    });
  }

  async shutdown(): Promise<void> {
    const inFlight = this.reconcileInFlight;
    this.shuttingDown = true;
    this.onboardingGuide?.stop();
    this.reviewPages.stop();
    this.cancelTick?.();
    this.cancelTick = undefined;
    try {
      if (this.createdService !== undefined) await this.createdService.shutdown();
    } finally {
      try {
        if (inFlight !== undefined) await inFlight;
      } finally {
        await this.status.reporter?.release();
      }
    }
  }

  /**
   * Sends one Herdr notification when rows of this project's that {@link notifiesUser} accepts
   * land in "Needs you". What was already there when the coordinator started counts as seen, so a
   * relaunch notifies nothing.
   */
  private async notifyOnArrival(service: TandemService): Promise<void> {
    const rows = (await service.board()).needsYou;
    const current = new Map<string, BoardRow>();
    if (rows.length > 0) {
      const repo = await this.deps.realpath(this.deps.environment.repo);
      for (const row of rows) {
        if (row.repoPath === undefined || !notifiesUser(row)) continue;
        if (await isInRepository(row.repoPath, repo, this.deps.realpath)) current.set(row.key, row);
      }
    }
    const seen = this.needsYouSeen;
    this.needsYouSeen = new Set(current.keys());
    if (seen === undefined) return;
    const arrived = [...current.values()].filter((row) => !seen.has(row.key));
    if (arrived.length === 0) return;
    await service
      .notifyNeedsYou(this.deps.environment.repo, arrived)
      .catch((error: unknown) =>
        this.deps.logError("Tandem could not show a Herdr notification", error),
      );
  }

  private async reconcileOnce(runTick: boolean): Promise<void> {
    try {
      const service = this.service();
      const tasks = runTick ? await service.tick() : await service.list();
      if (this.status.reporter !== undefined) {
        const repo = await this.deps.realpath(this.deps.environment.repo);
        this.status.setTasks(await coordinatorTaskStatus(tasks, repo, this.deps.realpath));
        this.status.report();
      }
      await deliverPendingNotifications({
        host: this.deps.host,
        service,
        tasks,
        delivered: this.deliveredNotifications,
        unacknowledged: this.unacknowledgedNotifications,
        readReport: this.deps.readReport,
        thread: { open: this.threadOpen(), held: this.heldNotifications },
      });
      await deliverPrWatchNotices({ host: this.deps.host, service });
      await this.notifyOnArrival(service);
      await deliverInvestigationQuestions({ host: this.deps.host, service });
      // Setup moves on after the user's actions, not on the timer.
      if (!runTick && (await this.tandemCheckout())) await this.onboarding().afterAction();
      // A review page opens during an action (review-show), so its listener starts after one.
      if (!runTick) this.reviewPages.afterAction();
      const idle =
        !this.status.agentActive &&
        !this.status.waitingForInput &&
        this.unacknowledgedNotifications.size === 0;
      this.compaction.compactIfAtBoundary(tasks, idle);
    } catch (error) {
      // Another process holding the state lock is routine contention the next tick retries, not
      // something for the user to act on.
      if (!(error instanceof StoreLockTimeoutError)) {
        this.status.block(errorMessage(error));
        this.status.report();
      }
      throw error;
    }
  }
}
