import { expect, test } from "bun:test";
import {
  JEV_MODEL,
  type JevChoiceAnswer,
  type JevEvaluationInput,
  type JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import {
  classifyPullUpPrompt,
  mentionsPullUp,
  type PullUpCandidate,
  type PullUpEvaluator,
} from "../../src/session/pull-up-route.ts";

const config = { apiKey: "key", timeoutMs: 1_500 };
const CANDIDATES: readonly PullUpCandidate[] = [
  { kind: "presentation", id: "presentation-1", about: "Mock up the settings page" },
  { kind: "brief", id: "req-1", about: "Add a settings page" },
];
const TARGETS = ["c1", "c2", "none"];

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

function answers(
  request: JevChoiceAnswer,
  target: JevChoiceAnswer,
  seen: JevEvaluationInput[] = [],
): PullUpEvaluator {
  return async (input): Promise<JevEvaluationResponse> => {
    seen.push(input);
    return {
      model: "jev",
      answers: { request, target },
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  };
}

test("only prompts that name a brief or a visual are screened in", () => {
  expect(mentionsPullUp("pull up the mockup for the settings page")).toBe(true);
  expect(mentionsPullUp("can you open the brief for cancellation")).toBe(true);
  expect(mentionsPullUp("add a settings page")).toBe(false);
  expect(mentionsPullUp("what is the brief about")).toBe(false);
});

test("a confident open request resolves to the listed item Jev chose", async () => {
  const seen: JevEvaluationInput[] = [];
  const mockup = await classifyPullUpPrompt(
    "pull up the settings mockup",
    CANDIDATES,
    config,
    answers(choice("open", ["open", "other"]), choice("c1", TARGETS), seen),
  );
  expect(mockup.target).toEqual(CANDIDATES[0]);
  expect(mockup.usage).toBeDefined();
  expect(JSON.stringify(seen[0]?.questions.target)).toContain("Mock up the settings page");

  const brief = await classifyPullUpPrompt(
    "show me the settings brief",
    CANDIDATES,
    config,
    answers(choice("open", ["open", "other"]), choice("c2", TARGETS)),
  );
  expect(brief.target).toEqual(CANDIDATES[1]);
});

test("anything short of one confident match goes back to the coordinator", async () => {
  const other = await classifyPullUpPrompt(
    "open the brief and approve it",
    CANDIDATES,
    config,
    answers(choice("other", ["open", "other"]), choice("c2", TARGETS)),
  );
  expect(other.target).toBeUndefined();
  expect(other.reason).toBe("not-a-pull-up");

  const none = await classifyPullUpPrompt(
    "pull up the billing mockup",
    CANDIDATES,
    config,
    answers(choice("open", ["open", "other"]), choice("none", TARGETS)),
  );
  expect(none.target).toBeUndefined();

  const unsure = await classifyPullUpPrompt(
    "pull up the settings thing",
    CANDIDATES,
    config,
    answers(choice("open", ["open", "other"]), choice("c1", TARGETS, 0.6)),
  );
  expect(unsure.target).toBeUndefined();
  expect(unsure.reason).toBe("no-confident-match");
});

test("no candidates or no API key skips Jev", async () => {
  const seen: JevEvaluationInput[] = [];
  const evaluate = answers(choice("open", ["open", "other"]), choice("c1", TARGETS), seen);
  expect((await classifyPullUpPrompt("pull up the mockup", [], config, evaluate)).reason).toBe(
    "no-candidates",
  );
  expect(
    (await classifyPullUpPrompt("pull up the mockup", CANDIDATES, { timeoutMs: 1_500 }, evaluate))
      .reason,
  ).toBe("jev-not-configured");
  expect(seen).toHaveLength(0);
});

test("the configured fetch carries the Jev request", async () => {
  const seen: JevEvaluationInput[] = [];
  const reply = answers(choice("open", ["open", "other"]), choice("c2", TARGETS), seen);
  const result = await classifyPullUpPrompt("pull up the settings brief", CANDIDATES, {
    ...config,
    fetch: async (_endpoint, init) => {
      const response = await reply(JSON.parse(String(init?.body)) as JevEvaluationInput, config);
      return new Response(JSON.stringify({ ...response, model: JEV_MODEL }));
    },
  });
  expect(seen).toHaveLength(1);
  expect(result.target).toEqual(CANDIDATES[1]);
});
