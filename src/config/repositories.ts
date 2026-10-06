import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  InstructionChannel,
  RepoPolicy,
  ResolvedGuidance,
  ResolvedPolicy,
  SetupCommand,
  ValidationCommand,
} from "../contracts.ts";
import { writeTextAtomically } from "../runtime/persistence.ts";
import { type ModelSettings, readModelSettingsAt } from "./models.ts";
import { copyPolicy, defaultPolicy, parsePolicy, parsePolicyOverride } from "./policy.ts";
import {
  assertContainedReference,
  assertPhysicalRepositoryReference,
  configuredHome,
  ensureCentralDirectory,
  ensurePrivateDirectoryTree,
  inspectPolicyPath,
  isAlreadyExistsError,
  isContainedPath,
  isNotFoundError,
  type ResolvedHome,
  repositoryRoot,
} from "./storage.ts";
import {
  assertKnownKeys,
  deduplicateStrings,
  hasKey,
  INSTRUCTION_CHANNELS,
  isRecord,
  parseJson,
  readNonEmptyString,
  readPositiveInteger,
} from "./values.ts";

const ROOT_GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const CENTRAL_REPOSITORY_DIRECTORY = "repositories";
const CENTRAL_CONFIG_FILE = "settings.toml";
/** The JSON envelope projects were saved in before settings.toml; still read, never written. */
const LEGACY_CONFIG_FILE = "config.json";
const CENTRAL_SCHEMA_VERSION = 1;

/** Reads an absolute Tandem or target-repository file; return undefined only when the optional file is absent. */
export type PolicyTextReader = (
  absolutePath: string,
) => Promise<string | undefined> | string | undefined;

/** Writes a new Tandem-owned policy file at an absolute path. */
export type PolicyTextWriter = (absolutePath: string, text: string) => Promise<void> | void;

export type PolicyResolutionOptions = Readonly<{
  repoPath: string;
  checkoutPath?: string;
  home: string;
  globalPolicy?: unknown;
  readText?: PolicyTextReader;
}>;

/** Inputs for discovery; write=true is the explicit setup approval that creates a missing central policy. */
export type OnboardRepoOptions = Readonly<{
  repoPath: string;
  checkoutPath?: string;
  home: string;
  globalPolicy?: unknown;
  readText?: PolicyTextReader;
  writeText?: PolicyTextWriter;
  write?: boolean;
  /** The user's own check commands, replacing the discovered ones in the proposal and the write. */
  validationCommands?: readonly string[];
  /** The user's own install commands, replacing the discovered one likewise. */
  setupCommands?: readonly string[];
}>;

/** Onboarding proposal and durable-write outcome; unresolved is never represented as a passing check. */
export type OnboardRepoResult = Readonly<{
  repoPath: string;
  configPath: string;
  existingConfig: boolean;
  written: boolean;
  approvalRequired: boolean;
  modelSettings: ModelSettings;
  policy: RepoPolicy;
  proposedPolicy: RepoPolicy;
  validationCommands: readonly ValidationCommand[];
  setupCommands: readonly SetupCommand[];
  unresolved: readonly string[];
  /** Where the discovered commands came from, whether or not the user replaced them. */
  discovery: OnboardingDiscovery;
}>;

/** Every package.json script as the command that runs it, and the lockfile behind the install. */
export type OnboardingDiscovery = Readonly<{
  commands: readonly string[];
  lockfile?: string;
}>;

type CentralPaths = Readonly<{
  home: string;
  config: string;
  legacy: string;
}>;

function applySavedModelSettings(base: RepoPolicy, settings: ModelSettings): RepoPolicy {
  if (!settings.configured) return copyPolicy(base);
  if (settings.models === undefined) {
    throw new TypeError("configured model settings must contain models");
  }
  return parsePolicyOverride({ models: settings.models }, base);
}

/** Stable key used by saved project settings and derived project files. Input is the canonical root. */
export function repositoryKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

