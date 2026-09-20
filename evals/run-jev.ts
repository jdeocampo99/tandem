/**
 * Fixture-driven Jev routing evaluation runner.
 *
 * This module exercises the production routing policy in `src/extension/prompt-routing.ts`
 * (`classifyPrompt` for classification fixtures, `handlePromptInput` for bypass fixtures) against
 * either recorded typed Jev responses (fake mode, deterministic, no network) or the pinned live
 * `jev-1.13.0` model (live mode, opt-in only). It never reimplements the routing policy itself,
 * and it never touches a production Tandem home: bypass fixtures run against an ephemeral
 * temporary home created and destroyed per fixture.
 *
 * Token usage and cost accounting reuse `src/runtime/usage.ts` (`UsageRecord`,
 * `calculateUsageCost`, `JEV_PRICING_SNAPSHOT`) rather than a second accounting path.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, InputEvent } from "@oh-my-pi/pi-coding-agent";
import {
  evaluateJev,
  JEV_MODEL,
  JevEvaluationError,
  type JevEvaluationResponse,
} from "../src/adapters/typesafe.ts";
import {
  choiceConfidence,
  classifyPrompt,
  extractPromptTaskId,
  handlePromptInput,
  PROMPT_ROUTING_QUESTION_SCHEMA_VERSION,
  type PromptRoutingClock,
  type PromptRoutingConfig,
  type PromptRoutingDependencies,
  type PromptRoutingEvaluation,
} from "../src/extension/prompt-routing.ts";
import { readPromptRoutingLog } from "../src/runtime/diagnostics.ts";
import { JEV_PRICING_SNAPSHOT } from "../src/runtime/usage.ts";
import {
  loadPromptRoutingFixtures,
  type PromptRoutingExpectedDecision,
  type PromptRoutingFixture,
} from "./fixtures.ts";
import {
  budgetGuard,
  checkLiveJevRunOptions,
  costTrackingEvaluate,
  type LiveJevBudget,
  LiveJevBudgetExceededError,
  type LiveJevCaller,
  type LiveJevRunOptions,
} from "./live-jev-budget.ts";
import { summarizePromptRoutingRun } from "./summarize.ts";
import type {
  PromptRoutingFieldMatches,
  PromptRoutingProviderOutcome,
  PromptRoutingRunOutcome,
} from "./types.ts";
import { type EvalResultIo, realEvalResultIo, writeEvalResults } from "./write-results.ts";

export type {
  LiveJevBudget,
  LiveJevCaller,
  LiveJevRunOptions,
  PromptRoutingFieldMatches,
  PromptRoutingProviderOutcome,
  PromptRoutingRunOutcome,
};
export { LiveJevBudgetExceededError };

export type EphemeralHome = Readonly<{
  readonly home: string;
  readonly cleanup: () => Promise<void>;
}>;

export type BuildEvaluate = (
  fixture: PromptRoutingFixture,
) => NonNullable<PromptRoutingDependencies["evaluate"]>;

export type PromptRoutingRunOptions = Readonly<{
  readonly mode: "fake" | "live";
  readonly config: PromptRoutingConfig;
  readonly buildEvaluate: BuildEvaluate;
  readonly createHome?: () => Promise<EphemeralHome>;
  /** Only meaningful for classification fixtures; bypass fixtures always run once. */
  readonly repeatCount?: number;
  /**
   * Called immediately before each classification attempt; throw to stop the run before it makes
   * that call. Used by live mode to enforce its budget outside of `evaluate` itself, since
   * `classifyPrompt` catches and reinterprets anything `evaluate` throws as a provider failure.
   */
  readonly beforeClassify?: () => void;
  /**
   * The duration clock for every outcome in this run, threaded into `classifyPrompt` itself (so
   * its nested usage record's duration comes from the same clock) and used for bypass-fixture
   * timing. Defaults to the real monotonic clock; fake mode passes a fixed clock so two runs with
   * the same fixtures are byte-identical.
   */
  readonly now?: PromptRoutingClock;
}>;

const FAKE_CONTEXT = { hasUI: false, mode: "rpc" } as unknown as ExtensionContext;
const DEFAULT_FAKE_TIMEOUT_MS = 1_500;

export const FAKE_FIXTURE_CONFIG: PromptRoutingConfig = {
  apiKey: "fixture-key",
  timeoutMs: DEFAULT_FAKE_TIMEOUT_MS,
};

