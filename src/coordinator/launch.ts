import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteShellCommand } from "../adapters/commands.ts";
import { readCheckpoint } from "../adapters/git.ts";
import { readHerdrStatus } from "../adapters/herdr.ts";
import { acquireWorktree } from "../adapters/treehouse.ts";
import type { TandemEnvironmentSource } from "../config/environment.ts";
import { readModelSettings } from "../config/models.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  ModelSpec,
  WorktreeLease,
} from "../contracts.ts";
import { type CliOptions, CliUsageError, parseThinking, text } from "../terminal/cli-arguments.ts";
import { checkLaunchPath, checkLaunchText } from "../terminal/cli-input.ts";
import type { RunInteractive, Sleep, StartPersistent } from "../terminal/cli-process.ts";
import { mergeInheritedEnvironment } from "../terminal/cli-process.ts";
import {
  type CoordinatorSessionReconciliation,
  claimRepositoryCoordinator,
  parallelCoordinatorsAllowed,
} from "./exclusivity.ts";
import { withCoordinatorLaunchLock, withCoordinatorRepositoryLock } from "./lock.ts";
import { COORDINATOR_SCRIPT_DIRECTORY, findRunningCoordinator } from "./ownership.ts";
import { COORDINATOR_LEASE_HOLDER_PREFIX, type CoordinatorRecord, recordPath } from "./record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "./registry.ts";
import {
  applyCoordinatorReplacement,
  type CoordinatorResourceOutcome,
  decideCoordinatorReplacement,
  observeCoordinatorCheckout,
  rollbackCoordinatorAllocation,
} from "./resources.ts";
import { resolveCoordinatorSourceHead } from "./source.ts";
import {
  type CoordinatorWorkspaceRetirement,
  coordinatorWorkspaceLabel,
  retireCoordinatorWorkspace,
} from "./workspace.ts";

const DEFAULT_COORDINATOR_CONFIG = "harness/omp/worker-config.yml";
const HERDR_READY_ATTEMPTS = 40;
const HERDR_READY_DELAY_MS = 250;
/** How long a coordinator shell Herdr just restored gets to finish starting before it counts as busy. */
const RESTORED_SHELL_ATTEMPTS = 20;
// No grep or glob: searching the repository is a scout's job, not the coordinator's.
const COORDINATOR_TOOLS = ["read", "ask", "tandem"] as const;

function defaultClock(): string {
  return new Date().toISOString();
}

export type CoordinatorLaunchInput = Readonly<{
  readonly cwd: string;
  /** Unset runs OMP's own default model: the Tandem coordinator before any model is chosen. */
  readonly model: ModelSpec | undefined;
  readonly configPath: string;
  readonly extensionPath: string;
  readonly continueSession?: boolean;
  readonly sessionDirectory?: string;
  readonly prompt?: string;
}>;

export type CoordinatorLaunchRequest = Readonly<{
  readonly cwd: string;
  readonly repo: string;
  readonly sourceRepo?: string;
  readonly sourceHead?: string;
  readonly home: string;
  readonly poolRoot: string;
  readonly sessionId: string;
  /** Unset runs OMP's own default model: the Tandem coordinator before any model is chosen. */
  readonly model: ModelSpec | undefined;
  readonly configPath: string;
  readonly extensionPath: string;
  readonly continueSession: boolean;
  readonly headless: boolean;
  readonly noAttach: boolean;
  readonly parentWorkspaceId?: string;
  readonly prompt?: string;
  /**
   * Bypass the ordinary reconnect reuse path after restart ownership has been
   * proven. The caller must close the superseded pane before launching the
   * replacement, so two OMP processes never share the saved conversation.
   */
  readonly restart?: boolean;
}>;

export type CoordinatorLaunchResult = Readonly<{
  readonly sessionId: string;
  readonly repoPath: string;
  readonly worktree: WorktreeLease;
  readonly command: readonly string[];
  readonly direct: boolean;
  readonly workspaceId?: string;
  readonly paneId?: string;
  readonly tabId?: string;
  readonly reused?: boolean;
  readonly processExitCode?: number;
  /** What happened to a previous coordinator's Herdr workspace, when one was retired. */
  readonly workspaceRetirement?: CoordinatorWorkspaceRetirement;
  /** What happened to a previous coordinator's worktree lease, when one was replaced. */
  readonly previousResources?: CoordinatorResourceOutcome;
  /** What happened to stopped coordinator records other Tandem sessions held for this repository. */
  readonly otherSessionReconciliations?: readonly CoordinatorSessionReconciliation[];
}>;

