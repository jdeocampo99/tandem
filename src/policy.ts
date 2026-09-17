import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentRole,
  InstructionChannel,
  ModelSpec,
  RepoPolicy,
  ResolvedGuidance,
  ResolvedPolicy,
  ThinkingLevel,
  ValidationCommand,
} from "./contracts.ts";
import { writeJsonAtomically } from "./runtime.ts";

const INSTRUCTION_CHANNELS = [
  "implementation",
  "validation",
  "review",
] as const satisfies readonly InstructionChannel[];

const INSTRUCTION_CHANNEL_KEYS: Readonly<Record<InstructionChannel, true>> = {
  implementation: true,
  validation: true,
  review: true,
};

const AGENT_ROLE_KEYS: Readonly<Record<AgentRole, true>> = {
  coordinator: true,
  scout: true,
  implementer: true,
  reviewer: true,
  verifier: true,
  presentation: true,
};

const MODEL_SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*\/[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u;
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

const POLICY_KEYS: Readonly<Record<string, true>> = {
  version: true,
  models: true,
  instructions: true,
  instructionFiles: true,
  validationCommands: true,
  maxWorkers: true,
  maxFixRounds: true,
};

const MODEL_KEYS: Readonly<Record<string, true>> = {
  model: true,
  thinking: true,
};
const COMMAND_KEYS: Readonly<Record<string, true>> = {
  name: true,
  argv: true,
  surfaces: true,
  timeoutMs: true,
};
const ROOT_GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const CENTRAL_REPOSITORY_DIRECTORY = "repositories";
const CENTRAL_CONFIG_FILE = "config.json";
const CENTRAL_SCHEMA_VERSION = 1;
const MODEL_SETTINGS_FILE = "models.json";
const MODEL_SETTINGS_SCHEMA_VERSION = 1;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

const DEFAULT_MODELS: Readonly<Record<AgentRole, ModelSpec>> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  verifier: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

/** Reads an absolute Tandem or target-repository file; return undefined only when the optional file is absent. */
export type PolicyTextReader = (
  absolutePath: string,
) => Promise<string | undefined> | string | undefined;

/** Writes a new Tandem-owned policy file at an absolute path. */
export type PolicyTextWriter = (absolutePath: string, text: string) => Promise<void> | void;

/** Inputs for resolving global policy plus a Tandem-owned central repository override. */
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

export type ModelSettings = Readonly<{
  configPath: string;
  configured: boolean;
  models?: RepoPolicy["models"];
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
  unresolved: readonly string[];
}>;
type PolicyRecord = Readonly<Record<string, unknown>>;
type PolicyBase = RepoPolicy;
function isRecord(value: unknown): value is PolicyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKey(value: PolicyRecord, key: string): boolean {
  return Object.hasOwn(value, key);
}

function assertKnownKeys(
  value: PolicyRecord,
  allowed: Readonly<Record<string, true>>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed[key] !== true) {
      throw new TypeError(`${field} contains unknown key ${JSON.stringify(key)}`);
    }
  }
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (hasDisallowedControlCharacter(value, false)) {
    throw new TypeError(`${field} contains a control character or line break`);
  }
  return value.trim();
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function hasDisallowedControlCharacter(
  value: string,
  allowInstructionWhitespace: boolean,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code !== 0x7f) {
      continue;
    }
    if (allowInstructionWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) {
      continue;
    }
    return true;
  }
  return false;
}

function readInstruction(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (hasDisallowedControlCharacter(value, true)) {
    throw new TypeError(`${field} contains a control character`);
  }
  return value.trim();
}

function readThinkingLevel(value: unknown, field: string): ThinkingLevel {
  if (typeof value !== "string" || THINKING_LEVELS[value as ThinkingLevel] !== true) {
    throw new TypeError(`${field} must be a supported thinking level`);
  }
  return value as ThinkingLevel;
}

function readModelSelector(value: unknown, field: string): string {
  if (typeof value !== "string" || !MODEL_SELECTOR_PATTERN.test(value)) {
    throw new TypeError(`${field} must be an exact provider/model selector`);
  }
  return value;
}

