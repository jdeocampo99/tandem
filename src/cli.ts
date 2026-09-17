import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWorktree, readCheckpoint, readHerdrStatus, validateModel } from "./adapters.ts";
import { quoteShellCommand, runCommand } from "./commands.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  ModelSpec,
  RepoPolicy,
  TaskKind,
  ThinkingLevel,
  WorktreeLease,
} from "./contracts.ts";
import {
  type CoordinatorRecord,
  findRunningCoordinator,
  saveCoordinatorRecord,
  withCoordinatorLaunchLock,
} from "./coordinator-registry.ts";
import type { PrSummary } from "./delivery.ts";
import {
  resolveTandemEnvironment,
  summarizeTandemActionValue,
  type TandemBoundaryEnvironment,
  type TandemEnvironmentSource,
} from "./extension.ts";
import { parseModelAssignments } from "./policy.ts";
import {
  type CreateTaskRequest,
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "./service.ts";

const DEFAULT_COORDINATOR_CONFIG = "worker-config.yml";
const DEFAULT_COORDINATOR_SESSION = "tandem";
const DEFAULT_WATCH_INTERVAL_MS = 2_000;
const HERDR_READY_ATTEMPTS = 40;
const HERDR_READY_DELAY_MS = 250;
const COORDINATOR_TOOLS = ["read", "grep", "glob", "ask", "tandem"] as const;
const PATH_OPTIONS: Readonly<Record<string, true>> = {
  "--home": true,
  "--pool-root": true,
  "--repo": true,
  "--extension": true,
  "--input": true,
  "--config": true,
  "--artifact": true,
};
const THINKING_LEVELS: Readonly<Record<ThinkingLevel, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};
const TASK_KINDS: Readonly<Record<TaskKind, true>> = {
  scout: true,
  implementation: true,
};
const MERGE_METHODS: Readonly<Record<MergeMethod, true>> = {
  merge: true,
  squash: true,
  rebase: true,
};
const CLI_COMMANDS: Readonly<Record<string, CliCommand>> = {
  launch: "launch",
  models: "models",
  "configure-models": "configure-models",
  doctor: "doctor",
  setup: "setup",
  onboard: "onboard",
  create: "create",
  list: "list",
  status: "list",
  show: "show",
  approve: "approve",
  tick: "tick",
  watch: "watch",
  pause: "pause",
  resume: "resume",
  cancel: "cancel",
  steer: "steer",
  answer: "answer",
  messages: "messages",
  present: "present",
  presentations: "presentations",
  feedback: "feedback",
  describe: "describe",
  publish: "publish",
  merge: "merge",
  cleanup: "cleanup",
};
const PR_COMMANDS: Readonly<Record<string, CliCommand>> = {
  describe: "describe",
  publish: "publish",
  merge: "merge",
};
const CLI_POSITIONAL_LIMITS: Readonly<Record<CliCommand, number>> = {
  launch: 0,
  models: 0,
  "configure-models": 0,
  doctor: 0,
  setup: 1,
  onboard: 1,
  create: 2,
  list: 0,
  show: 1,
  approve: 1,
  tick: 0,
  watch: 0,
  pause: Number.POSITIVE_INFINITY,
  resume: 1,
  cancel: Number.POSITIVE_INFINITY,
  steer: 0,
  answer: 0,
  messages: 0,
  present: 3,
  presentations: 0,
  feedback: 1,
  describe: 2,
  publish: 5,
  merge: 2,
  cleanup: 1,
};

export type MergeMethod = "merge" | "squash" | "rebase";

export type CliCommand =
  | "launch"
  | "models"
  | "configure-models"
  | "doctor"
  | "setup"
  | "onboard"
  | "create"
  | "list"
  | "show"
  | "approve"
  | "tick"
  | "watch"
  | "pause"
  | "resume"
  | "cancel"
  | "steer"
  | "answer"
  | "messages"
  | "present"
  | "presentations"
  | "feedback"
  | "describe"
  | "publish"
  | "merge"
  | "cleanup";

export type CliOptions = Readonly<{
  readonly help: boolean;
  readonly json: boolean;
  readonly yes: boolean;
  readonly write: boolean;
  readonly discard: boolean;
  readonly continueSession: boolean;
  readonly headless: boolean;
  readonly noAttach: boolean;
  readonly home?: string;
  readonly sessionId?: string;
  readonly parentWorkspaceId?: string;
  readonly poolRoot?: string;
  readonly repo?: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly extensionPath?: string;
  readonly configPath?: string;
  readonly intervalMs?: number;
  readonly iterations?: number;
  readonly taskId?: string;
  readonly presentationId?: string;
  readonly reason?: string;
  readonly kind?: TaskKind;
  readonly objective?: string;
  readonly text?: string;
  readonly questionId?: string;
  readonly supersedes: readonly string[];
  readonly repository?: string;
  readonly title?: string;
  readonly base?: string;
  readonly summary?: string;
  readonly method?: MergeMethod;
  readonly input?: string;
  readonly acceptanceCriteria: readonly string[];
  readonly surfaces: readonly string[];
  readonly artifacts: readonly string[];
}>;

