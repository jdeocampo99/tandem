import { expect, test } from "bun:test";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import type { TaskRecord } from "../../src/contracts.ts";
import { createTandemExtension } from "../../src/extension.ts";
import type { TandemService } from "../../src/service/controller.ts";
import {
  atCompactionBoundary,
  coordinatorCompactTokens,
  DEFAULT_COORDINATOR_COMPACT_TOKENS,
  finishedTaskIds,
} from "../../src/session/compaction.ts";

function task(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-1",
    kind: "implementation",
    stage: "implementing",
    notifications: [],
    ...overrides,
  } as TaskRecord;
}

test("the compaction threshold defaults to 128k, accepts 0 to turn it off, and ignores junk", () => {
  expect(coordinatorCompactTokens({})).toBe(DEFAULT_COORDINATOR_COMPACT_TOKENS);
  expect(coordinatorCompactTokens({ TANDEM_COORDINATOR_COMPACT_TOKENS: " 90000 " })).toBe(90_000);
  expect(coordinatorCompactTokens({ TANDEM_COORDINATOR_COMPACT_TOKENS: "0" })).toBe(0);
  expect(coordinatorCompactTokens({ TANDEM_COORDINATOR_COMPACT_TOKENS: "-5" })).toBe(128_000);
  expect(coordinatorCompactTokens({ TANDEM_COORDINATOR_COMPACT_TOKENS: "lots" })).toBe(128_000);
});

test("only finished implementation tasks count as finished", () => {
  const ids = finishedTaskIds([
    task({ id: "done", stage: "completed" }),
    task({ id: "merged", stage: "merged" }),
    task({ id: "running", stage: "reviewing" }),
    task({ id: "pr-ready", stage: "ready" }),
    task({ id: "scout", kind: "scout", stage: "completed" }),
  ]);
  expect([...ids].sort()).toEqual(["done", "merged"]);
});

test("the boundary needs a finished task and an idle coordinator, and allows running tasks", () => {
  const running = [task({ stage: "implementing" }), task({ id: "t2", stage: "validating" })];
  expect(atCompactionBoundary(running, { taskFinished: true, idle: true })).toBe(true);
  expect(atCompactionBoundary(running, { taskFinished: false, idle: true })).toBe(false);
  expect(atCompactionBoundary(running, { taskFinished: true, idle: false })).toBe(false);
});

test("any task waiting on the user holds compaction back", () => {
  for (const stage of ["blocked", "paused", "awaiting-approval", "ready"] as const) {
    expect(atCompactionBoundary([task({ stage })], { taskFinished: true, idle: true })).toBe(false);
  }
  const unread = task({
    notifications: [{ id: "n1", message: "report ready", acknowledged: false }],
  } as Partial<TaskRecord>);
  expect(atCompactionBoundary([unread], { taskFinished: true, idle: true })).toBe(false);
});

test("the coordinator compacts when a task finishes while idle over the threshold", async () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
  const handlers = new Map<string, Handler>();
  let tasks: TaskRecord[] = [task({ id: "a" }), task({ id: "b", stage: "blocked" })];
  const service = {
    list: async () => tasks,
    acknowledge: async () => undefined,
  } as unknown as TandemService;
  const pi = {
    zod,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: () => undefined,
    registerCommand: () => undefined,
    logger: { error: () => undefined },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;
  createTandemExtension({
    service,
    processEnvironment: {},
    environment: { home: "/tmp/tandem-home", sessionId: "s", poolRoot: "/tmp/pool", repo: "/repo" },
  })(pi);
  let compactions = 0;
  let tokens = 200_000;
  const ctx = {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "s" },
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
    compact: async () => {
      compactions += 1;
    },
  } as unknown as ExtensionContext;
  const agentEnd = async (): Promise<void> => {
    await handlers.get("agent_end")?.({ willContinue: false }, ctx);
  };

  await agentEnd(); // seeds the finished set; nothing has finished yet
  tasks = [task({ id: "a", stage: "completed" }), task({ id: "b", stage: "blocked" })];
  await agentEnd();
  expect(compactions).toBe(0); // b is still waiting on the user

  tasks = [task({ id: "a", stage: "completed" }), task({ id: "b", stage: "implementing" })];
  tokens = 50_000;
  await agentEnd();
  expect(compactions).toBe(0); // under the threshold, and that boundary is now used up

  tokens = 200_000;
  await agentEnd();
  expect(compactions).toBe(0); // no new task finished since

  tasks = [...tasks, task({ id: "c", stage: "merged" })];
  await agentEnd();
  expect(compactions).toBe(1);
});
