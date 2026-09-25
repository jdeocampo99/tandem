import type { HerdrAgentState, HerdrStatusReporter } from "../adapters/herdr-status.ts";
import {
  coordinatorSourceGuidance,
  type TandemBoundaryEnvironment,
} from "../config/environment.ts";
import type { TaskRecord } from "../contracts.ts";
import { COORDINATOR_INSTRUCTIONS, COORDINATOR_TOOL_GUIDANCE } from "../instructions.ts";
import type { CoordinatorUsageEntry } from "../runtime/usage-receipt.ts";
import type { SourceRefreshResult, TandemService } from "../service/controller.ts";
import { isMissing, isTerminalTask } from "../service/records.ts";
import { fixRoundBudget, ledgerBlockers } from "../tasks/findings.ts";
import type { ReplyUsage } from "../workers/terminal.ts";
import { atCompactionBoundary, finishedTaskIds } from "./compaction.ts";
import type {
  Cancel,
  ReplyFor,
  SessionDeps,
  SessionEvent,
  SessionHost,
  ToolCall,
} from "./events.ts";
import { deliverPendingNotifications, type ResearchReportReader } from "./notifications.ts";
import { buildDurableDigest } from "./summary.ts";

export type CoordinatorDeps = SessionDeps &
  Readonly<{
    environment: TandemBoundaryEnvironment;
    /** Called once, on first use, so a bad service configuration fails where it is needed. */
    createService(): TandemService;
    realpath(path: string): Promise<string>;
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
  const blockers = ledgerBlockers(task.findingLedger ?? []).length;
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

function sourceRefreshBlockedStatus(message: string): string {
  return `SOURCE REFRESH BLOCKED: ${message}. Do not create or launch new work until the coordinator source refresh succeeds.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The standing coordinator context: instructions, source boundary and freshness, and the digest. */
function coordinatorContext(
  environment: TandemBoundaryEnvironment,
  sourceStatus: string,
  digest: string,
): string[] {
  return [
    COORDINATOR_INSTRUCTIONS,
    COORDINATOR_TOOL_GUIDANCE,
    coordinatorSourceGuidance(environment),
    sourceStatus,
    digest,
  ];
}

/** Whether the task belongs to this already-resolved repository; a missing task checkout does not. */
async function isTaskInRepository(
  task: TaskRecord,
  repo: string,
  realpath: CoordinatorDeps["realpath"],
): Promise<boolean> {
  if (task.repoPath === repo) return true;
  const taskRepo = await realpath(task.repoPath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  return taskRepo === repo;
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
    if (!(await isTaskInRepository(task, repo, realpath))) continue;
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
  private createdService: TandemService | undefined;
  private cancelTick: Cancel | undefined;
  private reconcileInFlight: Promise<void> | undefined;
  private sourceStatus = INITIAL_SOURCE_STATUS;
  private shuttingDown = false;

  constructor(private readonly deps: CoordinatorDeps) {
    this.status = new CoordinatorStatus(deps.status);
    this.compaction = new EarlyCompaction(deps.compactTokens, deps.host, deps.logError);
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
        if (researching && (await isTaskInRepository(task, repo, this.deps.realpath))) return true;
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
    return { systemContext: coordinatorContext(this.deps.environment, this.sourceStatus, digest) };
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

  async agentEnd(willContinue: boolean): Promise<void> {
    this.status.agentActive = willContinue;
    this.status.report();
    if (!willContinue) await this.reconcile(false);
  }

  async compacting(): Promise<Reply<"compacting">> {
    const digest = buildDurableDigest(await this.service().list());
    return {
      context: coordinatorContext(this.deps.environment, this.sourceStatus, digest),
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
      });
      const idle =
        !this.status.agentActive &&
        !this.status.waitingForInput &&
        this.unacknowledgedNotifications.size === 0;
      this.compaction.compactIfAtBoundary(tasks, idle);
    } catch (error) {
      this.status.block(errorMessage(error));
      this.status.report();
      throw error;
    }
  }
}
