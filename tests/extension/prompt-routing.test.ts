import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  type JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import {
  classifyPrompt,
  handlePromptInput,
  promptRoutingConfig,
} from "../../src/extension/prompt-routing.ts";
import { registerTandemOmp } from "../../src/extension/registration.ts";
import type { TandemService } from "../../src/service/controller.ts";

type Choice = Readonly<{ choice: string; confidence?: number }>;

function choiceAnswer({ choice, confidence = 0.95 }: Choice): JevChoiceAnswer {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: Object.fromEntries(
      [choice, "list", "presentations", "show", "messages", "inspect", "recovery-plan", "none"]
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

    const diagnostics = JSON.parse(
      `[${(await readFile(join(home, "logs", "tandem.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .join(",")}]`,
    ) as { event: string }[];
    expect(diagnostics.map((entry) => entry.event)).toEqual([
      "prompt-route-evaluated",
      "prompt-route-dispatched",
    ]);
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