function readChannel(value: unknown, field: string): InstructionChannel {
  if (typeof value !== "string" || !INSTRUCTION_CHANNELS.includes(value as InstructionChannel)) {
    throw new TypeError(`${field} must name a supported instruction channel`);
  }
  return value as InstructionChannel;
}

function readInstructionList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of strings`);
  }

  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    entries.push(readInstruction(value[index], `${field}[${index}]`));
  }
  return entries;
}

function normalizeRelativeReference(value: unknown, field: string): string {
  const reference = readNonEmptyString(value, field);
  if (
    path.posix.isAbsolute(reference) ||
    path.win32.isAbsolute(reference) ||
    reference.includes("\\")
  ) {
    throw new TypeError(`${field} must be a relative POSIX path inside the repository`);
  }
  const normalized = path.posix.normalize(reference);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError(`${field} must stay inside the repository`);
  }
  return normalized;
}

function readReferenceList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of relative file references`);
  }

  const references: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    references.push(normalizeRelativeReference(value[index], `${field}[${index}]`));
  }
  return references;
}

function readChannels<T>(
  value: unknown,
  field: string,
  readList: (value: unknown, field: string) => readonly T[],
): Partial<Record<InstructionChannel, readonly T[]>> {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object keyed by instruction channel`);
  }
  assertKnownKeys(value, INSTRUCTION_CHANNEL_KEYS, field);

  const channels: Partial<Record<InstructionChannel, readonly T[]>> = {};
  for (const key of Object.keys(value)) {
    const channel = readChannel(key, `${field}.${key}`);
    channels[channel] = readList(value[key], `${field}.${channel}`);
  }
  return channels;
}

function cloneChannels<T>(
  channels: Readonly<Record<InstructionChannel, readonly T[]>>,
): Record<InstructionChannel, readonly T[]> {
  return {
    implementation: [...channels.implementation],
    validation: [...channels.validation],
    review: [...channels.review],
  };
}

function deduplicateStrings(entries: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function readModelOverrides(
  value: unknown,
  base: Readonly<Record<AgentRole, ModelSpec>>,
): Readonly<Record<AgentRole, ModelSpec>> {
  if (!isRecord(value)) {
    throw new TypeError("models must be an object keyed by agent role");
  }
  assertKnownKeys(value, AGENT_ROLE_KEYS, "models");

  const models: Record<AgentRole, ModelSpec> = {
    coordinator: { ...base.coordinator },
    scout: { ...base.scout },
    implementer: { ...base.implementer },
    reviewer: { ...base.reviewer },
    verifier: { ...base.verifier },
    presentation: { ...base.presentation },
  };

  for (const key of Object.keys(value)) {
    const role = key as AgentRole;
    const override = value[key];
    if (!isRecord(override)) {
      throw new TypeError(`models.${role} must be an object`);
    }
    assertKnownKeys(override, MODEL_KEYS, `models.${role}`);

    const model = hasKey(override, "model")
      ? readModelSelector(override.model, `models.${role}.model`)
      : models[role].model;
    const thinking = hasKey(override, "thinking")
      ? readThinkingLevel(override.thinking, `models.${role}.thinking`)
      : models[role].thinking;
    models[role] = { model, thinking };
  }

  return models;
}
/**
 * Parses the complete model-role selection persisted by onboarding.
 *
 * Unlike policy overrides, every role and both fields are required so a
 * partially written or manually edited selection can never become implicit
 * defaults.
 */
export function parseModelAssignments(input: unknown): RepoPolicy["models"] {
  if (!isRecord(input)) {
    throw new TypeError("models must be an object keyed by all agent roles");
  }
  assertKnownKeys(input, AGENT_ROLE_KEYS, "models");

  const roles = Object.keys(AGENT_ROLE_KEYS) as AgentRole[];
  for (const role of roles) {
    if (!hasKey(input, role)) {
      throw new TypeError(`models must contain role ${JSON.stringify(role)}`);
    }
  }

  const models: Record<AgentRole, ModelSpec> = {
    coordinator: { model: "", thinking: "off" },
    scout: { model: "", thinking: "off" },
    implementer: { model: "", thinking: "off" },
    reviewer: { model: "", thinking: "off" },
    verifier: { model: "", thinking: "off" },
    presentation: { model: "", thinking: "off" },
  };
  for (const role of roles) {
    const assignment = input[role];
    if (!isRecord(assignment)) {
      throw new TypeError(`models.${role} must be an object`);
    }
    assertKnownKeys(assignment, MODEL_KEYS, `models.${role}`);
    if (!hasKey(assignment, "model") || !hasKey(assignment, "thinking")) {
      throw new TypeError(`models.${role} must contain model and thinking`);
    }
    models[role] = {
      model: readModelSelector(assignment.model, `models.${role}.model`),
      thinking: readThinkingLevel(assignment.thinking, `models.${role}.thinking`),
    };
  }
  return models;
}

function readValidationCommands(
  value: unknown,
  field: string,
  base: readonly ValidationCommand[],
): readonly ValidationCommand[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of command objects`);
  }
  const parsed: ValidationCommand[] = [];
  const names = new Set(base.map((command) => command.name));
  for (let index = 0; index < value.length; index += 1) {
    const commandValue = value[index];
    if (!isRecord(commandValue)) {
      throw new TypeError(`${field}[${index}] must be an object`);
    }
    assertKnownKeys(commandValue, COMMAND_KEYS, `${field}[${index}]`);

    const name = readNonEmptyString(commandValue.name, `${field}[${index}].name`);
    if (names.has(name)) {
      throw new TypeError(`${field} contains duplicate command name ${JSON.stringify(name)}`);
    }

    if (!Array.isArray(commandValue.argv) || commandValue.argv.length === 0) {
      throw new TypeError(`${field}[${index}].argv must be a non-empty array`);
    }
    const argv: string[] = [];
    for (let argumentIndex = 0; argumentIndex < commandValue.argv.length; argumentIndex += 1) {
      argv.push(
        readNonEmptyString(
          commandValue.argv[argumentIndex],
          `${field}[${index}].argv[${argumentIndex}]`,
        ),
      );
    }

    if (!Array.isArray(commandValue.surfaces)) {
      throw new TypeError(`${field}[${index}].surfaces must be an array of strings`);
    }
    const surfaces: string[] = [];
    for (let surfaceIndex = 0; surfaceIndex < commandValue.surfaces.length; surfaceIndex += 1) {
      surfaces.push(
        readNonEmptyString(
          commandValue.surfaces[surfaceIndex],
          `${field}[${index}].surfaces[${surfaceIndex}]`,
        ),
      );
    }

    const timeoutMs = readPositiveInteger(commandValue.timeoutMs, `${field}[${index}].timeoutMs`);
    const command: ValidationCommand = { name, argv, surfaces, timeoutMs };
    parsed.push(command);
    names.add(name);
  }

  return [...base, ...parsed];
}

