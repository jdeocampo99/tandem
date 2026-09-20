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

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type PromptRoutingConfig,
  type PromptRoutingDependencies,
  type PromptRoutingEvaluation,
} from "../src/extension/prompt-routing.ts";
import { readPromptRoutingLog } from "../src/runtime/diagnostics.ts";
import {
  calculateUsageCost,
  JEV_PRICING_SNAPSHOT,
  type PricingSnapshot,
} from "../src/runtime/usage.ts";
import {
  loadPromptRoutingFixtures,
  type PromptRoutingExpectedDecision,
  type PromptRoutingFixture,
} from "./fixtures.ts";
import { summarizePromptRoutingRun } from "./summarize.ts";
import type {
  PromptRoutingFieldMatches,
  PromptRoutingProviderOutcome,
  PromptRoutingRunOutcome,
} from "./types.ts";

export type { PromptRoutingFieldMatches, PromptRoutingProviderOutcome, PromptRoutingRunOutcome };

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
): Promise<PromptRoutingRunOutcome> {
  const { evaluate, getRawResponse } = recordingEvaluate(buildEvaluate(fixture));
  const evaluation = await classifyPrompt(fixture.prompt, config, evaluate);
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
): Promise<PromptRoutingRunOutcome> {
  const { home, cleanup } = await createHome();
  const startedAt = performance.now();
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
    });
    if (evaluateCalls > 0) {
      throw new Error(`fixture ${fixture.id}: bypass leaked into Jev evaluation`);
    }
    const log = await readPromptRoutingLog(home);
    const bypassed = log
      .map((line) => JSON.parse(line) as { event: string; details?: { reason?: string } })
      .find((entry) => entry.event === "prompt-route-bypassed");
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
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
  const outcomes: PromptRoutingRunOutcome[] = [];
  for (const fixture of fixtures) {
    if (fixture.bypass !== undefined) {
      outcomes.push(await runBypassFixture(fixture, createHome, options.mode));
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
        ),
      );
    }
  }
  return outcomes;
}

/** Fake mode: deterministic, no network, safe for `bun test`. */
export async function runFakePromptRoutingFixtures(
  fixtures: readonly PromptRoutingFixture[],
): Promise<readonly PromptRoutingRunOutcome[]> {
  return runPromptRoutingFixtures(fixtures, {
    mode: "fake",
    config: FAKE_FIXTURE_CONFIG,
    buildEvaluate: fakeEvaluatorFor,
  });
}

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

export type LiveJevRunOptions = Readonly<{
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly repeatCount: number;
  readonly budget: LiveJevBudget;
  /** Injected Jev caller; defaults to the real network call. Tests inject a fake caller. */
  readonly evaluate?: LiveJevCaller;
}>;

/** Measures and accumulates spend per call. Never throws: the budget is enforced by the caller. */
function costTrackingEvaluate(
  evaluate: LiveJevCaller,
  pricing: PricingSnapshot,
  spentTracker: { totalUsd: number },
): NonNullable<PromptRoutingDependencies["evaluate"]> {
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

/**
 * Live mode: calls the pinned `jev-1.13.0` model through `evaluateJev()` (via `classifyPrompt`,
 * never reimplemented) with an explicit repeat count, timeout, and budget. Stops before any call
 * that would be made once cumulative spend has reached the budget, throwing
 * `LiveJevBudgetExceededError` instead of silently truncating results. Opt-in only: this function
 * is never called by `bun test`, and the CLI entry point below only reaches it behind an explicit
 * `--live` flag plus a `TYPESAFE_API_KEY`.
 */
export async function runLivePromptRoutingFixtures(
  fixtures: readonly PromptRoutingFixture[],
  options: LiveJevRunOptions,
): Promise<readonly PromptRoutingRunOutcome[]> {
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
  const spentTracker = { totalUsd: 0 };
  const pricing = options.budget.pricing ?? JEV_PRICING_SNAPSHOT;
  const evaluate = costTrackingEvaluate(options.evaluate ?? evaluateJev, pricing, spentTracker);
  return runPromptRoutingFixtures(fixtures, {
    mode: "live",
    config: { apiKey: options.apiKey, timeoutMs: options.timeoutMs },
    buildEvaluate: () => evaluate,
    repeatCount: options.repeatCount,
    beforeClassify: () => {
      if (spentTracker.totalUsd >= options.budget.maxTotalCostUsd) {
        throw new LiveJevBudgetExceededError(spentTracker.totalUsd, options.budget.maxTotalCostUsd);
      }
    },
  });
}

export type PromptRoutingResultIo = Readonly<{
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
}>;

/** Writes JSONL results plus a concise, comparable summary. Never called by `bun test`. */
export async function writePromptRoutingResults(
  outcomes: readonly PromptRoutingRunOutcome[],
  outputDir: string,
  io: PromptRoutingResultIo,
): Promise<Readonly<{ resultsPath: string; summaryPath: string }>> {
  await io.mkdir(outputDir);
  const resultsPath = join(outputDir, "results.jsonl");
  const summaryPath = join(outputDir, "summary.json");
  const lines = outcomes.map((outcome) => JSON.stringify(outcome));
  await io.writeFile(resultsPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  const summary = summarizePromptRoutingRun(outcomes);
  await io.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { resultsPath, summaryPath };
}

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/prompt-routing.jsonl", import.meta.url));
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL("./results", import.meta.url));

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function realIo(): Promise<PromptRoutingResultIo> {
  return {
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    writeFile: async (path, contents) => {
      await writeFile(path, contents, "utf8");
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const io = await realIo();
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
