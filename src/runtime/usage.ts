/**
 * Bounded usage telemetry and the request-scoped accounting ledger's schema.
 *
 * This module is the single source for the usage record shape, pricing data, cost
 * calculation, cross-run aggregation, and the durable accounting event that request
 * receipts are rebuilt from. Missing provider usage is always the literal "unavailable",
 * never zero, so a report can tell "no tokens reported" apart from "zero tokens used".
 * Cost figures produced here are informational only; nothing in this module authorizes,
 * pauses, retries, or blocks work.
 */

import { createHash } from "node:crypto";
import type { IsoTimestamp } from "../contracts.ts";

export const USAGE_RECORD_SCHEMA_VERSION = 1;

export const REQUEST_USAGE_EVENT_SCHEMA_VERSION = 1;

/** USD is accounted in integer micro-dollars so a receipt's totals never drift when summed. */
export const USD_MICROS_PER_DOLLAR = 1_000_000;

/** A reported token count, or the explicit marker used when a provider did not report one. */
export type TokenCount = number | "unavailable";

export type PricingSnapshot = Readonly<{
  readonly schemaVersion: number;
  readonly source: string;
  readonly effectiveDate: string;
  readonly currency: "USD";
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
}>;

/** TypeSafe's published Jev rate as of 2026-09-20 (https://docs.typesafe.ai/pricing): output is free. */
export const JEV_PRICING_SNAPSHOT: PricingSnapshot = {
  schemaVersion: 1,
  source: "typesafe-jev-published-rate",
  effectiveDate: "2026-09-20",
  currency: "USD",
  inputPerMillionTokens: 0.042,
  outputPerMillionTokens: 0,
};

export type UsageRecord = Readonly<{
  readonly schemaVersion: typeof USAGE_RECORD_SCHEMA_VERSION;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly reason: string;
  readonly pricing: PricingSnapshot | "unavailable";
}>;

export type UsageCost = Readonly<{
  readonly currency: "USD";
  readonly amount: number;
  readonly pricingVersion: number;
  readonly pricingSource: string;
}>;

/** Grouping tags for one usage sample. Each is optional; an absent tag aggregates as "unknown". */
export type UsageContext = Readonly<{
  readonly fixture?: string;
  readonly role?: string;
  readonly taskId?: string;
  readonly runId?: string;
}>;

export type TaggedUsageRecord = Readonly<{
  readonly context: UsageContext;
  readonly usage: UsageRecord;
}>;

export type UsageAggregateKey = Readonly<{
  readonly fixture: string;
  readonly role: string;
  readonly taskId: string;
  readonly runId: string;
}>;

export type UsageAggregate = Readonly<{
  readonly key: UsageAggregateKey;
  readonly sampleCount: number;
  readonly knownInputTokens: number;
  readonly knownOutputTokens: number;
  readonly unavailableInputSamples: number;
  readonly unavailableOutputSamples: number;
  readonly timedOutSamples: number;
  readonly totalDurationMs: number;
  readonly knownCost: number;
  readonly costUnavailableSamples: number;
}>;

/** The kinds of work a request receipt accounts for, in the order a breakdown lists them. */
export const REQUEST_WORK_KIND_ORDER = [
  "coordinator",
  "research",
  "implementation",
  "review",
  "validation",
  // ponytail: legacy usage events recorded before the verifier role was removed may still carry
  // this work kind; no new event is ever recorded with it.
  "verification",
  "presentation",
] as const;

export type RequestWorkKind = (typeof REQUEST_WORK_KIND_ORDER)[number];

/**
 * What an accounting event is. `work` spans a settled unit of durable work, `provider-sample`
 * carries one provider call's reported usage, and the two point events mark the wall-clock
 * window a receipt's elapsed time is measured over.
 */
export const REQUEST_USAGE_EVENT_KINDS = ["intake", "work", "provider-sample", "terminal"] as const;

export type RequestUsageEventKind = (typeof REQUEST_USAGE_EVENT_KINDS)[number];

/** How a unit of accounted work ended. Bounded by construction so no error text is recorded. */
export const REQUEST_WORK_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed-out",
  "quarantined",
  "observed",
] as const;

export type RequestWorkStatus = (typeof REQUEST_WORK_STATUSES)[number];

/** How a request stopped being in flight. A later human merge is not one of these. */
export const REQUEST_TERMINAL_OUTCOMES = ["delivered", "cancelled", "failed"] as const;

export type RequestTerminalOutcome = (typeof REQUEST_TERMINAL_OUTCOMES)[number];

