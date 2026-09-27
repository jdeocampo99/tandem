import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  choiceConfidence,
  JEV_MODEL,
  type JevChoiceAnswer,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationResponse,
  type JevFetch,
} from "../../src/adapters/typesafe.ts";
import { renderBoard } from "../../src/board/view.ts";
import { registerTandemOmp } from "../../src/extension/registration.ts";
import { RESTART_QUESTION_ID_PREFIX } from "../../src/recovery/central.ts";
import { appendDiagnosticEvent, readPromptRoutingLog } from "../../src/runtime/diagnostics.ts";
import { JEV_PRICING_SNAPSHOT, USAGE_RECORD_SCHEMA_VERSION } from "../../src/runtime/usage.ts";
import type { TandemService } from "../../src/service/controller.ts";
import {
  actionForPromptDecision,
  type ChoiceConfirmation,
  classifyPrompt,
  PROMPT_ROUTING_QUESTION_SCHEMA_VERSION,
  type PromptRoutingDependencies,
  promptRoutingConfig,
  routeUserPrompt,
  type UserPrompt,
} from "../../src/session/prompt-routing.ts";
import { type RecordingSessionHost, recordingSessionHost } from "../evals/scenario.ts";

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

function typed(text: string): UserPrompt {
  return { type: "userPrompt", text, interactive: true, attachments: 0 };
}

