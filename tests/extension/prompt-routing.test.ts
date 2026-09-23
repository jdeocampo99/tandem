import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
  zod,
} from "@oh-my-pi/pi-coding-agent";
import {
  JEV_MODEL,
  type JevChoiceAnswer,
  JevEvaluationError,
  type JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import {
  choiceConfidence,
  classifyPrompt,
  handlePromptInput,
  PROMPT_ROUTING_QUESTION_SCHEMA_VERSION,
  promptRoutingConfig,
} from "../../src/extension/prompt-routing.ts";
import { registerTandemOmp } from "../../src/extension/registration.ts";
import { readPromptRoutingLog } from "../../src/runtime/diagnostics.ts";
import { JEV_PRICING_SNAPSHOT, USAGE_RECORD_SCHEMA_VERSION } from "../../src/runtime/usage.ts";
import type { TandemService } from "../../src/service/controller.ts";

type Choice = Readonly<{ choice: string; confidence?: number }>;

function choiceAnswer({ choice, confidence = 0.95 }: Choice): JevChoiceAnswer {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: Object.fromEntries(
      [choice, "list", "presentations", "show", "messages", "inspect", "none"]
        .filter((candidate, index, values) => values.indexOf(candidate) === index)
        .map((candidate) => [candidate, candidate === choice ? confidence : (1 - confidence) / 7]),
    ),
  };
}

function response(
  action: Choice,
  target: Choice,
  effect: Choice,
  scope: Choice,
  composition: Choice,
): JevEvaluationResponse {
  return {
    model: JEV_MODEL,
    answers: {
      action: choiceAnswer(action),
      target: choiceAnswer(target),
      effect: choiceAnswer(effect),
      scope: choiceAnswer(scope),
      composition: choiceAnswer(composition),
    },
    usage: { input_tokens: 12, output_tokens: 8 },
  };
}

const context = {
  hasUI: false,
  mode: "rpc",
} as unknown as ExtensionContext;

const listFacts = response(
  { choice: "list" },
  { choice: "repository" },
  { choice: "read-only" },
  { choice: "within" },
  { choice: "single" },
);

const inspectFacts = response(
  { choice: "inspect" },
  { choice: "task" },
  { choice: "read-only" },
  { choice: "within" },
  { choice: "single" },
);

test("choiceConfidence combines stated confidence with the chosen option's own probability", () => {
  expect(
    choiceConfidence({
      type: "choice",
      choice: "list",
      confidence: 0.9,
      probabilities: { list: 0.7 },
    }),
  ).toBe(0.7);
  expect(
    choiceConfidence({
      type: "choice",
      choice: "list",
      confidence: 0.6,
      probabilities: { list: 0.95 },
    }),
  ).toBe(0.6);
});

test("choiceConfidence returns undefined for a probability or confidence that cannot be trusted", () => {
  expect(
    choiceConfidence({
      type: "choice",
      choice: "list",
      confidence: 0.9,
      probabilities: { other: 0.7 },
    }),
  ).toBeUndefined();
  expect(
    choiceConfidence({
      type: "choice",
      choice: "list",
      confidence: Number.NaN,
      probabilities: { list: 0.7 },
    }),
  ).toBeUndefined();
});

test("the routing question schema version is a stable positive integer", () => {
  expect(Number.isInteger(PROMPT_ROUTING_QUESTION_SCHEMA_VERSION)).toBe(true);
  expect(PROMPT_ROUTING_QUESTION_SCHEMA_VERSION).toBeGreaterThan(0);
});

test("prompt routing config enables only with a key and bounds the timeout", () => {
  expect(promptRoutingConfig({})).toEqual({ timeoutMs: 1_500 });
  expect(
    promptRoutingConfig({ TYPESAFE_API_KEY: "  key-1  ", TANDEM_JEV_TIMEOUT_MS: "2500" }),
  ).toEqual({ apiKey: "key-1", timeoutMs: 2_500 });
  expect(promptRoutingConfig({ TYPESAFE_API_KEY: "key-1", TANDEM_JEV_TIMEOUT_MS: "99" })).toEqual({
    apiKey: "key-1",
    timeoutMs: 1_500,
  });
});

