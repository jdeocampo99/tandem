import { realpath } from "node:fs/promises";
import { runCommand } from "../adapters/commands.ts";
import {
  environmentForContext,
  processEnvironmentSnapshot,
  type TandemBoundaryEnvironment,
  type TandemEnvironmentSource,
} from "../config/environment.ts";
import type { CommandRunner } from "../contracts.ts";
import { canonicalPath } from "../coordinator/record.ts";
import { refreshCoordinatorSourceUnlocked } from "../coordinator/source.ts";
import { isTandemCheckout } from "../coordinator/tandem-checkout.ts";
import { publishViews } from "../native/store.ts";
import { playbookClassifier } from "../playbooks/classify.ts";
import { briefLanguageChecker } from "../requests/plain-language.ts";
import { appendCoordinatorUsage } from "../runtime/usage-ledger.ts";
import { issueDraftChecker } from "../self-improvement/issue-draft.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "../service/controller.ts";
import { coordinatorCompactTokens } from "../session/compaction.ts";
import { CoordinatorSession } from "../session/coordinator.ts";
import type { SessionDeps } from "../session/events.ts";
import { readResearchReport } from "../session/notifications.ts";
import {
  researchContinuationClassifier,
  researchContinuationClassifierConfig,
} from "../tasks/research-continuation-classifier.ts";
import { terminalBackend } from "../terminal-backend/compose.ts";

const DEFAULT_TICK_INTERVAL_MS = 2_000;

/** What a coordinator adapter may override; production leaves every field unset. */
export type CoordinatorOptions = Readonly<{
  readonly service?: TandemService;
  readonly createService?: (options: TandemServiceOptions) => TandemService;
  readonly environment?: Partial<TandemBoundaryEnvironment>;
  readonly processEnvironment?: TandemEnvironmentSource;
  readonly tickIntervalMs?: number;
  /** Runs the terminal's status commands; the real command runner when absent. */
  readonly run?: CommandRunner;
}>;

/** What only the harness supplies: where effects go, its timers, and its log. */
export type CoordinatorHarness = Pick<SessionDeps, "host" | "timers" | "logError"> &
  Readonly<{ cwd: string; sessionId: string }>;

export type BoundCoordinator = Readonly<{
  environment: TandemBoundaryEnvironment;
  session: CoordinatorSession;
}>;

function createCoordinatorService(
  options: CoordinatorOptions,
  environment: TandemBoundaryEnvironment,
  environmentSnapshot: TandemEnvironmentSource,
): TandemService {
  if (options.service !== undefined) return options.service;
  const jevConfig = researchContinuationClassifierConfig(environmentSnapshot);
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
    classifyResearchContinuation: researchContinuationClassifier(jevConfig),
    classifyPlaybook: playbookClassifier(jevConfig),
    checkIssueDraft: issueDraftChecker(jevConfig),
    checkBriefLanguage: briefLanguageChecker(jevConfig),
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
              terminal: terminalBackend(runCommand, { home: environment.home }),
            }),
        }),
  });
}

/** One coordinator conversation's session, on whichever harness `harness` describes. */
export function bindCoordinator(
  options: CoordinatorOptions,
  harness: CoordinatorHarness,
): BoundCoordinator {
  const environmentSnapshot = processEnvironmentSnapshot(options.processEnvironment);
  const environment = environmentForContext(options, {
    cwd: harness.cwd,
    sessionId: harness.sessionId,
  });
  const terminal = terminalBackend(options.run ?? runCommand, { home: environment.home });
  let service: TandemService | undefined;
  // One service per session: the setup block reads the same one the conversation uses.
  const coordinatorService = (): TandemService =>
    (service ??= createCoordinatorService(options, environment, environmentSnapshot));
  const session = new CoordinatorSession({
    host: harness.host,
    clock: { now: () => Date.now(), monotonic: () => performance.now() },
    timers: harness.timers,
    status: terminal.agentStatusReporter({
      cwd: harness.cwd,
      agentLabel: "tandem-coordinator",
      ...(options.processEnvironment === undefined
        ? {}
        : { environment: options.processEnvironment }),
    }),
    logError: harness.logError,
    environment,
    createService: coordinatorService,
    realpath: (path) => realpath(path),
    isTandemCheckout: () => isTandemCheckout(environment.repo),
    openWelcome: async () => {
      if (environment.coordinatorPaneId === undefined) {
        throw new Error("the coordinator is not running in a Tandem Herdr pane");
      }
      await terminal.openWelcome({
        sessionId: environment.sessionId,
        cwd: harness.cwd,
        paneId: environment.coordinatorPaneId,
      });
    },
    openSetup: async () => {
      // Herdr has no native blocks; its setup runs in the chat, and nothing is published for it.
      if (terminal.views === undefined) return false;
      if (environment.coordinatorPaneId === undefined) {
        throw new Error("the coordinator is not running in a Tandem Tern pane");
      }
      const setup = await coordinatorService().setupView(environment.repo, "setup");
      await publishViews(environment.home, await canonicalPath(environment.repo, "repoPath"), async () => ({
        setup,
      }));
      return terminal.openSetup({
        sessionId: environment.sessionId,
        cwd: harness.cwd,
        paneId: environment.coordinatorPaneId,
      });
    },
    readReport: readResearchReport,
    appendUsage: (entry) => appendCoordinatorUsage(environment.home, entry),
    compactTokens: coordinatorCompactTokens(environmentSnapshot),
    tickIntervalMs: options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
  });
  return { environment, session };
}
