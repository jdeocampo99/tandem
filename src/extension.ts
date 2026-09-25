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
import type { CommandRunner } from "./contracts.ts";
import { refreshCoordinatorSourceUnlocked } from "./coordinator/source.ts";
import { ompSessionHost, ompToolCall } from "./extension/omp-host.ts";
import { registerTandemOmp } from "./extension/registration.ts";
import { type PlaybookClassifier, playbookClassifier } from "./playbooks/classify.ts";
import { appendCoordinatorUsage } from "./runtime/usage-ledger.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "./service/controller.ts";
import { coordinatorCompactTokens } from "./session/compaction.ts";
import { CoordinatorSession } from "./session/coordinator.ts";
import { readResearchReport } from "./session/notifications.ts";
import { promptRoutingConfig } from "./session/prompt-routing.ts";
import {
  type ResearchContinuationClassifier,
  researchContinuationClassifier,
  researchContinuationClassifierConfig,
} from "./tasks/research-continuation-classifier.ts";
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

function createCoordinatorService(
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The status line only needs the tool's kind, so its arguments are not classified. */
function statusToolCall(event: Readonly<{ toolCallId: string; toolName: string }>) {
  return ompToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, input: {} });
}

type BoundCoordinator = Readonly<{
  environment: TandemBoundaryEnvironment;
  session: CoordinatorSession;
}>;

/** Create the OMP extension factory; all mutable runtime state is per loaded extension instance. */
export function createTandemExtension(options: TandemExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    const environmentSnapshot = processEnvironmentSnapshot(options.processEnvironment);
    const jevConfig = researchContinuationClassifierConfig(environmentSnapshot);
    const classifyResearchContinuation = researchContinuationClassifier(jevConfig);
    const classifyPlaybook = playbookClassifier(jevConfig);
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
        status: createHerdrStatusReporter(options.run ?? runCommand, {
          cwd: ctx.cwd,
          agentLabel: "tandem-coordinator",
          ...(options.processEnvironment === undefined
            ? {}
            : { environment: options.processEnvironment }),
        }),
        logError: (message, error) => pi.logger.error(message, { error: errorMessage(error) }),
        environment,
        createService: () =>
          createCoordinatorService(
            options,
            environment,
            classifyResearchContinuation,
            classifyPlaybook,
          ),
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
    pi.on("tool_execution_start", (event, ctx) => session(ctx).toolStart(statusToolCall(event)));
    pi.on("tool_execution_end", (event, ctx) => session(ctx).toolEnd(statusToolCall(event)));
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
