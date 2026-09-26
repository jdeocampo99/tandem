import { expect, test } from "bun:test";
import type { RepoPolicy } from "../../src/contracts.ts";
import { createRequestBriefRecord } from "../../src/requests/brief.ts";
import type { TandemService } from "../../src/service/controller.ts";
import {
  executeTandemAction,
  parseTandemCommand,
  resolveCommandAction,
  runTandemCommand,
  runTandemTool,
  type TandemCallDependencies,
} from "../../src/session/actions.ts";
import type { SessionEffect } from "../../src/session/events.ts";
import { buildDurableDigest, summarizeTandemActionValue } from "../../src/session/summary.ts";
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

function callDependencies(service: TandemService, followUps: string[]): TandemCallDependencies {
  return {
    service: () => service,
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

test("the tandem tool reconciles after a tick and runs the post-action step after anything else", async () => {
  const followUps: string[] = [];
  const service = {
    tick: async () => [],
    list: async () => [task()],
  } as unknown as TandemService;

  const ticked = await runTandemTool(
    { action: "tick" },
    callDependencies(service, followUps),
    undefined,
  );
  const listed = await runTandemTool(
    { action: "list" },
    callDependencies(service, followUps),
    undefined,
  );

  expect(followUps).toEqual(["reconcile", "postAction"]);
  expect(ticked).toEqual({
    text: summarizeTandemActionValue("tick", []),
    isError: false,
    details: { action: "tick", value: [] },
  });
  expect(listed).toMatchObject({ isError: false, details: { action: "list" } });
  expect(listed.text).toContain("task-1");
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

test("a /tandem command shows its result before the post-action step, and failures as errors", async () => {
  const order: string[] = [];
  const modelsFor: string[] = [];
  const service = {
    models: async (repoPath: string) => {
      modelsFor.push(repoPath);
      return { modelSettings: { configPath: "/m.json", configured: false }, availableModels: [] };
    },
  } as unknown as TandemService;
  const recording = recordingSessionHost();
  const host = {
    perform: async (effect: SessionEffect) => {
      order.push(effect.type);
      await recording.host.perform(effect);
    },
  };
  const dependencies = callDependencies(service, order);

  await runTandemCommand("models .", "/repo", dependencies, host);
  await runTandemCommand("unknown-command", "/repo", dependencies, host);

  // `.` is the coordinator's own checkout.
  expect(modelsFor).toEqual(["/repo"]);
  expect(order).toEqual(["notify", "postAction", "notify"]);
  expect(recording.effects[0]).toMatchObject({ type: "notify", level: "info" });
  expect(recording.effects[1]).toMatchObject({ type: "notify", level: "error" });
  expect(recording.effects[1]?.type === "notify" ? recording.effects[1].text : "").toStartWith(
    "Tandem command failed: ",
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
