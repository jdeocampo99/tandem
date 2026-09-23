import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import { resolveTandemEnvironment } from "../../src/config/environment.ts";
import type { ModelSpec, RepoPolicy, ResolvedPolicy, TaskRecord } from "../../src/contracts.ts";
import { executeTandemAction, parseTandemCommand } from "../../src/extension/actions.ts";
import { deliverPendingNotifications } from "../../src/extension/notifications.ts";
import { buildDurableDigest, summarizeTandemActionValue } from "../../src/extension/summary.ts";
import { createTandemExtension, reviewStatus } from "../../src/extension.ts";
import { createRequestBriefRecord } from "../../src/requests/brief.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { StoreLockTimeoutError } from "../../src/tasks/store-errors.ts";
import { expectNoIdentifiers } from "../tasks/question.test.ts";

const models: Readonly<
  Record<"coordinator" | "scout" | "implementer" | "reviewer" | "presentation", ModelSpec>
> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

const policyConfig: RepoPolicy = {
  version: 1,
  models,
  instructions: { implementation: [], validation: [], review: [] },
  instructionFiles: { implementation: [], validation: [], review: [] },
  validationCommands: [],
  setupCommands: [],
  maxWorkers: 3,
  maxFixRounds: 3,
  reviewLevels: {
    deepScrutiny: false,
    jevAssistance: "off",
    sourceTransmission: false,
  },
};

const policy: ResolvedPolicy = {
  config: policyConfig,
  guidance: { implementation: [], validation: [], review: [] },
};

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 1,
    repoPath: "/repo",
    kind: "implementation",
    objective: "Implement the requested change",
    acceptanceCriteria: ["Keep the durable behavior intact."],
    surfaces: ["src/extension.ts"],
    stage: "ready",
    scopeApproved: true,
    policy,
    createdAt: "2030-01-02T03:04:05.000Z",
    updatedAt: "2030-01-02T03:04:05.000Z",
    generation: 0,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    notifications: [],
    ...overrides,
  };
}
function notificationContext(notify: ExtensionContext["ui"]["notify"]): {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
} {
  return { ui: { notify } };
}

function notificationSink(
  sendMessage: (content: string, options: unknown) => void,
  appendEntry: (customType: string, data?: unknown) => void,
): Pick<ExtensionAPI, "sendMessage" | "appendEntry"> {
  return {
    sendMessage: (message, options) => {
      const content =
        typeof message === "string"
          ? message
          : typeof message.content === "string"
            ? message.content
            : (JSON.stringify(message.content) ?? "");
      sendMessage(content, options);
    },
    appendEntry,
  };
}

test("review status renders round, failed lenses, and blocker count for the status line", () => {
  const reviewing = task({
    stage: "reviewing",
    reviewRound: 2,
    reviewHead: "head-1",
    reviews: [
      {
        lens: "behavior",
        head: "head-1",
        generation: 0,
        pass: false,
        findings: [],
        summary: "Needs another look.",
      },
      {
        lens: "design",
        head: "head-1",
        generation: 0,
        pass: true,
        findings: [],
        summary: "Looks good.",
      },
    ],
    findingLedger: [
      {
        id: "finding-1",
        lens: "behavior",
        severity: "P1",
        verdict: "confirmed",
        description: "Missing error handling.",
        status: "unresolved",
        raisedAt: { head: "head-1", generation: 0, reviewRound: 2 },
        statusAt: { head: "head-1", generation: 0, reviewRound: 2 },
      },
    ],
  });
  expect(reviewStatus(reviewing)).toBe("reviewing fix 2/3 · behavior fail · 1 blocker");

  expect(reviewStatus(task({ ...reviewing, reviewRound: 0 }))).toBe(
    "reviewing · behavior fail · 1 blocker",
  );

  const twoBlockers = task({
    ...reviewing,
    findingLedger: [
      ...(reviewing.findingLedger ?? []),
      {
        id: "finding-2",
        lens: "behavior",
        severity: "P0",
        verdict: "confirmed",
        description: "Crashes on empty input.",
        status: "unresolved",
        raisedAt: { head: "head-1", generation: 0, reviewRound: 2 },
        statusAt: { head: "head-1", generation: 0, reviewRound: 2 },
      },
    ],
  });
  expect(reviewStatus(twoBlockers)).toBe("reviewing fix 2/3 · behavior fail · 2 blockers");

  expect(reviewStatus(task({ stage: "implementing" }))).toBeUndefined();
});