export type CoordinatorLaunchDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly startPersistent: StartPersistent;
  readonly runInteractive: RunInteractive;
  readonly sleep: Sleep;
  readonly processEnvironment: TandemEnvironmentSource;
  /** Timestamps quarantine notes; defaults to the wall clock. */
  readonly clock?: () => string;
  /** Names quarantine notes; defaults to a random UUID. */
  readonly newId?: () => string;
  readonly rehomeTaskWorkspaces?: (
    input: Readonly<{
      readonly home: string;
      readonly cwd: string;
      readonly sessionId: string;
      readonly parentWorkspaceId: string;
    }>,
  ) => Promise<readonly string[]>;
}>;
export function buildCoordinatorArgv(input: CoordinatorLaunchInput): readonly string[] {
  const cwd = checkLaunchPath(input.cwd, "cwd");
  const configPath = checkLaunchPath(input.configPath, "configPath");
  const extensionPath = checkLaunchPath(input.extensionPath, "extensionPath");
  const model =
    input.model === undefined
      ? []
      : [
          "--model",
          checkLaunchText(input.model.model, "model.model"),
          "--thinking",
          parseThinking(input.model.thinking),
        ];
  const argv = [
    "omp",
    ...model,
    "--config",
    configPath,
    "--no-extensions",
    "--extension",
    extensionPath,
    "--tools",
    COORDINATOR_TOOLS.join(","),
    "--cwd",
    cwd,
    "--no-prewalk",
    "--no-title",
  ];
  if (input.continueSession === true) argv.push("--continue");
  if (input.sessionDirectory !== undefined) {
    argv.push("--session-dir", checkLaunchPath(input.sessionDirectory, "sessionDirectory"));
  }
  if (input.prompt !== undefined) argv.push(checkLaunchText(input.prompt, "prompt"));
  return argv;
}

export function coordinatorFiles(
  options: CliOptions,
): Readonly<{ extensionPath: string; configPath: string }> {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const defaultExtensionPath = join(sourceDirectory, "..", "harness", "omp", "extension.ts");
  const defaultConfigPath = join(sourceDirectory, "..", DEFAULT_COORDINATOR_CONFIG);
  const extensionPath = options.extensionPath ?? defaultExtensionPath;
  const configPath = options.configPath ?? defaultConfigPath;
  if (resolve(extensionPath) !== resolve(defaultExtensionPath)) {
    throw new CliUsageError(
      `coordinator extension must be Tandem's checked-in extension at ${defaultExtensionPath}`,
    );
  }
  if (resolve(configPath) !== resolve(defaultConfigPath)) {
    throw new CliUsageError(
      `coordinator config must be the checked-in fallback-disabled config at ${defaultConfigPath}`,
    );
  }
  return { extensionPath, configPath };
}

type CoordinatorPaths = Readonly<{
  readonly home: string;
  readonly poolRoot: string;
  readonly repo: string;
  readonly sessionDirectory: string;
}>;

function coordinatorPaths(request: CoordinatorLaunchRequest): CoordinatorPaths {
  const home = resolve(request.home);
  const poolRoot = resolve(request.poolRoot);
  const repo = resolve(request.repo);
  const repositoryKey = createHash("sha256").update(repo).digest("hex").slice(0, 24);
  return {
    home,
    poolRoot,
    repo,
    sessionDirectory: join(home, "coordinator-sessions", repositoryKey),
  };
}

function coordinatorHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function coordinatorLeaseIdentity(
  repoPath: string,
  sessionId: string,
  sourceHead: string,
): Readonly<{ tandemId: string; taskName: string }> {
  const repositoryKey = coordinatorHash(repoPath);
  const sessionKey = coordinatorHash(sessionId);
  const sourceKey = coordinatorHash(sourceHead);
  return {
    tandemId: `${COORDINATOR_LEASE_HOLDER_PREFIX}${repositoryKey}:${sessionKey}:${sourceKey}`,
    taskName: `coordinator-${repositoryKey}-${sessionKey}-${sourceKey}`,
  };
}

async function sameCoordinatorPath(expected: string, actual: string): Promise<boolean> {
  try {
    const [expectedPath, actualPath] = await Promise.all([realpath(expected), realpath(actual)]);
    return expectedPath === actualPath;
  } catch {
    return resolve(expected) === resolve(actual);
  }
}

