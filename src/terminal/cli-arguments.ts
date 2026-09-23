import type { TaskKind, ThinkingLevel } from "../contracts.ts";

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
  restart: "restart",
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
  cancel: "cancel",
  resume: "resume",
  steer: "steer",
  answer: "answer",
  messages: "messages",
  present: "present",
  presentations: "presentations",
  feedback: "feedback",
  describe: "describe",
  publish: "publish",
  draft: "draft",
  cleanup: "cleanup",
  inspect: "inspect",
  "recovery-plan": "recovery-plan",
  reconcile: "reconcile",
  "review-existing": "review-existing",
  "validation-retry": "validation-retry",
  "evidence-repair": "evidence-repair",
  "delivery-preflight": "delivery-preflight",
};
const PR_COMMANDS: Readonly<Record<string, CliCommand>> = {
  describe: "describe",
  publish: "publish",
  draft: "draft",
  merge: "merge",
};
const CLI_POSITIONAL_LIMITS: Readonly<Record<CliCommand, number>> = {
  launch: 0,
  restart: 1,
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
  draft: 4,
  merge: 2,
  cleanup: 1,
  inspect: 1,
  "recovery-plan": 1,
  reconcile: 1,
  "review-existing": 1,
  "validation-retry": 1,
  "evidence-repair": 1,
  "delivery-preflight": 3,
};

export type MergeMethod = "merge" | "squash" | "rebase";

export type CliCommand =
  | "launch"
  | "restart"
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
  | "draft"
  | "merge"
  | "cleanup"
  | "inspect"
  | "recovery-plan"
  | "reconcile"
  | "review-existing"
  | "validation-retry"
  | "evidence-repair"
  | "delivery-preflight";

export type CliOptions = Readonly<{
  readonly help: boolean;
  readonly json: boolean;
  readonly yes: boolean;
  readonly write: boolean;
  readonly discard: boolean;
  readonly continueSession: boolean;
  readonly restart: boolean;
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
  readonly head?: string;
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

export function text(value: unknown, field: string): string {
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

export function pathText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliUsageError(`${field} must be non-empty text`);
  }
  if (value.includes("\0")) throw new CliUsageError(`${field} must not contain NUL characters`);
  if (hasPathControlCharacter(value)) {
    throw new CliUsageError(`${field} must not contain control characters`);
  }
  return value;
}

export function positiveInteger(value: string, field: string): number {
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

export function parseThinking(value: string): ThinkingLevel {
  if (THINKING_LEVELS[value as ThinkingLevel] !== true) {
    throw new CliUsageError(`unsupported thinking level ${JSON.stringify(value)}`);
  }
  return value as ThinkingLevel;
}

export function parseTaskKind(value: string): TaskKind {
  if (TASK_KINDS[value as TaskKind] !== true)
    throw new CliUsageError(`unsupported task kind ${JSON.stringify(value)}`);
  return value as TaskKind;
}

export function parseMergeMethod(value: string): MergeMethod {
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
  restart: boolean;
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
  head?: string;
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
    restart: false,
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
    case "--restart":
      options.restart = true;
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
    case "--head": {
      const parsed = optionValue(argv, index, name);
      options.head = parsed.value;
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

export function requiredPositionOrOption(
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

export function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value))
    throw new CliUsageError(`${field} must be an array of non-empty strings`);
  const entries: unknown[] = value;
  if (entries.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new CliUsageError(`${field} must be an array of non-empty strings`);
  }
  return entries.map((entry) => text(entry, field));
}

export function parseJsonObject(value: string, field: string): Record<string, unknown> {
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