export type CliInvocation = Readonly<{
  readonly command: CliCommand;
  readonly options: CliOptions;
  readonly positionals: readonly string[];
}>;

export type CliResult = Readonly<{
  readonly command: CliCommand;
  readonly value?: unknown;
  readonly approvalRequired?: boolean;
  readonly approved?: boolean;
}>;

export type CliRunResult = Readonly<{
  readonly exitCode: number;
  readonly result?: CliResult;
  readonly error?: { readonly name: string; readonly message: string };
}>;

export type CoordinatorLaunchInput = Readonly<{
  readonly cwd: string;
  readonly model: ModelSpec;
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
  readonly home: string;
  readonly poolRoot: string;
  readonly sessionId: string;
  readonly model: ModelSpec;
  readonly configPath: string;
  readonly extensionPath: string;
  readonly continueSession: boolean;
  readonly headless: boolean;
  readonly noAttach: boolean;
  readonly parentWorkspaceId?: string;
  readonly prompt?: string;
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
}>;

export type PathStat = Readonly<{
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}>;

export type PersistentProcess = Readonly<{
  readonly pid: number;
  readonly exited: Promise<number>;
}>;

export type StartPersistent = (
  request: Readonly<{
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
  }>,
) => Promise<PersistentProcess | undefined>;
export type RunInteractive = (
  request: Readonly<{
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
  }>,
) => Promise<number>;
export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type CliSignal = "SIGINT" | "SIGTERM";
export type CliSignalListener = () => void;
export type CliSignalSource = Readonly<{
  readonly on: (signal: CliSignal, listener: CliSignalListener) => void;
  readonly removeListener: (signal: CliSignal, listener: CliSignalListener) => void;
}>;

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

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliConsentError";
  }
}
class CliInterruptError extends Error {
  readonly signal: CliSignal;