test("environment resolution applies explicit boundary values and ignores unrelated variables", () => {
  const environment = resolveTandemEnvironment(
    {
      TANDEM_HOME: "/env/home",
      TANDEM_SESSION: "env-session",
      TANDEM_PARENT_WORKSPACE: "env-parent",
      TANDEM_POOL_ROOT: "/env/pool",
      TANDEM_REPO: "/env/repo",
      TANDEM_SOURCE_REPO: "/env/source-repo",
      PATH: "/usr/bin",
    },
    { cwd: "/cwd", sessionId: "default-session" },
    { home: "/override/home", sessionId: "override-session", repo: "/override/repo" },
  );

  expect(environment).toEqual({
    home: "/override/home",
    sessionId: "override-session",
    parentWorkspaceId: "env-parent",
    poolRoot: "/env/pool",
    repo: "/override/repo",
    sourceRepo: "/env/source-repo",
  });
});

test("the coordinator pane is known only inside an active Herdr context for the Tandem session", () => {
  const fallback = { cwd: "/cwd", sessionId: "default-session" };
  const herdr = {
    TANDEM_HOME: "/env/home",
    TANDEM_SESSION: "tandem-session",
    HERDR_ENV: "1",
    HERDR_SESSION: "tandem-session",
    HERDR_PANE_ID: "pane-coordinator",
  };

  expect(resolveTandemEnvironment(herdr, fallback).coordinatorPaneId).toBe("pane-coordinator");
  expect(
    resolveTandemEnvironment({ ...herdr, HERDR_SESSION: "other-session" }, fallback)
      .coordinatorPaneId,
  ).toBeUndefined();
  expect(
    resolveTandemEnvironment({ ...herdr, HERDR_ENV: undefined }, fallback).coordinatorPaneId,
  ).toBeUndefined();
  expect(
    resolveTandemEnvironment({ ...herdr, HERDR_PANE_ID: undefined }, fallback).coordinatorPaneId,
  ).toBeUndefined();
});

