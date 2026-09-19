export type TerminalCommand = "launch" | "configure" | "migrate-state";

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
  readonly restart: boolean;
  readonly force: boolean;
  readonly yes: boolean;
  readonly json: boolean;
}>;
export type TerminalRunResult = Readonly<{
  readonly exitCode: number;
  readonly status: "help" | "launched" | "configured" | "migrated" | "cancelled" | "error";
  readonly migration?: unknown;
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

/** Parses the small user-facing terminal command without executing anything. */
export function parseTerminalArgs(argv: readonly string[]): TerminalInvocation {
  let command: TerminalCommand | undefined;
  let help = false;
  let home: string | undefined;
  let sessionId: string | undefined;
  let poolRoot: string | undefined;
  let continueSession = false;
  let reset = false;
  let restart = false;
  let force = false;
  let headless = false;
  let noAttach = false;
  let yes = false;
  let json = false;
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
    if (parseOptions && token === "--yes") {
      yes = true;
      continue;
    }
    if (parseOptions && token === "--json") {
      json = true;
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
    if (parseOptions && token === "--restart") {
      restart = true;
      continue;
    }
    if (parseOptions && token === "--force") {
      force = true;
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
    if (parseOptions && command === undefined && token === "configure") {
      command = "configure";
      continue;
    }
    if (parseOptions && command === undefined && token === "migrate-state") {
      command = "migrate-state";
      continue;
    }
    if (command === undefined) command = "launch";
    paths.push(token);
  }

  const resolvedCommand = command ?? "launch";
  if (resolvedCommand === "migrate-state" && paths.length > 0) {
    throw new Error("tandem migrate-state does not accept project paths");
  }
  if (resolvedCommand === "configure" && paths.length > 1) {
    throw new Error("tandem configure accepts at most one project path");
  }
  if (force && !reset) {
    throw new Error("tandem --force requires --reset");
  }
  if (reset && restart) {
    throw new Error("tandem --reset and --restart are mutually exclusive");
  }
  if (resolvedCommand === "configure" && (reset || restart)) {
    throw new Error(
      "tandem --reset/--restart are launch-only; they cannot be combined with configure",
    );
  }
  return {
    command: resolvedCommand,
    paths,
    help,
    continueSession,
    headless,
    noAttach,
    reset,
    restart,
    force,
    yes,
    json,
    ...(home === undefined ? {} : { home }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(poolRoot === undefined ? {} : { poolRoot }),
  };
}