  constructor(signal: CliSignal) {
    super(`CLI interrupted by ${signal}`);
    this.name = "CliInterruptError";
    this.signal = signal;
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(`${field} must be non-empty text`);
  }
  if (value.includes("\0")) throw new CliUsageError(`${field} must not contain NUL characters`);
  return value.trim();
}
function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function pathText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(`${field} must be non-empty text`);
  }
  if (value.includes("\0")) throw new CliUsageError(`${field} must not contain NUL characters`);
  if (hasPathControlCharacter(value)) {
    throw new CliUsageError(`${field} must not contain control characters`);
  }
  return value;
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${field} must be a positive integer`);
  }
  return parsed;
}

function optionValue(
  argv: readonly string[],
  index: number,
  name: string,
): Readonly<{ value: string; nextIndex: number }> {
  const token = argv[index];
  if (token === undefined) throw new CliUsageError(`${name} requires a value`);
  const readValue = PATH_OPTIONS[name] === true ? pathText : text;
  const equalsIndex = token.indexOf("=");
  if (equalsIndex >= 0) {
    const value = token.slice(equalsIndex + 1);
    return { value: readValue(value, name), nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new CliUsageError(`${name} requires a value`);
  return { value: readValue(value, name), nextIndex: index + 1 };
}

function parseThinking(value: string): ThinkingLevel {
  if (THINKING_LEVELS[value as ThinkingLevel] !== true) {
    throw new CliUsageError(`unsupported thinking level ${JSON.stringify(value)}`);
  }
  return value as ThinkingLevel;
}

function parseTaskKind(value: string): TaskKind {
  if (TASK_KINDS[value as TaskKind] !== true)
    throw new CliUsageError(`unsupported task kind ${JSON.stringify(value)}`);
  return value as TaskKind;
}

function parseMergeMethod(value: string): MergeMethod {
  if (MERGE_METHODS[value as MergeMethod] !== true)
    throw new CliUsageError(`unsupported merge method ${JSON.stringify(value)}`);
  return value as MergeMethod;
}

type MutableCliOptions = {
  help: boolean;
  json: boolean;
  yes: boolean;
  write: boolean;
  discard: boolean;
  continueSession: boolean;
  headless: boolean;
  noAttach: boolean;
  home?: string;
  sessionId?: string;
  parentWorkspaceId?: string;
  poolRoot?: string;
  repo?: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionPath?: string;
  configPath?: string;
  intervalMs?: number;
  iterations?: number;
  taskId?: string;
  presentationId?: string;
  reason?: string;
  kind?: TaskKind;
  objective?: string;
  text?: string;
  questionId?: string;
  supersedes: string[];
  repository?: string;
  title?: string;
  base?: string;
  summary?: string;
  method?: MergeMethod;
  input?: string;
  acceptanceCriteria: string[];
  surfaces: string[];
  artifacts: string[];
};

function initialOptions(): MutableCliOptions {
  return {
    help: false,
    json: false,
    yes: false,
    write: false,
    discard: false,
    continueSession: false,
    headless: false,
    noAttach: false,
    supersedes: [],
    acceptanceCriteria: [],
    surfaces: [],
    artifacts: [],
  };
}

function commandFromToken(token: string): CliCommand {
  const command = CLI_COMMANDS[token];
  if (command === undefined)
    throw new CliUsageError(`unknown Tandem command ${JSON.stringify(token)}`);
  return command;
}

function parseOption(options: MutableCliOptions, argv: readonly string[], index: number): number {
  const token = argv[index];
  if (token === undefined) throw new CliUsageError("missing CLI argument");
  const equalsIndex = token.indexOf("=");
  const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
  switch (name) {
    case "--help":
      options.help = true;
      return index;
    case "--json":
      options.json = true;
      return index;
    case "--yes":
      options.yes = true;
      return index;
    case "--write":
      options.write = true;
      return index;
    case "--discard":
      options.discard = true;
      return index;
    case "--continue":
      options.continueSession = true;
      return index;
    case "--headless":
      options.headless = true;
      return index;
    case "--no-attach":
      options.noAttach = true;
      return index;
    case "--home": {
      const parsed = optionValue(argv, index, name);
      options.home = parsed.value;
      return parsed.nextIndex;
    }
    case "--session": {
      const parsed = optionValue(argv, index, name);
      options.sessionId = parsed.value;
      return parsed.nextIndex;
    }
    case "--parent-workspace":
    case "--parent": {
      const parsed = optionValue(argv, index, name);
      options.parentWorkspaceId = parsed.value;
      return parsed.nextIndex;
    }
    case "--pool-root": {
      const parsed = optionValue(argv, index, name);
      options.poolRoot = parsed.value;
      return parsed.nextIndex;
    }
    case "--repo": {
      const parsed = optionValue(argv, index, name);
      options.repo = parsed.value;
      return parsed.nextIndex;
    }
    case "--model": {
      const parsed = optionValue(argv, index, name);
      options.model = parsed.value;
      return parsed.nextIndex;
    }
    case "--thinking": {
      const parsed = optionValue(argv, index, name);
      options.thinking = parseThinking(parsed.value);
      return parsed.nextIndex;
    }
    case "--extension": {
      const parsed = optionValue(argv, index, name);
      options.extensionPath = parsed.value;
      return parsed.nextIndex;
    }
    case "--config": {
      const parsed = optionValue(argv, index, name);
      options.configPath = parsed.value;
      return parsed.nextIndex;
    }
    case "--interval-ms": {
      const parsed = optionValue(argv, index, name);
      options.intervalMs = positiveInteger(parsed.value, name);
      return parsed.nextIndex;
    }
    case "--iterations": {
      const parsed = optionValue(argv, index, name);
      options.iterations = positiveInteger(parsed.value, name);
      return parsed.nextIndex;
    }
    case "--kind": {
      const parsed = optionValue(argv, index, name);
      options.kind = parseTaskKind(parsed.value);
      return parsed.nextIndex;
    }
    case "--objective": {
      const parsed = optionValue(argv, index, name);
      options.objective = parsed.value;
      return parsed.nextIndex;
    }
    case "--task":
    case "--task-id": {
      const parsed = optionValue(argv, index, name);
      options.taskId = parsed.value;
      return parsed.nextIndex;
    }
    case "--text": {
      const parsed = optionValue(argv, index, name);
      options.text = parsed.value;
      return parsed.nextIndex;
    }
    case "--question": {
      const parsed = optionValue(argv, index, name);
      options.questionId = parsed.value;
      return parsed.nextIndex;
    }
    case "--supersedes": {
      const parsed = optionValue(argv, index, name);
      options.supersedes.push(parsed.value);
      return parsed.nextIndex;
    }
    case "--presentation":
    case "--presentation-id": {
      const parsed = optionValue(argv, index, name);
      options.presentationId = parsed.value;
      return parsed.nextIndex;
    }
    case "--reason": {
      const parsed = optionValue(argv, index, name);
      options.reason = parsed.value;
      return parsed.nextIndex;
    }
    case "--repository": {
      const parsed = optionValue(argv, index, name);
      options.repository = parsed.value;
      return parsed.nextIndex;
    }
    case "--title": {
      const parsed = optionValue(argv, index, name);
      options.title = parsed.value;
      return parsed.nextIndex;
    }
    case "--base": {
      const parsed = optionValue(argv, index, name);
      options.base = parsed.value;
      return parsed.nextIndex;
    }
    case "--summary": {
      const parsed = optionValue(argv, index, name);
      options.summary = parsed.value;
      return parsed.nextIndex;
    }
    case "--method": {
      const parsed = optionValue(argv, index, name);
      options.method = parseMergeMethod(parsed.value);
      return parsed.nextIndex;
    }
    case "--input": {
      const parsed = optionValue(argv, index, name);
      options.input = parsed.value;
      return parsed.nextIndex;
    }
    case "--acceptance": {
      const parsed = optionValue(argv, index, name);
      options.acceptanceCriteria.push(parsed.value);
      return parsed.nextIndex;
    }
    case "--surface": {
      const parsed = optionValue(argv, index, name);
      options.surfaces.push(parsed.value);
      return parsed.nextIndex;
    }
    case "--artifact": {
      const parsed = optionValue(argv, index, name);
      options.artifacts.push(parsed.value);
      return parsed.nextIndex;
    }
    default:
      throw new CliUsageError(`unknown option ${JSON.stringify(token)}`);
  }
}

/** Parse CLI flags without executing commands or mutating the repository. */
export function parseCliArgs(argv: readonly string[]): CliInvocation {
  const options = initialOptions();
  const positionals: string[] = [];
  let command: CliCommand | undefined;
  let parseOptions = true;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (parseOptions && token === "--") {
      parseOptions = false;
      continue;
    }
    if (parseOptions && token.startsWith("--")) {
      index = parseOption(options, argv, index);
      continue;
    }
    if (command === undefined) {
      if (token === "pr") {
        const nested = argv[index + 1];
        if (nested === undefined)
          throw new CliUsageError("pr requires describe, publish, or merge");
        command = PR_COMMANDS[nested];
        if (command === undefined)
          throw new CliUsageError(`unknown pr command ${JSON.stringify(nested)}`);
        index += 1;
      } else {
        command = commandFromToken(token);
      }
      continue;
    }
    positionals.push(token);
  }
  const resolvedCommand = command ?? "launch";
  const maximumPositionals = CLI_POSITIONAL_LIMITS[resolvedCommand];
  if (positionals.length > maximumPositionals) {
    throw new CliUsageError(
      `${resolvedCommand} accepts at most ${maximumPositionals} positional argument(s)`,
    );
  }
  return { command: resolvedCommand, options, positionals };
}

function requiredPositionOrOption(
  invocation: CliInvocation,
  option: string | undefined,
  position: number,
  field: string,
): string {
  if (option !== undefined && invocation.positionals[position] !== undefined) {
    throw new CliUsageError(`${field} was provided both as an option and a positional argument`);
  }
  return text(option ?? invocation.positionals[position], field);
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value))
    throw new CliUsageError(`${field} must be an array of non-empty strings`);
  const entries: unknown[] = value;
  if (entries.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new CliUsageError(`${field} must be an array of non-empty strings`);
  }
  return entries.map((entry) => text(entry, field));
}
function repoFor(
  invocation: CliInvocation,
  environment: TandemBoundaryEnvironment,
  position = 0,
): string {
  if (invocation.options.repo !== undefined && invocation.positionals[position] !== undefined) {
    throw new CliUsageError(`repoPath was provided both as an option and a positional argument`);
  }
  return pathText(
    invocation.options.repo ?? invocation.positionals[position] ?? environment.repo,
    "repoPath",
  );
}

function taskIdFor(invocation: CliInvocation): string {
  return requiredPositionOrOption(invocation, invocation.options.taskId, 0, "taskId");
}

function parseJsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new CliUsageError(
      `${field} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
