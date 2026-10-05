import { resolveUsedFraction, type UsageReport, usageReportSchema } from "@oh-my-pi/pi-ai/usage";
import { parseJson, requiredRecord, runChecked } from "../../adapters/primitives.ts";
import type { CommandRunner } from "../../contracts.ts";
import type { AccountLimit } from "../../runtime/usage-view.ts";

/** OMP owns authentication and the pi-ai provider APIs. Only sanitized windows leave this adapter. */
export async function readOmpUsageLimits(
  run: CommandRunner,
  cwd: string,
): Promise<readonly AccountLimit[]> {
  const result = await runChecked(
    run,
    { argv: ["omp", "usage", "--json"], cwd, timeoutMs: 15_000 },
    "omp usage limits",
  );
  const parsed = requiredRecord(
    parseJson(result.stdout, "omp usage limits"),
    "usage",
    "omp usage limits",
    "",
  );
  if (!Array.isArray(parsed.reports)) throw new TypeError("omp usage must contain reports");
  return ompUsageLimits(
    parsed.reports.map((value): UsageReport => {
      if (!usageReportSchema.allows(value)) throw new TypeError("Invalid OMP usage report");
      return value as UsageReport;
    }),
  );
}

export function ompUsageLimits(reports: readonly UsageReport[]): readonly AccountLimit[] {
  return reports.flatMap((report, index) =>
    report.limits.flatMap((limit) => {
      const id = limit.window?.id ?? limit.scope.windowId;
      const duration = limit.window?.durationMs;
      const window =
        duration === 18_000_000 || id === "5h" || id === "five_hour"
          ? "five-hour"
          : duration === 604_800_000 || id === "7d" || id === "seven_day"
            ? "weekly"
            : undefined;
      if (window === undefined) return [];
      const used = resolveUsedFraction(limit);
      const fraction =
        used ??
        (limit.amount.remaining !== undefined &&
        limit.amount.limit !== undefined &&
        limit.amount.limit > 0
          ? 1 - limit.amount.remaining / limit.amount.limit
          : undefined);
      const account =
        limit.scope.accountId ??
        (typeof report.metadata?.accountId === "string"
          ? report.metadata.accountId
          : `${report.provider}-${index + 1}`);
      return [
        {
          provider: report.provider,
          account,
          window,
          label: limit.label,
          remainingPercent:
            fraction === undefined || !Number.isFinite(fraction)
              ? ("unavailable" as const)
              : Math.max(0, Math.min(100, (1 - fraction) * 100)),
          fetchedAt: new Date(report.fetchedAt).toISOString(),
          ...(limit.window?.resetsAt === undefined || !Number.isFinite(limit.window.resetsAt)
            ? {}
            : { resetsAt: new Date(limit.window.resetsAt).toISOString() }),
        },
      ];
    }),
  );
}
