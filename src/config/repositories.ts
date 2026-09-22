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
import { type ModelSettings, readModelSettingsAt } from "./models.ts";
import {
  copyPolicy,
  DEFAULT_COMMAND_TIMEOUT_MS,
  parsePolicy,
  parsePolicyOverride,
} from "./policy.ts";
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
} from "./values.ts";

const ROOT_GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const CENTRAL_REPOSITORY_DIRECTORY = "repositories";
const CENTRAL_CONFIG_FILE = "config.json";
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
}>;

type CentralPaths = Readonly<{
  home: string;
  config: string;
}>;

function applySavedModelSettings(base: RepoPolicy, settings: ModelSettings): RepoPolicy {
  if (!settings.configured) return copyPolicy(base);
  if (settings.models === undefined) {
    throw new TypeError("configured model settings must contain models");
  }
  return parsePolicyOverride({ models: settings.models }, base);
}

function repositoryKey(root: string): string {
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
  return { home: home.canonical, config: central };
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

function parseCentralPolicy(text: string, source: string, root: string): unknown {
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
  const inspection = await inspectPolicyPath(paths);
  let text: string | undefined;
  if (readText === undefined) {
    text = inspection.exists ? await readFile(paths.config, "utf8") : undefined;
  } else {
    text = await readText(paths.config);
    if (text === undefined && inspection.exists) {
      text = await readFile(paths.config, "utf8");
    }
  }
  return text === undefined ? undefined : parseCentralPolicy(text, paths.config, root);
}

async function writeCentralConfig(
  paths: CentralPaths,
  text: string,
  writeText: PolicyTextWriter | undefined,
): Promise<void> {
  const before = await inspectPolicyPath(paths);
  if (before.exists) throw centralOverwriteError(paths.config);
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
  const after = await inspectPolicyPath(paths);
  if (after.exists) throw centralOverwriteError(paths.config);
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

function commandSurfaceForScript(scriptName: string): readonly string[] {
  switch (scriptName) {
    case "check":
    case "typecheck":
      return ["typecheck"];
    case "lint":
      return ["lint"];
    case "test":
      return ["test"];
    default:
      return [];
  }
}

type ValidationProposal = Readonly<{
  commands: readonly ValidationCommand[];
  unresolved: readonly string[];
  approvalRequired: boolean;
}>;

function proposeValidationCommands(packageText: string | undefined): ValidationProposal {
  if (packageText === undefined) {
    return {
      commands: [],
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
      unresolved: ["package.json is invalid JSON; no validation commands were proposed"],
      approvalRequired: false,
    };
  }
  if (!isRecord(parsed)) {
    return {
      commands: [],
      unresolved: ["package.json must be an object; no validation commands were proposed"],
      approvalRequired: false,
    };
  }
  const scripts = parsed.scripts;
  if (scripts === undefined) {
    return {
      commands: [],
      unresolved: ["package.json has no scripts; no validation commands were proposed"],
      approvalRequired: false,
    };
  }
  if (!isRecord(scripts)) {
    return {
      commands: [],
      unresolved: ["package.json.scripts must be an object; no validation commands were proposed"],
      approvalRequired: false,
    };
  }

  const hasCiLocal =
    typeof scripts["ci:local"] === "string" && scripts["ci:local"].trim().length > 0;
  const scriptNames = hasCiLocal
    ? (["ci:local"] as const)
    : (["check", "typecheck", "lint", "test"] as const);
  const commands: ValidationCommand[] = [];
  for (const scriptName of scriptNames) {
    if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim().length > 0) {
      commands.push({
        name: `package:${scriptName}`,
        argv: ["bun", "run", scriptName],
        surfaces: commandSurfaceForScript(scriptName),
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      });
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

/** Lockfile → the install that reproduces it exactly; the first lockfile found wins. */
const LOCKFILE_INSTALLS: readonly (readonly [string, string])[] = [
  ["bun.lock", "bun install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --immutable"],
  ["package-lock.json", "npm ci"],
  ["uv.lock", "uv sync --frozen"],
];

/**
 * Proposes one dependency install for fresh worktrees from the checkout's lockfile, if any, as the
 * plain-string form so the saved settings file stays easy to read and edit.
 */
async function proposeSetupCommands(
  root: string,
  readText: PolicyTextReader | undefined,
): Promise<readonly string[]> {
  for (const [lockfile, command] of LOCKFILE_INSTALLS) {
    if ((await readRepositoryFile(root, lockfile, readText, false)) !== undefined) return [command];
  }
  return [];
}

function appendValidationCommands(
  base: RepoPolicy,
  commands: readonly ValidationCommand[],
): RepoPolicy {
  if (commands.length === 0) {
    return copyPolicy(base);
  }
  const commandInput = commands.map((command) => ({
    name: command.name,
    argv: [...command.argv],
    surfaces: [...command.surfaces],
    timeoutMs: command.timeoutMs,
  }));
  return parsePolicyOverride({ validationCommands: commandInput }, base);
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

function serializeCentralConfig(
  root: string,
  commands: readonly ValidationCommand[],
  setupCommands: readonly string[],
): string {
  return `${JSON.stringify(
    {
      schemaVersion: CENTRAL_SCHEMA_VERSION,
      repoPath: root,
      policy: { version: 1, validationCommands: commands, setupCommands },
    },
    null,
    2,
  )}
`;
}

/** The absolute path of a repository's central settings file, whether or not it exists yet. */
export async function centralConfigPath(repoPath: string, home: string): Promise<string> {
  return centralPaths(await repositoryRoot(repoPath), await configuredHome(home)).config;
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
  if (existingConfig && options.write === true) {
    throw centralOverwriteError(paths.config);
  }

  const packageText = await readRepositoryFile(
    checkoutRoot,
    "package.json",
    options.readText,
    false,
  );
  const proposal = proposeValidationCommands(packageText);
  const setupCommands = await proposeSetupCommands(checkoutRoot, options.readText);
  const proposedPolicy = existingConfig
    ? copyPolicy(currentPolicy)
    : parsePolicyOverride({ setupCommands }, appendValidationCommands(global, proposal.commands));
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
    configPath: paths.config,
    existingConfig,
    written,
    approvalRequired: !written && (proposal.approvalRequired || setupCommands.length > 0),
    modelSettings,
    policy: existingConfig ? currentPolicy : proposedPolicy,
    proposedPolicy,
    validationCommands: proposedPolicy.validationCommands,
    setupCommands: proposedPolicy.setupCommands,
    unresolved,
  };
}
