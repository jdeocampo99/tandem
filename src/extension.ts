import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { runCommand } from "./adapters/commands.ts";
import {
  createHerdrStatusReporter,
  type HerdrAgentState,
  type HerdrStatusReporter,
} from "./adapters/herdr-status.ts";
import {
  coordinatorSourceGuidance,
  environmentForContext,
  processEnvironmentSnapshot,
  type TandemBoundaryEnvironment,
  type TandemEnvironmentSource,
} from "./config/environment.ts";
import { readCoordinatorMcpServers } from "./config/repositories.ts";
import type { CommandRunner, TaskRecord } from "./contracts.ts";
import { refreshCoordinatorSourceUnlocked } from "./coordinator/source.ts";
import {
  atCompactionBoundary,
  coordinatorCompactTokens,
  finishedTaskIds,
} from "./extension/compaction.ts";
import { deliverPendingNotifications, readResearchReport } from "./extension/notifications.ts";
import { type PromptRoutingConfig, promptRoutingConfig } from "./extension/prompt-routing.ts";
import {
  registerTandemOmp,
  type TandemOmpRegistrationDependencies,
} from "./extension/registration.ts";
import { buildDurableDigest } from "./extension/summary.ts";
import { COORDINATOR_INSTRUCTIONS, COORDINATOR_TOOL_GUIDANCE } from "./instructions.ts";
import { type PlaybookClassifier, playbookClassifier } from "./playbooks/classify.ts";
import { appendCoordinatorUsage } from "./runtime/usage-ledger.ts";
import {
  createTandemService,
  type SourceRefreshResult,
  type TandemService,
  type TandemServiceOptions,
} from "./service/controller.ts";
import { isMissing, isTerminalTask } from "./service/records.ts";
import { fixRoundBudget, ledgerBlockers } from "./tasks/findings.ts";
import {
  type ResearchContinuationClassifier,
  researchContinuationClassifier,
  researchContinuationClassifierConfig,
} from "./tasks/research-continuation-classifier.ts";
import { StoreLockTimeoutError } from "./tasks/store-errors.ts";
import { replyUsage } from "./workers/terminal.ts";

const DEFAULT_TICK_INTERVAL_MS = 2_000;

export type TandemExtensionOptions = Readonly<{
  readonly service?: TandemService;
  readonly createService?: (options: TandemServiceOptions) => TandemService;
  readonly environment?: Partial<TandemBoundaryEnvironment>;
  readonly processEnvironment?: TandemEnvironmentSource;
  readonly tickIntervalMs?: number;
  /** Runs the Herdr status commands; the real command runner when absent. */
  readonly run?: CommandRunner;
}>;

function serviceForContext(
  options: TandemExtensionOptions,
  environment: TandemBoundaryEnvironment,
  classifyResearchContinuation: ResearchContinuationClassifier,
  classifyPlaybook: PlaybookClassifier,
): TandemService {
  if (options.service !== undefined) return options.service;
  const sourceRepo = environment.sourceRepo;
  const createService = options.createService ?? createTandemService;
  return createService({
    home: environment.home,
    sessionId: environment.sessionId,
    ...(environment.parentWorkspaceId === undefined
      ? {}
      : { parentWorkspaceId: environment.parentWorkspaceId }),
    ...(environment.coordinatorPaneId === undefined
      ? {}
      : { coordinatorPaneId: environment.coordinatorPaneId }),
    poolRoot: environment.poolRoot,
    classifyResearchContinuation,
    classifyPlaybook,
    ...(sourceRepo === undefined
      ? {}
      : {
          sourceWorkspace: {
            repoPath: environment.repo,
            path: sourceRepo,
          },
          refreshSource: () =>
            refreshCoordinatorSourceUnlocked({
              home: environment.home,
              sessionId: environment.sessionId,
              repoPath: environment.repo,
              sourceRepoPath: sourceRepo,
              run: runCommand,
            }),
        }),
  });
}

