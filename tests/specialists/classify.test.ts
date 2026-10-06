import { expect, test } from "bun:test";
import type {
  JevEvaluationInput,
  JevEvaluationResponse,
  JevGateway,
} from "../../src/adapters/typesafe.ts";
import { classifySpecialist, MAX_GUESS_CANDIDATES } from "../../src/specialists/classify.ts";

const candidates = [
  { name: "bug-fix", description: "Fixes bugs." },
  { name: "blog-writer", description: "Writes posts." },
];
const config = { apiKey: "key", timeoutMs: 1_000 };

function answer(choice: string, confidence: number): JevEvaluationResponse {
  return {
    model: "jev-1.13.0",
    answers: {
      specialist: {
        type: "choice",
        choice,
        probabilities: { "bug-fix": 0, "blog-writer": 0, no_fit: 0, [choice]: 1 },
        confidence,
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test("asks Jev once among the candidates plus no_fit and returns a confident pick", async () => {
  const asked: JevEvaluationInput[] = [];
  const picked = await classifySpecialist(
    "Write the launch post",
    candidates,
    config,
    async (input) => {
      asked.push(input);
      return answer("blog-writer", 0.95);
    },
  );
  expect(picked).toBe("blog-writer");
  expect(asked).toHaveLength(1);
  const question = asked[0]?.questions.specialist;
  expect(question?.type === "choice" ? Object.keys(question.criteria).sort() : []).toEqual([
    "blog-writer",
    "bug-fix",
    "no_fit",
  ]);
});

test("no_fit, low confidence, an unknown pick, failure, or no key is no pick", async () => {
  const reply = (response: JevEvaluationResponse) => async () => response;
  expect(
    await classifySpecialist("Do it", candidates, config, reply(answer("no_fit", 0.99))),
  ).toBeUndefined();
  expect(
    await classifySpecialist("Do it", candidates, config, reply(answer("bug-fix", 0.5))),
  ).toBeUndefined();
  expect(
    await classifySpecialist("Do it", candidates, config, reply(answer("perf", 0.99))),
  ).toBeUndefined();
  expect(
    await classifySpecialist("Do it", candidates, config, async () => {
      throw new Error("down");
    }),
  ).toBeUndefined();
  let called = false;
  expect(
    await classifySpecialist("Do it", candidates, { timeoutMs: 1_000 }, async () => {
      called = true;
      return answer("bug-fix", 1);
    }),
  ).toBeUndefined();
  expect(called).toBe(false);
});

test("over Jev's option cap, it never asks", async () => {
  const many = Array.from({ length: MAX_GUESS_CANDIDATES + 1 }, (_, index) => ({
    name: `s${index}`,
    description: `Kind ${index}.`,
  }));
  let called = false;
  await classifySpecialist("Do it", many, config, async () => {
    called = true;
    return answer("s1", 1);
  });
  expect(called).toBe(false);
});

test("goes through the configured Jev gateway", async () => {
  const gateway: JevGateway = { url: "https://gateway.example/v1", model: "jev", headers: {} };
  let used: JevGateway | undefined;
  await classifySpecialist(
    "Fix the crash",
    candidates,
    { ...config, gateway },
    async (_, options) => {
      used = options.gateway;
      return answer("bug-fix", 0.95);
    },
  );
  expect(used).toEqual(gateway);
});
