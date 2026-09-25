export type TerminalCommand =
  | "launch"
  | "status"
  | "watch"
  | "board"
  | "update"
  | "fix"
  | "reset"
  | "config"
  | "configure";

export type TerminalInvocation = Readonly<{
  readonly command: TerminalCommand;
  readonly paths: readonly string[];
  readonly help: boolean;
  readonly home?: string;
  readonly sessionId?: string;
  readonly poolRoot?: string;
  readonly fresh: boolean;
  readonly headless: boolean;
  readonly noAttach: boolean;
  readonly hard: boolean;
  readonly logs: boolean;
  readonly yes: boolean;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly freeSuperseded: boolean;
  readonly stop: boolean;
}>;

export type TerminalRunResult = Readonly<{
  readonly exitCode: number;
  readonly status:
    | "help"
    | "launched"
    | "configured"
    | "status"
    | "watch"
    | "fixed"
    | "reset"
    | "cancelled"
    | "error";
  readonly reconciliation?: unknown;
  readonly projects?: readonly string[];
  readonly sessionId?: string;
  readonly launches?: readonly unknown[];
  readonly error?: Readonly<{ readonly name: string; readonly message: string }>;
}>;

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

const COMMANDS: Readonly<Record<string, TerminalCommand>> = {
  status: "status",
  watch: "watch",
  board: "board",
  update: "update",
  fix: "fix",
  reset: "reset",
  config: "config",
  configure: "configure",
};

/** Old spellings name their replacement instead of being mistaken for a project path. */
const RENAMED: Readonly<Record<string, string>> = {
  restart: "tandem update",
  "--restart": "tandem update",
  "--reset": "tandem reset",
  "--force": "tandem reset",
  "--continue": "tandem (chats now resume by default; --fresh starts new ones)",
  logs: "tandem status --logs",
  "reconcile-resources": "tandem fix",
  inspect: "tandem status TASK_ID",
};

const FLAGS = {
  "-h": "help",
  "--help": "help",
  "--yes": "yes",
  "--json": "json",
  "--verbose": "verbose",
  "--free-superseded": "freeSuperseded",
  "--fresh": "fresh",
  "--hard": "hard",
  "--logs": "logs",
  "--headless": "headless",
  "--no-attach": "noAttach",
  "--stop": "stop",
} as const;
type Flag = (typeof FLAGS)[keyof typeof FLAGS];

/** Which commands accept which flags, and how many positional arguments. */
const ALLOWED: Readonly<
  Record<TerminalCommand, Readonly<{ flags: readonly Flag[]; maxPaths: number }>>
> = {
  launch: { flags: ["fresh", "headless", "noAttach"], maxPaths: Number.POSITIVE_INFINITY },
  status: { flags: ["json", "logs"], maxPaths: 1 },
  watch: { flags: ["json", "stop"], maxPaths: 1 },
  board: { flags: [], maxPaths: 0 },
  update: { flags: ["fresh", "headless", "noAttach"], maxPaths: 0 },
  fix: { flags: ["yes", "json", "verbose", "freeSuperseded"], maxPaths: 0 },
  reset: { flags: ["yes", "hard", "headless", "noAttach"], maxPaths: 0 },
  config: { flags: [], maxPaths: 1 },
  configure: { flags: [], maxPaths: 1 },
};

/** Parses the small user-facing terminal command without executing anything. */
export function parseTerminalArgs(argv: readonly string[]): TerminalInvocation {
  let command: TerminalCommand | undefined;
  let home: string | undefined;
  let sessionId: string | undefined;
  let poolRoot: string | undefined;
  const flags = new Set<Flag>();
  const paths: string[] = [];
  let parseOptions = true;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!parseOptions) {
      paths.push(token);
      continue;
    }
    if (token === "--") {
      parseOptions = false;
      continue;
    }
    const flag = FLAGS[token as keyof typeof FLAGS];
    if (flag !== undefined) {
      flags.add(flag);
      continue;
    }
    const name = token.split("=")[0];
    if (name === "--home" || name === "--session" || name === "--pool-root") {
      const parsed = optionValue(argv, index, name);
      index = parsed.next;
      if (name === "--home") home = parsed.value;
      else if (name === "--session") sessionId = parsed.value;
      else poolRoot = parsed.value;
      continue;
    }
    const renamed =
      (command === undefined && paths.length === 0) || token.startsWith("-")
        ? RENAMED[token]
        : undefined;
    if (renamed !== undefined) throw new Error(`\`tandem ${token}\` is now \`${renamed}\``);
    if (token.startsWith("-")) throw new Error(`unknown option ${token}; run tandem --help`);
    if (command === undefined && paths.length === 0 && COMMANDS[token] !== undefined) {
      command = COMMANDS[token];
      continue;
    }
    paths.push(token);
  }

  const resolved = command ?? "launch";
  const allowed = ALLOWED[resolved];
  const label = resolved === "launch" ? "tandem" : `tandem ${resolved}`;
  for (const flag of flags) {
    if (flag !== "help" && !allowed.flags.includes(flag)) {
      const spelling = Object.entries(FLAGS).find(([, value]) => value === flag)?.[0];
      throw new Error(`${label} does not accept ${spelling}`);
    }
  }
  if (paths.length > allowed.maxPaths) {
    throw new Error(
      allowed.maxPaths === 0
        ? `${label} takes no arguments`
        : `${label} accepts at most ${allowed.maxPaths} argument`,
    );
  }
  return {
    command: resolved,
    paths,
    help: flags.has("help"),
    fresh: flags.has("fresh"),
    headless: flags.has("headless"),
    noAttach: flags.has("noAttach"),
    hard: flags.has("hard"),
    logs: flags.has("logs"),
    yes: flags.has("yes"),
    json: flags.has("json"),
    verbose: flags.has("verbose"),
    freeSuperseded: flags.has("freeSuperseded"),
    stop: flags.has("stop"),
    ...(home === undefined ? {} : { home }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(poolRoot === undefined ? {} : { poolRoot }),
  };
}
