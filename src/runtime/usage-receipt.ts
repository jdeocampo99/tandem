/**
 * Pure assembly of one request's receipt from its recorded accounting events.
 *
 * Elapsed time is measured only between the request's durable intake and its terminal delivery,
 * cancellation, or failure, so parallel workers can never add up to more wall time than actually
 * passed. Anything a provider or boundary did not report stays "unavailable": it is never summed
 * as zero, and it is never used to claim a saving.
 */

import type { IsoTimestamp } from "../contracts.ts";
import {
  type ChargeMeasurement,
  type QuotaMeasurement,
  REQUEST_WORK_KIND_ORDER,
  type RequestTerminalOutcome,
  type RequestUsageEvent,
  type RequestWorkKind,
  type TokenMeasurement,
} from "./usage.ts";

/**
 * How much of a request's own usage nobody priced or measured at all, as far as the ledger's own
 * samples show. `unaccountedSamples` is unpriced work no published price stands for and
 * `unmeasuredTokenSamples` is work that reported no tokens; either one means that part of the
 * request's usage is unknown rather than small, never zero.
 */
export type RequestUsageExposure = Readonly<{
  readonly unaccountedSamples: number;
  readonly unmeasuredTokenSamples: number;
}>;

export const REQUEST_RECEIPT_SCHEMA_VERSION = 1;

/** How many individual samples a receipt's expandable breakdown carries at most. */
export const MAX_RECEIPT_BREAKDOWN_SAMPLES = 50;

/**
 * Everything one request's accounting rows amount to, including the rows that could not be read.
 * A malformed row is counted rather than dropped silently, so a receipt can say how much of its
 * own history it could not account for.
 */
export type RequestUsageReadout = Readonly<{
  readonly events: readonly RequestUsageEvent[];
  readonly malformedEvents: number;
}>;

/** A duration in milliseconds, or the explicit marker when the interval could not be measured. */
export type ElapsedMillis = number | "unavailable";

/**
 * The request's wall-clock accounting. `elapsedMs` is intake-to-terminal wall time including every
 * research, interview, approval, queue, and recovery wait; `activeMs` is the union of the periods
 * some work was actually running, so `overlappingMs` is exactly the concurrency that must not
 * reach elapsed time.
 */
export type ReceiptTiming = Readonly<{
  readonly intakeAt: IsoTimestamp | "unavailable";
  readonly terminalAt: IsoTimestamp | "unavailable";
  readonly elapsedMs: ElapsedMillis;
  readonly activeMs: number;
  readonly overlappingMs: number;
  readonly waitingMs: ElapsedMillis;
}>;

/** Charges billed beyond any subscription, in integer USD micro-dollars. */
export type AdditionalCharges = Readonly<{
  readonly currency: "USD";
  readonly amountMicros: number;
  readonly actualSamples: number;
  readonly estimatedSamples: number;
  readonly unavailableSamples: number;
}>;

/** One subscription allowance drawn down, in the provider's own units and never in currency. */
export type IncludedQuotaTotal = Readonly<{
  readonly plan: string;
  readonly unit: string;
  readonly units: number;
  readonly actualSamples: number;
  readonly estimatedSamples: number;
}>;

export type IncludedQuota = Readonly<{
  readonly entries: readonly IncludedQuotaTotal[];
  readonly unavailableSamples: number;
}>;

export type TokenTotals = Readonly<{
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly unavailableSamples: number;
}>;

export type RequestWorkKindTotal = Readonly<{
  readonly workKind: RequestWorkKind;
  readonly sampleCount: number;
  readonly activeMs: number;
  readonly overlappingMs: number;
  readonly retries: number;
  readonly failures: number;
  readonly tokens: TokenTotals;
  readonly charges: AdditionalCharges;
  readonly quota: IncludedQuota;
}>;

export type ProviderSampleTotal = Readonly<{
  readonly provider: string;
  readonly model: string;
  readonly sampleCount: number;
  readonly timedOutSamples: number;
  readonly tokens: TokenTotals;
  readonly charges: AdditionalCharges;
}>;

/**
 * The expandable half of a receipt. `samples` is bounded; `omittedSamples`, `duplicateSamples`,
 * and `malformedSamples` keep what is not shown visible as a count.
 */
