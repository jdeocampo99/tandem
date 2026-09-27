import { expect, test } from "bun:test";
import type { HerdrAgentState, HerdrStatusReporter } from "../../src/adapters/herdr-status.ts";
import type { BoardRow } from "../../src/board/view.ts";
import type { TaskRecord } from "../../src/contracts.ts";
import { TANDEM_COORDINATOR_INSTRUCTIONS } from "../../src/instructions.ts";
import type { TandemService } from "../../src/service/controller.ts";
import { runTandemCommand } from "../../src/session/actions.ts";
import {
  type CoordinatorDeps,
  CoordinatorSession,
  reviewStatus,
  sourceRefreshStatus,
} from "../../src/session/coordinator.ts";
import type { SessionHost } from "../../src/session/events.ts";
import { WELCOME_TEXT } from "../../src/terminal/welcome.ts";
import { fakeSessionTime, recordingSessionHost } from "../evals/scenario.ts";
import { task } from "./fixtures.ts";

function coordinatorDeps(
  service: Partial<TandemService>,
  overrides: Partial<CoordinatorDeps> = {},
): CoordinatorDeps {
  const time = fakeSessionTime();
  return {
    host: recordingSessionHost().host,
    clock: time.clock,
    timers: time.timers,
    status: undefined,
    logError: () => undefined,
    environment: {
      home: "/tmp/tandem-home",
      sessionId: "session-1",
      poolRoot: "/tmp/tandem-pool",
      repo: "/repo",
    },
    createService: () =>
      ({
        prWatchNotices: async () => [],
        requestBriefs: async () => [],
        board: async () => ({ now: "", projects: [], needsYou: [], running: [], pullRequests: [] }),
        investigationQuestions: async () => [],
        ...service,
      }) as TandemService,
    realpath: async (path) => path,
    isTandemCheckout: async () => false,
    openWelcome: async () => undefined,
    readReport: async () => undefined,
    appendUsage: async () => undefined,
    compactTokens: 128_000,
    tickIntervalMs: 2_000,
    ...overrides,
  };
}