function copyPolicy(policy: PolicyBase): RepoPolicy {
  return {
    version: 1,
    models: {
      coordinator: { ...policy.models.coordinator },
      scout: { ...policy.models.scout },
      implementer: { ...policy.models.implementer },
      reviewer: { ...policy.models.reviewer },
      verifier: { ...policy.models.verifier },
      presentation: { ...policy.models.presentation },
    },
    instructions: cloneChannels(policy.instructions),
    instructionFiles: cloneChannels(policy.instructionFiles),
    validationCommands: policy.validationCommands.map((command) => ({
      name: command.name,
      argv: [...command.argv],
      surfaces: [...command.surfaces],
      timeoutMs: command.timeoutMs,
    })),
    maxWorkers: policy.maxWorkers,
    maxFixRounds: policy.maxFixRounds,
  };
}

function parsePolicyOverride(input: unknown, base: PolicyBase): RepoPolicy {
  if (!isRecord(input)) {
    throw new TypeError("policy must be an object");
  }
  assertKnownKeys(input, POLICY_KEYS, "policy");

  if (hasKey(input, "version") && input.version !== 1) {
    throw new TypeError("policy.version must be 1");
  }

  const models = hasKey(input, "models")
    ? readModelOverrides(input.models, base.models)
    : base.models;
  const instructions = cloneChannels(base.instructions);
  if (hasKey(input, "instructions")) {
    const overrides = readChannels(input.instructions, "instructions", readInstructionList);
    for (const channel of INSTRUCTION_CHANNELS) {
      const entries = overrides[channel];
      if (entries !== undefined) {
        instructions[channel] = deduplicateStrings([...instructions[channel], ...entries]);
      }
    }
  }

  const instructionFiles = cloneChannels(base.instructionFiles);
  if (hasKey(input, "instructionFiles")) {
    const overrides = readChannels(input.instructionFiles, "instructionFiles", readReferenceList);
    for (const channel of INSTRUCTION_CHANNELS) {
      const entries = overrides[channel];
      if (entries !== undefined) {
        instructionFiles[channel] = deduplicateStrings([...instructionFiles[channel], ...entries]);
      }
    }
  }

  const validationCommands = hasKey(input, "validationCommands")
    ? readValidationCommands(
        input.validationCommands,
        "validationCommands",
        base.validationCommands,
      )
    : [...base.validationCommands];

  const maxWorkers = hasKey(input, "maxWorkers")
    ? readPositiveInteger(input.maxWorkers, "maxWorkers")
    : base.maxWorkers;
  const maxFixRounds = hasKey(input, "maxFixRounds")
    ? readPositiveInteger(input.maxFixRounds, "maxFixRounds")
    : base.maxFixRounds;

  return {
    version: 1,
    models,
    instructions,
    instructionFiles,
    validationCommands,
    maxWorkers,
    maxFixRounds,
  };
}

