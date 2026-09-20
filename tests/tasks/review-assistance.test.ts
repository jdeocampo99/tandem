import { expect, test } from "bun:test";
import {
  JEV_MODEL,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import type { ReviewLevelPolicy, ReviewLevelRecord } from "../../src/contracts.ts";
import {
  createReviewAssistanceCache,
  type JevEvaluator,
  REVIEW_ASSISTANCE_LIMITS,
  type ReviewAssistanceRequest,
  type ReviewAssistanceRuntime,
  requestReviewAssistance,
  reviewAssistanceConfig,
  reviewAssistanceRuntime,
  screenReviewContext,
} from "../../src/tasks/review-assistance.ts";
import {
  classifyReviewLevel,
  DEFAULT_REVIEW_LEVEL_POLICY,
  raiseReviewLevel,
} from "../../src/tasks/review-levels.ts";

const SHADOW: ReviewLevelPolicy = {
  ...DEFAULT_REVIEW_LEVEL_POLICY,
  jevAssistance: "shadow",
  sourceTransmission: true,
};

const DETERMINISTIC: ReviewLevelRecord = {
  level: "standard",
  reason: "the observed diff is broader than a contained change",
  floors: [],
};

function request(overrides: Partial<ReviewAssistanceRequest> = {}): ReviewAssistanceRequest {
  return {
    files: [
      {
        path: "src/pool/maintenance.ts",
        changedLines: ["+  const retained = keep(entry);"],
        contentObserved: true,
      },
    ],
    affectedCallers: ["src/main.ts"],
    deterministic: DETERMINISTIC,
    impact: "contained",
    policyDigest: "policy-digest",
    source: "cumulative diff base..head",
    ...overrides,
  };
}

function answer(
  choice: string,
  confidence: number,
  nouls: Readonly<Record<string, number>> = {},
): JevEvaluationResponse {
  const others = ["light", "standard", "deep", "unclear"].filter((option) => option !== choice);
  const remainder = (1 - confidence) / others.length;
  const probabilities: Record<string, number> = { [choice]: confidence };
  for (const option of others) probabilities[option] = remainder;
  return {
    model: JEV_MODEL,
    answers: {
      depth: { type: "choice", choice, probabilities, confidence },
      "hidden-effects": { type: "noul", noul: nouls["hidden-effects"] ?? 0 },
      "weakened-tests": { type: "noul", noul: nouls["weakened-tests"] ?? 0 },
      "auth-change": { type: "noul", noul: nouls["auth-change"] ?? 0 },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
  };
}

function runtime(
  evaluate: JevEvaluator,
  overrides: Partial<ReviewAssistanceRuntime> = {},
): ReviewAssistanceRuntime & Readonly<{ readonly events: string[] }> {
  const events: string[] = [];
  return {
    ...reviewAssistanceRuntime({
      apiKey: "test-key",
      timeoutMs: 1_000,
      evaluate,
      recordDiagnostic: async (event) => {
        events.push(event);
      },
    }),
    ...overrides,
    events,
  };
}

function refusingEvaluator(): JevEvaluator {
  return () => {
    throw new Error("the evaluator must not be called");
  };
}

test("with assistance off the injected evaluator is never called and no source leaves", async () => {
  const transport = runtime(refusingEvaluator());
  const outcome = await requestReviewAssistance(transport, DEFAULT_REVIEW_LEVEL_POLICY, request());
  expect(outcome.status).toBe("disabled");
  expect(outcome.leads).toEqual([]);
  expect(outcome.recommendation).toBe("unavailable");
  expect(outcome.identity).toBeUndefined();
  expect(transport.events).toEqual([]);
});

test("shadow assistance without the source-transmission opt-in never calls the evaluator", async () => {
  const transport = runtime(refusingEvaluator());
  const outcome = await requestReviewAssistance(
    transport,
    { ...DEFAULT_REVIEW_LEVEL_POLICY, jevAssistance: "shadow" },
    request(),
  );
  expect(outcome.status).toBe("disabled");
  expect(outcome.reason).toContain("source transmission");
  expect(transport.events).toEqual([]);
});

test("a missing credential disables assistance without calling the evaluator", async () => {
  const { apiKey: _withheld, ...transport } = runtime(refusingEvaluator());
  const outcome = await requestReviewAssistance(transport, SHADOW, request());
  expect(outcome.status).toBe("disabled");
  expect(outcome.reason).toContain("credential");
});

test("screening refuses secret-bearing paths and secret-looking content", () => {
  const screened = screenReviewContext([
    { path: ".env", changedLines: ["+TOKEN=abc"], contentObserved: true },
    { path: "deploy/service.pem", changedLines: [], contentObserved: true },
    {
      path: "src/config/environment.ts",
      changedLines: ["+const key = 'sk-01234567890123456789abcdef';"],
      contentObserved: true,
    },
    {
      path: "src/config/loader.ts",
      changedLines: ["+  api_key: 'AAAAAAAAAAAAAAAAAAAA',"],
      contentObserved: true,
    },
    {
      path: "src/pool/maintenance.ts",
      changedLines: ["+  const retained = keep(entry);"],
      contentObserved: true,
    },
    { path: "src/pool/unreadable.ts", changedLines: [], contentObserved: false },
  ]);
  expect(screened.transmittable.map((file) => file.path)).toEqual(["src/pool/maintenance.ts"]);
  expect(screened.refusals).toEqual([
    { path: ".env", reason: "secret-bearing-path" },
    { path: "deploy/service.pem", reason: "secret-bearing-path" },
    { path: "src/config/environment.ts", reason: "secret-pattern" },
    { path: "src/config/loader.ts", reason: "secret-pattern" },
  ]);
});

test("transmitted context is bounded by file, line, and byte limits", () => {
  const long = Array.from({ length: 500 }, (_, index) => `+  const step${index} = index;`);
  const screened = screenReviewContext(
    Array.from({ length: 20 }, (_, index) => ({
      path: `src/pool/step-${index}.ts`,
      changedLines: long,
      contentObserved: true as const,
    })),
  );
  expect(screened.transmittable.length).toBeLessThanOrEqual(
    REVIEW_ASSISTANCE_LIMITS.maxTransmittedFiles,
  );
  expect(screened.transmittedBytes).toBeLessThanOrEqual(
    REVIEW_ASSISTANCE_LIMITS.maxTransmittedBytes,
  );
  for (const file of screened.transmittable) {
    expect(file.changedLines.length).toBe(REVIEW_ASSISTANCE_LIMITS.maxTransmittedLinesPerFile);
  }
  expect(screened.boundedOutFiles).toBeGreaterThan(0);
});

test("a request with nothing safe to transmit is refused with a source-free diagnostic", async () => {
  const transport = runtime(refusingEvaluator());
  const outcome = await requestReviewAssistance(
    transport,
    SHADOW,
    request({ files: [{ path: ".env", changedLines: ["+TOKEN=x"], contentObserved: true }] }),
  );
  expect(outcome.status).toBe("refused");
  expect(outcome.refusals).toEqual([{ path: ".env", reason: "secret-bearing-path" }]);
  expect(transport.events).toEqual(["review-level-assistance-refused"]);
});

test("independent questions are batched into one evaluation and cached on exact identity", async () => {
  const inputs: JevEvaluationInput[] = [];
  const transport = runtime(async (input) => {
    inputs.push(input);
    return answer("standard", 0.95, { "hidden-effects": 0.9 });
  });
  const first = await requestReviewAssistance(transport, SHADOW, request());
  expect(first.status).toBe("answered");
  expect(first.cached).toBe(false);
  expect(inputs).toHaveLength(1);
  expect(Object.keys(inputs[0]?.questions ?? {}).sort()).toEqual([
    "auth-change",
    "depth",
    "hidden-effects",
    "weakened-tests",
  ]);

  const repeated = await requestReviewAssistance(transport, SHADOW, request());
  expect(repeated.cached).toBe(true);
  expect(inputs).toHaveLength(1);

  const changed = await requestReviewAssistance(
    transport,
    SHADOW,
    request({ policyDigest: "a-different-policy" }),
  );
  expect(changed.cached).toBe(false);
  expect(inputs).toHaveLength(2);
});

test("a flagged question becomes an untrusted lead with full provenance", async () => {
  const transport = runtime(async () => answer("standard", 0.95, { "hidden-effects": 0.92 }));
  const outcome = await requestReviewAssistance(transport, SHADOW, request());
  expect(outcome.leads).toHaveLength(1);
  const lead = outcome.leads[0];
  expect(lead?.id).toBe("jev-hidden-effects");
  expect(lead?.principle).toContain("Maximize Honesty");
  expect(lead?.provenance.source).toBe("cumulative diff base..head");
  expect(lead?.provenance.question).toContain("hidden-effects");
  expect(lead?.provenance.requestIdentity).toContain("code=");
  expect(lead?.provenance.requestIdentity).toContain("context=");
  expect(lead?.provenance.requestIdentity).toContain("question=");
  expect(lead?.provenance.requestIdentity).toContain("schema=");
  expect(lead?.provenance.requestIdentity).toContain("policy=");
  expect(lead?.provenance.requestIdentity).toContain(`model=${JEV_MODEL}`);
  expect(lead?.provenance.resultIdentity).toContain("result=");
});

test("a belief below the provisional flag bound produces no lead", async () => {
  const transport = runtime(async () =>
    answer("standard", 0.95, {
      "hidden-effects": REVIEW_ASSISTANCE_LIMITS.minFlagBelief - 0.01,
    }),
  );
  const outcome = await requestReviewAssistance(transport, SHADOW, request());
  expect(outcome.leads).toEqual([]);
});

test("a security-floor diff with no transmittable context keeps its deterministic floor", async () => {
  const securityDiff = classifyReviewLevel({
    files: [
      {
        path: "src/coordinator/ownership.ts",
        changedLines: ["+  if (!request.authorization) return deny();"],
        contentObserved: true,
      },
    ],
    affectedCallers: [],
    impact: { assessment: "contained" },
  });
  expect(securityDiff.level).toBe("deep");
  expect(securityDiff.floors).toEqual(["permissions-security"]);

  const transport = runtime(async () => answer("light", 0.999));
  const outcome = await requestReviewAssistance(
    transport,
    SHADOW,
    request({ deterministic: securityDiff, files: [] }),
  );
  expect(outcome.recommendation).toBe("unavailable");
  expect(raiseReviewLevel(securityDiff, "light")).toBe("deep");
  expect(raiseReviewLevel(securityDiff, outcome.recommendation)).toBe("deep");
});

test("an adversarial confident light answer on a security-floor diff leaves the level at the floor", async () => {
  const floorRecord: ReviewLevelRecord = {
    level: "deep",
    reason: "the permissions and security floor fired",
    floors: ["permissions-security"],
  };
  const transport = runtime(async () => answer("light", 0.999));
  const outcome = await requestReviewAssistance(
    transport,
    SHADOW,
    request({ deterministic: floorRecord }),
  );
  expect(outcome.status).toBe("answered");
  expect(outcome.recommendation).toBe("light");
  expect(raiseReviewLevel(floorRecord, outcome.recommendation)).toBe("deep");
});

test("a low-confidence depth answer records no recommendation", async () => {
  const transport = runtime(async () =>
    answer("light", REVIEW_ASSISTANCE_LIMITS.minDepthConfidence - 0.05),
  );
  const outcome = await requestReviewAssistance(transport, SHADOW, request());
  expect(outcome.recommendation).toBe("unavailable");
  expect(outcome.reason).toContain("confidence bound");
});

test("an unclear depth answer records no recommendation", async () => {
  const transport = runtime(async () => answer("unclear", 0.99));
  const outcome = await requestReviewAssistance(transport, SHADOW, request());
  expect(outcome.recommendation).toBe("unavailable");
});

test("a provider failure or timeout fails conservative with a source-free diagnostic", async () => {
  for (const code of ["unavailable", "timeout", "invalid-response"] as const) {
    const transport = runtime(async () => {
      throw new JevEvaluationError(code, `jev ${code}`);
    });
    const outcome = await requestReviewAssistance(transport, SHADOW, request());
    expect(outcome.status).toBe("failed");
    expect(outcome.recommendation).toBe("unavailable");
    expect(outcome.leads).toEqual([]);
    expect(outcome.reason).toContain(`jev-${code}`);
    expect(transport.events).toEqual(["review-level-assistance-failed"]);
  }
});

test("a malformed answer shape yields no recommendation and no lead", async () => {
  const transport = runtime(async () => ({
    model: JEV_MODEL,
    answers: { depth: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 1, output_tokens: 0 },
  }));
  const outcome = await requestReviewAssistance(transport, SHADOW, request());
  expect(outcome.recommendation).toBe("unavailable");
  expect(outcome.leads).toEqual([]);
});

test("the cache only matches when every identity matches", async () => {
  const cache = createReviewAssistanceCache();
  let calls = 0;
  const transport = runtime(
    async () => {
      calls += 1;
      return answer("standard", 0.95);
    },
    { cache },
  );
  await requestReviewAssistance(transport, SHADOW, request());
  await requestReviewAssistance(transport, SHADOW, request());
  expect(calls).toBe(1);

  await requestReviewAssistance(
    transport,
    SHADOW,
    request({
      files: [
        {
          path: "src/pool/maintenance.ts",
          changedLines: ["+  const retained = drop(entry);"],
          contentObserved: true,
        },
      ],
    }),
  );
  expect(calls).toBe(2);

  await requestReviewAssistance(transport, SHADOW, request({ impact: "expanded" }));
  expect(calls).toBe(3);
});

test("the transport config reads the credential and a bounded timeout", () => {
  expect(reviewAssistanceConfig({})).toEqual({ timeoutMs: 2_000 });
  expect(reviewAssistanceConfig({ TYPESAFE_API_KEY: "  key  " })).toEqual({
    timeoutMs: 2_000,
    apiKey: "key",
  });
  expect(reviewAssistanceConfig({ TANDEM_JEV_TIMEOUT_MS: "900" }).timeoutMs).toBe(900);
  expect(reviewAssistanceConfig({ TANDEM_JEV_TIMEOUT_MS: "99999" }).timeoutMs).toBe(2_000);
  expect(reviewAssistanceConfig({ TYPESAFE_API_KEY: "   " }).apiKey).toBeUndefined();
});
