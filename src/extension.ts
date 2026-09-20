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
import { refreshCoordinatorSourceUnlocked } from "./coordinator/source.ts";
import { deliverPendingNotifications } from "./extension/notifications.ts";
import { promptRoutingConfig } from "./extension/prompt-routing.ts";
import { registerTandemOmp } from "./extension/registration.ts";
import { buildDurableDigest } from "./extension/summary.ts";
import { COORDINATOR_INSTRUCTIONS, COORDINATOR_TOOL_GUIDANCE } from "./instructions.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "./service/controller.ts";
import { isMissing, isTerminalTask } from "./service/records.ts";

const DEFAULT_TICK_INTERVAL_MS = 2_000;

export type TandemExtensionOptions = Readonly<{
  readonly service?: TandemService;
  readonly createService?: (options: TandemServiceOptions) => TandemService;
  readonly environment?: Partial<TandemBoundaryEnvironment>;
  readonly processEnvironment?: TandemEnvironmentSource;
  readonly tickIntervalMs?: number;
}>;

function serviceForContext(
  options: TandemExtensionOptions,
  ctx: ExtensionContext,
  resolvedEnvironment?: TandemBoundaryEnvironment,
): TandemService {
  if (options.service !== undefined) return options.service;
  const environment = resolvedEnvironment ?? environmentForContext(options, ctx);
  const sourceRepo = environment.sourceRepo;
  const createService = options.createService ?? createTandemService;
  return createService({
    home: environment.home,
    sessionId: environment.sessionId,
    ...(environment.parentWorkspaceId === undefined
      ? {}
      : { parentWorkspaceId: environment.parentWorkspaceId }),
    poolRoot: environment.poolRoot,
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

async function refreshDigest(service: TandemService): Promise<string> {
  return buildDurableDigest(await service.list());
}

function logExtensionError(pi: ExtensionAPI, error: unknown): void {
  pi.logger.error("Tandem extension operation failed", {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Create the OMP extension factory; all mutable runtime state is per loaded extension instance. */
export function createTandemExtension(options: TandemExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    const promptRouting = promptRoutingConfig(
      processEnvironmentSnapshot(options.processEnvironment),
    );
    let service: TandemService | undefined;
    let boundaryEnvironment: TandemBoundaryEnvironment | undefined;
    const getEnvironment = (ctx: ExtensionContext): TandemBoundaryEnvironment => {
      if (boundaryEnvironment === undefined)
        boundaryEnvironment = environmentForContext(options, ctx);
      return boundaryEnvironment;
    };
    let tickTimer: Timer | undefined;
    let tickInFlight: Promise<void> | undefined;
    let sourceStatus =
      "Source is refreshed only at the start of a new coordinator turn; tasks already created remain pinned to their captured commit.";
    let shuttingDown = false;
    let statusReporter: HerdrStatusReporter | undefined;
    let agentActive = false;
    let taskState: HerdrAgentState = "idle";
    let taskMessage: string | undefined;
    const waitingInputs = new Set<string>();
    const reportStatus = (): void => {
      if (waitingInputs.size > 0) {
        void statusReporter?.report("blocked", "Waiting for your answer");
      } else if (agentActive) {
        void statusReporter?.report("working");
      } else {
        void statusReporter?.report(taskState, taskMessage);
      }
    };
    const deliveredNotifications = new Set<string>();
    const getService = (ctx: ExtensionContext): TandemService => {
      if (service === undefined) service = serviceForContext(options, ctx, getEnvironment(ctx));
      return service;
    };
    const reconcile = async (ctx: ExtensionContext, runTick: boolean): Promise<void> => {
      if (shuttingDown) return;
      if (tickInFlight !== undefined) return tickInFlight;
      tickInFlight = (async (): Promise<void> => {
        try {
          const current = getService(ctx);
          const tasks = runTick ? await current.tick() : await current.list();
          if (statusReporter !== undefined) {
            const repo = await realpath(getEnvironment(ctx).repo);
            taskState = "idle";
            taskMessage = undefined;
            for (const task of tasks) {
              if (isTerminalTask(task) || task.stage === "ready") continue;
              const taskRepo =
                task.repoPath === repo
                  ? repo
                  : await realpath(task.repoPath).catch((error: unknown) => {
                      if (isMissing(error)) return undefined;
                      throw error;
                    });
              if (taskRepo !== repo) continue;
              if (
                task.stage === "blocked" ||
                task.stage === "paused" ||
                task.stage === "awaiting-approval"
              ) {
                taskState = "blocked";
                taskMessage = task.blockReason ?? `${task.stage}: ${task.objective}`;
                break;
              }
              taskState = "working";
            }
            reportStatus();
          }
          await deliverPendingNotifications(pi, current, tasks, deliveredNotifications, ctx);
        } catch (error) {
          taskState = "blocked";
          taskMessage = error instanceof Error ? error.message : String(error);
          reportStatus();
          throw error;
        }
      })().finally(() => {
        tickInFlight = undefined;
      });
      return tickInFlight;
    };
    const postAction = async (ctx: ExtensionContext): Promise<void> => {
      await reconcile(ctx, false);
    };
    registerTandemOmp(pi, {
      getService,
      getHome: (ctx) => getEnvironment(ctx).home,
      promptRouting,
      reconcile,
      postAction,
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const current = getService(ctx);
      try {
        const refreshed = await current.refreshSource?.();
        if (refreshed?.changed === true) {
          sourceStatus = `Coordinator source advanced from ${refreshed.previousHead} to ${refreshed.head}; earlier file observations and repository guidance may be stale. Existing tasks remain pinned to their captured commits.`;
        } else if (refreshed?.localOnly) {
          sourceStatus =
            "Coordinator source is local-only; no origin/main refresh is configured. Existing tasks remain pinned to their captured commits.";
        } else {
          sourceStatus =
            "Coordinator source is current for this turn. Existing tasks remain pinned to their captured commits.";
        }
      } catch (error) {
        taskState = "blocked";
        taskMessage = error instanceof Error ? error.message : String(error);
        sourceStatus = `SOURCE REFRESH BLOCKED: ${taskMessage}. Do not create or launch new work until the coordinator source refresh succeeds.`;
        reportStatus();
        const digest = await refreshDigest(current);
        return {
          systemPrompt: [
            ...event.systemPrompt,
            COORDINATOR_INSTRUCTIONS,
            COORDINATOR_TOOL_GUIDANCE,
            coordinatorSourceGuidance(getEnvironment(ctx)),
            sourceStatus,
            digest,
          ],
        };
      }
      agentActive = true;
      reportStatus();
      const digest = await refreshDigest(current);
      return {
        systemPrompt: [
          ...event.systemPrompt,
          COORDINATOR_INSTRUCTIONS,
          COORDINATOR_TOOL_GUIDANCE,
          coordinatorSourceGuidance(getEnvironment(ctx)),
          sourceStatus,
          digest,
        ],
      };
    });

    pi.on("session_start", async (_event, ctx) => {
      if (shuttingDown) return;
      statusReporter ??= createHerdrStatusReporter(runCommand, {
        cwd: ctx.cwd,
        agentLabel: "tandem-coordinator",
        ...(options.processEnvironment === undefined
          ? {}
          : { environment: options.processEnvironment }),
      });
      reportStatus();
      if (tickTimer === undefined) {
        const interval = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
        if (!Number.isFinite(interval) || interval <= 0)
          throw new TypeError("tickIntervalMs must be a positive finite number");
        tickTimer = ctx.setInterval(() => {
          void reconcile(ctx, true).catch((error) => logExtensionError(pi, error));
        }, interval);
      }
      await reconcile(ctx, true);
    });
    pi.on("turn_start", () => {
      agentActive = true;
      reportStatus();
    });
    pi.on("tool_execution_start", (event) => {
      agentActive = true;
      if (event.toolName === "ask") waitingInputs.add(event.toolCallId);
      reportStatus();
    });
    pi.on("tool_execution_end", (event) => {
      waitingInputs.delete(event.toolCallId);
      reportStatus();
    });
    pi.on("agent_end", async (event, ctx) => {
      agentActive = event.willContinue === true;
      reportStatus();
      if (!agentActive) await reconcile(ctx, false);
    });

    pi.on("session.compacting", async (_event, ctx) => {
      const digest = await refreshDigest(getService(ctx));
      return {
        context: [
          COORDINATOR_INSTRUCTIONS,
          COORDINATOR_TOOL_GUIDANCE,
          coordinatorSourceGuidance(getEnvironment(ctx)),
          sourceStatus,
          digest,
        ],
        preserveData: { tandemDigest: digest },
      };
    });

    pi.on("session_compact", async (_event, ctx) => {
      await reconcile(ctx, true);
      const digest = await refreshDigest(getService(ctx));
      pi.appendEntry("tandem-digest", { digest });
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const inFlight = tickInFlight;
      shuttingDown = true;
      if (tickTimer !== undefined) ctx.clearTimer(tickTimer);
      tickTimer = undefined;
      try {
        if (service !== undefined) await service.shutdown();
      } finally {
        try {
          if (inFlight !== undefined) await inFlight;
        } finally {
          await statusReporter?.release();
        }
      }
    });
  };
}

const defaultExtension = createTandemExtension();
export default defaultExtension;