test("confident repository lookup becomes a direct route", async () => {
  const result = await classifyPrompt(
    "  list my tandem tasks  ",
    { apiKey: "key", timeoutMs: 1_500 },
    async () => listFacts,
  );
  expect(result.classifier).toBe("jev");
  expect(result.reason).toBe("direct-read-only");
  expect(result.decision).toMatchObject({
    action: "list",
    target: "repository",
    effect: "read-only",
    scope: "within",
    composition: "single",
    confidence: 0.95,
  });
});

test("task lookup requires an explicit task identifier", async () => {
  const missing = await classifyPrompt(
    "inspect the current task",
    { apiKey: "key", timeoutMs: 1_500 },
    async () => inspectFacts,
  );
  expect(missing.decision).toBeUndefined();
  expect(missing.reason).toBe("missing-explicit-task-id");

  const identified = await classifyPrompt(
    "inspect task-42",
    { apiKey: "key", timeoutMs: 1_500 },
    async () => inspectFacts,
  );
  expect(identified.decision).toMatchObject({ action: "inspect", taskId: "task-42" });
});

test("low confidence and state-changing classifications stay with the coordinator", async () => {
  const low = await classifyPrompt("show task-42", { apiKey: "key", timeoutMs: 1_500 }, async () =>
    response(
      { choice: "show", confidence: 0.79 },
      { choice: "task" },
      { choice: "read-only" },
      { choice: "within" },
      { choice: "single" },
    ),
  );
  expect(low.reason).toBe("low-confidence");

  const changing = await classifyPrompt(
    "cancel task-42",
    { apiKey: "key", timeoutMs: 1_500 },
    async () =>
      response(
        { choice: "none" },
        { choice: "task" },
        { choice: "state-change" },
        { choice: "within" },
        { choice: "single" },
      ),
  );
  expect(changing.decision).toBeUndefined();
  expect(changing.reason).toBe("normal-coordinator");
});

test("no usage is recorded when Jev is not configured, since no request was attempted", async () => {
  const result = await classifyPrompt("list my tasks", { timeoutMs: 1_500 }, async () => listFacts);
  expect(result.reason).toBe("jev-not-configured");
  expect(result.usage).toBeUndefined();
});

test("records reported input/output tokens and the pinned pricing snapshot on a Jev response", async () => {
  const result = await classifyPrompt(
    "list my tandem tasks",
    { apiKey: "key", timeoutMs: 1_500 },
    async () => listFacts,
  );
  expect(result.usage).toEqual({
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    provider: "typesafe",
    model: JEV_MODEL,
    inputTokens: 12,
    outputTokens: 8,
    durationMs: result.durationMs,
    timedOut: false,
    reason: "direct-read-only",
    pricing: JEV_PRICING_SNAPSHOT,
  });
});

test("records usage as unavailable, not zero, when the provider is unavailable", async () => {
  const result = await classifyPrompt(
    "list my tandem tasks",
    { apiKey: "key", timeoutMs: 1_500 },
    async () => {
      throw new JevEvaluationError("unavailable", "Jev service unavailable");
    },
  );
  expect(result.reason).toBe("jev-unavailable");
  expect(result.usage).toEqual({
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    provider: "typesafe",
    model: JEV_MODEL,
    inputTokens: "unavailable",
    outputTokens: "unavailable",
    durationMs: result.durationMs,
    timedOut: false,
    reason: "jev-unavailable",
    pricing: JEV_PRICING_SNAPSHOT,
  });
});

test("records usage as unavailable with a timed-out marker on a Jev timeout", async () => {
  const result = await classifyPrompt(
    "list my tandem tasks",
    { apiKey: "key", timeoutMs: 1_500 },
    async () => {
      throw new JevEvaluationError("timeout", "Jev request timed out");
    },
  );
  expect(result.reason).toBe("jev-timeout");
  expect(result.usage).toMatchObject({
    inputTokens: "unavailable",
    outputTokens: "unavailable",
    timedOut: true,
    reason: "jev-timeout",
  });
});

