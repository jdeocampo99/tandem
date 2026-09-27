import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { RequestPlanningAnswer } from "../../src/contracts.ts";
import { ompToolCall } from "../../src/extension/omp-host.ts";
import { registerTandemOmp } from "../../src/extension/registration.ts";
import {
  addRequestPlanningQuestion,
  createRequestBriefRecord,
  recordRequestPlanningAnswer,
} from "../../src/requests/brief.ts";
import type { TandemService } from "../../src/service/controller.ts";
import type { ToolCall } from "../../src/session/events.ts";
import { planningAskInput } from "../../src/session/planning-interview.ts";
import {
  COORDINATOR_RESEARCH_RUNNING_REFUSAL,
  COORDINATOR_TOOL_REFUSAL,
  type CoordinatorToolPolicy,
  coordinatorToolRefusal,
} from "../../src/session/tool-guard.ts";

function policy(overrides: Partial<CoordinatorToolPolicy> = {}): CoordinatorToolPolicy {
  return {
    researchRunning: async () => false,
    home: "/tandem-home",
    cwd: "/repo",
    userHome: "/Users/someone",
    realpath: async (path) => path,
    ...overrides,
  };
}

/** How OMP presents a tool call: its native name and raw input. */
function omp(toolName: string, input: Record<string, unknown>): ToolCall {
  return ompToolCall({ toolCallId: "call-1", toolName, input });
}

test("OMP tool calls classify into kinds, with MCP calls under either native shape", () => {
  expect(omp("read", { path: "src/main.ts" })).toEqual({
    id: "call-1",
    name: "read",
    kind: "read",
    path: "src/main.ts",
  });
  expect(omp("bash", { command: "ls" })).toMatchObject({ kind: "shell", command: "ls" });
  expect(omp("mcp__linear_get_issue", {})).toMatchObject({
    kind: "mcp",
    mcpTool: "mcp__linear_get_issue",
  });
  expect(omp("write", { path: "xd://mcp__linear_get_issue", content: "{}" })).toMatchObject({
    kind: "mcp",
    mcpTool: "mcp__linear_get_issue",
  });
  // Reading an MCP tool's docs is a read, not an MCP call.
  expect(omp("read", { path: "xd://mcp__linear_get_issue" })).toMatchObject({ kind: "read" });
  expect(omp("write", { path: "notes.md" })).toMatchObject({ kind: "write" });
  expect(omp("read", { path: 42 })).toEqual({ id: "call-1", name: "read", kind: "read" });
  expect(omp("tandem", { request: { action: "list" } })).toMatchObject({ kind: "other" });
});

test("coordinator is refused web reads but can use every MCP call", async () => {
  const refused: [string, Record<string, unknown>][] = [
    ["read", { path: "https://tagalingo.app/" }],
    ["read", { path: "src; http://localhost:5173/" }],
  ];
  for (const [tool, input] of refused) {
    expect(await coordinatorToolRefusal(omp(tool, input), policy())).toBe(COORDINATOR_TOOL_REFUSAL);
  }
  expect(
    await coordinatorToolRefusal(
      omp("write", { path: "xd://mcp__playwright_browser_navigate" }),
      policy(),
    ),
  ).toBeUndefined();
  expect(
    await coordinatorToolRefusal(omp("mcp__sentry_search_issues", {}), policy()),
  ).toBeUndefined();
});

test("while research runs the coordinator reads only Tandem reports and briefs", async () => {
  const researching = policy({ researchRunning: async () => true });
  const refused = [
    "src/routes/settings.tsx",
    "/repo/CLAUDE.md",
    "/tandem-home/pool/.treehouse/app-db7c/1/app/src/routes/settings.tsx",
    "../other-repo/README.md",
    "~/notes.md",
  ];
  for (const path of refused) {
    expect(await coordinatorToolRefusal(omp("read", { path }), researching)).toBe(
      COORDINATOR_RESEARCH_RUNNING_REFUSAL,
    );
  }
  const allowed = [
    "/tandem-home/jobs/abc/report.md",
    "/tandem-home/request-briefs/req-1.md",
    "pr://tagalog-learning-app/42",
    "xd://mcp__linear_get_issue",
  ];
  for (const path of allowed) {
    expect(await coordinatorToolRefusal(omp("read", { path }), researching)).toBeUndefined();
  }
});