function validateCoordinatorCheckout(
  path: string,
  checkpoint: Readonly<{
    readonly head: string;
    readonly dirty: boolean;
    readonly unmerged: boolean;
  }>,
  expectedHead: string,
): void {
  const reasons: string[] = [];
  if (checkpoint.dirty) reasons.push("worktree is dirty");
  if (checkpoint.unmerged) reasons.push("worktree has unmerged paths");
  if (checkpoint.head !== expectedHead) {
    reasons.push(`HEAD ${checkpoint.head} does not match captured source HEAD ${expectedHead}`);
  }
  if (reasons.length > 0) {
    throw new Error(
      `coordinator worktree ${JSON.stringify(path)} is unsafe: ${reasons.join("; ")}`,
    );
  }
}

async function validateBoundCoordinatorSource(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
  expectedHead: string,
  context: HerdrContext | undefined,
): Promise<string | undefined> {
  const boundSourcePath =
    request.sourceRepo === undefined && context === undefined
      ? undefined
      : (request.sourceRepo ?? dependencies.processEnvironment.TANDEM_SOURCE_REPO);
  if (boundSourcePath === undefined) return undefined;
  const normalizedBoundSourcePath = resolve(boundSourcePath);
  const boundCheckpoint = await readCheckpoint(dependencies.run, {
    repo: normalizedBoundSourcePath,
  });
  validateCoordinatorCheckout(normalizedBoundSourcePath, boundCheckpoint, expectedHead);
  return normalizedBoundSourcePath;
}

async function acquireCoordinatorLease(
  request: CoordinatorLaunchRequest,
  paths: CoordinatorPaths,
  dependencies: CoordinatorLaunchDependencies,
  sourceHead: string,
): Promise<WorktreeLease> {
  const identity = coordinatorLeaseIdentity(paths.repo, request.sessionId, sourceHead);
  return acquireWorktree(dependencies.run, {
    repo: paths.repo,
    root: paths.poolRoot,
    tandemId: identity.tandemId,
    taskName: identity.taskName,
    sourceHead,
  });
}

/** Proves an acquired coordinator lease is the clean, commit-pinned checkout the launch asked for. */
async function validateCoordinatorLease(
  dependencies: CoordinatorLaunchDependencies,
  worktree: WorktreeLease,
  sourceHead: string,
  normalizedBoundSourcePath: string | undefined,
): Promise<void> {
  if (worktree.baseHead !== sourceHead) {
    throw new Error(
      `coordinator lease ${JSON.stringify(worktree.leaseId)} is pinned to ${worktree.baseHead}, expected captured source HEAD ${sourceHead}`,
    );
  }
  const checkout = await readCheckpoint(dependencies.run, { repo: worktree.path });
  validateCoordinatorCheckout(worktree.path, checkout, sourceHead);
  if (
    normalizedBoundSourcePath !== undefined &&
    !(await sameCoordinatorPath(normalizedBoundSourcePath, worktree.path))
  ) {
    throw new Error(
      `coordinator source ${JSON.stringify(normalizedBoundSourcePath)} does not match owned lease worktree ${JSON.stringify(worktree.path)}`,
    );
  }
}

function coordinatorEnvironmentOverrides(
  paths: CoordinatorPaths,
  request: CoordinatorLaunchRequest,
  parentWorkspaceId: string | undefined,
  sourceRepo: string,
): Readonly<Record<string, string>> {
  return {
    TANDEM_HOME: paths.home,
    TANDEM_POOL_ROOT: paths.poolRoot,
    TANDEM_SESSION: request.sessionId,
    TANDEM_REPO: paths.repo,
    TANDEM_SOURCE_REPO: sourceRepo,
    ...(parentWorkspaceId === undefined ? {} : { TANDEM_PARENT_WORKSPACE: parentWorkspaceId }),
  };
}

function coordinatorPaneCommand(
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
): string {
  const assignments = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  return quoteShellCommand(["env", ...assignments, ...argv]);
}

/**
 * Writes the pane's launch script. It runs the coordinator, and when the coordinator exits
 * (Ctrl-C, crash) it offers to start it again in the same pane, resuming the saved conversation.
 * Ctrl-C at that offer leaves the user at the pane's own shell.
 */
