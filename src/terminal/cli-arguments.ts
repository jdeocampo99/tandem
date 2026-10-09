import type { CreatableTaskKind, ThinkingLevel } from "../contracts.ts";
import { CliUsageError } from "./cli-argument-values.ts";
import { initialOptions, parseOption } from "./cli-options.ts";

const CLI_COMMANDS: Readonly<Record<string, CliCommand>> = {
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

function commandFromToken(
  token: string,
  nested: string | undefined,
): Readonly<{ command: CliCommand; consumed: number }> {
  if (token === "pr") {
    if (nested === undefined) throw new CliUsageError("pr requires describe, publish, or merge");
    const command = PR_COMMANDS[nested];
    if (command === undefined)
      throw new CliUsageError(`unknown pr command ${JSON.stringify(nested)}`);
    return { command, consumed: 1 };
  }
  const command = CLI_COMMANDS[token];
  if (command === undefined)
    throw new CliUsageError(`unknown Tandem command ${JSON.stringify(token)}`);
  return { command, consumed: 0 };
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
      const parsed = commandFromToken(token, argv[index + 1]);
      command = parsed.command;
      index += parsed.consumed;
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
