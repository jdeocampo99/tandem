/**
 * Fixture-driven post-research continuation evaluation runner (issue #28).
 *
 * Each fixture drives two production seams in sequence, never reimplemented here:
 * 1. `classifyResearchContinuation` (`src/tasks/research-continuation-classifier.ts`) decides a
 *    disposition from a sanitized request objective, either deterministically or through an
 *    injected Jev evaluator.
 * 2. `decideResearchFollowUp` / `buildResearchFollowUpContent`
 *    (`src/tasks/research-continuation.ts`, `src/session/research-follow-up.ts`) turn that
 *    disposition, plus the scout's durable stage, into the coordinator-facing wake content.
 *
 * Fake mode (the only mode exercised by `bun test`) never touches the network: deterministic
 * fixtures never invoke the injected evaluator at all, and ambiguous fixtures replay a recorded
 * typed Jev response or a simulated provider failure. Live mode calls the pinned `jev-1.13.0`
 * model through `evaluateJev()` with the same budget enforcement used by the prompt-routing
 * harness (`./live-jev-budget.ts`), so there is exactly one live-Jev budget mechanism in this repo.
 *
 * Usage/cost accounting reuses `src/runtime/usage.ts` and the generalized summary functions in
 * `./summarize.ts`; result writing reuses `./write-results.ts`. No second percentile, cost,
 * budget, or JSONL writer is defined here.
 */

import { fileURLToPath } from "node:url";
import { evaluateJev, JEV_MODEL, JEV_PROVIDER } from "../src/adapters/typesafe.ts";
import {
  JEV_PRICING_SNAPSHOT,
  USAGE_RECORD_SCHEMA_VERSION,
  type UsageRecord,
} from "../src/runtime/usage.ts";
import {
  classifyContinuationCues,
  classifyResearchContinuation,
  DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS,
  type JevEvaluator,
  type ResearchContinuationClassification,
  type ResearchContinuationClassifierConfig,
  type ResearchContinuationClock,
} from "../src/tasks/research-continuation-classifier.ts";
import { fakeEvaluatorFor } from "./fixtures.ts";
import {
  budgetGuard,
  checkLiveJevRunOptions,
  costTrackingEvaluate,
  type LiveJevBudget,
  LiveJevBudgetExceededError,
  type LiveJevRunOptions,
  readLiveJevRunOptions,
} from "./live-jev-budget.ts";
import {
  loadResearchContinuationFixtures,
  type ResearchContinuationFixture,
} from "./research-continuation-fixtures.ts";
import { evaluateFixtureFollowUp } from "./research-continuation-follow-up.ts";
import { summarizeResearchContinuationRun } from "./summarize.ts";
import type { PromptRoutingProviderOutcome, ResearchContinuationRunOutcome } from "./types.ts";
import { realEvalResultIo, writeEvalResults } from "./write-results.ts";

export type { LiveJevBudget, LiveJevRunOptions, ResearchContinuationRunOutcome };
export { LiveJevBudgetExceededError };

const FAKE_API_KEY = "fixture-key";

type ClassifyDeps = Readonly<{
  readonly config: ResearchContinuationClassifierConfig;
  readonly evaluate: JevEvaluator;
}>;

function fakeDepsFor(fixture: ResearchContinuationFixture): ClassifyDeps {
  const jevConfigured = fixture.jevConfigured ?? true;
  return {
    config: {
      timeoutMs: DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS,
      ...(jevConfigured ? { apiKey: FAKE_API_KEY } : {}),
    },
    evaluate: fakeEvaluatorFor(fixture),
  };
}

const PROVIDER_FAILURE_REASONS = [
  "jev-unavailable",
  "jev-invalid-response",
  "jev-invalid-request",
  "jev-error",
];

function classifierProviderOutcome(
  jevCallMade: boolean,
  reason: string,
): PromptRoutingProviderOutcome {
  if (!jevCallMade) return "not-attempted";
  if (reason === "jev-timeout") return "timeout";
  return PROVIDER_FAILURE_REASONS.includes(reason) ? "error" : "success";
}

/** Adapts the classifier's bounded `JevUsage` into the shared `UsageRecord` shape for reporting. */
function usageRecordFor(
  classification: ResearchContinuationClassification,
  jevCallMade: boolean,
): UsageRecord | undefined {
  if (!jevCallMade) return undefined;
  const shared = {
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    provider: JEV_PROVIDER,
    model: JEV_MODEL,
    durationMs: classification.durationMs,
    reason: classification.reason,
    pricing: JEV_PRICING_SNAPSHOT,
  } as const;
  if (classification.usage === undefined) {
    return {
      ...shared,
      inputTokens: "unavailable",
      outputTokens: "unavailable",
      timedOut: classification.reason === "jev-timeout",
    };
  }
  return {
    ...shared,
    inputTokens: classification.usage.input_tokens,
    outputTokens: classification.usage.output_tokens,
    timedOut: false,
  };
}

