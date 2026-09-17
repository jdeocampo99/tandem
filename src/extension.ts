import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import {
  coordinatorSourceGuidance,
  environmentForContext,
  type TandemBoundaryEnvironment,
  type TandemEnvironmentSource,
} from "./config/environment.ts";
import {
  deliverPendingNotifications,
  listAndDeliverPendingNotifications,
} from "./extension/notifications.ts";
import { registerTandemOmp } from "./extension/registration.ts";
import { buildDurableDigest } from "./extension/summary.ts";
import { COORDINATOR_INSTRUCTIONS, COORDINATOR_TOOL_GUIDANCE } from "./instructions.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "./service/controller.ts";

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
  const createService = options.createService ?? createTandemService;
  return createService({
    home: environment.home,
    sessionId: environment.sessionId,
    ...(environment.parentWorkspaceId === undefined
      ? {}
      : { parentWorkspaceId: environment.parentWorkspaceId }),
    poolRoot: environment.poolRoot,
    ...(environment.sourceRepo === undefined
      ? {}
      : {
          sourceWorkspace: {
            repoPath: environment.repo,
            path: environment.sourceRepo,
          },
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
    let service: TandemService | undefined;
    let boundaryEnvironment: TandemBoundaryEnvironment | undefined;
    const getEnvironment = (ctx: ExtensionContext): TandemBoundaryEnvironment => {
      if (boundaryEnvironment === undefined)
        boundaryEnvironment = environmentForContext(options, ctx);
      return boundaryEnvironment;
    };
    let tickTimer: Timer | undefined;
    let tickInFlight: Promise<void> | undefined;
    let shuttingDown = false;
    const deliveredNotifications = new Set<string>();
    const getService = (ctx: ExtensionContext): TandemService => {
      if (service === undefined) service = serviceForContext(options, ctx, getEnvironment(ctx));
      return service;
    };
    const reconcile = async (ctx: ExtensionContext, runTick: boolean): Promise<void> => {
      if (shuttingDown) return;
      if (tickInFlight !== undefined) return tickInFlight;
      tickInFlight = (async (): Promise<void> => {
        const current = getService(ctx);
        const tasks = runTick ? await current.tick() : await current.list();
        await deliverPendingNotifications(pi, current, tasks, deliveredNotifications, ctx);
      })().finally(() => {
        tickInFlight = undefined;
      });
      return tickInFlight;
    };
    const postAction = async (ctx: ExtensionContext): Promise<void> => {
      await listAndDeliverPendingNotifications(pi, getService(ctx), deliveredNotifications, ctx);
    };
    registerTandemOmp(pi, { getService, reconcile, postAction });

    pi.on("before_agent_start", async (event, ctx) => {
      const digest = await refreshDigest(getService(ctx));
      return {
        systemPrompt: [
          ...event.systemPrompt,
          COORDINATOR_INSTRUCTIONS,
          COORDINATOR_TOOL_GUIDANCE,
          coordinatorSourceGuidance(getEnvironment(ctx)),
          digest,
        ],
      };
    });

    pi.on("session_start", async (_event, ctx) => {
      if (shuttingDown) return;
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

    pi.on("session.compacting", async (_event, ctx) => {
      const digest = await refreshDigest(getService(ctx));
      return {
        context: [
          COORDINATOR_INSTRUCTIONS,
          COORDINATOR_TOOL_GUIDANCE,
          coordinatorSourceGuidance(getEnvironment(ctx)),
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
        if (inFlight !== undefined) await inFlight;
      }
    });
  };
}

const defaultExtension = createTandemExtension();
export default defaultExtension;