async function modelAssignmentsFromFile(
  statPath: (path: string) => Promise<PathStat>,
  file: string,
): Promise<RepoPolicy["models"]> {
  const inputPath = resolve(pathText(file, "input"));
  await verifyRegularPath(statPath, inputPath, "input");
  let source: string;
  try {
    source = await readFile(inputPath, "utf8");
  } catch (error) {
    throw new CliUsageError(
      `input is unavailable at ${inputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseJsonObject(source, "input");
  try {
    return parseModelAssignments(parsed);
  } catch (error) {
    throw new CliUsageError(
      `input must contain a complete model assignment map: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function summaryFromValue(value: string, field = "summary"): PrSummary {
  const object = parseJsonObject(value, field);
  const keys = Object.keys(object);
  for (const key of keys) {
    if (key !== "tldr" && key !== "what" && key !== "why")
      throw new CliUsageError(`${field} contains unknown key ${JSON.stringify(key)}`);
  }
  return {
    tldr: stringArray(object.tldr, `${field}.tldr`),
    what: stringArray(object.what, `${field}.what`),
    why: stringArray(object.why, `${field}.why`),
  };
}

function createInputFromInvocation(
  invocation: CliInvocation,
  environment: TandemBoundaryEnvironment,
): CreateTaskRequest {
  if (invocation.options.input !== undefined) {
    if (
      invocation.positionals.length > 0 ||
      invocation.options.repo !== undefined ||
      invocation.options.objective !== undefined ||
      invocation.options.kind !== undefined ||
      invocation.options.acceptanceCriteria.length > 0 ||
      invocation.options.surfaces.length > 0
    ) {
      throw new CliUsageError(
        "--input cannot be combined with create field flags or positional arguments",
      );
    }
    const object = parseJsonObject(invocation.options.input, "input");
    const allowed = ["repoPath", "kind", "objective", "acceptanceCriteria", "surfaces"] as const;
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key as (typeof allowed)[number]))
        throw new CliUsageError(`input contains unknown key ${JSON.stringify(key)}`);
    }
    return {
      repoPath: pathText(object.repoPath, "input.repoPath"),
      kind: parseTaskKind(text(object.kind, "input.kind")),
      objective: text(object.objective, "input.objective"),
      acceptanceCriteria: stringArray(object.acceptanceCriteria, "input.acceptanceCriteria"),
      surfaces: stringArray(object.surfaces, "input.surfaces"),
    };
  }
  const repoPath = repoFor(invocation, environment);
  const objective = requiredPositionOrOption(
    invocation,
    invocation.options.objective,
    1,
    "objective",
  );
  return {
    repoPath,
    kind: invocation.options.kind ?? "implementation",
    objective,
    acceptanceCriteria: invocation.options.acceptanceCriteria,
    surfaces: invocation.options.surfaces,
  };
}

