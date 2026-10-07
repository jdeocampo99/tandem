import type {
  AgentRole,
  ModelSpec,
  RepoPolicy,
  SetupCommand,
  ValidationCommand,
} from "../contracts.ts";
import { MODEL_ROLE_ORDER } from "../contracts.ts";
import {
  assertKnownKeys,
  cloneChannels,
  deduplicateStrings,
  hasKey,
  INSTRUCTION_CHANNELS,
  isRecord,
  LEGACY_MODEL_ROLE_KEYS,
  MODEL_KEYS,
  readChannels,
  readInstructionList,
  readModelSelector,
  readNonEmptyString,
  readPositiveInteger,
  readReferenceList,
  readThinkingLevel,
} from "./values.ts";

// ponytail: a repository config may still set "requestBudget", "maxWorkers", or "reviewLevels" from
// before standing request budgets, the worker limit, and review-level settings were removed; accept
// them here so the config still loads, but their values are never read.
const POLICY_KEYS: Readonly<Record<string, true>> = {
  version: true,
  models: true,
  instructions: true,
  instructionFiles: true,
  validationCommands: true,
  validation: true,
  setupCommands: true,
  maxWorkers: true,
  maxFixRounds: true,
  reviewLevels: true,
  standards: true,
  requestBudget: true,
};

const COMMAND_KEYS: Readonly<Record<string, true>> = {
  name: true,
  argv: true,
  surfaces: true,
  timeoutMs: true,
};

const SETUP_COMMAND_KEYS: Readonly<Record<string, true>> = {
  name: true,
  argv: true,
  timeoutMs: true,
};

const DEFAULT_MODELS: Readonly<Record<AgentRole, ModelSpec>> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

type PolicyBase = RepoPolicy;

/** Ten minutes: the timeout for a command written as a plain string or proposed by onboarding. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/**
 * A command written as a plain string (e.g. "npm ci") runs through the shell, so `&&` and quoting
 * work as typed; the string is also its name and it gets the default timeout.
 */
function readShorthandCommand(value: string, field: string): SetupCommand {
  const text = readNonEmptyString(value, field).trim();
  return { name: text, argv: ["/bin/sh", "-c", text], timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS };
}

