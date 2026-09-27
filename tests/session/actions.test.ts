import { expect, test } from "bun:test";
import { renderBoard } from "../../src/board/view.ts";
import type { RepoPolicy } from "../../src/contracts.ts";
import {
  type MemoryShowResult,
  renderCatchUpCard,
  renderMemoryShow,
} from "../../src/memory/view.ts";
import {
  addRequestPlanningQuestion,
  completeRequestPlanningInterview,
  createRequestBriefRecord,
  recordRequestPlanningAnswer,
  reviseRequestBriefRecord,
} from "../../src/requests/brief.ts";
import type { TandemService } from "../../src/service/controller.ts";
import {
  executeTandemAction,
  parseTandemCommand,
  resolveCommandAction,
  runTandemCommand,
  runTandemTool,
  type TandemCallDependencies,
} from "../../src/session/actions.ts";
import type { CoordinatorTurnAction, SessionEffect } from "../../src/session/events.ts";
import { planningAskInput } from "../../src/session/planning-interview.ts";
import {
  ACTION_FULL_RESULT_MAX_CHARS,
  ACTION_RESULT_MAX_CHARS,
  ACTION_TRACE_MAX_EVENTS,
  DIGEST_MAX_CHARS,
  buildDurableDigest,
  summarizeTandemActionValue,
} from "../../src/session/summary.ts";
import type { StoredTimelineEvent } from "../../src/tasks/timeline.ts";
import type { BoundedTaskTrace, TaskTrace } from "../../src/tasks/trace.ts";
import { recordingSessionHost } from "../evals/scenario.ts";
import { expectNoIdentifiers } from "../tasks/question.test.ts";
import { models, policyConfig, task } from "./fixtures.ts";

test("Tandem command parsing preserves quoted values and routes presentation feedback", () => {
  expect(
    parseTandemCommand('present task-1 "show the changed screen" /tmp/a.html,/tmp/b.png'),
  ).toEqual({
    action: "present",
    taskId: "task-1",
    objective: "show the changed screen",
    artifacts: ["/tmp/a.html", "/tmp/b.png"],
  });
  expect(parseTandemCommand("request-receipt")).toEqual({ action: "request-receipt" });
  expect(parseTandemCommand("request-receipt req-1")).toEqual({
    action: "request-receipt",
    requestId: "req-1",
  });
  expect(parseTandemCommand("feedback presentation-1")).toEqual({
    action: "feedback",
    presentationId: "presentation-1",
  });
  expect(parseTandemCommand("show task-1 --full")).toEqual({
    action: "show",
    taskId: "task-1",
    detail: "full",
  });
  expect(parseTandemCommand("trace task-1")).toEqual({ action: "trace", taskId: "task-1" });
  expect(() => parseTandemCommand("trace")).toThrow();
  expect(() => parseTandemCommand("trace task-1 extra")).toThrow();
  expect(parseTandemCommand("presentations")).toEqual({ action: "presentations" });
  expect(parseTandemCommand("models")).toEqual({ action: "models", repoPath: "." });
  expect(parseTandemCommand("models /repo")).toEqual({ action: "models", repoPath: "/repo" });
  expect(
    parseTandemCommand('create /repo implementation "ship feature" "behavior,tests" "src,tests"'),
  ).toEqual({
    action: "create",
    repoPath: "/repo",
    kind: "implementation",
    objective: "ship feature",
    acceptanceCriteria: ["behavior", "tests"],
    surfaces: ["src", "tests"],
  });
  expect(
    parseTandemCommand(
      'create /repo implementation "ship feature" "behavior" "src" "scout-a,scout-b"',
    ),
  ).toMatchObject({
    action: "create",
    researchTaskIds: ["scout-a", "scout-b"],
  });
});

test("create forwards the named request so work can join one of several open requests", async () => {
  const createCalls: unknown[] = [];
  const service = {
    create: async (input: unknown) => {
      createCalls.push(input);
      return task({});
    },
  } as unknown as TandemService;
  const noDialog = { confirm: undefined };

  await executeTandemAction(
    {
      action: "create",
      repoPath: "/repo",
      requestId: "req-2",
      kind: "implementation",
      objective: "ship feature",
      acceptanceCriteria: ["behavior"],
      surfaces: ["src"],
    },
    service,
    noDialog,
  );

  expect(createCalls).toMatchObject([{ requestId: "req-2" }]);
});

test("create forwards skill names and the created task summary names each skill", async () => {
  const createCalls: unknown[] = [];
  const created = task({
    skills: [
      {
        name: "refactor-functions",
        origin: "repository",
        directory: "/repo/.claude/skills/refactor-functions",
        instructions: "Refactor foo.ts",
      },
      {
        name: "tdd",
        origin: "personal",
        directory: "/Users/me/.claude/skills/tdd",
        instructions: "Test first.",
      },
    ],
  });
  const service = {
    create: async (input: unknown) => {
      createCalls.push(input);
      return created;
    },
  } as unknown as TandemService;
  const noDialog = { confirm: undefined };

  const result = await executeTandemAction(
    {
      action: "create",
      repoPath: "/repo",
      kind: "implementation",
      objective: "ship feature",
      acceptanceCriteria: ["behavior"],
      surfaces: ["src"],
      skills: ["refactor-functions", "tdd"],
    },
    service,
    noDialog,
  );

  expect(createCalls).toEqual([
    {
      repoPath: "/repo",
      kind: "implementation",
      objective: "ship feature",
      acceptanceCriteria: ["behavior"],
      surfaces: ["src"],
      skills: ["refactor-functions", "tdd"],
    },
  ]);
  expect(result.value).toBe(created);
  expect(summarizeTandemActionValue("create", created)).toContain(
    "Skills: refactor-functions (from the repository), tdd (personal)",
  );
});

test("inspection and delivery slash commands preserve their arguments", () => {
  expect(parseTandemCommand("inspect task-1")).toEqual({
    action: "inspect",
    taskId: "task-1",
  });
  expect(parseTandemCommand("delivery-preflight task-1 main")).toEqual({
    action: "delivery-preflight",
    taskId: "task-1",
    base: "main",
  });
  expect(
    summarizeTandemActionValue("delivery-preflight", {
      taskId: "task-1",
      ready: false,
      refusals: ["the worktree has uncommitted or unmerged changes"],
    }),
  ).toBe("task-1: not ready to publish: the worktree has uncommitted or unmerged changes");
});

test("board summaries validate required Running row data", () => {
  const row = {
    key: "task-1:implementing",
    cause: "implementing",
    project: "app",
    mark: "🔨",
    name: "Fix the flaky login test",
    text: "implementing",
  };
  const board = {
    now: "2030-01-01T12:00:00.000Z",
    projects: ["app"],
    needsYou: [],
    pullRequests: [],
    finished: 0,
  };
  const complete = {
    ...board,
    running: [{ ...row, repoPath: "/work/app", since: "12m" }],
  };
  expect(summarizeTandemActionValue("board", complete)).toContain(
    "- 🔨 **app** · **Fix the flaky login test** — implementing · 12m",
  );

  const incomplete = [
    { ...board, running: [{ ...row, since: "12m" }] },
    { ...board, running: [{ ...row, repoPath: "/work/app" }] },
    {
      ...board,
      running: [
        {
          ...row,
          cause: "ready",
          repoPath: "/work/app",
          since: "12m",
        },
      ],
    },
  ];
  for (const value of incomplete) {
    expect(summarizeTandemActionValue("board", value)).toBe(JSON.stringify(value));
  }
});

test("communication slash commands join quoted deltas and reject extra message arguments", () => {
  expect(parseTandemCommand('steer task-1 "preserve the API" now')).toEqual({
    action: "steer",
    taskId: "task-1",
    text: "preserve the API now",
  });
  expect(parseTandemCommand('answer task-1 question-1 "use the adapter"')).toEqual({
    action: "answer",
    taskId: "task-1",
    questionId: "question-1",
    text: "use the adapter",
  });
  expect(parseTandemCommand("messages task-1")).toEqual({
    action: "messages",
    taskId: "task-1",
  });
  expect(() => parseTandemCommand("messages task-1 extra")).toThrow("expects at most");
});

