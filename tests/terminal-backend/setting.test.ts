import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "../../src/config/policy.ts";
import { runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { emptyRuntimeState, type RuntimeTaskState } from "../../src/runtime/schema.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { assertTerminalSwitch } from "../../src/terminal-backend/setting.ts";

const now = () => "2026-10-06T00:00:00.000Z";

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