function buildDefaultPolicy(): RepoPolicy {
  return {
    version: 1,
    models: {
      coordinator: { ...DEFAULT_MODELS.coordinator },
      scout: { ...DEFAULT_MODELS.scout },
      implementer: { ...DEFAULT_MODELS.implementer },
      reviewer: { ...DEFAULT_MODELS.reviewer },
      verifier: { ...DEFAULT_MODELS.verifier },
      presentation: { ...DEFAULT_MODELS.presentation },
    },
    instructions: {
      implementation: [],
      validation: [],
      review: [],
    },
    instructionFiles: {
      implementation: [],
      validation: [],
      review: [],
    },
    validationCommands: [],
    maxWorkers: 3,
    maxFixRounds: 3,
  };
}

/** Returns a fresh policy with the exact built-in role pins and conservative limits. */
export function defaultPolicy(): RepoPolicy {
  return buildDefaultPolicy();
}

/** Parses a strict policy override and appends instruction, file, and command entries to defaults. */
export function parsePolicy(input: unknown): RepoPolicy {
  return parsePolicyOverride(input, buildDefaultPolicy());
}
function applySavedModelSettings(base: RepoPolicy, settings: ModelSettings): RepoPolicy {
  if (!settings.configured) return copyPolicy(base);
  if (settings.models === undefined) {
    throw new TypeError("configured model settings must contain models");
  }
  return parsePolicyOverride({ models: settings.models }, base);
}

function readPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty path`);
  }
  if (hasDisallowedControlCharacter(value, false)) {
    throw new TypeError(`${field} contains a control character or line break`);
  }
  return path.resolve(value);
}

async function repositoryRoot(repoPath: string): Promise<string> {
  const requested = readPath(repoPath, "repoPath");
  const root = await realpath(requested);
  const details = await stat(root);
  if (!details.isDirectory()) {
    throw new TypeError("repoPath must resolve to a directory");
  }
  return root;
}

type ResolvedHome = Readonly<{
  requested: string;
  canonical: string;
}>;

async function configuredHome(home: string): Promise<ResolvedHome> {
  const requested = readPath(home, "home");
  const missing: string[] = [];
  let candidate = requested;

  while (true) {
    try {
      const physical = await realpath(candidate);
      const details = await stat(physical);
      if (!details.isDirectory()) {
        throw new TypeError("home must resolve to a directory");
      }
      return {
        requested,
        canonical: path.resolve(physical, ...missing),
      };
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function repositoryKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

type CentralPaths = Readonly<{
  home: string;
  config: string;
}>;

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
type ModelSettingsPaths = Readonly<{
  home: string;
  config: string;
  requestedConfig: string;
}>;

function modelSettingsPaths(root: string, home: ResolvedHome): ModelSettingsPaths {
  const config = path.join(home.canonical, MODEL_SETTINGS_FILE);
  const requestedConfig = path.join(home.requested, MODEL_SETTINGS_FILE);
  if (isContainedPath(root, config) || isContainedPath(root, requestedConfig)) {
    throw new Error("Tandem home would place model settings inside the target repository");
  }
  return { home: home.canonical, config, requestedConfig };
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function assertContainedReference(root: string, reference: string): string {
  const candidate = path.resolve(root, ...reference.split("/"));
  if (!isContainedPath(root, candidate)) {
    throw new Error(`instruction reference escapes repository: ${reference}`);
  }
  return candidate;
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

async function assertPhysicalRepositoryReference(
  root: string,
  candidate: string,
  reference: string,
): Promise<void> {
  let candidateRealPath: string;
  try {
    candidateRealPath = await realpath(candidate);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  if (!isContainedPath(root, candidateRealPath)) {
    throw new Error(`instruction reference resolves outside repository: ${reference}`);
  }
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

type CentralInspection = Readonly<{
  exists: boolean;
}>;

async function inspectCentralPath(paths: CentralPaths): Promise<CentralInspection> {
  if (!isContainedPath(paths.home, paths.config)) {
    throw new Error("central policy path escapes Tandem home");
  }

  const components = path.relative(paths.home, paths.config).split(path.sep);
  let current = paths.home;
  for (const [index, component] of components.entries()) {
    const candidate = path.join(current, component);
    let details: Stats;
    try {
      details = await lstat(candidate);
    } catch (error) {
      if (isNotFoundError(error)) return { exists: false };
      throw error;
    }

    if (details.isSymbolicLink()) {
      throw new Error(`central policy path contains a symlink: ${candidate}`);
    }
    if (index < components.length - 1 && !details.isDirectory()) {
      throw new Error(`central policy directory is not a directory: ${candidate}`);
    }
    if (index === components.length - 1) {
      return { exists: true };
    }
    current = candidate;
  }

  return { exists: false };
}

const CENTRAL_ENVELOPE_KEYS: Readonly<Record<string, true>> = {
  schemaVersion: true,
  repoPath: true,
  policy: true,
};
const MODEL_SETTINGS_ENVELOPE_KEYS: Readonly<Record<string, true>> = {
  schemaVersion: true,
  models: true,
};

function parseStoredModelSettings(text: string, source: string): RepoPolicy["models"] {
  const envelope = parseJson(text, source);
  if (!isRecord(envelope)) {
    throw new TypeError(`${source} must be an object`);
  }
  assertKnownKeys(envelope, MODEL_SETTINGS_ENVELOPE_KEYS, source);
  if (!hasKey(envelope, "schemaVersion") || !hasKey(envelope, "models")) {
    throw new TypeError(`${source} must contain schemaVersion and models`);
  }
  if (envelope.schemaVersion !== MODEL_SETTINGS_SCHEMA_VERSION) {
    throw new TypeError(`${source}.schemaVersion must be ${MODEL_SETTINGS_SCHEMA_VERSION}`);
  }
  return parseModelAssignments(envelope.models);
}

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
  const inspection = await inspectCentralPath(paths);
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
async function readModelSettingsAt(
  root: string,
  home: ResolvedHome,
  readText: PolicyTextReader | undefined,
): Promise<ModelSettings> {
  const paths = modelSettingsPaths(root, home);
  const inspection = await inspectCentralPath(paths);
  let text: string | undefined;
  if (readText === undefined) {
    text = inspection.exists ? await readFile(paths.config, "utf8") : undefined;
  } else {
    text = await readText(paths.config);
    if (text === undefined && inspection.exists) {
      text = await readFile(paths.config, "utf8");
    }
  }
  if (text === undefined) {
    return { configPath: paths.config, configured: false };
  }
  return {
    configPath: paths.config,
    configured: true,
    models: parseStoredModelSettings(text, paths.config),
  };
}
export async function readModelSettings(
  options: Readonly<{
    repoPath: string;
    home: string;
    readText?: PolicyTextReader;
  }>,
): Promise<ModelSettings> {
  const root = await repositoryRoot(options.repoPath);
  const home = await configuredHome(options.home);
  return readModelSettingsAt(root, home, options.readText);
}

async function ensurePrivateDirectoryTree(directory: string, field: string): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`${field} must be a private directory`);
      }
      break;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }

  for (const component of missing) {
    const next = path.join(current, component);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    const details = await lstat(next);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`${field} must be a private directory`);
    }
    current = next;
  }
}

async function ensureCentralDirectory(directory: string, field: string): Promise<void> {
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink()) {
      throw new Error(`central policy path contains a symlink: ${directory}`);
    }
    if (!details.isDirectory()) throw new Error(`${field} must be a directory`);
    return;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${field} must be a private directory`);
  }
}
function centralOverwriteError(configPath: string): Error {
  return new Error(`${configPath} already exists; onboarding refuses to overwrite it`);
}