test("communication summaries keep newest actionable state and question identity visible", () => {
  const history = Array.from({ length: 8 }, (_, index) => ({
    id: `old-${index + 1}`,
    revision: index + 1,
    kind: "instruction" as const,
    text: `HISTORY_SENTINEL_${index + 1}`,
    createdAt: "2030-01-02T03:04:05.000Z",
    status: "applied" as const,
  }));
  const view = {
    taskId: "task-1",
    stage: "implementing",
    revision: 9,
    messages: [
      ...history,
      {
        id: "newest",
        revision: 9,
        kind: "instruction" as const,
        text: "NEWEST_ACTIONABLE",
        createdAt: "2030-01-02T03:04:06.000Z",
        status: "received" as const,
      },
    ],
    question: {
      id: "question-9",
      text: "QUESTION_NEEDS_ID",
      recommendation: "RECOMMENDATION_VISIBLE",
    },
    activity: {
      phase: "tool",
      tool: "edit",
      heartbeatAt: "2030-01-02T03:04:07.000Z",
      progressAt: "2030-01-02T03:04:08.000Z",
    },
  };

  const overview = summarizeTandemActionValue("messages", view);
  const latest = summarizeTandemActionValue("steer", view);

  expect(overview).toContain("question-9");
  expect(overview).toContain("QUESTION_NEEDS_ID");
  expect(overview).toContain("RECOMMENDATION_VISIBLE");
  expect(overview).toContain("NEWEST_ACTIONABLE");
  expect(overview).toContain("Last activity");
  expect(overview).toContain("2030-01-02T03:04:07.000Z");
  expect(overview).not.toContain("HISTORY_SENTINEL_1");
  expect(latest).toContain("NEWEST_ACTIONABLE");
  expect(latest).not.toContain("HISTORY_SENTINEL_1");
  expect(latest).not.toContain("QUESTION_NEEDS_ID");
});

test("approve confirmation exposes active non-superseded communication deltas and revision", async () => {
  const pending = task({
    communication: {
      revision: 3,
      messages: [
        {
          id: "direction-old",
          revision: 1,
          kind: "instruction",
          text: "REPLACE_ME_OLD",
          createdAt: "2030-01-02T03:04:05.000Z",
        },
        {
          id: "direction-current",
          revision: 2,
          kind: "instruction",
          text: "Preserve the existing adapter.",
          createdAt: "2030-01-02T03:04:06.000Z",
          supersedes: ["direction-old"],
        },
        {
          id: "answer-current",
          revision: 3,
          kind: "answer",
          text: "Use the compatibility path.",
          createdAt: "2030-01-02T03:04:07.000Z",
          replyTo: "question-1",
        },
      ],
    },
  });
  const prompts: string[] = [];
  const service = {
    get: async () => pending,
    approve: async () => pending,
  } as unknown as TandemService;
  const context = {
    confirm: async (_title: string, message: string) => {
      prompts.push(message);
      return false;
    },
  };

  const result = await executeTandemAction(
    { action: "approve", taskId: "task-1" },
    service,
    context,
  );

  expect(result.approved).toBe(false);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toBe("Includes 2 directions you gave after the plan.");
});

test("extension setup approval preserves the write boundary and metadata", async () => {
  const prompts: Array<{ readonly title: string; readonly message: string }> = [];
  const writeCalls: string[] = [];
  let allow = false;
  const configPath = "/tandem-home/repositories/abc123/config.json";
  const service = {
    setupOnboard: async (repoPath: string, write = false) => {
      if (write) writeCalls.push(repoPath);
      return {
        repoPath,
        configPath,
        existingConfig: false,
        written: write,
        modelSettings: {
          configPath: "/tandem-home/models.json",
          configured: false,
        },
        policy: policyConfig,
        proposedPolicy: policyConfig,
        validationCommands: [],
        setupCommands: [],
        unresolved: [],
      };
    },
  } as unknown as TandemService;
  const context = {
    confirm: async (title: string, message: string) => {
      prompts.push({ title, message });
      return allow;
    },
  };

  const refused = await executeTandemAction(
    { action: "setup", repoPath: "/repo" },
    service,
    context,
  );

  expect(refused.approved).toBe(false);
  expect(writeCalls).toEqual([]);
  expect(prompts).toHaveLength(1);

  allow = true;
  const saved = await executeTandemAction({ action: "setup", repoPath: "/repo" }, service, context);

  expect(saved.approved).toBe(true);
  expect(writeCalls).toEqual(["/repo"]);
  const savedValue = saved.value as Record<string, unknown>;
  expect(savedValue.configPath).toBe(configPath);
  expect(savedValue.written).toBe(true);
});

test("open-project opens a project's chat only after the user approves it", async () => {
  const prompts: Array<{ readonly title: string; readonly message: string }> = [];
  const opened: string[] = [];
  let allow = false;
  const service = {
    openProject: async (repoPath: string) => {
      opened.push(repoPath);
      return { repoPath };
    },
  } as unknown as TandemService;
  const context = {
    confirm: async (title: string, message: string) => {
      prompts.push({ title, message });
      return allow;
    },
  };

  const refused = await executeTandemAction(
    { action: "open-project", repoPath: "/code/app" },
    service,
    context,
  );
  expect(refused.approved).toBe(false);
  expect(opened).toEqual([]);
  expect(prompts[0]?.title).toBe("Open app in Tandem?");

  allow = true;
  const done = await executeTandemAction(
    { action: "open-project", repoPath: "/code/app" },
    service,
    context,
  );
  expect(done.approved).toBe(true);
  expect(opened).toEqual(["/code/app"]);
  expect(parseTandemCommand("open-project /code/app")).toEqual({
    action: "open-project",
    repoPath: "/code/app",
  });
});

test("setup's approval shows the checks and install step", async () => {
  const prompts: Array<{ readonly title: string; readonly message: string }> = [];
  const writes: unknown[][] = [];
  const service = {
    setupOnboard: async (repoPath: string, write = false, commands?: unknown) => {
      if (write) writes.push([repoPath, commands]);
      return {
        repoPath,
        existingConfig: false,
        written: write,
        modelSettings: { configured: true },
        validationCommands: [{ name: "make check" }],
        setupCommands: [{ name: "make deps" }],
        unresolved: [],
      };
    },
  } as unknown as TandemService;
  const action = {
    action: "setup",
    repoPath: "/code/api",
    validationCommands: ["make check"],
    setupCommands: ["make deps"],
  } as const;
  const result = await executeTandemAction(action, service, {
    confirm: async (title: string, message: string) => {
      prompts.push({ title, message });
      return true;
    },
  });
  expect(result.approved).toBe(true);
  expect(prompts[0]?.title).toBe("Save Tandem settings for api?");
  expect(prompts[0]?.message).toContain("Checks: make check");
  expect(prompts[0]?.message).toContain("Install in fresh copies: make deps");
  expect(writes).toEqual([["/code/api", action]]);
});

test("onboarding saves ask first, and lookups do not", async () => {
  const prompts: string[] = [];
  const calls: string[] = [];
  const service = {
    saveProjectRoots: async (roots: readonly string[]) => calls.push(`roots ${roots.join(",")}`),
    saveSelfImprovement: async (mode: string) => calls.push(`self ${mode}`),
    findRepo: async () => [{ path: "/code/api", repo: "acme/api", setUp: true }],
    checkTools: async () => [
      { name: "OMP", ok: false, detail: "not found", fix: "bun install -g omp" },
    ],
  } as unknown as TandemService;
  const context = {
    confirm: async (title: string) => {
      prompts.push(title);
      return true;
    },
  };
  await executeTandemAction(
    { action: "save-code-folders", folders: ["/Users/me/code"] },
    service,
    context,
  );
  await executeTandemAction({ action: "self-improvement", mode: "fix" }, service, context);
  expect(prompts).toEqual([
    "Look for your repos in these folders?",
    "Let Tandem look into its own problems and offer fixes?",
  ]);
  expect(calls).toEqual(["roots /Users/me/code", "self fix"]);

  const found = await executeTandemAction({ action: "find-repo", name: "api" }, service, context);
  expect(prompts).toHaveLength(2);
  const tools = await executeTandemAction({ action: "check-tools" }, service, context);
  expect(summarizeTandemActionValue("find-repo", found.value)).toBe(
    "Found api:\n- /code/api (acme/api) (already set up)",
  );
  expect(summarizeTandemActionValue("check-tools", tools.value)).toBe(
    "✗ OMP: not found. Fix: bun install -g omp",
  );
  expect(summarizeTandemActionValue("find-repo", { name: "web", matches: [] })).toContain(
    "No checkout named web",
  );
});

