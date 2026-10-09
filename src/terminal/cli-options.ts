import type { CliOptions } from "./cli-arguments.ts";
import {
  CliUsageError,
  parseMergeMethod,
  parseTaskKind,
  parseThinking,
  pathText,
  positiveInteger,
  text,
} from "./cli-values.ts";

/** Paths preserve their literal argv spelling. */
const LITERAL_OPTIONS: Readonly<Record<string, true>> = {
  "--home": true,
  "--pool-root": true,
  "--repo": true,
  "--extension": true,
  "--input": true,
  "--config": true,
  "--artifact": true,
};
type MutableCliOptions = {
  -readonly [Key in keyof CliOptions]: CliOptions[Key] extends readonly string[]
    ? string[]
    : CliOptions[Key];
};

type FlagField =
  | "help"
  | "json"
  | "yes"
  | "write"
  | "discard"
  | "continueSession"
  | "restart"
  | "headless"
  | "noAttach";
type TextField =
  | "home"
  | "sessionId"
  | "parentWorkspaceId"
  | "poolRoot"
  | "repo"
  | "model"
  | "extensionPath"
  | "configPath"
  | "objective"
  | "taskId"
  | "text"
  | "questionId"
  | "presentationId"
  | "reason"
  | "title"
  | "base"
  | "summary"
  | "input";
type RepeatedField = "supersedes" | "acceptanceCriteria" | "surfaces" | "artifacts";

export function initialOptions(): MutableCliOptions {
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

type OptionSpec =
  | Readonly<{ readonly takesValue: false; readonly apply: (options: MutableCliOptions) => void }>
  | Readonly<{
      readonly takesValue: true;
      readonly apply: (options: MutableCliOptions, value: string, name: string) => void;
    }>;

function flag(field: FlagField): OptionSpec {
  return {
    takesValue: false,
    apply: (options) => {
      options[field] = true;
    },
  };
}

function valued(field: TextField): OptionSpec {
  return {
    takesValue: true,
    apply: (options, value) => {
      options[field] = value;
    },
  };
}

function parsed<Key extends keyof MutableCliOptions>(
  field: Key,
  read: (value: string, name: string) => MutableCliOptions[Key],
): OptionSpec {
  return {
    takesValue: true,
    apply: (options, value, name) => {
      options[field] = read(value, name);
    },
  };
}

function repeated(field: RepeatedField): OptionSpec {
  return {
    takesValue: true,
    apply: (options, value) => {
      options[field].push(value);
    },
  };
}

const OPTION_SPECS: Readonly<Record<string, OptionSpec>> = {
  "--help": flag("help"),
  "--json": flag("json"),
  "--yes": flag("yes"),
  "--write": flag("write"),
  "--discard": flag("discard"),
  "--continue": flag("continueSession"),
  "--restart": flag("restart"),
  "--headless": flag("headless"),
  "--no-attach": flag("noAttach"),
  "--home": valued("home"),
  "--session": valued("sessionId"),
  "--parent-workspace": valued("parentWorkspaceId"),
  "--parent": valued("parentWorkspaceId"),
  "--pool-root": valued("poolRoot"),
  "--repo": valued("repo"),
  "--model": valued("model"),
  "--thinking": parsed("thinking", parseThinking),
  "--extension": valued("extensionPath"),
  "--config": valued("configPath"),
  "--interval-ms": parsed("intervalMs", positiveInteger),
  "--iterations": parsed("iterations", positiveInteger),
  "--kind": parsed("kind", parseTaskKind),
  "--objective": valued("objective"),
  "--task": valued("taskId"),
  "--task-id": valued("taskId"),
  "--text": valued("text"),
  "--question": valued("questionId"),
  "--supersedes": repeated("supersedes"),
  "--presentation": valued("presentationId"),
  "--presentation-id": valued("presentationId"),
  "--reason": valued("reason"),
  "--title": valued("title"),
  "--base": valued("base"),
  "--summary": valued("summary"),
  "--method": parsed("method", parseMergeMethod),
  "--input": valued("input"),
  "--acceptance": repeated("acceptanceCriteria"),
  "--surface": repeated("surfaces"),
  "--artifact": repeated("artifacts"),
};

function optionValue(
  argv: readonly string[],
  index: number,
  name: string,
): Readonly<{ value: string; nextIndex: number }> {
  const token = argv[index];
  if (token === undefined) throw new CliUsageError(`${name} requires a value`);
  const readValue = LITERAL_OPTIONS[name] === true ? pathText : text;
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

/** Apply the option at `index` and return the index of the last token it consumed. */
export function parseOption(
  options: MutableCliOptions,
  argv: readonly string[],
  index: number,
): number {
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
