import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { quoteShellCommand } from "../adapters/commands.ts";
import { AdapterCommandError, readGitText } from "../adapters/primitives.ts";
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
import {
  type CoordinatorFile,
  type Harness,
  harnessOf,
  type LaunchIo,
  type LaunchSpec,
  type StartedAgent,
} from "../harness/contract.ts";
import { launchIo } from "../harness/launch-io.ts";
import { harnessFor } from "../harness/resolve.ts";
import { tryShowCatchUp } from "../memory/native-visits.ts";
import { CliUsageError, parseThinking, text } from "../terminal/cli-argument-values.ts";
import type { CliOptions } from "../terminal/cli-arguments.ts";
import { checkLaunchPath, checkLaunchText } from "../terminal/cli-input.ts";
import type { RunInteractive, Sleep, StartPersistent } from "../terminal/cli-process.ts";
import { mergeInheritedEnvironment } from "../terminal/cli-process.ts";
import { terminalContextFor } from "../terminal-backend/compose.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import {
  type CoordinatorSessionReconciliation,
  claimRepositoryCoordinator,
  parallelCoordinatorsAllowed,
} from "./exclusivity.ts";
import { withCoordinatorLaunchLock, withCoordinatorRepositoryLock } from "./lock.ts";
import { COORDINATOR_SCRIPT_DIRECTORY, findRunningCoordinator } from "./ownership.ts";
import { openPanelBeside } from "./panel.ts";
import { COORDINATOR_LEASE_HOLDER_PREFIX, type CoordinatorRecord, recordPath } from "./record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "./registry.ts";
import {
  acquireCoordinatorLease,
  applyCoordinatorReplacement,
  type CoordinatorResourceOutcome,
  decideCoordinatorReplacement,
  observeCoordinatorCheckout,
  readCoordinatorCheckoutState,
  rollbackCoordinatorAllocation,
} from "./resources.ts";
import { resolveCoordinatorSourceHead, startCoordinatorSourceHead } from "./source.ts";
import {
  type CoordinatorWorkspaceRetirement,
  coordinatorWorkspaceLabel,
  findRestoredCoordinatorPanes,
  type RetiredRecord,
  retireCoordinatorWorkspace,
} from "./workspace.ts";

const READY_ATTEMPTS = 40;
const READY_DELAY_MS = 250;
/** How long a coordinator shell Herdr just restored gets to finish starting before it counts as busy. */
const RESTORED_SHELL_ATTEMPTS = 20;

function defaultClock(): string {
  return new Date().toISOString();
}

export type CoordinatorLaunchInput = Readonly<{
  readonly cwd: string;
  /**
   * Picks the harness too. Unset runs OMP's own default model: the Tandem coordinator before any
   * model is chosen.
   */
  readonly model: ModelSpec | undefined;
  readonly continueSession?: boolean;
  readonly sessionDirectory: string;
  /** The conversation's id, for a harness that names conversations by id (Claude Code). */
  readonly conversationId?: string;
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
  /**
   * Picks the harness a new coordinator runs on; a running one keeps the harness its record names.
   * Unset runs OMP's own default model: the Tandem coordinator before any model is chosen.
   */
  readonly model: ModelSpec | undefined;
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
  /** Why the Tandem panel could not open beside the coordinator, when it could not. */
  readonly panelFailure?: string;
  /** An optional catch-up warning after a successful visible launch or reconnect. */
  readonly catchUpWarning?: string;
}>;