async function writeCoordinatorBootstrap(
  paths: CoordinatorPaths,
  request: CoordinatorLaunchRequest,
  argv: readonly string[],
  resumeArgv: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = join(paths.home, COORDINATOR_SCRIPT_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const scriptPath = join(
    directory,
    `coordinator-${coordinatorHash(paths.repo)}-${coordinatorHash(request.sessionId)}-${coordinatorHash(argv.join("\0"))}.sh`,
  );
  const temporaryPath = `${scriptPath}.${process.pid}.${randomUUID()}.tmp`;
  // The no-op INT trap keeps this script alive through the coordinator's own Ctrl-C handling;
  // children still get the default signal behavior.
  const script = [
    "#!/bin/sh",
    "set -u",
    "trap : INT",
    coordinatorPaneCommand(argv, environment),
    "while :; do",
    "  trap - INT",
    `  printf '\\n%s\\n%s\\n' "Tandem's coordinator stopped." "Press Enter to start it again where you left off, or Ctrl-C to leave this shell."`,
    "  read -r _ || exit 0",
    "  trap : INT",
    `  ${coordinatorPaneCommand(resumeArgv, environment)}`,
    "done",
    "",
  ].join("\n");
  try {
    await writeFile(temporaryPath, script, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o700,
    });
    await chmod(temporaryPath, 0o700);
    await rename(temporaryPath, scriptPath);
    await chmod(scriptPath, 0o700);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return scriptPath;
}

type HerdrContext = Readonly<{
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly paneId: string;
}>;

function herdrContext(source: TandemEnvironmentSource): HerdrContext | undefined {
  const contextKeys = [
    source.HERDR_SESSION ?? source.HERDR_SESSION_NAME,
    source.HERDR_WORKSPACE_ID,
    source.HERDR_PANE_ID,
  ];
  const herdrActive = source.HERDR_ENV === "1" || source.HERDR_ENV === "true";
  const hasAny = contextKeys.some((value) => value !== undefined);
  if (!herdrActive) {
    if (hasAny)
      throw new Error(
        "Herdr identity variables are present while HERDR_ENV is inactive; refusing to guess the active pane",
      );
    return undefined;
  }
  if (contextKeys.some((value) => value === undefined))
    throw new Error(
      "existing Herdr context is incomplete; require HERDR_SESSION, HERDR_WORKSPACE_ID, and HERDR_PANE_ID",
    );
  return {
    sessionId: text(contextKeys[0], "HERDR_SESSION"),
    workspaceId: text(contextKeys[1], "HERDR_WORKSPACE_ID"),
    paneId: text(contextKeys[2], "HERDR_PANE_ID"),
  };
}

function externalError(argv: readonly string[], result: CommandResult): Error {
  const details = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `${argv[0] ?? "command"} ${argv.slice(1).join(" ")} failed with exit code ${result.code}${details.length === 0 ? "" : `: ${details}`}`,
  );
}

async function runExternal(run: CommandRunner, request: CommandRequest): Promise<CommandResult> {
  const result = await run(request);
  if (result.code !== 0) throw externalError(request.argv, result);
  return result;
}

