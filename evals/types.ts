/**
 * Result shape shared by the runner (`run-jev.ts`) and the summarizer (`summarize.ts`), and
 * exported for reuse by later stacked evaluation work that grades its own fixtures against the
 * same routing policy or reuses the same percentile/aggregation functions.
 */

import type { JEV_MODEL, JevEvaluationResponse } from "../src/adapters/typesafe.ts";
import type { ResearchContinuationDisposition, ResearchContinuationSelector } from "../src/contracts.ts";
import type { PromptRoutingDecision } from "../src/extension/prompt-routing.ts";
import type { UsageRecord } from "../src/runtime/usage.ts";
import type {
  ResearchContinuationOverride,
  ResearchFollowUp,
} from "../src/tasks/research-continuation.ts";
import type { PromptRoutingExpectedDecision, PromptRoutingSafetyClass } from "./fixtures.ts";
import type {
  ResearchContinuationScenario,
  ResearchContinuationScoutOutcome,
} from "./research-continuation-fixtures.ts";

export type PromptRoutingProviderOutcome = "success" | "error" | "timeout" | "not-attempted";

export type PromptRoutingFieldMatches = Readonly<{
  readonly action?: boolean;
  readonly target?: boolean;
  readonly effect?: boolean;
  readonly scope?: boolean;
  readonly composition?: boolean;
  readonly taskId?: boolean;
}>;

/**
 * One graded fixture run. Live results preserve everything needed to compare two runs later:
 * model version, fixture-set version, request/schema version, the raw answers and probabilities
 * Jev actually returned, usage, and latency.
 */
export type PromptRoutingRunOutcome = Readonly<{
  readonly fixtureId: string;
  readonly fixtureSetVersion: string;
  readonly mode: "fake" | "live";
  readonly runIndex: number;
  readonly modelVersion: typeof JEV_MODEL;
  readonly requestSchemaVersion: number;
  readonly safety: PromptRoutingSafetyClass;
  readonly expectedRoute: "direct" | "fallback";
  readonly actualRoute: "direct" | "fallback";
  readonly expectedReason: string;
  readonly actualReason: string;
  readonly expectedDecision?: PromptRoutingExpectedDecision;
  readonly actualDecision?: PromptRoutingDecision;
  readonly fieldMatches?: PromptRoutingFieldMatches;
  readonly providerOutcome: PromptRoutingProviderOutcome;
  readonly combinedConfidence?: number;
  readonly rawResponse?: JevEvaluationResponse;
  readonly usage?: UsageRecord;
  readonly durationMs: number;
}>;

/**
 * One graded post-research continuation fixture run (issue #28). Covers both production seams a
 * fixture drives: the classifier's chosen disposition, and the pure follow-up decision computed
 * from that disposition plus the scout's durable stage. `safetyFailure` is reported separately
 * from, and never averaged into, the accuracy metrics computed over these outcomes.
 */
export type ResearchContinuationRunOutcome = Readonly<{
  readonly fixtureId: string;
  readonly fixtureSetVersion: string;
  readonly mode: "fake" | "live";
  readonly runIndex: number;
  readonly scenario: ResearchContinuationScenario;
  readonly scoutOutcome: ResearchContinuationScoutOutcome;
  readonly expectedDisposition: ResearchContinuationDisposition;
  readonly actualDisposition: ResearchContinuationDisposition;
  readonly expectedSelectedBy: ResearchContinuationSelector;
  readonly actualSelectedBy: ResearchContinuationSelector;
  readonly classifierReason: string;
  readonly providerOutcome: PromptRoutingProviderOutcome;
  readonly jevCallExpected: boolean;
  readonly jevCallMade: boolean;
  readonly expectedFollowUp: ResearchFollowUp;
  readonly actualFollowUp: ResearchFollowUp;
  readonly expectedOverride?: ResearchContinuationOverride;
  readonly actualOverride?: ResearchContinuationOverride;
  readonly content: string;
  readonly restartContent?: string;
  readonly contentFailures: readonly string[];
  /** True only when this outcome demonstrates an unapproved path toward implementation. */
  readonly safetyFailure: boolean;
  readonly durationMs: number;
  readonly usage?: UsageRecord;
}>;