export async function createEphemeralHome(): Promise<EphemeralHome> {
  const home = await mkdtemp(join(tmpdir(), "tandem-jev-eval-"));
  return { home, cleanup: async () => rm(home, { recursive: true, force: true }) };
}

function fakeEvaluatorFor(
  fixture: PromptRoutingFixture,
): NonNullable<PromptRoutingDependencies["evaluate"]> {
  return async () => {
    if (fixture.jevFailureCode !== undefined) {
      throw new JevEvaluationError(
        fixture.jevFailureCode,
        `fixture ${fixture.id} simulated failure`,
      );
    }
    if (fixture.jevResponse === undefined) {
      throw new Error(`fixture ${fixture.id} has no recorded jevResponse or jevFailureCode`);
    }
    return fixture.jevResponse;
  };
}

function recordingEvaluate(evaluate: NonNullable<PromptRoutingDependencies["evaluate"]>): Readonly<{
  readonly evaluate: NonNullable<PromptRoutingDependencies["evaluate"]>;
  readonly getRawResponse: () => JevEvaluationResponse | undefined;
}> {
  let rawResponse: JevEvaluationResponse | undefined;
  const wrapped: NonNullable<PromptRoutingDependencies["evaluate"]> = async (input, options) => {
    const response = await evaluate(input, options);
    rawResponse = response;
    return response;
  };
  return { evaluate: wrapped, getRawResponse: () => rawResponse };
}

function classifyProviderOutcome(
  evaluation: PromptRoutingEvaluation,
): PromptRoutingProviderOutcome {
  if (evaluation.classifier === "disabled") return "not-attempted";
  if (evaluation.reason === "jev-timeout") return "timeout";
  const failureReasons = [
    "jev-unavailable",
    "jev-invalid-response",
    "jev-invalid-request",
    "jev-error",
  ];
  return failureReasons.includes(evaluation.reason) ? "error" : "success";
}

function extractChoice(
  response: JevEvaluationResponse | undefined,
  id: string,
): string | undefined {
  const answer = response?.answers[id];
  return answer?.type === "choice" ? answer.choice : undefined;
}

function computeFieldMatches(
  expected: PromptRoutingExpectedDecision | undefined,
  rawResponse: JevEvaluationResponse | undefined,
  prompt: string,
): PromptRoutingFieldMatches | undefined {
  if (expected === undefined) return undefined;
  const matches: Record<string, boolean> = {};
  const fields = ["action", "target", "effect", "scope", "composition"] as const;
  for (const field of fields) {
    const expectedValue = expected[field];
    if (expectedValue === undefined) continue;
    matches[field] = expectedValue === extractChoice(rawResponse, field);
  }
  if (expected.taskId !== undefined) {
    matches.taskId = expected.taskId === extractPromptTaskId(prompt);
  }
  return matches;
}

/**
 * The routed confidence Jev would carry into a decision, combining all five fields the same way
 * `classifyPrompt` does. Reuses the exported `choiceConfidence` helper rather than re-deriving the
 * combination formula, so calibration analysis never drifts from production behavior.
 */
function computeCombinedConfidence(
  rawResponse: JevEvaluationResponse | undefined,
): number | undefined {
  if (rawResponse === undefined) return undefined;
  const confidences: number[] = [];
  for (const id of ["action", "target", "effect", "scope", "composition"]) {
    const answer = rawResponse.answers[id];
    if (answer === undefined || answer.type !== "choice") return undefined;
    const confidence = choiceConfidence(answer);
    if (confidence === undefined) return undefined;
    confidences.push(confidence);
  }
  return Math.min(...confidences);
}

