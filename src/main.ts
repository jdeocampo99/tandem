#!/usr/bin/env bun
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import {
  type CliApplication,
  type CliDependencies,
  createCliApplication,
  parseCliArgs,
  type RunInteractive,
} from "./cli.ts";
import { runCommand } from "./commands.ts";
import type { CommandRunner, RepoPolicy } from "./contracts.ts";
import { listCoordinatorRecords, resetCoordinators } from "./coordinator-registry.ts";
import type { TandemEnvironmentSource } from "./extension.ts";
import { createTandemService, type TandemService, type TandemServiceOptions } from "./service.ts";
import {
  askProjectSelection,
  askProjectSettingsApproval,
  runModelOnboarding,
  type TerminalPrompt,
  type TerminalPrompter,
} from "./terminal-onboarding.ts";

const DEFAULT_SESSION_ID = "tandem";
const HELP_TEXT = `Tandem\n\nUsage:\n  tandem [PATH ...]              Open or reconnect project coordinators\n  tandem --reset [PATH ...]      Stop idle Tandem coordinators, then reopen them\n  tandem configure [PATH]        Choose and save all six global role models\n  tandem --help                  Show this help\n\nWith no PATH for a launch, Tandem opens all saved projects under ~/.tandem/repositories. If no projects\nare saved, it opens the current Git project; outside a Git project it offers registered projects or an\nexplicit path. Explicit PATH values override the saved registry and select only those projects. Multiple\nPATH values share one Herdr session and are attached once after every coordinator is ready.\n\n--reset applies only to the selected Tandem coordinators: with no PATH it selects all saved projects,\nand explicit PATH values select only that subset. It stops and reopens idle owned coordinators while\nretaining settings, conversation history, task records, worktrees, and repository files. Preflight refuses\nbusy, unknown, foreign, or unsafe coordinators before any pane closes. A later race or native close failure\ncan leave a partial reset; errors identify already-stopped projects. Reset never recovers tasks or wipes data.\nRun it from a separate normal terminal, not from inside Herdr. Add --continue only to resume each saved\nconversation; without it, the reopened coordinators start fresh conversations.\n\nThe configure command always uses one project as its catalogue anchor; with no PATH it keeps the\ncurrent-Git or interactive one-project flow and never expands to all saved projects.\n\nOptions:\n  --reset                       Reopen only selected idle Tandem coordinators (launch only)\n  --home PATH                    Tandem durable home (default: TANDEM_HOME or ~/.tandem)\n  --session ID                   Shared Herdr/OMP session (default: TANDEM_SESSION or tandem)\n  --pool-root PATH               Private Treehouse pool (default: <home>/pool)\n  --continue                     Resume each project's coordinator conversation\n  --headless                     Prepare coordinators without attaching Herdr\n  --no-attach                    Do not attach Herdr after preparing coordinators\n  -h, --help                     Show this help\n\nThe first setup asks explicitly for a catalogue-backed model and thinking level for each of the six\nroles. Blank answers, cancellation, or declining the recap never chooses a default and never launches.\nGlobal choices are saved only in <home>/models.json; project settings are saved only in\n<home>/repositories/<key>/config.json. Neither operation changes application files.\n`;

type TerminalCommand = "launch" | "configure";

export type TerminalInvocation = Readonly<{
  readonly command: TerminalCommand;
  readonly paths: readonly string[];
  readonly help: boolean;
  readonly home?: string;
  readonly sessionId?: string;
  readonly poolRoot?: string;
  readonly continueSession: boolean;
  readonly headless: boolean;
  readonly noAttach: boolean;
  readonly reset: boolean;
}>;

export type TerminalRunResult = Readonly<{
  readonly exitCode: number;
  readonly status: "help" | "launched" | "configured" | "cancelled" | "error";
  readonly projects?: readonly string[];
  readonly sessionId?: string;
  readonly launches?: readonly unknown[];
  readonly error?: Readonly<{ readonly name: string; readonly message: string }>;
}>;