function centralPaths(root: string, home: ResolvedHome): CentralPaths {
  const key = repositoryKey(root);
  const central = path.join(home.canonical, CENTRAL_REPOSITORY_DIRECTORY, key, CENTRAL_CONFIG_FILE);
  const configuredCentral = path.join(
    home.requested,
    CENTRAL_REPOSITORY_DIRECTORY,
    key,
    CENTRAL_CONFIG_FILE,
  );
  if (isContainedPath(root, central) || isContainedPath(root, configuredCentral)) {
    throw new Error("Tandem home would place central policy inside the target repository");
  }
  return {
    home: home.canonical,
    config: central,
    legacy: path.join(path.dirname(central), LEGACY_CONFIG_FILE),
  };
}

/** The settings file this repository actually has, if any; both formats at once is refused. */
async function existingCentralFile(paths: CentralPaths): Promise<string | undefined> {
  const toml = await inspectPolicyPath(paths);
  const legacy = await inspectPolicyPath({ home: paths.home, config: paths.legacy });
  if (toml.exists && legacy.exists) {
    throw new Error(
      `${path.dirname(paths.config)} has both ${CENTRAL_CONFIG_FILE} and ${LEGACY_CONFIG_FILE}; keep one`,
    );
  }
  if (toml.exists) return paths.config;
  return legacy.exists ? paths.legacy : undefined;
}

