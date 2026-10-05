import { expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { ompUsageLimits, readOmpUsageLimits } from "../../../src/harness/omp/usage-limits.ts";

const report: UsageReport = {
  provider: "anthropic",
  fetchedAt: Date.parse("2030-01-01T12:00:00Z"),
  metadata: { accountId: "personal", secret: "never-export-me" },
  raw: { accessToken: "never-export-me" },
  limits: [
    {
      id: "five_hour",
      label: "5-hour",
      scope: { provider: "anthropic", accountId: "personal" },
      window: { id: "5h", label: "5-hour", resetsAt: Date.parse("2030-01-01T14:14:00Z") },
      amount: { unit: "percent", used: 38 },
    },
    {
      id: "seven_day",
      label: "Weekly",
      scope: { provider: "anthropic", accountId: "personal" },
      window: { id: "7d", label: "Week" },
      amount: { unit: "percent", usedFraction: 0.29 },
    },
    {
      id: "monthly",
      label: "Monthly",
      scope: { provider: "anthropic" },
      window: { id: "monthly", label: "Month" },
      amount: { unit: "tokens" },
    },
  ],
};

test("OMP adapter exports only 5-hour/weekly per-account meters and no credential metadata", () => {
  const limits = ompUsageLimits([report]);
  expect(limits.map((limit) => limit.remainingPercent)).toEqual([62, 71]);
  expect(limits[0]).toMatchObject({
    provider: "anthropic",
    account: "personal",
    window: "five-hour",
    resetsAt: "2030-01-01T14:14:00.000Z",
  });
  expect(JSON.stringify(limits)).not.toContain("never-export-me");
});

test("OMP usage command uses the pi-ai schema and rejects malformed provider windows", async () => {
  const seen: string[][] = [];
  const limits = await readOmpUsageLimits(async (request) => {
    seen.push([...request.argv]);
    return { code: 0, stdout: JSON.stringify({ reports: [report] }), stderr: "" };
  }, "/repo");
  expect(seen).toEqual([["omp", "usage", "--json"]]);
  expect(limits).toHaveLength(2);
  await expect(
    readOmpUsageLimits(
      async () => ({ code: 0, stdout: '{"reports":[{"provider":"anthropic"}]}', stderr: "" }),
      "/repo",
    ),
  ).rejects.toThrow("Invalid OMP usage report");
});