export type TerminalMainDependencies = Readonly<{
  readonly cwd?: string;
  readonly processEnvironment?: TandemEnvironmentSource;
  readonly run?: CommandRunner;
  readonly service?: TandemService;
  readonly createService?: (options: TandemServiceOptions) => TandemService;
  readonly application?: CliApplication;
  readonly createApplication?: (dependencies: CliDependencies) => CliApplication;
  readonly runInteractive?: RunInteractive;
  readonly prompt?: TerminalPrompt;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly errorOutput?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly resetCoordinators?: typeof resetCoordinators;
}>;

type ResolvedTerminalEnvironment = Readonly<{
  readonly cwd: string;
  readonly home: string;
  readonly sessionId: string;
  readonly poolRoot: string;
  readonly source: TandemEnvironmentSource;
}>;

type ProjectState = Readonly<{
  readonly repoPath: string;
  readonly existingConfig: boolean;
  readonly configPath: string;
  readonly modelSettings: Readonly<{
    readonly configured: boolean;
    readonly models?: RepoPolicy["models"];
  }>;
}>;

type ReadlineResources = Readonly<{
  readonly prompter: TerminalPrompter;
  readonly close: () => void;
}>;

function processEnvironmentSnapshot(): TandemEnvironmentSource {
  const source: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) source[key] = value;
  return source;
}