/** Where a recorded number came from. An estimate always names the method that produced it. */
export type UsageProvenance = "actual" | "estimated" | "unavailable";

/**
 * Why a number could not be observed. The set is closed so an unavailable marker can never
 * carry a prompt, payload, credential, repository content, or full action error.
 */
export const USAGE_UNAVAILABLE_REASONS = [
  "provider-did-not-report",
  "no-provider-boundary",
  "provider-unavailable",
  "no-pricing-basis",
  "no-quota-contract",
  "malformed-telemetry",
] as const;

export type UsageUnavailableReason = (typeof USAGE_UNAVAILABLE_REASONS)[number];

export type TokenMeasurement =
  | Readonly<{
      readonly provenance: "actual";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }>
  | Readonly<{
      readonly provenance: "estimated";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly method: string;
      readonly source: string;
    }>
  | Readonly<{
      readonly provenance: "unavailable";
      readonly reason: UsageUnavailableReason;
    }>;

/** What a sample bills beyond any subscription, in integer USD micro-dollars. */
export type ChargeMeasurement =
  | Readonly<{
      readonly provenance: "actual" | "estimated";
      readonly currency: "USD";
      readonly amountMicros: number;
      readonly pricingSource: string;
      readonly pricingVersion: number;
    }>
  | Readonly<{
      readonly provenance: "unavailable";
      readonly reason: UsageUnavailableReason;
    }>;

/**
 * What a sample drew from a subscription's included allowance, in the provider's own units.
 * Included consumption never carries a currency: turning it into dollars would invent a charge
 * the provider never billed.
 */
export type QuotaMeasurement =
  | Readonly<{
      readonly provenance: "actual" | "estimated";
      readonly plan: string;
      readonly unit: string;
      readonly units: number;
    }>
  | Readonly<{
      readonly provenance: "unavailable";
      readonly reason: UsageUnavailableReason;
    }>;

/**
 * The durable identities one accounting event is attributed to. Every field but the scope is
 * optional because a boundary that never exposed an identity must stay silent about it rather
 * than have one inferred from process observations or text. The scope is the governing request,
 * or, for work no request governs, the task alone: an event without `requestId` always names its
 * `taskId` and is kept in that task's own ledger scope, never on a request's receipt.
 */
export type RequestWorkIdentity = Readonly<{
  readonly requestId?: string;
  readonly taskId?: string;
  readonly jobId?: string;
  readonly operationId?: string;
  readonly generation?: number;
  readonly attempt?: number;
  readonly role?: string;
  readonly provider?: string;
  readonly model?: string;
}>;

/** What makes two events of the same kind and identity distinct, such as an attempt or digest. */
export type RequestUsageEventOrigin = Readonly<{
  readonly kind: RequestUsageEventKind;
  readonly identity: RequestWorkIdentity;
  readonly discriminator: string;
}>;

/**
 * One immutable accounting fact. `startedAt` equals `endedAt` on the point events. Replaying an
 * event that was already recorded is a no-op because `eventKey` is derived from the identity
 * the emitter observed, not from when it was observed.
 */
export type RequestUsageEvent = Readonly<{
  readonly schemaVersion: typeof REQUEST_USAGE_EVENT_SCHEMA_VERSION;
  readonly eventKey: string;
  readonly kind: RequestUsageEventKind;
  readonly workKind: RequestWorkKind;
  readonly identity: RequestWorkIdentity;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly status: RequestWorkStatus;
  readonly tokens: TokenMeasurement;
  readonly charge: ChargeMeasurement;
  readonly quota: QuotaMeasurement;
  /** Present only on a terminal event. */
  readonly outcome?: RequestTerminalOutcome;
}>;

/**
 * Pure cost estimate for informational reporting only. `pricing` is an explicit input
 * rather than read off a `UsageRecord` so callers can re-price recorded usage under a
 * different, later pricing snapshot.
 */
export function calculateUsageCost(
  tokens: Readonly<{ readonly inputTokens: TokenCount; readonly outputTokens: TokenCount }>,
  pricing: PricingSnapshot | "unavailable",
): UsageCost | "unavailable" {
  if (pricing === "unavailable") return "unavailable";
  if (tokens.inputTokens === "unavailable" || tokens.outputTokens === "unavailable") {
    return "unavailable";
  }
  const amount =
    (tokens.inputTokens / 1_000_000) * pricing.inputPerMillionTokens +
    (tokens.outputTokens / 1_000_000) * pricing.outputPerMillionTokens;
  return {
    currency: pricing.currency,
    amount,
    pricingVersion: pricing.schemaVersion,
    pricingSource: pricing.source,
  };
}

