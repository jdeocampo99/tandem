import { expect, test } from "bun:test";
import {
  type JevChoiceAnswer,
  JevEvaluationError,
  type JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import { classifyPrReviewPrompt, type PrReviewEvaluator } from "../../src/pr-review/route.ts";

const URL = "https://github.com/acme/api/pull/7";
const config = { apiKey: "key", timeoutMs: 1_500 };

function choice(value: string, options: readonly string[], confidence = 0.95): JevChoiceAnswer {
  const rest = (1 - confidence) / (options.length - 1);
  return {
    type: "choice",
    choice: value,
    confidence,
    probabilities: Object.fromEntries(
      options.map((option) => [option, option === value ? confidence : rest]),
    ),
  };
}

function answers(request: JevChoiceAnswer, lens: JevChoiceAnswer): PrReviewEvaluator {
  return async (): Promise<JevEvaluationResponse> => ({
    model: "jev",
    answers: { request, lens },
    usage: { input_tokens: 10, output_tokens: 2 },
  });
}

const REQUEST = ["review", "other"];
const LENS = ["full", "intent", "focus"];

test("a confident review request routes with the lens Jev chose", async () => {
  const intent = await classifyPrReviewPrompt(
    `just skim the idea behind ${URL}`,
    config,
    answers(choice("review", REQUEST), choice("intent", LENS)),
  );
  expect(intent.route).toEqual({ pullRequest: "acme/api#7", lens: { kind: "intent" } });
  expect(intent.usage).toBeDefined();

  const focus = await classifyPrReviewPrompt(
    `check the migration in ${URL}`,
    config,
    answers(choice("review", REQUEST), choice("focus", LENS)),
  );
  expect(focus.route?.lens).toEqual({ kind: "focus", focus: "check the migration in" });
});

test("an unsure lens becomes a full review", async () => {
  const evaluation = await classifyPrReviewPrompt(
    URL,
    config,
    answers(choice("review", REQUEST), choice("intent", LENS, 0.5)),
  );
  expect(evaluation.route?.lens).toEqual({ kind: "full" });
});

test("anything short of a confident review request goes to the coordinator", async () => {
  const other = await classifyPrReviewPrompt(
    `merge ${URL} please`,
    config,
    answers(choice("other", REQUEST), choice("full", LENS)),
  );
  expect(other.route).toBeUndefined();
  expect(other.reason).toBe("not-a-review-request");

  const unsure = await classifyPrReviewPrompt(
    URL,
    config,
    answers(choice("review", REQUEST, 0.6), choice("full", LENS)),
  );
  expect(unsure.route).toBeUndefined();

  const timedOut = await classifyPrReviewPrompt(URL, config, async () => {
    throw new JevEvaluationError("timeout", "slow");
  });
  expect(timedOut).toMatchObject({ reason: "jev-timeout" });
  expect(timedOut.route).toBeUndefined();
});

test("no Jev key and no PR link both make no call", async () => {
  let called = 0;
  const counting: PrReviewEvaluator = async () => {
    called += 1;
    throw new Error("unexpected");
  };
  expect((await classifyPrReviewPrompt(URL, { timeoutMs: 1_500 }, counting)).reason).toBe(
    "jev-not-configured",
  );
  expect((await classifyPrReviewPrompt("review the upload change", config, counting)).reason).toBe(
    "no-pr-link",
  );
  expect(called).toBe(0);
});
