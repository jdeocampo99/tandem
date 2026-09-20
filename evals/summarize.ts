/**
 * Pure metric computation over `PromptRoutingRunOutcome[]`. No filesystem, network, or clock
 * access lives here; every function takes outcomes in and returns plain data out, so the same
 * functions summarize a fake-mode run, a live-mode run, or (for later stacked evaluation work) any
 * other outcome list shaped like this one.
 *
 * Distinguishes, per the routing safety rules in `docs/jev-evaluation.md`: a false direct route
 * (the policy routed directly on a fixture that should have fallen back) is a safety failure; a
 * missed direct route (the policy fell back on a fixture that should have routed directly) is only
 * an optimization miss.
 */

import { aggregateUsage, type TaggedUsageRecord } from "../src/runtime/usage.ts";
import type { PromptRoutingRunOutcome } from "./types.ts";

export type Rate = number | "unavailable";

function rate(numerator: number, denominator: number): Rate {
  return denominator === 0 ? "unavailable" : numerator / denominator;
}

/** Linear-interpolated percentile over an already-ascending-sorted array. */
export function percentile(sortedAscending: readonly number[], p: number): number | "unavailable" {
  if (sortedAscending.length === 0) return "unavailable";
  const first = sortedAscending[0];
  const last = sortedAscending[sortedAscending.length - 1];
  if (first === undefined || last === undefined) return "unavailable";
  if (p <= 0) return first;
  if (p >= 100) return last;
  const rank = (p / 100) * (sortedAscending.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lowerValue = sortedAscending[lowerIndex];
  const upperValue = sortedAscending[upperIndex];
  if (lowerValue === undefined || upperValue === undefined) return "unavailable";
  if (lowerIndex === upperIndex) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (rank - lowerIndex);
}

export type LatencyPercentiles = Readonly<{ readonly p50: Rate; readonly p95: Rate }>;

export function computeLatencyPercentiles(durationsMs: readonly number[]): LatencyPercentiles {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

const CLASSIFIED_FIELDS = ["action", "target", "effect", "scope", "composition", "taskId"] as const;
export type ClassifiedField = (typeof CLASSIFIED_FIELDS)[number];

export type FieldAccuracy = Readonly<{
  readonly correct: number;
  readonly total: number;
  readonly accuracy: Rate;
}>;
export type FieldAccuracyReport = Readonly<Record<ClassifiedField, FieldAccuracy>>;

/** Per-field classification accuracy, graded against Jev's raw answers, independent of routing. */
export function computeFieldAccuracy(
  outcomes: readonly PromptRoutingRunOutcome[],
): FieldAccuracyReport {
  const report = {} as Record<ClassifiedField, FieldAccuracy>;
  for (const field of CLASSIFIED_FIELDS) {
    let correct = 0;
    let total = 0;
    for (const outcome of outcomes) {
      const match = outcome.fieldMatches?.[field];
      if (match === undefined) continue;
      total += 1;
      if (match) correct += 1;
    }
    report[field] = { correct, total, accuracy: rate(correct, total) };
  }
  return report;
}

export type DirectRouteMetrics = Readonly<{
  readonly actualDirectCount: number;
  readonly expectedDirectCount: number;
  readonly truePositiveCount: number;
  /** A false direct route: the policy routed directly on a fixture that should have fallen back. This is a safety failure. */
  readonly falseDirectRouteCount: number;
  /** A missed direct route: the policy fell back on a fixture that should have routed directly. This is only an optimization miss. */
  readonly missedDirectRouteCount: number;
  readonly precision: Rate;
  readonly recall: Rate;
}>;

export function computeDirectRouteMetrics(
  outcomes: readonly PromptRoutingRunOutcome[],
): DirectRouteMetrics {
  let actualDirectCount = 0;
  let expectedDirectCount = 0;
  let truePositiveCount = 0;
  let falseDirectRouteCount = 0;
  let missedDirectRouteCount = 0;
  for (const outcome of outcomes) {
    const actualDirect = outcome.actualRoute === "direct";
    const expectedDirect = outcome.expectedRoute === "direct";
    if (actualDirect) actualDirectCount += 1;
    if (expectedDirect) expectedDirectCount += 1;
    if (actualDirect && expectedDirect) truePositiveCount += 1;
    else if (actualDirect && !expectedDirect) falseDirectRouteCount += 1;
    else if (!actualDirect && expectedDirect) missedDirectRouteCount += 1;
  }
  return {
    actualDirectCount,
    expectedDirectCount,
    truePositiveCount,
    falseDirectRouteCount,
    missedDirectRouteCount,
    precision: rate(truePositiveCount, actualDirectCount),
    recall: rate(truePositiveCount, expectedDirectCount),
  };
}

export type FallbackMetrics = Readonly<{
  readonly fallbackCount: number;
  readonly fallbackRate: Rate;
  readonly shouldFallbackCount: number;
  readonly correctFallbackCount: number;
  /** Of fixtures that should abstain, the fraction the policy actually abstained on. */
  readonly abstentionRecall: Rate;
}>;

export function computeFallbackMetrics(
  outcomes: readonly PromptRoutingRunOutcome[],
): FallbackMetrics {
  const fallbackCount = outcomes.filter((outcome) => outcome.actualRoute === "fallback").length;
  const shouldFallback = outcomes.filter((outcome) => outcome.expectedRoute === "fallback");
  const correctFallbackCount = shouldFallback.filter(
    (outcome) => outcome.actualRoute === "fallback",
  ).length;
  return {
    fallbackCount,
    fallbackRate: rate(fallbackCount, outcomes.length),
    shouldFallbackCount: shouldFallback.length,
    correctFallbackCount,
    abstentionRecall: rate(correctFallbackCount, shouldFallback.length),
  };
}

export type ProviderReliability = Readonly<{
  readonly attemptedCount: number;
  readonly errorCount: number;
  readonly timeoutCount: number;
  readonly errorRate: Rate;
  readonly timeoutRate: Rate;
}>;

export function computeProviderReliability(
  outcomes: readonly PromptRoutingRunOutcome[],
): ProviderReliability {
  const attempted = outcomes.filter((outcome) => outcome.providerOutcome !== "not-attempted");
  const errorCount = attempted.filter((outcome) => outcome.providerOutcome === "error").length;
  const timeoutCount = attempted.filter((outcome) => outcome.providerOutcome === "timeout").length;
  return {
    attemptedCount: attempted.length,
    errorCount,
    timeoutCount,
    errorRate: rate(errorCount, attempted.length),
    timeoutRate: rate(timeoutCount, attempted.length),
  };
}

export type ConfidenceCalibrationPoint = Readonly<{
  readonly threshold: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly precision: Rate;
  readonly recall: Rate;
}>;

export const DEFAULT_CONFIDENCE_THRESHOLDS: readonly number[] = [
  0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
];

/**
 * Confidence calibration: for each candidate threshold, how well the combined confidence score
 * alone (saved from the response Jev already returned) predicts whether a fixture should route
 * directly. This never re-runs the full multi-field routing policy at the swept threshold and
 * never changes `PROMPT_ROUTING_CONFIDENCE_THRESHOLD`; it measures the confidence signal's
 * quality in isolation, using only probabilities already saved on each outcome.
 */
export function sweepConfidenceThresholds(
  outcomes: readonly PromptRoutingRunOutcome[],
  thresholds: readonly number[] = DEFAULT_CONFIDENCE_THRESHOLDS,
): readonly ConfidenceCalibrationPoint[] {
  const scored = outcomes.filter(
    (outcome): outcome is PromptRoutingRunOutcome & { combinedConfidence: number } =>
      outcome.combinedConfidence !== undefined,
  );
  return thresholds.map((threshold) => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let trueNegatives = 0;
    for (const outcome of scored) {
      const predictedDirect = outcome.combinedConfidence >= threshold;
      const shouldBeDirect = outcome.expectedRoute === "direct";
      if (predictedDirect && shouldBeDirect) truePositives += 1;
      else if (predictedDirect && !shouldBeDirect) falsePositives += 1;
      else if (!predictedDirect && shouldBeDirect) falseNegatives += 1;
      else trueNegatives += 1;
    }
    return {
      threshold,
      truePositives,
      falsePositives,
      falseNegatives,
      trueNegatives,
      precision: rate(truePositives, truePositives + falsePositives),
      recall: rate(truePositives, truePositives + falseNegatives),
    };
  });
}

export type UsageSummary = Readonly<{
  readonly totalSamples: number;
  readonly knownInputTokens: number;
  readonly knownOutputTokens: number;
  readonly unavailableInputSamples: number;
  readonly unavailableOutputSamples: number;
  readonly timedOutSamples: number;
  readonly knownCostUsd: number;
  readonly costUnavailableSamples: number;
}>;

/** Reuses `aggregateUsage`/`calculateUsageCost` from `src/runtime/usage.ts`; no second accounting path. */
export function computeUsageSummary(outcomes: readonly PromptRoutingRunOutcome[]): UsageSummary {
  const samples: TaggedUsageRecord[] = [];
  for (const outcome of outcomes) {
    if (outcome.usage === undefined) continue;
    samples.push({
      context: { fixture: outcome.fixtureId, role: "jev", runId: `run-${outcome.runIndex}` },
      usage: outcome.usage,
    });
  }
  const aggregates = aggregateUsage(samples);
  let knownInputTokens = 0;
  let knownOutputTokens = 0;
  let unavailableInputSamples = 0;
  let unavailableOutputSamples = 0;
  let timedOutSamples = 0;
  let knownCostUsd = 0;
  let costUnavailableSamples = 0;
  for (const aggregate of aggregates) {
    knownInputTokens += aggregate.knownInputTokens;
    knownOutputTokens += aggregate.knownOutputTokens;
    unavailableInputSamples += aggregate.unavailableInputSamples;
    unavailableOutputSamples += aggregate.unavailableOutputSamples;
    timedOutSamples += aggregate.timedOutSamples;
    knownCostUsd += aggregate.knownCost;
    costUnavailableSamples += aggregate.costUnavailableSamples;
  }
  return {
    totalSamples: samples.length,
    knownInputTokens,
    knownOutputTokens,
    unavailableInputSamples,
    unavailableOutputSamples,
    timedOutSamples,
    knownCostUsd,
    costUnavailableSamples,
  };
}

export type PromptRoutingSummary = Readonly<{
  readonly totalOutcomes: number;
  readonly modes: readonly ("fake" | "live")[];
  readonly fixtureSetVersions: readonly string[];
  readonly fieldAccuracy: FieldAccuracyReport;
  readonly directRoute: DirectRouteMetrics;
  readonly fallback: FallbackMetrics;
  readonly providerReliability: ProviderReliability;
  readonly confidenceCalibration: readonly ConfidenceCalibrationPoint[];
  readonly latency: LatencyPercentiles;
  readonly usage: UsageSummary;
}>;

function distinctSorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Builds the concise, comparable summary from a set of run outcomes. Suitable for comparing two
 * runs directly (a fake-mode regression run against a previous one, or a fake run against a live
 * run) since the field names and shape never depend on which mode produced the outcomes.
 */
export function summarizePromptRoutingRun(
  outcomes: readonly PromptRoutingRunOutcome[],
  thresholds: readonly number[] = DEFAULT_CONFIDENCE_THRESHOLDS,
): PromptRoutingSummary {
  return {
    totalOutcomes: outcomes.length,
    modes: [...new Set(outcomes.map((outcome) => outcome.mode))].sort(),
    fixtureSetVersions: distinctSorted(outcomes.map((outcome) => outcome.fixtureSetVersion)),
    fieldAccuracy: computeFieldAccuracy(outcomes),
    directRoute: computeDirectRouteMetrics(outcomes),
    fallback: computeFallbackMetrics(outcomes),
    providerReliability: computeProviderReliability(outcomes),
    confidenceCalibration: sweepConfidenceThresholds(outcomes, thresholds),
    latency: computeLatencyPercentiles(outcomes.map((outcome) => outcome.durationMs)),
    usage: computeUsageSummary(outcomes),
  };
}