test("remembered setup keeps home, session, and derived pool together without leaking into explicit homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-remembered-setup-"));
  const configRoot = join(root, "config");
  const home = join(root, "saved-home");
  const source = { XDG_CONFIG_HOME: configRoot };
  const fallback = { cwd: "/repo", sessionId: "fallback-session" };
  await mkdir(join(configRoot, "tandem"), { recursive: true });
  try {
    await writeFile(
      join(configRoot, "tandem", "config.json"),
      JSON.stringify({ schemaVersion: 1, home, sessionId: "saved-session" }),
    );
    expect(resolveTandemEnvironment(source, fallback)).toEqual({
      home,
      sessionId: "saved-session",
      poolRoot: join(home, "pool"),
      repo: "/repo",
    });
    expect(
      resolveTandemEnvironment(
        { ...source, TANDEM_SESSION: "selected-session", TANDEM_POOL_ROOT: "/selected-pool" },
        fallback,
      ),
    ).toEqual({ home, sessionId: "selected-session", poolRoot: "/selected-pool", repo: "/repo" });
    expect(resolveTandemEnvironment(source, fallback, { home: "/other-home" })).toEqual({
      home: "/other-home",
      sessionId: "fallback-session",
      poolRoot: "/other-home/pool",
      repo: "/repo",
    });
    expect(resolveTandemEnvironment({ ...source, TANDEM_HOME: "/env-home" }, fallback)).toEqual({
      home: "/env-home",
      sessionId: "fallback-session",
      poolRoot: "/env-home/pool",
      repo: "/repo",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid remembered setup fails closed but explicit homes remain accessible", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-invalid-setup-"));
  const source = { XDG_CONFIG_HOME: root };
  await mkdir(join(root, "tandem"));
  try {
    await writeFile(
      join(root, "tandem", "config.json"),
      JSON.stringify({ schemaVersion: 1, home: "/saved-home" }),
    );
    expect(() => resolveTandemEnvironment(source, { cwd: "/repo" })).toThrow(TypeError);
    expect(resolveTandemEnvironment(source, { cwd: "/repo" }, { home: "/rescue-home" }).home).toBe(
      "/rescue-home",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extension binds services to a clean source while preserving original identity", async () => {
  type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
  const handlers = new Map<string, LifecycleHandler>();
  let sourceWorkspace: unknown;
  let shutdownCalls = 0;
  const service = {
    list: async () => [],
    shutdown: async () => {
      shutdownCalls += 1;
    },
  } as unknown as TandemService;
  const pi = {
    zod,
    on: (event: string, handler: LifecycleHandler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    logger: { error: () => undefined },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;

  createTandemExtension({
    environment: {
      home: "/tmp/tandem-home",
      sessionId: "session-a",
      poolRoot: "/tmp/tandem-pool",
      repo: "/tmp/original-project",
      sourceRepo: "/tmp/clean-coordinator",
    },
    createService: (options) => {
      sourceWorkspace = options.sourceWorkspace;
      return service;
    },
  })(pi);
  const beforeAgentStart = handlers.get("before_agent_start");
  const sessionShutdown = handlers.get("session_shutdown");
  if (beforeAgentStart === undefined || sessionShutdown === undefined) {
    throw new Error("extension lifecycle handlers were not registered");
  }
  const context = {
    cwd: "/tmp/clean-coordinator",
    sessionManager: { getSessionId: () => "session-a" },
  } as unknown as ExtensionContext;
  const result = (await beforeAgentStart({ systemPrompt: ["existing"] }, context)) as {
    readonly systemPrompt: readonly string[];
  };

  expect(sourceWorkspace).toEqual({
    repoPath: "/tmp/original-project",
    path: "/tmp/clean-coordinator",
  });
  expect(result.systemPrompt.join("\n")).toContain("/tmp/clean-coordinator");
  expect(result.systemPrompt.join("\n")).toContain("/tmp/original-project");
  await sessionShutdown({}, context);
  expect(shutdownCalls).toBe(1);
});

test("before_agent_start exposes a blocked source refresh instead of silently planning stale work", async () => {
  type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
  const handlers = new Map<string, LifecycleHandler>();
  const service = {
    list: async () => [],
    refreshSource: async () => {
      throw new Error("origin/main fetch failed");
    },
    shutdown: async () => undefined,
  } as unknown as TandemService;
  const pi = {
    zod,
    on: (event: string, handler: LifecycleHandler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    logger: { error: () => undefined },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;

  createTandemExtension({ service })(pi);
  const beforeAgentStart = handlers.get("before_agent_start");
  if (beforeAgentStart === undefined) throw new Error("before_agent_start handler missing");
  const context = {
    cwd: "/tmp/clean-coordinator",
    sessionManager: { getSessionId: () => "session-a" },
  } as unknown as ExtensionContext;

  const result = (await beforeAgentStart({ systemPrompt: ["existing"] }, context)) as {
    readonly systemPrompt: readonly string[];
  };
  expect(result.systemPrompt.join("\n")).toContain("SOURCE REFRESH BLOCKED");
  expect(result.systemPrompt.join("\n")).toContain("Do not create or launch new work");
});

test("Tandem command parsing preserves quoted values and routes presentation feedback", () => {
  expect(
    parseTandemCommand('present task-1 "show the changed screen" /tmp/a.html,/tmp/b.png'),
  ).toEqual({
    action: "present",
    taskId: "task-1",
    objective: "show the changed screen",
    artifacts: ["/tmp/a.html", "/tmp/b.png"],
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
test("create forwards an explicit skill invocation to task creation untouched", async () => {
  const createCalls: unknown[] = [];
  const created = task({ skill: { name: "refactor-functions", context: "Refactor foo.ts" } });
  const service = {
    create: async (input: unknown) => {
      createCalls.push(input);
      return created;
    },
  } as unknown as TandemService;
  const noUiContext = { hasUI: false, mode: "rpc" } as unknown as ExtensionContext;

  const result = await executeTandemAction(
    {
      action: "create",
      repoPath: "/repo",
      kind: "implementation",
      objective: "ship feature",
      acceptanceCriteria: ["behavior"],
      surfaces: ["src"],
      skill: { name: "refactor-functions", context: "Refactor foo.ts" },
    },
    service,
    noUiContext,
  );

  expect(createCalls).toEqual([
    {
      repoPath: "/repo",
      kind: "implementation",
      objective: "ship feature",
      acceptanceCriteria: ["behavior"],
      surfaces: ["src"],
      skill: { name: "refactor-functions", context: "Refactor foo.ts" },
    },
  ]);
  expect(result.value).toBe(created);
});
test("inspection and delivery slash commands preserve their arguments", () => {
  expect(parseTandemCommand("inspect task-1")).toEqual({
    action: "inspect",
    taskId: "task-1",
  });
  expect(parseTandemCommand("delivery-preflight task-1 owner/repo main")).toEqual({
    action: "delivery-preflight",
    taskId: "task-1",
    repository: "owner/repo",
    base: "main",
  });
  expect(
    summarizeTandemActionValue("delivery-preflight", {
      taskId: "task-1",
      ready: false,
      checks: [{ name: "branch", passed: false }],
    }),
  ).toBe("task-1: not ready to deliver; failed: branch");
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
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: async (_title: string, message: string) => {
        prompts.push(message);
        return false;
      },
    },
  } as unknown as ExtensionContext;

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
    onboard: async (repoPath: string, write = false) => {
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
        unresolved: [],
      };
    },
  } as unknown as TandemService;
  const context = {
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: async (title: string, message: string) => {
        prompts.push({ title, message });
        return allow;
      },
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;

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
  const noUiContext = { hasUI: false, mode: "rpc" } as unknown as ExtensionContext;

  const listing = await executeTandemAction(
    { action: "models", repoPath: "/repo" },
    service,
    noUiContext,
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
    noUiContext,
  );

  expect(denied.approved).toBe(false);
  expect(configureCalls).toEqual([]);

  const uiContext = (allow: boolean) =>
    ({
      hasUI: true,
      mode: "tui",
      ui: {
        confirm: async () => allow,
      },
    }) as unknown as ExtensionContext;
  const refused = await executeTandemAction(
    { action: "configure-models", repoPath: "/repo", models },
    service,
    uiContext(false),
  );

  expect(refused.approved).toBe(false);
  expect(configureCalls).toEqual([]);

  const configured = await executeTandemAction(
    { action: "configure-models", repoPath: "/repo", models },
    service,
    uiContext(true),
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
  const uiContext = {
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: async (_title: string, message: string) => {
        prompts.push(message);
        return true;
      },
    },
  } as unknown as ExtensionContext;

  const result = await executeTandemAction(
    { action: "configure-models", repoPath: "/repo", models, enabledProviders: ["openai-codex"] },
    service,
    uiContext,
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
  expect(parseTandemCommand("cleanup task-1 --discard")).toEqual({
    action: "cleanup",
    taskId: "task-1",
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
  expect(digest).toContain("head-active");
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
  const scout = task({
    id: "scout-continuation",
    kind: "scout",
    stage: "completed",
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
  expect(summary).toContain("After research: summarize the report with its evidence");

  const digest = buildDurableDigest([scout]);
  expect(digest).toContain("after research: implementation-interview");

  const legacyScout = task({ id: "legacy-scout", kind: "scout", stage: "completed" });
  expect(buildDurableDigest([legacyScout])).toContain("after research: ask-intent");
  expect(buildDurableDigest([task({ id: "implementation-task" })])).not.toContain("continuation:");
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
  const parsed = parseTandemCommand("pr-draft task-1 acme/repo Draft-title main");
  expect(parsed).toEqual({
    action: "draft",
    taskId: "task-1",
    repository: "acme/repo",
    title: "Draft-title",
    base: "main",
  });

  const refusingContext = {
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: async (_title: string, message: string) => {
        prompts.push(message);
        return false;
      },
    },
  } as unknown as ExtensionContext;
  const refused = await executeTandemAction(parsed, service, refusingContext);
  expect(refused.approved).toBe(false);
  expect(published).toHaveLength(0);
  expect(prompts[0]).toBe("Shows progress only. Nothing is merged.");

  const headless = await executeTandemAction(parsed, service, {
    hasUI: false,
    mode: "rpc",
  } as unknown as ExtensionContext);
  expect(headless.approved).toBe(false);
  expect(published).toHaveLength(0);

  const approvingContext = {
    hasUI: true,
    mode: "tui",
    ui: { confirm: async () => true },
  } as unknown as ExtensionContext;
  const accepted = await executeTandemAction(parsed, service, approvingContext);
  expect(accepted.approved).toBe(true);
  expect(published).toEqual([
    {
      taskId: "task-1",
      input: { repository: "acme/repo", title: "Draft-title", base: "main", approved: true },
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
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: async (title: string, message: string) => {
        prompts.push(`${title} ${message}`);
        return false;
      },
    },
  } as unknown as ExtensionContext);
  expect(refused.approved).toBe(false);
  expect(published).toHaveLength(0);
  expect(prompts[0]).toContain("Skip review and open a PR");

  const headless = await executeTandemAction(action, service, {
    hasUI: false,
    mode: "rpc",
  } as unknown as ExtensionContext);
  expect(headless.approved).toBe(false);
  expect(published).toHaveLength(0);

  const accepted = await executeTandemAction(action, service, {
    hasUI: true,
    mode: "tui",
    ui: { confirm: async () => true },
  } as unknown as ExtensionContext);
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

test("ready and bounded-loop-exhausted outcomes wake the coordinator as distinct messages", async () => {
  const sent: string[] = [];
  const turns: unknown[] = [];
  const acknowledged: string[] = [];
  const service: Pick<TandemService, "acknowledge"> = {
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => {
      sent.push(content);
      turns.push(options);
    },
    () => undefined,
  );
  const context = notificationContext(() => undefined);
  const readyTask = task({
    id: "task-ready",
    stage: "ready",
    notifications: [
      {
        id: "ready-1",
        message:
          "Ready: task task-ready passed review at the standard review level and the final acceptance manifest at HEAD head-1. Ready is not publication, merge, or deploy approval; each remains explicit.",
        acknowledged: false,
        kind: "coordinator",
      },
    ],
  });
  const exhausted = transitionTask(
    task({ id: "task-exhausted", stage: "awaiting-fixes", reviewRound: 3 }),
    {
      type: "block",
      reason:
        "bounded review loop exhausted after 3 of 3 fix round(s); no new fix operation was admitted and the task is not ready or accepted",
    },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "exhausted-1" },
  );

  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [readyTask, exhausted],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    reportReadable: async () => true,
  });

  expect(sent).toHaveLength(2);
  const identifiers = sent[0] ?? "";
  const content = sent[1] ?? "";
  expect(identifiers).toContain("task task-ready");
  expect(identifiers).toContain("task task-exhausted");
  expect(content).not.toContain("[task-ready]");
  expect(content).not.toContain("[task-exhausted]");
  expect(content).toContain("Ready: task task-ready passed");
  expect(content).toContain("Ready is not publication, merge, or deploy approval");
  expect(content).toContain("Task task-exhausted blocked: bounded review loop");
  expect(content).toContain("the task is not ready or accepted");
  expect(turns[0]).not.toMatchObject({ triggerTurn: true });
  expect(turns[1]).toMatchObject({ triggerTurn: true });
  expect(acknowledged.sort()).toEqual(["task-exhausted:exhausted-1", "task-ready:ready-1"]);
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

  expect(summary).toContain("Pull request: acme/repo#11 draft");
  expect(summary).toContain("This is a draft: work in progress, not ready to merge.");
});

test("a failed acknowledgement retries on the next tick without waking the coordinator again", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const acknowledged: string[] = [];
  let acknowledgementsFail = true;
  const service: Pick<TandemService, "acknowledge"> = {
    acknowledge: async (taskId, notificationId) => {
      if (acknowledgementsFail) {
        throw new StoreLockTimeoutError("/tmp/tandem/home", 5_000);
      }
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => sent.push({ content, options }),
    () => undefined,
  );
  const context = notificationContext(() => undefined);
  const blocked = transitionTask(
    task({ stage: "implementing" }),
    { type: "block", reason: "worktree allocation failed before worker launch" },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "blocked-notification" },
  );
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();
  const deliver = async (): Promise<void> =>
    deliverPendingNotifications({
      pi: sink,
      service,
      tasks: [blocked],
      delivered,
      unacknowledged: unacknowledgedKeys,
      ctx: context,
      reportReadable: async () => true,
    });

  // The wake reaches the coordinator (a hidden identifiers message, then the displayed prompt),
  // then the acknowledgement loses the state-lock race.
  await deliver();
  expect(sent).toHaveLength(2);
  expect(acknowledged).toHaveLength(0);
  expect(unacknowledgedKeys.has("task-1:blocked-notification")).toBe(true);

  // Later ticks over the same still-unacknowledged record must not send the wake a second time.
  await deliver();
  await deliver();
  expect(sent).toHaveLength(2);

  // Once the lock is free the acknowledgement lands, exactly once, with no further wake.
  acknowledgementsFail = false;
  await deliver();
  expect(sent).toHaveLength(2);
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
  expect(unacknowledgedKeys.size).toBe(0);

  await deliver();
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
});

test("fresh block transitions wake the coordinator once through the bridge", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  let modelTurns = 0;
  const service: Pick<TandemService, "acknowledge"> = {
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => {
      sent.push({ content, options });
      if (
        options !== null &&
        typeof options === "object" &&
        "triggerTurn" in options &&
        options.triggerTurn === true
      ) {
        modelTurns += 1;
      }
    },
    () => undefined,
  );
  const context = notificationContext((message) => notices.push(message));
  const blocked = transitionTask(
    task({
      stage: "implementing",
      reportPath: "/tmp/tandem/task-1/report.txt",
      communication: {
        revision: 2,
        messages: [],
        question: {
          id: "question-1",
          text: "Should the existing API remain unchanged?",
          recommendation: "Keep the existing API unchanged.",
        },
      },
    }),
    { type: "block", reason: "worktree allocation failed before worker launch" },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "blocked-notification" },
  );
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();

  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [blocked],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    reportReadable: async () => true,
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [blocked],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    reportReadable: async () => true,
  });

  expect(blocked.stage).toBe("blocked");
  expect(blocked.notifications.at(-1)?.kind).toBe("coordinator");
  expect(sent).toHaveLength(2);
  expect(sent[0]?.content).toContain("task task-1");
  expect(sent[0]?.content).toContain("question question-1");
  expect(sent[1]?.content).not.toContain("[task-1]");
  expect(sent[1]?.content).not.toContain("question-1");
  expect(sent[1]?.content).toContain("worktree allocation failed before worker launch");
  expect(sent[1]?.content).toContain("Should the existing API remain unchanged?");
  expect(sent[1]?.content).toContain("Recommendation: Keep the existing API unchanged.");
  expect(sent[1]?.content).toContain("Evidence report: /tmp/tandem/task-1/report.txt");
  expect(modelTurns).toBe(1);
  expect(notices).toHaveLength(0);
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
});
test("scout report completion wakes once, survives durable reconnect, and retries failed delivery", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-extension-scout-"));
  const now = "2030-01-02T03:04:06.000Z";
  const clock = () => now;
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock,
    idFactory: () => "store-id",
  });
  try {
    let scouting = await store.create({
      id: "scout-task",
      repoPath: join(home, "repo"),
      kind: "scout",
      objective: "Collect the requested evidence.",
      acceptanceCriteria: ["Report the evidence."],
      surfaces: ["repository"],
      policy,
    });
    scouting = await store.update(scouting.id, scouting.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      stage: "scouting",
      updatedAt: now,
    }));
    const completed = await store.update(scouting.id, scouting.revision, (current) =>
      transitionTask(
        current,
        {
          type: "scout-report-complete",
          generation: current.generation,
          reportPath: "/tmp/tandem/scout-report.txt",
        },
        { now, notificationId: "scout-complete" },
      ),
    );
    expect(completed.stage).toBe("completed");
    expect(completed.notifications.at(-1)?.id).toBe("scout-complete");
    expect(completed.notifications.at(-1)?.kind).toBe("coordinator");

    const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
    const notices: string[] = [];
    const sink = notificationSink(
      (content, options) => sent.push({ content, options }),
      () => undefined,
    );
    const context = notificationContext((message) => notices.push(message));
    const delivered = new Set<string>();
    const unacknowledgedKeys = new Set<string>();
    const service = createTandemService({
      home,
      sessionId: "extension-scout-session",
      clock,
      idFactory: () => "service-id",
    });
    try {
      await deliverPendingNotifications({
        pi: sink,
        service: service,
        tasks: [completed],
        delivered: delivered,
        unacknowledged: unacknowledgedKeys,
        ctx: context,
        reportReadable: async () => true,
      });
      await deliverPendingNotifications({
        pi: sink,
        service: service,
        tasks: [completed],
        delivered: delivered,
        unacknowledged: unacknowledgedKeys,
        ctx: context,
        reportReadable: async () => true,
      });
      expect(sent).toHaveLength(2);
      expect(sent[0]?.content).toContain("task scout-task");
      expect(sent[0]?.options).toEqual({ deliverAs: "followUp" });
      expect(sent[1]?.content).toContain("/tmp/tandem/scout-report.txt");
      expect(sent[1]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(notices).toHaveLength(0);
    } finally {
      await service.shutdown();
    }

    const reopened = createTandemService({
      home,
      sessionId: "extension-scout-reconnected",
      clock,
      idFactory: () => "reconnected-id",
    });
    try {
      const persisted = await reopened.get("scout-task");
      expect(persisted.notifications.at(-1)?.acknowledged).toBe(true);
      await deliverPendingNotifications({
        pi: sink,
        service: reopened,
        tasks: [persisted],
        delivered: new Set<string>(),
        unacknowledged: new Set<string>(),
        ctx: context,
        reportReadable: async () => true,
      });
      expect(sent).toHaveLength(2);

      let retryScouting = await store.create({
        id: "scout-retry",
        repoPath: join(home, "repo"),
        kind: "scout",
        objective: "Retry the requested evidence.",
        acceptanceCriteria: ["Report the evidence."],
        surfaces: ["repository"],
        policy,
      });
      retryScouting = await store.update(retryScouting.id, retryScouting.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        stage: "scouting",
        updatedAt: now,
      }));
      const retryTask = await store.update(retryScouting.id, retryScouting.revision, (current) =>
        transitionTask(
          current,
          {
            type: "scout-report-complete",
            generation: current.generation,
            reportPath: "/tmp/tandem/scout-retry-report.txt",
          },
          { now, notificationId: "scout-retry" },
        ),
      );
      let failSend = true;
      const retrySent: string[] = [];
      const retrySink = notificationSink(
        (content) => {
          if (failSend) {
            failSend = false;
            throw new Error("coordinator bridge unavailable");
          }
          retrySent.push(content);
        },
        () => undefined,
      );
      const retryDelivered = new Set<string>();
      const retryUnacknowledged = new Set<string>();
      await expect(
        deliverPendingNotifications({
          pi: retrySink,
          service: reopened,
          tasks: [retryTask],
          delivered: retryDelivered,
          unacknowledged: retryUnacknowledged,
          ctx: context,
          reportReadable: async () => true,
        }),
      ).rejects.toThrow("coordinator bridge unavailable");
      const pendingRetry = await reopened.get("scout-retry");
      expect(pendingRetry.notifications.at(-1)?.id).toBe("scout-retry");
      expect(pendingRetry.notifications.at(-1)?.acknowledged).toBe(false);
      await deliverPendingNotifications({
        pi: retrySink,
        service: reopened,
        tasks: [pendingRetry],
        delivered: retryDelivered,
        unacknowledged: retryUnacknowledged,
        ctx: context,
        reportReadable: async () => true,
      });
      expect(retrySent).toHaveLength(2);
      expect(retrySent[1]).toContain("/tmp/tandem/scout-retry-report.txt");
      expect((await reopened.get("scout-retry")).notifications.at(-1)?.acknowledged).toBe(true);
    } finally {
      await reopened.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("automatic review-fix handoffs stay visible without waking the coordinator", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const entries: Array<{ readonly type: string; readonly data: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  const service: Pick<TandemService, "acknowledge"> = {
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => sent.push({ content, options }),
    (type, data) => entries.push({ type, data }),
  );
  const context = notificationContext((message) => notices.push(message));
  const routine = task({
    stage: "awaiting-fixes",
    notifications: [
      {
        id: "routine-1",
        message: "Review findings queued for the original implementer.",
        acknowledged: false,
      },
    ],
  });
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();

  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [routine],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    reportReadable: async () => true,
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [routine],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    reportReadable: async () => true,
  });

  expect(sent).toHaveLength(0);
  expect(notices).toHaveLength(1);
  expect(entries).toHaveLength(1);
  expect(acknowledged).toEqual(["task-1:routine-1"]);
});

