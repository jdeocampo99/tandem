/**
 * Reads accounting events back out of the authoritative state database.
 *
 * The parser is where the receipt's privacy and boundedness are enforced on re-read: every field
 * is a known key, every label is length-bounded, and every reason is one of the closed set, so a
 * row can never reintroduce a prompt, a provider payload, a credential, repository content, or a
 * full action error into a receipt.
 */

import { isSafeRequestId } from "../contracts.ts";
import { StateCorruptionError } from "../tasks/store-errors.ts";
import {
  type ChargeMeasurement,
  type QuotaMeasurement,
  REQUEST_TERMINAL_OUTCOMES,
  REQUEST_USAGE_EVENT_KINDS,
  REQUEST_USAGE_EVENT_SCHEMA_VERSION,
  REQUEST_WORK_KIND_ORDER,
  REQUEST_WORK_STATUSES,
  type RequestUsageEvent,
  type RequestWorkIdentity,
  type TokenMeasurement,
  USAGE_UNAVAILABLE_REASONS,
  type UsageUnavailableReason,
} from "./usage.ts";

/** The longest a provider, model, role, plan, unit, or estimation label may be on a stored row. */
export const MAX_USAGE_LABEL_CHARS = 120;

export function parseRequestUsageEvent(
  value: unknown,
  source = "request usage event",
): RequestUsageEvent {
  const record = requiredRecord(value, source);
  assertExactKeys(record, EVENT_KEYS, source);
  const schemaVersion = requiredInteger(record, "schemaVersion", source, 1);
  if (schemaVersion !== REQUEST_USAGE_EVENT_SCHEMA_VERSION) {
    failState(source, `unsupported schemaVersion ${schemaVersion}`);
  }
  const outcome = optionalField(record, "outcome");
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requiredLabel(record, "eventKey", source),
    kind: requiredEnum(record, "kind", REQUEST_USAGE_EVENT_KINDS, source),
    workKind: requiredEnum(record, "workKind", REQUEST_WORK_KIND_ORDER, source),
    identity: parseIdentity(requiredValue(record, "identity", source), `${source}.identity`),
    startedAt: requiredLabel(record, "startedAt", source),
    endedAt: requiredLabel(record, "endedAt", source),
    status: requiredEnum(record, "status", REQUEST_WORK_STATUSES, source),
    tokens: parseTokens(requiredValue(record, "tokens", source), `${source}.tokens`),
    charge: parseCharge(requiredValue(record, "charge", source), `${source}.charge`),
    quota: parseQuota(requiredValue(record, "quota", source), `${source}.quota`),
    ...(outcome === undefined
      ? {}
      : { outcome: enumValue(outcome, REQUEST_TERMINAL_OUTCOMES, "outcome", source) }),
  };
}

type UnknownRecord = Record<string, unknown>;

const EVENT_KEYS = [
  "schemaVersion",
  "eventKey",
  "kind",
  "workKind",
  "identity",
  "startedAt",
  "endedAt",
  "status",
  "tokens",
  "charge",
  "quota",
  "outcome",
] as const;

const IDENTITY_KEYS = [
  "requestId",
  "taskId",
  "jobId",
  "operationId",
  "generation",
  "attempt",
  "role",
  "provider",
  "model",
] as const;

const TOKEN_KEYS = ["provenance", "inputTokens", "outputTokens", "method", "source"] as const;

const CHARGE_KEYS = [
  "provenance",
  "currency",
  "amountMicros",
  "pricingSource",
  "pricingVersion",
] as const;

const QUOTA_KEYS = ["provenance", "plan", "unit", "units"] as const;

const UNAVAILABLE_KEYS = ["provenance", "reason"] as const;

function failState(source: string, message: string): never {
  throw new StateCorruptionError(source, message);
}

function requiredRecord(value: unknown, source: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failState(source, "must be an object");
  }
  return value as UnknownRecord;
}

function assertExactKeys(record: UnknownRecord, allowed: readonly string[], source: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) failState(source, `unexpected field ${key}`);
  }
}

function requiredValue(record: UnknownRecord, key: string, source: string): unknown {
  if (!Object.hasOwn(record, key)) failState(source, `missing field ${key}`);
  const value = record[key];
  if (value === undefined) failState(source, `field ${key} must not be undefined`);
  return value;
}

function optionalField(record: UnknownRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function labelValue(value: unknown, key: string, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failState(source, `field ${key} must be a non-empty string`);
  }
  if (value.length > MAX_USAGE_LABEL_CHARS) {
    failState(source, `field ${key} exceeds ${MAX_USAGE_LABEL_CHARS} characters`);
  }
  return value;
}

