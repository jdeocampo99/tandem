import { expect, test } from "bun:test";
import type { HerdrAgentState, HerdrStatusReporter } from "../../src/adapters/herdr-status.ts";
import type { TaskRecord } from "../../src/contracts.ts";
import type { TandemService } from "../../src/service/controller.ts";
import {
  type CoordinatorDeps,
  CoordinatorSession,
  reviewStatus,
  sourceRefreshStatus,
} from "../../src/session/coordinator.ts";
import type { SessionHost } from "../../src/session/events.ts";
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
    createService: () => ({ prWatchNotices: async () => [], ...service }) as TandemService,
    realpath: async (path) => path,
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
