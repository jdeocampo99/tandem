import { expect, test } from "bun:test";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import type { ModelSpec, RepoPolicy, ResolvedPolicy, TaskRecord } from "../src/contracts.ts";
import {
  buildDurableDigest,
  createTandemExtension,
  deliverPendingNotifications,
  executeTandemAction,
  parseTandemCommand,
  resolveTandemEnvironment,
  summarizeTandemActionValue,
} from "../src/extension.ts";
import { transitionTask } from "../src/lifecycle.ts";
import type { TandemService } from "../src/service.ts";

const models: Readonly<
  Record<
    "coordinator" | "scout" | "implementer" | "reviewer" | "verifier" | "presentation",
    ModelSpec
  >
> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  verifier: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

const policyConfig: RepoPolicy = {
  version: 1,
  models,
  instructions: { implementation: [], validation: [], review: [] },
  instructionFiles: { implementation: [], validation: [], review: [] },
  validationCommands: [],
  maxWorkers: 3,
  maxFixRounds: 3,
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
  expect(overview).toContain("Last observed activity");
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
  expect(prompts[0]).toContain("Communication revision 3");
  expect(prompts[0]).toContain("Preserve the existing adapter.");
  expect(prompts[0]).toContain("Use the compatibility path.");
  expect(prompts[0]).not.toContain("REPLACE_ME_OLD");
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
    "Final checks (verifier)",
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
test("onboard summaries render complete saved and pending role selections", () => {
  const savedModels: RepoPolicy["models"] = {
    coordinator: { model: "provider/planning", thinking: "high" },
    scout: { model: "provider/research", thinking: "low" },
    implementer: { model: "provider/coding", thinking: "max" },
    reviewer: { model: "provider/review", thinking: "medium" },
    verifier: { model: "provider/checks", thinking: "xhigh" },
    presentation: { model: "provider/presentations", thinking: "minimal" },
  };
  const roleIdentities = [
    "Planning (coordinator)",
    "Research (scout)",
    "Coding (implementer)",
    "Review (reviewer)",
    "Final checks (verifier)",
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

test("durable digest prioritizes current blockers and preserves acceptance and review evidence", () => {
  const blocked = task({
    id: "blocked",
    stage: "blocked",
    objective: "Current implementation needs a decision",
    acceptanceCriteria: ["Keep the API stable", "Record the decision durably"],
    blockReason: "Waiting for the owner to choose the migration path.",
    reviewHead: "head-active",
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
    task({ id: "blocked", stage: "implementing" }),
    { type: "block", reason: "worktree allocation failed before worker launch" },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "blocked-notification" },
  );
  const delivered = new Set<string>();

  await deliverPendingNotifications(sink, service, [blocked], delivered, context);
  await deliverPendingNotifications(sink, service, [blocked], delivered, context);

  expect(blocked.stage).toBe("blocked");
  expect(blocked.notifications.at(-1)?.kind).toBe("coordinator");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.content).toContain("worktree allocation failed before worker launch");
  expect(modelTurns).toBe(1);
  expect(notices).toHaveLength(0);
  expect(acknowledged).toEqual(["blocked:blocked-notification"]);
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

  await deliverPendingNotifications(sink, service, [routine], delivered, context);
  await deliverPendingNotifications(sink, service, [routine], delivered, context);

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

  await deliverPendingNotifications(sink, service, [scout, blocked], delivered, context);
  await deliverPendingNotifications(sink, service, [scout, blocked], delivered, context);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.content).toContain("Latest scout report needs review.");
  expect(sent[0]?.content).toContain("Owner decision required.");
  expect(sent[0]?.content).not.toContain("Earlier scout evidence.");
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
  await deliverPendingNotifications(sink, service, [recovered], new Set<string>(), context);
  expect(sent).toHaveLength(1);
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
  await deliverPendingNotifications(
    sink,
    service,
    [routine, coordinator],
    new Set<string>(),
    context,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("[task-coordinator]");
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

  await deliverPendingNotifications(sink, service, [recovered], new Set<string>(), context);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.content).toContain("Legacy scout report requires coordinator review.");
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
  await deliverPendingNotifications(sink, service, [routineOnly], new Set<string>(), context);

  expect(sent).toHaveLength(1);
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
  expect(prompts[0]).toContain("/repo");
  expect(prompts[0]).toContain("Release the completed task resources");
  expect(prompts[0]).toContain("review-head");
  expect(prompts[0]).toContain("/tmp/treehouse/task-1");
  expect(refused.approved).toBe(false);
});