function optionValue(
  argv: readonly string[],
  index: number,
  name: string,
): Readonly<{ value: string; next: number }> {
  const token = argv[index] ?? "";
  const equal = token.indexOf("=");
  if (equal >= 0) {
    const value = token.slice(equal + 1);
    if (value.trim().length === 0) throw new Error(`${name} requires a non-empty value`);
    return { value, next: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
    throw new Error(`${name} requires a non-empty value`);
  }
  return { value, next: index + 1 };
}

/** Parses the small user-facing terminal command without executing anything. */
export function parseTerminalArgs(argv: readonly string[]): TerminalInvocation {
  let command: TerminalCommand | undefined;
  let help = false;
  let home: string | undefined;
  let sessionId: string | undefined;
  let poolRoot: string | undefined;
  let continueSession = false;
  let reset = false;
  let headless = false;
  let noAttach = false;
  const paths: string[] = [];
  let parseOptions = true;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (parseOptions && token === "--") {
      parseOptions = false;
      continue;
    }
    if (parseOptions && (token === "-h" || token === "--help")) {
      help = true;
      continue;
    }
    if (parseOptions && token === "--continue") {
      continueSession = true;
      continue;
    }
    if (parseOptions && token === "--reset") {
      reset = true;
      continue;
    }
    if (parseOptions && token === "--headless") {
      headless = true;
      continue;
    }
    if (parseOptions && token === "--no-attach") {
      noAttach = true;
      continue;
    }
    if (parseOptions && (token === "--home" || token.startsWith("--home="))) {
      const parsed = optionValue(argv, index, "--home");
      home = parsed.value;
      index = parsed.next;
      continue;
    }
    if (parseOptions && (token === "--session" || token.startsWith("--session="))) {
      const parsed = optionValue(argv, index, "--session");
      sessionId = parsed.value;
      index = parsed.next;
      continue;
    }
    if (parseOptions && (token === "--pool-root" || token.startsWith("--pool-root="))) {
      const parsed = optionValue(argv, index, "--pool-root");
      poolRoot = parsed.value;
      index = parsed.next;
      continue;
    }
    if (parseOptions && token.startsWith("-")) {
      throw new Error(`unknown option ${JSON.stringify(token)}; run tandem --help`);
    }
    if (command === undefined && token === "configure") {
      command = "configure";
      continue;
    }
    if (command === undefined) command = "launch";
    paths.push(token);
  }

  const resolvedCommand = command ?? "launch";
  if (resolvedCommand === "configure" && paths.length > 1) {
    throw new Error("tandem configure accepts at most one project path");
  }
  if (resolvedCommand === "configure" && reset) {
    throw new Error("tandem --reset is launch-only; it cannot be combined with configure");
  }
  return {
    command: resolvedCommand,
    paths,
    help,
    ...(home === undefined ? {} : { home }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(poolRoot === undefined ? {} : { poolRoot }),
    continueSession,
    reset,
    headless,
    noAttach,
  };
}

function streamIsTTY(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return (stream as { readonly isTTY?: unknown }).isTTY === true;
}

function writeText(output: NodeJS.WritableStream, text: string): void {
  output.write(text);
}

function defaultRunInteractive(request: Parameters<RunInteractive>[0]): Promise<number> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  if (request.env !== undefined) Object.assign(environment, request.env);
  const child = Bun.spawn({
    cmd: [...request.argv],
    cwd: request.cwd,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

function createReadlineResources(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ReadlineResources {
  let readline: Interface | undefined;
  const ensureReadline = () => {
    if (readline === undefined) readline = createInterface({ input, output });
    return readline;
  };
  return {
    prompter: {
      ask: (question) => ensureReadline().question(question),
      write: (text) => writeText(output, text),
    },
    close: () => {
      readline?.close();
      readline = undefined;
    },
  };
}

function resolvedEnvironment(
  invocation: TerminalInvocation,
  dependencies: TerminalMainDependencies,
): ResolvedTerminalEnvironment {
  const source = dependencies.processEnvironment ?? processEnvironmentSnapshot();
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const home = resolve(invocation.home ?? source.TANDEM_HOME ?? join(homedir(), ".tandem"));
  const sessionId =
    invocation.sessionId ??
    source.TANDEM_SESSION ??
    source.HERDR_SESSION ??
    source.HERDR_SESSION_NAME ??
    DEFAULT_SESSION_ID;
  if (sessionId.trim().length === 0 || /[\r\n\u2028\u2029]/u.test(sessionId)) {
    throw new Error("session id must be non-empty single-line text");
  }
  const poolRoot = resolve(invocation.poolRoot ?? source.TANDEM_POOL_ROOT ?? join(home, "pool"));
  return { cwd, home, sessionId, poolRoot, source };
}

async function canonicalExistingPath(candidate: string): Promise<string> {
  const physical = await realpath(candidate);
  const details = await stat(physical);
  if (!details.isDirectory()) throw new Error(`project path must be a directory: ${candidate}`);
  return physical;
}

/** Resolves a path through Git so symlink aliases and subdirectories use one real project root. */
export async function gitRootForPath(
  candidate: string,
  cwd: string,
  run: CommandRunner,
): Promise<string | undefined> {
  const requested = resolve(cwd, candidate);
  const physical = await canonicalExistingPath(requested);
  const result = await run({
    argv: ["git", "-C", physical, "rev-parse", "--show-toplevel"],
    cwd: physical,
  });
  if (result.code !== 0) return undefined;
  const output = result.stdout.trim();
  if (output.length === 0) throw new Error(`git returned no repository root for ${requested}`);
  const root = await canonicalExistingPath(resolve(physical, output));
  return root;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRegisteredProjects(home: string): Promise<readonly string[]> {
  const directory = join(home, "repositories");
  let entries: readonly Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const projects: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const configPath = join(directory, entry.name, "config.json");
    let details: Stats;
    try {
      details = await lstat(configPath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`registered project record is not a regular file: ${configPath}`);
    }
    const text = await readFile(configPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(
        `registered project record ${configPath} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.repoPath !== "string") {
      throw new Error(
        `registered project record ${configPath} has no valid schemaVersion or repoPath`,
      );
    }
    const repoPath = parsed.repoPath.trim();
    if (repoPath.length === 0 || !isAbsolute(repoPath)) {
      throw new Error(`registered project record ${configPath} contains a non-absolute repoPath`);
    }
    try {
      const canonical = await canonicalExistingPath(repoPath);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        projects.push(canonical);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return projects.sort((left, right) => left.localeCompare(right));
}
async function canonicalIfAvailable(candidate: string): Promise<string | undefined> {
  try {
    return await canonicalExistingPath(candidate);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function gitCommonDirectory(root: string, run: CommandRunner): Promise<string> {
  const result = await run({
    argv: ["git", "-C", root, "rev-parse", "--git-common-dir"],
    cwd: root,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `could not validate Git identity for ${root}${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  const common = result.stdout.trim();
  if (common.length === 0) throw new Error(`Git returned no common directory for ${root}`);
  return realpath(resolve(root, common));
}

async function validateSharedGitIdentity(
  originalRoot: string,
  checkoutRoot: string,
  run: CommandRunner,
): Promise<void> {
  if (originalRoot === checkoutRoot) {
    throw new Error("coordinator identity claimed a clean checkout identical to the original root");
  }
  const [originalCommon, checkoutCommon] = await Promise.all([
    gitCommonDirectory(originalRoot, run),
    gitCommonDirectory(checkoutRoot, run),
  ]);
  if (originalCommon !== checkoutCommon) {
    throw new Error(
      `coordinator identity roots ${JSON.stringify(originalRoot)} and ${JSON.stringify(checkoutRoot)} do not share a Git common directory`,
    );
  }
}

async function mapCoordinatorCheckoutIdentity(
  root: string,
  environment: ResolvedTerminalEnvironment,
  run: CommandRunner,
  allowRegistryLookup: boolean,
): Promise<string> {
  const sourceValue = environment.source.TANDEM_SOURCE_REPO;
  const originalValue = environment.source.TANDEM_REPO;
  if (sourceValue !== undefined && originalValue !== undefined) {
    const sourcePath = await canonicalIfAvailable(sourceValue);
    if (sourcePath === root) {
      const originalRoot = await gitRootForPath(originalValue, environment.cwd, run);
      if (originalRoot === undefined) {
        throw new Error(
          "TANDEM_REPO is not a Git repository for the active coordinator checkout; refusing to onboard the clean checkout",
        );
      }
      await validateSharedGitIdentity(originalRoot, root, run);
      return originalRoot;
    }
  }
  if (!allowRegistryLookup) return root;

  const records = await listCoordinatorRecords(environment.home, environment.sessionId);
  const matches: string[] = [];
  for (const record of records) {
    const worktreePath = await canonicalIfAvailable(record.worktree.path);
    if (worktreePath === root) matches.push(record.repoPath);
  }
  if (matches.length > 1) {
    throw new Error(
      `multiple coordinator records claim clean checkout ${JSON.stringify(root)}; refusing to guess the original project`,
    );
  }
  const recordedOriginal = matches[0];
  if (recordedOriginal === undefined) return root;
  const originalRoot = await gitRootForPath(recordedOriginal, environment.cwd, run);
  if (originalRoot === undefined) {
    throw new Error(
      `coordinator registry points to a non-Git original project ${JSON.stringify(recordedOriginal)}; refusing to onboard the clean checkout`,
    );
  }
  await validateSharedGitIdentity(originalRoot, root, run);
  return originalRoot;
}

function interactiveFor(
  dependencies: TerminalMainDependencies,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): boolean {
  if (dependencies.prompt !== undefined) return true;
  return dependencies.isTTY ?? (streamIsTTY(input) && streamIsTTY(output));
}

function noTtyError(operation: string): Error {
  return new Error(
    `${operation} needs an interactive terminal for explicit choices; rerun from a TTY or provide a configured project path. No settings or coordinator was started.`,
  );
}

async function resolveProjectRoots(
  paths: readonly string[],
  environment: ResolvedTerminalEnvironment,
  run: CommandRunner,
  currentRootForMapping?: string,
): Promise<readonly string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const root = await gitRootForPath(path, environment.cwd, run);
    if (root === undefined) {
      throw new Error(
        `${path} is not inside a Git repository; Tandem requires the actual Git root`,
      );
    }
    const projectRoot = await mapCoordinatorCheckoutIdentity(
      root,
      environment,
      run,
      root === currentRootForMapping,
    );
    if (!seen.has(projectRoot)) {
      seen.add(projectRoot);
      roots.push(projectRoot);
    }
  }
  return roots;
}

async function selectProjects(
  invocation: TerminalInvocation,
  environment: ResolvedTerminalEnvironment,
  run: CommandRunner,
  interactive: boolean,
  prompter: TerminalPrompter | undefined,
): Promise<readonly string[] | undefined> {
  if (invocation.paths.length > 0) {
    const current = await gitRootForPath(environment.cwd, environment.cwd, run);
    return resolveProjectRoots(invocation.paths, environment, run, current);
  }

  let registered: readonly string[] | undefined;
  if (invocation.command === "launch") {
    registered = await readRegisteredProjects(environment.home);
    if (registered.length > 0) {
      return resolveProjectRoots(registered, environment, run);
    }
  }

  const current = await gitRootForPath(environment.cwd, environment.cwd, run);
  if (current !== undefined) {
    return [await mapCoordinatorCheckoutIdentity(current, environment, run, true)];
  }
  if (!interactive || prompter === undefined) throw noTtyError("project selection");
  registered ??= await readRegisteredProjects(environment.home);
  const selected = await askProjectSelection(prompter, registered);
  if (selected === undefined) return undefined;
  return resolveProjectRoots(selected, environment, run);
}

function createServiceFor(
  environment: ResolvedTerminalEnvironment,
  run: CommandRunner,
  dependencies: TerminalMainDependencies,
): TandemService {
  if (dependencies.service !== undefined) return dependencies.service;
  return (dependencies.createService ?? createTandemService)({
    home: environment.home,
    sessionId: environment.sessionId,
    poolRoot: environment.poolRoot,
    run,
  });
}

async function readProjectStates(
  roots: readonly string[],
  service: TandemService,
): Promise<readonly ProjectState[]> {
  const states: ProjectState[] = [];
  for (const repoPath of roots) {
    const onboarding = await service.onboard(repoPath, false);
    states.push({
      repoPath,
      existingConfig: onboarding.existingConfig,
      configPath: onboarding.configPath,
      modelSettings: onboarding.modelSettings,
    });
  }
  return states;
}

function firstModelSettings(
  states: readonly ProjectState[],
): Readonly<{ configured: boolean; models?: RepoPolicy["models"] }> {
  const settings = states[0]?.modelSettings;
  if (settings === undefined) throw new Error("Tandem could not inspect the selected project");
  return settings;
}

async function runConfigure(
  roots: readonly string[],
  environment: ResolvedTerminalEnvironment,
  service: TandemService,
  prompter: TerminalPrompter,
  output: (text: string) => void,
): Promise<TerminalRunResult> {
  const anchor = roots[0];
  if (anchor === undefined)
    throw new Error("configure needs a project path or one registered project");
  const modelOptions = await service.models(anchor);
  const modelSettings = modelOptions.modelSettings;
  const decision = await runModelOnboarding({
    mode: modelSettings.configured ? "saved" : "first",
    availableModels: modelOptions.availableModels,
    ...(modelSettings.models === undefined ? {} : { currentModels: modelSettings.models }),
    prompter,
    home: environment.home,
  });
  if (decision.status === "cancelled" || decision.models === undefined) {
    return {
      exitCode: 0,
      status: "cancelled",
      projects: roots,
      sessionId: environment.sessionId,
    };
  }
  if (decision.action === "save" || decision.action === "change") {
    await service.configureModels({ repoPath: anchor, models: decision.models });
  }
  output(
    decision.action === "keep"
      ? "Saved six-role choices kept; no coordinator was launched.\n"
      : `Saved six-role choices in ${environment.home}/models.json; no coordinator was launched.\n`,
  );
  return {
    exitCode: 0,
    status: "configured",
    projects: roots,
    sessionId: environment.sessionId,
  };
}

async function prepareProjects(
  states: readonly ProjectState[],
  environment: ResolvedTerminalEnvironment,
  service: TandemService,
  prompter: TerminalPrompter | undefined,
  interactive: boolean,
): Promise<readonly ProjectState[] | undefined> {
  const settings = firstModelSettings(states);
  const needsNewProjectChoice = states.some((state) => !state.existingConfig);
  if (!settings.configured || needsNewProjectChoice) {
    if (!interactive || prompter === undefined) throw noTtyError("Tandem onboarding");
    const anchor = states[0];
    if (anchor === undefined) throw new Error("Tandem could not inspect the selected project");
    const modelOptions = await service.models(anchor.repoPath);
    const decision = await runModelOnboarding({
      mode: settings.configured ? "saved" : "first",
      availableModels: modelOptions.availableModels,
      ...(settings.models === undefined ? {} : { currentModels: settings.models }),
      prompter,
      home: environment.home,
    });
    if (decision.status === "cancelled" || decision.models === undefined) return undefined;
    if (decision.action === "save" || decision.action === "change") {
      await service.configureModels({ repoPath: anchor.repoPath, models: decision.models });
    }
  }

  for (const state of states) {
    if (state.existingConfig) continue;
    if (!interactive || prompter === undefined) throw noTtyError("project settings approval");
    const approved = await askProjectSettingsApproval(prompter, state.repoPath, state.configPath);
    if (!approved) return undefined;
    await service.onboard(state.repoPath, true);
  }
  return states;
}

function launchProcessEnvironment(source: TandemEnvironmentSource): TandemEnvironmentSource {
  const sanitized: Record<string, string | undefined> = { ...source };
  delete sanitized.TANDEM_SOURCE_REPO;
  delete sanitized.TANDEM_PARENT_WORKSPACE;
  return sanitized;
}

function hasActiveHerdrContext(source: TandemEnvironmentSource): boolean {
  const session = source.HERDR_SESSION ?? source.HERDR_SESSION_NAME;
  return (
    (source.HERDR_ENV === "1" || source.HERDR_ENV === "true") &&
    session !== undefined &&
    source.HERDR_WORKSPACE_ID !== undefined &&
    source.HERDR_PANE_ID !== undefined
  );
}

function workspaceIdFromLaunch(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.workspaceId === "string" && value.workspaceId.trim().length > 0
    ? value.workspaceId
    : undefined;
}
async function launchProjects(
  roots: readonly string[],
  invocation: TerminalInvocation,
  environment: ResolvedTerminalEnvironment,
  dependencies: TerminalMainDependencies,
  service: TandemService,
  run: CommandRunner,
): Promise<readonly unknown[]> {
  const applicationDependencies: CliDependencies = {
    cwd: environment.cwd,
    processEnvironment: launchProcessEnvironment(environment.source),
    run,
    service,
    runInteractive: dependencies.runInteractive ?? defaultRunInteractive,
    ...(dependencies.stdout === undefined ? {} : { stdout: dependencies.stdout }),
    ...(dependencies.stderr === undefined ? {} : { stderr: dependencies.stderr }),
  };
  const application =
    dependencies.application ??
    (dependencies.createApplication ?? createCliApplication)(applicationDependencies);
  const launches: unknown[] = [];
  try {
    for (const repoPath of roots) {
      const args = [
        "launch",
        "--repo",
        repoPath,
        "--home",
        environment.home,
        "--pool-root",
        environment.poolRoot,
        "--session",
        environment.sessionId,
        "--headless",
        "--no-attach",
        ...(invocation.continueSession ? ["--continue"] : []),
      ];
      const result = await application.invoke(parseCliArgs(args));
      launches.push(result.value);
    }
  } finally {
    await application.shutdown();
  }

  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const interactive = dependencies.isTTY ?? (streamIsTTY(input) && streamIsTTY(output));
  const shouldAttach = !invocation.headless && !invocation.noAttach && interactive;
  if (shouldAttach) {
    const first = roots[0];
    if (first === undefined) throw new Error("no project was prepared for Herdr attachment");
    const workspaceId = workspaceIdFromLaunch(launches[0]);
    if (workspaceId === undefined) {
      throw new Error(
        "coordinator launch returned no workspace identity; refusing to attach an unrelated Herdr workspace",
      );
    }
    const herdrEnvironment = {
      TANDEM_HOME: environment.home,
      TANDEM_POOL_ROOT: environment.poolRoot,
      TANDEM_SESSION: environment.sessionId,
    };
    const focus = await run({
      argv: ["herdr", "--session", environment.sessionId, "workspace", "focus", workspaceId],
      cwd: first,
      env: herdrEnvironment,
    });
    if (focus.code !== 0) {
      const detail = focus.stderr.trim() || focus.stdout.trim();
      throw new Error(
        `Herdr workspace focus failed with code ${focus.code}${detail.length === 0 ? "" : `: ${detail}`}`,
      );
    }
    if (!hasActiveHerdrContext(environment.source)) {
      const attach = await (dependencies.runInteractive ?? defaultRunInteractive)({
        argv: ["herdr", "--session", environment.sessionId],
        cwd: first,
        env: herdrEnvironment,
      });
      if (attach !== 0) throw new Error(`Herdr attachment exited with code ${attach}`);
    }
  }
  return launches;
}

/** Runs the shared-session terminal front door and returns a process-style result. */
export async function runTerminal(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: TerminalMainDependencies = {},
): Promise<TerminalRunResult> {
  const outputStream = dependencies.output ?? process.stdout;
  const errorStream = dependencies.errorOutput ?? process.stderr;
  const stdout = dependencies.stdout ?? ((text: string) => writeText(outputStream, text));
  const stderr = dependencies.stderr ?? ((text: string) => writeText(errorStream, text));
  try {
    const invocation = parseTerminalArgs(argv);
    if (invocation.help) {
      stdout(HELP_TEXT);
      return { exitCode: 0, status: "help" };
    }
    const environment = resolvedEnvironment(invocation, dependencies);
    if (invocation.reset && hasActiveHerdrContext(environment.source)) {
      throw new Error(
        "tandem --reset cannot run from inside Herdr; rerun it from a separate normal terminal",
      );
    }
    const run = dependencies.run ?? runCommand;
    const input = dependencies.input ?? process.stdin;
    const output = dependencies.output ?? process.stdout;
    const interactive = interactiveFor(dependencies, input, output);
    let resources: ReadlineResources | undefined;
    let prompter: TerminalPrompter | undefined;
    if (dependencies.prompt !== undefined) {
      prompter = { ask: dependencies.prompt, write: stdout };
    } else if (interactive) {
      resources = createReadlineResources(input, output);
      prompter = resources.prompter;
    }
    try {
      const roots = await selectProjects(invocation, environment, run, interactive, prompter);
      if (roots === undefined) {
        stdout("Tandem cancelled; no settings were changed and no coordinator was launched.\n");
        return { exitCode: 0, status: "cancelled" };
      }
      if (roots.length === 0) throw new Error("no projects were selected");
      if (invocation.command === "configure" && roots.length !== 1) {
        throw new Error("tandem configure needs exactly one project to validate the OMP catalogue");
      }
      const service = createServiceFor(environment, run, dependencies);
      if (invocation.command === "configure") {
        if (!interactive || prompter === undefined) throw noTtyError("tandem configure");
        return await runConfigure(roots, environment, service, prompter, stdout);
      }
      const states = await readProjectStates(roots, service);
      const prepared = await prepareProjects(states, environment, service, prompter, interactive);
      if (prepared === undefined) {
        stdout("Tandem cancelled; no coordinator was launched.\n");
        return {
          exitCode: 0,
          status: "cancelled",
          projects: roots,
          sessionId: environment.sessionId,
        };
      }
      resources?.close();
      resources = undefined;
      if (invocation.reset) {
        const stopped = await (dependencies.resetCoordinators ?? resetCoordinators)(run, {
          home: environment.home,
          sessionId: environment.sessionId,
          repoPaths: roots,
        });
        stdout(
          `Tandem reset stopped ${stopped.length} coordinator${stopped.length === 1 ? "" : "s"}.\n`,
        );
      }
      const launches = await launchProjects(
        roots,
        invocation,
        environment,
        dependencies,
        service,
        run,
      );
      stdout(
        `Tandem prepared ${roots.length} project${roots.length === 1 ? "" : "s"} in shared Herdr session ${environment.sessionId}.\n`,
      );
      return {
        exitCode: 0,
        status: "launched",
        projects: roots,
        sessionId: environment.sessionId,
        launches,
      };
    } finally {
      resources?.close();
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    stderr(`tandem: ${message}\n`);
    return { exitCode: 1, status: "error", error: { name, message } };
  }
}

if (import.meta.main) {
  const result = await runTerminal();
  process.exitCode = result.exitCode;
}
