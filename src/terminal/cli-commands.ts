import type { TandemBoundaryEnvironment, TandemEnvironmentSource } from "../config/environment.ts";
import type { CommandRequest, CommandResult, CommandRunner, ModelSpec } from "../contracts.ts";
import {
  type CoordinatorLaunchDependencies,
  type CoordinatorLaunchRequest,
  coordinatorFiles,
  launchCoordinator,
} from "../coordinator/launch.ts";
import { renestWorkspaces } from "../coordinator/renest.ts";
import { restartCoordinator } from "../coordinator/restart.ts";
import { isTandemCheckout } from "../coordinator/tandem-checkout.ts";
import { harnessForRole } from "../harness/resolve.ts";
import type { TandemService } from "../service/controller.ts";
import {
  type CliCommand,
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
  jsonObjectFromFile,
  mergingChoiceFrom,
  modelAssignmentsFromFile,
  modelForPolicy,
  repoFor,
  summaryForInvocation,
  taskIdFor,
  verifyRegularPath,
} from "./cli-input.ts";
import {
  type PathStat,
  type RunInteractive,
  type Sleep,
  type StartPersistent,
  throwIfAborted,
  type WatchControl,
  waitForWatchDelay,
} from "./cli-process.ts";

const DEFAULT_WATCH_INTERVAL_MS = 2_000;

/** Process capabilities the command handlers may use; each is injectable by the application. */
export type CliCapabilities = Readonly<{
  readonly run: CommandRunner;
  readonly statPath: (path: string) => Promise<PathStat>;
  readonly startPersistent: StartPersistent;
  readonly runInteractive: RunInteractive;
  readonly sleep: Sleep;
  readonly processEnvironment: () => TandemEnvironmentSource;
  /** Registers a running watch so shutdown can interrupt it; the returned function unregisters it. */
  readonly trackWatch: (control: WatchControl) => () => void;
}>;

export type CliCommandContext = Readonly<{
  readonly invocation: CliInvocation;
  readonly environment: TandemBoundaryEnvironment;
  /** Creates the service on first use, so commands that fail validation never start it. */
  readonly service: () => TandemService;
  readonly signal: AbortSignal | undefined;
  readonly capabilities: CliCapabilities;
}>;

export type CliCommandOutcome = Omit<CliResult, "command">;

type CliCommandHandler = (context: CliCommandContext) => Promise<CliCommandOutcome>;

function requireYes(invocation: CliInvocation, message: string): void {
  if (!invocation.options.yes) throw new CliConsentError(`${message} requires explicit --yes`);
}

function externalError(argv: readonly string[], result: CommandResult): Error {
  const details = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `${argv[0] ?? "command"} ${argv.slice(1).join(" ")} failed with exit code ${result.code}${details.length === 0 ? "" : `: ${details}`}`,
  );
}

function reasonFor(invocation: CliInvocation): string | undefined {
  return (invocation.options.reason ?? invocation.positionals.slice(1).join(" ")) || undefined;
}

