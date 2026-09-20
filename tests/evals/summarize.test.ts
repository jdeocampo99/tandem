import { expect, test } from "bun:test";
import {
  computeDirectRouteMetrics,
  computeFallbackMetrics,
  computeFieldAccuracy,
  computeLatencyPercentiles,
  computeProviderReliability,
  computeUsageSummary,
  percentile,
  summarizePromptRoutingRun,
  sweepConfidenceThresholds,
} from "../../evals/summarize.ts";
import type { PromptRoutingRunOutcome } from "../../evals/types.ts";
import { JEV_MODEL } from "../../src/adapters/typesafe.ts";
import { JEV_PRICING_SNAPSHOT, USAGE_RECORD_SCHEMA_VERSION } from "../../src/runtime/usage.ts";

function outcome(overrides: Partial<PromptRoutingRunOutcome> = {}): PromptRoutingRunOutcome {
  return {
    fixtureId: "fixture-1",
    fixtureSetVersion: "v1",
    mode: "fake",
    runIndex: 0,
    modelVersion: JEV_MODEL,
    requestSchemaVersion: 1,
    safety: "safe-direct",
    expectedRoute: "direct",
    actualRoute: "direct",
    expectedReason: "direct-read-only",
    actualReason: "direct-read-only",
    providerOutcome: "success",
    durationMs: 10,
    ...overrides,
  };
}

test("percentile handles empty input, single values, and linear interpolation", () => {
  expect(percentile([], 50)).toBe("unavailable");
  expect(percentile([10], 50)).toBe(10);
  expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  expect(percentile([1, 2, 3, 4], 0)).toBe(1);
  expect(percentile([1, 2, 3, 4], 100)).toBe(4);
});

test("computeLatencyPercentiles reports p50 and p95 over sorted durations", () => {
  expect(computeLatencyPercentiles([100, 200, 300, 400, 500])).toEqual({ p50: 300, p95: 480 });
  expect(computeLatencyPercentiles([])).toEqual({ p50: "unavailable", p95: "unavailable" });
});

test("computeFieldAccuracy grades only fields with a recorded match, skipping the rest", () => {
  const outcomes = [
    outcome({ fieldMatches: { action: true } }),
    outcome({ fieldMatches: { action: true } }),
    outcome({ fieldMatches: { action: false } }),
    outcome({ fieldMatches: {} }),
  ];
  const report = computeFieldAccuracy(outcomes);
  expect(report.action).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
  expect(report.target).toEqual({ correct: 0, total: 0, accuracy: "unavailable" });
});

test("computeDirectRouteMetrics distinguishes false direct routes from missed direct routes", () => {
  const outcomes = [
    outcome({ expectedRoute: "direct", actualRoute: "direct" }), // true positive
    outcome({ expectedRoute: "direct", actualRoute: "direct" }), // true positive
    outcome({ expectedRoute: "fallback", actualRoute: "direct" }), // false direct route (safety failure)
    outcome({ expectedRoute: "direct", actualRoute: "fallback" }), // missed direct route (optimization miss)
    outcome({ expectedRoute: "fallback", actualRoute: "fallback" }),
  ];
  const metrics = computeDirectRouteMetrics(outcomes);
  expect(metrics).toEqual({
    actualDirectCount: 3,
    expectedDirectCount: 3,
    truePositiveCount: 2,
    falseDirectRouteCount: 1,
    missedDirectRouteCount: 1,
    precision: 2 / 3,
    recall: 2 / 3,
  });
});

test("computeDirectRouteMetrics reports unavailable rates rather than dividing by zero", () => {
  const outcomes = [outcome({ expectedRoute: "fallback", actualRoute: "fallback" })];
  const metrics = computeDirectRouteMetrics(outcomes);
  expect(metrics.precision).toBe("unavailable");
  expect(metrics.recall).toBe("unavailable");
});