async function readDefaultRepositoryFile(
  root: string,
  reference: string,
): Promise<string | undefined> {
  const candidate = assertContainedReference(root, reference);
  await assertPhysicalRepositoryReference(root, candidate, reference);
  try {
    return await readFile(candidate, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

async function readRepositoryFile(
  root: string,
  reference: string,
  readText: PolicyTextReader | undefined,
  required: boolean,
): Promise<string | undefined> {
  const candidate = assertContainedReference(root, reference);
  let text: string | undefined;
  if (readText === undefined) {
    text = await readDefaultRepositoryFile(root, reference);
  } else {
    await assertPhysicalRepositoryReference(root, candidate, reference);
    text = await readText(candidate);
  }

  if (text === undefined && required) {
    throw new Error(`configured instruction file is missing: ${reference}`);
  }
  return text;
}

const CENTRAL_ENVELOPE_KEYS: Readonly<Record<string, true>> = {
  schemaVersion: true,
  repoPath: true,
  policy: true,
};

/** Shell commands that stop what agents started in a worktree, such as a Docker stack. */
function readCleanupCommandList(value: unknown, source: string): readonly string[] {
  if (value === undefined) return [];
  const field = `${source} cleanupCommands`;
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of commands`);
  return value.map((entry: unknown, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(`${field}[${index}] must be a non-empty command`);
    }
    return entry.trim();
  });
}

export type MergeWith = "auto-merge" | "queue-label" | "off";

/** The user's answer to "how does this repository merge?", as saved into `[merging]`. */
export type MergingChoice =
  | Readonly<{ readonly mergeWith: "auto-merge" | "off" }>
  | Readonly<{
      readonly mergeWith: "queue-label";
      readonly queueLabel: string;
      readonly blockedLabel?: string;
    }>;

/**
 * How PR watch merges this repository's pull requests, as written in `[merging]`; each key left
 * out falls back to PR watch's default, and no `mergeWith` means merging is not set up.
 */
export type MergingSettingsFile = Readonly<{
  /** "off" is the user's "Not now": PR watch still retries CI but never arms merging. */
  readonly mergeWith?: MergeWith;
  readonly queueLabel?: string;
  readonly blockedLabel?: string;
  readonly maxCiRetries?: number;
  readonly stuckAfterMinutes?: number;
}>;

const MERGING_KEYS: Readonly<Record<string, true>> = {
  mergeWith: true,
  queueLabel: true,
  blockedLabel: true,
  maxCiRetries: true,
  stuckAfterMinutes: true,
};

function readMergingTable(value: unknown, source: string): MergingSettingsFile | undefined {
  if (value === undefined) return undefined;
  const field = `${source} merging`;
  if (!isRecord(value)) throw new TypeError(`${field} must be a table`);
  assertKnownKeys(value, MERGING_KEYS, field);
  const { mergeWith, queueLabel, blockedLabel, maxCiRetries, stuckAfterMinutes } = value;
  if (
    mergeWith !== undefined &&
    mergeWith !== "auto-merge" &&
    mergeWith !== "queue-label" &&
    mergeWith !== "off"
  ) {
    throw new TypeError(`${field}.mergeWith must be "auto-merge", "queue-label", or "off"`);
  }
  if (
    maxCiRetries !== undefined &&
    (!Number.isSafeInteger(maxCiRetries) || Number(maxCiRetries) < 0)
  ) {
    throw new TypeError(`${field}.maxCiRetries must be a whole number of retries`);
  }
  return {
    ...(mergeWith === undefined ? {} : { mergeWith }),
    ...(queueLabel === undefined
      ? {}
      : { queueLabel: readNonEmptyString(queueLabel, `${field}.queueLabel`) }),
    ...(blockedLabel === undefined
      ? {}
      : { blockedLabel: readNonEmptyString(blockedLabel, `${field}.blockedLabel`) }),
    ...(maxCiRetries === undefined ? {} : { maxCiRetries: Number(maxCiRetries) }),
    ...(stuckAfterMinutes === undefined
      ? {}
      : {
          stuckAfterMinutes: readPositiveInteger(stuckAfterMinutes, `${field}.stuckAfterMinutes`),
        }),
  };
}

/**
 * settings.toml is the policy itself plus the `repoPath` it belongs to, cleanup commands, and
 * `[merging]`. Those are machine settings read live, not task policy, so they stay out of the policy.
 */
function readSettingsToml(text: string, source: string, root: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new TypeError(
      `${source} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new TypeError(`${source} must be a TOML table`);
  if (parsed.repoPath !== root) {
    throw new TypeError(`${source} repoPath must be ${JSON.stringify(root)}`);
  }
  readCleanupCommandList(parsed.cleanupCommands, source);
  readMergingTable(parsed.merging, source);
  return parsed;
}

function parseSettingsToml(text: string, source: string, root: string): unknown {
  const {
    repoPath: _repoPath,
    coordinatorMcpServers: _legacyCoordinatorMcpServers,
    cleanupCommands: _cleanup,
    merging: _merging,
    ...policy
  } = readSettingsToml(text, source, root);
  return policy;
}

function parseCentralPolicy(text: string, source: string, root: string): unknown {
  if (source.endsWith(".toml")) return parseSettingsToml(text, source, root);
  const envelope = parseJson(text, source);
  if (!isRecord(envelope)) {
    throw new TypeError(`${source} must be an object`);
  }
  assertKnownKeys(envelope, CENTRAL_ENVELOPE_KEYS, source);
  if (
    !hasKey(envelope, "schemaVersion") ||
    !hasKey(envelope, "repoPath") ||
    !hasKey(envelope, "policy")
  ) {
    throw new TypeError(`${source} must contain schemaVersion, repoPath, and policy`);
  }
  if (envelope.schemaVersion !== CENTRAL_SCHEMA_VERSION) {
    throw new TypeError(`${source}.schemaVersion must be ${CENTRAL_SCHEMA_VERSION}`);
  }
  if (typeof envelope.repoPath !== "string" || envelope.repoPath !== root) {
    throw new TypeError(`${source}.repoPath must match the canonical repository root`);
  }
  return envelope.policy;
}

async function readCentralPolicy(
  paths: CentralPaths,
  root: string,
  readText: PolicyTextReader | undefined,
): Promise<unknown | undefined> {
  const file = await existingCentralFile(paths);
  if (file === undefined) return undefined;
  const text = (await readText?.(file)) ?? (await readFile(file, "utf8"));
  return parseCentralPolicy(text, file, root);
}

async function writeCentralConfig(
  paths: CentralPaths,
  text: string,
  writeText: PolicyTextWriter | undefined,
): Promise<void> {
  const before = await existingCentralFile(paths);
  if (before !== undefined) throw centralOverwriteError(before);
  if (writeText !== undefined) {
    await writeText(paths.config, text);
    return;
  }

  await ensurePrivateDirectoryTree(paths.home, "Tandem home");
  await ensureCentralDirectory(
    path.join(paths.home, CENTRAL_REPOSITORY_DIRECTORY),
    "central policy repositories",
  );
  const keyDirectory = path.dirname(paths.config);
  await ensureCentralDirectory(keyDirectory, "central policy repository");
  const after = await existingCentralFile(paths);
  if (after !== undefined) throw centralOverwriteError(after);
  try {
    await writeFile(paths.config, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isAlreadyExistsError(error)) throw centralOverwriteError(paths.config);
    throw error;
  }
}

function centralOverwriteError(configPath: string): Error {
  return new Error(`${configPath} already exists; onboarding refuses to overwrite it`);
}

function addGuidance(
  entries: ResolvedGuidance[],
  seenText: Set<string>,
  text: string,
  channel: InstructionChannel,
  source: string,
): void {
  if (seenText.has(text)) {
    return;
  }
  seenText.add(text);
  entries.push({ text, provenance: { channel, source } });
}

async function readGuidanceFile(
  root: string,
  reference: string,
  readText: PolicyTextReader | undefined,
  cache: Map<string, Promise<string | undefined>>,
  required: boolean,
): Promise<string | undefined> {
  let snapshot = cache.get(reference);
  if (snapshot === undefined) {
    snapshot = readRepositoryFile(root, reference, readText, false);
    cache.set(reference, snapshot);
  }
  const text = await snapshot;
  if (text === undefined && required) {
    throw new Error(`configured instruction file is missing: ${reference}`);
  }
  return text;
}

async function resolveGuidance(
  root: string,
  config: RepoPolicy,
  readText: PolicyTextReader | undefined,
): Promise<Readonly<Record<InstructionChannel, readonly ResolvedGuidance[]>>> {
  const guidance: Record<InstructionChannel, readonly ResolvedGuidance[]> = {
    implementation: [],
    validation: [],
    review: [],
  };
  const fileSnapshots = new Map<string, Promise<string | undefined>>();

  for (const channel of INSTRUCTION_CHANNELS) {
    const entries: ResolvedGuidance[] = [];
    const seenText = new Set<string>();
    for (const [index, text] of config.instructions[channel].entries()) {
      addGuidance(entries, seenText, text, channel, `policy.instructions.${channel}[${index}]`);
    }

    for (const reference of ROOT_GUIDANCE_FILES) {
      const text = await readGuidanceFile(root, reference, readText, fileSnapshots, false);
      if (text !== undefined) {
        addGuidance(entries, seenText, text, channel, reference);
      }
    }

    for (const reference of config.instructionFiles[channel]) {
      const text = await readGuidanceFile(root, reference, readText, fileSnapshots, true);
      if (text !== undefined) {
        addGuidance(entries, seenText, text, channel, reference);
      }
    }
    guidance[channel] = entries;
  }

  return guidance;
}

/** The commands that clean up a finished task's worktree; none when unset or not yet onboarded. */
export async function readCleanupCommands(
  options: Readonly<{ repoPath: string; home: string; readText?: PolicyTextReader }>,
): Promise<readonly string[]> {
  const root = await repositoryRoot(options.repoPath);
  const file = await existingCentralFile(centralPaths(root, await configuredHome(options.home)));
  if (file === undefined || !file.endsWith(".toml")) return [];
  const text = (await options.readText?.(file)) ?? (await readFile(file, "utf8"));
  const settings = readSettingsToml(text, file, root);
  return readCleanupCommandList(settings.cleanupCommands, file);
}

/** How PR watch merges this repository's pull requests; undefined when unset or not onboarded. */
export async function readMergingSettings(
  options: Readonly<{ repoPath: string; home: string; readText?: PolicyTextReader }>,
): Promise<MergingSettingsFile | undefined> {
  const root = await repositoryRoot(options.repoPath);
  const file = await existingCentralFile(centralPaths(root, await configuredHome(options.home)));
  if (file === undefined || !file.endsWith(".toml")) return undefined;
  const text = (await options.readText?.(file)) ?? (await readFile(file, "utf8"));
  return readMergingTable(readSettingsToml(text, file, root).merging, file);
}

/**
 * Saves how PR watch merges this repository's pull requests into its existing settings.toml: the
 * one field Tandem ever writes into a saved project's settings, and only after the user answered.
 * It adds `mergeWith` (and the queue labels) to `[merging]`, never replacing a value already
 * there, and writes nothing if the file changed since it was read. The file stays where it is;
 * a symlink in the settings path is refused like any other policy read.
 */
export async function saveMergingChoice(
  options: Readonly<{ repoPath: string; home: string; choice: MergingChoice }>,
): Promise<MergingSettingsFile> {
  const root = await repositoryRoot(options.repoPath);
  const file = await existingCentralFile(centralPaths(root, await configuredHome(options.home)));
  if (file === undefined) {
    throw new Error("This project has no Tandem settings yet; save its settings first.");
  }
  if (!file.endsWith(".toml")) {
    throw new Error(`${file} is from before settings.toml; merging can't be saved into it.`);
  }
  const before = await readFile(file, "utf8");
  const current = readMergingTable(readSettingsToml(before, file, root).merging, file);
  if (current?.mergeWith !== undefined) {
    throw new Error(`${file} already says how this project merges; change it with tandem config.`);
  }
  const lines = mergingLines(options.choice);
  const after =
    current === undefined
      ? `${before.replace(/\n*$/u, "\n")}\n[merging]\n${lines}`
      : before.replace(/^\[merging\][ \t]*$/mu, `[merging]\n${lines.trimEnd()}`);
  const saved = readMergingTable(readSettingsToml(after, file, root).merging, file);
  if ((await readFile(file, "utf8")) !== before) {
    throw new Error(`${file} changed while saving; nothing was written. Try again.`);
  }
  await writeTextAtomically(file, after);
  return saved ?? {};
}

function mergingLines(choice: MergingChoice): string {
  const lines = [`mergeWith = ${JSON.stringify(choice.mergeWith)}`];
  if (choice.mergeWith === "queue-label") {
    lines.push(`queueLabel = ${JSON.stringify(choice.queueLabel)}`);
    if (choice.blockedLabel !== undefined) {
      lines.push(`blockedLabel = ${JSON.stringify(choice.blockedLabel)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Resolves central policy by canonical repository identity and pins guidance from the requested checkout. */
export async function resolveRepoPolicy(options: PolicyResolutionOptions): Promise<ResolvedPolicy> {
  const root = await repositoryRoot(options.repoPath);
  const guidanceRoot =
    options.checkoutPath === undefined ? root : await repositoryRoot(options.checkoutPath);
  const home = await configuredHome(options.home);
  const paths = centralPaths(root, home);
  const readText = options.readText;
  const modelSettings = await readModelSettingsAt(root, home, readText);
  const savedBase = applySavedModelSettings(parsePolicy({}), modelSettings);
  const globalInput = options.globalPolicy === undefined ? {} : options.globalPolicy;
  const global = parsePolicyOverride(globalInput, savedBase);
  const localInput = await readCentralPolicy(paths, root, readText);
  const config =
    localInput === undefined ? copyPolicy(global) : parsePolicyOverride(localInput, global);
  const guidance = await resolveGuidance(guidanceRoot, config, readText);
  return { config: copyPolicy(config), guidance };
}

type ValidationProposal = Readonly<{
  commands: readonly string[];
  /** The scripts the commands run, in order; empty when none were proposed. */
  scripts: readonly string[];
  unresolved: readonly string[];
  approvalRequired: boolean;
}>;

function proposeValidationCommands(
  packageText: string | undefined,
  runner: string,
): ValidationProposal {
  if (packageText === undefined) {
    return {
      commands: [],
      scripts: [],
      unresolved: ["package.json is missing; no validation commands were proposed"],
      approvalRequired: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseJson(packageText, "package.json");
  } catch {
    return {
      commands: [],
      scripts: [],
      unresolved: ["package.json is invalid JSON; no validation commands were proposed"],
      approvalRequired: false,
    };
  }
  if (!isRecord(parsed)) {
    return {
      commands: [],
      scripts: [],
      unresolved: ["package.json must be an object; no validation commands were proposed"],
      approvalRequired: false,
    };
  }
  const scripts = parsed.scripts;
  if (scripts === undefined) {
    return {
      commands: [],
      scripts: [],
      unresolved: ["package.json has no scripts; no validation commands were proposed"],
      approvalRequired: false,
    };
  }
  if (!isRecord(scripts)) {
    return {
      commands: [],
      scripts: [],
      unresolved: ["package.json.scripts must be an object; no validation commands were proposed"],
      approvalRequired: false,
    };
  }

  const hasCiLocal =
    typeof scripts["ci:local"] === "string" && scripts["ci:local"].trim().length > 0;
  const scriptNames = hasCiLocal
    ? (["ci:local"] as const)
    : (["check", "typecheck", "lint", "test"] as const);
  const commands: string[] = [];
  const found: string[] = [];
  for (const scriptName of scriptNames) {
    if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim().length > 0) {
      commands.push(`${runner} run ${scriptName}`);
      found.push(scriptName);
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
    scripts: found,
    unresolved,
    approvalRequired: commands.length > 0,
  };
}

function packageScriptCommands(packageText: string | undefined, runner: string): readonly string[] {
  if (packageText === undefined) return [];
  let parsed: unknown;
  try {
    parsed = parseJson(packageText, "package.json");
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return [];
  return Object.entries(parsed.scripts)
    .filter(([, body]) => typeof body === "string" && body.trim().length > 0)
    .map(([name]) => `${runner} run ${name}`);
}

type PackageManager = Readonly<{ install: string; runner: string; lockfile: string }>;

/** Lockfile → the install that reproduces it exactly and the tool that runs package scripts. */
const LOCKFILE_PACKAGE_MANAGERS: readonly (readonly [string, Omit<PackageManager, "lockfile">])[] =
  [
    ["bun.lock", { install: "bun install --frozen-lockfile", runner: "bun" }],
    ["bun.lockb", { install: "bun install --frozen-lockfile", runner: "bun" }],
    ["pnpm-lock.yaml", { install: "pnpm install --frozen-lockfile", runner: "pnpm" }],
    ["yarn.lock", { install: "yarn install --immutable", runner: "yarn" }],
    ["package-lock.json", { install: "npm ci", runner: "npm" }],
    ["uv.lock", { install: "uv sync --frozen", runner: "bun" }],
  ];

/** The first lockfile found decides the package manager; none means no install and bun scripts. */
async function detectPackageManager(
  root: string,
  readText: PolicyTextReader | undefined,
): Promise<PackageManager | undefined> {
  for (const [lockfile, manager] of LOCKFILE_PACKAGE_MANAGERS) {
    if ((await readRepositoryFile(root, lockfile, readText, false)) !== undefined) {
      return { ...manager, lockfile };
    }
  }
  return undefined;
}

function onboardingUnresolved(
  proposal: Readonly<{ unresolved: readonly string[] }>,
  policy: RepoPolicy,
): readonly string[] {
  const unresolved = [...proposal.unresolved];
  if (policy.validationCommands.length === 0) {
    unresolved.push("no validation commands are configured; validation remains unresolved");
  }
  return deduplicateStrings(unresolved);
}

function tomlList(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

/**
 * Writes settings.toml with the proposed commands filled in and every other setting present but
 * commented out, each with what it does and an example, so the file documents itself.
 */
function serializeCentralConfig(
  root: string,
  validationCommands: readonly string[],
  setupCommands: readonly string[],
): string {
  const defaults = defaultPolicy();
  const setting = (values: readonly string[], key: string, example: string): string =>
    values.length > 0 ? `${key} = ${tomlList(values)}` : `# ${key} = ${example}`;
  return `# Tandem settings for this project. Edit with \`tandem config\`.
# Uncomment a line (remove the leading "#") to turn a setting on.
# Changes apply to tasks started afterwards; running tasks keep the settings they began with.

# The repository these settings belong to. Don't change this.
repoPath = ${JSON.stringify(root)}

# Commands that prepare a fresh working copy before a coding agent starts, like installing
# dependencies. They run every time an agent starts, so they should be safe to repeat.
${setting(setupCommands, "setupCommands", '["npm ci", "npx prisma generate"]')}

# Checks every change must pass before Tandem accepts it. Each one runs in the project folder.
${setting(validationCommands, "validationCommands", '["npm run lint", "npm test"]')}

# Commands that stop what agents started in a working copy, like a Docker or database stack.
# They run in the task's working copy once the task is finished and its agents are closed.
# cleanupCommands = ["docker compose down"]

# How many times reviewers may send a change back for fixes before Tandem asks you.
# maxFixRounds = ${defaults.maxFixRounds}

# Tandem gives coding agents and reviewers its own code standards and principles. Set "none" to
# leave them out and let this repository's AGENTS.md, CLAUDE.md, and instructions govern.
# standards = "tandem"

# Extra instructions for agents at each stage. Keep this section below the settings above.
# [instructions]
# implementation = ["Keep changes small and match the surrounding code."]
# validation = []
# review = ["Flag any change to the public API."]

# Files in this repository whose contents are given to agents as instructions, by stage.
# [instructionFiles]
# implementation = ["docs/CONTRIBUTING.md"]
# validation = []
# review = []

# How PR watch merges published pull requests and how patient it is with CI. mergeWith is
# "auto-merge" (GitHub's own), "queue-label" (add queueLabel; blockedLabel is the label the queue
# adds when it kicks a pull request out), or "off". Until mergeWith is set, PR watch retries CI
# but never merges; Tandem offers to set it up the first time it watches one of your pull
# requests here.
# [merging]
# mergeWith = "queue-label"
# queueLabel = "mergequeue"
# blockedLabel = "blocked"
# maxCiRetries = 1
# stuckAfterMinutes = 60

# Use a different model for one role in this project only. Roles: coordinator, scout,
# implementer, reviewer, presentation. Other roles keep your saved choices.
# [models.implementer]
# model = "provider/model"
# thinking = "high"
`;
}

/** The absolute path of a repository's central settings file, whether or not it exists yet. */
export async function centralConfigPath(repoPath: string, home: string): Promise<string> {
  const paths = centralPaths(await repositoryRoot(repoPath), await configuredHome(home));
  return (await existingCentralFile(paths)) ?? paths.config;
}

/** Discovers package scripts from the requested checkout without executing them; write=true creates only a missing central policy. */
export async function onboardRepo(options: OnboardRepoOptions): Promise<OnboardRepoResult> {
  const root = await repositoryRoot(options.repoPath);
  const checkoutRoot =
    options.checkoutPath === undefined ? root : await repositoryRoot(options.checkoutPath);
  const home = await configuredHome(options.home);
  const paths = centralPaths(root, home);
  const modelSettings = await readModelSettingsAt(root, home, options.readText);
  const policyText = await readCentralPolicy(paths, root, options.readText);
  const existingConfig = policyText !== undefined;

  const savedBase = applySavedModelSettings(parsePolicy({}), modelSettings);
  const globalInput = options.globalPolicy === undefined ? {} : options.globalPolicy;
  const global = parsePolicyOverride(globalInput, savedBase);
  const currentPolicy =
    policyText === undefined ? copyPolicy(global) : parsePolicyOverride(policyText, global);
  const configPath = (await existingCentralFile(paths)) ?? paths.config;
  if (existingConfig && options.write === true) {
    throw centralOverwriteError(configPath);
  }

  const packageText = await readRepositoryFile(
    checkoutRoot,
    "package.json",
    options.readText,
    false,
  );
  const manager = await detectPackageManager(checkoutRoot, options.readText);
  const runner = manager?.runner ?? "bun";
  const discovered = proposeValidationCommands(packageText, runner);
  // Commands the user chose are theirs to vouch for, so they leave nothing unresolved.
  const proposal: ValidationProposal =
    options.validationCommands === undefined
      ? discovered
      : {
          commands: options.validationCommands,
          scripts: [],
          unresolved: [],
          approvalRequired: true,
        };
  const setupCommands = options.setupCommands ?? (manager === undefined ? [] : [manager.install]);
  const proposedPolicy = existingConfig
    ? copyPolicy(currentPolicy)
    : parsePolicyOverride({ setupCommands, validationCommands: proposal.commands }, global);
  const unresolved = onboardingUnresolved(proposal, proposedPolicy);

  let written = false;
  if (options.write === true) {
    await writeCentralConfig(
      paths,
      serializeCentralConfig(root, proposal.commands, setupCommands),
      options.writeText,
    );
    written = true;
  }

  return {
    repoPath: root,
    configPath,
    existingConfig,
    written,
    approvalRequired: !written && (proposal.approvalRequired || setupCommands.length > 0),
    modelSettings,
    policy: existingConfig ? currentPolicy : proposedPolicy,
    proposedPolicy,
    validationCommands: proposedPolicy.validationCommands,
    setupCommands: proposedPolicy.setupCommands,
    unresolved,
    discovery: {
      commands: packageScriptCommands(packageText, runner),
      ...(manager === undefined ? {} : { lockfile: manager.lockfile }),
    },
  };
}
