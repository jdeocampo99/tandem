import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { AgentRole, ModelSpec, RepoPolicy } from "../contracts.ts";
import { MODEL_ROLE_ORDER } from "../contracts.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import {
  configuredHome,
  ensurePrivateDirectoryTree,
  inspectPolicyPath,
  isContainedPath,
  type PolicyTextReader,
  type ResolvedHome,
  repositoryRoot,
} from "./storage.ts";
import {
  assertKnownKeys,
  deduplicateStrings,
  hasKey,
  isRecord,
  LEGACY_MODEL_ROLE_KEYS,
  MODEL_KEYS,
  parseJson,
  readModelSelector,
  readNonEmptyString,
  readThinkingLevel,
} from "./values.ts";

const MODEL_SETTINGS_FILE = "models.json";
const MODEL_SETTINGS_SCHEMA_VERSION = 1;
const MODEL_SETTINGS_ENVELOPE_KEYS: Readonly<Record<string, true>> = {
  schemaVersion: true,
  models: true,
  enabledProviders: true,
};

export type ModelSettings = Readonly<{
  configPath: string;
  configured: boolean;
  models?: RepoPolicy["models"];
  /** Providers explicitly approved for spending; catalogue discovery alone never adds one here. */
  enabledProviders: readonly string[];
}>;
type ModelSettingsPaths = Readonly<{
  home: string;
  config: string;
  requestedConfig: string;
}>;

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
  // ponytail: a saved models.json may still carry a "verifier" entry from before the role was
  // removed; accept it here so it still loads, but MODEL_ROLE_ORDER's loop below never reads it.
  assertKnownKeys(input, LEGACY_MODEL_ROLE_KEYS, "models");

  for (const role of MODEL_ROLE_ORDER) {
    if (!hasKey(input, role)) {
      throw new TypeError(`models must contain role ${JSON.stringify(role)}`);
    }
  }

  const models = {} as Record<AgentRole, ModelSpec>;
  for (const role of MODEL_ROLE_ORDER) {
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

function modelSettingsPaths(root: string, home: ResolvedHome): ModelSettingsPaths {
  const config = path.join(home.canonical, MODEL_SETTINGS_FILE);
  const requestedConfig = path.join(home.requested, MODEL_SETTINGS_FILE);
  if (isContainedPath(root, config) || isContainedPath(root, requestedConfig)) {
    throw new Error("Tandem home would place model settings inside the target repository");
  }
  return { home: home.canonical, config, requestedConfig };
}
/** Reads the explicit spending-permission provider set; absent means none, never "all discovered". */
function readEnabledProviders(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of provider ids`);
  }
  const providers = value.map((entry, index) => readNonEmptyString(entry, `${field}[${index}]`));
  return [...deduplicateStrings(providers)].sort();
}

type StoredModelSettings = Readonly<{
  models: RepoPolicy["models"];
  enabledProviders: readonly string[];
}>;

function parseStoredModelSettings(text: string, source: string): StoredModelSettings {
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
  return {
    models: parseModelAssignments(envelope.models),
    enabledProviders: readEnabledProviders(envelope.enabledProviders, `${source}.enabledProviders`),
  };
}

/** Reads model settings after repository and Tandem-home paths have been canonicalized. */
export async function readModelSettingsAt(
  root: string,
  home: ResolvedHome,
  readText: PolicyTextReader | undefined,
): Promise<ModelSettings> {
  const paths = modelSettingsPaths(root, home);
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
  if (text === undefined) {
    return { configPath: paths.config, configured: false, enabledProviders: [] };
  }
  const stored = parseStoredModelSettings(text, paths.config);
  return {
    configPath: paths.config,
    configured: true,
    models: stored.models,
    enabledProviders: stored.enabledProviders,
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

export async function writeModelSettings(
  options: Readonly<{
    repoPath: string;
    home: string;
    models: RepoPolicy["models"];
    /** Omit to preserve the previously saved provider enablement; never defaults to "all discovered". */
    enabledProviders?: readonly string[] | undefined;
  }>,
): Promise<ModelSettings> {
  const root = await repositoryRoot(options.repoPath);
  const home = await configuredHome(options.home);
  const paths = modelSettingsPaths(root, home);
  const models = parseModelAssignments(options.models);
  const existing = await inspectPolicyPath(paths);
  const priorSettings = existing.exists
    ? await readModelSettingsAt(root, home, undefined)
    : undefined;
  const enabledProviders =
    options.enabledProviders === undefined
      ? (priorSettings?.enabledProviders ?? [])
      : readEnabledProviders(options.enabledProviders, "enabledProviders");

  await ensurePrivateDirectoryTree(paths.home, "Tandem home");
  const beforeWrite = await inspectPolicyPath(paths);
  if (beforeWrite.exists) await readModelSettingsAt(root, home, undefined);
  await writeJsonAtomically(paths.config, {
    schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
    models,
    enabledProviders,
  });
  const afterWrite = await inspectPolicyPath(paths);
  if (!afterWrite.exists) throw new Error(`model settings write did not create ${paths.config}`);
  return readModelSettingsAt(root, home, undefined);
}