function parseCreatedWorkspace(
  stdout: string,
): Readonly<{ workspaceId: string; tabId: string; paneId: string }> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(
      `herdr workspace create returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("herdr workspace create returned a non-object response");
  const root = payload as Record<string, unknown>;
  const result = root.result;
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new Error("herdr workspace create response omitted result");
  const resultRecord = result as Record<string, unknown>;
  const workspace = resultRecord.workspace;
  const tab = resultRecord.tab;
  const rootPane = resultRecord.root_pane;
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    Array.isArray(workspace) ||
    tab === null ||
    typeof tab !== "object" ||
    Array.isArray(tab) ||
    rootPane === null ||
    typeof rootPane !== "object" ||
    Array.isArray(rootPane)
  ) {
    throw new Error(
      "herdr workspace create response omitted workspace, tab, or root_pane identity",
    );
  }
  const workspaceId = text(
    (workspace as Record<string, unknown>).workspace_id,
    "result.workspace.workspace_id",
  );
  const tabId = text((tab as Record<string, unknown>).tab_id, "result.tab.tab_id");
  const paneId = text((rootPane as Record<string, unknown>).pane_id, "result.root_pane.pane_id");
  return { workspaceId, tabId, paneId };
}

function coordinatorResultFromRecord(record: CoordinatorRecord): CoordinatorLaunchResult {
  return {
    sessionId: record.endpoint.sessionId,
    repoPath: record.repoPath,
    worktree: record.worktree,
    command: record.command,
    direct: false,
    workspaceId: record.endpoint.workspaceId,
    tabId: record.endpoint.tabId,
    paneId: record.endpoint.paneId,
    reused: true,
  };
}

async function readHerdrRunningState(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  const status = await readHerdrStatus(run, sessionId, cwd, true);
  if (status.running === undefined) {
    throw new Error(
      `Herdr session ${JSON.stringify(sessionId)} status omitted explicit server.running state`,
    );
  }
  return status.running;
}

async function probeHerdrSession(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  return readHerdrRunningState(run, sessionId, cwd);
}

async function waitForHerdr(
  run: CommandRunner,
  sleep: Sleep,
  sessionId: string,
  cwd: string,
): Promise<void> {
  let lastFailure = "Herdr status reported running=false";
  for (let attempt = 0; attempt < HERDR_READY_ATTEMPTS; attempt += 1) {
    if (await readHerdrRunningState(run, sessionId, cwd)) return;
    lastFailure = "Herdr status reported running=false";
    if (attempt + 1 < HERDR_READY_ATTEMPTS) await sleep(HERDR_READY_DELAY_MS);
  }
  throw new Error(
    `Herdr session ${JSON.stringify(sessionId)} did not become ready: ${lastFailure}`,
  );
}

async function waitForCoordinatorOwnership(
  run: CommandRunner,
  sleep: Sleep,
  home: string,
  sessionId: string,
  repoPath: string,
): Promise<CoordinatorRecord> {
  let lastFailure = "no matching coordinator process";
  for (let attempt = 0; attempt < HERDR_READY_ATTEMPTS; attempt += 1) {
    try {
      const record = await findRunningCoordinator(run, { home, sessionId, repoPath });
      if (record !== undefined) return record;
      lastFailure = "no matching coordinator process";
    } catch (error) {
      // The fresh pane can briefly look unrecorded or mismatched before its OMP foreground settles.
      if (
        !(error instanceof Error) ||
        !/coordinator is still running elsewhere|pre-registry Tandem coordinator/.test(
          error.message,
        )
      ) {
        throw error;
      }
      lastFailure = error.message;
    }
    if (attempt + 1 < HERDR_READY_ATTEMPTS) await sleep(HERDR_READY_DELAY_MS);
  }
  throw new Error(
    `coordinator in Herdr session ${JSON.stringify(sessionId)} did not become owned: ${lastFailure}`,
  );
}

/** A running coordinator must still sit clean at its lease base and match any bound source. */
async function assertRunningCoordinatorSource(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
  running: CoordinatorRecord,
  context: HerdrContext | undefined,
): Promise<void> {
  const runningCheckpoint = await readCheckpoint(dependencies.run, {
    repo: running.worktree.path,
  });
  validateCoordinatorCheckout(running.worktree.path, runningCheckpoint, running.worktree.baseHead);
  const boundSourcePath = await validateBoundCoordinatorSource(
    request,
    dependencies,
    running.worktree.baseHead,
    context,
  );
  if (
    boundSourcePath !== undefined &&
    !(await sameCoordinatorPath(boundSourcePath, running.worktree.path))
  ) {
    throw new Error(
      `coordinator source ${JSON.stringify(boundSourcePath)} does not match running coordinator worktree ${JSON.stringify(running.worktree.path)}`,
    );
  }
}

/**
 * Retires the previous coordinator's workspace, giving a shell Herdr just restored time to finish
 * starting. Mid-startup (prompt, fastfetch) the pane does not yet prove a stopped shell, so without
 * waiting the old workspace is left open beside its replacement after every Herdr restart.
 */
async function retireSettledCoordinatorWorkspace(
  dependencies: CoordinatorLaunchDependencies,
  previous: CoordinatorRecord,
): Promise<CoordinatorWorkspaceRetirement> {
  for (let attempt = 1; ; attempt += 1) {
    const retirement = await retireCoordinatorWorkspace(dependencies.run, previous);
    if (retirement.outcome !== "quarantined" || attempt >= RESTORED_SHELL_ATTEMPTS) {
      return retirement;
    }
    await dependencies.sleep(HERDR_READY_DELAY_MS);
  }
}

/** Retires the previous coordinator's workspace, then settles its lease for the replacement. */
async function replacePreviousCoordinator(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
  paths: CoordinatorPaths,
  previous: CoordinatorRecord,
  sourceHead: string,
): Promise<
  Readonly<{
    readonly workspaceRetirement: CoordinatorWorkspaceRetirement;
    readonly previousResources: CoordinatorResourceOutcome;
  }>
> {
  const workspaceRetirement = await retireSettledCoordinatorWorkspace(dependencies, previous);
  const previousResources = await applyCoordinatorReplacement({
    run: dependencies.run,
    home: paths.home,
    sessionId: request.sessionId,
    repoPath: paths.repo,
    clock: dependencies.clock ?? defaultClock,
    newId: dependencies.newId ?? randomUUID,
    decision: decideCoordinatorReplacement({
      previous,
      paneRetirement: workspaceRetirement,
      checkout: await observeCoordinatorCheckout(dependencies.run, previous.worktree.path),
      requestedSourceHead: sourceHead,
      replacementLeaseHolder: coordinatorLeaseIdentity(paths.repo, request.sessionId, sourceHead)
        .tandemId,
    }),
  });
  return { workspaceRetirement, previousResources };
}

export async function launchCoordinatorUnlocked(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
): Promise<CoordinatorLaunchResult> {
  const paths = coordinatorPaths(request);
  const context = herdrContext(dependencies.processEnvironment);
  if (context !== undefined && context.sessionId !== request.sessionId) {
    throw new Error(
      `explicit session ${JSON.stringify(request.sessionId)} does not match current Herdr session ${JSON.stringify(context.sessionId)}`,
    );
  }
  const headless = request.headless || request.noAttach;
  buildCoordinatorArgv({
    cwd: request.cwd,
    model: request.model,
    configPath: request.configPath,
    extensionPath: request.extensionPath,
    continueSession: request.continueSession,
    sessionDirectory: paths.sessionDirectory,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
  });
  const running = await findRunningCoordinator(dependencies.run, {
    home: paths.home,
    sessionId: request.sessionId,
    repoPath: paths.repo,
  });
  if (running !== undefined) {
    await assertRunningCoordinatorSource(request, dependencies, running, context);
    if (request.restart !== true) return coordinatorResultFromRecord(running);
  }
  const sourceHead =
    request.sourceHead ?? (await resolveCoordinatorSourceHead(dependencies.run, paths.repo)).head;
  const previous =
    running ?? (await readCoordinatorRecord(recordPath(paths.home, request.sessionId, paths.repo)));
  const { workspaceRetirement, previousResources } =
    previous === undefined
      ? {}
      : await replacePreviousCoordinator(request, dependencies, paths, previous, sourceHead);
  const boundSourcePath = await validateBoundCoordinatorSource(
    request,
    dependencies,
    sourceHead,
    context,
  );
  const worktree = await acquireCoordinatorLease(request, paths, dependencies, sourceHead);
  // A lease the previous record still names is not this launch's to undo.
  const rollbackEligible = previous === undefined || previous.worktree.leaseId !== worktree.leaseId;
  let ownedEndpoint: Endpoint | undefined;
  let startup: CoordinatorStartupResult;
  try {
    await validateCoordinatorLease(dependencies, worktree, sourceHead, boundSourcePath);
    startup = await startCoordinator({
      request,
      dependencies,
      paths,
      context,
      headless,
      worktree,
      previous,
      workspaceRetirement,
      onEndpointCreated: (endpoint) => {
        ownedEndpoint = endpoint;
      },
    });
  } catch (error) {
    if (!rollbackEligible) throw error;
    const quarantined = await coordinatorStartupFailure({
      request,
      dependencies,
      paths,
      worktree,
      ...(ownedEndpoint === undefined ? {} : { endpoint: ownedEndpoint }),
      error,
    });
    if (quarantined !== undefined) throw quarantined;
    throw error;
  }
  return {
    sessionId: request.sessionId,
    repoPath: paths.repo,
    worktree,
    command: startup.command,
    direct: startup.direct,
    workspaceId: startup.workspaceId,
    paneId: startup.paneId,
    ...(startup.tabId === undefined ? {} : { tabId: startup.tabId }),
    ...(startup.processExitCode === undefined ? {} : { processExitCode: startup.processExitCode }),
    ...(startup.workspaceRetirement === undefined
      ? {}
      : { workspaceRetirement: startup.workspaceRetirement }),
    ...(previousResources === undefined ? {} : { previousResources }),
  };
}

/**
 * Undoes or durably quarantines the pane and lease a failed startup acquired. Returns a
 * replacement error only when something was quarantined and the caller must say so; otherwise
 * the original startup failure still describes what happened.
 */
async function coordinatorStartupFailure(
  input: Readonly<{
    readonly request: CoordinatorLaunchRequest;
    readonly dependencies: CoordinatorLaunchDependencies;
    readonly paths: CoordinatorPaths;
    readonly worktree: WorktreeLease;
    readonly endpoint?: Endpoint;
    readonly error: unknown;
  }>,
): Promise<Error | undefined> {
  const failure = input.error instanceof Error ? input.error.message : String(input.error);
  let rollback: CoordinatorResourceOutcome;
  try {
    rollback = await rollbackCoordinatorAllocation({
      run: input.dependencies.run,
      home: input.paths.home,
      sessionId: input.request.sessionId,
      repoPath: input.paths.repo,
      lease: input.worktree,
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      failure,
      clock: input.dependencies.clock ?? defaultClock,
      newId: input.dependencies.newId ?? randomUUID,
    });
  } catch (rollbackError) {
    return new Error(
      `${failure}; rolling back the new coordinator lease also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      { cause: input.error },
    );
  }
  if (rollback.outcome !== "quarantined") return undefined;
  return new Error(`${rollback.reason}; quarantine record ${rollback.quarantinePath}`, {
    cause: input.error,
  });
}