/**
 * The same cost in integer micro-dollars, which is what a ledger sums. Rounding once here keeps
 * a receipt's total independent of the order its samples were recorded in.
 */
export function chargeMicrosForTokens(
  tokens: Readonly<{ readonly inputTokens: TokenCount; readonly outputTokens: TokenCount }>,
  pricing: PricingSnapshot | "unavailable",
): number | "unavailable" {
  const cost = calculateUsageCost(tokens, pricing);
  return cost === "unavailable" ? "unavailable" : Math.round(cost.amount * USD_MICROS_PER_DOLLAR);
}

/**
 * The stable identity a ledger deduplicates on. A distinct attempt carries a distinct attempt or
 * operation identity and so keys differently, while replaying the same observed receipt after a
 * restart, reconciliation, or compaction reproduces the same key and is counted once.
 */
export function requestUsageEventKey(origin: RequestUsageEventOrigin): string {
  const canonical = JSON.stringify([
    REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    origin.kind,
    origin.identity.requestId ?? null,
    origin.identity.taskId ?? null,
    origin.identity.jobId ?? null,
    origin.identity.operationId ?? null,
    origin.identity.generation ?? null,
    origin.identity.attempt ?? null,
    origin.identity.role ?? null,
    origin.identity.provider ?? null,
    origin.identity.model ?? null,
    origin.discriminator,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Groups usage samples by fixture, role, task, and run. A tag missing from a sample's
 * context becomes the explicit "unknown" bucket rather than being dropped or merged with
 * unrelated samples, and unavailable token/cost samples are counted rather than treated as
 * zero, so a report never understates how much usage it could not observe.
 */
export function aggregateUsage(samples: readonly TaggedUsageRecord[]): readonly UsageAggregate[] {
  const groups = new Map<string, MutableUsageAggregate>();
  for (const sample of samples) {
    const key = aggregateKeyFor(sample.context);
    const id = aggregateGroupId(key);
    const group = groups.get(id) ?? newAggregate(key);
    addSample(group, sample);
    groups.set(id, group);
  }
  return Array.from(groups.values());
}

type MutableUsageAggregate = {
  key: UsageAggregateKey;
  sampleCount: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  unavailableInputSamples: number;
  unavailableOutputSamples: number;
  timedOutSamples: number;
  totalDurationMs: number;
  knownCost: number;
  costUnavailableSamples: number;
};

const UNKNOWN_USAGE_TAG = "unknown";
const AGGREGATE_KEY_SEPARATOR = " ";

function tagOrUnknown(value: string | undefined): string {
  return value === undefined || value.length === 0 ? UNKNOWN_USAGE_TAG : value;
}

function aggregateKeyFor(context: UsageContext): UsageAggregateKey {
  return {
    fixture: tagOrUnknown(context.fixture),
    role: tagOrUnknown(context.role),
    taskId: tagOrUnknown(context.taskId),
    runId: tagOrUnknown(context.runId),
  };
}

function aggregateGroupId(key: UsageAggregateKey): string {
  return [key.fixture, key.role, key.taskId, key.runId].join(AGGREGATE_KEY_SEPARATOR);
}

function newAggregate(key: UsageAggregateKey): MutableUsageAggregate {
  return {
    key,
    sampleCount: 0,
    knownInputTokens: 0,
    knownOutputTokens: 0,
    unavailableInputSamples: 0,
    unavailableOutputSamples: 0,
    timedOutSamples: 0,
    totalDurationMs: 0,
    knownCost: 0,
    costUnavailableSamples: 0,
  };
}

function addSample(group: MutableUsageAggregate, sample: TaggedUsageRecord): void {
  group.sampleCount += 1;
  group.totalDurationMs += sample.usage.durationMs;
  if (sample.usage.timedOut) group.timedOutSamples += 1;
  if (typeof sample.usage.inputTokens === "number") {
    group.knownInputTokens += sample.usage.inputTokens;
  } else {
    group.unavailableInputSamples += 1;
  }
  if (typeof sample.usage.outputTokens === "number") {
    group.knownOutputTokens += sample.usage.outputTokens;
  } else {
    group.unavailableOutputSamples += 1;
  }
  const cost = calculateUsageCost(sample.usage, sample.usage.pricing);
  if (cost === "unavailable") {
    group.costUnavailableSamples += 1;
  } else {
    group.knownCost += cost.amount;
  }
}
