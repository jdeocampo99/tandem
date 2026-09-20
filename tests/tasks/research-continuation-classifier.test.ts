import { expect, test } from "bun:test";
import {
  JEV_MODEL,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import type { ResearchContinuationDisposition } from "../../src/contracts.ts";
import { checkResearchContinuation } from "../../src/tasks/research-continuation.ts";
import {
  classifyContinuationCues,
  classifyResearchContinuation,
  MAX_CLASSIFIED_OBJECTIVE_CHARS,
  RESEARCH_CONTINUATION_CLASSIFIER_VERSION,
  RESEARCH_CONTINUATION_CONFIDENCE_THRESHOLD,
  type ResearchContinuationClassification,
  type ResearchContinuationReason,
  researchContinuationClassifier,
  researchContinuationClassifierConfig,
} from "../../src/tasks/research-continuation-classifier.ts";

const DISPOSITIONS: readonly ResearchContinuationDisposition[] = [
  "report-only",
  "ask-intent",
  "implementation-interview",
];

const CONFIG = { apiKey: "typesafe-key", timeoutMs: 1_500 } as const;

function isStateRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jevChoice(choice: string, confidence = 0.95): JevEvaluationResponse {
  const remainder = (1 - confidence) / (DISPOSITIONS.length - 1);
  const probabilities: Record<string, number> = {};
  for (const option of DISPOSITIONS) {
    probabilities[option] = option === choice ? confidence : remainder;
  }
  return {
    model: JEV_MODEL,
    answers: { continuation: { type: "choice", choice, confidence, probabilities } },
    usage: { input_tokens: 21, output_tokens: 3 },
  };
}

function counting(response: () => Promise<JevEvaluationResponse>): {
  readonly evaluate: (
    input: JevEvaluationInput,
    options: JevEvaluationOptions,
  ) => Promise<JevEvaluationResponse>;
  readonly calls: JevEvaluationInput[];
} {
  const calls: JevEvaluationInput[] = [];
  return {
    calls,
    evaluate: async (input) => {
      calls.push(input);
      return response();
    },
  };
}

async function classifyWithoutProvider(
  objective: string,
): Promise<ResearchContinuationClassification> {
  const provider = counting(async () => jevChoice("implementation-interview"));
  const classification = await classifyResearchContinuation(
    { objective, taskKind: "scout" },
    CONFIG,
    provider.evaluate,
  );
  expect(provider.calls).toEqual([]);
  return classification;
}

test("explicit cues resolve deterministically without any provider call", async () => {
  const fixtures: readonly Readonly<{
    objective: string;
    disposition: ResearchContinuationDisposition;
    reason: ResearchContinuationReason;
  }>[] = [
    {
      objective:
        "Research how Cloudflare Durable Objects handle WebSocket hibernation and summarize the tradeoffs",
      disposition: "report-only",
      reason: "explicit-report-only",
    },
    {
      objective: "Look up the current Bun snapshot testing API for the docs page",
      disposition: "report-only",
      reason: "explicit-report-only",
    },
    {
      objective: "Investigate the flaky worker timeout and then fix it",
      disposition: "implementation-interview",
      reason: "explicit-implementation",
    },
    {
      objective: "Research ticket TAN-42 and prepare a patch for the scheduler",
      disposition: "implementation-interview",
      reason: "explicit-implementation",
    },
    {
      objective: "Research only, do not change anything, then implement the fix",
      disposition: "ask-intent",
      reason: "contradictory-cues",
    },
    { objective: "   ", disposition: "ask-intent", reason: "empty-objective" },
  ];

  for (const fixture of fixtures) {
    const classification = await classifyWithoutProvider(fixture.objective);
    expect(classification.reason).toBe(fixture.reason);
    expect(classification.continuation).toEqual({
      schemaVersion: 1,
      disposition: fixture.disposition,
      selectedBy: "deterministic",
    });
    expect(classification.usage).toBeUndefined();
    expect(checkResearchContinuation(classification.continuation).valid).toBe(true);
  }
});

test("ambiguous wording is unresolved by the rules and answered through the classifier seam", async () => {
  const ambiguous = ["Research this ticket", "Research TAN-42 and recommend an approach"] as const;
  for (const objective of ambiguous) {
    expect(classifyContinuationCues(objective)).toEqual({ resolved: false });
  }

  const provider = counting(async () => jevChoice("implementation-interview"));
  const classification = await classifyResearchContinuation(
    { objective: ambiguous[0], taskKind: "scout" },
    CONFIG,
    provider.evaluate,
  );
  expect(provider.calls.length).toBe(1);
  expect(classification.reason).toBe("jev-classified");
  expect(classification.continuation).toEqual({
    schemaVersion: 1,
    disposition: "implementation-interview",
    selectedBy: "jev",
    classifierVersion: RESEARCH_CONTINUATION_CLASSIFIER_VERSION,
  });
  expect(classification.usage).toEqual({ input_tokens: 21, output_tokens: 3 });
  expect(checkResearchContinuation(classification.continuation).valid).toBe(true);
});

test("the Jev request carries only the bounded sanitized objective and task kind", async () => {
  const noisy = [
    "Research this ticket",
    String.fromCharCode(0),
    String.fromCharCode(9),
    "\n  spread   over lines ",
    "z".repeat(MAX_CLASSIFIED_OBJECTIVE_CHARS * 2),
  ].join("");
  const provider = counting(async () => jevChoice("ask-intent"));
  let seenOptions: JevEvaluationOptions | undefined;
  await classifyResearchContinuation(
    { objective: noisy, taskKind: "scout" },
    { ...CONFIG, timeoutMs: 900 },
    async (input, options) => {
      seenOptions = options;
      return provider.evaluate(input, options);
    },
  );

  const request = provider.calls[0];
  if (request === undefined) throw new Error("the classifier made no request");
  expect(request.model).toBe(JEV_MODEL);
  expect(Object.keys(request.questions)).toEqual(["continuation"]);
  const question = request.questions.continuation;
  if (question === undefined || question.type !== "choice") {
    throw new Error("the continuation question is not a closed-set choice");
  }
  expect(Object.keys(question.criteria).sort()).toEqual([...DISPOSITIONS].sort());

  const state = request.state;
  if (!isStateRecord(state)) throw new Error("the classifier state must be a record");
  expect(Object.keys(state).sort()).toEqual(["objective", "taskKind"]);
  expect(state.taskKind).toBe("scout");
  const objective = state.objective;
  if (typeof objective !== "string") throw new Error("the classifier state lost its objective");
  expect(objective.length).toBe(MAX_CLASSIFIED_OBJECTIVE_CHARS);
  expect(objective.startsWith("Research this ticket spread over lines z")).toBe(true);
  expect(/\p{Cc}|\p{Zl}|\p{Zp}|\s\s/u.test(objective)).toBe(false);
  expect(seenOptions).toEqual({ apiKey: "typesafe-key", timeoutMs: 900 });
});

test("unusable classifier outcomes all record a durable conservative ask-intent", async () => {
  const malformed: JevEvaluationResponse = {
    model: JEV_MODEL,
    answers: { continuation: { type: "noul", noul: 0.4 } },
    usage: { input_tokens: 9, output_tokens: 1 },
  };
  const unknownChoice: JevEvaluationResponse = {
    model: JEV_MODEL,
    answers: {
      continuation: {
        type: "choice",
        choice: "implement-now",
        confidence: 0.99,
        probabilities: { "implement-now": 1 },
      },
    },
    usage: { input_tokens: 9, output_tokens: 1 },
  };
  const cases: readonly Readonly<{
    reason: ResearchContinuationReason;
    respond: () => Promise<JevEvaluationResponse>;
  }>[] = [
    {
      reason: "jev-low-confidence",
      respond: async () =>
        jevChoice("implementation-interview", RESEARCH_CONTINUATION_CONFIDENCE_THRESHOLD - 0.01),
    },
    { reason: "jev-invalid-classification", respond: async () => malformed },
    { reason: "jev-invalid-classification", respond: async () => unknownChoice },
    {
      reason: "jev-timeout",
      respond: async () => {
        throw new JevEvaluationError("timeout", "Jev request timed out");
      },
    },
    {
      reason: "jev-unavailable",
      respond: async () => {
        throw new JevEvaluationError("unavailable", "Jev service unavailable");
      },
    },
    {
      reason: "jev-invalid-response",
      respond: async () => {
        throw new JevEvaluationError("invalid-response", "Jev response is invalid");
      },
    },
    {
      reason: "jev-error",
      respond: async () => {
        throw new Error("socket hang up");
      },
    },
  ];

  for (const testCase of cases) {
    const provider = counting(testCase.respond);
    const classification = await classifyResearchContinuation(
      { objective: "Research this ticket", taskKind: "scout" },
      CONFIG,
      provider.evaluate,
    );
    expect(provider.calls.length).toBe(1);
    expect(classification.reason).toBe(testCase.reason);
    expect(classification.continuation).toEqual({
      schemaVersion: 1,
      disposition: "ask-intent",
      selectedBy: "deterministic",
    });
    expect(checkResearchContinuation(classification.continuation).valid).toBe(true);
  }
});

test("a missing API key answers ask-intent without contacting the provider", async () => {
  const provider = counting(async () => jevChoice("implementation-interview"));
  const classify = researchContinuationClassifier({ timeoutMs: 1_500 }, provider.evaluate);
  const classification = await classify({ objective: "Research this ticket", taskKind: "scout" });
  expect(provider.calls).toEqual([]);
  expect(classification.reason).toBe("jev-not-configured");
  expect(classification.continuation).toEqual({
    schemaVersion: 1,
    disposition: "ask-intent",
    selectedBy: "deterministic",
  });
});

test("classifier config enables Jev only with a key and bounds the timeout", () => {
  expect(researchContinuationClassifierConfig({})).toEqual({ timeoutMs: 1_500 });
  expect(
    researchContinuationClassifierConfig({
      TYPESAFE_API_KEY: "  key-1  ",
      TANDEM_JEV_TIMEOUT_MS: "2500",
    }),
  ).toEqual({ apiKey: "key-1", timeoutMs: 2_500 });
  expect(
    researchContinuationClassifierConfig({
      TYPESAFE_API_KEY: "key-1",
      TANDEM_JEV_TIMEOUT_MS: "99",
    }),
  ).toEqual({ apiKey: "key-1", timeoutMs: 1_500 });
  expect(
    researchContinuationClassifierConfig({
      TYPESAFE_API_KEY: "   ",
      TANDEM_JEV_TIMEOUT_MS: "99999",
    }),
  ).toEqual({ timeoutMs: 1_500 });
});