export type CoordinatorLaunchDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
  readonly startPersistent: StartPersistent;
  readonly runInteractive: RunInteractive;
  readonly sleep: Sleep;
  readonly processEnvironment: TandemEnvironmentSource;
  /** Timestamps quarantine notes; defaults to the wall clock. */
  readonly clock?: () => string;
  /** Names quarantine notes and new Claude Code conversations; defaults to a random UUID. */
  readonly newId?: () => string;
  /** Whether a unix socket answers `GET /health`; defaults to asking it. */
  readonly answersHealth?: (socket: string) => Promise<boolean>;
  /** Whether a file exists, which tells a saved Claude Code conversation from one never saved. */
  readonly exists?: (path: string) => Promise<boolean>;
  /** Milliseconds on a monotonic clock, for the ready wait; defaults to `performance.now`. */
  readonly now?: () => number;
  /** Checks the files and model a new coordinator needs on the harness it would launch on. */
  readonly checkNewCoordinator?: (harness: Harness, model: ModelSpec | undefined) => Promise<void>;
  readonly rehomeTaskWorkspaces?: (
    input: Readonly<{
      readonly home: string;
      readonly cwd: string;
      readonly sessionId: string;
      readonly parentWorkspaceId: string;
    }>,
  ) => Promise<readonly string[]>;
}>;
/** Checks caller-supplied launch values. */
function coordinatorLaunchSpec(input: CoordinatorLaunchInput): LaunchSpec {
  return {
    agent: "coordinator",
    cwd: checkLaunchPath(input.cwd, "cwd"),
    model:
      input.model === undefined
        ? undefined
        : {
            model: checkLaunchText(input.model.model, "model.model"),
            thinking: parseThinking(input.model.thinking),
          },
    conversation: {
      kind: "saved",
      directory: checkLaunchPath(input.sessionDirectory, "sessionDirectory"),
      resume: input.continueSession === true,
      ...(input.conversationId === undefined
        ? {}
        : { id: checkLaunchText(input.conversationId, "conversationId") }),
    },
    ...(input.prompt === undefined ? {} : { prompt: checkLaunchText(input.prompt, "prompt") }),
  };
}

/** Checks caller-supplied launch values, then builds the coordinator command. */
export function buildCoordinatorArgv(input: CoordinatorLaunchInput): readonly string[] {
  return harnessFor(harnessOf(input.model)).command(coordinatorLaunchSpec(input));
}

/** The CLI's options that may name a coordinator file, only to confirm it. */
const FILE_CONFIRMATIONS = [
  {
    name: "extension",
    flag: "--extension",
    option: "extensionPath",
    mismatch: (path: string) =>
      `coordinator extension must be Tandem's checked-in extension at ${path}`,
  },
  {
    name: "config",
    flag: "--config",
    option: "configPath",
    mismatch: (path: string) =>
      `coordinator config must be the checked-in fallback-disabled config at ${path}`,
  },
] as const;

/** The coordinator's checked-in files; the CLI may name the extension and config only to confirm them. */
export function coordinatorFiles(
  harness: Harness,
  options: CliOptions,
): readonly CoordinatorFile[] {
  for (const confirmation of FILE_CONFIRMATIONS) {
    const named = options[confirmation.option];
    if (named === undefined) continue;
    const file = harness.coordinatorFiles.find((entry) => entry.name === confirmation.name);
    if (file === undefined) {
      throw new CliUsageError(
        `this coordinator runs in ${harness.executable}, which loads no ${confirmation.name} file; leave out ${confirmation.flag}`,
      );
    }
    if (resolve(named) !== resolve(file.path)) {
      throw new CliUsageError(confirmation.mismatch(file.path));
    }
  }
  return harness.coordinatorFiles;
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

/**
 * Refuses a coordinator that cannot launch, before anything is replaced. Only a new coordinator
 * takes its harness from the model; a running one keeps the harness its record names.
 */
export async function checkNewCoordinator(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
): Promise<void> {
  const harness = harnessFor(harnessOf(request.model));
  await dependencies.checkNewCoordinator?.(harness, request.model);
  coordinatorLaunchSpec({
    cwd: request.cwd,
    model: request.model,
    continueSession: request.continueSession,
    sessionDirectory: coordinatorPaths(request).sessionDirectory,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
  });
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

function headMismatch(head: string, expectedHead: string): string | undefined {
  return head === expectedHead
    ? undefined
    : `HEAD ${head} does not match captured source HEAD ${expectedHead}`;
}

function refuseUnsafeCheckout(path: string, reasons: readonly (string | undefined)[]): void {
  const found = reasons.filter((reason) => reason !== undefined);
  if (found.length > 0) {
    throw new Error(`coordinator worktree ${JSON.stringify(path)} is unsafe: ${found.join("; ")}`);
  }
}

/** Reads a checkout and refuses one that is dirty, has unmerged paths, or is not at `expectedHead`. */
async function assertCleanCheckoutAt(
  run: CommandRunner,
  path: string,
  expectedHead: string,
): Promise<void> {
  const checkout = await readCoordinatorCheckoutState(run, path);
  refuseUnsafeCheckout(path, [
    checkout.dirty ? "worktree is dirty" : undefined,
    checkout.unmerged ? "worktree has unmerged paths" : undefined,
    headMismatch(checkout.head, expectedHead),
  ]);
}

async function validateBoundCoordinatorSource(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
  expectedHead: string,
  context: InsidePane | undefined,
): Promise<string | undefined> {
  const boundSourcePath =
    request.sourceRepo === undefined && context === undefined
      ? undefined
      : (request.sourceRepo ?? dependencies.processEnvironment.TANDEM_SOURCE_REPO);
  if (boundSourcePath === undefined) return undefined;
  const normalizedBoundSourcePath = resolve(boundSourcePath);
  await assertCleanCheckoutAt(dependencies.run, normalizedBoundSourcePath, expectedHead);
  return normalizedBoundSourcePath;
}

async function acquireCoordinatorSourceLease(
  request: CoordinatorLaunchRequest,
  paths: CoordinatorPaths,
  dependencies: CoordinatorLaunchDependencies,
  sourceHead: string,
): Promise<WorktreeLease> {
  const identity = coordinatorLeaseIdentity(paths.repo, request.sessionId, sourceHead);
  return acquireCoordinatorLease(dependencies.run, paths.home, {
    repo: paths.repo,
    root: paths.poolRoot,
    tandemId: identity.tandemId,
    taskName: identity.taskName,
    sourceHead,
  });
}

/**
 * Proves an acquired coordinator lease is the clean, commit-pinned checkout the launch asked for.
 * The acquire has just proven the checkout clean, on its own branch, with no unmerged paths, in
 * this same launch with nothing between; rereading that would only repeat it, so the commit it sits
 * on is the one fact left to read.
 */
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
  const head = await readGitText(
    dependencies.run,
    worktree.path,
    ["rev-parse", "HEAD"],
    "git coordinator lease HEAD",
  );
  refuseUnsafeCheckout(worktree.path, [headMismatch(head, sourceHead)]);
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

function withoutVariables(
  environment: Readonly<Record<string, string>>,
  cleared: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !cleared.includes(key)));
}