test("find-repo with one new checkout also says what Tandem found there", async () => {
  const service = {
    findRepo: async () => [{ path: "/code/api", repo: "acme/api", setUp: false }],
    setupOnboard: async (repoPath: string) => ({
      repoPath,
      existingConfig: false,
      written: false,
      modelSettings: { configured: true },
      validationCommands: [{ name: "bun run check" }],
      setupCommands: [{ name: "bun install --frozen-lockfile" }],
      unresolved: [],
    }),
    mcpServers: async () => ["linear"],
    mergingCheck: async () => {
      throw new Error("gh is not signed in");
    },
  } as unknown as TandemService;
  const found = await executeTandemAction({ action: "find-repo", name: "api" }, service, {
    confirm: undefined,
  });
  const summary = summarizeTandemActionValue("find-repo", found.value);
  expect(summary).toContain("- /code/api (acme/api)");
  expect(summary).toContain("Checks it would run before calling work done: bun run check");
  expect(summary).toContain("Install step for fresh copies: bun install --frozen-lockfile");
  expect(summary).toContain("MCP tools OMP loaded for this project: linear");
});

test("model listing is read-only and model changes require approval", async () => {
  const modelOptions = {
    modelSettings: {
      configPath: "/tandem-home/models.json",
      configured: false,
    },
    availableModels: [
      {
        selector: "openai-codex/gpt-6-astra",
        id: "gpt-6-astra",
        provider: "openai-codex",
        thinking: ["high"],
        name: "Astra",
        reasoning: true,
        contextWindow: 128_000,
        cost: { input: 1, output: 2 },
      },
    ],
  };
  const savedSettings = {
    configPath: "/tandem-home/models.json",
    configured: true,
    models,
  };
  const modelCalls: string[] = [];
  const configureCalls: unknown[] = [];
  const service = {
    models: async (repoPath: string) => {
      modelCalls.push(repoPath);
      return modelOptions;
    },
    configureModels: async (input: unknown) => {
      configureCalls.push(input);
      return savedSettings;
    },
  } as unknown as TandemService;
  const noDialog = { confirm: undefined };

  const listing = await executeTandemAction(
    { action: "models", repoPath: "/repo" },
    service,
    noDialog,
  );

  expect(listing.approved).toBeUndefined();
  expect(listing.value).toBe(modelOptions);
  expect(modelCalls).toEqual(["/repo"]);
  const listingSummary = summarizeTandemActionValue("models", modelOptions);
  for (const role of [
    "Planning (coordinator)",
    "Research (scout)",
    "Coding (implementer)",
    "Review (reviewer)",
    "Presentations (presentation)",
  ] as const) {
    expect(listingSummary).toContain(role);
  }

  const denied = await executeTandemAction(
    { action: "configure-models", repoPath: "/repo", models },
    service,
    noDialog,
  );

  expect(denied.approved).toBe(false);
  expect(configureCalls).toEqual([]);

  const withDialog = (allow: boolean) => ({ confirm: async () => allow });
  const refused = await executeTandemAction(
    { action: "configure-models", repoPath: "/repo", models },
    service,
    withDialog(false),
  );

  expect(refused.approved).toBe(false);
  expect(configureCalls).toEqual([]);

  const configured = await executeTandemAction(
    { action: "configure-models", repoPath: "/repo", models },
    service,
    withDialog(true),
  );

  expect(configured.approved).toBe(true);
  expect(configureCalls).toEqual([{ repoPath: "/repo", models }]);
  expect(configured.value).toBe(savedSettings);
});

test("configure-models forwards explicit provider enablement and recaps it in the approval prompt", async () => {
  const configureCalls: unknown[] = [];
  const prompts: string[] = [];
  const service = {
    configureModels: async (input: unknown) => {
      configureCalls.push(input);
      return {
        configPath: "/tandem-home/models.json",
        configured: true,
        models,
        enabledProviders: ["openai-codex"],
      };
    },
  } as unknown as TandemService;
  const withDialog = {
    confirm: async (_title: string, message: string) => {
      prompts.push(message);
      return true;
    },
  };

  const result = await executeTandemAction(
    { action: "configure-models", repoPath: "/repo", models, enabledProviders: ["openai-codex"] },
    service,
    withDialog,
  );

  expect(result.approved).toBe(true);
  expect(configureCalls).toEqual([
    { repoPath: "/repo", models, enabledProviders: ["openai-codex"] },
  ]);
  expect(prompts[0]).toContain("Can spend on: openai-codex.");
});

test("models summary surfaces discovered/enabled providers and a resolved Balanced proposal", () => {
  const summary = summarizeTandemActionValue("models", {
    modelSettings: {
      configPath: "/tandem-home/models.json",
      configured: false,
      enabledProviders: ["openai-codex"],
    },
    availableModels: [],
    discoveredProviders: ["openai-codex", "other-provider"],
    balancedProfile: {
      status: "resolved",
      assignments: {},
      roles: {
        coordinator: {
          role: "coordinator",
          provider: "openai-codex",
          model: { model: "openai-codex/gpt-6-astra", thinking: "high" },
          evidence: { reasoning: true },
          reason: "provider openai-codex is enabled",
        },
      },
    },
  });

  expect(summary).toContain("Providers found");
  expect(summary).toContain("other-provider");
  expect(summary).toContain("Providers allowed to spend");
  expect(summary).toContain("openai-codex/gpt-6-astra");
  expect(summary).toContain("Planning (coordinator)");
});

test("models summary discloses unresolved Balanced roles with actionable reasons", () => {
  const summary = summarizeTandemActionValue("models", {
    modelSettings: {
      configPath: "/tandem-home/models.json",
      configured: false,
      enabledProviders: [],
    },
    availableModels: [],
    discoveredProviders: [],
    balancedProfile: {
      status: "unresolved",
      roles: {},
      gaps: [{ role: "coordinator", reason: "no provider is explicitly enabled for spending yet" }],
    },
  });

  expect(summary).toContain("No suitable model was found for these roles");
  expect(summary).toContain("Planning (coordinator)");
  expect(summary).toContain("no provider is explicitly enabled");
});

test("onboard summaries render complete saved and pending role selections", () => {
  const savedModels: RepoPolicy["models"] = {
    coordinator: { model: "provider/planning", thinking: "high" },
    scout: { model: "provider/research", thinking: "low" },
    implementer: { model: "provider/coding", thinking: "max" },
    reviewer: { model: "provider/review", thinking: "medium" },
    presentation: { model: "provider/presentations", thinking: "minimal" },
  };
  const roleIdentities = [
    "Planning (coordinator)",
    "Research (scout)",
    "Coding (implementer)",
    "Review (reviewer)",
    "Presentations (presentation)",
  ] as const;

  const savedSummary = summarizeTandemActionValue("onboard", {
    repoPath: "/repo",
    existingConfig: true,
    written: false,
    modelSettings: {
      configPath: "/tandem-home/models.json",
      configured: true,
      models: savedModels,
    },
    unresolved: [],
  });
  for (const role of roleIdentities) expect(savedSummary).toContain(role);
  for (const assignment of Object.values(savedModels)) {
    expect(savedSummary).toContain(`${assignment.model} (thinking ${assignment.thinking})`);
  }
  expect(savedSummary).toContain("Keep all");
  expect(savedSummary).toContain("Change roles");
  expect(savedSummary).toContain("Not now");

  const pendingSummary = summarizeTandemActionValue("onboard", {
    repoPath: "/repo",
    existingConfig: false,
    written: false,
    modelSettings: {
      configPath: "/tandem-home/models.json",
      configured: false,
    },
    proposedPolicy: { models: savedModels },
    unresolved: [],
  });
  for (const role of roleIdentities) expect(pendingSummary).toContain(role);
  for (const assignment of Object.values(savedModels)) {
    expect(pendingSummary).not.toContain(assignment.model);
    expect(pendingSummary).not.toContain(`thinking ${assignment.thinking}`);
  }
  expect(pendingSummary).toContain("Not now");
  expect(pendingSummary).not.toContain("Keep all");

  const setupSummary = summarizeTandemActionValue("setup", {
    repoPath: "/repo",
    existingConfig: false,
    written: true,
    modelSettings: {
      configPath: "/tandem-home/models.json",
      configured: false,
    },
    proposedPolicy: { models: savedModels },
    unresolved: [],
  });
  expect(setupSummary).not.toContain("provider/planning");
  expect(setupSummary).not.toContain("Keep all");
});

