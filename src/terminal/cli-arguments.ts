import type { CreatableTaskKind, ThinkingLevel } from "../contracts.ts";

const PATH_OPTIONS: Readonly<Record<string, true>> = {
  "--home": true,
  "--pool-root": true,
  "--repo": true,
  "--cwd": true,
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
const TASK_KINDS: Readonly<Record<CreatableTaskKind, true>> = {
  scout: true,
  implementation: true,
};
const MERGE_METHODS: Readonly<Record<MergeMethod, true>> = {
  merge: true,
  squash: true,
  rebase: true,
};
const CLI_COMMANDS: Readonly<Record<string, CliCommand>> = {
  "brief-comment": "brief-comment",
  "brief-request-changes": "brief-request-changes",
  "brief-approve": "brief-approve",
  "pr-comment": "pr-comment",
  open: "open",
  "review-submit": "review-submit",
  launch: "launch",
  restart: "restart",
  models: "models",
  "configure-models": "configure-models",
  "configure-merging": "configure-merging",
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
  "delivery-preflight": "delivery-preflight",
};
const PR_COMMANDS: Readonly<Record<string, CliCommand>> = {
  describe: "describe",
  publish: "publish",
  draft: "draft",
  merge: "merge",
};
const CLI_POSITIONAL_LIMITS: Readonly<Record<CliCommand, number>> = {
  "brief-comment": 1,
  "brief-request-changes": 1,
  "brief-approve": 1,
  "pr-comment": 1,
  open: 2,
  "review-submit": 1,
  launch: 0,
  restart: 1,
  models: 0,
  "configure-models": 0,
  "configure-merging": 0,
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
  publish: 4,
  draft: 3,
  merge: 2,
  cleanup: 1,
  inspect: 1,
  "delivery-preflight": 2,
};

export type MergeMethod = "merge" | "squash" | "rebase";

export type CliCommand =
  | "brief-comment"
  | "brief-request-changes"
  | "brief-approve"
  | "pr-comment"
  | "open"
  | "review-submit"
  | "launch"
  | "restart"
  | "models"
  | "configure-models"
  | "configure-merging"
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
  readonly presentationId?: string;
  readonly reason?: string;
  readonly kind?: CreatableTaskKind;
  readonly objective?: string;
  readonly text?: string;
  readonly questionId?: string;
  readonly viewPaneId?: string;
  readonly viewWindowId?: string;
  readonly viewCwd?: string;
  readonly supersedes: readonly string[];
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

export function parseTaskKind(value: string): CreatableTaskKind {
  if (TASK_KINDS[value as CreatableTaskKind] !== true)
    throw new CliUsageError(`unsupported task kind ${JSON.stringify(value)}`);
  return value as CreatableTaskKind;
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
  presentationId?: string;
  reason?: string;
  kind?: CreatableTaskKind;
  objective?: string;
  text?: string;
  questionId?: string;
  viewPaneId?: string;
  viewWindowId?: string;
  viewCwd?: string;
  supersedes: string[];
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

type OptionSpec =
  | Readonly<{ readonly takesValue: false; readonly apply: (options: MutableCliOptions) => void }>
  | Readonly<{
      readonly takesValue: true;
      readonly apply: (options: MutableCliOptions, value: string, name: string) => void;
    }>;

function flag(apply: (options: MutableCliOptions) => void): OptionSpec {
  return { takesValue: false, apply };
}

function valued(
  apply: (options: MutableCliOptions, value: string, name: string) => void,
): OptionSpec {
  return { takesValue: true, apply };
}

const OPTION_SPECS: Readonly<Record<string, OptionSpec>> = {
  "--help": flag((options) => {
    options.help = true;
  }),
  "--json": flag((options) => {
    options.json = true;
  }),
  "--yes": flag((options) => {
    options.yes = true;
  }),
  "--write": flag((options) => {
    options.write = true;
  }),
  "--discard": flag((options) => {
    options.discard = true;
  }),
  "--continue": flag((options) => {
    options.continueSession = true;
  }),
  "--restart": flag((options) => {
    options.restart = true;
  }),
  "--headless": flag((options) => {
    options.headless = true;
  }),
  "--no-attach": flag((options) => {
    options.noAttach = true;
  }),
  "--home": valued((options, value) => {
    options.home = value;
  }),
  "--session": valued((options, value) => {
    options.sessionId = value;
  }),
  "--parent-workspace": valued((options, value) => {
    options.parentWorkspaceId = value;
  }),
  "--parent": valued((options, value) => {
    options.parentWorkspaceId = value;
  }),
  "--pool-root": valued((options, value) => {
    options.poolRoot = value;
  }),
  "--repo": valued((options, value) => {
    options.repo = value;
  }),
  "--model": valued((options, value) => {
    options.model = value;
  }),
  "--thinking": valued((options, value) => {
    options.thinking = parseThinking(value);
  }),
  "--extension": valued((options, value) => {
    options.extensionPath = value;
  }),
  "--config": valued((options, value) => {
    options.configPath = value;
  }),
  "--interval-ms": valued((options, value, name) => {
    options.intervalMs = positiveInteger(value, name);
  }),
  "--iterations": valued((options, value, name) => {
    options.iterations = positiveInteger(value, name);
  }),
  "--kind": valued((options, value) => {
    options.kind = parseTaskKind(value);
  }),
  "--objective": valued((options, value) => {
    options.objective = value;
  }),
  "--task": valued((options, value) => {
    options.taskId = value;
  }),
  "--task-id": valued((options, value) => {
    options.taskId = value;
  }),
  "--pane": valued((options, value) => {
    options.viewPaneId = value;
  }),
  "--window": valued((options, value) => {
    options.viewWindowId = value;
  }),
  "--cwd": valued((options, value) => {
    options.viewCwd = value;
  }),
  "--text": valued((options, value) => {
    options.text = value;
  }),
  "--question": valued((options, value) => {
    options.questionId = value;
  }),
  "--supersedes": valued((options, value) => {
    options.supersedes.push(value);
  }),
  "--presentation": valued((options, value) => {
    options.presentationId = value;
  }),
  "--presentation-id": valued((options, value) => {
    options.presentationId = value;
  }),
  "--reason": valued((options, value) => {
    options.reason = value;
  }),
  "--title": valued((options, value) => {
    options.title = value;
  }),
  "--base": valued((options, value) => {
    options.base = value;
  }),
  "--summary": valued((options, value) => {
    options.summary = value;
  }),
  "--method": valued((options, value) => {
    options.method = parseMergeMethod(value);
  }),
  "--input": valued((options, value) => {
    options.input = value;
  }),
  "--acceptance": valued((options, value) => {
    options.acceptanceCriteria.push(value);
  }),
  "--surface": valued((options, value) => {
    options.surfaces.push(value);
  }),
  "--artifact": valued((options, value) => {
    options.artifacts.push(value);
  }),
};

/** Apply the option at `index` and return the index of the last token it consumed. */
function parseOption(options: MutableCliOptions, argv: readonly string[], index: number): number {
  const token = argv[index];
  if (token === undefined) throw new CliUsageError("missing CLI argument");
  const equalsIndex = token.indexOf("=");
  const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
  const spec = Object.hasOwn(OPTION_SPECS, name) ? OPTION_SPECS[name] : undefined;
  if (spec === undefined) throw new CliUsageError(`unknown option ${JSON.stringify(token)}`);
  if (!spec.takesValue) {
    spec.apply(options);
    return index;
  }
  const parsed = optionValue(argv, index, name);
  spec.apply(options, parsed.value, name);
  return parsed.nextIndex;
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
