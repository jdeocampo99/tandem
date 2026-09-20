/**
 * Live-Jev budget enforcement shared by every stacked live-mode runner (prompt-routing,
 * research-continuation, and any later one) so a live evaluation's spend is tracked and enforced
 * in exactly one place, on top of the one pricing/cost function in `src/runtime/usage.ts`.
 */

import { evaluateJev, type JevEvaluationInput, type JevEvaluationOptions } from "../src/adapters/typesafe.ts";
import { calculateUsageCost, type PricingSnapshot } from "../src/runtime/usage.ts";

export type LiveJevBudget = Readonly<{
  readonly maxTotalCostUsd: number;
  readonly pricing?: PricingSnapshot;
}>;

export class LiveJevBudgetExceededError extends Error {
  constructor(spentUsd: number, maxTotalCostUsd: number) {
    super(
      `Jev live evaluation budget exceeded: spent $${spentUsd.toFixed(6)} of a ` +
        `$${maxTotalCostUsd.toFixed(6)} budget`,
    );
    this.name = "LiveJevBudgetExceededError";
  }
}

export type LiveJevCaller = typeof evaluateJev;

export type LiveJevEvaluate = LiveJevCaller;

export type LiveJevRunOptions = Readonly<{
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly repeatCount: number;
  readonly budget: LiveJevBudget;
  /** Injected Jev caller; defaults to the real network call. Tests inject a fake caller. */
  readonly evaluate?: LiveJevCaller;
}>;

/** Fails closed before any live call is made, rather than truncating results silently. */
export function checkLiveJevRunOptions(
  options: Pick<LiveJevRunOptions, "apiKey" | "timeoutMs" | "repeatCount" | "budget">,
): void {
  if (options.apiKey.trim().length === 0) {
    throw new Error("live Jev evaluation requires a non-empty API key");
  }
  if (!Number.isSafeInteger(options.repeatCount) || options.repeatCount < 1) {
    throw new RangeError("live Jev evaluation requires a positive integer repeat count");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError("live Jev evaluation requires a positive timeout");
  }
  if (!Number.isFinite(options.budget.maxTotalCostUsd) || options.budget.maxTotalCostUsd <= 0) {
    throw new RangeError("live Jev evaluation requires a positive budget");
  }
}

/** Measures and accumulates spend per call. Never throws: the budget is enforced by {@link budgetGuard}. */
export function costTrackingEvaluate(
  evaluate: LiveJevCaller,
  pricing: PricingSnapshot,
  spentTracker: { totalUsd: number },
): (input: JevEvaluationInput, options: JevEvaluationOptions) => ReturnType<LiveJevCaller> {
  return async (input, options) => {
    const response = await evaluate(input, options);
    const cost = calculateUsageCost(
      { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      pricing,
    );
    if (cost !== "unavailable") spentTracker.totalUsd += cost.amount;
    return response;
  };
}

/** Called immediately before each live call; throws once cumulative spend has reached the budget. */
export function budgetGuard(
  spentTracker: { totalUsd: number },
  budget: LiveJevBudget,
): () => void {
  return () => {
    if (spentTracker.totalUsd >= budget.maxTotalCostUsd) {
      throw new LiveJevBudgetExceededError(spentTracker.totalUsd, budget.maxTotalCostUsd);
    }
  };
}
