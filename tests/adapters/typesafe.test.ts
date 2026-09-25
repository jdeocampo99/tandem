import { expect, test } from "bun:test";
import { evaluateJev, type JevEvaluationInput, jevGateway } from "../../src/adapters/typesafe.ts";

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

test("sends the same body through a Portkey gateway under the gateway's model name", async () => {
  const gateway = jevGateway({
    PORTKEY_BASE_URL: "https://gateway.example/v1/",
    PORTKEY_API_KEY: "portkey-key",
    PORTKEY_PROVIDER: "@openrouter",
    PORTKEY_CUSTOM_HOST: "https://openrouter.ai/api/alpha",
    PORTKEY_JEV_MODEL: "typesafe/jev-1.13-20260917",
  });
  let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  const result = await evaluateJev(input, {
    apiKey: "typesafe-key",
    timeoutMs: 2_000,
    ...(gateway === undefined ? {} : { gateway }),
    fetch: async (url, init) => {
      seen = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: { relevant: { type: "noul", noul: 0.8 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    },
  });
  expect(seen?.url).toBe("https://gateway.example/v1/proxy/decisions");
  expect(seen?.headers.get("x-portkey-api-key")).toBe("portkey-key");
  expect(seen?.headers.get("x-portkey-provider")).toBe("@openrouter");
  expect(seen?.headers.get("x-portkey-custom-host")).toBe("https://openrouter.ai/api/alpha");
  expect(seen?.headers.get("authorization")).toBe("Bearer typesafe-key");
  expect(seen?.body.model).toBe("typesafe/jev-1.13-20260917");
  expect(result.model).toBe("jev-1.13.0");
  expect(jevGateway({})).toBeUndefined();
});