type CoordinatorStartup = Readonly<{
  readonly request: CoordinatorLaunchRequest;
  readonly dependencies: CoordinatorLaunchDependencies;
  readonly paths: CoordinatorPaths;
  readonly context: HerdrContext | undefined;
  readonly headless: boolean;
  readonly worktree: WorktreeLease;
  readonly previous: CoordinatorRecord | undefined;
  readonly workspaceRetirement: CoordinatorWorkspaceRetirement | undefined;
  /** Reports the replacement pane the moment it exists, so a later failure can retire it. */
  readonly onEndpointCreated: (endpoint: Endpoint) => void;
}>;

type CoordinatorStartupResult = Readonly<{
  readonly command: readonly string[];
  readonly direct: boolean;
  readonly workspaceId: string;
  readonly paneId: string;
  readonly tabId?: string;
  readonly processExitCode?: number;
  readonly workspaceRetirement?: CoordinatorWorkspaceRetirement;
}>;

/** Runs the coordinator in the caller's pane or in a freshly created owned workspace. */
async function startCoordinator(startup: CoordinatorStartup): Promise<CoordinatorStartupResult> {
  const { request, dependencies, paths, context, headless, worktree, previous } = startup;
  let workspaceRetirement = startup.workspaceRetirement;
  const coordinatorCwd = worktree.path;
  const argv = buildCoordinatorArgv({
    cwd: coordinatorCwd,
    model: request.model,
    configPath: request.configPath,
    extensionPath: request.extensionPath,
    continueSession: request.continueSession,
    sessionDirectory: paths.sessionDirectory,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
  });
  const sourceEnvironment = coordinatorEnvironmentOverrides(
    paths,
    request,
    request.parentWorkspaceId ?? context?.workspaceId,
    coordinatorCwd,
  );
  // Turning Jev off hides the key from this coordinator and every task it starts.
  const jevOverride: Readonly<Record<string, string>> =
    (await readModelSettings({ repoPath: paths.repo, home: paths.home })).jev === "off"
      ? { TYPESAFE_API_KEY: "" }
      : {};
  if (context !== undefined && !headless) {
    const environment = mergeInheritedEnvironment(dependencies.processEnvironment, {
      ...sourceEnvironment,
      ...jevOverride,
    });
    const processExitCode = await dependencies.runInteractive({
      argv,
      cwd: coordinatorCwd,
      env: environment,
    });
    if (processExitCode !== 0) throw new Error(`coordinator exited with code ${processExitCode}`);
    return {
      command: argv,
      direct: true,
      workspaceId: context.workspaceId,
      paneId: context.paneId,
      processExitCode,
      ...(workspaceRetirement === undefined ? {} : { workspaceRetirement }),
    };
  }
  const herdrLauncher = headless
    ? ["herdr", "--session", request.sessionId, "server"]
    : ["herdr", "--session", request.sessionId];
  const serverEnvironment = mergeInheritedEnvironment(
    dependencies.processEnvironment,
    sourceEnvironment,
  );
  if (
    context === undefined &&
    !(await probeHerdrSession(dependencies.run, request.sessionId, coordinatorCwd))
  ) {
    // Outside the pool: returning the coordinator's worktree must never end the server.
    await dependencies.startPersistent({
      argv: herdrLauncher,
      cwd: paths.home,
      env: serverEnvironment,
    });
    await waitForHerdr(dependencies.run, dependencies.sleep, request.sessionId, coordinatorCwd);
    // Starting Herdr can restore the previous workspace and its saved label.
    if (previous !== undefined) {
      workspaceRetirement = await retireSettledCoordinatorWorkspace(dependencies, previous);
    }
  }
  const workspaceResult = await runExternal(dependencies.run, {
    argv: [
      "herdr",
      "--session",
      request.sessionId,
      "workspace",
      "create",
      "--cwd",
      coordinatorCwd,
      "--label",
      coordinatorWorkspaceLabel(paths.repo),
      "--no-focus",
    ],
    cwd: coordinatorCwd,
    env: serverEnvironment,
  });
  const workspace = parseCreatedWorkspace(workspaceResult.stdout);
  const endpoint: Endpoint = {
    sessionId: request.sessionId,
    workspaceId: workspace.workspaceId,
    tabId: workspace.tabId,
    paneId: workspace.paneId,
    role: "coordinator",
    generation: 0,
  };
  startup.onEndpointCreated(endpoint);
  const coordinatorEnvironment = {
    ...coordinatorEnvironmentOverrides(
      paths,
      request,
      request.parentWorkspaceId ?? workspace.workspaceId,
      coordinatorCwd,
    ),
    ...jevOverride,
  };
  const resumeArgv = buildCoordinatorArgv({
    cwd: coordinatorCwd,
    model: request.model,
    configPath: request.configPath,
    extensionPath: request.extensionPath,
    continueSession: true,
    sessionDirectory: paths.sessionDirectory,
  });
  const bootstrapPath = await writeCoordinatorBootstrap(
    paths,
    request,
    argv,
    resumeArgv,
    coordinatorEnvironment,
  );
  await runExternal(dependencies.run, {
    argv: [
      "herdr",
      "--session",
      request.sessionId,
      "pane",
      "run",
      workspace.paneId,
      quoteShellCommand(["/bin/sh", bootstrapPath]),
    ],
    cwd: coordinatorCwd,
    env: mergeInheritedEnvironment(dependencies.processEnvironment, coordinatorEnvironment),
  });
  await saveCoordinatorRecord(paths.home, {
    schemaVersion: 1,
    repoPath: paths.repo,
    endpoint,
    worktree,
    command: argv,
  });
  await waitForCoordinatorOwnership(
    dependencies.run,
    dependencies.sleep,
    paths.home,
    request.sessionId,
    paths.repo,
  );
  return {
    command: argv,
    direct: false,
    workspaceId: workspace.workspaceId,
    tabId: workspace.tabId,
    paneId: workspace.paneId,
    ...(workspaceRetirement === undefined ? {} : { workspaceRetirement }),
  };
}