test("approval-bearing command syntax carries no model-controlled approval field", () => {
  expect(parseTandemCommand("cleanup task-1 task-2 --discard")).toEqual({
    action: "cleanup",
    taskIds: ["task-1", "task-2"],
    discard: true,
  });
  expect(() => parseTandemCommand("merge task-1 squash --approved")).toThrow("expects at most");
});

test("durable digest prioritizes current blockers and preserves acceptance, review, and question evidence", () => {
  const blocked = task({
    id: "blocked",
    stage: "blocked",
    objective: "Current implementation needs a decision",
    acceptanceCriteria: ["Keep the API stable", "Record the decision durably"],
    blockReason: "Waiting for the owner to choose the migration path.",
    reviewHead: "head-active",
    communication: {
      revision: 2,
      messages: [],
      question: {
        id: "question-current",
        text: "Should the existing API remain unchanged?",
        recommendation: "Keep the existing API unchanged.",
      },
    },
    reviews: [
      {
        lens: "behavior",
        head: "head-active",
        generation: 0,
        pass: false,
        findings: [
          {
            id: "finding-current",
            severity: "P1",
            verdict: "confirmed",
            description: "The migration path is not covered by the current behavior.",
          },
        ],
        summary: "Needs a decision.",
      },
    ],
    notifications: [
      { id: "notification-current", message: "Owner decision required.", acknowledged: false },
    ],
  });
  const oldTasks = Array.from({ length: 12 }, (_, index) =>
    task({ id: `old-${index}`, stage: "completed", objective: `old history ${index}` }),
  );
  const digest = buildDurableDigest([...oldTasks, blocked]);

  expect(digest.indexOf("blocked")).toBeLessThan(digest.indexOf("old-0"));
  expect(digest).toContain("Keep the API stable");
  expect(digest).toContain("Waiting for the owner");
  expect(digest).toContain("finding-current");
  expect(digest).toContain("question-current");
  expect(digest).toContain("Should the existing API remain unchanged?");
  expect(digest).toContain("Keep the existing API unchanged.");
  expect(digest).toContain("P1");
  expect(digest).not.toContain("head-active");
  expect(digest).toContain("Finished, nothing new (12): old-0 (old history 0)");
  expect(digest).not.toContain("- old-0:");
});

test("durable digest stays bounded with adversarial identifiers", () => {
  const longIdentifier = "identifier-".padEnd(10_000, "x");
  const digest = buildDurableDigest([
    task({
      id: longIdentifier,
      stage: "blocked",
      blockReason: longIdentifier,
      reviewHead: longIdentifier,
      reviews: [
        {
          lens: "behavior",
          head: longIdentifier,
          generation: 0,
          pass: false,
          findings: [
            {
              id: longIdentifier,
              severity: "P0",
              verdict: "confirmed",
              description: "Current evidence.",
            },
          ],
          summary: "Needs attention.",
        },
      ],
    }),
  ]);

  expect(digest.length).toBeLessThanOrEqual(8_000);
});

test("model-facing action summaries are bounded and retain current task evidence", () => {
  const value = task({
    objective: "Current feature objective",
    acceptanceCriteria: [
      "Keep API stable",
      ...Array.from({ length: 40 }, (_, index) => `criterion ${index} ${"x".repeat(240)}`),
    ],
    surfaces: ["src/extension.ts", "tests/extension.test.ts"],
    reviewHead: "head-current",
    blockReason: "Current blocker",
    reviews: [
      {
        lens: "behavior",
        head: "head-current",
        generation: 0,
        pass: false,
        findings: [
          {
            id: "finding-visible",
            severity: "P0",
            verdict: "confirmed",
            description: "Current evidence requires coordinator attention.",
          },
        ],
        summary: "Needs attention.",
      },
    ],
  });
  const summary = summarizeTandemActionValue("show", value);

  expect(summary.length).toBeLessThanOrEqual(4_000);
  expect(summary).toContain("Keep API stable");
  expect(summary).toContain("Current blocker");
  expect(summary).toContain("finding-visible/P0");
  expect(summary).toContain("head-current");
  expect(summary).not.toContain("maxFixRounds");
});

test("scout summaries and the durable digest carry the post-research disposition", () => {
  const unread = [{ id: "done", message: "Research finished.", acknowledged: false }];
  const scout = task({
    id: "scout-continuation",
    kind: "scout",
    stage: "completed",
    notifications: unread,
    objective: "Investigate the reported defect",
    reportPath: "/reports/scout.md",
    researchContinuation: {
      schemaVersion: 1,
      disposition: "implementation-interview",
      selectedBy: "jev",
      classifierVersion: "jev-continuation-1",
    },
  });
  const summary = summarizeTandemActionValue("show", scout);
  expect(summary).toContain("After research: summarize the report, propose one direction");

  const digest = buildDurableDigest([scout]);
  expect(digest).toContain("after research: implementation-interview");

  const legacyScout = task({
    id: "legacy-scout",
    kind: "scout",
    stage: "completed",
    notifications: unread,
  });
  expect(buildDurableDigest([legacyScout])).toContain("after research: ask-intent");
  const quietScout = { ...legacyScout, notifications: [] };
  expect(buildDurableDigest([quietScout])).not.toContain("after research");
  expect(buildDurableDigest([task({ id: "implementation-task" })])).not.toContain("continuation:");
});

