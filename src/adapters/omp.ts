import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { CommandRequest, CommandRunner, ModelSpec, ThinkingLevel } from "../contracts.ts";
import {
  AdapterProtocolError,
  checkedPath,
  checkedText,
  optionalInteger,
  optionalString,
  parseJson,
  requiredRecord,
  requiredString,
  runChecked,
} from "./primitives.ts";

const THINKING_LEVELS: Readonly<Record<string, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS[value] === true;
}

/**
 * What one request on this model draws from a subscription's included allowance, in the
 * provider's own units. It carries no currency: an included draw is quota consumption, and
 * pricing it would invent a charge the provider never billed.
 */
export type OmpIncludedAllowance = Readonly<{
  plan: string;
  unit: string;
  unitsPerRequest: number;
}>;

export type OmpModelRecord = Readonly<{
  selector: string;
  id: string;
  provider: string;
  thinking: readonly ThinkingLevel[];
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  /** Descriptive catalogue pricing; it is evidence about the model, not this account's rate. */
  cost?: Readonly<{
    input: number;
    output: number;
  }>;
  includedAllowance?: OmpIncludedAllowance;
}>;

export type OmpModelListInput = Readonly<{
  cwd: string;
}>;

export type ValidateModelInput = Readonly<{
  cwd: string;
  model: ModelSpec;
}>;

function optionalBoolean(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new AdapterProtocolError(operation, `${field} must be a boolean when present`, response);
  }
  return value;
}

function optionalNumber(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a non-negative finite number when present`,
      response,
    );
  }
  return value;
}

function optionalModelCost(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): Readonly<{ input: number; output: number }> | undefined {
  if (value === undefined || value === null) return undefined;
  const cost = requiredRecord(value, field, operation, response);
  const input = optionalNumber(cost.input, `${field}.input`, operation, response);
  const output = optionalNumber(cost.output, `${field}.output`, operation, response);
  if (input === undefined || output === undefined) {
    throw new AdapterProtocolError(
      operation,
      `${field} must contain input and output costs`,
      response,
    );
  }
  return { input, output };
}

function optionalIncludedAllowance(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): OmpIncludedAllowance | undefined {
  if (value === undefined || value === null) return undefined;
  const allowance = requiredRecord(value, field, operation, response);
  const unitsPerRequest = optionalNumber(
    allowance.unitsPerRequest,
    `${field}.unitsPerRequest`,
    operation,
    response,
  );
  if (unitsPerRequest === undefined) {
    throw new AdapterProtocolError(
      operation,
      `${field} must report unitsPerRequest when present`,
      response,
    );
  }
  return {
    plan: requiredString(allowance.plan, `${field}.plan`, operation, response),
    unit: requiredString(allowance.unit, `${field}.unit`, operation, response),
    unitsPerRequest,
  };
}

function parseThinkingLevels(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): readonly ThinkingLevel[] {
  const values: readonly unknown[] =
    typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (values.length === 0 || values.some((entry) => typeof entry !== "string")) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a thinking level or non-empty level array`,
      response,
    );
  }
  const levels: ThinkingLevel[] = [];
  for (const entry of values) {
    if (typeof entry !== "string" || !isThinkingLevel(entry)) {
      throw new AdapterProtocolError(
        operation,
        `${field} contains unsupported level ${JSON.stringify(entry)}`,
        response,
      );
    }
    levels.push(entry);
  }
  return levels;
}

function parseModelRecord(
  value: unknown,
  index: number,
  operation: string,
  response: string,
): OmpModelRecord {
  const record = requiredRecord(value, `models[${index}]`, operation, response);
  const selector = requiredString(
    record.selector,
    `models[${index}].selector`,
    operation,
    response,
  );
  const id = requiredString(record.id, `models[${index}].id`, operation, response);
  const provider = requiredString(
    record.provider,
    `models[${index}].provider`,
    operation,
    response,
  );
  const thinking = parseThinkingLevels(
    record.thinking,
    `models[${index}].thinking`,
    operation,
    response,
  );
  const name = optionalString(record.name, `models[${index}].name`, operation, response);
  const reasoning = optionalBoolean(
    record.reasoning,
    `models[${index}].reasoning`,
    operation,
    response,
  );
  const contextWindow = optionalInteger(
    record.contextWindow,
    `models[${index}].contextWindow`,
    operation,
    response,
  );
  const cost = optionalModelCost(record.cost, `models[${index}].cost`, operation, response);
  const includedAllowance = optionalIncludedAllowance(
    record.includedAllowance,
    `models[${index}].includedAllowance`,
    operation,
    response,
  );
  return {
    selector,
    id,
    provider,
    thinking,
    ...(name === undefined ? {} : { name }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(cost === undefined ? {} : { cost }),
    ...(includedAllowance === undefined ? {} : { includedAllowance }),
  };
}

function parseModelListing(response: string): readonly OmpModelRecord[] {
  const operation = "omp model listing";
  const parsed = parseJson(response, operation);
  const root = requiredRecord(parsed, "response", operation, response);
  if (!Array.isArray(root.models)) {
    throw new AdapterProtocolError(operation, "models must be an array", response);
  }
  return root.models.map((entry, index) => parseModelRecord(entry, index, operation, response));
}

type OmpModelListingResult = Readonly<{
  readonly models: readonly OmpModelRecord[];
  readonly response: string;
}>;

async function readOmpModelListing(
  run: CommandRunner,
  input: OmpModelListInput,
): Promise<OmpModelListingResult> {
  const request: CommandRequest = {
    argv: ["omp", "models", "--json"],
    cwd: checkedPath(input.cwd, "cwd"),
  };
  const result = await runChecked(run, request, "omp model listing");
  return {
    models: parseModelListing(result.stdout),
    response: result.stdout,
  };
}

export async function listOmpModels(
  run: CommandRunner,
  input: OmpModelListInput,
): Promise<readonly OmpModelRecord[]> {
  return (await readOmpModelListing(run, input)).models;
}

export async function validateModel(
  run: CommandRunner,
  input: ValidateModelInput,
): Promise<OmpModelRecord> {
  const model = input.model;
  checkedText(model.model, "model.model");
  if (!isThinkingLevel(model.thinking)) {
    throw new TypeError(`unsupported model thinking level ${model.thinking}`);
  }
  const listing = await readOmpModelListing(run, { cwd: input.cwd });
  const matches = listing.models.filter((candidate) => candidate.selector === model.model);
  if (matches.length !== 1) {
    throw new AdapterProtocolError(
      "omp model listing",
      `selector ${JSON.stringify(model.model)} matched ${matches.length} models; no fallback is allowed`,
      listing.response,
    );
  }
  const observed = matches[0];
  if (observed === undefined) {
    throw new AdapterProtocolError(
      "omp model listing",
      `selector ${JSON.stringify(model.model)} matched no model`,
      listing.response,
    );
  }
  if (!observed.thinking.includes(model.thinking)) {
    throw new AdapterProtocolError(
      "omp model listing",
      `selector ${JSON.stringify(model.model)} does not support thinking ${JSON.stringify(model.thinking)}`,
      listing.response,
    );
  }
  return observed;
}

/** Names of the MCP servers OMP would load in this checkout, from project and user config. */
export async function listOmpMcpServers(cwd: string): Promise<readonly string[]> {
  const { configs } = await loadAllMCPConfigs(cwd);
  return Object.keys(configs).sort();
}
