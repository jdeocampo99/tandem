import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "../../src/config/policy.ts";
import type { Endpoint } from "../../src/contracts.ts";
import { runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { emptyRuntimeState, type RuntimeTaskState } from "../../src/runtime/schema.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { assertTerminalSwitch } from "../../src/terminal-backend/setting.ts";

const now = () => "2026-10-06T00:00:00.000Z";
const retainedPane: Endpoint = {
  terminal: "herdr",
  sessionId: "test",
  workspaceId: "work",
  tabId: "tab",
  paneId: "pane",
  role: "implementer",
  generation: 0,
};

test("a blocked task with a failed job and retained Herdr pane cannot switch terminals", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-terminal-setting-"));
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: now,
    idFactory: () => "blocked",
  });
  const service = createTandemService({
    home,
    sessionId: "test",
    run: async () => {
      throw new Error("blocked switching must not contact a terminal");
    },
  });
  try {
    const task = await store.create({
      repoPath: home,
      kind: "scout",
      objective: "Research",
      surfaces: [],
      acceptanceCriteria: [],
      policy: {
        config: defaultPolicy(),
        guidance: { implementation: [], validation: [], review: [] },
      },
    });
    const blocked = await store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        { type: "block", reason: "worker failed" },
        { now: now(), notificationId: "blocked-notice" },
      ),
    );
    const runtime: RuntimeTaskState = {
      schemaVersion: 1,
      taskId: task.id,
      taskName: task.id,
      sourceCheckpoint: { head: "a", base: "a", diff: "", dirty: false, unmerged: false },
      endpoints: [retainedPane],
      jobs: [
        {
          schemaVersion: 1,
          id: "failed-job",
          taskId: task.id,
          generation: 0,
          role: "scout",
          kind: "worker",
          cwd: home,
          jobPath: join(home, "job"),
          resultPath: join(home, "result"),
          attempt: 1,
          phase: "failed",
          launchAttempted: true,
          createdAt: now(),
          endpoint: retainedPane,
        },
      ],
    };
    await writeRuntimeState(runtimeFile(home), { ...emptyRuntimeState(), tasks: [runtime] });
    await expect(service.configureTerminal("tern")).rejects.toThrow("blocked");
    await expect(readFile(join(home, "settings.toml"))).rejects.toThrow();
    // Retained resources still block after the task is cancelled or its record is absent.
    expect(() =>
      assertTerminalSwitch("herdr", "tern", [], { ...emptyRuntimeState(), tasks: [runtime] }),
    ).toThrow();
    for (const stage of ["paused", "blocked", "ready", "awaiting-approval"] as const) {
      expect(() =>
        assertTerminalSwitch("herdr", "tern", [{ ...blocked, stage }], emptyRuntimeState()),
      ).toThrow();
    }
    for (const stage of ["completed", "cancelled", "merged"] as const) {
      expect(() =>
        assertTerminalSwitch("herdr", "tern", [{ ...blocked, stage }], emptyRuntimeState()),
      ).not.toThrow();
    }
  } finally {
    await service.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("a retained presentation pane prevents switching even after its job is finished", () => {
  const state = {
    ...emptyRuntimeState(),
    presentations: [
      {
        schemaVersion: 1 as const,
        id: "view",
        taskId: "completed",
        recordPath: "/tmp/retained-presentation",
        endpoint: retainedPane,
      },
    ],
  };
  expect(() => assertTerminalSwitch("herdr", "tern", [], state)).toThrow("completed");
  expect(() => assertTerminalSwitch("herdr", "herdr", [], state)).not.toThrow();
  expect(() =>
    assertTerminalSwitch("herdr", "tern", [], { ...state, presentations: [] }),
  ).not.toThrow();
});

test("a switch with an active task is refused before saving the terminal", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-terminal-setting-"));
  const service = createTandemService({
    home,
    sessionId: "test",
    clock: now,
    run: async () => {
      throw new Error("must not contact a terminal");
    },
  });
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: now,
    idFactory: () => "task",
  });
  try {
    const task = await store.create({
      repoPath: home,
      kind: "scout",
      objective: "Research",
      surfaces: [],
      acceptanceCriteria: [],
      policy: {
        config: defaultPolicy(),
        guidance: { implementation: [], validation: [], review: [] },
      },
    });
    expect(task.stage).toBe("queued");
    await expect(service.configureTerminal("tern")).rejects.toThrow("while tasks are running");
    await expect(readFile(join(home, "settings.toml"))).rejects.toThrow();
    await service.configureTerminal("herdr");
    expect(await readFile(join(home, "settings.toml"), "utf8")).toContain('terminal = "herdr"');
  } finally {
    await service.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("uncertain ownership refuses switching even without an active task record", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-terminal-setting-"));
  const runtime: RuntimeTaskState = {
    schemaVersion: 1,
    taskId: "lost-task",
    taskName: "lost-task",
    sourceCheckpoint: { head: "a", base: "a", diff: "", dirty: false, unmerged: false },
    endpoints: [],
    jobs: [],
    reservation: {
      schemaVersion: 1,
      id: "held",
      taskId: "lost-task",
      ownerSessionId: "test",
      phase: "reserved",
      createdAt: now(),
    },
  };
  try {
    const state = { ...emptyRuntimeState(), tasks: [runtime] };
    expect(() => assertTerminalSwitch("herdr", "tern", [], state)).toThrow("uncertain ownership");
    expect(() => assertTerminalSwitch("herdr", "herdr", [], state)).not.toThrow();
    // A real service checks the same retained reservation under the task store's state lock.
    await writeRuntimeState(runtimeFile(home), state);
    const service = createTandemService({ home, sessionId: "test" });
    try {
      await expect(service.configureTerminal("tern")).rejects.toThrow("uncertain ownership");
    } finally {
      await service.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("choosing missing Tern saves Herdr and explains the fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-terminal-setting-"));
  const service = createTandemService({
    home,
    sessionId: "test",
    run: async () => ({ code: 127, stdout: "", stderr: "not installed" }),
  });
  try {
    const result = await service.configureTerminal("tern");
    expect(result).toMatchObject({
      requested: "tern",
      terminal: "herdr",
      reason: expect.stringContaining("not installed"),
    });
    expect(await readFile(join(home, "settings.toml"), "utf8")).toContain('terminal = "herdr"');
  } finally {
    await service.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
