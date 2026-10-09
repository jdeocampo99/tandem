import { expect, test } from "bun:test";
import { fakeEvaluatorFor } from "../../evals/fixtures.ts";
import { checkLiveJevRunOptions, readLiveJevRunOptions } from "../../evals/live-jev-budget.ts";
import { loadResearchContinuationFixtures } from "../../evals/research-continuation-fixtures.ts";
import {
  LiveJevBudgetExceededError,
  runLiveResearchContinuationFixtures,
} from "../../evals/run-research-continuation.ts";
import {
  JEV_MODEL,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
} from "../../src/adapters/typesafe.ts";

const FIXTURE_PATH = new URL("../../evals/fixtures/research-continuation.jsonl", import.meta.url)
  .pathname;
const RESPONSE = {
  model: JEV_MODEL,
  answers: {
    continuation: {
      type: "choice",
      choice: "ask-intent",
      confidence: 1,
      probabilities: { "ask-intent": 1 },
    },
  },
  usage: { input_tokens: 1_000_000, output_tokens: 0 },
} as const;

test("CLI parsing keeps first flags, trims credentials, and defers positive-value checks", () => {
  const options = readLiveJevRunOptions(
    ["--repeat", "2", "--repeat", "9", "--timeout", "1e3", "--budget", "0.1"],
    " key ",
  );
  expect(options).toEqual({
    apiKey: "key",
    repeatCount: 2,
    timeoutMs: 1_000,
    budget: { maxTotalCostUsd: 0.1 },
  });
  expect(() => checkLiveJevRunOptions(options)).not.toThrow();
  const missing = readLiveJevRunOptions([], "key");
  expect(missing).toEqual({
    apiKey: "key",
    repeatCount: 0,
    timeoutMs: 0,
    budget: { maxTotalCostUsd: 0 },
  });
  expect(() => checkLiveJevRunOptions(missing)).toThrow(
    "live Jev evaluation requires a positive integer repeat count",
  );
  expect(() => readLiveJevRunOptions(["--repeat", "NaN"], "key")).toThrow(
    "--live requires --repeat, --timeout, and --budget to all be numbers",
  );
  expect(() => readLiveJevRunOptions(["--repeat", "NaN"], " ")).toThrow(
    "--live requires TYPESAFE_API_KEY to be set",
  );
});

test("recorded Jev replay retains response identity and failure precedence", async () => {
  const input: JevEvaluationInput = { model: JEV_MODEL, state: {}, questions: {} };
  const options = { apiKey: "key", timeoutMs: 1_000 };
  await expect(
    fakeEvaluatorFor({ id: "answer", jevResponse: RESPONSE })(input, options),
  ).resolves.toBe(RESPONSE);
  const replay = fakeEvaluatorFor({
    id: "outage",
    jevResponse: RESPONSE,
    jevFailureCode: "unavailable",
  });
  await expect(replay(input, options)).rejects.toBeInstanceOf(JevEvaluationError);
  await expect(replay(input, options)).rejects.toThrow("fixture outage simulated failure");
  await expect(fakeEvaluatorFor({ id: "missing" })(input, options)).rejects.toThrow(
    "fixture missing has no recorded jevResponse or jevFailureCode",
  );
});

test("live continuation repeats in fixture order and bypasses the provider for deterministic cues", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const deterministic = fixtures.find(
    (fixture) => fixture.id === "explicit-web-research-report-only",
  );
  const unresolved = fixtures.find((fixture) => fixture.id === "jev-unavailable-ambiguous");
  if (deterministic === undefined || unresolved === undefined) throw new Error("missing fixture");
  const calls: Readonly<{ input: JevEvaluationInput; options: JevEvaluationOptions }>[] = [];
  const outcomes = await runLiveResearchContinuationFixtures([deterministic, unresolved], {
    apiKey: "key",
    timeoutMs: 2_500,
    repeatCount: 2,
    budget: { maxTotalCostUsd: 1 },
    evaluate: async (input, options) => {
      calls.push({ input, options });
      return RESPONSE;
    },
  });
  expect(outcomes.map((outcome) => [outcome.fixtureId, outcome.runIndex, outcome.mode])).toEqual([
    [deterministic.id, 0, "live"],
    [deterministic.id, 1, "live"],
    [unresolved.id, 0, "live"],
    [unresolved.id, 1, "live"],
  ]);
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.input.model).toBe(JEV_MODEL);
    expect(call.options).toEqual({ apiKey: "key", timeoutMs: 2_500 });
  }
  expect(outcomes.map((outcome) => outcome.providerOutcome)).toEqual([
    "not-attempted",
    "not-attempted",
    "success",
    "success",
  ]);
  expect(outcomes.slice(2).map((outcome) => outcome.actualDisposition)).toEqual([
    "ask-intent",
    "ask-intent",
  ]);
});

test("live continuation stops before another unresolved attempt after accumulated spend", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const unresolved = fixtures.find((fixture) => fixture.id === "jev-unavailable-ambiguous");
  if (unresolved === undefined) throw new Error("missing fixture");
  let calls = 0;
  await expect(
    runLiveResearchContinuationFixtures([unresolved, unresolved], {
      apiKey: "key",
      timeoutMs: 1_000,
      repeatCount: 2,
      budget: { maxTotalCostUsd: 0.1 },
      evaluate: async () => {
        calls += 1;
        return RESPONSE;
      },
    }),
  ).rejects.toBeInstanceOf(LiveJevBudgetExceededError);
  expect(calls).toBe(3);
});