/** Routing deps that record replies on a session host and diagnostics under `home`. */
function routing(
  home: string,
  service: TandemService,
  overrides: Partial<PromptRoutingDependencies> = {},
  recording: RecordingSessionHost = recordingSessionHost(),
): Readonly<{ deps: PromptRoutingDependencies; sent: () => string[] }> {
  return {
    deps: {
      config: { apiKey: "key", timeoutMs: 1_500 },
      service: () => service,
      host: recording.host,
      confirm: undefined,
      diagnostics: (entry) => appendDiagnosticEvent(home, entry),
      ...overrides,
    },
    sent: () =>
      recording.effects.flatMap((effect) => (effect.type === "deliver" ? [effect.text] : [])),
  };
}

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
  let listCalls = 0;
  const service = {
    list: async () => {
      listCalls += 1;
      return [{ id: "task-1", stage: "ready" }];
    },
  } as unknown as TandemService;
  const recording = recordingSessionHost();
  try {
    const { deps } = routing(home, service, { evaluate: async () => listFacts }, recording);
    const result = await routeUserPrompt(typed("list my tasks"), deps);
    expect(result).toEqual({ handled: true });
    // Once to look for open questions a short reply could answer, once for the lookup itself.
    expect(listCalls).toBe(2);
    expect(recording.effects).toEqual([
      {
        type: "deliver",
        source: "prompt-route",
        text: expect.stringContaining("task-1"),
        details: { promptHash: expect.any(String), action: "list" },
        timing: "nextTurn",
        triggerTurn: false,
      },
    ]);

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

type InputHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

/** Registers Tandem on a fake OMP API and returns its input hook and every message it sent. */
function registeredInputHook(
  home: string,
  service: TandemService,
  promptRouting: PromptRoutingDependencies["config"],
): Readonly<{ input: InputHandler; sent: unknown[] }> {
  const handlers = new Map<string, InputHandler>();
  const sent: unknown[] = [];
  const pi = {
    on: (event: string, handler: InputHandler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: (message: unknown, options: unknown) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  registerTandemOmp(pi, {
    getService: () => service,
    getHome: () => home,
    promptRouting,
    reconcile: async () => undefined,
    postAction: async () => undefined,
    userPrompt: () => undefined,
    closeThread: () => undefined,
    researchRunning: async () => false,
  });
  const input = handlers.get("input");
  if (input === undefined) throw new Error("input hook was not registered");
  return { input, sent };
}

const HEADLESS = { hasUI: false, mode: "rpc" } as unknown as ExtensionContext;

function ompInput(text: string): unknown {
  return { type: "input", source: "interactive", text };
}

test("registration installs the OMP input hook before command handling", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-hook-"));
  try {
    const { input } = registeredInputHook(home, {} as TandemService, { timeoutMs: 1_500 });
    expect(await input(ompInput("/tandem list"), HEADLESS)).toBeUndefined();
    expect(
      await input({ type: "input", source: "rpc", text: "list my tasks" }, HEADLESS),
    ).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unconfigured and exact-command input preserves normal OMP handling", async () => {
  let evaluations = 0;
  const recording = recordingSessionHost();
  const { deps } = routing(
    "/tmp/tandem-no-route",
    {} as TandemService,
    {
      config: promptRoutingConfig({}),
      diagnostics: async () => undefined,
      evaluate: async () => {
        evaluations += 1;
        return listFacts;
      },
    },
    recording,
  );
  expect(await routeUserPrompt(typed("list tasks"), deps)).toEqual({ handled: false });
  expect(await routeUserPrompt(typed("/tandem list"), deps)).toEqual({ handled: false });
  expect(evaluations).toBe(0);
  expect(recording.effects).toEqual([]);
});

test("a prompt that is not typed, or carries an attachment, is never routed", async () => {
  let evaluations = 0;
  const recording = recordingSessionHost();
  const { deps } = routing(
    "/tmp/tandem-no-route",
    {} as TandemService,
    {
      diagnostics: async () => undefined,
      evaluate: async () => {
        evaluations += 1;
        return listFacts;
      },
    },
    recording,
  );
  expect(await routeUserPrompt({ ...typed("list my tasks"), interactive: false }, deps)).toEqual({
    handled: false,
  });
  expect(await routeUserPrompt({ ...typed("list my tasks"), attachments: 1 }, deps)).toEqual({
    handled: false,
  });
  expect(evaluations).toBe(0);
  expect(recording.effects).toEqual([]);
});

test("asking what the request has cost so far routes straight to its receipt", async () => {
  const receiptFacts = response(
    { choice: "receipt" },
    { choice: "repository" },
    { choice: "read-only" },
    { choice: "within" },
    { choice: "single" },
  );
  const result = await classifyPrompt(
    "how much has this request cost so far?",
    { apiKey: "key", timeoutMs: 1_500 },
    async () => receiptFacts,
  );

  expect(result.reason).toBe("direct-read-only");
  if (result.decision === undefined) throw new Error("expected a direct route");
  expect(actionForPromptDecision(result.decision)).toEqual({ action: "request-receipt" });
});

test("asking how your pull requests are doing shows the PR watch view without a coordinator turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-pr-watch-"));
  const prWatchFacts = response(
    { choice: "pr-watch" },
    { choice: "repository" },
    { choice: "read-only" },
    { choice: "within" },
    { choice: "single" },
  );
  const service = {
    list: async () => [],
    prWatch: async () => ({
      now: "2030-01-01T00:00:05.000Z",
      readAt: "2030-01-01T00:00:00.000Z",
      rows: [
        {
          repo: "acme/app",
          number: 409,
          branch: "refactor-cache",
          url: "https://github.com/acme/app/pull/409",
          color: "done",
          checks: "✅",
          status: "🎉 merged 11:02",
          note: "",
        },
      ],
    }),
  } as unknown as TandemService;
  try {
    const { deps, sent } = routing(home, service, { evaluate: async () => prWatchFacts });
    const result = await routeUserPrompt(typed("did #409 merge?"), deps);
    expect(result).toEqual({ handled: true });
    expect(sent()).toEqual([
      "PR watch · 0 open · checked 5s ago\n\n⚪ #409 refactor-cache ✅ 🎉 merged 11:02\n",
    ]);

    const hands = await classifyPrompt(
      "hands off #409",
      { apiKey: "key", timeoutMs: 1_500 },
      async () =>
        response(
          { choice: "pr-watch" },
          { choice: "repository" },
          { choice: "state-change" },
          { choice: "within" },
          { choice: "single" },
        ),
    );
    expect(hands.reason).toBe("normal-coordinator");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("asking how it's going shows the board without a coordinator turn, and a Jev failure leaves it to the coordinator", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-board-"));
  const boardFacts = response(
    { choice: "board" },
    { choice: "repository" },
    { choice: "read-only" },
    { choice: "within" },
    { choice: "single" },
  );
  const view = {
    now: "2030-01-01T00:00:05.000Z",
    projects: ["app"],
    needsYou: [
      {
        key: "brief:req-1",
        cause: "brief",
        repoPath: "/work/app",
        project: "app",
        mark: "🙋",
        name: "Dark mode",
        text: "brief waiting for approval",
      },
    ],
    running: [],
    pullRequests: [],
    finished: 0,
  } as const;
  const service = { board: async () => view } as unknown as TandemService;
  try {
    const answerHost = recordingSessionHost();
    const answered = routing(home, service, { evaluate: async () => boardFacts }, answerHost);
    expect(await routeUserPrompt(typed("how's it going?"), answered.deps)).toEqual({
      handled: true,
    });
    expect(answered.sent()).toEqual([]);
    expect(answerHost.effects).toHaveLength(1);
    expect(answerHost.effects[0]).toMatchObject({
      type: "showStatus",
      view,
      text: renderBoard(view),
      timing: "nextTurn",
      triggerTurn: false,
      details: { action: "board" },
    });

    const failed = routing(home, service, {
      evaluate: async () => {
        throw new JevEvaluationError("unavailable", "Jev service unavailable");
      },
    });
    expect(await routeUserPrompt(typed("how's it going?"), failed.deps)).toEqual({
      handled: false,
    });
    expect(failed.sent()).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a pasted PR link starts a review under the project, and anything else goes to the coordinator", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-pr-"));
  const started: unknown[] = [];
  const service = {
    reviewPr: async (input: unknown) => {
      started.push(input);
      return { kind: "started", taskId: "task-9", message: "Reviewing acme/api#7 for intent." };
    },
  } as unknown as TandemService;
  const prAnswers = (request: string): JevEvaluationResponse => ({
    model: JEV_MODEL,
    answers: {
      request: {
        type: "choice",
        choice: request,
        confidence: 0.95,
        probabilities: {
          review: request === "review" ? 0.95 : 0.05,
          other: request === "review" ? 0.05 : 0.95,
        },
      },
      lens: {
        type: "choice",
        choice: "intent",
        confidence: 0.95,
        probabilities: { full: 0.03, intent: 0.95, focus: 0.02 },
      },
    },
    usage: { input_tokens: 12, output_tokens: 8 },
  });
  const route = (request: string) =>
    routing(home, service, {
      repoPath: () => "/work/project",
      evaluate: async () => prAnswers(request),
    });
  try {
    const url = "https://github.com/acme/api/pull/7";
    const review = route("review");
    const handled = await routeUserPrompt(typed(`skim the idea behind ${url}`), review.deps);
    expect(handled).toEqual({ handled: true });
    expect(started).toEqual([
      { pullRequest: "acme/api#7", repoPath: "/work/project", lens: { kind: "intent" } },
    ]);
    expect(review.sent().at(-1)).toContain("Reviewing acme/api#7 for intent.");

    const other = route("other");
    const declined = await routeUserPrompt(typed(`merge ${url} when CI passes`), other.deps);
    expect(declined).toEqual({ handled: false });
    expect(started).toHaveLength(1);
    expect(other.sent()).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a pull-up prompt opens the one presentation Jev matched", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-"));
  const opened: string[] = [];
  const service = {
    requestBriefs: async () => [
      { id: "req-1", draft: { content: { goal: "Add a settings page" } } },
    ],
    presentations: async () => [
      {
        id: "presentation-1",
        taskId: "task-1",
        status: "ended",
        objective: "Mock up the settings page",
        createdAt: "2026-09-24T00:00:00.000Z",
      },
      { id: "presentation-2", taskId: "task-1", status: "running", createdAt: "2026-09-24" },
    ],
    openPresentation: async (id: string) => {
      opened.push(id);
      return { id, taskId: "task-1", status: "open" };
    },
  } as unknown as TandemService;
  try {
    const { deps, sent } = routing(home, service, {
      evaluate: async (input) => {
        // Only openable presentations are offered, before briefs.
        expect(Object.keys(input.questions.target?.criteria ?? {})).toEqual(["c1", "c2", "none"]);
        return {
          model: JEV_MODEL,
          answers: {
            request: choiceAnswer({ choice: "open" }),
            target: choiceAnswer({ choice: "c1" }),
          },
          usage: { input_tokens: 12, output_tokens: 8 },
        };
      },
    });
    const result = await routeUserPrompt(typed("pull up the settings mockup"), deps);
    expect(result).toEqual({ handled: true });
    expect(opened).toEqual(["presentation-1"]);
    expect(sent()).toHaveLength(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function choiceReplyFixture(replyChoice: Choice) {
  const answered: unknown[] = [];
  const approved: unknown[] = [];
  const service = {
    list: async () => [
      {
        id: "task-1",
        stage: "blocked",
        communication: {
          revision: 1,
          messages: [],
          question: {
            id: `${RESTART_QUESTION_ID_PREFIX}incident`,
            text: 'The worker for "fix login" stopped. Restart it? Reply "restart" or "stop".',
          },
        },
      },
    ],
    pendingBriefApprovalId: async () => "req-1",
    requestBrief: async () => ({
      record: { draft: { revision: 3, contentDigest: "digest", content: { goal: "Fix login" } } },
    }),
    answer: async (input: unknown) => {
      answered.push(input);
      return { taskId: "task-1", messages: [] };
    },
    approveRequestBrief: async (input: unknown) => {
      approved.push(input);
      return { record: { id: "req-1" }, approvalState: "current", markdown: "", pausedTaskIds: [] };
    },
  } as unknown as TandemService;
  const lookups: string[] = [];
  const evaluate = async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
    const question = input.questions.reply;
    if (question === undefined) {
      lookups.push(JSON.stringify(input.state));
      return response(
        { choice: "none" },
        { choice: "conversation" },
        { choice: "read-only" },
        { choice: "within" },
        { choice: "single" },
      );
    }
    const options = Object.keys(question.criteria ?? {});
    const confidence = replyChoice.confidence ?? 0.95;
    return {
      model: JEV_MODEL,
      answers: {
        reply: {
          type: "choice",
          choice: replyChoice.choice,
          confidence,
          probabilities: Object.fromEntries(
            options.map((option) => [
              option,
              option === replyChoice.choice ? confidence : (1 - confidence) / (options.length - 1),
            ]),
          ),
        },
      },
      usage: { input_tokens: 9, output_tokens: 1 },
    };
  };
  const recording = recordingSessionHost();
  const deps = (home: string, confirmation?: ChoiceConfirmation) =>
    routing(
      home,
      service,
      { evaluate, ...(confirmation === undefined ? {} : { confirmation }) },
      recording,
    ).deps;
  const sent = () =>
    recording.effects.flatMap((effect) => (effect.type === "deliver" ? [effect.text] : []));
  return { service, evaluate, recording, sent, answered, approved, lookups, deps };
}

test("a short reply to a fixed-choice question answers it in code, with no coordinator turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-"));
  const fixture = choiceReplyFixture({ choice: "c1" });
  try {
    const result = await routeUserPrompt(typed("yeah restart it"), fixture.deps(home));
    expect(result).toEqual({ handled: true });
    expect(fixture.answered).toEqual([
      { taskId: "task-1", questionId: `${RESTART_QUESTION_ID_PREFIX}incident`, text: "restart" },
    ]);
    expect(fixture.sent()).toHaveLength(1);
    expect(fixture.lookups).toEqual([]);
    const raw = await readFile(join(home, "logs", "tandem.jsonl"), "utf8");
    expect(raw).toContain("choice-reply-route/1");
    expect(raw).toContain("prompt-route-dispatched");
    expect(raw).not.toContain("yeah restart it");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a risky choice runs only after an exact y to a code-written confirmation", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-"));
  // c3 is the brief approval, after the restart question's two choices.
  const fixture = choiceReplyFixture({ choice: "c3" });
  const confirmation: ChoiceConfirmation = {};
  try {
    expect(
      await routeUserPrompt(typed("yes sounds good"), fixture.deps(home, confirmation)),
    ).toEqual({ handled: true });
    expect(fixture.recording.effects).toEqual([
      {
        type: "deliver",
        source: "prompt-route",
        text: 'Approve the brief for "Fix login"? (y/n)',
        details: {
          promptHash: expect.any(String),
          action: "brief-approve",
          awaitingConfirmation: true,
        },
        timing: "nextTurn",
        triggerTurn: false,
      },
    ]);
    expect(fixture.approved).toEqual([]);

    // Nobody can answer an approval dialog here, so only the typed "y" can approve.
    expect(await routeUserPrompt(typed("y"), fixture.deps(home, confirmation))).toEqual({
      handled: true,
    });
    expect(fixture.approved).toEqual([
      { requestId: "req-1", briefRevision: 3, contentDigest: "digest" },
    ]);
    expect(fixture.recording.confirmations).toEqual([]);
    expect(confirmation.pending).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a risky choice is dropped on n, and on anything else the reply routes as a new prompt", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-"));
  const declined = choiceReplyFixture({ choice: "c3" });
  const confirmation: ChoiceConfirmation = {};
  try {
    await routeUserPrompt(typed("approve it"), declined.deps(home, confirmation));
    expect(await routeUserPrompt(typed("n"), declined.deps(home, confirmation))).toEqual({
      handled: true,
    });
    expect(declined.approved).toEqual([]);
    expect(declined.recording.effects.at(-1)).toEqual({
      type: "deliver",
      source: "prompt-route",
      text: "Okay, I didn't do that.",
      details: { promptHash: expect.any(String), action: "brief-approve", declined: true },
      timing: "nextTurn",
      triggerTurn: false,
    });

    await routeUserPrompt(typed("approve it"), declined.deps(home, confirmation));
    // "yes please" is not an exact "y": nothing is approved and the reply goes on to the coordinator.
    const changed = choiceReplyFixture({ choice: "other" });
    expect(await routeUserPrompt(typed("yes please"), changed.deps(home, confirmation))).toEqual({
      handled: false,
    });
    expect(changed.approved).toEqual([]);
    expect(declined.approved).toEqual([]);
    expect(confirmation.pending).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("without a confirmation holder, or below the cutoff, the reply goes to the coordinator", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-"));
  try {
    const risky = choiceReplyFixture({ choice: "c3" });
    expect(await routeUserPrompt(typed("approve it"), risky.deps(home))).toEqual({
      handled: false,
    });
    expect(risky.approved).toEqual([]);

    const unsure = choiceReplyFixture({ choice: "c1", confidence: 0.6 });
    expect(await routeUserPrompt(typed("hmm restart?"), unsure.deps(home))).toEqual({
      handled: false,
    });
    expect(unsure.answered).toEqual([]);
    // The ordinary lookup routes still get their turn.
    expect(unsure.lookups).toHaveLength(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed reply delivery is reported as the action's failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-route-"));
  const recording = recordingSessionHost();
  recording.failNext("deliver");
  const service = { list: async () => [] } as unknown as TandemService;
  try {
    const { deps } = routing(home, service, { evaluate: async () => listFacts }, recording);
    expect(await routeUserPrompt(typed("list my tasks"), deps)).toEqual({ handled: true });
    expect(recording.effects.map((effect) => effect.type === "deliver" && effect.details)).toEqual([
      { promptHash: expect.any(String), action: "list" },
      { promptHash: expect.any(String), action: "list", error: "action-failed" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the OMP input hook holds a risky choice's confirmation for exactly one message", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-prompt-hook-"));
  const fixture = choiceReplyFixture({ choice: "c3" });
  const fetch: JevFetch = async (_endpoint, init) =>
    new Response(
      JSON.stringify(await fixture.evaluate(JSON.parse(String(init?.body)) as JevEvaluationInput)),
    );
  try {
    const { input, sent } = registeredInputHook(home, fixture.service, {
      apiKey: "key",
      timeoutMs: 1_500,
      fetch,
    });
    expect(await input(ompInput("yes sounds good"), HEADLESS)).toEqual({ handled: true });
    expect(sent).toEqual([
      {
        message: {
          customType: "tandem-prompt-route",
          content: 'Approve the brief for "Fix login"? (y/n)',
          display: true,
          attribution: "agent",
          details: {
            promptHash: expect.any(String),
            action: "brief-approve",
            awaitingConfirmation: true,
          },
        },
        options: { deliverAs: "nextTurn" },
      },
    ]);
    expect(await input(ompInput("y"), HEADLESS)).toEqual({ handled: true });
    expect(fixture.approved).toHaveLength(1);
    // The confirmation was used up: a second "y" routes as a new reply and is only asked back.
    expect(await input(ompInput("y"), HEADLESS)).toEqual({ handled: true });
    expect(fixture.approved).toHaveLength(1);
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)).toMatchObject({ message: { details: { awaitingConfirmation: true } } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