/** Whether the task belongs to this already-resolved repository; a missing task checkout does not. */
async function isTaskInRepository(task: TaskRecord, repo: string): Promise<boolean> {
  if (task.repoPath === repo) return true;
  const taskRepo = await realpath(task.repoPath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  return taskRepo === repo;
}

async function refreshDigest(service: TandemService): Promise<string> {
  return buildDurableDigest(await service.list());
}

function logExtensionError(pi: ExtensionAPI, error: unknown): void {
  pi.logger.error("Tandem extension operation failed", {
    error: error instanceof Error ? error.message : String(error),
  });
}

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

const INITIAL_SOURCE_STATUS =
  "Source is refreshed only at the start of a new coordinator turn; tasks already created remain pinned to their captured commit.";

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

function sourceRefreshBlockedStatus(message: string): string {
  return `SOURCE REFRESH BLOCKED: ${message}. Do not create or launch new work until the coordinator source refresh succeeds.`;
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

type TaskStatus = Readonly<{ state: HerdrAgentState; message: string | undefined }>;

/**
 * The coordinator pane's task status: the first open task in this repository waiting on someone,
 * otherwise the last one working, otherwise idle.
 */
async function coordinatorTaskStatus(
  tasks: readonly TaskRecord[],
  repo: string,
): Promise<TaskStatus> {
  let status: TaskStatus = { state: "idle", message: undefined };
  for (const task of tasks) {
    if (isTerminalTask(task) || task.stage === "ready") continue;
    if (!(await isTaskInRepository(task, repo))) continue;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Herdr status of the coordinator pane: waiting for an answer, working, or its tasks' state. */
class CoordinatorStatus {
  reporter: HerdrStatusReporter | undefined;
  agentActive = false;
  private taskState: HerdrAgentState = "idle";
  private taskMessage: string | undefined;
  private readonly waitingInputs = new Set<string>();

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

  toolStarted(toolName: string, toolCallId: string): void {
    this.agentActive = true;
    if (toolName === "ask") this.waitingInputs.add(toolCallId);
    this.report();
  }

  toolEnded(toolCallId: string): void {
    this.waitingInputs.delete(toolCallId);
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
    private readonly logError: (error: unknown) => void,
  ) {}

  /** Uses every listed task, like the digest and notifications, because this coordinator sees them all. */
  compactIfAtBoundary(ctx: ExtensionContext, tasks: readonly TaskRecord[], idle: boolean): void {
    if (this.compactTokens === 0) return;
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
    const usage = ctx.getContextUsage();
    if (usage === undefined || usage.tokens < this.compactTokens) return;
    this.compacting = true;
    // Not awaited: the `session_compact` handler reconciles, and this runs inside `reconcile`.
    void ctx
      .compact()
      .catch(this.logError)
      .finally(() => {
        this.compacting = false;
      });
  }
}

/** One loaded coordinator extension's runtime state and its OMP event handlers. */
class TandemCoordinator {
  private readonly promptRouting: PromptRoutingConfig;
  private readonly classifyResearchContinuation: ResearchContinuationClassifier;
  private readonly classifyPlaybook: PlaybookClassifier;
  private readonly compaction: EarlyCompaction;
  private readonly status = new CoordinatorStatus();
  private readonly deliveredNotifications = new Set<string>();
  private readonly unacknowledgedNotifications = new Set<string>();
  private service: TandemService | undefined;
  private boundaryEnvironment: TandemBoundaryEnvironment | undefined;
  private tickTimer: Timer | undefined;
  private tickInFlight: Promise<void> | undefined;
  private sourceStatus = INITIAL_SOURCE_STATUS;
  private shuttingDown = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: TandemExtensionOptions,
  ) {
    const environmentSnapshot = processEnvironmentSnapshot(options.processEnvironment);
    this.promptRouting = promptRoutingConfig(environmentSnapshot);
    const jevConfig = researchContinuationClassifierConfig(environmentSnapshot);
    this.classifyResearchContinuation = researchContinuationClassifier(jevConfig);
    this.classifyPlaybook = playbookClassifier(jevConfig);
    this.compaction = new EarlyCompaction(coordinatorCompactTokens(environmentSnapshot), (error) =>
      logExtensionError(pi, error),
    );
  }

  environment(ctx: ExtensionContext): TandemBoundaryEnvironment {
    this.boundaryEnvironment ??= environmentForContext(this.options, ctx);
    return this.boundaryEnvironment;
  }

  getService(ctx: ExtensionContext): TandemService {
    this.service ??= serviceForContext(
      this.options,
      this.environment(ctx),
      this.classifyResearchContinuation,
      this.classifyPlaybook,
    );
    return this.service;
  }

  registrationDependencies(): TandemOmpRegistrationDependencies {
    return {
      getService: (ctx) => this.getService(ctx),
      getHome: (ctx) => this.environment(ctx).home,
      getRepo: (ctx) => this.environment(ctx).repo,
      promptRouting: this.promptRouting,
      reconcile: (ctx, runTick) => this.reconcile(ctx, runTick),
      postAction: (ctx) => this.reconcile(ctx, false),
      researchRunning: (ctx) => this.researchRunning(ctx),
      // An unreadable settings file allows no servers, so the guard fails closed.
      coordinatorMcpServers: (ctx) =>
        readCoordinatorMcpServers({
          repoPath: this.environment(ctx).repo,
          home: this.environment(ctx).home,
        }).catch(() => []),
    };
  }

  /** An unreadable task list counts as research running, so the guard fails closed. */
  private async researchRunning(ctx: ExtensionContext): Promise<boolean> {
    try {
      const repo = await realpath(this.environment(ctx).repo);
      for (const task of await this.getService(ctx).list()) {
        const researching =
          task.kind === "scout" && (task.stage === "queued" || task.stage === "scouting");
        if (researching && (await isTaskInRepository(task, repo))) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  /** Runs one reconcile at a time; a call while one is in flight joins it. */
  reconcile(ctx: ExtensionContext, runTick: boolean): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.tickInFlight !== undefined) return this.tickInFlight;
    this.tickInFlight = this.reconcileOnce(ctx, runTick).finally(() => {
      this.tickInFlight = undefined;
    });
    return this.tickInFlight;
  }

  private async reconcileOnce(ctx: ExtensionContext, runTick: boolean): Promise<void> {
    try {
      const current = this.getService(ctx);
      const tasks = runTick ? await current.tick() : await current.list();
      if (this.status.reporter !== undefined) {
        const repo = await realpath(this.environment(ctx).repo);
        this.status.setTasks(await coordinatorTaskStatus(tasks, repo));
        this.status.report();
      }
      await deliverPendingNotifications({
        pi: this.pi,
        service: current,
        tasks,
        delivered: this.deliveredNotifications,
        unacknowledged: this.unacknowledgedNotifications,
        ctx,
        readReport: readResearchReport,
      });
      const idle =
        !this.status.agentActive &&
        !this.status.waitingForInput &&
        this.unacknowledgedNotifications.size === 0;
      this.compaction.compactIfAtBoundary(ctx, tasks, idle);
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

  async onBeforeAgentStart(
    systemPrompt: readonly string[],
    ctx: ExtensionContext,
  ): Promise<{ systemPrompt: string[] }> {
    const current = this.getService(ctx);
    try {
      this.sourceStatus = sourceRefreshStatus(await current.refreshSource?.());
      this.status.agentActive = true;
    } catch (error) {
      const message = errorMessage(error);
      this.status.block(message);
      this.sourceStatus = sourceRefreshBlockedStatus(message);
    }
    this.status.report();
    const digest = await refreshDigest(current);
    return {
      systemPrompt: [
        ...systemPrompt,
        ...coordinatorContext(this.environment(ctx), this.sourceStatus, digest),
      ],
    };
  }

  async onSessionStart(ctx: ExtensionContext): Promise<void> {
    if (this.shuttingDown) return;
    this.status.reporter ??= createHerdrStatusReporter(this.options.run ?? runCommand, {
      cwd: ctx.cwd,
      agentLabel: "tandem-coordinator",
      ...(this.options.processEnvironment === undefined
        ? {}
        : { environment: this.options.processEnvironment }),
    });
    this.status.report();
    if (this.tickTimer === undefined) {
      const interval = this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
      if (!Number.isFinite(interval) || interval <= 0)
        throw new TypeError("tickIntervalMs must be a positive finite number");
      this.tickTimer = ctx.setInterval(() => {
        void this.reconcile(ctx, true).catch((error) => logExtensionError(this.pi, error));
      }, interval);
    }
    await this.reconcile(ctx, true);
  }

  onTurnStart(): void {
    this.status.agentActive = true;
    this.status.report();
  }

  onToolStart(toolName: string, toolCallId: string): void {
    this.status.toolStarted(toolName, toolCallId);
  }

  onToolEnd(toolCallId: string): void {
    this.status.toolEnded(toolCallId);
  }

  /** Records the coordinator's own model usage; a failed ledger write is ignored. */
  async onTurnEnd(message: unknown, ctx: ExtensionContext): Promise<void> {
    const reply = replyUsage(message);
    if (reply === undefined) return;
    const environment = this.environment(ctx);
    await appendCoordinatorUsage(environment.home, {
      at: new Date().toISOString(),
      repoPath: await realpath(environment.repo).catch(() => environment.repo),
      inputTokens: reply.input + reply.cacheRead + reply.cacheWrite,
      outputTokens: reply.output,
      costUsd: reply.costUsd,
    }).catch(() => undefined);
  }

  async onAgentEnd(willContinue: boolean | undefined, ctx: ExtensionContext): Promise<void> {
    this.status.agentActive = willContinue === true;
    this.status.report();
    if (!this.status.agentActive) await this.reconcile(ctx, false);
  }

  async onCompacting(
    ctx: ExtensionContext,
  ): Promise<{ context: string[]; preserveData: { tandemDigest: string } }> {
    const digest = await refreshDigest(this.getService(ctx));
    return {
      context: coordinatorContext(this.environment(ctx), this.sourceStatus, digest),
      preserveData: { tandemDigest: digest },
    };
  }

  async onCompacted(ctx: ExtensionContext): Promise<void> {
    await this.reconcile(ctx, true);
    const digest = await refreshDigest(this.getService(ctx));
    this.pi.appendEntry("tandem-digest", { digest });
  }

  async onShutdown(ctx: ExtensionContext): Promise<void> {
    const inFlight = this.tickInFlight;
    this.shuttingDown = true;
    if (this.tickTimer !== undefined) ctx.clearTimer(this.tickTimer);
    this.tickTimer = undefined;
    try {
      if (this.service !== undefined) await this.service.shutdown();
    } finally {
      try {
        if (inFlight !== undefined) await inFlight;
      } finally {
        await this.status.reporter?.release();
      }
    }
  }
}

/** Create the OMP extension factory; all mutable runtime state is per loaded extension instance. */
export function createTandemExtension(options: TandemExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    const coordinator = new TandemCoordinator(pi, options);
    registerTandemOmp(pi, coordinator.registrationDependencies());
    pi.on("before_agent_start", (event, ctx) =>
      coordinator.onBeforeAgentStart(event.systemPrompt, ctx),
    );
    pi.on("session_start", (_event, ctx) => coordinator.onSessionStart(ctx));
    pi.on("turn_start", () => coordinator.onTurnStart());
    pi.on("tool_execution_start", (event) =>
      coordinator.onToolStart(event.toolName, event.toolCallId),
    );
    pi.on("tool_execution_end", (event) => coordinator.onToolEnd(event.toolCallId));
    pi.on("turn_end", (event, ctx) => coordinator.onTurnEnd(event.message, ctx));
    pi.on("agent_end", (event, ctx) => coordinator.onAgentEnd(event.willContinue, ctx));
    pi.on("session.compacting", (_event, ctx) => coordinator.onCompacting(ctx));
    pi.on("session_compact", (_event, ctx) => coordinator.onCompacted(ctx));
    pi.on("session_shutdown", (_event, ctx) => coordinator.onShutdown(ctx));
  };
}

const defaultExtension = createTandemExtension();
export default defaultExtension;