async function runResearchContinuationFixture(
  fixture: ResearchContinuationFixture,
  run: ClassifyDeps &
    Readonly<{
      mode: "fake" | "live";
      runIndex: number;
      now: ResearchContinuationClock;
    }>,
): Promise<ResearchContinuationRunOutcome> {
  let jevCallMade = false;
  const wrapped: JevEvaluator = async (input, options) => {
    jevCallMade = true;
    return run.evaluate(input, options);
  };
  const classification = await classifyResearchContinuation(
    { objective: fixture.objective, taskKind: "scout" },
    run.config,
    wrapped,
    run.now,
  );
  const jevCallExpected =
    !classifyContinuationCues(fixture.objective).resolved && run.config.apiKey !== undefined;
  const providerOutcome = classifierProviderOutcome(jevCallMade, classification.reason);
  const usage = usageRecordFor(classification, jevCallMade);
  const continuation = classification.continuation;

  const { decision, content, restartContent, contentFailures, safetyFailure } =
    await evaluateFixtureFollowUp(fixture, continuation);

  return {
    fixtureId: fixture.id,
    fixtureSetVersion: fixture.fixtureSetVersion,
    mode: run.mode,
    runIndex: run.runIndex,
    scenario: fixture.scenario,
    scoutOutcome: fixture.scoutOutcome,
    expectedDisposition: fixture.expectedDisposition,
    actualDisposition: continuation.disposition,
    expectedSelectedBy: fixture.expectedSelectedBy,
    actualSelectedBy: continuation.selectedBy,
    classifierReason: classification.reason,
    providerOutcome,
    jevCallExpected,
    jevCallMade,
    expectedFollowUp: fixture.expectedFollowUp,
    actualFollowUp: decision.followUp,
    ...(fixture.expectedOverride === undefined
      ? {}
      : { expectedOverride: fixture.expectedOverride }),
    ...(decision.override === undefined ? {} : { actualOverride: decision.override }),
    content,
    ...(restartContent === undefined ? {} : { restartContent }),
    contentFailures,
    safetyFailure,
    durationMs: classification.durationMs,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Fake mode: deterministic, no network, safe for `bun test`. Uses a fixed clock rather than the
 * real one, since fake mode never makes a real provider call and so has no real latency to
 * measure: every duration (the outcome's own and its nested usage record's) is therefore always
 * zero, and two fake runs over the same fixtures are byte-identical.
 */
export async function runFakeResearchContinuationFixtures(
  fixtures: readonly ResearchContinuationFixture[],
): Promise<readonly ResearchContinuationRunOutcome[]> {
  const now: ResearchContinuationClock = () => 0;
  const outcomes: ResearchContinuationRunOutcome[] = [];
  for (const fixture of fixtures) {
    outcomes.push(
      await runResearchContinuationFixture(fixture, {
        ...fakeDepsFor(fixture),
        mode: "fake",
        runIndex: 0,
        now,
      }),
    );
  }
  return outcomes;
}

/**
 * Live mode: calls the pinned `jev-1.13.0` model through `evaluateJev()` for every fixture whose
 * deterministic cues leave it unresolved, sharing the exact budget/cost tracking the
 * prompt-routing harness uses (`./live-jev-budget.ts`). Opt-in only: never called by `bun test`.
 */
export async function runLiveResearchContinuationFixtures(
  fixtures: readonly ResearchContinuationFixture[],
  options: LiveJevRunOptions,
): Promise<readonly ResearchContinuationRunOutcome[]> {
  checkLiveJevRunOptions(options);
  const spentTracker = { totalUsd: 0 };
  const pricing = options.budget.pricing ?? JEV_PRICING_SNAPSHOT;
  const evaluate = costTrackingEvaluate(options.evaluate ?? evaluateJev, pricing, spentTracker);
  const guard = budgetGuard(spentTracker, options.budget);
  const deps: ClassifyDeps = {
    config: { apiKey: options.apiKey, timeoutMs: options.timeoutMs },
    evaluate,
  };
  const now: ResearchContinuationClock = () => performance.now();
  const outcomes: ResearchContinuationRunOutcome[] = [];
  for (const fixture of fixtures) {
    for (let runIndex = 0; runIndex < options.repeatCount; runIndex += 1) {
      if (!classifyContinuationCues(fixture.objective).resolved) guard();
      outcomes.push(
        await runResearchContinuationFixture(fixture, { ...deps, mode: "live", runIndex, now }),
      );
    }
  }
  return outcomes;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/research-continuation.jsonl", import.meta.url),
);
const DEFAULT_OUTPUT_DIR = fileURLToPath(
  new URL("./results-research-continuation", import.meta.url),
);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const io = await realEvalResultIo();
  const live = args.includes("--live");
  const outcomes = live
    ? await runLiveResearchContinuationFixtures(
        fixtures,
        readLiveJevRunOptions(args, process.env.TYPESAFE_API_KEY),
      )
    : await runFakeResearchContinuationFixtures(fixtures);
  const { resultsPath, summaryPath } = await writeEvalResults(
    outcomes,
    DEFAULT_OUTPUT_DIR,
    io,
    summarizeResearchContinuationRun,
  );
  console.log(`${live ? "live" : "fake"} mode: wrote ${resultsPath} and ${summaryPath}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
