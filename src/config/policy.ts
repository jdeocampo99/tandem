import type {
  AgentRole,
  ModelSpec,
  RepoPolicy,
  RequestBudgetPolicy,
  ReviewLevelPolicy,
  SetupCommand,
  ValidationCommand,
} from "../contracts.ts";
import { MODEL_ROLE_ORDER } from "../contracts.ts";
import { DEFAULT_REVIEW_LEVEL_POLICY } from "../tasks/review-levels.ts";
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
  setupCommands: true,
  maxWorkers: true,
  maxFixRounds: true,
  reviewLevels: true,
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

const REVIEW_LEVEL_KEYS: Readonly<Record<string, true>> = {
  reducedRouting: true,
  deepScrutiny: true,
  jevAssistance: true,
  sourceTransmission: true,
};

const REQUEST_BUDGET_KEYS: Readonly<Record<string, true>> = {
  capMicros: true,
  operationEstimateMicros: true,
};

/**
 * No standing amount is assumed for anyone. Until a repository configures a cap, its requests are
 * not spend-governed and run as they did before budgets existed, rather than pausing against a cap
 * Tandem invented for them. Configuring `capMicros` turns the whole feature on for that repository.
 */
export const DEFAULT_REQUEST_BUDGET: RequestBudgetPolicy = {
  capMicros: "unset",
  operationEstimateMicros: "unset",
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
    if (!isRecord(commandValue)) throw new TypeError(`${field} must be an object`);
    assertKnownKeys(commandValue, SETUP_COMMAND_KEYS, field);
    const name = readNonEmptyString(commandValue.name, `${field}.name`);
    if (names.has(name)) {
      throw new TypeError(`setupCommands contains duplicate command name ${JSON.stringify(name)}`);
    }
    names.add(name);
    parsed.push({
      name,
      argv: readArgv(commandValue.argv, `${field}.argv`),
      timeoutMs: readPositiveInteger(commandValue.timeoutMs, `${field}.timeoutMs`),
    });
  }
  return parsed;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

/**
 * Reads the review-level opt-ins. Each one is off unless the repository names it, and each one
 * is documented in `docs/agent-reference.md` as requiring the end-to-end evaluation from issue
 * #20 before it is turned on, because turning one on changes what review actually runs.
 */
function readReviewLevels(value: unknown, base: ReviewLevelPolicy): ReviewLevelPolicy {
  if (!isRecord(value)) {
    throw new TypeError("reviewLevels must be an object");
  }
  assertKnownKeys(value, REVIEW_LEVEL_KEYS, "reviewLevels");
  const jevAssistance = hasKey(value, "jevAssistance")
    ? readNonEmptyString(value.jevAssistance, "reviewLevels.jevAssistance")
    : base.jevAssistance;
  if (jevAssistance !== "off" && jevAssistance !== "shadow") {
    throw new TypeError("reviewLevels.jevAssistance must be off or shadow");
  }
  return {
    reducedRouting: hasKey(value, "reducedRouting")
      ? readBoolean(value.reducedRouting, "reviewLevels.reducedRouting")
      : base.reducedRouting,
    deepScrutiny: hasKey(value, "deepScrutiny")
      ? readBoolean(value.deepScrutiny, "reviewLevels.deepScrutiny")
      : base.deepScrutiny,
    jevAssistance,
    sourceTransmission: hasKey(value, "sourceTransmission")
      ? readBoolean(value.sourceTransmission, "reviewLevels.sourceTransmission")
      : base.sourceTransmission,
  };
}

/**
 * Reads the standing spending amounts. An amount the repository does not name keeps whatever the
 * layer beneath it configured, so a repository can tighten one amount without silently adopting a
 * default for the other. Zero is a real cap that forbids spending; a negative or fractional amount
 * is refused rather than rounded, because micro-dollars are the smallest unit a receipt sums.
 */
function readRequestBudget(value: unknown, base: RequestBudgetPolicy): RequestBudgetPolicy {
  if (!isRecord(value)) {
    throw new TypeError("requestBudget must be an object");
  }
  assertKnownKeys(value, REQUEST_BUDGET_KEYS, "requestBudget");
  return {
    capMicros: hasKey(value, "capMicros")
      ? readMicroDollars(value.capMicros, "requestBudget.capMicros")
      : base.capMicros,
    operationEstimateMicros: hasKey(value, "operationEstimateMicros")
      ? readMicroDollars(value.operationEstimateMicros, "requestBudget.operationEstimateMicros")
      : base.operationEstimateMicros,
  };
}

function readMicroDollars(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer number of USD micro-dollars`);
  }
  return value as number;
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
    setupCommands: policy.setupCommands.map((command) => ({
      name: command.name,
      argv: [...command.argv],
      timeoutMs: command.timeoutMs,
    })),
    maxWorkers: policy.maxWorkers,
    maxFixRounds: policy.maxFixRounds,
    reviewLevels: { ...policy.reviewLevels },
    requestBudget: { ...policy.requestBudget },
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
  const setupCommands = hasKey(input, "setupCommands")
    ? readSetupCommands(input.setupCommands, base.setupCommands)
    : [...base.setupCommands];

  const maxWorkers = hasKey(input, "maxWorkers")
    ? readPositiveInteger(input.maxWorkers, "maxWorkers")
    : base.maxWorkers;
  const maxFixRounds = hasKey(input, "maxFixRounds")
    ? readPositiveInteger(input.maxFixRounds, "maxFixRounds")
    : base.maxFixRounds;
  const reviewLevels = hasKey(input, "reviewLevels")
    ? readReviewLevels(input.reviewLevels, base.reviewLevels)
    : { ...base.reviewLevels };
  const requestBudget = hasKey(input, "requestBudget")
    ? readRequestBudget(input.requestBudget, base.requestBudget)
    : { ...base.requestBudget };

  return {
    version: 1,
    models,
    instructions,
    instructionFiles,
    validationCommands,
    setupCommands,
    maxWorkers,
    maxFixRounds,
    reviewLevels,
    requestBudget,
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
    setupCommands: [],
    maxWorkers: 3,
    maxFixRounds: 3,
    reviewLevels: { ...DEFAULT_REVIEW_LEVEL_POLICY },
    requestBudget: { ...DEFAULT_REQUEST_BUDGET },
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