test("durable digest resumes the saved planning question and never promotes an answer to approval", () => {
  const started = createRequestBriefRecord(
    {
      id: "req-plan",
      repoPath: "/repo",
      content: {
        goal: "Choose the compatibility contract",
        scope: ["src"],
        constraints: [],
        nonGoals: [],
        acceptanceCriteria: ["the approved contract is explicit"],
        manualVerification: [],
        recommendedApproach: "Use research evidence",
        keyDecisions: [],
        openQuestions: ["Which contract should remain?", "Should adapter hooks remain stable?"],
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
  );
  const asked = addRequestPlanningQuestion(
    started,
    {
      context: "Research found an existing and a new path.",
      question: "Which contract should remain?",
      options: [{ label: "Existing" }, { label: "New" }],
      recommendedOption: 0,
    },
    "plan-1",
    "2030-01-01T00:00:00.000Z",
  );
  const question = asked.planningInterview?.questions[0];
  if (question === undefined) throw new Error("planning question was not saved");
  const activeDigest = buildDurableDigest([], [asked]);
  expect(activeDigest).toContain(JSON.stringify(planningAskInput(question)));

  const briefSummary = summarizeTandemActionValue("brief-show", {
    record: asked,
    approvalState: "unapproved",
    pausedTaskIds: [],
  });
  expect(briefSummary).toContain(JSON.stringify(planningAskInput(question)));
  const answered = recordRequestPlanningAnswer(
    asked,
    question.id,
    { kind: "option", value: "Existing" },
    "2030-01-01T00:00:00.000Z",
  ).record;
  const resumedDigest = buildDurableDigest([], [answered]);
  expect(resumedDigest).toContain("Saved decision 1: Which contract should remain? → Existing");
  expect(resumedDigest).toContain(
    "Open decisions from the brief, in order: Which contract should remain?; Should adapter hooks remain stable?",
  );
  expect(resumedDigest).not.toContain("Resume this saved question");
  const resumedBriefSummary = summarizeTandemActionValue("brief-show", {
    record: answered,
    approvalState: "unapproved",
    pausedTaskIds: [],
  });
  expect(resumedBriefSummary).toContain(
    "Open decisions from the brief, in order: Which contract should remain?; Should adapter hooks remain stable?",
  );

  const briefed = reviseRequestBriefRecord(
    answered,
    {
      ...answered.draft.content,
      keyDecisions: ["Preserve the existing contract"],
      openQuestions: [],
    },
    "2030-01-01T00:00:00.000Z",
  );
  const completed = completeRequestPlanningInterview(briefed, "2030-01-01T00:00:00.000Z");
  const completedDigest = buildDurableDigest([], [completed]);
  expect(completedDigest).toContain(
    "Final scope is ready for review; request explicit confirmation, then use brief-approve. Never infer approval.",
  );
  expect(completed.approval).toBeUndefined();
});

test("the durable digest keeps planning questions whole before task detail", () => {
  const requests = Array.from({ length: 4 }, (_, index) => {
    const record = createRequestBriefRecord(
      {
        id: `req-digest-${index}`,
        repoPath: "/repo",
        content: {
          goal: `Keep decision ${index} durable`,
          scope: ["src"],
          constraints: [],
          nonGoals: [],
          acceptanceCriteria: ["the selected contract stays explicit"],
          manualVerification: [],
          recommendedApproach: "Preserve the durable answer",
          keyDecisions: [],
          openQuestions: [`Which path ${index}?`],
          researchLinks: [],
        },
        planningInterview: {
          schemaVersion: 1,
          status: "active",
          researchTaskIds: [`scout-${index}`],
          questions: [],
        },
      },
      "2030-01-01T00:00:00.000Z",
    );
    return addRequestPlanningQuestion(
      record,
      {
        context: "c".repeat(800),
        question: `q${index}${"q".repeat(598)}`,
        options: [
          { label: "Existing", description: "e".repeat(240) },
          { label: "New", description: "n".repeat(240) },
          { label: "Hybrid", description: "h".repeat(240) },
        ],
        recommendedOption: 0,
      },
      `plan-${index}`,
      "2030-01-01T00:00:00.000Z",
    );
  });
  const taskObjective = "Task detail must yield to complete planning decisions";
  const digest = buildDurableDigest([task({ objective: taskObjective })], requests);
  let included = 0;
  let omitted = 0;
  const includedQuestionPositions: number[] = [];

  expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  expect(digest).toContain("brief-show for exact questions");
  for (const [index, request] of requests.entries()) {
    const question = request.planningInterview?.questions.at(-1);
    if (question === undefined) throw new Error("planning question was not saved");
    const payload = JSON.stringify(planningAskInput(question));
    const position = digest.indexOf(payload);
    if (position >= 0) {
      included += 1;
      includedQuestionPositions.push(position);
    } else {
      omitted += 1;
      expect(digest).toContain(`req-digest-${index}`);
      expect(digest).not.toContain(`q${index}${"q".repeat(40)}`);
    }
  }
  expect(included).toBeGreaterThan(0);
  expect(omitted).toBeGreaterThan(0);
  const taskPosition = digest.indexOf(taskObjective);
  if (taskPosition >= 0) {
    for (const questionPosition of includedQuestionPositions) {
      expect(questionPosition).toBeLessThan(taskPosition);
    }
  }
});

test("brief-question returns the exact ask payload for its saved request decision", async () => {
  let record = createRequestBriefRecord(
    {
      id: "req-action",
      repoPath: "/repo",
      content: {
        goal: "Choose a behavior",
        scope: ["src"],
        constraints: [],
        nonGoals: [],
        acceptanceCriteria: ["the decision is saved"],
        manualVerification: [],
        recommendedApproach: "Use research evidence",
        keyDecisions: [],
        openQuestions: ["Which behavior?"],
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
  );
  const service = {
    addRequestPlanningQuestion: async (
      requestId: string,
      input: Parameters<typeof addRequestPlanningQuestion>[1],
    ) => {
      expect(requestId).toBe(record.id);
      record = addRequestPlanningQuestion(record, input, "plan-action", "2030-01-01T00:00:00.000Z");
      return record;
    },
  } as unknown as TandemService;
  const result = await executeTandemAction(
    {
      action: "brief-question",
      requestId: "req-action",
      context: "Research found two paths.",
      question: "Which behavior?",
      options: [{ label: "Existing" }, { label: "Alternative" }],
      recommendedOption: 1,
    },
    service,
    { confirm: undefined },
  );

  expect(result.value).toEqual({
    requestId: "req-action",
    askInput: {
      questions: [
        {
          id: "plan-action",
          question: "Research found two paths.\n\nWhich behavior?",
          options: [{ label: "Existing" }, { label: "Alternative" }],
          recommended: 1,
        },
      ],
    },
  });
  expect(summarizeTandemActionValue("brief-question", result.value)).toBe(
    JSON.stringify(result.value),
  );
});

test("draft publication needs interactive human approval and never runs without it", async () => {
  const unfinished = task({ stage: "implementing" });
  const prompts: string[] = [];
  const published: unknown[] = [];
  const service = {
    get: async () => unfinished,
    publishDraft: async (taskId: string, input: unknown) => {
      published.push({ taskId, input });
      return unfinished;
    },
  } as unknown as TandemService;
  const parsed = parseTandemCommand("pr-draft task-1 Draft-title main");
  expect(parsed).toEqual({
    action: "draft",
    taskId: "task-1",
    title: "Draft-title",
    base: "main",
  });

  const refusing = {
    confirm: async (_title: string, message: string) => {
      prompts.push(message);
      return false;
    },
  };
  const refused = await executeTandemAction(parsed, service, refusing);
  expect(refused.approved).toBe(false);
  expect(published).toHaveLength(0);
  expect(prompts[0]).toBe("Shows progress only. Nothing is merged.");

  const headless = await executeTandemAction(parsed, service, { confirm: undefined });
  expect(headless.approved).toBe(false);
  expect(published).toHaveLength(0);

  const approving = { confirm: async () => true };
  const accepted = await executeTandemAction(parsed, service, approving);
  expect(accepted.approved).toBe(true);
  expect(published).toEqual([
    {
      taskId: "task-1",
      input: { title: "Draft-title", base: "main", approved: true },
    },
  ]);
});

test("publish now needs interactive human approval and never runs without it", async () => {
  const reviewing = task({ stage: "reviewing" });
  const prompts: string[] = [];
  const published: unknown[] = [];
  const service = {
    get: async () => reviewing,
    publishNow: async (taskId: string, input: unknown) => {
      published.push({ taskId, input });
      return reviewing;
    },
  } as unknown as TandemService;
  const summary = { tldr: ["Adds retries."], what: ["Retry loop."], why: ["Flaky calls."] };
  const action = {
    action: "publish-now" as const,
    taskId: "task-1",
    repository: "acme/repo",
    title: "Add retries",
    base: "main",
    summary,
  };

  const refused = await executeTandemAction(action, service, {
    confirm: async (title: string, message: string) => {
      prompts.push(`${title} ${message}`);
      return false;
    },
  });
  expect(refused.approved).toBe(false);
  expect(published).toHaveLength(0);
  expect(prompts[0]).toContain("Skip review and open a PR");

  const headless = await executeTandemAction(action, service, { confirm: undefined });
  expect(headless.approved).toBe(false);
  expect(published).toHaveLength(0);

  const accepted = await executeTandemAction(action, service, { confirm: async () => true });
  expect(accepted.approved).toBe(true);
  expect(published).toEqual([
    {
      taskId: "task-1",
      input: {
        repository: "acme/repo",
        title: "Add retries",
        base: "main",
        summary,
        approved: true,
      },
    },
  ]);
});

test("a draft pull request is summarized as unfinished visibility, never as acceptance", () => {
  const summary = summarizeTandemActionValue(
    "draft",
    task({
      stage: "implementing",
      pullRequest: {
        repository: "acme/repo",
        number: 11,
        state: "draft",
        head: "head-1",
        base: "main",
      },
    }),
  );

  expect(summary).toContain("Pull request: acme/repo#11 (draft)");
  expect(summary).toContain("This is a draft: work in progress, not ready to merge.");
});

test("a published pull request is summarized with its link", () => {
  const summary = summarizeTandemActionValue(
    "publish-now",
    task({
      stage: "ready",
      pullRequest: {
        repository: "acme/repo",
        number: 12,
        state: "open",
        head: "head-1",
        base: "main",
        url: "https://github.com/acme/repo/pull/12",
      },
    }),
  );

  expect(summary).toContain("Pull request: https://github.com/acme/repo/pull/12 (open)");
});

test("extension cleanup skips confirmation for safe release and shows scope for discard", async () => {
  const cleanupInputs: unknown[] = [];
  const prompts: string[] = [];
  const cleanupTask = task({
    objective: "Release the completed task resources",
    reviewHead: "review-head",
    worktree: {
      root: "/tmp/treehouse",
      path: "/tmp/treehouse/task-1",
      name: "task-1",
      baseHead: "base-head",
      branch: "tandem/task-1",
      leaseId: "lease-1",
      leaseHolder: "tandem-1",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
  });
  const service = {
    get: async () => cleanupTask,
    cleanup: async (_taskId: string, input: unknown) => {
      cleanupInputs.push(input);
      return cleanupTask;
    },
  } as unknown as TandemService;
  const context = {
    confirm: async (_title: string, message: string) => {
      prompts.push(message);
      return false;
    },
  };

  await executeTandemAction({ action: "cleanup", taskIds: [cleanupTask.id] }, service, context);
  const refused = await executeTandemAction(
    { action: "cleanup", taskIds: [cleanupTask.id], discard: true },
    service,
    context,
  );

  expect(cleanupInputs).toEqual([{}]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toBe("This discards its changes.");
  expect(refused.approved).toBe(false);
});

test("extension cleanup asks once for a batch and keeps going past a failure", async () => {
  const cleaned: string[] = [];
  const prompts: Array<{ readonly title: string; readonly message: string }> = [];
  const tasks = new Map([
    ["task-1", task({ id: "task-1", objective: "Research the settings flash" })],
    ["task-2", task({ id: "task-2", objective: "Build the settings redesign" })],
    ["task-3", task({ id: "task-3", objective: "Investigate analytics counts" })],
  ]);
  const found = (taskId: string) => {
    const record = tasks.get(taskId);
    if (record === undefined) throw new Error(`Task ${taskId} was not found`);
    return record;
  };
  const service = {
    get: async (taskId: string) => found(taskId),
    cleanup: async (taskId: string) => {
      if (taskId === "task-2") throw new Error("the worktree lease was retained");
      cleaned.push(taskId);
      return found(taskId);
    },
  } as unknown as TandemService;
  const context = {
    confirm: async (title: string, message: string) => {
      prompts.push({ title, message });
      return true;
    },
  };

  const result = await executeTandemAction(
    { action: "cleanup", taskIds: ["task-1", "task-2", "task-3"], discard: true },
    service,
    context,
  );

  expect(prompts).toEqual([
    {
      title: "Delete the worktrees for 3 tasks?",
      message:
        '- "Research the settings flash"\n- "Build the settings redesign"\n- "Investigate analytics counts"\nThis discards their changes.',
    },
  ]);
  expect(cleaned).toEqual(["task-1", "task-3"]);
  expect(result.value).toContain("task-2: not cleaned up: the worktree lease was retained");
});

test("brief-approve parses without a requestId when only revision and digest are given", () => {
  const parsed = parseTandemCommand("brief-approve 3 digest-abc");
  expect(parsed).toEqual({
    action: "brief-approve",
    briefRevision: 3,
    contentDigest: "digest-abc",
  });
});

test("brief-approve parses a named requestId when all three arguments are given", () => {
  const parsed = parseTandemCommand("brief-approve req-1 3 digest-abc");
  expect(parsed).toEqual({
    action: "brief-approve",
    requestId: "req-1",
    briefRevision: 3,
    contentDigest: "digest-abc",
  });
});

function briefRecordFor(goal: string) {
  return createRequestBriefRecord(
    {
      id: "req-9",
      repoPath: "/repo",
      content: {
        goal,
        scope: ["src/requests"],
        constraints: [],
        nonGoals: [],
        acceptanceCriteria: ["it works"],
        manualVerification: [],
        recommendedApproach: "do it",
        keyDecisions: [],
        openQuestions: [],
        researchLinks: [],
      },
    },
    "2030-01-01T00:00:00.000Z",
  );
}

test("the brief-approve prompt names the request by its goal, never its id or revision, and omitting requestId resolves the one pending request", async () => {
  const record = briefRecordFor("Ship the pricing widget");
  const prompts: string[] = [];
  const approveCalls: unknown[] = [];
  const service = {
    pendingBriefApprovalId: async () => record.id,
    requestBrief: async (requestId: string) => {
      expect(requestId).toBe(record.id);
      return { record, approvalState: "unapproved", markdown: "", pausedTaskIds: [] };
    },
    approveRequestBrief: async (intent: unknown) => {
      approveCalls.push(intent);
      return { record, approvalState: "current", markdown: "", pausedTaskIds: [] };
    },
  } as unknown as TandemService;
  const context = {
    confirm: async (_title: string, message: string) => {
      prompts.push(message);
      return true;
    },
  };

  const result = await executeTandemAction(
    {
      action: "brief-approve",
      briefRevision: record.draft.revision,
      contentDigest: record.draft.contentDigest,
    },
    service,
    context,
  );

  expect(result.approved).toBe(true);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Ship the pricing widget");
  expectNoIdentifiers(prompts[0] ?? "", [record.id, record.draft.contentDigest]);
  expect(approveCalls).toEqual([
    { briefRevision: record.draft.revision, contentDigest: record.draft.contentDigest },
  ]);
});

function callDependencies(
  service: TandemService,
  followUps: string[],
  turnActions: CoordinatorTurnAction[] = [],
): TandemCallDependencies {
  return {
    service: () => service,
    recordTurnAction: (action) => {
      turnActions.push(action);
    },
    confirm: undefined,
    reconcile: async () => {
      followUps.push("reconcile");
    },
    closeThread: () => {
      followUps.push("closeThread");
    },
    postAction: async () => {
      followUps.push("postAction");
    },
  };
}

test("the tandem tool reconciles after ticks and runs post-action for ordinary actions", async () => {
  const followUps: string[] = [];
  const turnActions: CoordinatorTurnAction[] = [];
  const service = {
    tick: async () => [],
    list: async () => [task()],
  } as unknown as TandemService;
  const dependencies = callDependencies(service, followUps, turnActions);

  const ticked = await runTandemTool({ action: "tick" }, dependencies, undefined);
  const listed = await runTandemTool({ action: "list" }, dependencies, undefined);

  expect(followUps).toEqual(["reconcile", "postAction"]);
  expect(turnActions).toEqual(["other", "other"]);
  expect(ticked).toEqual({
    text: summarizeTandemActionValue("tick", []),
    isError: false,
    details: { action: "tick", value: [] },
  });
  expect(listed).toMatchObject({ isError: false, details: { action: "list" } });
  expect(listed.text).toContain("task-1");
});

test("trace reads are chronological and safe to repeat", async () => {
  const trace: TaskTrace = {
    events: [
      {
        type: "created",
        taskId: "task-1",
        at: "2030-01-01T00:00:00.000Z",
        stage: "queued",
        seq: 1,
      },
      {
        type: "stage-changed",
        taskId: "task-1",
        at: "2030-01-01T00:01:00.000Z",
        from: "queued",
        to: "scouting",
        seq: 2,
      },
    ],
    unreadableEvents: 1,
    rollup: {
      taskId: "task-1",
      firstPassReview: false,
      fixRounds: 2,
      blockedMs: 120_000,
      cost: {
        currency: "USD",
        amountMicros: 1_234_567,
        actualSamples: 1,
        estimatedSamples: 2,
        unavailableSamples: 3,
      },
    },
  };
  const traceCalls: string[] = [];
  const followUps: string[] = [];
  const turnActions: CoordinatorTurnAction[] = [];
  const service = {
    trace: async (taskId: string) => {
      traceCalls.push(taskId);
      return trace;
    },
  } as unknown as TandemService;
  const dependencies = callDependencies(service, followUps, turnActions);
  const action = { action: "trace" as const, taskId: "task-1" };

  const first = await runTandemTool(action, dependencies, undefined);
  const second = await runTandemTool(action, dependencies, undefined);

  expect(first).toEqual(second);
  expect(traceCalls).toEqual(["task-1", "task-1"]);
  expect(followUps).toEqual([]);
  expect(turnActions).toEqual(["trace", "trace"]);
  expect(first.text).toContain("First review: needed fixes");
  expect(first.text).toContain("Fix rounds: 2");
  expect(first.text).toContain("Time blocked: 2m (120000 ms)");
  expect(first.text).toContain("Cost: $1.23 (1 actual, 2 estimated, 3 unpriced)");
  expect(first.text).toContain("1 unreadable");
  expect(first.text.indexOf("created at queued")).toBeLessThan(
    first.text.indexOf("queued -> scouting"),
  );
  expect(first.details).toMatchObject({
    action: "trace",
    value: {
      events: trace.events,
      unreadableEvents: 1,
      omittedEvents: 0,
      rollup: trace.rollup,
    },
  });
});

test("trace keeps the newest readable events and full rollup for long histories", async () => {
  const events = Array.from({ length: 40 }, (_, index): StoredTimelineEvent => {
    const seq = index + 1;
    return {
      type: "question-asked",
      taskId: "task-1",
      at: new Date(Date.UTC(2030, 0, 1, 0, 0, seq - 1)).toISOString(),
      questionId: `question-${seq}`,
      cause: `cause-${seq}`,
      seq,
    };
  });
  const trace: TaskTrace = {
    events,
    unreadableEvents: 2,
    rollup: {
      taskId: "task-1",
      firstPassReview: true,
      fixRounds: 4,
      blockedMs: 123_456,
      cost: {
        currency: "USD",
        amountMicros: 9_876_543,
        actualSamples: 4,
        estimatedSamples: 1,
        unavailableSamples: 2,
      },
    },
  };
  const service = { trace: async () => trace } as unknown as TandemService;
  const outcome = await runTandemTool(
    { action: "trace", taskId: "task-1" },
    callDependencies(service, []),
    undefined,
  );
  const boundedTrace = (outcome.details as Readonly<{ value: BoundedTaskTrace }>).value;

  expect(outcome.isError).toBe(false);
  expect(outcome.text.length).toBeLessThanOrEqual(ACTION_RESULT_MAX_CHARS);
  expect(outcome.text).toContain("First review: passed");
  expect(outcome.text).toContain("Fix rounds: 4");
  expect(outcome.text).toContain("Time blocked: 2m (123456 ms)");
  expect(outcome.text).toContain("24 omitted; 2 unreadable");
  expect(outcome.text.indexOf("question-25")).toBeLessThan(outcome.text.indexOf("question-40"));
  expect(outcome.text).not.toContain("question-24");
  expect(boundedTrace.events).toEqual(events.slice(-ACTION_TRACE_MAX_EVENTS));
  expect(boundedTrace.omittedEvents).toBe(40 - ACTION_TRACE_MAX_EVENTS);
  expect(boundedTrace.unreadableEvents).toBe(2);
  expect(boundedTrace.rollup).toEqual(trace.rollup);
  expect((JSON.stringify(boundedTrace) ?? "").length).toBeLessThanOrEqual(12_000);
  expect((JSON.stringify(outcome.details) ?? "").length).toBeLessThanOrEqual(
    ACTION_FULL_RESULT_MAX_CHARS,
  );
});

test("trace never backfills older events past an oversized newest event", async () => {
  const olderEvent: StoredTimelineEvent = {
    type: "question-asked",
    taskId: "task-1",
    at: "2030-01-01T00:00:00.000Z",
    questionId: "older-question",
    seq: 1,
  };
  const newestEvent: StoredTimelineEvent = {
    type: "fix-round",
    taskId: "task-1",
    at: "2030-01-01T00:01:00.000Z",
    round: 2,
    generation: 1,
    findingIds: Array.from({ length: 5_000 }, (_, index) => `finding-${index}`),
    seq: 2,
  };
  const trace: TaskTrace = {
    events: [olderEvent, newestEvent],
    unreadableEvents: 3,
    rollup: {
      taskId: "task-1",
      firstPassReview: false,
      fixRounds: 2,
      blockedMs: 12_345,
      cost: {
        currency: "USD",
        amountMicros: 987_654,
        actualSamples: 2,
        estimatedSamples: 1,
        unavailableSamples: 3,
      },
    },
  };
  const service = { trace: async () => trace } as unknown as TandemService;
  const outcome = await runTandemTool(
    { action: "trace", taskId: "task-1" },
    callDependencies(service, []),
    undefined,
  );
  const boundedTrace = (outcome.details as Readonly<{ value: BoundedTaskTrace }>).value;

  expect(outcome.isError).toBe(false);
  expect(boundedTrace.events).toEqual([]);
  expect(boundedTrace.omittedEvents).toBe(2);
  expect(boundedTrace.unreadableEvents).toBe(3);
  expect(boundedTrace.rollup).toEqual(trace.rollup);
  expect(outcome.text).toContain("2 readable; showing 0 newest; 2 omitted; 3 unreadable");
  expect(outcome.text).not.toContain("older-question");
  expect((JSON.stringify(outcome.details) ?? "").length).toBeLessThanOrEqual(
    ACTION_FULL_RESULT_MAX_CHARS,
  );
});

test("a failed trace returns not-found details without reconciliation", async () => {
  const followUps: string[] = [];
  const service = {
    trace: async () => {
      throw new Error("Task foreign-task was not found");
    },
  } as unknown as TandemService;

  expect(
    await runTandemTool(
      { action: "trace", taskId: "foreign-task" },
      callDependencies(service, followUps),
      undefined,
    ),
  ).toEqual({
    text: "Tandem trace failed: Task foreign-task was not found",
    isError: true,
    details: { action: "trace" },
  });
  expect(followUps).toEqual([]);
});

test("finishing actions close the thread, but a refused approval does not", async () => {
  const followUps: string[] = [];
  const service = { answer: async () => task() } as unknown as TandemService;

  await runTandemTool({ action: "thread-done" }, callDependencies(service, followUps), undefined);
  await runTandemTool(
    { action: "answer", taskId: "task-1", questionId: "q-1", text: "Yes." },
    callDependencies(service, followUps),
    undefined,
  );
  await runTandemTool(
    { action: "approve", taskId: "task-1" },
    callDependencies(service, followUps),
    undefined,
  );

  expect(followUps).toEqual([
    "closeThread",
    "postAction",
    "closeThread",
    "postAction",
    "postAction",
  ]);
});

test("a tool approval that nobody can answer is refused and reported, not thrown", async () => {
  const followUps: string[] = [];
  const service = {
    get: async () => task(),
    approve: async () => task(),
  } as unknown as TandemService;

  const outcome = await runTandemTool(
    { action: "approve", taskId: "task-1" },
    callDependencies(service, followUps),
    undefined,
  );

  expect(outcome).toMatchObject({
    isError: false,
    details: { action: "approve", approved: false },
  });
  expect(outcome.text).toContain("Action refused");
  expect(followUps).toEqual(["postAction"]);
});

test("a failed tool call becomes an error outcome naming the action", async () => {
  const followUps: string[] = [];
  const service = {
    list: async () => {
      throw new Error("the task store is locked");
    },
  } as unknown as TandemService;

  expect(
    await runTandemTool({ action: "list" }, callDependencies(service, followUps), undefined),
  ).toEqual({
    text: "Tandem list failed: the task store is locked",
    isError: true,
    details: { action: "list" },
  });
  expect(followUps).toEqual([]);
});

test("a /tandem command shows results before post-action work, except for read-only trace", async () => {
  const order: string[] = [];
  const turnActions: CoordinatorTurnAction[] = [];
  const modelsFor: string[] = [];
  const trace: TaskTrace = {
    events: [],
    unreadableEvents: 0,
    rollup: { taskId: "task-1", fixRounds: 0, blockedMs: 0 },
  };
  const service = {
    models: async (repoPath: string) => {
      modelsFor.push(repoPath);
      return { modelSettings: { configPath: "/m.json", configured: false }, availableModels: [] };
    },
    trace: async () => trace,
  } as unknown as TandemService;
  const recording = recordingSessionHost();
  const host = {
    perform: async (effect: SessionEffect) => {
      order.push(effect.type);
      await recording.host.perform(effect);
    },
  };
  const dependencies = callDependencies(service, order, turnActions);

  await runTandemCommand("models .", "/repo", dependencies, host);
  await runTandemCommand("unknown-command", "/repo", dependencies, host);
  await runTandemCommand("trace task-1", "/repo", dependencies, host);

  // `.` is the coordinator's own checkout.
  expect(modelsFor).toEqual(["/repo"]);
  expect(order).toEqual(["notify", "postAction", "notify", "notify"]);
  expect(turnActions).toEqual([]);
  expect(recording.effects[0]).toMatchObject({ type: "notify", level: "info" });
  expect(recording.effects[1]).toMatchObject({ type: "notify", level: "error" });
  expect(recording.effects[1]?.type === "notify" ? recording.effects[1].text : "").toStartWith(
    "Tandem command failed: ",
  );
  expect(recording.effects[2]).toMatchObject({ type: "notify", level: "info" });
  expect(recording.effects[2]?.type === "notify" ? recording.effects[2].text : "").toContain(
    "Task task-1",
  );
});

test("/tandem models . resolves to the coordinator's own checkout, and nothing else does", () => {
  expect(resolveCommandAction({ action: "models", repoPath: "." }, "/repo")).toEqual({
    action: "models",
    repoPath: "/repo",
  });
  expect(resolveCommandAction({ action: "models", repoPath: "/other" }, "/repo")).toEqual({
    action: "models",
    repoPath: "/other",
  });
  expect(resolveCommandAction({ action: "setup", repoPath: "." }, "/repo")).toEqual({
    action: "setup",
    repoPath: ".",
  });
});

test("a report-mode issue is filed only after the user approves the cleaned-up draft", async () => {
  const reviewed = {
    draft: { title: "Reviewer times out", body: "It restarted twice." },
    check: { flagged: true, warning: "It may still contain work code, paths, or secrets." },
  };
  const filed: unknown[] = [];
  const service = {
    reviewIssue: async () => reviewed,
    fileIssue: async (input: unknown) => {
      filed.push(input);
      return { url: "https://github.com/jdeocampo99/tandem/issues/7" };
    },
  } as unknown as TandemService;
  const action = {
    action: "report-issue",
    taskId: "task-1",
    title: "Reviewer times out on acme",
    body: "It restarted twice.",
  } as const;
  const dialogs: { title: string; message: string }[] = [];
  const answering = (allow: boolean) => ({
    confirm: async (title: string, message: string) => {
      dialogs.push({ title, message });
      return allow;
    },
  });

  expect((await executeTandemAction(action, service, answering(false))).approved).toBe(false);
  expect((await executeTandemAction(action, service, { confirm: undefined })).approved).toBe(false);
  expect(filed).toEqual([]);
  expect(dialogs[0]).toEqual({
    title: "File this issue on jdeocampo99/tandem?",
    message:
      "Warning: It may still contain work code, paths, or secrets. Read it before filing.\n\nReviewer times out\n\nIt restarted twice.",
  });

  const accepted = await executeTandemAction(action, service, answering(true));
  expect(accepted.value).toBe("Filed https://github.com/jdeocampo99/tandem/issues/7");
  expect(filed).toEqual([
    { taskId: "task-1", title: "Reviewer times out on acme", body: "It restarted twice." },
  ]);
});

test("the setup page opens without approval", async () => {
  const calls: string[] = [];
  const service = {
    openSetupPage: async (repoPath: string) => {
      calls.push(`open ${repoPath}`);
      return { path: "/home/setup/tandem-setup.html", url: "http://127.0.0.1:4387/session/a" };
    },
  } as unknown as TandemService;

  const opened = await executeTandemAction({ action: "setup-page", repoPath: "/tandem" }, service, {
    confirm: async () => false,
  });
  expect(opened.value).toBe(
    "The setup page is open in Lavish (http://127.0.0.1:4387/session/a). Its answer comes back to this chat by itself; wait for it.",
  );
  expect(calls).toEqual(["open /tandem"]);
  expect(parseTandemCommand("setup-page")).toEqual({ action: "setup-page", repoPath: "." });
});

test("create forwards the workstream the work belongs to", async () => {
  const createCalls: unknown[] = [];
  const service = {
    create: async (input: unknown) => {
      createCalls.push(input);
      return task({});
    },
  } as unknown as TandemService;
  await executeTandemAction(
    {
      action: "create",
      repoPath: "/repo",
      kind: "implementation",
      objective: "ship feature",
      acceptanceCriteria: ["behavior"],
      surfaces: ["src"],
      workstream: "billing",
    },
    service,
    { confirm: undefined },
  );
  expect(createCalls).toMatchObject([{ workstream: "billing" }]);
});

test("memory actions run without an approval dialog and keep the notes' line breaks", async () => {
  const writes: unknown[] = [];
  const catchUp: MemoryShowResult = {
    kind: "notes",
    view: {
      name: "tia",
      path: "/notes/tia/MEMORY.md",
      savedOn: "2030-01-09",
      age: "today",
      today: "2030-01-09",
      due: [{ text: "check the rate on 2030-01-09 because x", due: "2030-01-09" }],
      later: [],
      extra: [],
      recent: [],
    },
  };
  const service = {
    memoryList: async () => ["tia: 1 follow-up due", "billing: nothing due"],
    memoryShow: async () => catchUp,
    memoryWrite: async (input: unknown) => {
      writes.push(input);
      return "Saved tia: now, last handoff.";
    },
    memoryDone: async () => "Archived tia.",
  } as unknown as TandemService;
  const noDialog = { confirm: undefined };

  const listed = await executeTandemAction(
    { action: "memory-list", repoPath: "/repo" },
    service,
    noDialog,
  );
  expect(summarizeTandemActionValue(listed.action, listed.value)).toBe(
    "tia: 1 follow-up due\nbilling: nothing due",
  );
  const shown = await executeTandemAction(
    { action: "memory-show", repoPath: "/repo", workstream: "tia" },
    service,
    noDialog,
  );
  expect(summarizeTandemActionValue(shown.action, shown.value)).toBe(renderMemoryShow(catchUp));
  const written = await executeTandemAction(
    {
      action: "memory-write",
      repoPath: "/repo",
      workstream: "tia",
      now: "Mobile left.",
      lastHandoff: "Lowered the threshold.",
      followUps: "- check the rate on 2030-01-09 because #412 merged",
    },
    service,
    noDialog,
  );
  expect(written.value).toBe("Saved tia: now, last handoff.");
  expect(writes).toEqual([
    {
      repoPath: "/repo",
      workstream: "tia",
      changes: {
        now: "Mobile left.",
        "follow-ups": "- check the rate on 2030-01-09 because #412 merged",
        "last-handoff": "Lowered the threshold.",
      },
    },
  ]);
  const done = await executeTandemAction(
    { action: "memory-done", repoPath: "/repo", workstream: "tia" },
    service,
    noDialog,
  );
  expect(done.value).toBe("Archived tia.");

  const empty = { ...service, memoryList: async () => [] } as unknown as TandemService;
  const none = await executeTandemAction(
    { action: "memory-list", repoPath: "/repo" },
    empty,
    noDialog,
  );
  expect(none.value).toBe("No workstreams yet.");
});

test("the coordinator board tool shows one terminal-formatted status card", async () => {
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
  const shown: unknown[] = [];
  const followUps: string[] = [];

  const outcome = await runTandemTool(
    { action: "board" },
    {
      ...callDependencies(service, followUps),
      showStatus: async (effect) => {
        shown.push(effect);
      },
    },
    undefined,
  );

  expect(shown).toEqual([
    {
      type: "showStatus",
      view,
      text: renderBoard(view),
      timing: "aside",
      triggerTurn: false,
    },
  ]);
  expect(outcome.text).toBe(
    "The status board is displayed above. Do not repeat its rows; briefly answer the user's status question.",
  );
  expect(outcome.details).toMatchObject({ action: "board", value: view });
  expect(followUps).toEqual(["postAction"]);
});
test("a catch-up goes on screen as its own card, and the tool result only carries the notes", async () => {
  const view = {
    name: "tia",
    path: "/notes/tia/MEMORY.md",
    savedOn: "2030-01-09",
    age: "today",
    today: "2030-01-09",
    due: [],
    later: [],
    now: "Rolling out.",
    brief: "Goal: skip safe suites.",
    extra: [],
    recent: [],
  };
  const service = {
    memoryShow: async (_repoPath: string, workstream: string) =>
      workstream === "tia" ? { kind: "notes", view } : { kind: "none", name: workstream },
  } as unknown as TandemService;
  const shown: unknown[] = [];
  const dependencies: TandemCallDependencies = {
    ...callDependencies(service, []),
    showCard: async (effect) => {
      shown.push(effect);
    },
  };

  const outcome = await runTandemTool(
    { action: "memory-show", repoPath: "/repo", workstream: "tia" },
    dependencies,
    undefined,
  );
  expect(shown).toEqual([
    { type: "showCard", view, text: renderCatchUpCard(view, { color: false }).trimEnd() },
  ]);
  expect(outcome.text).toBe(
    renderMemoryShow({ kind: "notes", view } as MemoryShowResult, { cardShown: true }),
  );
  expect(outcome.text).toContain("Goal: skip safe suites.");
  expect(outcome.text).not.toContain("WHERE YOU LEFT OFF");

  // Without notes there is no card, and without a host that shows cards the card stays in the text.
  await runTandemTool(
    { action: "memory-show", repoPath: "/repo", workstream: "billing" },
    dependencies,
    undefined,
  );
  expect(shown).toHaveLength(1);
  const plain = await runTandemTool(
    { action: "memory-show", repoPath: "/repo", workstream: "tia" },
    callDependencies(service, []),
    undefined,
  );
  expect(plain.text).toContain("WHERE YOU LEFT OFF");
});
