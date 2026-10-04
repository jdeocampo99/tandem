import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import { resolveTandemEnvironment } from "../../../src/config/environment.ts";
import type { CommandRunner, TaskRecord } from "../../../src/contracts.ts";
import { createTandemExtension } from "../../../src/harness/omp/extension.ts";
import type { TandemService } from "../../../src/service/controller.ts";
import { StoreLockTimeoutError } from "../../../src/tasks/store-errors.ts";
import { task } from "../../session/fixtures.ts";

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
    prWatchNotices: async () => [],
    board: async () => ({ needsYou: [] }),
    investigationQuestions: async () => [],
    reviewPagesOpen: () => [],
  } as unknown as TandemService;
  const pi = {
    zod,
    on: (event: string, handler: LifecycleHandler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
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
    prWatchNotices: async () => [],
    board: async () => ({ needsYou: [] }),
    investigationQuestions: async () => [],
    reviewPagesOpen: () => [],
  } as unknown as TandemService;
  const pi = {
    zod,
    on: (event: string, handler: LifecycleHandler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
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
    prWatchNotices: async () => [],
    board: async () => ({ needsYou: [] }),
    investigationQuestions: async () => [],
    reviewPagesOpen: () => [],
  } as unknown as TandemService;
  const pi = {
    zod,
    on: (event: string, handler: LifecycleHandler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
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

test("OMP delivers a wake's hidden identifiers first, then the shown prompt that starts the turn", async () => {
  type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
  const handlers = new Map<string, LifecycleHandler>();
  const calls: unknown[] = [];
  const blocked = task({
    stage: "blocked",
    notifications: [
      { id: "blocked-1", message: "Owner decision required.", acknowledged: false },
      { id: "routine-1", message: "Workspace bookkeeping.", acknowledged: false, kind: "routine" },
    ],
  });
  const service = {
    list: async () => [blocked],
    acknowledge: async () => blocked,
    prWatchNotices: async () => [],
    board: async () => ({ needsYou: [] }),
    investigationQuestions: async () => [],
    reviewPagesOpen: () => [],
  } as unknown as TandemService;
  const pi = {
    zod,
    on: (event: string, handler: LifecycleHandler) => {
      handlers.set(event, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    logger: { error: () => undefined },
    sendMessage: (message: unknown, options: unknown) => calls.push({ message, options }),
    appendEntry: (customType: string) => calls.push({ entry: customType }),
  } as unknown as ExtensionAPI;
  createTandemExtension({
    service,
    processEnvironment: {},
    environment: { home: "/tmp/tandem-home", sessionId: "s", poolRoot: "/tmp/pool", repo: "/repo" },
  })(pi);
  const context = {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "s" },
    ui: { notify: (text: string) => calls.push({ notify: text }) },
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;

  await handlers.get("agent_end")?.({ willContinue: false }, context);

  expect(calls).toMatchObject([
    { notify: expect.stringContaining("Workspace bookkeeping.") },
    { entry: "tandem-notification" },
    {
      message: {
        customType: "tandem-notification",
        content: expect.stringContaining("task task-1, notification blocked-1"),
        display: false,
        details: { notifications: [expect.objectContaining({ taskId: "task-1" })] },
        attribution: "agent",
      },
      options: { deliverAs: "followUp" },
    },
    {
      message: {
        customType: "tandem-notification",
        content: expect.stringContaining("Owner decision required."),
        display: true,
        attribution: "agent",
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
  expect((calls[2] as { options: object }).options).toEqual({ deliverAs: "followUp" });
});

test("a tick that only waited out the state lock leaves the Herdr status alone; other failures block it", async () => {
  type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
  const failures = [
    { error: new StoreLockTimeoutError("/home", 5_000), reportsBlocked: false },
    { error: new Error("state database unreadable"), reportsBlocked: true },
  ];
  for (const failure of failures) {
    const handlers = new Map<string, LifecycleHandler>();
    const states: string[] = [];
    const run: CommandRunner = async (request) => {
      const state = request.argv[request.argv.indexOf("--state") + 1];
      if (request.argv.includes("report-agent") && state !== undefined) states.push(state);
      return { code: 0, stdout: "", stderr: "" };
    };
    const context = {
      ui: { notify: () => undefined },
      mode: "tui",
      cwd: "/repo",
      sessionManager: { getSessionId: () => "session-1" },
      setInterval: () => ({}) as Timer,
      clearTimer: () => undefined,
    } as unknown as ExtensionContext;
    const service = {
      tick: async () => {
        throw failure.error;
      },
      list: async () => [],
      shutdown: async () => undefined,
    } as unknown as TandemService;
    const pi = {
      zod,
      on: (event: string, handler: LifecycleHandler) => {
        handlers.set(event, handler);
      },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerMessageRenderer: () => undefined,
      logger: { error: () => undefined },
      sendMessage: () => undefined,
      appendEntry: () => undefined,
    } as unknown as ExtensionAPI;

    createTandemExtension({
      service,
      run,
      processEnvironment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "tandem-session",
        HERDR_PANE_ID: "pane-coordinator",
      },
    })(pi);
    const sessionStart = handlers.get("session_start");
    if (sessionStart === undefined) throw new Error("session_start was not registered");
    await Promise.resolve(sessionStart({}, context)).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states.includes("blocked"), failure.error.message).toBe(failure.reportsBlocked);
  }
});