function requiredLabel(record: UnknownRecord, key: string, source: string): string {
  return labelValue(requiredValue(record, key, source), key, source);
}

function requiredInteger(record: UnknownRecord, key: string, source: string, minimum = 0): number {
  const value = requiredValue(record, key, source);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    failState(source, `field ${key} must be an integer >= ${minimum}`);
  }
  return value;
}

function enumValue<Value extends string>(
  value: unknown,
  values: readonly Value[],
  key: string,
  source: string,
): Value {
  if (typeof value !== "string" || !values.some((candidate) => candidate === value)) {
    failState(source, `field ${key} has unsupported value ${String(value)}`);
  }
  return value as Value;
}

function requiredEnum<Value extends string>(
  record: UnknownRecord,
  key: string,
  values: readonly Value[],
  source: string,
): Value {
  return enumValue(requiredValue(record, key, source), values, key, source);
}

function requiredReason(record: UnknownRecord, source: string): UsageUnavailableReason {
  return requiredEnum(record, "reason", USAGE_UNAVAILABLE_REASONS, source);
}

function optionalLabel(record: UnknownRecord, key: string, source: string): string | undefined {
  const value = optionalField(record, key);
  return value === undefined ? undefined : labelValue(value, key, source);
}

function optionalCount(record: UnknownRecord, key: string, source: string): number | undefined {
  const value = optionalField(record, key);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    failState(source, `field ${key} must be a non-negative integer`);
  }
  return value;
}

function parseIdentity(value: unknown, source: string): RequestWorkIdentity {
  const record = requiredRecord(value, source);
  assertExactKeys(record, IDENTITY_KEYS, source);
  const requestId = requiredLabel(record, "requestId", source);
  if (!isSafeRequestId(requestId)) failState(source, `unsafe request id ${requestId}`);
  const taskId = optionalLabel(record, "taskId", source);
  const jobId = optionalLabel(record, "jobId", source);
  const operationId = optionalLabel(record, "operationId", source);
  const role = optionalLabel(record, "role", source);
  const provider = optionalLabel(record, "provider", source);
  const model = optionalLabel(record, "model", source);
  const generation = optionalCount(record, "generation", source);
  const attempt = optionalCount(record, "attempt", source);
  return {
    requestId,
    ...(taskId === undefined ? {} : { taskId }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(generation === undefined ? {} : { generation }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(role === undefined ? {} : { role }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

function parseTokens(value: unknown, source: string): TokenMeasurement {
  const record = requiredRecord(value, source);
  const provenance = requiredEnum(
    record,
    "provenance",
    ["actual", "estimated", "unavailable"] as const,
    source,
  );
  if (provenance === "unavailable") {
    assertExactKeys(record, UNAVAILABLE_KEYS, source);
    return { provenance, reason: requiredReason(record, source) };
  }
  assertExactKeys(record, TOKEN_KEYS, source);
  const inputTokens = requiredInteger(record, "inputTokens", source);
  const outputTokens = requiredInteger(record, "outputTokens", source);
  if (provenance === "actual") return { provenance, inputTokens, outputTokens };
  return {
    provenance,
    inputTokens,
    outputTokens,
    method: requiredLabel(record, "method", source),
    source: requiredLabel(record, "source", source),
  };
}

function parseCharge(value: unknown, source: string): ChargeMeasurement {
  const record = requiredRecord(value, source);
  const provenance = requiredEnum(
    record,
    "provenance",
    ["actual", "estimated", "unavailable"] as const,
    source,
  );
  if (provenance === "unavailable") {
    assertExactKeys(record, UNAVAILABLE_KEYS, source);
    return { provenance, reason: requiredReason(record, source) };
  }
  assertExactKeys(record, CHARGE_KEYS, source);
  const currency = requiredEnum(record, "currency", ["USD"] as const, source);
  return {
    provenance,
    currency,
    amountMicros: requiredInteger(record, "amountMicros", source),
    pricingSource: requiredLabel(record, "pricingSource", source),
    pricingVersion: requiredInteger(record, "pricingVersion", source),
  };
}

function parseQuota(value: unknown, source: string): QuotaMeasurement {
  const record = requiredRecord(value, source);
  const provenance = requiredEnum(
    record,
    "provenance",
    ["actual", "estimated", "unavailable"] as const,
    source,
  );
  if (provenance === "unavailable") {
    assertExactKeys(record, UNAVAILABLE_KEYS, source);
    return { provenance, reason: requiredReason(record, source) };
  }
  assertExactKeys(record, QUOTA_KEYS, source);
  return {
    provenance,
    plan: requiredLabel(record, "plan", source),
    unit: requiredLabel(record, "unit", source),
    units: requiredInteger(record, "units", source),
  };
}
