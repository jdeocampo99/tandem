import type { IsoTimestamp } from "../contracts.ts";
import { calendarDate } from "../memory/workstream.ts";
import type { RequestUsageEvent, RequestWorkKind } from "./usage.ts";
import { type UsageDisplay, usageDisplay } from "./usage-display.ts";
import {
  buildRequestUsageReceipt,
  type RequestUsageReadout,
  type RequestUsageReceipt,
} from "./usage-receipt.ts";

/** Sanitized provider windows. Credentials and provider raw payloads never cross this boundary. */
export type AccountLimit = Readonly<{
  provider: string;
  account: string;
  window: "five-hour" | "weekly";
  label: string;
  remainingPercent: number | "unavailable";
  resetsAt?: IsoTimestamp;
  fetchedAt: IsoTimestamp;
}>;
export type LimitMeter = AccountLimit & Readonly<{ resetInMs: number | "unavailable" }>;
export type UsageTotals = Readonly<{
  costMicros: number;
  unpricedSamples: number;
  agentMs: number;
  tasksDone: number;
}>;
export type UsageView = Readonly<{
  display?: UsageDisplay;
  limits: readonly LimitMeter[];
  today: UsageTotals;
  week: UsageTotals;
  byModel: readonly Readonly<{
    provider: string;
    model: string;
    today: UsageTotals;
    week: UsageTotals;
  }>[];
  byStage: readonly Readonly<{ stage: RequestWorkKind; todayMs: number; weekMs: number }>[];
  malformedEvents: number;
}>;

export function limitMeter(limit: AccountLimit, now: IsoTimestamp): LimitMeter {
  const reset = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt);
  return {
    ...limit,
    resetInMs: Number.isFinite(reset) ? Math.max(0, reset - Date.parse(now)) : "unavailable",
  };
}

/** Duplicate ledger scopes are counted once; unpriced usage stays visible beside the known floor. */
export function usageView(
  input: Readonly<{
    now: IsoTimestamp;
    todayStart: IsoTimestamp;
    weekStart: IsoTimestamp;
    limits: readonly AccountLimit[];
    readout: RequestUsageReadout;
    finished: readonly Readonly<{ taskId: string; at: IsoTimestamp }>[];
  }>,
): UsageView {
  const events = [
    ...new Map(input.readout.events.map((event) => [usageSpanKey(event), event])).values(),
  ];
  const inWindow = (event: RequestUsageEvent, start: string) =>
    event.endedAt >= start && event.endedAt <= input.now;
  const today = events.filter((event) => inWindow(event, input.todayStart));
  const week = events.filter((event) => inWindow(event, input.weekStart));
  const done = (start: string) =>
    new Set(
      input.finished
        .filter((entry) => entry.at >= start && entry.at <= input.now)
        .map((entry) => entry.taskId),
    ).size;
  const modelKeys = new Map(
    week.filter(accountable).map((event) => {
      const provider = event.identity.provider ?? "unknown";
      const model = event.identity.model ?? "unknown";
      return [JSON.stringify([provider, model]), { provider, model }];
    }),
  );
  const view: UsageView = {
    limits: input.limits.map((limit) => limitMeter(limit, input.now)),
    today: { ...totals(today, input.todayStart, input.now), tasksDone: done(input.todayStart) },
    week: { ...totals(week, input.weekStart, input.now), tasksDone: done(input.weekStart) },
    byModel: [...modelKeys.values()]
      .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
      .map(({ provider, model }) => {
        const matches = (event: RequestUsageEvent) =>
          (event.identity.provider ?? "unknown") === provider &&
          (event.identity.model ?? "unknown") === model;
        return {
          provider,
          model,
          today: totals(today.filter(matches), input.todayStart, input.now),
          week: totals(week.filter(matches), input.weekStart, input.now),
        };
      }),
    byStage: [
      ...new Set(week.filter((event) => event.kind === "work").map((event) => event.workKind)),
    ].map((stage) => ({
      stage,
      todayMs: workMillis(
        today.filter((event) => event.workKind === stage),
        input.todayStart,
        input.now,
      ),
      weekMs: workMillis(
        week.filter((event) => event.workKind === stage),
        input.weekStart,
        input.now,
      ),
    })),
    malformedEvents: input.readout.malformedEvents,
  };
  return { ...view, display: usageDisplay(view) };
}

/** Local midnight boundaries are explicit inputs to usageView for deterministic rendering. */
export function usageWindowStarts(
  now: IsoTimestamp,
): Readonly<{ todayStart: IsoTimestamp; weekStart: IsoTimestamp }> {
  const today = new Date(`${calendarDate(now)}T00:00:00`);
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  return { todayStart: today.toISOString(), weekStart: week.toISOString() };
}

function accountable(event: RequestUsageEvent): boolean {
  return event.kind === "work" || event.kind === "provider-sample";
}
function totals(events: readonly RequestUsageEvent[], start: string, now: string): UsageTotals {
  const receipt = buildRequestUsageReceipt("usage-view", { events, malformedEvents: 0 });
  return {
    costMicros: receipt.charges.amountMicros,
    unpricedSamples: receipt.charges.unavailableSamples,
    agentMs: workMillis(events, start, now),
    tasksDone: 0,
  };
}
function workMillis(events: readonly RequestUsageEvent[], start: string, now: string): number {
  return events
    .filter((event) => event.kind === "work")
    .reduce(
      (sum, event) =>
        sum +
        Math.max(
          0,
          Math.min(Date.parse(event.endedAt), Date.parse(now)) -
            Math.max(Date.parse(event.startedAt), Date.parse(start)),
        ),
      0,
    );
}

/** Per-task receipt fields, without inventing request intake or subscription charges. */
export type TaskCostView = Readonly<{
  taskId: string;
  recorded: boolean;
  charges: RequestUsageReceipt["charges"];
  tokens: RequestUsageReceipt["tokens"];
  quota: RequestUsageReceipt["quota"];
  timing: RequestUsageReceipt["timing"];
  breakdown: RequestUsageReceipt["breakdown"];
}>;

export function taskUsageView(taskId: string, readout: RequestUsageReadout): TaskCostView {
  const events = readout.events.filter((event) => event.identity.taskId === taskId);
  const receipt = buildRequestUsageReceipt(taskId, {
    events,
    malformedEvents: readout.malformedEvents,
  });
  return {
    taskId,
    recorded: events.some(accountable),
    charges: receipt.charges,
    tokens: receipt.tokens,
    quota: receipt.quota,
    timing: receipt.timing,
    breakdown: receipt.breakdown,
  };
}

/** A cited scout's settled operation may be credited into several request/task scopes. */
function usageSpanKey(event: RequestUsageEvent): string {
  const identity = event.identity;
  if (event.kind !== "work" || (identity.operationId === undefined && identity.jobId === undefined))
    return event.eventKey;
  return JSON.stringify([
    "work",
    identity.taskId,
    identity.operationId ?? identity.jobId,
    identity.generation,
    identity.attempt,
  ]);
}