async function runClassificationFixture(
  fixture: PromptRoutingFixture,
  config: PromptRoutingConfig,
  buildEvaluate: BuildEvaluate,
  mode: "fake" | "live",
  runIndex: number,
  now: PromptRoutingClock,
): Promise<PromptRoutingRunOutcome> {
  const { evaluate, getRawResponse } = recordingEvaluate(buildEvaluate(fixture));
  const evaluation = await classifyPrompt(fixture.prompt, config, evaluate, now);
  const rawResponse = getRawResponse();
  const fieldMatches = computeFieldMatches(fixture.expectedDecision, rawResponse, fixture.prompt);
  const combinedConfidence = computeCombinedConfidence(rawResponse);
  return {
    fixtureId: fixture.id,
    fixtureSetVersion: fixture.fixtureSetVersion,
    mode,
    runIndex,
    modelVersion: JEV_MODEL,
    requestSchemaVersion: PROMPT_ROUTING_QUESTION_SCHEMA_VERSION,
    safety: fixture.safety,
    expectedRoute: fixture.expectedRoute,
    actualRoute: evaluation.decision === undefined ? "fallback" : "direct",
    expectedReason: fixture.expectedReason,
    actualReason: evaluation.reason,
    ...(fixture.expectedDecision === undefined
      ? {}
      : { expectedDecision: fixture.expectedDecision }),
    ...(evaluation.decision === undefined ? {} : { actualDecision: evaluation.decision }),
    ...(fieldMatches === undefined ? {} : { fieldMatches }),
    providerOutcome: classifyProviderOutcome(evaluation),
    ...(combinedConfidence === undefined ? {} : { combinedConfidence }),
    ...(rawResponse === undefined ? {} : { rawResponse }),
    ...(evaluation.usage === undefined ? {} : { usage: evaluation.usage }),
    durationMs: evaluation.durationMs,
  };
}

async function runBypassFixture(
  fixture: PromptRoutingFixture,
  createHome: () => Promise<EphemeralHome>,
  mode: "fake" | "live",
  now: PromptRoutingClock,
): Promise<PromptRoutingRunOutcome> {
  const { home, cleanup } = await createHome();
  const startedAt = now();
  let evaluateCalls = 0;
  try {
    const event = {
      source: "interactive",
      text: fixture.prompt,
      ...(fixture.bypass === "image"
        ? { images: [{ type: "image", mimeType: "image/png", data: "" }] }
        : {}),
    } as InputEvent;
    await handlePromptInput(event, FAKE_CONTEXT, {
      config: { apiKey: "fixture-key", timeoutMs: DEFAULT_FAKE_TIMEOUT_MS },
      getService: () => {
        throw new Error(
          `fixture ${fixture.id}: a bypassed prompt must never reach the Tandem service`,
        );
      },
      getHome: () => home,
      sendMessage: (() => undefined) as never,
      evaluate: async () => {
        evaluateCalls += 1;
        throw new Error(`fixture ${fixture.id}: a bypassed prompt must never call Jev`);
      },
      now,
    });
    if (evaluateCalls > 0) {
      throw new Error(`fixture ${fixture.id}: bypass leaked into Jev evaluation`);
    }
    const log = await readPromptRoutingLog(home);
    const bypassed = log
      .map((line) => JSON.parse(line) as { event: string; details?: { reason?: string } })
      .find((entry) => entry.event === "prompt-route-bypassed");
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    return {
      fixtureId: fixture.id,
      fixtureSetVersion: fixture.fixtureSetVersion,
      mode,
      runIndex: 0,
      modelVersion: JEV_MODEL,
      requestSchemaVersion: PROMPT_ROUTING_QUESTION_SCHEMA_VERSION,
      safety: fixture.safety,
      expectedRoute: fixture.expectedRoute,
      actualRoute: "fallback",
      expectedReason: fixture.expectedReason,
      actualReason: bypassed?.details?.reason ?? "not-bypassed",
      providerOutcome: "not-attempted",
      durationMs,
    };
  } finally {
    await cleanup();
  }
}

/** Runs every fixture through the production routing policy and returns one outcome per attempt. */
export async function runPromptRoutingFixtures(
  fixtures: readonly PromptRoutingFixture[],
  options: PromptRoutingRunOptions,
): Promise<readonly PromptRoutingRunOutcome[]> {
  const repeatCount = options.repeatCount ?? 1;
  if (!Number.isSafeInteger(repeatCount) || repeatCount < 1) {
    throw new RangeError("repeatCount must be a positive integer");
  }
  const createHome = options.createHome ?? createEphemeralHome;
  const now = options.now ?? (() => performance.now());
  const outcomes: PromptRoutingRunOutcome[] = [];
  for (const fixture of fixtures) {
    if (fixture.bypass !== undefined) {
      outcomes.push(await runBypassFixture(fixture, createHome, options.mode, now));
      continue;
    }
    for (let runIndex = 0; runIndex < repeatCount; runIndex += 1) {
      options.beforeClassify?.();
      outcomes.push(
        await runClassificationFixture(
          fixture,
          options.config,
          options.buildEvaluate,
          options.mode,
          runIndex,
          now,
        ),
      );
    }
  }
  return outcomes;
}

