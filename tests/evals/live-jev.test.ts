import { expect, test } from "bun:test";
import type { PromptRoutingFixture } from "../../evals/fixtures.ts";
import { LiveJevBudgetExceededError, runLivePromptRoutingFixtures } from "../../evals/run-jev.ts";
import {
  JEV_MODEL,
  type JevEvaluationInput,
  type JevEvaluationOptions,
} from "../../src/adapters/typesafe.ts";

function fixture(id: string): PromptRoutingFixture {
  return {
    id,
    fixtureSetVersion: "test-only",
    description: "A minimal live-mode test fixture.",
    prompt: `list my tandem tasks (${id})`,
    // Ignored by live mode: it always calls the injected live caller instead of replaying this.
    jevResponse: {
      model: JEV_MODEL,
      answers: {
        action: { type: "choice", choice: "list", confidence: 1, probabilities: { list: 1 } },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    expectedRoute: "direct",
    expectedReason: "direct-read-only",
    safety: "safe-direct",
  };
}

type Call = Readonly<{ input: JevEvaluationInput; options: JevEvaluationOptions }>;

function fakeLiveCaller(usage: { inputTokens: number; outputTokens: number }, calls: Call[]) {
  return async (input: JevEvaluationInput, options: JevEvaluationOptions) => {
    calls.push({ input, options });
    return {
      model: JEV_MODEL,
      answers: {
        action: {
          type: "choice" as const,
          choice: "list",
          confidence: 1,
          probabilities: { list: 1 },
        },
        target: {
          type: "choice" as const,
          choice: "repository",
          confidence: 1,
          probabilities: { repository: 1 },
        },
        effect: {
          type: "choice" as const,
          choice: "read-only",
          confidence: 1,
          probabilities: { "read-only": 1 },
        },
        scope: {
          type: "choice" as const,
          choice: "within",
          confidence: 1,
          probabilities: { within: 1 },
        },
        composition: {
          type: "choice" as const,
          choice: "single",
          confidence: 1,
          probabilities: { single: 1 },
        },
      },
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    };
  };
}

test("rejects an empty API key before making any call", async () => {
  const calls: Call[] = [];
  await expect(
    runLivePromptRoutingFixtures([fixture("a")], {
      apiKey: "  ",
      timeoutMs: 1_000,
      repeatCount: 1,
      budget: { maxTotalCostUsd: 1 },
      evaluate: fakeLiveCaller({ inputTokens: 1, outputTokens: 0 }, calls),
    }),
  ).rejects.toThrow(/API key/);
  expect(calls).toHaveLength(0);
});

test("rejects a non-positive-integer repeat count", async () => {
  await expect(
    runLivePromptRoutingFixtures([fixture("a")], {
      apiKey: "key",
      timeoutMs: 1_000,
      repeatCount: 0,
      budget: { maxTotalCostUsd: 1 },
      evaluate: fakeLiveCaller({ inputTokens: 1, outputTokens: 0 }, []),
    }),
  ).rejects.toThrow(/repeat count/);
});

test("rejects a non-positive timeout", async () => {
  await expect(
    runLivePromptRoutingFixtures([fixture("a")], {
      apiKey: "key",
      timeoutMs: 0,
      repeatCount: 1,
      budget: { maxTotalCostUsd: 1 },
      evaluate: fakeLiveCaller({ inputTokens: 1, outputTokens: 0 }, []),
    }),
  ).rejects.toThrow(/timeout/);
});

test("rejects a non-positive budget", async () => {
  await expect(
    runLivePromptRoutingFixtures([fixture("a")], {
      apiKey: "key",
      timeoutMs: 1_000,
      repeatCount: 1,
      budget: { maxTotalCostUsd: 0 },
      evaluate: fakeLiveCaller({ inputTokens: 1, outputTokens: 0 }, []),
    }),
  ).rejects.toThrow(/budget/);
});

test("pins every live call to jev-1.13.0 and passes the explicit timeout through", async () => {
  const calls: Call[] = [];
  await runLivePromptRoutingFixtures([fixture("a"), fixture("b")], {
    apiKey: "key",
    timeoutMs: 2_500,
    repeatCount: 2,
    budget: { maxTotalCostUsd: 1_000 },
    evaluate: fakeLiveCaller({ inputTokens: 1, outputTokens: 0 }, calls),
  });
  expect(calls).toHaveLength(4);
  for (const call of calls) {
    expect(call.input.model).toBe(JEV_MODEL);
    expect(call.options.timeoutMs).toBe(2_500);
  }
});

test("repeats each fixture exactly the requested number of times, in order", async () => {
  const calls: Call[] = [];
  const outcomes = await runLivePromptRoutingFixtures([fixture("a"), fixture("b")], {
    apiKey: "key",
    timeoutMs: 1_000,
    repeatCount: 3,
    budget: { maxTotalCostUsd: 1_000 },
    evaluate: fakeLiveCaller({ inputTokens: 1, outputTokens: 0 }, calls),
  });
  expect(calls).toHaveLength(6);
  expect(outcomes).toHaveLength(6);
  expect(
    outcomes.filter((outcome) => outcome.fixtureId === "a").map((outcome) => outcome.runIndex),
  ).toEqual([0, 1, 2]);
  expect(
    outcomes.filter((outcome) => outcome.fixtureId === "b").map((outcome) => outcome.runIndex),
  ).toEqual([0, 1, 2]);
  expect(outcomes.every((outcome) => outcome.mode === "live")).toBe(true);
});

test("stops before the call that would exceed the budget and fails the run", async () => {
  const calls: Call[] = [];
  // Each call reports 1,000,000 input tokens, costing $0.042 at the pinned Jev rate.
  const evaluate = fakeLiveCaller({ inputTokens: 1_000_000, outputTokens: 0 }, calls);
  const attempt = runLivePromptRoutingFixtures([fixture("a"), fixture("b")], {
    apiKey: "key",
    timeoutMs: 1_000,
    repeatCount: 2,
    budget: { maxTotalCostUsd: 0.1 },
    evaluate,
  });
  await expect(attempt).rejects.toBeInstanceOf(LiveJevBudgetExceededError);
  // 3 calls succeed ($0.126 spent); the 4th is blocked before it would be made.
  expect(calls).toHaveLength(3);
});
