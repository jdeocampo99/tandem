import { deduplicateStrings, isRecord, parseJson } from "./values.ts";

type ValidationProposal = Readonly<{
  commands: readonly string[];
  unresolved: readonly string[];
  approvalRequired: boolean;
}>;

type EcosystemCheck = Readonly<{ command: string; from: string }>;

const ECOSYSTEM_FILES = [
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "uv.lock",
  "Makefile",
  "makefile",
  "justfile",
  "Justfile",
] as const;

type PackageManager = Readonly<{
  install: string;
  /** The tool that runs package.json scripts; absent for a lockfile that is not JavaScript's. */
  runner?: string;
  lockfile: string;
}>;

/** Lockfile → the install that reproduces it exactly and the tool that runs package scripts. */
const LOCKFILE_PACKAGE_MANAGERS: readonly (readonly [string, Omit<PackageManager, "lockfile">])[] =
  [
    ["bun.lock", { install: "bun install --frozen-lockfile", runner: "bun" }],
    ["bun.lockb", { install: "bun install --frozen-lockfile", runner: "bun" }],
    ["pnpm-lock.yaml", { install: "pnpm install --frozen-lockfile", runner: "pnpm" }],
    ["yarn.lock", { install: "yarn install --immutable", runner: "yarn" }],
    ["package-lock.json", { install: "npm ci", runner: "npm" }],
    ["uv.lock", { install: "uv sync --frozen" }],
  ];

/** Read lockfiles in order, stopping at the first present one; ecosystem files are all optional. */
export const DISCOVERY_FILES = {
  lockfiles: LOCKFILE_PACKAGE_MANAGERS.map(([name]) => name),
  ecosystem: ECOSYSTEM_FILES,
};

export function discoverRepositoryCommands(
  files: Readonly<{
    packageText?: string;
    lockfile?: string;
    ecosystemFiles: Readonly<Partial<Record<string, string>>>;
  }>,
): Readonly<{
  proposal: ValidationProposal;
  setupCommands: readonly string[];
  discovery: Readonly<{
    commands: readonly string[];
    sources: readonly string[];
    lockfile?: string;
  }>;
}> {
  const manager = detectPackageManager(files.lockfile);
  const runner = manager === undefined ? "bun" : (manager.runner ?? "npm");
  const scripts = readPackageScripts(files.packageText);
  const proposal =
    typeof scripts === "string"
      ? { commands: [], unresolved: [scripts], approvalRequired: false }
      : proposeValidationCommands(scripts, runner);
  const packageCommands =
    typeof scripts === "string"
      ? []
      : Object.entries(scripts)
          .filter(([, body]) => typeof body === "string" && body.trim().length > 0)
          .map(([name]) => `${runner} run ${name}`);
  const ecosystem = detectEcosystemChecks(files.ecosystemFiles);
  return {
    proposal,
    setupCommands: manager === undefined ? [] : [manager.install],
    discovery: {
      commands: deduplicateStrings([
        ...packageCommands,
        ...ecosystem.map((check) => check.command),
      ]),
      sources: deduplicateStrings([
        ...(packageCommands.length > 0 ? ["package.json scripts"] : []),
        ...ecosystem.map((check) => check.from),
      ]),
      ...(manager === undefined ? {} : { lockfile: manager.lockfile }),
    },
  };
}

function readPackageScripts(packageText: string | undefined): Record<string, unknown> | string {
  if (packageText === undefined)
    return "package.json is missing; no validation commands were proposed";
  let parsed: unknown;
  try {
    parsed = parseJson(packageText, "package.json");
  } catch {
    return "package.json is invalid JSON; no validation commands were proposed";
  }
  if (!isRecord(parsed))
    return "package.json must be an object; no validation commands were proposed";
  if (parsed.scripts === undefined)
    return "package.json has no scripts; no validation commands were proposed";
  if (!isRecord(parsed.scripts))
    return "package.json.scripts must be an object; no validation commands were proposed";
  return parsed.scripts;
}

function proposeValidationCommands(
  scripts: Record<string, unknown>,
  runner: string,
): ValidationProposal {
  const hasCiLocal =
    typeof scripts["ci:local"] === "string" && scripts["ci:local"].trim().length > 0;
  const scriptNames = hasCiLocal
    ? (["ci:local"] as const)
    : (["check", "typecheck", "lint", "test"] as const);
  const commands: string[] = [];
  for (const scriptName of scriptNames) {
    if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim().length > 0) {
      commands.push(`${runner} run ${scriptName}`);
    }
  }

  const unresolved = hasCiLocal
    ? []
    : ["package.json has no ci:local script; review the validation proposal before approval"];
  if (commands.length === 0) {
    unresolved.push("package.json has no discovered validation scripts; no commands were proposed");
  }
  return {
    commands,
    unresolved,
    approvalRequired: commands.length > 0,
  };
}

function detectPackageManager(lockfile: string | undefined): PackageManager | undefined {
  const found = LOCKFILE_PACKAGE_MANAGERS.find(([name]) => name === lockfile);
  return found === undefined ? undefined : { ...found[1], lockfile: found[0] };
}

const RUNNER_TARGETS = ["check", "lint", "test"] as const;

/** Makefile rule names on a line like `test lint: deps`; `:=` and `::=` assignments are not rules. */
function makeTargets(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/^([A-Za-z0-9_.\- ]+?)[ \t]*::?(?!=)/gmu)) {
    for (const name of (match[1] ?? "").split(/\s+/u)) names.add(name);
  }
  return names;
}

/** just recipe names on a line like `test *args:` or `@lint:`; `:=` assignments are not recipes. */
function justRecipes(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/^@?([A-Za-z_][A-Za-z0-9_-]*)[^:=\n]*:(?!=)/gmu)) {
    names.add(match[1] ?? "");
  }
  return names;
}

/**
 * The checks a repository's build files suggest, read as text and never executed: Go, Rust, a uv
 * Python project, and `check`/`lint`/`test` targets of a Makefile or justfile. Pure.
 */
export function detectEcosystemChecks(
  files: Readonly<Partial<Record<string, string>>>,
): readonly EcosystemCheck[] {
  const checks: EcosystemCheck[] = [];
  const add = (from: string, commands: readonly string[]) => {
    for (const command of commands) checks.push({ command, from });
  };
  if (files["go.mod"] !== undefined) add("go.mod", ["go vet ./...", "go test ./..."]);
  if (files["Cargo.toml"] !== undefined) add("Cargo.toml", ["cargo clippy", "cargo test"]);
  if (files["pyproject.toml"] !== undefined && files["uv.lock"] !== undefined) {
    add("pyproject.toml and uv.lock", ["uv run pytest"]);
  }
  for (const name of ["Makefile", "makefile"] as const) {
    const text = files[name];
    if (text === undefined) continue;
    const targets = makeTargets(text);
    add(
      name,
      RUNNER_TARGETS.filter((target) => targets.has(target)).map((target) => `make ${target}`),
    );
    break;
  }
  for (const name of ["justfile", "Justfile"] as const) {
    const text = files[name];
    if (text === undefined) continue;
    const recipes = justRecipes(text);
    add(
      name,
      RUNNER_TARGETS.filter((target) => recipes.has(target)).map((target) => `just ${target}`),
    );
    break;
  }
  return checks;
}