type PaneEnvironment = Readonly<{
  set: Readonly<Record<string, string>>;
  cleared: readonly string[];
}>;

function coordinatorPaneCommand(argv: readonly string[], environment: PaneEnvironment): string {
  const clears = environment.cleared.flatMap((name) => ["-u", name]);
  const assignments = Object.entries(environment.set).map(([key, value]) => `${key}=${value}`);
  return quoteShellCommand(["env", ...clears, ...assignments, ...argv]);
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
  environment: PaneEnvironment,
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

type InsidePane = Readonly<{ sessionId: string; workspaceId: string; paneId: string }>;

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

/** A terminal command the launch sends fails with the same plain error as its own commands. */
async function asExternal<Result>(operation: Promise<Result>): Promise<Result> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof AdapterCommandError) throw externalError(error.request.argv, error.result);
    throw error;
  }
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

async function waitForTerminal(
  terminal: TerminalBackend,
  sleep: Sleep,
  sessionId: string,
  cwd: string,
): Promise<void> {
  let lastFailure = "Herdr status reported running=false";
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    if (await terminal.sessionRunning({ sessionId, cwd })) return;
    lastFailure = "Herdr status reported running=false";
    if (attempt + 1 < READY_ATTEMPTS) await sleep(READY_DELAY_MS);
  }
  throw new Error(
    `Herdr session ${JSON.stringify(sessionId)} did not become ready: ${lastFailure}`,
  );
}

