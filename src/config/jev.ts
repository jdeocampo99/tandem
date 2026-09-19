import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { JEV_MODEL } from "../adapters/typesafe.ts";
import {
  type AgentRole,
  MODEL_ROLE_ORDER,
  type ModelSpec,
  type ThinkingLevel,
} from "../contracts.ts";
import { configuredHome, inspectPolicyPath, type ResolvedHome } from "./storage.ts";
import {
  AGENT_ROLE_KEYS,
  assertKnownKeys,
  hasKey,
  isRecord,
  parseJson,
  readModelSelector,
  readNonEmptyString,
  readThinkingLevel,
} from "./values.ts";

const JEV_CONFIG_FILE = "jev.json";
const JEV_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CANDIDATES_PER_ROLE = 63;
const MAX_DESCRIPTION_LENGTH = 4_096;
const CANDIDATE_KEYS: Readonly<Record<string, true>> = {
  id: true,
  model: true,
  thinking: true,
  description: true,
};
const ENVELOPE_KEYS: Readonly<Record<string, true>> = {
  schemaVersion: true,
  routingCandidates: true,
};

export type JevMode = "off" | "shadow";

export type JevEnvironment = Readonly<{
  readonly mode: JevMode;
  readonly key?: string;
  readonly model: typeof JEV_MODEL;
  readonly timeoutMs: number;
}>;

export type JevRoutingCandidate = Readonly<{
  readonly id: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly description: string;
}>;

export type JevRoutingCandidates = Readonly<Record<AgentRole, readonly JevRoutingCandidate[]>>;

function emptyRoutingCandidates(): JevRoutingCandidates {
  return Object.fromEntries(
    MODEL_ROLE_ORDER.map((role) => [role, [] as readonly JevRoutingCandidate[]]),
  ) as JevRoutingCandidates;
}

function readTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/u.test(value.trim())) throw new TypeError("TANDEM_JEV_TIMEOUT_MS is invalid");
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new TypeError("TANDEM_JEV_TIMEOUT_MS is invalid");
  }
  return timeout;
}

export function readJevEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): JevEnvironment {
  const rawMode = env.TANDEM_JEV_MODE?.trim() ?? "off";
  if (rawMode !== "off" && rawMode !== "shadow") {
    throw new TypeError("TANDEM_JEV_MODE must be off or shadow");
  }
  const rawKey = env.TYPESAFE_API_KEY;
  if (rawKey !== undefined && rawKey.length > 0 && rawKey.trim().length === 0) {
    throw new TypeError("TYPESAFE_API_KEY is invalid");
  }
  if (rawKey?.includes("\0")) throw new TypeError("TYPESAFE_API_KEY is invalid");
  const key = rawKey === undefined || rawKey.trim() === "" ? undefined : rawKey.trim();
  return {
    mode: rawMode,
    model: JEV_MODEL,
    timeoutMs: readTimeout(env.TANDEM_JEV_TIMEOUT_MS),
    ...(key === undefined ? {} : { key }),
  };
}

function candidateId(value: unknown): string {
  const id = readNonEmptyString(value, "routing candidate id");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(id)) {
    throw new TypeError("routing candidate id is invalid");
  }
  return id;
}

function parseCandidate(value: unknown): JevRoutingCandidate {
  if (!isRecord(value)) throw new TypeError("routing candidate must be an object");
  assertKnownKeys(value, CANDIDATE_KEYS, "routing candidate");
  for (const key of Object.keys(CANDIDATE_KEYS)) {
    if (!hasKey(value, key)) throw new TypeError("routing candidate is incomplete");
  }
  const id = candidateId(value.id);
  const model = readModelSelector(value.model, "routing candidate model");
  const thinking = readThinkingLevel(value.thinking, "routing candidate thinking");
  const description = readNonEmptyString(value.description, "routing candidate description");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new TypeError("routing candidate description is too long");
  }
  return { id, model, thinking, description } satisfies JevRoutingCandidate;
}

function parseCandidates(input: unknown): JevRoutingCandidates {
  if (!isRecord(input)) throw new TypeError("routingCandidates must be an object");
  assertKnownKeys(input, AGENT_ROLE_KEYS, "routingCandidates");
  const parsed = emptyRoutingCandidates() as Record<AgentRole, readonly JevRoutingCandidate[]>;
  const ids = new Set<string>();
  for (const role of MODEL_ROLE_ORDER) {
    const value = input[role];
    if (role === "coordinator" && value !== undefined) {
      throw new TypeError("routingCandidates.coordinator is unsupported");
    }
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > MAX_CANDIDATES_PER_ROLE) {
      throw new TypeError(`routingCandidates.${role} must be an array`);
    }
    const roleCandidates: JevRoutingCandidate[] = [];
    for (const candidate of value) {
      const parsedCandidate = parseCandidate(candidate);
      if (ids.has(parsedCandidate.id)) throw new TypeError("routing candidate ids must be unique");
      ids.add(parsedCandidate.id);
      roleCandidates.push(parsedCandidate);
    }
    parsed[role] = roleCandidates;
  }
  return parsed;
}

function configPath(home: ResolvedHome): string {
  return path.join(home.canonical, JEV_CONFIG_FILE);
}

export async function readJevRoutingCandidates(home: string): Promise<JevRoutingCandidates> {
  const resolved = await configuredHome(home);
  const config = configPath(resolved);
  const inspection = await inspectPolicyPath({ home: resolved.canonical, config });
  if (!inspection.exists) return emptyRoutingCandidates();
  const details = await stat(config);
  if (!details.isFile() || details.size > MAX_CONFIG_BYTES) {
    throw new TypeError("Jev routing candidate config is invalid");
  }
  const text = await readFile(config, "utf8");
  const envelope = parseJson(text, config);
  if (!isRecord(envelope)) throw new TypeError("Jev routing candidate config is invalid");
  assertKnownKeys(envelope, ENVELOPE_KEYS, config);
  if (
    envelope.schemaVersion !== JEV_SCHEMA_VERSION ||
    !hasKey(envelope, "schemaVersion") ||
    !hasKey(envelope, "routingCandidates")
  ) {
    throw new TypeError("Jev routing candidate config is invalid");
  }
  return parseCandidates(envelope.routingCandidates);
}

export type JevRoutingModelSpec = ModelSpec;
