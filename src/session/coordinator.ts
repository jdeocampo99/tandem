import type { TandemBoundaryEnvironment } from "../config/environment.ts";
import type { CoordinatorUsageEntry } from "../runtime/usage-receipt.ts";
import type { TandemService } from "../service/controller.ts";
import { StoreLockTimeoutError } from "../tasks/store-errors.ts";
import type { ReplyUsage } from "../workers/terminal.ts";
import { EarlyCompaction } from "./compaction.ts";
import { CoordinatorBoard } from "./coordinator-board.ts";
import { CoordinatorContext, sourceRefreshStatus } from "./coordinator-context.ts";
import type { CoordinatorMessage } from "./coordinator-reply.ts";
import { CoordinatorStatus, isInRepository } from "./coordinator-status.ts";
import type {
  Cancel,
  CoordinatorTurnAction,
  ReplyFor,
  SessionDeps,
  SessionEvent,
  ToolCall,
} from "./events.ts";
import {
  deliverInvestigationQuestions,
  deliverPendingNotifications,
  deliverPrWatchNotices,
  type ResearchReportReader,
} from "./notifications.ts";
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
    /**
     * Publishes the setup view and opens its block beside this coordinator's conversation; false
     * when the terminal has no native blocks, so setup runs in the chat.
     */
    openSetup(): Promise<boolean>;
    readReport: ResearchReportReader;
    appendUsage(entry: CoordinatorUsageEntry): Promise<void>;
    /** Context size that triggers early compaction; `0` leaves compaction to the harness. */
    compactTokens: number;
    tickIntervalMs: number;
  }>;

type Reply<T extends SessionEvent["type"]> = ReplyFor<Extract<SessionEvent, { type: T }>>;

const OPERATION_FAILED = "Tandem extension operation failed";

/** A thread closes after this much time without user participation. */
export const THREAD_IDLE_MS = 30 * 60 * 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One coordinator conversation: its scheduler, notifications, status, and compaction state. */
export class CoordinatorSession {
  private readonly status: CoordinatorStatus;
  private readonly compaction: EarlyCompaction;
  private readonly context: CoordinatorContext;
  private readonly board: CoordinatorBoard;
  private readonly deliveredNotifications = new Set<string>();
  private readonly unacknowledgedNotifications = new Set<string>();
  /** Notifications held back while a thread is open, which the user was told are waiting. */
  private readonly heldNotifications = new Set<string>();
  /** When the user last took part in the open thread; unset when no thread is open. */
  private threadActiveAt: number | undefined;

  /** The current agent run's actions; any non-trace action keeps final reconcile enabled. */
  private turnAction: CoordinatorTurnAction | undefined;
  private createdService: TandemService | undefined;
  private readonly reviewPages: ReviewPageListeners;
  private cancelTick: Cancel | undefined;
  private reconcileInFlight: Promise<void> | undefined;
  private shuttingDown: boolean = false;

  constructor(private readonly deps: CoordinatorDeps) {
    this.status = new CoordinatorStatus(deps.status);
    this.context = new CoordinatorContext(deps, () => this.service());
    this.board = new CoordinatorBoard(deps);
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
    await this.context.sessionStart();
  }

  async agentStart(): Promise<Reply<"agentStart">> {
    const service = this.service();
    try {
      this.context.sourceStatus = sourceRefreshStatus(await service.refreshSource?.());
      this.status.agentActive = true;
    } catch (error) {
      const message = errorMessage(error);
      this.status.block(message);
      this.context.sourceStatus = `SOURCE REFRESH BLOCKED: ${message}. Do not create or launch new work until the coordinator source refresh succeeds.`;
    }
    this.status.report();
    const { context } = await this.context.build(service);
    return { systemContext: context };
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
    this.reviewPages.agentEnd({ willContinue, messages });
    if (!willContinue) {
      const traceOnly = this.turnAction === "trace";
      this.turnAction = undefined;
      if (!traceOnly) await this.reconcile(false);
    }
  }

  async compacting(): Promise<Reply<"compacting">> {
    const { context, digest } = await this.context.build(this.service());
    return { context, preserve: { tandemDigest: digest } };
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

  private async reconcileOnce(runTick: boolean): Promise<void> {
    try {
      const service = this.service();
      const tasks = runTick ? await service.tick() : await service.list();
      await this.status.updateTasks(tasks, this.deps.environment.repo, this.deps.realpath);
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
      const board = await service.board();
      await this.board.publish(service, board);
      await deliverInvestigationQuestions({ host: this.deps.host, service });
      // Setup moves on after the user's actions, not on the timer.
      if (!runTick) await this.context.afterAction();
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