async function waitForCoordinatorOwnership(
  run: CommandRunner,
  terminal: TerminalBackend,
  sleep: Sleep,
  home: string,
  sessionId: string,
  repoPath: string,
): Promise<CoordinatorRecord> {
  let lastFailure = "no matching coordinator process";
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    try {
      const record = await findRunningCoordinator(run, terminal, { home, sessionId, repoPath });
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
    if (attempt + 1 < READY_ATTEMPTS) await sleep(READY_DELAY_MS);
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
  context: InsidePane | undefined,
): Promise<void> {
  await assertCleanCheckoutAt(dependencies.run, running.worktree.path, running.worktree.baseHead);
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
  home: string,
  previous: RetiredRecord,
): Promise<CoordinatorWorkspaceRetirement> {
  for (let attempt = 1; ; attempt += 1) {
    const retirement = await retireCoordinatorWorkspace(dependencies.terminal, home, previous);
    if (retirement.outcome !== "quarantined" || attempt >= RESTORED_SHELL_ATTEMPTS) {
      return retirement;
    }
    await dependencies.sleep(READY_DELAY_MS);
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
  const workspaceRetirement = await retireSettledCoordinatorWorkspace(
    dependencies,
    paths.home,
    previous,
  );
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
  const inherited = terminalContextFor(dependencies.terminal.name).inheritedPane(
    dependencies.processEnvironment,
  );
  if (inherited.status === "invalid") throw new Error(inherited.reason);
  const context: InsidePane | undefined =
    inherited.status === "inside"
      ? {
          sessionId: text(inherited.sessionId, "HERDR_SESSION"),
          workspaceId: text(inherited.workspaceId, "HERDR_WORKSPACE_ID"),
          paneId: text(inherited.paneId, "HERDR_PANE_ID"),
        }
      : undefined;
  if (context !== undefined && context.sessionId !== request.sessionId) {
    throw new Error(
      `explicit session ${JSON.stringify(request.sessionId)} does not match current Herdr session ${JSON.stringify(context.sessionId)}`,
    );
  }
  const headless = request.headless || request.noAttach;
  const running = await findRunningCoordinator(dependencies.run, dependencies.terminal, {
    home: paths.home,
    sessionId: request.sessionId,
    repoPath: paths.repo,
  });
  if (running !== undefined) {
    await assertRunningCoordinatorSource(request, dependencies, running, context);
    if (request.restart !== true) {
      const panelFailure = await openPanelBeside(dependencies.terminal, paths.home, running);
      const catchUp = headless
        ? undefined
        : await tryShowCatchUp(dependencies.terminal, {
            home: paths.home,
            record: running,
            now: (dependencies.clock ?? defaultClock)(),
          });
      return {
        ...coordinatorResultFromRecord(running),
        ...(panelFailure === undefined ? {} : { panelFailure }),
        ...(catchUp?.warning === undefined ? {} : { catchUpWarning: catchUp.warning }),
      };
    }
  }
  // The fetch behind the source head does not depend on the new-coordinator check, so they overlap.
  const pendingSourceHead: Promise<string> =
    request.sourceHead !== undefined
      ? Promise.resolve(request.sourceHead)
      : startCoordinatorSourceHead(dependencies.run, paths.repo).then((source) => source.head);
  pendingSourceHead.catch(() => undefined);
  // A restart checked before it closed the coordinator it replaces.
  if (request.restart !== true) {
    try {
      await checkNewCoordinator(request, dependencies);
    } catch (error) {
      await pendingSourceHead.catch(() => undefined);
      throw error;
    }
  }
  const sourceHead = await pendingSourceHead;
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
  const worktree = await acquireCoordinatorSourceLease(request, paths, dependencies, sourceHead);
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
    ...(startup.panelFailure === undefined ? {} : { panelFailure: startup.panelFailure }),
    ...(startup.catchUpWarning === undefined ? {} : { catchUpWarning: startup.catchUpWarning }),
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
      terminal: input.dependencies.terminal,
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
  readonly context: InsidePane | undefined;
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
  readonly panelFailure?: string;
  readonly catchUpWarning?: string;
}>;

function coordinatorLaunchIo(dependencies: CoordinatorLaunchDependencies): LaunchIo {
  return launchIo({
    sleep: dependencies.sleep,
    ...(dependencies.newId === undefined ? {} : { newId: dependencies.newId }),
    ...(dependencies.answersHealth === undefined
      ? {}
      : { answersHealth: dependencies.answersHealth }),
    ...(dependencies.exists === undefined ? {} : { exists: dependencies.exists }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}

async function processIdsNaming(
  run: CommandRunner,
  needle: string,
  cwd: string,
): Promise<readonly string[]> {
  const listing = await runExternal(run, { argv: ["ps", "-axww", "-o", "pid=,command="], cwd });
  return listing.stdout
    .split("\n")
    .filter((line) => line.includes(needle))
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((pid) => pid.length > 0 && pid !== String(process.pid));
}

/**
 * Stops the coordinator a failed ready wait leaves behind, found by the conversation its command
 * names, and waits until it has exited so its pane is a stopped shell again.
 */
async function stopUnreadyCoordinator(
  dependencies: CoordinatorLaunchDependencies,
  harness: Harness,
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  const needle = harness.processNeedle(argv);
  if (needle === undefined) throw new Error("the coordinator command names no conversation");
  const pids = await processIdsNaming(dependencies.run, needle, cwd);
  if (pids.length === 0) return;
  await runExternal(dependencies.run, { argv: ["kill", "-TERM", ...pids], cwd });
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    if ((await processIdsNaming(dependencies.run, needle, cwd)).length === 0) return;
    await dependencies.sleep(READY_DELAY_MS);
  }
  throw new Error(`the coordinator naming ${needle} did not exit after SIGTERM`);
}

/** Waits for the coordinator to load Tandem; one that does not is stopped and the launch fails. */
async function awaitReadyOrStop(
  dependencies: CoordinatorLaunchDependencies,
  harness: Harness,
  started: StartedAgent,
  argv: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await harness.awaitReady(started, coordinatorLaunchIo(dependencies), signal);
  } catch (error) {
    try {
      await stopUnreadyCoordinator(dependencies, harness, argv, cwd);
    } catch (stopError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Stopping it also failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Runs the coordinator in the caller's pane with its ready wait beside it. The wait ends when the
 * coordinator exits; a coordinator that never gets ready is stopped and the launch fails.
 */
async function runDirectCoordinator(
  dependencies: CoordinatorLaunchDependencies,
  harness: Harness,
  started: StartedAgent,
  request: Parameters<RunInteractive>[0],
): Promise<number> {
  const exited = new AbortController();
  const outcome = dependencies.runInteractive(request).then(
    (code) => ({ ok: true as const, code }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void outcome.then(() => exited.abort());
  await awaitReadyOrStop(dependencies, harness, started, request.argv, request.cwd, exited.signal);
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.code;
}

/** Runs the coordinator in the caller's pane or in a freshly created owned workspace. */
async function startCoordinator(startup: CoordinatorStartup): Promise<CoordinatorStartupResult> {
  const { request, dependencies, paths, context, headless, worktree, previous } = startup;
  let workspaceRetirement = startup.workspaceRetirement;
  const coordinatorCwd = worktree.path;
  const harness = harnessFor(harnessOf(request.model));
  const conversation = await harness.conversation(
    {
      home: paths.home,
      directory: paths.sessionDirectory,
      resume: request.continueSession,
      cwd: coordinatorCwd,
    },
    coordinatorLaunchIo(dependencies),
  );
  // Every harness keeps a coordinator's conversation, which always has a directory.
  if (conversation.kind !== "saved") throw new Error("the coordinator has no saved conversation");
  const started: StartedAgent = {
    agent: "coordinator",
    home: paths.home,
    repo: paths.repo,
    conversation,
  };
  const argvFor = (resume: boolean, prompt: string | undefined): readonly string[] =>
    buildCoordinatorArgv({
      cwd: coordinatorCwd,
      model: request.model,
      continueSession: resume,
      sessionDirectory: paths.sessionDirectory,
      ...(conversation.id === undefined ? {} : { conversationId: conversation.id }),
      ...(prompt === undefined ? {} : { prompt }),
    });
  const argv = argvFor(conversation.resume, request.prompt);
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
  const inherited = mergeInheritedEnvironment(dependencies.processEnvironment, {});
  if (context !== undefined && !headless) {
    const environment = withoutVariables(
      dependencies.terminal.launchEnvironment({
        overrides: {
          ...sourceEnvironment,
          ...dependencies.terminal.paneIdentity({
            sessionId: request.sessionId,
            workspaceId: context.workspaceId,
          }),
          ...harness.launchEnvironment,
          ...jevOverride,
        },
        inherited,
      }),
      harness.clearedEnvironment,
    );
    const processExitCode = await runDirectCoordinator(dependencies, harness, started, {
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
  const terminalLauncher = headless
    ? dependencies.terminal.serverCommand(request.sessionId)
    : dependencies.terminal.clientCommand(request.sessionId);
  const serverEnvironment = dependencies.terminal.launchEnvironment({
    overrides: sourceEnvironment,
    inherited,
  });
  if (
    context === undefined &&
    !(await dependencies.terminal.sessionRunning({
      sessionId: request.sessionId,
      cwd: coordinatorCwd,
    }))
  ) {
    // Outside the pool: returning the coordinator's worktree must never end the server.
    await dependencies.startPersistent({
      argv: terminalLauncher,
      cwd: paths.home,
      env: serverEnvironment,
    });
    await waitForTerminal(
      dependencies.terminal,
      dependencies.sleep,
      request.sessionId,
      coordinatorCwd,
    );
    // Starting Herdr can restore the previous workspace and its saved label.
    if (previous !== undefined) {
      workspaceRetirement = await retireSettledCoordinatorWorkspace(
        dependencies,
        paths.home,
        previous,
      );
    }
  }
  if (previous === undefined) {
    const restored = await findRestoredCoordinatorPanes(dependencies.terminal, {
      sessionId: request.sessionId,
      repoPath: paths.repo,
      worktree,
    });
    for (const record of restored) {
      workspaceRetirement = await retireSettledCoordinatorWorkspace(
        dependencies,
        paths.home,
        record,
      );
    }
  }
  const { endpoint } = await asExternal(
    dependencies.terminal.createWorkspace({
      sessionId: request.sessionId,
      cwd: coordinatorCwd,
      label: coordinatorWorkspaceLabel(paths.repo),
      role: "coordinator",
      generation: 0,
      env: dependencies.terminal.paneEnvironment({ overrides: sourceEnvironment, inherited }),
      ...(previous === undefined ? {} : { previousEndpoint: previous.endpoint }),
    }),
  );
  startup.onEndpointCreated(endpoint);
  const coordinatorEnvironment = {
    ...coordinatorEnvironmentOverrides(
      paths,
      request,
      request.parentWorkspaceId ?? endpoint.workspaceId,
      coordinatorCwd,
    ),
    ...harness.launchEnvironment,
    ...jevOverride,
    ...dependencies.terminal.paneIdentity(endpoint),
  };
  const resumeArgv = argvFor(true, undefined);
  const bootstrapPath = await writeCoordinatorBootstrap(paths, request, argv, resumeArgv, {
    set: coordinatorEnvironment,
    cleared: harness.clearedEnvironment,
  });
  await asExternal(
    dependencies.terminal.runCommand({
      endpoint,
      cwd: coordinatorCwd,
      command: ["/bin/sh", bootstrapPath],
      env: dependencies.terminal.paneEnvironment({
        overrides: coordinatorEnvironment,
        inherited,
      }),
    }),
  );
  await saveCoordinatorRecord(paths.home, {
    schemaVersion: 1,
    repoPath: paths.repo,
    endpoint,
    worktree,
    harness: harnessOf(request.model),
    command: argv,
  });
  // The panel needs only this exact pane, not a started coordinator, and its open can wait out a
  // terminal that never confirms it. Opening it beside the coordinator's startup keeps that wait
  // off the launch's critical path; it never rejects, so the failure is reported, not thrown.
  const panelOpening = openPanelBeside(dependencies.terminal, paths.home, {
    repoPath: paths.repo,
    endpoint,
    worktree,
  });
  let owned: CoordinatorRecord;
  try {
    await awaitReadyOrStop(dependencies, harness, started, argv, coordinatorCwd);
    owned = await waitForCoordinatorOwnership(
      dependencies.run,
      dependencies.terminal,
      dependencies.sleep,
      paths.home,
      request.sessionId,
      paths.repo,
    );
  } catch (error) {
    // The rollback retires this workspace and its panel, so the open must have settled first.
    await panelOpening;
    throw error;
  }
  const panelFailure = await panelOpening;
  const catchUp = headless
    ? undefined
    : await tryShowCatchUp(dependencies.terminal, {
        home: paths.home,
        record: owned,
        now: (dependencies.clock ?? defaultClock)(),
      });
  return {
    command: argv,
    direct: false,
    workspaceId: endpoint.workspaceId,
    tabId: endpoint.tabId,
    paneId: endpoint.paneId,
    ...(workspaceRetirement === undefined ? {} : { workspaceRetirement }),
    ...(panelFailure === undefined ? {} : { panelFailure }),
    ...(catchUp?.warning === undefined ? {} : { catchUpWarning: catchUp.warning }),
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
        terminal: dependencies.terminal,
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