export type RequestUsageBreakdown = Readonly<{
  readonly byWorkKind: readonly RequestWorkKindTotal[];
  readonly byProvider: readonly ProviderSampleTotal[];
  readonly samples: readonly RequestUsageEvent[];
  readonly omittedSamples: number;
  readonly duplicateSamples: number;
  readonly malformedSamples: number;
}>;

/** What the request is now: settled with an outcome, or still in flight. */
export type RequestReceiptStatus = RequestTerminalOutcome | "open";

export type RequestUsageReceipt = Readonly<{
  readonly schemaVersion: typeof REQUEST_RECEIPT_SCHEMA_VERSION;
  readonly requestId: string;
  readonly status: RequestReceiptStatus;
  readonly timing: ReceiptTiming;
  readonly charges: AdditionalCharges;
  readonly quota: IncludedQuota;
  readonly tokens: TokenTotals;
  readonly breakdown: RequestUsageBreakdown;
  /** The coordinator's usage over this request's window; shared with any request open alongside. */
  readonly coordinator?: CoordinatorShare;
  /** The request's goal, so a receipt says which request it is. */
  readonly goal?: string;
  /** When an open request was measured; absent once the request has ended. */
  readonly asOf?: IsoTimestamp;
}>;

/** One coordinator model reply, as the coordinator extension records it. */
export type CoordinatorUsageEntry = Readonly<{
  readonly at: IsoTimestamp;
  readonly repoPath: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}>;

export type CoordinatorShare = Readonly<{
  readonly replies: number;
  readonly tokens: number;
  readonly costMicros: number;
}>;

/**
 * The coordinator replies in this repository between the request's intake and its end (or now,
 * while it is open). Other requests open over the same window share these replies, which is why a
 * receipt shows them apart and never adds them to the request's own total.
 */
export function coordinatorShare(
  entries: readonly unknown[],
  repoPath: string,
  from: IsoTimestamp,
  to: IsoTimestamp,
): CoordinatorShare {
  let replies = 0;
  let tokens = 0;
  let costUsd = 0;
  for (const entry of entries) {
    if (!isCoordinatorUsageEntry(entry)) continue;
    if (entry.repoPath !== repoPath || entry.at < from || entry.at > to) continue;
    replies += 1;
    tokens += entry.inputTokens + entry.outputTokens;
    costUsd += entry.costUsd;
  }
  return { replies, tokens, costMicros: Math.round(costUsd * 1_000_000) };
}

function isCoordinatorUsageEntry(value: unknown): value is CoordinatorUsageEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.at === "string" &&
    typeof entry.repoPath === "string" &&
    [entry.inputTokens, entry.outputTokens, entry.costUsd].every(
      (count) => typeof count === "number" && Number.isFinite(count) && count >= 0,
    )
  );
}

const RECEIPT_STAGE_LABELS: Readonly<Record<RequestWorkKind, string>> = {
  coordinator: "Coordinator",
  research: "Research",
  implementation: "Implementation",
  review: "Review",
  validation: "Validation",
  verification: "Verification",
  presentation: "Presentation",
};

/**
 * The receipt as a boxed table: one row per stage with its working time, new tokens, and OMP's
 * estimated list-price cost, and a total row for the request's own work, followed by short notes.
 * The total time is time spent working; the wall-clock span and the coordinator's shared cost go in
 * the notes. A figure that was never measured shows as a dash, never zero.
 */
