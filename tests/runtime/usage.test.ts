import { expect, test } from "bun:test";
import {
  aggregateUsage,
  calculateUsageCost,
  JEV_PRICING_SNAPSHOT,
  type TaggedUsageRecord,
  USAGE_RECORD_SCHEMA_VERSION,
  type UsageRecord,
} from "../../src/runtime/usage.ts";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    provider: "typesafe",
    model: "jev-1.13.0",
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    durationMs: 120,
    timedOut: false,
    reason: "direct-read-only",
    pricing: JEV_PRICING_SNAPSHOT,
    ...overrides,
  };
}

test("calculates cost from input tokens only, since Jev's published rate makes output free", () => {
  const cost = calculateUsageCost(usage(), JEV_PRICING_SNAPSHOT);
  expect(cost).toEqual({
    currency: "USD",
    amount: 0.042,
    pricingVersion: JEV_PRICING_SNAPSHOT.schemaVersion,
    pricingSource: JEV_PRICING_SNAPSHOT.source,
  });
});

test("reports cost unavailable when tokens are unavailable, never as zero", () => {
  expect(
    calculateUsageCost({ inputTokens: "unavailable", outputTokens: 10 }, JEV_PRICING_SNAPSHOT),
  ).toBe("unavailable");
  expect(
    calculateUsageCost({ inputTokens: 10, outputTokens: "unavailable" }, JEV_PRICING_SNAPSHOT),
  ).toBe("unavailable");
});

test("reports cost unavailable when pricing is unavailable", () => {
  expect(calculateUsageCost({ inputTokens: 10, outputTokens: 10 }, "unavailable")).toBe(
    "unavailable",
  );
});

test("accepts a pricing input distinct from any snapshot recorded on a usage record", () => {
  const otherPricing = {
    schemaVersion: 2,
    source: "hypothetical-future-rate",
    effectiveDate: "2027-01-01",
    currency: "USD" as const,
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 1,
  };
  const cost = calculateUsageCost(
    { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    otherPricing,
  );
  expect(cost).toEqual({
    currency: "USD",
    amount: 2,
    pricingVersion: 2,
    pricingSource: "hypothetical-future-rate",
  });
});

test("aggregates known usage per fixture, role, task, and run", () => {
  const samples: TaggedUsageRecord[] = [
    {
      context: { fixture: "list-tasks", role: "jev", taskId: "task-1", runId: "run-1" },
      usage: usage({ inputTokens: 100, outputTokens: 50 }),
    },
    {
      context: { fixture: "list-tasks", role: "jev", taskId: "task-1", runId: "run-1" },
      usage: usage({ inputTokens: 200, outputTokens: 100 }),
    },
  ];
  const [group] = aggregateUsage(samples);
  expect(group).toMatchObject({
    key: { fixture: "list-tasks", role: "jev", taskId: "task-1", runId: "run-1" },
    sampleCount: 2,
    knownInputTokens: 300,
    knownOutputTokens: 150,
    unavailableInputSamples: 0,
    unavailableOutputSamples: 0,
    timedOutSamples: 0,
  });
  expect(group?.knownCost).toBeCloseTo(0.0000126, 10);
});

test("preserves unknown tags and unavailable samples instead of dropping or zeroing them", () => {
  const samples: TaggedUsageRecord[] = [
    { context: {}, usage: usage({ inputTokens: "unavailable", outputTokens: "unavailable" }) },
    { context: {}, usage: usage({ inputTokens: 100, outputTokens: 100 }) },
  ];
  const [group] = aggregateUsage(samples);
  expect(group?.key).toEqual({
    fixture: "unknown",
    role: "unknown",
    taskId: "unknown",
    runId: "unknown",
  });
  expect(group?.sampleCount).toBe(2);
  expect(group?.unavailableInputSamples).toBe(1);
  expect(group?.unavailableOutputSamples).toBe(1);
  expect(group?.knownInputTokens).toBe(100);
  expect(group?.knownOutputTokens).toBe(100);
  expect(group?.costUnavailableSamples).toBe(1);
});

test("keeps distinct groups separate rather than merging different tags", () => {
  const samples: TaggedUsageRecord[] = [
    { context: { role: "jev" }, usage: usage() },
    { context: { role: "coordinator" }, usage: usage() },
  ];
  const groups = aggregateUsage(samples);
  expect(groups).toHaveLength(2);
  expect(groups.map((group) => group.key.role).sort()).toEqual(["coordinator", "jev"]);
});