test("actionable notifications coalesce one wake across tasks and exclude routine backlog", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const entries: Array<{ readonly type: string; readonly data: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  let modelTurns = 0;
  const service: Pick<TandemService, "acknowledge"> = {
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => {
      sent.push({ content, options });
      if (
        options !== null &&
        typeof options === "object" &&
        "triggerTurn" in options &&
        options.triggerTurn === true
      ) {
        modelTurns += 1;
      }
    },
    (type, data) => entries.push({ type, data }),
  );
  const context = notificationContext((message) => notices.push(message));
  const scout = task({
    kind: "scout",
    stage: "completed",
    notifications: [
      { id: "scout-old", message: "Earlier scout evidence.", acknowledged: false },
      { id: "scout-latest", message: "Latest scout report needs review.", acknowledged: false },
    ],
  });
  const blocked = task({
    id: "blocked",
    stage: "blocked",
    notifications: [
      { id: "blocked-latest", message: "Owner decision required.", acknowledged: false },
    ],
  });
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();

  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [scout, blocked],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    reportReadable: async () => true,
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [scout, blocked],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    reportReadable: async () => true,
  });

  expect(sent).toHaveLength(2);
  expect(sent[0]?.content).toContain("task task-1");
  expect(sent[0]?.content).toContain("task blocked");
  expect(sent[1]?.content).toContain("Latest scout report needs review.");
  expect(sent[1]?.content).toContain("Owner decision required.");
  expect(sent[1]?.content).not.toContain("Earlier scout evidence.");
  expect(modelTurns).toBe(1);
  expect(notices.join("\n")).toContain("Earlier scout evidence.");
  expect(entries).toHaveLength(1);
  expect(acknowledged).toHaveLength(3);
  expect(new Set(acknowledged)).toEqual(
    new Set(["task-1:scout-old", "task-1:scout-latest", "blocked:blocked-latest"]),
  );

  const recovered = task({
    ...scout,
    notifications: scout.notifications.map((notification) => ({
      ...notification,
      acknowledged: notification.id === "scout-latest",
    })),
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [recovered],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    reportReadable: async () => true,
  });
  expect(sent).toHaveLength(2);
  expect(modelTurns).toBe(1);
  expect(acknowledged).toHaveLength(4);
  expect(acknowledged.filter((value) => value === "task-1:scout-old")).toHaveLength(2);
});