export function renderRequestReceiptTable(receipt: RequestUsageReceipt): string {
  const rows: ReceiptRow[] = [];
  for (const stage of receipt.breakdown.byWorkKind) {
    if (stage.workKind === "coordinator") continue;
    const runs = stage.sampleCount > 1 ? ` ×${stage.sampleCount}` : "";
    rows.push({
      stage: `${RECEIPT_STAGE_LABELS[stage.workKind]}${runs}`,
      time: formatDuration(stage.activeMs),
      tokens: measuredTokens(stage.tokens),
      cost: measuredCost(stage.charges),
    });
  }
  const { timing } = receipt;
  const open = timing.elapsedMs === "unavailable";
  const total: ReceiptRow = {
    stage: open ? "So far" : "Total",
    time: formatDuration(timing.activeMs),
    tokens: measuredTokens(receipt.tokens),
    cost: measuredCost(receipt.charges),
  };
  const sinceIntake =
    receipt.asOf === undefined || timing.intakeAt === "unavailable"
      ? undefined
      : Date.parse(receipt.asOf) - Date.parse(timing.intakeAt);
  const coordinator = receipt.coordinator;

  const notes = [
    ...(typeof timing.elapsedMs === "number" && typeof timing.waitingMs === "number"
      ? [
          `${formatDuration(timing.elapsedMs)} from plan to finish, ${formatDuration(timing.waitingMs)} of it waiting on you or idle.`,
        ]
      : []),
    ...(open && sinceIntake !== undefined && Number.isFinite(sinceIntake)
      ? [`${formatDuration(sinceIntake)} since the plan was written.`]
      : []),
    ...(open ? ["Still open: work running now is added when it finishes."] : []),
    ...(coordinator !== undefined && coordinator.replies > 0
      ? [
          `Our conversation over the same period cost about ${formatDollars(coordinator.costMicros)}, shared with other requests.`,
        ]
      : []),
    "Costs are OMP's list-price estimates, not what a subscription is billed.",
  ];
  return [
    ...(receipt.goal === undefined ? [] : [receipt.goal, ""]),
    ...boxedTable([RECEIPT_HEADER, ...rows], total),
    ...notes,
  ].join("\n");
}

type ReceiptRow = Readonly<{ stage: string; time: string; tokens: string; cost: string }>;

const RECEIPT_HEADER: ReceiptRow = {
  stage: "Stage",
  time: "Time",
  tokens: "New tokens",
  cost: "Est. cost",
};

const RECEIPT_COLUMNS = ["stage", "time", "tokens", "cost"] as const;

/** Draws rows in a rounded box, with the header and the total set off by rules. */
function boxedTable(rows: readonly ReceiptRow[], total: ReceiptRow): readonly string[] {
  const all = [...rows, total];
  const widths = RECEIPT_COLUMNS.map((column) => Math.max(...all.map((row) => row[column].length)));
  const rule = (left: string, middle: string, right: string): string =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
  const line = (row: ReceiptRow): string =>
    `│${RECEIPT_COLUMNS.map((column, index) => {
      const width = widths[index] ?? 0;
      // The stage reads left to right; the figures line up on the right.
      const cell = index === 0 ? row[column].padEnd(width) : row[column].padStart(width);
      return ` ${cell} `;
    }).join("│")}│`;
  const [header, ...body] = rows;
  return [
    rule("╭", "┬", "╮"),
    ...(header === undefined ? [] : [line(header)]),
    rule("├", "┼", "┤"),
    ...body.map(line),
    rule("├", "┼", "┤"),
    line(total),
    rule("╰", "┴", "╯"),
  ];
}

function measuredTokens(tokens: TokenTotals): string {
  const measured = tokens.actualInputTokens + tokens.actualOutputTokens;
  return measured === 0 && tokens.unavailableSamples > 0 ? "—" : formatTokens(measured);
}

