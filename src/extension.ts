import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { runCommand } from "./adapters/commands.ts";
import { createHerdrStatusReporter } from "./adapters/herdr-status.ts";
import {
  environmentForContext,
  processEnvironmentSnapshot,
  type TandemBoundaryEnvironment,
  type TandemEnvironmentSource,
} from "./config/environment.ts";
import { readCoordinatorMcpServers } from "./config/repositories.ts";
import { refreshCoordinatorSourceUnlocked } from "./coordinator/source.ts";
import { registerTandemOmp } from "./extension/registration.ts";
import { appendCoordinatorUsage } from "./runtime/usage-ledger.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "./service/controller.ts";
import { coordinatorCompactTokens } from "./session/compaction.ts";
import { CoordinatorSession } from "./session/coordinator.ts";
import type { SessionEffect, SessionHost, ToolCall } from "./session/events.ts";
import { readResearchReport } from "./session/notifications.ts";
import { promptRoutingConfig } from "./session/prompt-routing.ts";
import {
  type ResearchContinuationClassifier,
  researchContinuationClassifier,
  researchContinuationClassifierConfig,
} from "./tasks/research-continuation-classifier.ts";
import { assertSelectedModel, expectedModelParts } from "./workers/protocol.ts";
import { replyUsage } from "./workers/terminal.ts";

const DEFAULT_TICK_INTERVAL_MS = 2_000;

export type TandemExtensionOptions = Readonly<{
  readonly service?: TandemService;
  readonly createService?: (options: TandemServiceOptions) => TandemService;
  readonly environment?: Partial<TandemBoundaryEnvironment>;
  readonly processEnvironment?: TandemEnvironmentSource;
  readonly tickIntervalMs?: number;
}>;

/** The custom message type each delivered message is saved under in the OMP session. */
const DELIVERY_MESSAGE_TYPE: Readonly<
  Record<Extract<SessionEffect, { type: "deliver" }>["source"], string>
> = {
  notification: "tandem-notification",
  "prompt-route": "tandem-prompt-route",
  "stall-reminder": "tandem-stall-reminder",
};

