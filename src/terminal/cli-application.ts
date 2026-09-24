import { runCommand } from "../adapters/commands.ts";
import {
  resolveTandemEnvironment,
  type TandemBoundaryEnvironment,
  type TandemEnvironmentSource,
} from "../config/environment.ts";
import type { CommandRunner } from "../contracts.ts";
import { PARALLEL_COORDINATORS_VARIABLE } from "../coordinator/exclusivity.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "../service/controller.ts";
import type { CliInvocation, CliResult } from "./cli-arguments.ts";
import { type CliCapabilities, runCliCommand } from "./cli-commands.ts";
import {
  type CliSignalSource,
  defaultRunInteractive,
  defaultSleep,
  defaultStartPersistent,
  defaultStatPath,
  type PathStat,
  type RunInteractive,
  type Sleep,
  type StartPersistent,
  type WatchControl,
} from "./cli-process.ts";

const DEFAULT_COORDINATOR_SESSION = "tandem";

export type CliDependencies = Readonly<{
  readonly cwd?: string;
  readonly processEnvironment?: TandemEnvironmentSource;
  readonly run?: CommandRunner;
  readonly service?: TandemService;
  readonly createService?: (options: TandemServiceOptions) => TandemService;
  readonly statPath?: (path: string) => Promise<PathStat>;
  readonly startPersistent?: StartPersistent;
  readonly runInteractive?: RunInteractive;
  readonly sleep?: Sleep;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly processSignals?: CliSignalSource;
}>;

function environmentSource(): TandemEnvironmentSource {
  const keys = [
    "XDG_CONFIG_HOME",
    "TANDEM_HOME",
    "TANDEM_SESSION",
    "TANDEM_PARENT_WORKSPACE",
    "TANDEM_POOL_ROOT",
    "TANDEM_REPO",
    "TANDEM_SOURCE_REPO",
    PARALLEL_COORDINATORS_VARIABLE,
    "HERDR_ENV",
    "HERDR_SESSION",
    "HERDR_SESSION_NAME",
    "HERDR_WORKSPACE_ID",
    "HERDR_PANE_ID",
  ];
  const source: Record<string, string | undefined> = {};
  for (const key of keys) source[key] = process.env[key];
  return source;
}

function resolveEnvironment(
  invocation: CliInvocation,
  dependencies: CliDependencies,
): TandemBoundaryEnvironment {
  const source = dependencies.processEnvironment ?? environmentSource();
  const cwd = dependencies.cwd ?? process.cwd();
  return resolveTandemEnvironment(
    source,
    { cwd, sessionId: DEFAULT_COORDINATOR_SESSION },
    {
      ...(invocation.options.home === undefined ? {} : { home: invocation.options.home }),
      ...(invocation.options.sessionId === undefined
        ? {}
        : { sessionId: invocation.options.sessionId }),
      ...(invocation.options.parentWorkspaceId === undefined
        ? {}
        : { parentWorkspaceId: invocation.options.parentWorkspaceId }),
      ...(invocation.options.poolRoot === undefined
        ? {}
        : { poolRoot: invocation.options.poolRoot }),
      ...(invocation.options.repo === undefined ? {} : { repo: invocation.options.repo }),
    },
  );
}

function serviceOptions(environment: TandemBoundaryEnvironment): TandemServiceOptions {
  return {
    home: environment.home,
    sessionId: environment.sessionId,
    ...(environment.parentWorkspaceId === undefined
      ? {}
      : { parentWorkspaceId: environment.parentWorkspaceId }),
    ...(environment.coordinatorPaneId === undefined
      ? {}
      : { coordinatorPaneId: environment.coordinatorPaneId }),
    poolRoot: environment.poolRoot,
    ...(environment.sourceRepo === undefined
      ? {}
      : {
          sourceWorkspace: {
            repoPath: environment.repo,
            path: environment.sourceRepo,
          },
        }),
  };
}

const HELP_TEXT = `Tandem coordinator\n\nUsage: bun src/cli.ts [command] [options]\n\nCommands:\n  launch       Launch the OMP coordinator in the owned Herdr context\n  restart      Restart one managed worker task without changing its identity\n  models       List available OMP models and saved global role choices\n  configure-models  Validate and save global role choices (requires --input FILE --yes)\n  doctor       Check model, Herdr, policy, and coordinator files without mutating\n  setup        Propose or write Tandem-owned per-repository policy (requires --yes)\n  onboard      Inspect Tandem-owned policy and validation surfaces\n  create       Create a scout or implementation task\n  list/status   List durable tasks\n  show         Show one durable task\n  inspect     Inspect durable task, jobs, panes, artifacts, leases, and PR state\n  delivery-preflight  Check exact reviewed HEAD and publication readiness\n  messages     Inspect steer/answer delivery and blocker questions\n  steer        Queue a concise user direction for a task\n  answer       Answer the task's current needs-decision question\n  approve      Approve implementation scope (requires --yes)\n  tick/watch  Advance bounded scheduler work\n  pause/resume/cancel  Control owned task work\n  present/feedback/presentations  Route and inspect visual work\n  pr describe/publish/merge  Record or publish reviewed PR work\n  cleanup      Release owned resources; --discard requires --yes\n\nSafety options:\n  --yes        Explicit human automation consent for approval-bearing commands\n  --json       Emit one JSON result for automation\n  --headless   Use a named headless Herdr server\n  --no-attach  Do not launch a GUI; use headless Herdr\n`;

export type CliApplication = Readonly<{
  readonly invoke: (invocation: CliInvocation, signal?: AbortSignal) => Promise<CliResult>;
  readonly shutdown: () => Promise<void>;
}>;

/** Build the effectful CLI application with all process and service capabilities injectable. */
export function createCliApplication(dependencies: CliDependencies = {}): CliApplication {
  let service = dependencies.service;
  const serviceOwned = dependencies.service === undefined;
  let activeWatch: WatchControl | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const capabilities: CliCapabilities = {
    run: dependencies.run ?? runCommand,
    statPath: dependencies.statPath ?? defaultStatPath,
    startPersistent: dependencies.startPersistent ?? defaultStartPersistent,
    runInteractive: dependencies.runInteractive ?? defaultRunInteractive,
    sleep: dependencies.sleep ?? defaultSleep,
    processEnvironment: () => dependencies.processEnvironment ?? environmentSource(),
    trackWatch: (control) => {
      activeWatch = control;
      return () => {
        if (activeWatch === control) activeWatch = undefined;
      };
    },
  };

  const getService = (environment: TandemBoundaryEnvironment): TandemService => {
    if (service === undefined)
      service = (dependencies.createService ?? createTandemService)(serviceOptions(environment));
    return service;
  };

  const invoke = async (invocation: CliInvocation, signal?: AbortSignal): Promise<CliResult> => {
    if (invocation.options.help) return { command: invocation.command, value: HELP_TEXT };
    const environment = resolveEnvironment(invocation, dependencies);
    return runCliCommand({
      invocation,
      environment,
      service: () => getService(environment),
      signal,
      capabilities,
    });
  };
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    const active = activeWatch;
    if (active !== undefined) {
      active.stopped = true;
      active.sleepController.abort(new Error("CLI watch interrupted"));
      active.wake?.();
    }
    const current = service;
    shutdownPromise = (async (): Promise<void> => {
      if (serviceOwned && current !== undefined) await current.shutdown();
    })();
    return shutdownPromise;
  };
  return { invoke, shutdown };
}
