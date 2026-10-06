import type { UsageView } from "./usage-view.ts";

export type UsageDisplay = Readonly<{
  accounts: readonly Readonly<{
    title: string;
    meters: readonly Readonly<{
      label: string;
      remaining: string;
      reset: string;
      fetched: string;
      percent?: number;
    }>[];
  }>[];
  totals: readonly Readonly<{ label: string; value: string }>[];
  todayModels: readonly Readonly<{ model: string; cost: string; percent: number }>[];
  weekModels: readonly Readonly<{ model: string; cost: string; percent: number }>[];
  stages: readonly Readonly<{ label: string; today: string; week: string }>[];
  updated: string;
  limitWarnings: readonly string[];
  warning?: string;
}>;

export function nativeCostLabel(micros: number | undefined, unpriced = 0): string {
  const known = micros === undefined ? "cost unavailable" : `$${(micros / 1_000_000).toFixed(2)}`;
  return `${known}${unpriced > 0 ? " + unpriced usage" : ""}`;
}

export function nativeDurationLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

const STAGES: Readonly<Record<string, string>> = {
  research: "Research",
  implementation: "Implementing",
  validation: "Validating",
  review: "Review",
  coordinator: "Coordinator",
  verification: "Verification",
  presentation: "Presentation",
};

/** Presentation values are derived here; native blocks only draw these labels and widths. */
export function usageDisplay(
  view: Omit<UsageView, "display">,
  freshness: Readonly<{ writtenAt: string; warnings: readonly string[] }>,
): UsageDisplay {
  const accounts = new Map<
    string,
    { title: string; meters: UsageDisplay["accounts"][number]["meters"][number][] }
  >();
  for (const meter of [...view.limits].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.account.localeCompare(b.account) ||
      Number(a.window === "weekly") - Number(b.window === "weekly"),
  )) {
    const key = JSON.stringify([meter.provider, meter.account]);
    let account = accounts.get(key);
    if (account === undefined) {
      account = { title: `Limits · ${meter.provider} (${meter.account})`, meters: [] };
      accounts.set(key, account);
    }
    account.meters.push({
      label: meter.window === "five-hour" ? "5-hour window" : "Weekly",
      remaining:
        meter.remainingPercent === "unavailable"
          ? "limit unavailable"
          : `${Math.round(meter.remainingPercent)}% left`,
      reset:
        meter.resetInMs === "unavailable"
          ? "reset unavailable"
          : `resets in ${nativeDurationLabel(meter.resetInMs)}`,
      fetched: `Fetched at ${timestampLabel(meter.fetchedAt)}`,
      ...(meter.remainingPercent === "unavailable" ? {} : { percent: meter.remainingPercent }),
    });
  }
  const models = (period: "today" | "week") => {
    const maximum = Math.max(0, ...view.byModel.map((row) => row[period].costMicros));
    return view.byModel.map((row) => ({
      model: row.model,
      cost: nativeCostLabel(row[period].costMicros, row[period].unpricedSamples),
      percent: maximum === 0 ? 0 : (row[period].costMicros / maximum) * 100,
    }));
  };
  return {
    accounts: [...accounts.values()],
    totals: [
      {
        label: "cost today",
        value: nativeCostLabel(view.today.costMicros, view.today.unpricedSamples),
      },
      { label: "agent time today", value: nativeDurationLabel(view.today.agentMs) },
      { label: "tasks done today", value: String(view.today.tasksDone) },
      {
        label: "this week",
        value: nativeCostLabel(view.week.costMicros, view.week.unpricedSamples),
      },
    ],
    todayModels: models("today"),
    weekModels: models("week"),
    stages: view.byStage.map((row) => ({
      label: STAGES[row.stage] ?? row.stage,
      today: nativeDurationLabel(row.todayMs),
      week: nativeDurationLabel(row.weekMs),
    })),
    updated: `View updated at ${timestampLabel(freshness.writtenAt)}`,
    limitWarnings: [...new Set(freshness.warnings)],
    ...(view.malformedEvents === 0
      ? {}
      : { warning: `${view.malformedEvents} unreadable usage rows; totals may be incomplete` }),
  };
}

function timestampLabel(timestamp: string): string {
  const time = Date.parse(timestamp);
  return Number.isFinite(time)
    ? `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`
    : "unavailable";
}