function recordingReporter(
  reports: string[],
  released: { count: number } = { count: 0 },
): HerdrStatusReporter {
  return {
    report: async (state: HerdrAgentState, message?: string) => {
      reports.push(`${state}: ${message ?? ""}`);
    },
    release: async () => {
      released.count += 1;
    },
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

test("source refresh status says whether the coordinator source moved, is local-only, or is current", () => {
  const refresh = { head: "b", previousHead: "a", changed: false, localOnly: false };
  expect(sourceRefreshStatus({ ...refresh, changed: true })).toStartWith(
    "Coordinator source advanced from a to b;",
  );
  expect(sourceRefreshStatus({ ...refresh, localOnly: true })).toStartWith(
    "Coordinator source is local-only;",
  );
  expect(sourceRefreshStatus(refresh)).toStartWith("Coordinator source is current for this turn.");
  expect(sourceRefreshStatus(undefined)).toStartWith(
    "Coordinator source is current for this turn.",
  );
});

test("the coordinator compacts when a task finishes while idle over the threshold", async () => {
  let tasks: TaskRecord[] = [task({ id: "a" }), task({ id: "b", stage: "blocked" })];
  const { host, effects, answers } = recordingSessionHost({ answers: { contextTokens: 200_000 } });
  const session = new CoordinatorSession(
    coordinatorDeps({ list: async () => tasks, acknowledge: async () => task({}) }, { host }),
  );
  const compactions = (): number => effects.filter((effect) => effect.type === "compact").length;

  await session.agentEnd(false); // seeds the finished set; nothing has finished yet
  tasks = [task({ id: "a", stage: "completed" }), task({ id: "b", stage: "blocked" })];
  await session.agentEnd(false);
  expect(compactions()).toBe(0); // b is still waiting on the user

  tasks = [task({ id: "a", stage: "completed" }), task({ id: "b", stage: "implementing" })];
  answers.contextTokens = 50_000;
  await session.agentEnd(false);
  expect(compactions()).toBe(0); // under the threshold, and that boundary is now used up

  answers.contextTokens = 200_000;
  await session.agentEnd(false);
  expect(compactions()).toBe(0); // no new task finished since

  tasks = [...tasks, task({ id: "c", stage: "merged" })];
  await session.agentEnd(false);
  expect(compactions()).toBe(1);

  tasks = [...tasks, task({ id: "d", stage: "merged" })];
  const { host: noCompaction, effects: noCompactionEffects } = recordingSessionHost({
    capabilities: { proactiveCompaction: false },
    answers: { contextTokens: 200_000 },
  });
  const unsupported = new CoordinatorSession(
    coordinatorDeps({ list: async () => tasks }, { host: noCompaction }),
  );
  await unsupported.agentEnd(false);
  tasks = [...tasks, task({ id: "e", stage: "merged" })];
  await unsupported.agentEnd(false);
  expect(noCompactionEffects.filter((effect) => effect.type === "compact")).toHaveLength(0);
});

test("a compaction that re-enters the session does not wait on the reconcile that started it", async () => {
  let tasks: TaskRecord[] = [task({ id: "a" })];
  const recording = recordingSessionHost({ answers: { contextTokens: 200_000 } });
  const reentries: Promise<void>[] = [];
  let session: CoordinatorSession | undefined;
  // Like OMP, compaction finishes by emitting `compacted` before the compact call returns.
  const host: SessionHost = {
    ...recording.host,
    perform: async (effect) => {
      await recording.host.perform(effect);
      if (effect.type !== "compact" || session === undefined) return;
      const reentry = session.compacted();
      reentries.push(reentry);
      await reentry;
    },
  };
  session = new CoordinatorSession(
    coordinatorDeps({ list: async () => tasks, tick: async () => tasks }, { host }),
  );

  await session.agentEnd(false);
  tasks = [task({ id: "a", stage: "completed" })];
  await session.agentEnd(false);
  await Promise.all(reentries);

  expect(reentries).toHaveLength(1);
  expect(recording.effects.map((effect) => effect.type)).toEqual(["compact", "recordEntry"]);
  expect(recording.effects[1]).toMatchObject({ entryType: "tandem-digest" });
});

test("reconcile runs one pass at a time and a concurrent call joins it", async () => {
  let ticks = 0;
  let lists = 0;
  let releaseTick!: (tasks: readonly TaskRecord[]) => void;
  const session = new CoordinatorSession(
    coordinatorDeps({
      tick: () => {
        ticks += 1;
        return new Promise((resolve) => {
          releaseTick = resolve;
        });
      },
      list: async () => {
        lists += 1;
        return [];
      },
    }),
  );

  const first = session.reconcile(true);
  const joined = session.reconcile(false);
  expect(joined).toBe(first);
  releaseTick([]);
  await first;
  expect(ticks).toBe(1);
  expect(lists).toBe(0);

  await session.reconcile(false);
  expect(lists).toBe(1);
});

test("shutdown clears the tick timer, waits for the reconcile in flight, and releases the pane", async () => {
  const time = fakeSessionTime();
  let ticks = 0;
  let shutdowns = 0;
  let releaseTick!: (tasks: readonly TaskRecord[]) => void;
  const released = { count: 0 };
  const session = new CoordinatorSession(
    coordinatorDeps(
      {
        tick: () => {
          ticks += 1;
          if (ticks === 1) return Promise.resolve([]);
          return new Promise((resolve) => {
            releaseTick = resolve;
          });
        },
        list: async () => [],
        shutdown: async () => {
          shutdowns += 1;
        },
      },
      { clock: time.clock, timers: time.timers, status: recordingReporter([], released) },
    ),
  );

  await session.sessionStart();
  expect(time.pendingTimers()).toBe(1);
  time.advance(2_000);
  expect(ticks).toBe(2);

  let completed = false;
  const stopped = session.shutdown().then(() => {
    completed = true;
  });
  expect(time.pendingTimers()).toBe(0);
  await Promise.resolve();
  expect(completed).toBe(false);

  releaseTick([]);
  await stopped;
  expect(shutdowns).toBe(1);
  expect(released.count).toBe(1);
  time.advance(10_000);
  await session.reconcile(true);
  expect(ticks).toBe(2);
});

test("an open ask shows the pane as waiting for the user's answer until it ends", () => {
  const reports: string[] = [];
  const session = new CoordinatorSession(
    coordinatorDeps({}, { status: recordingReporter(reports) }),
  );
  const ask = { id: "call-1", name: "ask", kind: "ask" } as const;
  const read = { id: "call-2", name: "read", kind: "read" } as const;

  session.toolStart(read);
  session.toolStart(ask);
  session.toolEnd(read);
  expect(reports.at(-1)).toBe("blocked: Waiting for your answer");
  session.toolEnd(ask);
  expect(reports.at(-1)).toBe("working: ");
});

test("turn usage is recorded with the injected clock and the resolved repository", async () => {
  const time = fakeSessionTime();
  const recorded: unknown[] = [];
  const session = new CoordinatorSession(
    coordinatorDeps(
      {},
      {
        clock: time.clock,
        realpath: async () => "/real/repo",
        appendUsage: async (entry) => {
          recorded.push(entry);
        },
      },
    ),
  );

  await session.turnEnd(undefined);
  await session.turnEnd({
    provider: "openai",
    model: "gpt",
    input: 10,
    cacheRead: 5,
    cacheWrite: 1,
    output: 7,
    costUsd: 0.5,
  });

  expect(recorded).toEqual([
    {
      at: "2030-01-01T00:00:00.000Z",
      repoPath: "/real/repo",
      inputTokens: 16,
      outputTokens: 7,
      costUsd: 0.5,
    },
  ]);
});

test("one Herdr notification names what of this project's just landed in Needs you, not what was already there or a block", async () => {
  const row = (key: string, repoPath: string, cause: BoardRow["cause"] = "brief") => ({
    key,
    cause,
    repoPath,
    project: "p",
    mark: "🙋",
    name: key,
    text: "",
  });
  let needsYou = [row("brief:req-old", "/repo")];
  const notified: [string, string[]][] = [];
  const session = new CoordinatorSession(
    coordinatorDeps({
      list: async () => [],
      board: async () => ({
        now: "",
        projects: [],
        needsYou,
        running: [],
        pullRequests: [],
        finished: 0,
      }),
      notifyNeedsYou: async (repoPath, rows) => {
        notified.push([repoPath, rows.map((each) => each.key)]);
      },
    }),
  );

  await session.reconcile(false);
  expect(notified).toEqual([]);

  needsYou = [
    ...needsYou,
    row("question:q-1", "/other-project", "question"),
    row("task:task-1:blocked", "/repo", "blocked"),
  ];
  await session.reconcile(false);
  expect(notified).toEqual([]);

  needsYou = [
    ...needsYou,
    row("pr:acme/app#409", "/repo", "pull-request"),
    row("task:task-2:ready", "/repo", "ready"),
  ];
  await session.reconcile(false);
  expect(notified).toEqual([["/repo", ["pr:acme/app#409", "task:task-2:ready"]]]);

  await session.reconcile(false);
  expect(notified).toHaveLength(1);
});

test("while the user is in a thread, what needs the coordinator waits for the thread to end", async () => {
  const blocked = (id: string): TaskRecord =>
    task({
      id,
      stage: "blocked",
      notifications: [
        { id: `${id}-n`, message: `${id} is blocked.`, acknowledged: false, kind: "coordinator" },
      ],
    });
  let tasks: TaskRecord[] = [blocked("a")];
  let now = 0;
  const { host, effects } = recordingSessionHost();
  const session = new CoordinatorSession(
    coordinatorDeps(
      { list: async () => tasks, acknowledge: async () => task({}) },
      { host, clock: { now: () => now, monotonic: () => now } },
    ),
  );
  const wakes = () =>
    effects.flatMap((effect) => (effect.type === "deliver" && effect.triggerTurn ? [effect] : []));
  const toasts = () => effects.flatMap((effect) => (effect.type === "notify" ? [effect.text] : []));

  session.userPrompt();
  await session.agentEnd(false);
  await session.agentEnd(false);
  expect(wakes()).toEqual([]);
  expect(toasts()).toEqual([
    `1 waiting for when you finish this. Ask "what's waiting?" to see them.`,
  ]);

  tasks = [blocked("a"), blocked("b")];
  await session.agentEnd(false);
  expect(wakes()).toEqual([]);
  expect(toasts().at(-1)).toStartWith("2 waiting");

  session.closeThread();
  await session.agentEnd(false);
  expect(wakes()).toHaveLength(1);
  expect(wakes()[0]?.text).toContain("a is blocked.");
  expect(wakes()[0]?.text).toContain("b is blocked.");
  expect(wakes()[0]?.hidden?.text).toStartWith("Some of these came in while you and the user");

  // A thread the model never closed ends after the user has been quiet long enough.
  tasks = [blocked("c")];
  session.userPrompt();
  await session.agentEnd(false);
  expect(wakes()).toHaveLength(1);
  now += 30 * 60 * 1_000;
  await session.agentEnd(false);
  expect(wakes()).toHaveLength(2);

  // With no thread open, it wakes the coordinator right away, as before.
  tasks = [blocked("d")];
  await session.agentEnd(false);
  expect(wakes()).toHaveLength(3);
  expect(wakes()[2]?.hidden?.text).not.toContain("came in while");
});

test("a trace-only turn skips final reconciliation, but other actions keep it", async () => {
  const routine = task({
    id: "task-routine",
    notifications: [
      {
        id: "routine-1",
        message: "A routine receipt is ready.",
        acknowledged: false,
        kind: "routine",
      },
    ],
  });
  const acknowledged: string[] = [];
  let listCalls = 0;
  const { host, effects } = recordingSessionHost();
  const session = new CoordinatorSession(
    coordinatorDeps(
      {
        list: async () => {
          listCalls += 1;
          return [routine];
        },
        acknowledge: async (taskId, notificationId) => {
          acknowledged.push(`${taskId}:${notificationId}`);
          return routine;
        },
      },
      { host },
    ),
  );

  session.userPrompt();
  session.recordTurnAction("trace");
  await session.agentEnd(false);
  expect(listCalls).toBe(0);
  expect(acknowledged).toEqual([]);
  expect(effects).toEqual([]);

  await session.agentEnd(false);
  expect(listCalls).toBe(1);
  expect(acknowledged).toEqual(["task-routine:routine-1"]);

  session.userPrompt();
  session.recordTurnAction("trace");
  session.recordTurnAction("other");
  await session.agentEnd(false);
  expect(listCalls).toBe(2);

  session.userPrompt();
  session.recordTurnAction("other");
  session.recordTurnAction("trace");
  await session.agentEnd(false);
  expect(listCalls).toBe(3);

  // Answering an ask mid-run must not forget the ask itself.
  session.userPrompt();
  session.recordTurnAction("other");
  session.toolEnd({ id: "ask-1", name: "ask", kind: "ask" });
  session.recordTurnAction("trace");
  await session.agentEnd(false);
  expect(listCalls).toBe(4);
});

test("a local trace command leaves later automatic reconciliation enabled", async () => {
  const routine = task({
    id: "task-routine",
    notifications: [
      {
        id: "routine-1",
        message: "A routine receipt is ready.",
        acknowledged: false,
        kind: "routine",
      },
    ],
  });
  const acknowledged: string[] = [];
  let listCalls = 0;
  const service = {
    trace: async () => ({
      events: [],
      unreadableEvents: 0,
      rollup: { taskId: "task-routine", fixRounds: 0, blockedMs: 0 },
    }),
    list: async () => {
      listCalls += 1;
      return [routine];
    },
    acknowledge: async (taskId: string, notificationId: string) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return routine;
    },
  } as unknown as TandemService;
  const { host, effects } = recordingSessionHost();
  const session = new CoordinatorSession(coordinatorDeps(service, { host }));
  const postActionCalls: string[] = [];

  await runTandemCommand(
    "trace task-routine",
    "/repo",
    {
      service: () => service,
      confirm: undefined,
      postAction: async () => {
        postActionCalls.push("postAction");
        await session.reconcile(false);
      },
    },
    host,
  );

  expect(listCalls).toBe(0);
  expect(acknowledged).toEqual([]);
  expect(postActionCalls).toEqual([]);
  expect(effects[0]?.type === "notify" ? effects[0].text : "").toContain("Task task-routine");

  // Notification-triggered turns start without passing through the input handler.
  session.turnStart();
  await session.agentEnd(false);

  expect(listCalls).toBe(1);
  expect(acknowledged).toEqual(["task-routine:routine-1"]);
});

test("the standing context lists the project's workstreams once there are any", async () => {
  const asked: string[] = [];
  const withNotes = new CoordinatorSession(
    coordinatorDeps({
      list: async () => [],
      memoryList: async (repoPath) => {
        asked.push(repoPath);
        return ["tia: 1 follow-up due", "billing: nothing due"];
      },
    }),
  );
  const context = (await withNotes.agentStart()).systemContext;
  expect(context.at(-1)).toBe("Workstreams: tia: 1 follow-up due · billing: nothing due");
  expect(asked).toEqual(["/repo"]);

  const without = new CoordinatorSession(
    coordinatorDeps({ list: async () => [], memoryList: async () => [] }),
  );
  const unreadable = new CoordinatorSession(
    coordinatorDeps({
      list: async () => [],
      memoryList: async () => {
        throw new Error("unreadable notes");
      },
    }),
  );
  const plain = (await without.agentStart()).systemContext;
  expect(plain.some((part) => part.startsWith("Workstreams:"))).toBe(false);
  expect((await unreadable.agentStart()).systemContext).toEqual(plain);
});

function welcomeSession(
  options: Readonly<{
    tandemCheckout: boolean;
    projects: readonly string[];
    openWelcome?: () => Promise<void>;
  }>,
) {
  const { host, effects } = recordingSessionHost();
  let opened = 0;
  const session = new CoordinatorSession(
    coordinatorDeps(
      {
        tick: async () => [],
        list: async () => [],
        shutdown: async () => undefined,
        onboardingFacts: async () => ({
          modelsChosen: false,
          codeFolders: [],
          projects: options.projects.filter((project) => project !== "/repo"),
          selfImprovementChosen: false,
          setupPage: "unavailable",
        }),
        board: async () => ({
          now: "",
          projects: options.projects,
          needsYou: [],
          running: [],
          finished: 0,
          pullRequests: [],
        }),
      },
      {
        host,
        isTandemCheckout: async () => options.tandemCheckout,
        openWelcome:
          options.openWelcome ??
          (async () => {
            opened += 1;
          }),
      },
    ),
  );
  return { session, effects, opened: () => opened };
}

test("the Tandem coordinator opens the welcome popup until another project is set up", async () => {
  const alone = welcomeSession({ tandemCheckout: true, projects: ["/repo"] });
  await alone.session.sessionStart();
  expect(alone.opened()).toBe(1);
  const context = (await alone.session.agentStart()).systemContext.join("\n");
  expect(context).toContain(TANDEM_COORDINATOR_INSTRUCTIONS);
  expect(context).toContain("Current step: Choose models");
  await alone.session.shutdown();

  const onboarded = welcomeSession({ tandemCheckout: true, projects: ["/repo", "/code/app"] });
  await onboarded.session.sessionStart();
  expect(onboarded.opened()).toBe(0);
  await onboarded.session.shutdown();
});

test("another project's coordinator never welcomes and has no Tandem-only instructions", async () => {
  const project = welcomeSession({ tandemCheckout: false, projects: [] });
  await project.session.sessionStart();
  expect(project.opened()).toBe(0);
  const context = (await project.session.agentStart()).systemContext.join("\n");
  expect(context).not.toContain(TANDEM_COORDINATOR_INSTRUCTIONS);
  await project.session.shutdown();
});

test("when the popup cannot open, the welcome arrives in the chat without a model turn", async () => {
  const fallback = welcomeSession({
    tandemCheckout: true,
    projects: [],
    openWelcome: async () => {
      throw new Error("plugin not found");
    },
  });
  await fallback.session.sessionStart();
  const delivered = fallback.effects.flatMap((effect) =>
    effect.type === "deliver" ? [effect] : [],
  );
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.text).toBe(WELCOME_TEXT);
  expect(delivered[0]?.triggerTurn).toBe(false);
  await fallback.session.shutdown();
});