async function writeCentralConfig(
  paths: CentralPaths,
  text: string,
  writeText: PolicyTextWriter | undefined,
): Promise<void> {
  const before = await inspectCentralPath(paths);
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
  const after = await inspectCentralPath(paths);
  if (after.exists) throw centralOverwriteError(paths.config);
  try {
    await writeFile(paths.config, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isAlreadyExistsError(error)) throw centralOverwriteError(paths.config);
    throw error;
  }
}
export async function writeModelSettings(
  options: Readonly<{
    repoPath: string;
    home: string;
    models: RepoPolicy["models"];
  }>,
): Promise<ModelSettings> {
  const root = await repositoryRoot(options.repoPath);
  const home = await configuredHome(options.home);
  const paths = modelSettingsPaths(root, home);
  const models = parseModelAssignments(options.models);
  const existing = await inspectCentralPath(paths);
  if (existing.exists) await readModelSettingsAt(root, home, undefined);

  await ensurePrivateDirectoryTree(paths.home, "Tandem home");
  const beforeWrite = await inspectCentralPath(paths);
  if (beforeWrite.exists) await readModelSettingsAt(root, home, undefined);
  await writeJsonAtomically(paths.config, {
    schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
    models,
  });
  const afterWrite = await inspectCentralPath(paths);
  if (!afterWrite.exists) throw new Error(`model settings write did not create ${paths.config}`);
  return readModelSettingsAt(root, home, undefined);
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

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new TypeError(`${source} must contain valid JSON: ${detail}`);
  }
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

function serializeCentralConfig(root: string, commands: readonly ValidationCommand[]): string {
  return `${JSON.stringify(
    {
      schemaVersion: CENTRAL_SCHEMA_VERSION,
      repoPath: root,
      policy: { version: 1, validationCommands: commands },
    },
    null,
    2,
  )}
`;
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
  const proposedPolicy = existingConfig
    ? copyPolicy(currentPolicy)
    : appendValidationCommands(global, proposal.commands);
  const unresolved = onboardingUnresolved(proposal, proposedPolicy);

  let written = false;
  if (options.write === true) {
    await writeCentralConfig(
      paths,
      serializeCentralConfig(root, proposal.commands),
      options.writeText,
    );
    written = true;
  }

  return {
    repoPath: root,
    configPath: paths.config,
    existingConfig,
    written,
    approvalRequired: !written && proposal.approvalRequired,
    modelSettings,
    policy: existingConfig ? currentPolicy : proposedPolicy,
    proposedPolicy,
    validationCommands: proposedPolicy.validationCommands,
    unresolved,
  };
}