test("notification kind controls whether presentation bookkeeping wakes the coordinator", async () => {
  const sent: string[] = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  const service: Pick<TandemService, "acknowledge"> = {
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content) => sent.push(content),
    () => undefined,
  );
  const context = notificationContext((message) => notices.push(message));
  const routine = task({
    stage: "blocked",
    notifications: [
      {
        id: "presentation-ready",
        message: "Presentation presentation-1 is ready.",
        acknowledged: false,
        kind: "routine",
      },
    ],
  });
  const coordinator = task({
    id: "task-coordinator",
    stage: "ready",
    notifications: [
      {
        id: "presentation-feedback",
        message: "Presentation presentation-1 received feedback:\nChoose a direction.",
        acknowledged: false,
        kind: "coordinator",
      },
    ],
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [routine, coordinator],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    reportReadable: async () => true,
  });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain("task task-coordinator");
  expect(sent[1]).not.toContain("[task-coordinator]");
  expect(sent[1]).toContain("Presentation presentation-1 received feedback");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("[task-1]");
  expect(acknowledged).toHaveLength(2);
});

test("legacy scout recovery survives a later routine presentation notice", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  let modelTurns = 0;
  const service: Pick<TandemService, "acknowledge"> = {
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => {
      sent.push({ content, options });
      if (
        options !== null &&
        typeof options === "object" &&
        "triggerTurn" in options &&
        options.triggerTurn === true
      ) {
        modelTurns += 1;
      }
    },
    () => undefined,
  );
  const context = notificationContext((message) => notices.push(message));
  const recovered = task({
    kind: "scout",
    stage: "completed",
    notifications: [
      {
        id: "legacy-report",
        message: "Legacy scout report requires coordinator review.",
        acknowledged: false,
      },
      {
        id: "routine-presentation",
        message: "Presentation presentation-1 is ready.",
        acknowledged: false,
        kind: "routine",
      },
    ],
  });

  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [recovered],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    reportReadable: async () => true,
  });

  expect(sent).toHaveLength(2);
  expect(sent[1]?.content).toContain("Legacy scout report requires coordinator review.");
  expect(modelTurns).toBe(1);
  expect(notices.join("\n")).toContain("Presentation presentation-1 is ready.");
  expect(acknowledged).toEqual(["task-1:legacy-report", "task-1:routine-presentation"]);

  const routineOnly = task({
    id: "routine-only",
    stage: "blocked",
    notifications: [
      {
        id: "routine-only-notice",
        message: "Routine presentation bookkeeping.",
        acknowledged: false,
        kind: "routine",
      },
    ],
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [routineOnly],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    reportReadable: async () => true,
  });

  expect(sent).toHaveLength(2);
  expect(modelTurns).toBe(1);
});