function summaryForInvocation(invocation: CliInvocation, position: number): PrSummary {
  const value = requiredPositionOrOption(
    invocation,
    invocation.options.summary,
    position,
    "summary",
  );
  return summaryFromValue(value);
}

function checkLaunchText(value: string, field: string): string {
  const checked = text(value, field);
  if (checked.startsWith("-")) throw new CliUsageError(`${field} must not begin with '-'`);
  return checked;
}

function checkLaunchPath(value: string, field: string): string {
  const checked = pathText(value, field);
  if (checked.startsWith("-")) throw new CliUsageError(`${field} must not begin with '-'`);
  return checked;
}

/** Build the coordinator command with least-privilege tools and explicit extension loading. */
export function buildCoordinatorArgv(input: CoordinatorLaunchInput): readonly string[] {
  const cwd = checkLaunchPath(input.cwd, "cwd");
  const configPath = checkLaunchPath(input.configPath, "configPath");
  const extensionPath = checkLaunchPath(input.extensionPath, "extensionPath");
  const model = checkLaunchText(input.model.model, "model.model");
  if (!THINKING_LEVELS[input.model.thinking])
    throw new CliUsageError(`unsupported thinking level ${JSON.stringify(input.model.thinking)}`);
  const argv = [
    "omp",
    "--model",
    model,
    "--thinking",
    input.model.thinking,
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

function coordinatorFiles(
  options: CliOptions,
): Readonly<{ extensionPath: string; configPath: string }> {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const defaultExtensionPath = join(sourceDirectory, "extension.ts");
  const defaultConfigPath = join(sourceDirectory, DEFAULT_COORDINATOR_CONFIG);
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
type CoordinatorWorkspace = Readonly<{
  readonly repoPath: string;
  readonly worktree: WorktreeLease;
}>;

type CoordinatorLaunchDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly processEnvironment: TandemEnvironmentSource;
}>;

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
    tandemId: `coordinator:${repositoryKey}:${sessionKey}:${sourceKey}`,
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

async function readCommittedHead(run: CommandRunner, repo: string): Promise<string> {
  const result = await runExternal(run, {
    argv: ["git", "-C", repo, "rev-parse", "HEAD"],
    cwd: repo,
  });
  return text(result.stdout.trim(), "git checkpoint HEAD");
}

async function acquireCoordinatorWorktree(
  request: CoordinatorLaunchRequest,
  paths: CoordinatorPaths,
  dependencies: CoordinatorLaunchDependencies,
  sourceHead: string,
  normalizedBoundSourcePath: string | undefined,
): Promise<CoordinatorWorkspace> {
  const identity = coordinatorLeaseIdentity(paths.repo, request.sessionId, sourceHead);
  const worktree = await acquireWorktree(dependencies.run, {
    repo: paths.repo,
    root: paths.poolRoot,
    tandemId: identity.tandemId,
    taskName: identity.taskName,
  });
  if (worktree.baseHead !== sourceHead) {
    throw new Error(
      `coordinator lease ${JSON.stringify(worktree.leaseId)} is pinned to ${worktree.baseHead}, expected captured source HEAD ${sourceHead}`,
    );
  }
  if (await sameCoordinatorPath(paths.repo, worktree.path)) {
    throw new Error(
      `coordinator lease ${JSON.stringify(worktree.leaseId)} must be distinct from original repository ${JSON.stringify(paths.repo)}`,
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
  return { repoPath: paths.repo, worktree };
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

async function writeCoordinatorBootstrap(
  paths: CoordinatorPaths,
  request: CoordinatorLaunchRequest,
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = join(paths.home, "coordinator-scripts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const scriptPath = join(
    directory,
    `coordinator-${coordinatorHash(paths.repo)}-${coordinatorHash(request.sessionId)}-${coordinatorHash(argv.join("\0"))}.sh`,
  );
  const temporaryPath = `${scriptPath}.${process.pid}.${randomUUID()}.tmp`;
  const script = `#!/bin/sh\nset -eu\nexec ${coordinatorPaneCommand(argv, environment)}\n`;
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

function mergeInheritedEnvironment(
  inherited: TandemEnvironmentSource,
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) environment[key] = value;
  return environment;
}

async function defaultStatPath(path: string): Promise<PathStat> {
  return lstat(path);
}

async function defaultStartPersistent(
  request: Readonly<{
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
  }>,
): Promise<PersistentProcess> {
  const child = Bun.spawn({
    cmd: [...request.argv],
    cwd: request.cwd,
    ...(request.env === undefined
      ? {}
      : { env: { ...mergeInheritedEnvironment({}, request.env) } }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  return { pid: child.pid, exited: child.exited };
}

async function defaultRunInteractive(
  request: Readonly<{
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
  }>,
): Promise<number> {
  const child = Bun.spawn({
    cmd: [...request.argv],
    cwd: request.cwd,
    ...(request.env === undefined
      ? {}
      : { env: { ...mergeInheritedEnvironment({}, request.env) } }),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

const defaultSleep: Sleep = async (milliseconds, signal) => {
  await new Promise<void>((resolvePromise) => {
    let timer: Timer | undefined;
    let onAbort: () => void = () => undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (): void => {
      cleanup();
      resolvePromise();
    };
    onAbort = (): void => finish();
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(finish, milliseconds);
  });
};
const defaultCliSignalSource: CliSignalSource = {
  on: (signal, listener) => {
    process.on(signal, listener);
  },
  removeListener: (signal, listener) => {
    process.removeListener(signal, listener);
  },
};

type WatchControl = {
  stopped: boolean;
  sleepController: AbortController;
  wake: (() => void) | undefined;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(
    reason === undefined
      ? "CLI operation interrupted"
      : `CLI operation interrupted: ${String(reason)}`,
  );
}

async function waitForWatchDelay(
  sleep: Sleep,
  milliseconds: number,
  control: WatchControl,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (control.stopped || signal?.aborted) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let onAbort: () => void = () => undefined;
    let wake: () => void = () => undefined;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      if (control.wake === wake) control.wake = undefined;
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    onAbort = (): void => {
      control.sleepController.abort(signal?.reason);
      finish(resolve);
    };
    wake = (): void => {
      control.sleepController.abort(new Error("CLI watch interrupted"));
      finish(resolve);
    };
    control.wake = wake;
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    void sleep(milliseconds, control.sleepController.signal).then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function environmentSource(): TandemEnvironmentSource {
  const keys = [
    "TANDEM_HOME",
    "TANDEM_SESSION",
    "TANDEM_PARENT_WORKSPACE",
    "TANDEM_POOL_ROOT",
    "TANDEM_REPO",
    "TANDEM_SOURCE_REPO",
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

function coordinatorWorkspaceLabel(repoPath: string): string {
  return `Tandem coordinator · ${basename(repoPath)}`;
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
      if (
        !(error instanceof Error) ||
        !error.message.includes("does not match recorded OMP command")
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

/** Launch the coordinator in the current owned pane or a newly created named Herdr workspace. */
async function launchCoordinatorUnlocked(
  request: CoordinatorLaunchRequest,
  dependencies: Readonly<{
    readonly run: CommandRunner;
    readonly startPersistent: StartPersistent;
    readonly runInteractive: RunInteractive;
    readonly sleep: Sleep;
    readonly processEnvironment: TandemEnvironmentSource;
  }>,
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
  const sourceHead = await readCommittedHead(dependencies.run, paths.repo);
  const running = await findRunningCoordinator(dependencies.run, {
    home: paths.home,
    sessionId: request.sessionId,
    repoPath: paths.repo,
  });
  if (running !== undefined) {
    const runningCheckpoint = await readCheckpoint(dependencies.run, {
      repo: running.worktree.path,
    });
    validateCoordinatorCheckout(
      running.worktree.path,
      runningCheckpoint,
      running.worktree.baseHead,
    );
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
    return coordinatorResultFromRecord(running);
  }
  const boundSourcePath = await validateBoundCoordinatorSource(
    request,
    dependencies,
    sourceHead,
    context,
  );
  const coordinator = await acquireCoordinatorWorktree(
    request,
    paths,
    dependencies,
    sourceHead,
    boundSourcePath,
  );
  const coordinatorCwd = coordinator.worktree.path;
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
  if (context !== undefined && !headless) {
    const environment = mergeInheritedEnvironment(
      dependencies.processEnvironment,
      sourceEnvironment,
    );
    const processExitCode = await dependencies.runInteractive({
      argv,
      cwd: coordinatorCwd,
      env: environment,
    });
    if (processExitCode !== 0) throw new Error(`coordinator exited with code ${processExitCode}`);
    return {
      sessionId: request.sessionId,
      repoPath: coordinator.repoPath,
      worktree: coordinator.worktree,
      command: argv,
      direct: true,
      workspaceId: context.workspaceId,
      paneId: context.paneId,
      processExitCode,
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
    await dependencies.startPersistent({
      argv: herdrLauncher,
      cwd: coordinatorCwd,
      env: serverEnvironment,
    });
    await waitForHerdr(dependencies.run, dependencies.sleep, request.sessionId, coordinatorCwd);
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
  const coordinatorEnvironment = coordinatorEnvironmentOverrides(
    paths,
    request,
    request.parentWorkspaceId ?? workspace.workspaceId,
    coordinatorCwd,
  );
  const bootstrapPath = await writeCoordinatorBootstrap(
    paths,
    request,
    argv,
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
    repoPath: coordinator.repoPath,
    endpoint: {
      sessionId: request.sessionId,
      workspaceId: workspace.workspaceId,
      tabId: workspace.tabId,
      paneId: workspace.paneId,
      role: "coordinator",
      generation: 0,
    },
    worktree: coordinator.worktree,
    command: argv,
  });
  await waitForCoordinatorOwnership(
    dependencies.run,
    dependencies.sleep,
    paths.home,
    request.sessionId,
    coordinator.repoPath,
  );
  return {
    sessionId: request.sessionId,
    repoPath: coordinator.repoPath,
    worktree: coordinator.worktree,
    command: argv,
    direct: false,
    workspaceId: workspace.workspaceId,
    tabId: workspace.tabId,
    paneId: workspace.paneId,
  };
}

export async function launchCoordinator(
  request: CoordinatorLaunchRequest,
  dependencies: Readonly<{
    readonly run: CommandRunner;
    readonly startPersistent: StartPersistent;
    readonly runInteractive: RunInteractive;
    readonly sleep: Sleep;
    readonly processEnvironment: TandemEnvironmentSource;
  }>,
): Promise<CoordinatorLaunchResult> {
  const paths = coordinatorPaths(request);
  return withCoordinatorLaunchLock(paths.home, request.sessionId, () =>
    launchCoordinatorUnlocked(request, dependencies),
  );
}

async function verifyRegularPath(
  statPath: (path: string) => Promise<PathStat>,
  path: string,
  field: string,
): Promise<void> {
  let stat: PathStat;
  try {
    stat = await statPath(path);
  } catch (error) {
    throw new Error(
      `${field} is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${field} must be a regular non-symlink file: ${path}`);
}

function modelForPolicy(policyModel: ModelSpec, options: CliOptions): ModelSpec {
  if (options.model !== undefined && options.model !== policyModel.model)
    throw new CliUsageError(
      `coordinator model is pinned to ${JSON.stringify(policyModel.model)} by Tandem policy`,
    );
  if (options.thinking !== undefined && options.thinking !== policyModel.thinking)
    throw new CliUsageError(
      `coordinator thinking is pinned to ${JSON.stringify(policyModel.thinking)} by Tandem policy`,
    );
  return policyModel;
}

function requireYes(invocation: CliInvocation, message: string): void {
  if (!invocation.options.yes) throw new CliConsentError(`${message} requires explicit --yes`);
}

const HELP_TEXT = `Tandem coordinator\n\nUsage: bun src/cli.ts [command] [options]\n\nCommands:\n  launch       Launch the OMP coordinator in the owned Herdr context\n  models       List available OMP models and saved global role choices\n  configure-models  Validate and save global role choices (requires --input FILE --yes)\n  doctor       Check model, Herdr, policy, and coordinator files without mutating\n  setup        Propose or write Tandem-owned per-repository policy (requires --yes to write)\n  onboard      Inspect Tandem-owned policy and validation surfaces\n  create       Create a scout or implementation task\n  list/status   List durable tasks\n  show         Show one durable task\n  messages     Inspect steer/answer delivery and blocker questions\n  steer        Queue a concise user direction for a task\n  answer       Answer the task's current needs-decision question\n  approve      Approve implementation scope (requires --yes)\n  tick/watch  Advance bounded scheduler work\n  pause/resume/cancel  Control owned task work\n  present/feedback/presentations  Route and inspect visual work\n  pr describe/publish/merge  Record or publish reviewed PR work\n  cleanup      Release owned resources; --discard requires --yes\n\nSafety options:\n  --yes        Explicit human automation consent for approval-bearing commands\n  --json       Emit one JSON result for automation\n  --headless   Use a named headless Herdr server\n  --no-attach  Do not launch a GUI; use headless Herdr\n`;

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
        const launch = await launchCoordinator(
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
          {
            run,
            startPersistent,
            runInteractive,
            sleep,
            processEnvironment: dependencies.processEnvironment ?? environmentSource(),
          },
        );
        return { command: invocation.command, value: launch };
      }
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
          const result = await run({
            argv: ["herdr", "--session", environment.sessionId, "status", "--json"],
            cwd: environment.repo,
          });
          if (result.code !== 0)
            throw externalError(
              ["herdr", "--session", environment.sessionId, "status", "--json"],
              result,
            );
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
        const repository = requiredPositionOrOption(
          invocation,
          invocation.options.repository,
          1,
          "repository",
        );
        const title = requiredPositionOrOption(invocation, invocation.options.title, 2, "title");
        const base = requiredPositionOrOption(invocation, invocation.options.base, 3, "base");
        return {
          command: invocation.command,
          value: await getService(environment).publish(taskId, {
            repository,
            title,
            base,
            summary: summaryForInvocation(invocation, 4),
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

function renderValue(value: unknown, json: boolean, command?: CliCommand): string {
  if (json) return JSON.stringify(value) ?? "null";
  if (command === "steer" || command === "answer" || command === "messages") {
    return summarizeTandemActionValue(command, value);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** Run one CLI invocation, preserving explicit JSON and non-zero error output for automation. */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<CliRunResult> {
  const application = createCliApplication(dependencies);
  const failure = (error: unknown): CliRunResult => {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    const json = argv.includes("--json") || argv.some((argument) => argument.startsWith("--json="));
    const output = json ? JSON.stringify({ error: { name, message } }) : `tandem: ${message}`;
    (dependencies.stderr ?? ((value: string) => process.stderr.write(value)))(`${output}\n`);
    return {
      exitCode: error instanceof CliUsageError || error instanceof CliConsentError ? 2 : 1,
      error: { name, message },
    };
  };
  let outcome: CliRunResult;
  let removeSignalHandlers: (() => void) | undefined;
  let interruption: CliInterruptError | undefined;
  try {
    const invocation = parseCliArgs(argv);
    const ownsPolling =
      invocation.command === "watch" ||
      invocation.command === "tick" ||
      invocation.command === "feedback";
    const controller = ownsPolling ? new AbortController() : undefined;
    if (controller !== undefined) {
      const processSignals = dependencies.processSignals ?? defaultCliSignalSource;
      const interrupt = (signal: CliSignal): void => {
        if (interruption !== undefined) return;
        interruption = new CliInterruptError(signal);
        controller.abort(interruption);
        void application.shutdown().catch(() => undefined);
      };
      const onSigint = (): void => interrupt("SIGINT");
      const onSigterm = (): void => interrupt("SIGTERM");
      processSignals.on("SIGINT", onSigint);
      processSignals.on("SIGTERM", onSigterm);
      removeSignalHandlers = (): void => {
        processSignals.removeListener("SIGINT", onSigint);
        processSignals.removeListener("SIGTERM", onSigterm);
      };
    }
    const result = await application.invoke(invocation, controller?.signal);
    if (interruption !== undefined) throw interruption;
    const output = renderValue(result.value, invocation.options.json, result.command);
    (dependencies.stdout ?? ((value: string) => process.stdout.write(value)))(
      `${output}${output.endsWith("\n") ? "" : "\n"}`,
    );
    outcome = { exitCode: 0, result };
  } catch (error) {
    outcome = failure(interruption ?? error);
  }
  try {
    await application.shutdown();
  } catch (error) {
    outcome = failure(interruption ?? error);
  } finally {
    removeSignalHandlers?.();
  }
  if (interruption !== undefined && outcome.exitCode === 0) outcome = failure(interruption);
  return outcome;
}

if (import.meta.main) {
  const result = await runCli();
  process.exitCode = result.exitCode;
}