test("computeFallbackMetrics reports the fallback rate and abstention recall", () => {
  const outcomes = [
    outcome({ expectedRoute: "fallback", actualRoute: "fallback" }),
    outcome({ expectedRoute: "fallback", actualRoute: "fallback" }),
    outcome({ expectedRoute: "fallback", actualRoute: "direct" }),
    outcome({ expectedRoute: "direct", actualRoute: "direct" }),
  ];
  expect(computeFallbackMetrics(outcomes)).toEqual({
    fallbackCount: 2,
    fallbackRate: 0.5,
    shouldFallbackCount: 3,
    correctFallbackCount: 2,
    abstentionRecall: 2 / 3,
  });
});

test("computeProviderReliability excludes not-attempted outcomes from its rates", () => {
  const outcomes = [
    outcome({ providerOutcome: "not-attempted" }),
    outcome({ providerOutcome: "success" }),
    outcome({ providerOutcome: "error" }),
    outcome({ providerOutcome: "timeout" }),
  ];
  expect(computeProviderReliability(outcomes)).toEqual({
    attemptedCount: 3,
    errorCount: 1,
    timeoutCount: 1,
    errorRate: 1 / 3,
    timeoutRate: 1 / 3,
  });
});

test("sweepConfidenceThresholds scores only outcomes with a saved combined confidence", () => {
  const outcomes = [
    outcome({ expectedRoute: "direct", combinedConfidence: 0.9 }),
    outcome({ expectedRoute: "direct", combinedConfidence: 0.7 }),
    outcome({ expectedRoute: "fallback", combinedConfidence: 0.6 }),
    outcome({ expectedRoute: "fallback" }), // no combinedConfidence: excluded
  ];
  const [highThreshold, lowThreshold] = sweepConfidenceThresholds(outcomes, [0.8, 0.5]);
  expect(highThreshold).toEqual({
    threshold: 0.8,
    truePositives: 1,
    falsePositives: 0,
    falseNegatives: 1,
    trueNegatives: 1,
    precision: 1,
    recall: 0.5,
  });
  expect(lowThreshold).toEqual({
    threshold: 0.5,
    truePositives: 2,
    falsePositives: 1,
    falseNegatives: 0,
    trueNegatives: 0,
    precision: 2 / 3,
    recall: 1,
  });
});

test("computeUsageSummary reuses aggregateUsage/calculateUsageCost, keeping unavailable samples explicit", () => {
  const outcomes = [
    outcome({
      usage: {
        schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
        provider: "typesafe",
        model: JEV_MODEL,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        durationMs: 120,
        timedOut: false,
        reason: "direct-read-only",
        pricing: JEV_PRICING_SNAPSHOT,
      },
    }),
    outcome({
      usage: {
        schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
        provider: "typesafe",
        model: JEV_MODEL,
        inputTokens: "unavailable",
        outputTokens: "unavailable",
        durationMs: 50,
        timedOut: true,
        reason: "jev-timeout",
        pricing: JEV_PRICING_SNAPSHOT,
      },
    }),
  ];
  const summary = computeUsageSummary(outcomes);
  expect(summary.totalSamples).toBe(2);
  expect(summary.knownInputTokens).toBe(1_000_000);
  expect(summary.knownOutputTokens).toBe(500_000);
  expect(summary.unavailableInputSamples).toBe(1);
  expect(summary.unavailableOutputSamples).toBe(1);
  expect(summary.timedOutSamples).toBe(1);
  expect(summary.knownCostUsd).toBeCloseTo(0.042, 10);
  expect(summary.costUnavailableSamples).toBe(1);
});

test("summarizePromptRoutingRun combines every metric into one comparable report", () => {
  const outcomes = [
    outcome({ mode: "fake", fixtureSetVersion: "v1" }),
    outcome({ mode: "fake", fixtureSetVersion: "v1", fixtureId: "fixture-2" }),
  ];
  const summary = summarizePromptRoutingRun(outcomes);
  expect(summary.totalOutcomes).toBe(2);
  expect(summary.modes).toEqual(["fake"]);
  expect(summary.fixtureSetVersions).toEqual(["v1"]);
  expect(summary.directRoute.actualDirectCount).toBe(2);
  expect(summary.confidenceCalibration.length).toBeGreaterThan(0);
});