function readModelOverrides(
  value: unknown,
  base: Readonly<Record<AgentRole, ModelSpec>>,
): Readonly<Record<AgentRole, ModelSpec>> {
  if (!isRecord(value)) {
    throw new TypeError("models must be an object keyed by agent role");
  }
  assertKnownKeys(value, LEGACY_MODEL_ROLE_KEYS, "models");

  const models = {} as Record<AgentRole, ModelSpec>;
  for (const role of MODEL_ROLE_ORDER) {
    models[role] = { ...base[role] };
  }

  for (const key of Object.keys(value)) {
    if (key === "verifier") continue;
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
    if (typeof commandValue === "string") {
      const command = { ...readShorthandCommand(commandValue, `${field}[${index}]`), surfaces: [] };
      if (names.has(command.name)) {
        throw new TypeError(
          `${field} contains duplicate command name ${JSON.stringify(command.name)}`,
        );
      }
      parsed.push(command);
      names.add(command.name);
      continue;
    }
    if (!isRecord(commandValue)) {
      throw new TypeError(`${field}[${index}] must be a command string or object`);
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

function readArgv(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
  return value.map((argument: unknown, index) =>
    readNonEmptyString(argument, `${field}[${index}]`),
  );
}

/** Reads the worktree setup commands, appended after the base layer's like validation commands. */
function readSetupCommands(value: unknown, base: readonly SetupCommand[]): readonly SetupCommand[] {
  if (!Array.isArray(value)) {
    throw new TypeError("setupCommands must be an array of command objects");
  }
  const parsed: SetupCommand[] = [...base];
  const names = new Set(base.map((command) => command.name));
  for (let index = 0; index < value.length; index += 1) {
    const field = `setupCommands[${index}]`;
    const commandValue: unknown = value[index];
    let command: SetupCommand;
    if (typeof commandValue === "string") {
      command = readShorthandCommand(commandValue, field);
    } else {
      if (!isRecord(commandValue))
        throw new TypeError(`${field} must be a command string or object`);
      assertKnownKeys(commandValue, SETUP_COMMAND_KEYS, field);
      command = {
        name: readNonEmptyString(commandValue.name, `${field}.name`),
        argv: readArgv(commandValue.argv, `${field}.argv`),
        timeoutMs: readPositiveInteger(commandValue.timeoutMs, `${field}.timeoutMs`),
      };
    }
    if (names.has(command.name)) {
      throw new TypeError(
        `setupCommands contains duplicate command name ${JSON.stringify(command.name)}`,
      );
    }
    names.add(command.name);
    parsed.push(command);
  }
  return parsed;
}

export function copyPolicy(policy: PolicyBase): RepoPolicy {
  const models = {} as Record<AgentRole, ModelSpec>;
  for (const role of MODEL_ROLE_ORDER) {
    models[role] = { ...policy.models[role] };
  }
  return {
    version: 1,
    models,
    instructions: cloneChannels(policy.instructions),
    instructionFiles: cloneChannels(policy.instructionFiles),
    validationCommands: policy.validationCommands.map((command) => ({
      name: command.name,
      argv: [...command.argv],
      surfaces: [...command.surfaces],
      timeoutMs: command.timeoutMs,
    })),
    ...(policy.validation === undefined ? {} : { validation: policy.validation }),
    setupCommands: policy.setupCommands.map((command) => ({
      name: command.name,
      argv: [...command.argv],
      timeoutMs: command.timeoutMs,
    })),
    maxFixRounds: policy.maxFixRounds,
    ...(policy.standards === undefined ? {} : { standards: policy.standards }),
  };
}

export function parsePolicyOverride(input: unknown, base: PolicyBase): RepoPolicy {
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
  const validation = readValidationChoice(input, base, validationCommands);
  const setupCommands = hasKey(input, "setupCommands")
    ? readSetupCommands(input.setupCommands, base.setupCommands)
    : [...base.setupCommands];

  const maxFixRounds = hasKey(input, "maxFixRounds")
    ? readPositiveInteger(input.maxFixRounds, "maxFixRounds")
    : base.maxFixRounds;
  const standards = hasKey(input, "standards") ? readStandards(input.standards) : base.standards;

  return {
    version: 1,
    models,
    instructions,
    instructionFiles,
    validationCommands,
    ...(validation === undefined ? {} : { validation }),
    setupCommands,
    maxFixRounds,
    ...(standards === undefined ? {} : { standards }),
  };
}

/**
 * `validation = "none"` is the user's "no checks", and holds only while no validation command is
 * configured: one layer setting both is refused, and commands a later layer adds replace an
 * inherited "none".
 */
function readValidationChoice(
  input: Readonly<Record<string, unknown>>,
  base: PolicyBase,
  validationCommands: readonly ValidationCommand[],
): "none" | undefined {
  if (!hasKey(input, "validation")) {
    return validationCommands.length === 0 ? base.validation : undefined;
  }
  if (input.validation !== "none") throw new TypeError('validation must be "none" when set');
  if (validationCommands.length > 0) {
    throw new TypeError('validation = "none" means no checks; remove the validationCommands');
  }
  return "none";
}

function readStandards(value: unknown): "none" | undefined {
  if (value === "tandem") return undefined;
  if (value === "none") return "none";
  throw new TypeError('standards must be "tandem" or "none"');
}

function buildDefaultPolicy(): RepoPolicy {
  return {
    version: 1,
    models: {
      coordinator: { ...DEFAULT_MODELS.coordinator },
      scout: { ...DEFAULT_MODELS.scout },
      implementer: { ...DEFAULT_MODELS.implementer },
      reviewer: { ...DEFAULT_MODELS.reviewer },
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
    setupCommands: [],
    maxFixRounds: 2,
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