function presentedArtifacts(invocation: CliInvocation): readonly string[] {
  if (invocation.options.artifacts.length > 0) return invocation.options.artifacts;
  return (invocation.positionals[2] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Onboarding writes policy only with --yes; without it the proposal is returned for approval. */
async function onboardWithConsent(context: CliCommandContext): Promise<CliCommandOutcome> {
  const repoPath = repoFor(context.invocation, context.environment);
  if (!context.invocation.options.yes) {
    return {
      value: await context.service().onboard(repoPath, false),
      approvalRequired: true,
      approved: false,
    };
  }
  return { value: await context.service().onboard(repoPath, true), approved: true };
}

async function launch(context: CliCommandContext): Promise<CliCommandOutcome> {
  const { invocation, environment, capabilities } = context;
  const { run, statPath } = capabilities;
  const onboarded = await context.service().onboard(environment.repo, false);
  // The Tandem coordinator is where models get chosen, so until then it runs OMP's own default.
  const ompDefault =
    !onboarded.modelSettings.configured &&
    invocation.options.model === undefined &&
    invocation.options.thinking === undefined &&
    (await isTandemCheckout(environment.repo));
  const model = ompDefault
    ? undefined
    : modelForPolicy(onboarded.policy.models.coordinator, invocation.options);
  const harness = harnessForRole("coordinator", model);
  const files = coordinatorFiles(harness, invocation.options);
  await verifyRegularPath(statPath, files.extensionPath, "extensionPath");
  await verifyRegularPath(statPath, files.configPath, "configPath");
  if (model !== undefined) await harness.validateModel(run, environment.repo, model);
  const launchDependencies: CoordinatorLaunchDependencies = {
    run,
    startPersistent: capabilities.startPersistent,
    runInteractive: capabilities.runInteractive,
    sleep: capabilities.sleep,
    processEnvironment: capabilities.processEnvironment(),
    rehomeTaskWorkspaces: async (input) =>
      (await renestWorkspaces(run, { ...input, apply: true })).warnings,
  };
  const request: CoordinatorLaunchRequest = {
    cwd: environment.repo,
    repo: environment.repo,
    home: environment.home,
    poolRoot: environment.poolRoot,
    sessionId: environment.sessionId,
    model,
    continueSession: invocation.options.continueSession,
    headless: invocation.options.headless,
    noAttach: invocation.options.noAttach,
    ...(environment.parentWorkspaceId === undefined
      ? {}
      : { parentWorkspaceId: environment.parentWorkspaceId }),
  };
  const value = invocation.options.restart
    ? await restartCoordinator(request, launchDependencies)
    : await launchCoordinator(request, launchDependencies);
  return { value };
}

type DoctorCheck = Readonly<{ name: string; ok: boolean; detail?: string }>;

async function runDoctorCheck(
  name: string,
  operation: () => Promise<string | undefined>,
): Promise<DoctorCheck> {
  try {
    const detail = await operation();
    return { name, ok: true, ...(detail === undefined ? {} : { detail }) };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function doctor(context: CliCommandContext): Promise<CliCommandOutcome> {
  const { invocation, environment } = context;
  const { run, statPath } = context.capabilities;
  const service = context.service();
  let policyModel: ModelSpec | undefined;
  const policyCheck = await runDoctorCheck("policy", async () => {
    const onboarded = await service.onboard(environment.repo, false);
    policyModel = modelForPolicy(onboarded.policy.models.coordinator, invocation.options);
    return onboarded.existingConfig
      ? `using ${onboarded.configPath}`
      : `proposal available at ${onboarded.configPath}`;
  });
  const coordinatorModel = (): ModelSpec => {
    if (policyModel === undefined)
      throw new Error("policy check did not produce coordinator model");
    return policyModel;
  };
  const coordinatorHarness = () => harnessForRole("coordinator", coordinatorModel());
  const checks: DoctorCheck[] = [];
  checks.push(
    await runDoctorCheck("extension", async () => {
      const files = coordinatorFiles(coordinatorHarness(), invocation.options);
      await verifyRegularPath(statPath, files.extensionPath, "extensionPath");
      return files.extensionPath;
    }),
  );
  checks.push(
    await runDoctorCheck("config", async () => {
      const files = coordinatorFiles(coordinatorHarness(), invocation.options);
      await verifyRegularPath(statPath, files.configPath, "configPath");
      return files.configPath;
    }),
  );
  checks.push(policyCheck);
  checks.push(
    await runDoctorCheck("omp-model", async () => {
      const model = coordinatorModel();
      const observed = await coordinatorHarness().validateModel(run, environment.repo, model);
      return `${observed.selector} supports ${model.thinking}`;
    }),
  );
  checks.push(
    await runDoctorCheck("herdr", async () => {
      const request: CommandRequest = {
        argv: ["herdr", "--session", environment.sessionId, "status", "--json"],
        cwd: environment.repo,
      };
      const result = await run(request);
      if (result.code !== 0) throw externalError(request.argv, result);
      return result.stdout.trim() || "session status available";
    }),
  );
  return { value: { ok: checks.every((entry) => entry.ok), checks } };
}

async function watch(context: CliCommandContext): Promise<CliCommandOutcome> {
  const { invocation, signal } = context;
  throwIfAborted(signal);
  const max = invocation.options.iterations ?? Number.POSITIVE_INFINITY;
  const intervalMs = invocation.options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  let latest: readonly unknown[] = [];
  const control: WatchControl = {
    stopped: false,
    sleepController: new AbortController(),
    wake: undefined,
  };
  const untrack = context.capabilities.trackWatch(control);
  try {
    const service = context.service();
    for (let index = 0; index < max; index += 1) {
      latest = await service.tick();
      if (control.stopped) throw new Error("CLI watch interrupted");
      throwIfAborted(signal);
      if (index + 1 < max) {
        await waitForWatchDelay(context.capabilities.sleep, intervalMs, control, signal);
        if (control.stopped) throw new Error("CLI watch interrupted");
        throwIfAborted(signal);
      }
    }
    return { value: latest };
  } finally {
    untrack();
  }
}

const CLI_COMMAND_HANDLERS: Readonly<Record<CliCommand, CliCommandHandler>> = {
  launch,
  restart: async ({ invocation, service }) => ({
    value: await service().restart(taskIdFor(invocation)),
  }),
  models: async ({ invocation, environment, service }) => ({
    value: await service().models(repoFor(invocation, environment)),
  }),
  "configure-models": async ({ invocation, environment, service, capabilities }) => {
    requireYes(invocation, "configuring model settings");
    const repoPath = repoFor(invocation, environment);
    const input = invocation.options.input;
    if (input === undefined) throw new CliUsageError("configure-models requires --input FILE");
    const models = await modelAssignmentsFromFile(capabilities.statPath, input);
    return { value: await service().configureModels({ repoPath, models }), approved: true };
  },
  "configure-merging": async ({ invocation, environment, service, capabilities }) => {
    requireYes(invocation, "saving how this project merges");
    const input = await jsonObjectFromFile(
      capabilities.statPath,
      invocation.options.input,
      "configure-merging",
    );
    const repoPath = repoFor(invocation, environment);
    return {
      value: await service().saveMerging({ repoPath, choice: mergingChoiceFrom(input) }),
      approved: true,
    };
  },
  doctor,
  setup: onboardWithConsent,
  onboard: async (context) => {
    if (context.invocation.options.write) return onboardWithConsent(context);
    const repoPath = repoFor(context.invocation, context.environment);
    const service = context.service();
    // Read-only extras for the onboarding conversation: how pull requests would merge.
    return {
      value: {
        ...(await service.onboard(repoPath, false)),
        merging: await service.mergingCheck(repoPath),
      },
    };
  },
  create: async ({ invocation, environment, service }) => ({
    value: await service().create(createInputFromInvocation(invocation, environment)),
  }),
  list: async ({ service }) => ({ value: await service().list() }),
  show: async ({ invocation, service }) => ({
    value: await service().get(taskIdFor(invocation)),
  }),
  inspect: async ({ invocation, service }) => ({
    value: await service().inspect(taskIdFor(invocation)),
  }),
  "delivery-preflight": async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    const base = requiredPositionOrOption(invocation, invocation.options.base, 1, "base");
    return { value: await service().deliveryPreflight(taskId, { base }) };
  },
  steer: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    const message = text(invocation.options.text, "text");
    return {
      value: await service().steer({
        taskId,
        text: message,
        ...(invocation.options.supersedes.length === 0
          ? {}
          : { supersedes: invocation.options.supersedes }),
      }),
    };
  },
  answer: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    const questionId = text(invocation.options.questionId, "questionId");
    const message = text(invocation.options.text, "text");
    return { value: await service().answer({ taskId, questionId, text: message }) };
  },
  messages: async ({ invocation, service }) => ({
    value: await service().messages(taskIdFor(invocation)),
  }),
  approve: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    requireYes(invocation, `approving scope for ${taskId}`);
    return { value: await service().approve(taskId), approved: true };
  },
  tick: async ({ service, signal }) => {
    throwIfAborted(signal);
    const tasks = await service().tick();
    throwIfAborted(signal);
    return { value: tasks };
  },
  watch,
  pause: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    return { value: await service().pause(taskId, reasonFor(invocation)) };
  },
  resume: async ({ invocation, service }) => ({
    value: await service().resume(taskIdFor(invocation)),
  }),
  cancel: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    requireYes(invocation, `cancelling ${taskId}`);
    return { value: await service().cancel(taskId, reasonFor(invocation)), approved: true };
  },
  present: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    const objective = requiredPositionOrOption(
      invocation,
      invocation.options.objective,
      1,
      "objective",
    );
    const artifacts = presentedArtifacts(invocation);
    if (artifacts.length === 0)
      throw new CliUsageError(
        "present requires at least one --artifact or comma-separated artifact positional",
      );
    return { value: await service().present(taskId, { objective, artifacts }) };
  },
  presentations: async ({ service }) => ({ value: await service().presentations() }),
  feedback: async ({ invocation, service, signal }) => {
    throwIfAborted(signal);
    const presentationId = invocation.options.presentationId ?? taskIdFor(invocation);
    const value = await service().feedback(presentationId, signal);
    throwIfAborted(signal);
    return { value };
  },
  describe: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    return { value: await service().describePr(taskId, summaryForInvocation(invocation, 1)) };
  },
  publish: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    requireYes(invocation, `publishing ${taskId}`);
    const title = requiredPositionOrOption(invocation, invocation.options.title, 1, "title");
    const base = requiredPositionOrOption(invocation, invocation.options.base, 2, "base");
    return {
      value: await service().publish(taskId, {
        title,
        base,
        summary: summaryForInvocation(invocation, 3),
        approved: true,
      }),
      approved: true,
    };
  },
  draft: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    requireYes(invocation, `publishing an unfinished draft for ${taskId}`);
    const title = requiredPositionOrOption(invocation, invocation.options.title, 1, "title");
    const base = requiredPositionOrOption(invocation, invocation.options.base, 2, "base");
    return {
      value: await service().publishDraft(taskId, { title, base, approved: true }),
      approved: true,
    };
  },
  merge: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    requireYes(invocation, `merging ${taskId}`);
    const method =
      invocation.options.method ?? parseMergeMethod(invocation.positionals[1] ?? "squash");
    return { value: await service().merge(taskId, { approved: true, method }), approved: true };
  },
  cleanup: async ({ invocation, service }) => {
    const taskId = taskIdFor(invocation);
    const discard = invocation.options.discard;
    if (discard) requireYes(invocation, `discarding ${taskId}`);
    return {
      value: await service().cleanup(
        taskId,
        discard ? { discard: true, destructiveApproval: true } : {},
      ),
      ...(discard ? { approved: true } : {}),
    };
  },
};

/** Run one parsed CLI command; the handler for each command owns its consent and argument checks. */
export async function runCliCommand(context: CliCommandContext): Promise<CliResult> {
  const outcome = await CLI_COMMAND_HANDLERS[context.invocation.command](context);
  return { command: context.invocation.command, ...outcome };
}
