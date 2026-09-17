import type { AgentRole, ModelSpec, RepoPolicy, ValidationCommand } from "../contracts.ts";
import { MODEL_ROLE_ORDER } from "../contracts.ts";
import {
  AGENT_ROLE_KEYS,
  assertKnownKeys,
  cloneChannels,
  deduplicateStrings,
  hasKey,
  INSTRUCTION_CHANNELS,
  isRecord,
  MODEL_KEYS,
  readChannels,
  readInstructionList,
  readModelSelector,
  readNonEmptyString,
  readPositiveInteger,
  readReferenceList,
  readThinkingLevel,
} from "./values.ts";

const POLICY_KEYS: Readonly<Record<string, true>> = {
  version: true,
  models: true,
  instructions: true,
  instructionFiles: true,
  validationCommands: true,
  maxWorkers: true,
  maxFixRounds: true,
};

const COMMAND_KEYS: Readonly<Record<string, true>> = {
  name: true,
  argv: true,
  surfaces: true,
  timeoutMs: true,
};

const DEFAULT_MODELS: Readonly<Record<AgentRole, ModelSpec>> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  verifier: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

type PolicyBase = RepoPolicy;

function readModelOverrides(
  value: unknown,
  base: Readonly<Record<AgentRole, ModelSpec>>,
): Readonly<Record<AgentRole, ModelSpec>> {
  if (!isRecord(value)) {
    throw new TypeError("models must be an object keyed by agent role");
  }
  assertKnownKeys(value, AGENT_ROLE_KEYS, "models");

  const models = {} as Record<AgentRole, ModelSpec>;
  for (const role of MODEL_ROLE_ORDER) {
    models[role] = { ...base[role] };
  }

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
    maxWorkers: policy.maxWorkers,
    maxFixRounds: policy.maxFixRounds,
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
