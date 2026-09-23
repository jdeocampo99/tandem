import { runCommand } from "../adapters/commands.ts";
import { moveWorkspaceAfterParent } from "../adapters/herdr.ts";
import { validateModel } from "../adapters/omp.ts";
import {
  resolveTandemEnvironment,
  type TandemBoundaryEnvironment,
  type TandemEnvironmentSource,
} from "../config/environment.ts";
import type { CommandRequest, CommandResult, CommandRunner, ModelSpec } from "../contracts.ts";
import { PARALLEL_COORDINATORS_VARIABLE } from "../coordinator/exclusivity.ts";
import {
  type CoordinatorLaunchDependencies,
  coordinatorFiles,
  launchCoordinator,
} from "../coordinator/launch.ts";
import { restartCoordinator } from "../coordinator/restart.ts";
import { readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "../service/controller.ts";
import {
  CliConsentError,
  type CliInvocation,
  type CliResult,
  CliUsageError,
  parseMergeMethod,
  requiredPositionOrOption,
  text,
} from "./cli-arguments.ts";
import {
  createInputFromInvocation,
  modelAssignmentsFromFile,
  modelForPolicy,
  repoFor,
  summaryForInvocation,
  taskIdFor,
  verifyRegularPath,
} from "./cli-input.ts";
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
  throwIfAborted,
  type WatchControl,
  waitForWatchDelay,
} from "./cli-process.ts";

const DEFAULT_COORDINATOR_SESSION = "tandem";
const DEFAULT_WATCH_INTERVAL_MS = 2_000;

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

async function rehomeTaskWorkspaces(
  run: CommandRunner,
  service: TandemService,
  input: Readonly<{
    readonly home: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly parentWorkspaceId: string;
  }>,
): Promise<void> {
  const scopedTaskIds = new Set((await service.list()).map((task) => task.id));
  if (scopedTaskIds.size === 0) return;
  const runtime = await readRuntimeState(runtimeFile(input.home));
  const workspaceIds = new Set<string>();
  for (const task of runtime.tasks) {
    if (!scopedTaskIds.has(task.taskId)) continue;
    for (const endpoint of task.endpoints) {
      if (endpoint.sessionId === input.sessionId) workspaceIds.add(endpoint.workspaceId);
    }
  }
  for (const workspaceId of workspaceIds) {
    await moveWorkspaceAfterParent(run, {
      sessionId: input.sessionId,
      cwd: input.cwd,
      workspaceId,
      parentWorkspaceId: input.parentWorkspaceId,
    });
  }
}

function externalError(argv: readonly string[], result: CommandResult): Error {
  const details = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `${argv[0] ?? "command"} ${argv.slice(1).join(" ")} failed with exit code ${result.code}${details.length === 0 ? "" : `: ${details}`}`,
  );
}

function requireYes(invocation: CliInvocation, message: string): void {
  if (!invocation.options.yes) throw new CliConsentError(`${message} requires explicit --yes`);
}
const HELP_TEXT = `Tandem coordinator\n\nUsage: bun src/cli.ts [command] [options]\n\nCommands:\n  launch       Launch the OMP coordinator in the owned Herdr context\n  restart      Restart one managed worker task without changing its identity\n  models       List available OMP models and saved global role choices\n  configure-models  Validate and save global role choices (requires --input FILE --yes)\n  doctor       Check model, Herdr, policy, and coordinator files without mutating\n  setup        Propose or write Tandem-owned per-repository policy (requires --yes)\n  onboard      Inspect Tandem-owned policy and validation surfaces\n  create       Create a scout or implementation task\n  list/status   List durable tasks\n  show         Show one durable task\n  inspect     Inspect durable task, jobs, panes, artifacts, leases, and PR state\n  delivery-preflight  Check exact reviewed HEAD and publication readiness\n  messages     Inspect steer/answer delivery and blocker questions\n  steer        Queue a concise user direction for a task\n  answer       Answer the task's current needs-decision question\n  approve      Approve implementation scope (requires --yes)\n  tick/watch  Advance bounded scheduler work\n  pause/resume/cancel  Control owned task work\n  present/feedback/presentations  Route and inspect visual work\n  pr describe/publish/merge  Record or publish reviewed PR work\n  cleanup      Release owned resources; --discard requires --yes\n\nSafety options:\n  --yes        Explicit human automation consent for approval-bearing commands\n  --json       Emit one JSON result for automation\n  --headless   Use a named headless Herdr server\n  --no-attach  Do not launch a GUI; use headless Herdr\n`;