test("records usage as unavailable for a malformed provider response", async () => {
  const result = await classifyPrompt(
    "list my tandem tasks",
    { apiKey: "key", timeoutMs: 1_500 },
    async () => {
      throw new JevEvaluationError("invalid-response", "Jev response is invalid");
    },
  );
  expect(result.reason).toBe("jev-invalid-response");
  expect(result.usage).toMatchObject({
    inputTokens: "unavailable",
    outputTokens: "unavailable",
    timedOut: false,
    reason: "jev-invalid-response",
  });
});

test("direct routing executes a read-only service action and records ordered diagnostics", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-"));
  const sent: string[] = [];
  let listCalls = 0;
  const service = {
    list: async () => {
      listCalls += 1;
      return [{ id: "task-1", stage: "ready" }];
    },
  } as unknown as TandemService;
  try {
    const result = await handlePromptInput(
      { source: "interactive", text: "list my tasks" } as InputEvent,
      context,
      {
        config: { apiKey: "key", timeoutMs: 1_500 },
        getService: () => service,
        getHome: () => home,
        sendMessage: ((message: string | { readonly content?: string }) => {
          sent.push(typeof message === "string" ? message : (message.content ?? ""));
        }) as never,
        evaluate: async () => listFacts,
      },
    );
    expect(result).toEqual({ handled: true });
    expect(listCalls).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("task-1");

    const raw = await readFile(join(home, "logs", "tandem.jsonl"), "utf8");
    const diagnostics = JSON.parse(`[${raw.trim().split("\n").join(",")}]`) as {
      event: string;
      details: { promptHash: string };
      usage?: unknown;
    }[];
    expect(diagnostics.map((entry) => entry.event)).toEqual([
      "prompt-route-evaluated",
      "prompt-route-dispatched",
    ]);

    const [evaluated, dispatched] = diagnostics;
    expect(evaluated?.usage).toEqual({
      schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
      provider: "typesafe",
      model: JEV_MODEL,
      inputTokens: 12,
      outputTokens: 8,
      durationMs: expect.any(Number),
      timedOut: false,
      reason: "direct-read-only",
      pricing: JEV_PRICING_SNAPSHOT,
    });
    expect(dispatched?.usage).toBeUndefined();
    expect(evaluated?.details.promptHash).toBe(dispatched?.details.promptHash);
    expect(raw).not.toContain("list my tasks");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an old diagnostic line recorded before usage existed still parses", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-legacy-"));
  try {
    await mkdir(join(home, "logs"), { recursive: true });
    await appendFile(
      join(home, "logs", "tandem.jsonl"),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: 1,
        event: "prompt-route-evaluated",
        details: { promptHash: "deadbeefdeadbeef", classifier: "jev", reason: "low-confidence" },
      })}\n`,
    );
    const lines = await readPromptRoutingLog(home);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "prompt-route-evaluated" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registration installs the OMP input hook before command handling", async () => {
  type InputHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
  const handlers = new Map<string, InputHandler>();
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-hook-"));
  try {
    const pi = {
      zod,
      on: (event: string, handler: InputHandler) => {
        handlers.set(event, handler);
      },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;
    registerTandemOmp(pi, {
      getService: () => ({}) as TandemService,
      getHome: () => home,
      promptRouting: { timeoutMs: 1_500 },
      reconcile: async () => undefined,
      postAction: async () => undefined,
    });
    const input = handlers.get("input");
    if (input === undefined) throw new Error("input hook was not registered");
    expect(
      await input({ source: "interactive", text: "/tandem list" } as InputEvent, context),
    ).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unconfigured and exact-command input preserves normal OMP handling", async () => {
  let evaluations = 0;
  const deps = {
    config: promptRoutingConfig({}),
    getService: () => ({}) as TandemService,
    getHome: () => "/tmp/tandem-no-route",
    sendMessage: (() => undefined) as never,
    evaluate: async () => {
      evaluations += 1;
      return listFacts;
    },
  };
  expect(
    await handlePromptInput(
      { source: "interactive", text: "list tasks" } as InputEvent,
      context,
      deps,
    ),
  ).toBeUndefined();
  expect(
    await handlePromptInput(
      { source: "interactive", text: "/tandem list" } as InputEvent,
      context,
      deps,
    ),
  ).toBeUndefined();
  expect(evaluations).toBe(0);
});