test("session shutdown waits for an interval reconciliation already in flight", async () => {
  type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
  const handlers = new Map<string, LifecycleHandler>();
  let intervalCallback: (() => void) | undefined;
  let timerCleared = false;
  const context = {
    ui: { notify: () => undefined },
    mode: "tui",
    cwd: "/repo",
    sessionManager: { getSessionId: () => "session-1" },
    setInterval: (callback: (...args: unknown[]) => void) => {
      intervalCallback = () => callback();
      return {} as Timer;
    },
    clearTimer: () => {
      timerCleared = true;
    },
  } as unknown as ExtensionContext;
  let tickCount = 0;
  let releaseTick!: (tasks: readonly TaskRecord[]) => void;
  const delayedTick = new Promise<readonly TaskRecord[]>((resolve) => {
    releaseTick = resolve;
  });
  let shutdownCalls = 0;
  const service = {
    tick: async () => {
      tickCount += 1;
      return tickCount === 2 ? delayedTick : [];
    },
    list: async () => [],
    shutdown: async () => {
      shutdownCalls += 1;
    },
  } as unknown as TandemService;
  const pi = {
    zod,
    on: (event: string, handler: LifecycleHandler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    logger: { error: () => undefined },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;

  createTandemExtension({ service })(pi);
  const sessionStart = handlers.get("session_start");
  const sessionShutdown = handlers.get("session_shutdown");
  if (sessionStart === undefined || sessionShutdown === undefined)
    throw new Error("extension lifecycle handlers were not registered");

  await sessionStart({}, context);
  if (intervalCallback === undefined) throw new Error("interval was not registered");
  intervalCallback();

  let completed = false;
  const shutdownPromise = Promise.resolve(sessionShutdown({}, context));
  void shutdownPromise.then(() => {
    completed = true;
  });
  await Promise.resolve();

  expect(completed).toBe(false);
  releaseTick([]);
  await shutdownPromise;
  expect(timerCleared).toBe(true);
  expect(shutdownCalls).toBe(1);
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
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: async (_title: string, message: string) => {
        prompts.push(message);
        return false;
      },
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;

  await executeTandemAction({ action: "cleanup", taskId: cleanupTask.id }, service, context);
  const refused = await executeTandemAction(
    { action: "cleanup", taskId: cleanupTask.id, discard: true },
    service,
    context,
  );

  expect(cleanupInputs).toEqual([{}]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toBe("This discards its changes.");
  expect(refused.approved).toBe(false);
});

test("a recovery question wakes the coordinator once with its recommendation and consequences", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  const service: Pick<TandemService, "acknowledge"> = {
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => sent.push({ content, options }),
    () => undefined,
  );
  const context = notificationContext((message) => notices.push(message));
  const question = {
    id: "recovery-3f2a",
    text: "Task task-1 in request req-1 is blocked: the reviewer never reported a result. Restart it?",
    recommendation: "restart: relaunches the reviewer at the exact reviewed HEAD",
  };
  const asked = task({
    id: "task-1",
    stage: "blocked",
    requestId: "req-1",
    blockReason: question.text,
    communication: { revision: 0, messages: [], question },
    notifications: [
      {
        id: "recovery-notification",
        message: question.text,
        acknowledged: false,
        kind: "coordinator",
      },
    ],
  });
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();

  await deliverPendingNotifications({
    pi: sink,
    service,
    tasks: [asked],
    delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    reportReadable: async () => true,
  });
  await deliverPendingNotifications({
    pi: sink,
    service,
    tasks: [asked],
    delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    reportReadable: async () => true,
  });

  expect(sent).toHaveLength(2);
  expect(sent[0]?.content).toContain("task task-1");
  expect(sent[0]?.content).toContain("question recovery-3f2a");
  expect(sent[1]?.content).not.toContain("Question recovery-3f2a:");
  expect(sent[1]?.content).toContain("Restart it?");
  expect(sent[1]?.content).toContain("Recommendation: restart:");
  expect(sent[1]?.options).toMatchObject({ triggerTurn: true });
  expect(notices).toHaveLength(0);
  expect(acknowledged).toEqual(["task-1:recovery-notification"]);
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
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: async (_title: string, message: string) => {
        prompts.push(message);
        return true;
      },
    },
  } as unknown as ExtensionContext;

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