export type CliApplication = Readonly<{
  readonly invoke: (invocation: CliInvocation, signal?: AbortSignal) => Promise<CliResult>;
  readonly shutdown: () => Promise<void>;
}>;

/** Build the effectful CLI application with all process and service capabilities injectable. */
export function createCliApplication(dependencies: CliDependencies = {}): CliApplication {
  const run = dependencies.run ?? runCommand;
  const statPath = dependencies.statPath ?? defaultStatPath;
  const startPersistent = dependencies.startPersistent ?? defaultStartPersistent;
  const runInteractive = dependencies.runInteractive ?? defaultRunInteractive;
  const sleep = dependencies.sleep ?? defaultSleep;
  let service = dependencies.service;
  const serviceOwned = dependencies.service === undefined;
  let activeWatch: WatchControl | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const getService = (environment: TandemBoundaryEnvironment): TandemService => {
    if (service === undefined)
      service = (dependencies.createService ?? createTandemService)(serviceOptions(environment));
    return service;
  };

  const invoke = async (invocation: CliInvocation, signal?: AbortSignal): Promise<CliResult> => {
    if (invocation.options.help) return { command: invocation.command, value: HELP_TEXT };
    const environment = resolveEnvironment(invocation, dependencies);
    switch (invocation.command) {
      case "launch": {
        const files = coordinatorFiles(invocation.options);
        await verifyRegularPath(statPath, files.extensionPath, "extensionPath");
        await verifyRegularPath(statPath, files.configPath, "configPath");
        const serviceApi = getService(environment);
        const onboarded = await serviceApi.onboard(environment.repo, false);
        const model = modelForPolicy(onboarded.policy.models.coordinator, invocation.options);
        await validateModel(run, { cwd: environment.repo, model });
        const launchDependencies: CoordinatorLaunchDependencies = {
          run,
          startPersistent,
          runInteractive,
          sleep,
          processEnvironment: dependencies.processEnvironment ?? environmentSource(),
          rehomeTaskWorkspaces: (input) => rehomeTaskWorkspaces(run, serviceApi, input),
        };
        const launch = invocation.options.restart
          ? await restartCoordinator(
              {
                cwd: environment.repo,
                repo: environment.repo,
                home: environment.home,
                poolRoot: environment.poolRoot,
                sessionId: environment.sessionId,
                model,
                configPath: files.configPath,
                extensionPath: files.extensionPath,
                continueSession: invocation.options.continueSession,
                headless: invocation.options.headless,
                noAttach: invocation.options.noAttach,
                ...(environment.parentWorkspaceId === undefined
                  ? {}
                  : { parentWorkspaceId: environment.parentWorkspaceId }),
              },
              launchDependencies,
            )
          : await launchCoordinator(
              {
                cwd: environment.repo,
                repo: environment.repo,
                home: environment.home,
                poolRoot: environment.poolRoot,
                sessionId: environment.sessionId,
                model,
                configPath: files.configPath,
                extensionPath: files.extensionPath,
                continueSession: invocation.options.continueSession,
                headless: invocation.options.headless,
                noAttach: invocation.options.noAttach,
                ...(environment.parentWorkspaceId === undefined
                  ? {}
                  : { parentWorkspaceId: environment.parentWorkspaceId }),
              },
              launchDependencies,
            );
        return { command: invocation.command, value: launch };
      }
      case "restart":
        return {
          command: invocation.command,
          value: await getService(environment).restart(taskIdFor(invocation)),
        };
      case "models":
        return {
          command: invocation.command,
          value: await getService(environment).models(repoFor(invocation, environment)),
        };
      case "configure-models": {
        requireYes(invocation, "configuring model settings");
        const repoPath = repoFor(invocation, environment);
        const input = invocation.options.input;
        if (input === undefined) throw new CliUsageError("configure-models requires --input FILE");
        const models = await modelAssignmentsFromFile(statPath, input);
        return {
          command: invocation.command,
          value: await getService(environment).configureModels({ repoPath, models }),
          approved: true,
        };
      }
      case "doctor": {
        const files = coordinatorFiles(invocation.options);
        const checks: Array<Readonly<{ name: string; ok: boolean; detail?: string }>> = [];
        const check = async (
          name: string,
          operation: () => Promise<string | undefined>,
        ): Promise<void> => {
          try {
            const detail = await operation();
            checks.push({
              name,
              ok: true,
              ...(detail === undefined ? {} : { detail }),
            });
          } catch (error) {
            checks.push({
              name,
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        };
        await check("extension", async () => {
          await verifyRegularPath(statPath, files.extensionPath, "extensionPath");
          return files.extensionPath;
        });
        await check("config", async () => {
          await verifyRegularPath(statPath, files.configPath, "configPath");
          return files.configPath;
        });
        const serviceApi = getService(environment);
        let policyModel: ModelSpec | undefined;
        await check("policy", async () => {
          const onboarded = await serviceApi.onboard(environment.repo, false);
          policyModel = modelForPolicy(onboarded.policy.models.coordinator, invocation.options);
          return onboarded.existingConfig
            ? `using ${onboarded.configPath}`
            : `proposal available at ${onboarded.configPath}`;
        });
        await check("omp-model", async () => {
          if (policyModel === undefined)
            throw new Error("policy check did not produce coordinator model");
          const observed = await validateModel(run, {
            cwd: environment.repo,
            model: policyModel,
          });
          return `${observed.selector} supports ${policyModel.thinking}`;
        });
        await check("herdr", async () => {
          const request: CommandRequest = {
            argv: ["herdr", "--session", environment.sessionId, "status", "--json"],
            cwd: environment.repo,
          };
          const result = await run(request);
          if (result.code !== 0) throw externalError(request.argv, result);
          return result.stdout.trim() || "session status available";
        });
        return {
          command: invocation.command,
          value: { ok: checks.every((entry) => entry.ok), checks },
        };
      }
      case "setup": {
        const repoPath = repoFor(invocation, environment);
        if (!invocation.options.yes) {
          return {
            command: invocation.command,
            value: await getService(environment).onboard(repoPath, false),
            approvalRequired: true,
            approved: false,
          };
        }
        return {
          command: invocation.command,
          value: await getService(environment).onboard(repoPath, true),
          approved: true,
        };
      }
      case "onboard": {
        const repoPath = repoFor(invocation, environment);
        if (invocation.options.write) {
          if (!invocation.options.yes) {
            return {
              command: invocation.command,
              value: await getService(environment).onboard(repoPath, false),
              approvalRequired: true,
              approved: false,
            };
          }
          return {
            command: invocation.command,
            value: await getService(environment).onboard(repoPath, true),
            approved: true,
          };
        }
        return {
          command: invocation.command,
          value: await getService(environment).onboard(repoPath, false),
        };
      }
      case "create":
        return {
          command: invocation.command,
          value: await getService(environment).create(
            createInputFromInvocation(invocation, environment),
          ),
        };
      case "list":
        return {
          command: invocation.command,
          value: await getService(environment).list(),
        };
      case "show":
        return {
          command: invocation.command,
          value: await getService(environment).get(taskIdFor(invocation)),
        };
      case "inspect":
        return {
          command: invocation.command,
          value: await getService(environment).inspect(taskIdFor(invocation)),
        };
      case "delivery-preflight": {
        const taskId = taskIdFor(invocation);
        const base = requiredPositionOrOption(invocation, invocation.options.base, 1, "base");
        return {
          command: invocation.command,
          value: await getService(environment).deliveryPreflight(taskId, { base }),
        };
      }
      case "steer": {
        const taskId = taskIdFor(invocation);
        const message = text(invocation.options.text, "text");
        return {
          command: invocation.command,
          value: await getService(environment).steer({
            taskId,
            text: message,
            ...(invocation.options.supersedes.length === 0
              ? {}
              : { supersedes: invocation.options.supersedes }),
          }),
        };
      }
      case "answer": {
        const taskId = taskIdFor(invocation);
        const questionId = text(invocation.options.questionId, "questionId");
        const message = text(invocation.options.text, "text");
        return {
          command: invocation.command,
          value: await getService(environment).answer({ taskId, questionId, text: message }),
        };
      }
      case "messages":
        return {
          command: invocation.command,
          value: await getService(environment).messages(taskIdFor(invocation)),
        };
      case "approve": {
        const taskId = taskIdFor(invocation);
        requireYes(invocation, `approving scope for ${taskId}`);
        return {
          command: invocation.command,
          value: await getService(environment).approve(taskId),
          approved: true,
        };
      }
      case "tick": {
        throwIfAborted(signal);
        const tasks = await getService(environment).tick();
        throwIfAborted(signal);
        return {
          command: invocation.command,
          value: tasks,
        };
      }
      case "watch": {
        throwIfAborted(signal);
        const max = invocation.options.iterations ?? Number.POSITIVE_INFINITY;
        let latest: readonly unknown[] = [];
        const control: WatchControl = {
          stopped: false,
          sleepController: new AbortController(),
          wake: undefined,
        };
        activeWatch = control;
        try {
          const current = getService(environment);
          for (let index = 0; index < max; index += 1) {
            latest = await current.tick();
            if (control.stopped) throw new Error("CLI watch interrupted");
            throwIfAborted(signal);
            if (index + 1 < max) {
              await waitForWatchDelay(
                sleep,
                invocation.options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
                control,
                signal,
              );
              if (control.stopped) throw new Error("CLI watch interrupted");
              throwIfAborted(signal);
            }
          }
          return { command: invocation.command, value: latest };
        } finally {
          if (activeWatch === control) activeWatch = undefined;
        }
      }
      case "pause": {
        const taskId = taskIdFor(invocation);
        const reason =
          (invocation.options.reason ?? invocation.positionals.slice(1).join(" ")) || undefined;
        return {
          command: invocation.command,
          value: await getService(environment).pause(taskId, reason),
        };
      }
      case "resume":
        return {
          command: invocation.command,
          value: await getService(environment).resume(taskIdFor(invocation)),
        };
      case "cancel": {
        const taskId = taskIdFor(invocation);
        requireYes(invocation, `cancelling ${taskId}`);
        const reason =
          (invocation.options.reason ?? invocation.positionals.slice(1).join(" ")) || undefined;
        return {
          command: invocation.command,
          value: await getService(environment).cancel(taskId, reason),
          approved: true,
        };
      }
      case "present": {
        const taskId = taskIdFor(invocation);
        const objective = requiredPositionOrOption(
          invocation,
          invocation.options.objective,
          1,
          "objective",
        );
        const artifacts =
          invocation.options.artifacts.length > 0
            ? invocation.options.artifacts
            : (invocation.positionals[2] ?? "")
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
        if (artifacts.length === 0)
          throw new CliUsageError(
            "present requires at least one --artifact or comma-separated artifact positional",
          );
        return {
          command: invocation.command,
          value: await getService(environment).present(taskId, {
            objective,
            artifacts,
          }),
        };
      }
      case "presentations":
        return {
          command: invocation.command,
          value: await getService(environment).presentations(),
        };
      case "feedback": {
        throwIfAborted(signal);
        const presentationId = invocation.options.presentationId ?? taskIdFor(invocation);
        const value = await getService(environment).feedback(presentationId, signal);
        throwIfAborted(signal);
        return {
          command: invocation.command,
          value,
        };
      }
      case "describe": {
        const taskId = taskIdFor(invocation);
        return {
          command: invocation.command,
          value: await getService(environment).describePr(
            taskId,
            summaryForInvocation(invocation, 1),
          ),
        };
      }
      case "publish": {
        const taskId = taskIdFor(invocation);
        requireYes(invocation, `publishing ${taskId}`);
        const title = requiredPositionOrOption(invocation, invocation.options.title, 1, "title");
        const base = requiredPositionOrOption(invocation, invocation.options.base, 2, "base");
        return {
          command: invocation.command,
          value: await getService(environment).publish(taskId, {
            title,
            base,
            summary: summaryForInvocation(invocation, 3),
            approved: true,
          }),
          approved: true,
        };
      }
      case "draft": {
        const taskId = taskIdFor(invocation);
        requireYes(invocation, `publishing an unfinished draft for ${taskId}`);
        const title = requiredPositionOrOption(invocation, invocation.options.title, 1, "title");
        const base = requiredPositionOrOption(invocation, invocation.options.base, 2, "base");
        return {
          command: invocation.command,
          value: await getService(environment).publishDraft(taskId, {
            title,
            base,
            approved: true,
          }),
          approved: true,
        };
      }
      case "merge": {
        const taskId = taskIdFor(invocation);
        requireYes(invocation, `merging ${taskId}`);
        const method =
          invocation.options.method ?? parseMergeMethod(invocation.positionals[1] ?? "squash");
        return {
          command: invocation.command,
          value: await getService(environment).merge(taskId, {
            approved: true,
            method,
          }),
          approved: true,
        };
      }
      case "cleanup": {
        const taskId = taskIdFor(invocation);
        if (invocation.options.discard) requireYes(invocation, `discarding ${taskId}`);
        return {
          command: invocation.command,
          value: await getService(environment).cleanup(
            taskId,
            invocation.options.discard ? { discard: true, destructiveApproval: true } : {},
          ),
          ...(invocation.options.discard ? { approved: true } : {}),
        };
      }
    }
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