test("the registered OMP tool_call hook blocks with the guard's reason", async () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
  } as unknown as ExtensionAPI;
  registerTandemOmp(pi, {
    getService: () => ({}) as TandemService,
    getHome: () => "/tandem-home",
    promptRouting: { timeoutMs: 1_500 },
    reconcile: async () => undefined,
    postAction: async () => undefined,
    userPrompt: () => undefined,
    closeThread: () => undefined,
    researchRunning: async () => false,
  });
  const hook = handlers.get("tool_call");
  if (hook === undefined) throw new Error("tool_call hook was not registered");
  const call = (toolName: string, input: object) =>
    hook({ type: "tool_call", toolCallId: "call-1", toolName, input }, { cwd: "/repo" });
  expect(await call("write", { path: "xd://mcp__playwright_browser_navigate" })).toBeUndefined();
  expect(await call("mcp__linear_get_issue", {})).toBeUndefined();
  expect(await call("read", { path: "https://example.com" })).toEqual({
    block: true,
    reason: COORDINATOR_TOOL_REFUSAL,
  });
});

test("OMP saves only an explicit answer for the exact pending planning question", async () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
  } as unknown as ExtensionAPI;
  let record = addRequestPlanningQuestion(
    createRequestBriefRecord(
      {
        id: "req-interview",
        repoPath: "/repo",
        content: {
          goal: "Choose a behavior",
          scope: ["src"],
          constraints: [],
          nonGoals: [],
          acceptanceCriteria: ["the decision is durable"],
          manualVerification: [],
          recommendedApproach: "Use research evidence",
          keyDecisions: [],
          openQuestions: ["Which contract should remain?"],
          researchLinks: [],
        },
        planningInterview: {
          schemaVersion: 1,
          status: "active",
          researchTaskIds: ["scout-1"],
          questions: [],
        },
      },
      "2030-01-01T00:00:00.000Z",
    ),
    {
      context: "Research found two paths.",
      question: "Which contract should remain?",
      options: [{ label: "Existing" }, { label: "New" }],
      recommendedOption: 0,
    },
    "plan-1",
    "2030-01-01T00:00:00.000Z",
  );
  const question = record.planningInterview?.questions[0];
  if (question === undefined) throw new Error("planning question was not saved");
  const service = {
    requestBriefs: async () => [record],
    recordRequestPlanningAnswer: async (
      _requestId: string,
      questionId: string,
      answer: RequestPlanningAnswer,
    ) => {
      const saved = recordRequestPlanningAnswer(
        record,
        questionId,
        answer,
        "2030-01-01T00:00:00.000Z",
      );
      record = saved.record;
      return saved;
    },
  } as unknown as TandemService;
  registerTandemOmp(pi, {
    getService: () => service,
    getHome: () => "/tandem-home",
    promptRouting: { timeoutMs: 1_500 },
    reconcile: async () => undefined,
    postAction: async () => undefined,
    userPrompt: () => undefined,
    closeThread: () => undefined,
    researchRunning: async () => false,
  });
  const callHook = handlers.get("tool_call");
  const resultHook = handlers.get("tool_result");
  if (callHook === undefined || resultHook === undefined) {
    throw new Error("planning ask hooks were not registered");
  }
  const askInput = planningAskInput(question);
  const context = { cwd: "/repo" };

  expect(await callHook({ toolName: "ask", input: askInput }, context)).toBeUndefined();
  expect(
    await callHook(
      {
        toolName: "ask",
        input: { questions: [{ ...askInput.questions[0], question: "Edited question" }] },
      },
      context,
    ),
  ).toMatchObject({ block: true });
  expect(
    await callHook({ toolName: "ask", input: { questions: [{ question: "unrelated" }] } }, context),
  ).toMatchObject({ block: true });

  const timeout = await resultHook(
    {
      toolName: "ask",
      input: askInput,
      details: {
        question: `${question.context}\n\n${question.question}`,
        options: question.options.map((option) => option.label),
        multi: false,
        selectedOptions: ["Existing"],
        timedOut: true,
      },
      isError: false,
    },
    context,
  );
  expect(timeout).toMatchObject({
    details: { tandemPlanningAnswerSaved: false },
    isError: true,
  });
  expect(record.planningInterview?.questions[0]?.answer).toBeUndefined();

  const explicit = await resultHook(
    {
      toolName: "ask",
      input: askInput,
      details: {
        question: `${question.context}\n\n${question.question}`,
        options: question.options.map((option) => option.label),
        multi: false,
        selectedOptions: ["New"],
        timedOut: false,
      },
      isError: false,
    },
    context,
  );
  expect(explicit).toMatchObject({ details: { tandemPlanningAnswerSaved: true } });
  expect(record.planningInterview?.questions[0]?.answer).toEqual({
    kind: "option",
    value: "New",
  });
});

test("a home reached through a symlink or ~ still counts as Tandem's records", async () => {
  const researching = policy({
    researchRunning: async () => true,
    home: "/Users/someone/.tandem",
    realpath: async () => "/private/tandem",
  });
  for (const path of ["/private/tandem/jobs/abc/report.md", "~/.tandem/jobs/abc/report.md"]) {
    expect(await coordinatorToolRefusal(omp("read", { path }), researching)).toBeUndefined();
  }
});