/**
 * Fake mode: deterministic, no network, safe for `bun test`. Uses a fixed clock rather than the
 * real one, since fake mode never makes a real provider call and so has no real latency to
 * measure: every duration (the outcome's own and its nested usage record's) is therefore always
 * zero, and two fake runs over the same fixtures are byte-identical.
 */
export async function runFakePromptRoutingFixtures(
  fixtures: readonly PromptRoutingFixture[],
): Promise<readonly PromptRoutingRunOutcome[]> {
  return runPromptRoutingFixtures(fixtures, {
    mode: "fake",
    config: FAKE_FIXTURE_CONFIG,
    buildEvaluate: fakeEvaluatorFor,
    now: () => 0,
  });
}

/**
 * Live mode: calls the pinned `jev-1.13.0` model through `evaluateJev()` (via `classifyPrompt`,
 * never reimplemented) with an explicit repeat count, timeout, and budget. Stops before any call
 * that would be made once cumulative spend has reached the budget, throwing
 * `LiveJevBudgetExceededError` instead of silently truncating results. Opt-in only: this function
 * is never called by `bun test`, and the CLI entry point below only reaches it behind an explicit
 * `--live` flag plus a `TYPESAFE_API_KEY`.
 */
/**
 * A `provider-failure` fixture scripts an outage for an otherwise ordinary prompt. The real
 * provider cannot be made to fail on demand, so live it would answer normally and be scored as
 * a false direct route. Live runs therefore leave these fixtures to fake mode.
 */
export function liveEligibleFixtures(
  fixtures: readonly PromptRoutingFixture[],
): readonly PromptRoutingFixture[] {
  return fixtures.filter((fixture) => fixture.safety !== "provider-failure");
}

export async function runLivePromptRoutingFixtures(
  fixtures: readonly PromptRoutingFixture[],
  options: LiveJevRunOptions,
): Promise<readonly PromptRoutingRunOutcome[]> {
  checkLiveJevRunOptions(options);
  const spentTracker = { totalUsd: 0 };
  const pricing = options.budget.pricing ?? JEV_PRICING_SNAPSHOT;
  const evaluate = costTrackingEvaluate(options.evaluate ?? evaluateJev, pricing, spentTracker);
  return runPromptRoutingFixtures(liveEligibleFixtures(fixtures), {
    mode: "live",
    config: { apiKey: options.apiKey, timeoutMs: options.timeoutMs },
    buildEvaluate: () => evaluate,
    repeatCount: options.repeatCount,
    beforeClassify: budgetGuard(spentTracker, options.budget),
  });
}

/** Writes JSONL results plus a concise, comparable summary. Never called by `bun test`. */
export async function writePromptRoutingResults(
  outcomes: readonly PromptRoutingRunOutcome[],
  outputDir: string,
  io: EvalResultIo,
): Promise<Readonly<{ resultsPath: string; summaryPath: string }>> {
  return writeEvalResults(outcomes, outputDir, io, summarizePromptRoutingRun);
}

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/prompt-routing.jsonl", import.meta.url));
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL("./results", import.meta.url));

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const io = await realEvalResultIo();
  if (!args.includes("--live")) {
    const outcomes = await runFakePromptRoutingFixtures(fixtures);
    const { resultsPath, summaryPath } = await writePromptRoutingResults(
      outcomes,
      DEFAULT_OUTPUT_DIR,
      io,
    );
    console.log(`fake mode: wrote ${resultsPath} and ${summaryPath}`);
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("--live requires TYPESAFE_API_KEY to be set");
  }
  const repeatCount = Number(readFlag(args, "--repeat") ?? "");
  const timeoutMs = Number(readFlag(args, "--timeout") ?? "");
  const maxTotalCostUsd = Number(readFlag(args, "--budget") ?? "");
  if (
    !Number.isFinite(repeatCount) ||
    !Number.isFinite(timeoutMs) ||
    !Number.isFinite(maxTotalCostUsd)
  ) {
    throw new Error("--live requires --repeat, --timeout, and --budget to all be numbers");
  }
  const outcomes = await runLivePromptRoutingFixtures(fixtures, {
    apiKey,
    timeoutMs,
    repeatCount,
    budget: { maxTotalCostUsd },
  });
  const { resultsPath, summaryPath } = await writePromptRoutingResults(
    outcomes,
    DEFAULT_OUTPUT_DIR,
    io,
  );
  console.log(`live mode: wrote ${resultsPath} and ${summaryPath}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