function measuredCost(charges: AdditionalCharges): string {
  return charges.actualSamples + charges.estimatedSamples === 0
    ? "—"
    : formatDollars(charges.amountMicros);
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function formatDollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

type MillisInterval = Readonly<{ readonly startMs: number; readonly endMs: number }>;

type MutableTokenTotals = {
  actualInputTokens: number;
  actualOutputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  unavailableSamples: number;
};

type MutableCharges = {
  amountMicros: number;
  actualSamples: number;
  estimatedSamples: number;
  unavailableSamples: number;
};

type MutableQuotaTotal = {
  plan: string;
  unit: string;
  units: number;
  actualSamples: number;
  estimatedSamples: number;
};

type MutableQuota = {
  entries: Map<string, MutableQuotaTotal>;
  unavailableSamples: number;
};

type MutableWorkKindTotal = {
  workKind: RequestWorkKind;
  sampleCount: number;
  retries: number;
  failures: number;
  intervals: MillisInterval[];
  tokens: MutableTokenTotals;
  charges: MutableCharges;
  quota: MutableQuota;
};

type MutableProviderTotal = {
  provider: string;
  model: string;
  sampleCount: number;
  timedOutSamples: number;
  tokens: MutableTokenTotals;
  charges: MutableCharges;
};

const FAILED_WORK_STATUSES: readonly RequestUsageEvent["status"][] = [
  "failed",
  "timed-out",
  "quarantined",
];

const QUOTA_KEY_SEPARATOR = " ";

function millisOf(timestamp: IsoTimestamp): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function intervalOf(event: RequestUsageEvent): MillisInterval | undefined {
  const startMs = millisOf(event.startedAt);
  const endMs = millisOf(event.endedAt);
  if (startMs === undefined || endMs === undefined || endMs < startMs) return undefined;
  return { startMs, endMs };
}

/**
 * Trims an interval to the request's own window. A late cost receipt observed after delivery is
 * still counted as a charge, but the time it took cannot extend the recorded delivery time.
 */
function clampedInterval(interval: MillisInterval, window: MillisInterval): MillisInterval {
  const startMs = Math.min(Math.max(interval.startMs, window.startMs), window.endMs);
  const endMs = Math.min(Math.max(interval.endMs, window.startMs), window.endMs);
  return { startMs, endMs };
}

/** The length of the union of the intervals, so concurrent work is counted once. */
function unionMillis(intervals: readonly MillisInterval[]): number {
  const ordered = [...intervals].sort((left, right) => left.startMs - right.startMs);
  let total = 0;
  let openStart: number | undefined;
  let openEnd = 0;
  for (const interval of ordered) {
    if (openStart === undefined) {
      openStart = interval.startMs;
      openEnd = interval.endMs;
      continue;
    }
    if (interval.startMs > openEnd) {
      total += openEnd - openStart;
      openStart = interval.startMs;
      openEnd = interval.endMs;
      continue;
    }
    openEnd = Math.max(openEnd, interval.endMs);
  }
  return openStart === undefined ? total : total + (openEnd - openStart);
}

function sumMillis(intervals: readonly MillisInterval[]): number {
  return intervals.reduce((total, interval) => total + (interval.endMs - interval.startMs), 0);
}

function newTokenTotals(): MutableTokenTotals {
  return {
    actualInputTokens: 0,
    actualOutputTokens: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    unavailableSamples: 0,
  };
}

function newCharges(): MutableCharges {
  return { amountMicros: 0, actualSamples: 0, estimatedSamples: 0, unavailableSamples: 0 };
}

function newQuota(): MutableQuota {
  return { entries: new Map(), unavailableSamples: 0 };
}

function addTokens(totals: MutableTokenTotals, measurement: TokenMeasurement): void {
  if (measurement.provenance === "unavailable") {
    totals.unavailableSamples += 1;
    return;
  }
  if (measurement.provenance === "actual") {
    totals.actualInputTokens += measurement.inputTokens;
    totals.actualOutputTokens += measurement.outputTokens;
    return;
  }
  totals.estimatedInputTokens += measurement.inputTokens;
  totals.estimatedOutputTokens += measurement.outputTokens;
}

function addCharge(charges: MutableCharges, measurement: ChargeMeasurement): void {
  if (measurement.provenance === "unavailable") {
    charges.unavailableSamples += 1;
    return;
  }
  charges.amountMicros += measurement.amountMicros;
  if (measurement.provenance === "actual") charges.actualSamples += 1;
  else charges.estimatedSamples += 1;
}

function addQuota(quota: MutableQuota, measurement: QuotaMeasurement): void {
  if (measurement.provenance === "unavailable") {
    quota.unavailableSamples += 1;
    return;
  }
  const key = `${measurement.plan}${QUOTA_KEY_SEPARATOR}${measurement.unit}`;
  const entry = quota.entries.get(key) ?? {
    plan: measurement.plan,
    unit: measurement.unit,
    units: 0,
    actualSamples: 0,
    estimatedSamples: 0,
  };
  entry.units += measurement.units;
  if (measurement.provenance === "actual") entry.actualSamples += 1;
  else entry.estimatedSamples += 1;
  quota.entries.set(key, entry);
}

function tokenTotals(totals: MutableTokenTotals): TokenTotals {
  return { ...totals };
}

function chargeTotals(charges: MutableCharges): AdditionalCharges {
  return { currency: "USD", ...charges };
}

function quotaTotals(quota: MutableQuota): IncludedQuota {
  return {
    entries: Array.from(quota.entries.values()).map((entry) => ({ ...entry })),
    unavailableSamples: quota.unavailableSamples,
  };
}

/** Drops rows the ledger could have handed over twice, and says how many it dropped. */
function distinctEvents(
  events: readonly RequestUsageEvent[],
): Readonly<{ readonly events: readonly RequestUsageEvent[]; readonly duplicates: number }> {
  const seen = new Set<string>();
  const distinct: RequestUsageEvent[] = [];
  for (const event of events) {
    if (seen.has(event.eventKey)) continue;
    seen.add(event.eventKey);
    distinct.push(event);
  }
  return { events: distinct, duplicates: events.length - distinct.length };
}

function earliestPoint(
  events: readonly RequestUsageEvent[],
  kind: RequestUsageEvent["kind"],
): RequestUsageEvent | undefined {
  return events
    .filter((event) => event.kind === kind)
    .reduce<RequestUsageEvent | undefined>(
      (earliest, event) =>
        earliest === undefined || event.startedAt < earliest.startedAt ? event : earliest,
      undefined,
    );
}

function latestPoint(
  events: readonly RequestUsageEvent[],
  kind: RequestUsageEvent["kind"],
): RequestUsageEvent | undefined {
  return events
    .filter((event) => event.kind === kind)
    .reduce<RequestUsageEvent | undefined>(
      (latest, event) => (latest === undefined || event.endedAt > latest.endedAt ? event : latest),
      undefined,
    );
}

function accountedIntervals(
  events: readonly RequestUsageEvent[],
  window: MillisInterval | undefined,
): readonly MillisInterval[] {
  const intervals: MillisInterval[] = [];
  for (const event of events) {
    const interval = intervalOf(event);
    if (interval === undefined) continue;
    intervals.push(window === undefined ? interval : clampedInterval(interval, window));
  }
  return intervals;
}

function receiptTiming(
  events: readonly RequestUsageEvent[],
  accountable: readonly RequestUsageEvent[],
): ReceiptTiming {
  const intake = earliestPoint(events, "intake");
  const terminal = latestPoint(events, "terminal");
  const intakeMs = intake === undefined ? undefined : millisOf(intake.startedAt);
  const terminalMs = terminal === undefined ? undefined : millisOf(terminal.endedAt);
  const window =
    intakeMs === undefined || terminalMs === undefined || terminalMs < intakeMs
      ? undefined
      : { startMs: intakeMs, endMs: terminalMs };
  const intervals = accountedIntervals(accountable, window);
  const activeMs = unionMillis(intervals);
  const elapsedMs: ElapsedMillis =
    window === undefined ? "unavailable" : window.endMs - window.startMs;
  return {
    intakeAt: intake === undefined ? "unavailable" : intake.startedAt,
    terminalAt: terminal === undefined ? "unavailable" : terminal.endedAt,
    elapsedMs,
    activeMs,
    overlappingMs: Math.max(0, sumMillis(intervals) - activeMs),
    waitingMs: elapsedMs === "unavailable" ? "unavailable" : Math.max(0, elapsedMs - activeMs),
  };
}

function workKindTotals(
  accountable: readonly RequestUsageEvent[],
): readonly RequestWorkKindTotal[] {
  const groups = new Map<RequestWorkKind, MutableWorkKindTotal>();
  for (const event of accountable) {
    const group = groups.get(event.workKind) ?? {
      workKind: event.workKind,
      sampleCount: 0,
      retries: 0,
      failures: 0,
      intervals: [],
      tokens: newTokenTotals(),
      charges: newCharges(),
      quota: newQuota(),
    };
    group.sampleCount += 1;
    if ((event.identity.attempt ?? 1) > 1) group.retries += 1;
    if (FAILED_WORK_STATUSES.includes(event.status)) group.failures += 1;
    const interval = intervalOf(event);
    if (interval !== undefined) group.intervals.push(interval);
    addTokens(group.tokens, event.tokens);
    addCharge(group.charges, event.charge);
    addQuota(group.quota, event.quota);
    groups.set(event.workKind, group);
  }
  return REQUEST_WORK_KIND_ORDER.flatMap((workKind) => {
    const group = groups.get(workKind);
    if (group === undefined) return [];
    const activeMs = unionMillis(group.intervals);
    return [
      {
        workKind,
        sampleCount: group.sampleCount,
        activeMs,
        overlappingMs: Math.max(0, sumMillis(group.intervals) - activeMs),
        retries: group.retries,
        failures: group.failures,
        tokens: tokenTotals(group.tokens),
        charges: chargeTotals(group.charges),
        quota: quotaTotals(group.quota),
      },
    ];
  });
}

function providerTotals(accountable: readonly RequestUsageEvent[]): readonly ProviderSampleTotal[] {
  const groups = new Map<string, MutableProviderTotal>();
  for (const event of accountable) {
    if (event.kind !== "provider-sample") continue;
    const provider = event.identity.provider ?? "unknown";
    const model = event.identity.model ?? "unknown";
    const key = `${provider}${QUOTA_KEY_SEPARATOR}${model}`;
    const group = groups.get(key) ?? {
      provider,
      model,
      sampleCount: 0,
      timedOutSamples: 0,
      tokens: newTokenTotals(),
      charges: newCharges(),
    };
    group.sampleCount += 1;
    if (event.status === "timed-out") group.timedOutSamples += 1;
    addTokens(group.tokens, event.tokens);
    addCharge(group.charges, event.charge);
    groups.set(key, group);
  }
  return Array.from(groups.values()).map((group) => ({
    provider: group.provider,
    model: group.model,
    sampleCount: group.sampleCount,
    timedOutSamples: group.timedOutSamples,
    tokens: tokenTotals(group.tokens),
    charges: chargeTotals(group.charges),
  }));
}

/**
 * Builds the compact receipt and its expandable breakdown from recorded events alone. It is a
 * report: it decides nothing about whether more work may run, and it never fails because the
 * telemetry behind an event was missing, stale, or malformed.
 */
export function buildRequestUsageReceipt(
  requestId: string,
  readout: RequestUsageReadout,
): RequestUsageReceipt {
  const { events, duplicates } = distinctEvents(readout.events);
  const ordered = [...events].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const accountable = ordered.filter(
    (event) => event.kind === "work" || event.kind === "provider-sample",
  );
  const tokens = newTokenTotals();
  const charges = newCharges();
  const quota = newQuota();
  for (const event of accountable) {
    addTokens(tokens, event.tokens);
    addCharge(charges, event.charge);
    addQuota(quota, event.quota);
  }
  const terminal = latestPoint(ordered, "terminal");
  return {
    schemaVersion: REQUEST_RECEIPT_SCHEMA_VERSION,
    requestId,
    status: terminal?.outcome ?? "open",
    timing: receiptTiming(ordered, accountable),
    charges: chargeTotals(charges),
    quota: quotaTotals(quota),
    tokens: tokenTotals(tokens),
    breakdown: {
      byWorkKind: workKindTotals(accountable),
      byProvider: providerTotals(accountable),
      samples: accountable.slice(-MAX_RECEIPT_BREAKDOWN_SAMPLES),
      omittedSamples: Math.max(0, accountable.length - MAX_RECEIPT_BREAKDOWN_SAMPLES),
      duplicateSamples: duplicates,
      malformedSamples: readout.malformedEvents,
    },
  };
}

/**
 * How much of a request's usage nobody priced or measured, read straight from its own accounting
 * events rather than the receipt's summed totals. An unpriced sample carrying an operation
 * identity counts once per operation; a sample with none counts on its own, since nothing else
 * could ever stand for its cost. Only the samples a receipt itself accounts for are inspected: the
 * intake and terminal markers carry no provider boundary by construction.
 */
export function requestUsageExposure(readout: RequestUsageReadout): RequestUsageExposure {
  const unpricedOperationIds = new Set<string>();
  let unattributedUnpricedSamples = 0;
  let unmeasuredTokenSamples = 0;
  for (const event of distinctEvents(readout.events).events) {
    if (event.kind !== "work" && event.kind !== "provider-sample") continue;
    if (event.tokens.provenance === "unavailable") unmeasuredTokenSamples += 1;
    if (event.charge.provenance !== "unavailable") continue;
    const operationId = event.identity.operationId;
    if (operationId === undefined) unattributedUnpricedSamples += 1;
    else unpricedOperationIds.add(operationId);
  }
  return {
    unaccountedSamples: unattributedUnpricedSamples + unpricedOperationIds.size,
    unmeasuredTokenSamples,
  };
}