function createCoordinatorService(
  options: TandemExtensionOptions,
  environment: TandemBoundaryEnvironment,
  classifyResearchContinuation: ResearchContinuationClassifier,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** OMP's MCP tool name prefix for a server, matching how OMP sanitizes server names. */
function mcpToolPrefix(server: string): string {
  const sanitized = server
    .toLowerCase()
    .replace(/[^a-z_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `mcp__${sanitized.length > 0 ? sanitized : "server"}_`;
}

/** A hidden part goes first as its own `display: false` message; only the shown one triggers a turn. */
async function performOmpEffect(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  effect: SessionEffect,
): Promise<void> {
  switch (effect.type) {
    case "deliver": {
      const customType = DELIVERY_MESSAGE_TYPE[effect.source];
      if (effect.hidden !== undefined) {
        pi.sendMessage(
          {
            customType,
            content: effect.hidden.text,
            display: false,
            ...(effect.hidden.details === undefined ? {} : { details: effect.hidden.details }),
            attribution: "agent",
          },
          { deliverAs: effect.timing },
        );
      }
      pi.sendMessage(
        {
          customType,
          content: effect.text,
          display: true,
          attribution: "agent",
          ...(effect.details === undefined ? {} : { details: effect.details }),
        },
        { deliverAs: effect.timing, ...(effect.triggerTurn ? { triggerTurn: true } : {}) },
      );
      return;
    }
    case "promptAsUser":
      pi.sendUserMessage(effect.text);
      return;
    case "notify":
      ctx.ui.notify(effect.text, effect.level);
      return;
    case "recordEntry":
      pi.appendEntry(effect.entryType, effect.data);
      return;
    case "compact":
      return ctx.compact();
    case "abort":
      ctx.abort();
      return;
    case "shutdown":
      ctx.shutdown();
      return;
  }
}

/** Every call reads the latest OMP context, the one of the event being handled. */
function ompSessionHost(pi: ExtensionAPI, currentContext: () => ExtensionContext): SessionHost {
  return {
    capabilities: {
      proactiveCompaction: true,
      hiddenMessages: true,
      streamingProgress: true,
      perActionApproval: true,
    },
    perform: (effect) => performOmpEffect(pi, currentContext(), effect),
    confirm: async (title, message) => {
      const ctx = currentContext();
      return ctx.hasUI && ctx.mode === "tui" ? ctx.ui.confirm(title, message) : false;
    },
    contextTokens: () => currentContext().getContextUsage()?.tokens,
    paneState: () => {
      const ctx = currentContext();
      return {
        idle: ctx.isIdle(),
        pendingMessages: ctx.hasPendingMessages(),
        draft: ctx.ui.getEditorText().trim().length > 0,
      };
    },
    assertSelectedModel: (selector) =>
      assertSelectedModel(expectedModelParts(selector), currentContext().model),
    mcpToolPrefix,
  };
}

function toolCall(event: Readonly<{ toolCallId: string; toolName: string }>): ToolCall {
  return {
    id: event.toolCallId,
    name: event.toolName,
    kind: event.toolName === "ask" ? "ask" : "other",
  };
}

type BoundCoordinator = Readonly<{
  environment: TandemBoundaryEnvironment;
  session: CoordinatorSession;
}>;

/** Create the OMP extension factory; all mutable runtime state is per loaded extension instance. */
export function createTandemExtension(options: TandemExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    const environmentSnapshot = processEnvironmentSnapshot(options.processEnvironment);
    const classifyResearchContinuation = researchContinuationClassifier(
      researchContinuationClassifierConfig(environmentSnapshot),
    );
    let latestContext: ExtensionContext;
    let bound: BoundCoordinator | undefined;

    /** The session is built from the first context, since its environment depends on the cwd. */
    const bind = (ctx: ExtensionContext): BoundCoordinator => {
      const environment = environmentForContext(options, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      const currentContext = (): ExtensionContext => latestContext;
      const session = new CoordinatorSession({
        host: ompSessionHost(pi, currentContext),
        clock: { now: () => Date.now(), monotonic: () => performance.now() },
        timers: {
          every: (ms, run) => {
            const timerContext = currentContext();
            const timer = timerContext.setInterval(run, ms);
            return () => timerContext.clearTimer(timer);
          },
          after: (ms, run) => {
            const timerContext = currentContext();
            const timer = timerContext.setTimeout(run, ms);
            return () => timerContext.clearTimer(timer);
          },
        },
        status: createHerdrStatusReporter(runCommand, {
          cwd: ctx.cwd,
          agentLabel: "tandem-coordinator",
          ...(options.processEnvironment === undefined
            ? {}
            : { environment: options.processEnvironment }),
        }),
        logError: (message, error) => pi.logger.error(message, { error: errorMessage(error) }),
        environment,
        createService: () =>
          createCoordinatorService(options, environment, classifyResearchContinuation),
        realpath: (path) => realpath(path),
        readReport: readResearchReport,
        appendUsage: (entry) => appendCoordinatorUsage(environment.home, entry),
        compactTokens: coordinatorCompactTokens(environmentSnapshot),
        tickIntervalMs: options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
      });
      return { environment, session };
    };
    const coordinator = (ctx: ExtensionContext): BoundCoordinator => {
      latestContext = ctx;
      bound ??= bind(ctx);
      return bound;
    };
    const session = (ctx: ExtensionContext): CoordinatorSession => coordinator(ctx).session;

    registerTandemOmp(pi, {
      getService: (ctx) => session(ctx).service(),
      getHome: (ctx) => coordinator(ctx).environment.home,
      getRepo: (ctx) => coordinator(ctx).environment.repo,
      promptRouting: promptRoutingConfig(environmentSnapshot),
      reconcile: (ctx, runTick) => session(ctx).reconcile(runTick),
      postAction: (ctx) => session(ctx).reconcile(false),
      researchRunning: (ctx) => session(ctx).researchRunning(),
      // An unreadable settings file allows no servers, so the guard fails closed.
      coordinatorMcpServers: (ctx) => {
        const { repo, home } = coordinator(ctx).environment;
        return readCoordinatorMcpServers({ repoPath: repo, home }).catch(() => []);
      },
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const { systemContext } = await session(ctx).agentStart();
      return { systemPrompt: [...event.systemPrompt, ...systemContext] };
    });
    pi.on("session_start", (_event, ctx) => session(ctx).sessionStart());
    pi.on("turn_start", (_event, ctx) => session(ctx).turnStart());
    pi.on("tool_execution_start", (event, ctx) => session(ctx).toolStart(toolCall(event)));
    pi.on("tool_execution_end", (event, ctx) => session(ctx).toolEnd(toolCall(event)));
    pi.on("turn_end", (event, ctx) => session(ctx).turnEnd(replyUsage(event.message)));
    pi.on("agent_end", (event, ctx) => session(ctx).agentEnd(event.willContinue === true));
    pi.on("session.compacting", async (_event, ctx) => {
      const { context, preserve } = await session(ctx).compacting();
      return { context: [...context], preserveData: { ...preserve } };
    });
    pi.on("session_compact", (_event, ctx) => session(ctx).compacted());
    pi.on("session_shutdown", async (_event, ctx) => {
      if (bound === undefined) return;
      latestContext = ctx;
      await bound.session.shutdown();
    });
  };
}

const defaultExtension = createTandemExtension();
export default defaultExtension;
