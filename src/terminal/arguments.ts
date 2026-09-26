export type TerminalCommand =
  | "launch"
  | "status"
  | "trace"
  | "report"
  | "watch"
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
  readonly watch: boolean;
  readonly line: boolean;
  readonly noOpen: boolean;
  /** `tandem report --since`, as an ISO timestamp. */
  readonly since?: string;
}>;

export type TerminalRunResult = Readonly<{
  readonly exitCode: number;
  readonly status:
    | "help"
    | "launched"
    | "configured"
    | "status"
    | "trace"
    | "report"
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
  trace: "trace",
  report: "report",
  watch: "watch",
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
  board: "tandem status --watch",
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
  "--watch": "watch",
  "--line": "line",
  "--no-open": "noOpen",
} as const;
type Flag = (typeof FLAGS)[keyof typeof FLAGS];

/** Which commands accept which flags, and how many positional arguments. */
const ALLOWED: Readonly<
  Record<TerminalCommand, Readonly<{ flags: readonly Flag[]; maxPaths: number }>>
> = {
  launch: { flags: ["fresh", "headless", "noAttach"], maxPaths: Number.POSITIVE_INFINITY },
  status: { flags: ["json", "logs", "watch", "line"], maxPaths: 1 },
  trace: { flags: ["json"], maxPaths: 1 },
  report: { flags: ["json", "noOpen"], maxPaths: 0 },
  watch: { flags: ["json", "stop"], maxPaths: 1 },
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
  let since: string | undefined;
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
    if (name === "--since") {
      const parsed = optionValue(argv, index, name);
      index = parsed.next;
      since = parseReportSince(parsed.value);
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
  if (since !== undefined && resolved !== "report") {
    throw new Error(`${label} does not accept --since`);
  }
  if (flags.has("watch") && (paths.length > 0 || flags.has("json") || flags.has("logs"))) {
    throw new Error(
      "tandem status --watch shows every project; it takes no task, --json, or --logs",
    );
  }
  if (
    flags.has("line") &&
    (paths.length > 0 || flags.has("json") || flags.has("logs") || flags.has("watch"))
  ) {
    throw new Error(
      "tandem status --line is one line across every project; it takes no task, --json, --logs, or --watch",
    );
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
    watch: flags.has("watch"),
    line: flags.has("line"),
    noOpen: flags.has("noOpen"),
    ...(since === undefined ? {} : { since }),
    ...(home === undefined ? {} : { home }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(poolRoot === undefined ? {} : { poolRoot }),
  };
}

/**
 * `--since` takes a calendar day, read as local midnight, or a full ISO timestamp with a time
 * zone; either becomes a UTC ISO timestamp.
 */
export function parseReportSince(value: string): string {
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (day !== null) {
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const local = new Date(year, month - 1, date);
    if (
      local.getFullYear() === year &&
      local.getMonth() === month - 1 &&
      local.getDate() === date
    ) {
      return local.toISOString();
    }
  } else if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)
  ) {
    const parsed = new Date(text);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  throw new Error(
    `--since needs a date like 2030-01-31 or a timestamp like 2030-01-31T09:00:00Z; received ${JSON.stringify(value)}`,
  );
}
