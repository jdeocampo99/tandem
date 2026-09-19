import { expect, test } from "bun:test";
import { evaluateJev, type JevEvaluationInput } from "../../src/adapters/typesafe.ts";

const input: JevEvaluationInput = {
  model: "jev-1.13.0",
  state: { task: "bounded" },
  questions: { relevant: { type: "noul", instructions: "Is this relevant?" } },
};

function response(): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: { relevant: { type: "noul", noul: 0.8 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200 },
  );
}

test("validates and returns a bounded Jev response", async () => {
  const result = await evaluateJev(input, {
    apiKey: "fake",
    timeoutMs: 2_000,
    fetch: async () => response(),
  });
  expect(result.answers.relevant).toEqual({ type: "noul", noul: 0.8 });
});

test("enforces one overall deadline when fetch never settles", async () => {
  const started = Date.now();
  await expect(
    evaluateJev(input, {
      apiKey: "fake",
      timeoutMs: 1,
      fetch: async (_request, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(Date.now() - started).toBeLessThan(500);
});

test("enforces the same deadline while a response body stalls", async () => {
  await expect(
    evaluateJev(input, {
      apiKey: "fake",
      timeoutMs: 1,
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
    }),
  ).rejects.toMatchObject({ code: "timeout" });
});

test("rejects timeout values above the Jev maximum", async () => {
  await expect(
    evaluateJev(input, { apiKey: "fake", timeoutMs: 10_001, fetch: async () => response() }),
  ).rejects.toMatchObject({ code: "invalid-request" });
});