/**
 * Holds one canonical repository's coordinator claim while the caller launches or restarts: the
 * repository lock shared by every session in this Tandem home, then this session's launch lock,
 * then whatever cross-session reconciliation the claim requires. The operation receives what that
 * reconciliation did, so a caller can report it.
 *
 * The explicit parallel-coordinator escape hatch keeps both locks and skips only the claim, so an
 * opted-in launch still serializes against every other launch for the same repository.
 */
export async function withClaimedCoordinatorRepository<Result>(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
  operation: (reconciliations: readonly CoordinatorSessionReconciliation[]) => Promise<Result>,
): Promise<Result> {
  const paths = coordinatorPaths(request);
  return withCoordinatorRepositoryLock(paths.home, paths.repo, () =>
    withCoordinatorLaunchLock(paths.home, request.sessionId, async () => {
      if (parallelCoordinatorsAllowed(dependencies.processEnvironment)) return operation([]);
      const reconciliations = await claimRepositoryCoordinator({
        run: dependencies.run,
        home: paths.home,
        sessionId: request.sessionId,
        repoPath: paths.repo,
        requestedSourceHead: async () =>
          request.sourceHead ??
          (await resolveCoordinatorSourceHead(dependencies.run, paths.repo)).head,
        replacementLeaseHolder: (sourceHead) =>
          coordinatorLeaseIdentity(paths.repo, request.sessionId, sourceHead).tandemId,
        clock: dependencies.clock ?? defaultClock,
        newId: dependencies.newId ?? randomUUID,
      });
      return operation(reconciliations);
    }),
  );
}

export async function launchCoordinator(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
): Promise<CoordinatorLaunchResult> {
  return withClaimedCoordinatorRepository(request, dependencies, async (reconciliations) => {
    const launch = await launchCoordinatorUnlocked(request, dependencies);
    return reconciliations.length === 0
      ? launch
      : { ...launch, otherSessionReconciliations: reconciliations };
  });
}
