import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InstructionChannels,
  RepoPolicy,
  ResolvedPolicy,
  WorktreeLease,
} from "../../src/contracts.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { emptyRuntimeState } from "../../src/runtime/schema.ts";
import { type TaskTransitionContext, transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore, type StoreTaskInput, type TaskStore } from "../../src/tasks/store.ts";
import {
  StaleTaskRevisionError,
  StateCorruptionError,
  StoreLockTimeoutError,
  UnsafeTaskIdError,
} from "../../src/tasks/store-errors.ts";

const models: RepoPolicy["models"] = {
  coordinator: { model: "coordinator-model", thinking: "high" },
  scout: { model: "scout-model", thinking: "medium" },
  implementer: { model: "implementer-model", thinking: "max" },
  reviewer: { model: "reviewer-model", thinking: "max" },
  verifier: { model: "verifier-model", thinking: "high" },
  presentation: { model: "presentation-model", thinking: "low" },
};
const channels: InstructionChannels = { implementation: [], validation: [], review: [] };
const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models,
    instructions: channels,
    instructionFiles: channels,
    validationCommands: [
      { name: "check", argv: ["bun", "run", "check"], surfaces: ["source"], timeoutMs: 10_000 },
    ],
    maxWorkers: 3,
    maxFixRounds: 1,
  },
  guidance: { implementation: [], validation: [], review: [] },
};

const input: StoreTaskInput = {
  repoPath: "/repo",
  kind: "implementation",
  objective: "Persist this task",
  acceptanceCriteria: ["The state reloads"],
  surfaces: ["store"],
  policy,
};
const researchHandoff = {
  scoutTaskId: "scout-1",
  scoutRepoPath: "/repo",
  scoutSourceHead: "source-head",
  scoutSourceBase: "source-head",
  reportPath: "/home/jobs/scout-1/0/job-1/report.txt",
  reportDigest: "a".repeat(64),
  excerpt: "Verified scout evidence.",
} as const;

const worktree: WorktreeLease = {
  root: "/worktrees",
  path: "/worktrees/store-task",
  name: "store-task",
  baseHead: "base-head",
  branch: "tandem/store-task",
  leaseId: "lease-1",
  leaseHolder: "worker-1",
  leasedAt: "2026-09-15T00:00:00.000Z",
};

let timestampSequence = 0;
function clock(): string {
  timestampSequence += 1;
  return `2026-09-15T00:01:${String(timestampSequence).padStart(2, "0")}.000Z`;
}

function transitionContext(
  notificationId = `store-notification-${timestampSequence + 1}`,
): TaskTransitionContext {
  return { now: clock(), notificationId };
}

function factory(prefix: string): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };
}

function makeStore(directory: string, prefix = "task"): TaskStore {
  return createTaskStore({
    directory,
    clock,
    idFactory: factory(prefix),
    lockTimeoutMs: 2_000,
    lockPollMs: 5,
  });
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tandem-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("persists records with restrictive modes and reloads through a new store instance", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create(input);
    expect(created.id).toBe("task-1");
    expect(await store.read(created.id)).toEqual(created);

    const reloaded = makeStore(directory, "other");
    expect(await reloaded.list()).toEqual([created]);
    const databaseStat = await stat(join(directory, "state.sqlite"));
    expect(databaseStat.mode & 0o777).toBe(0o600);
    const directoryStat = await stat(directory);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    const lockStat = await stat(join(directory, ".state.lock"));
    expect(lockStat.mode & 0o777).toBe(0o600);
  });
});
test("round-trips handoff snapshots and rejects oversized persisted excerpts", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const without = await store.create({ ...input, id: "without-handoff" });
    const withHandoff = await store.create({
      ...input,
      id: "with-handoff",
      researchHandoffs: [researchHandoff],
    });
    expect(without.researchHandoffs).toBeUndefined();
    expect((await store.read(without.id))?.researchHandoffs).toBeUndefined();
    expect((await store.read(withHandoff.id))?.researchHandoffs).toEqual([researchHandoff]);

    const oversized = await store.create({
      ...input,
      id: "oversized-handoff",
      researchHandoffs: [{ ...researchHandoff, excerpt: "x".repeat(4 * 1024 + 1) }],
    });
    await expect(store.read(oversized.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("serializes CAS updates and rejects stale concurrent writers", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "cas-task" });
    const first = store.update(created.id, created.revision, (task) =>
      transitionTask(task, { type: "approve" }, transitionContext()),
    );
    const second = store.update(created.id, created.revision, (task) =>
      transitionTask(task, { type: "approve" }, transitionContext()),
    );
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      StaleTaskRevisionError,
    );
    const current = await store.read(created.id);
    expect(current?.revision).toBe(created.revision + 1);
    expect(current?.stage).toBe("queued");
  });
});

test("serializes simultaneous first acquisitions through the persistent lock inode", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = makeStore(directory, "first");
    const second = makeStore(directory, "second");
    const [createdFirst, createdSecond] = await Promise.all([
      first.create({ ...input, id: "parallel-first" }),
      second.create({ ...input, id: "parallel-second" }),
    ]);

    expect([createdFirst.id, createdSecond.id].sort()).toEqual([
      "parallel-first",
      "parallel-second",
    ]);
    expect((await first.list()).map((task) => task.id)).toEqual([
      "parallel-first",
      "parallel-second",
    ]);
  });
});

test("supports one repository transaction without nested lock acquisition", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.exclusive(async (transaction) => {
      const task = await transaction.create({ ...input, id: "transaction-task" });
      const readBack = await transaction.read(task.id);
      expect(readBack?.revision).toBe(task.revision);
      return task;
    });
    expect(created.id).toBe("transaction-task");
    expect((await store.list()).map((task) => task.id)).toEqual(["transaction-task"]);
  });
});

test("rolls back task and runtime writes together when an exclusive callback throws", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "rollback-task" });
    const path = runtimeFile(directory);
    await writeRuntimeState(path, emptyRuntimeState());
    await expect(
      store.exclusive(async (transaction) => {
        await transaction.update(created.id, created.revision, (task) =>
          transitionTask(task, { type: "approve" }, transitionContext()),
        );
        await writeRuntimeState(path, {
          ...emptyRuntimeState(),
          presentations: [],
        });
        throw new Error("abort durable transition");
      }),
    ).rejects.toThrow("abort durable transition");
    expect(await store.read(created.id)).toEqual(created);
    expect(await readRuntimeState(path)).toEqual(emptyRuntimeState());
  });
});

test("caught nested exclusive failures mark the owning transaction rollback-only", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "nested-rollback-task" });
    await expect(
      store.exclusive(async (outer) => {
        try {
          await store.exclusive(async (inner) => {
            await inner.update(created.id, created.revision, (task) =>
              transitionTask(task, { type: "approve" }, transitionContext()),
            );
            throw new Error("nested failure");
          });
        } catch (error) {
          expect(error).toEqual(new Error("nested failure"));
        }
        expect(await outer.read(created.id)).toMatchObject({ revision: created.revision + 1 });
      }),
    ).rejects.toThrow("rollback-only");
    expect(await store.read(created.id)).toEqual(created);
  });
});

test("rejects missing SQLite tables and traversal IDs instead of skipping state", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    await store.list();
    expect(await store.read("../outside").catch((error) => error)).toBeInstanceOf(
      UnsafeTaskIdError,
    );
    await expect(store.create({ ...input, id: "../outside" })).rejects.toBeInstanceOf(
      UnsafeTaskIdError,
    );
    const database = new Database(join(directory, "state.sqlite"));
    database.exec("DROP TABLE tasks");
    database.close();
    await expect(store.list()).rejects.toThrow("authoritative state database");
  });
});

test("rejects unsafe persisted revisions before they can participate in CAS", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "unsafe-revision" });
    const database = new Database(join(directory, "state.sqlite"));
    const row = database.query("SELECT payload FROM tasks WHERE id = ?").get(created.id) as {
      payload: string;
    };
    const persisted = JSON.parse(row.payload) as Record<string, unknown>;
    persisted.revision = Number.MAX_SAFE_INTEGER + 1;
    database
      .query("UPDATE tasks SET revision = ?, payload = ? WHERE id = ?")
      .run(Number.MAX_SAFE_INTEGER + 1, JSON.stringify(persisted), created.id);
    database.close();

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
    await expect(store.update(created.id, created.revision, (task) => task)).rejects.toBeInstanceOf(
      StateCorruptionError,
    );
    await expect(
      store.update(created.id, Number.MAX_SAFE_INTEGER + 1, (task) => task),
    ).rejects.toMatchObject({ code: "invalid-mutation" });
  });
});

test("preserves the previous record when a transform cannot produce a valid state", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "preserve-task" });
    await expect(
      store.update(created.id, created.revision, (task) => ({
        ...task,
        revision: task.revision + 1,
        objective: "",
      })),
    ).rejects.toBeInstanceOf(StateCorruptionError);
    expect(await store.read(created.id)).toEqual(created);
    expect(await Bun.file(join(directory, `${created.id}.json`)).exists()).toBe(false);
  });
});

test("preserves live lock leases and reacquires after the owner incarnation releases", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const blockedStore = createTaskStore({
      directory,
      clock,
      idFactory: factory("blocked"),
      lockTimeoutMs: 25,
      lockPollMs: 5,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = store.exclusive(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const lockPath = join(directory, ".state.lock");
    const liveLock = await stat(lockPath);
    await expect(blockedStore.list()).rejects.toBeInstanceOf(StoreLockTimeoutError);
    release.resolve();
    await held;
    const recovered = await blockedStore.create({ ...input, id: "recovered-task" });
    expect(recovered.id).toBe("recovered-task");
    expect((await stat(lockPath)).ino).toBe(liveLock.ino);
  });
});

test("persists notification state before acknowledgement is observable after reload", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    let task = await store.create({ ...input, id: "notification-task" });
    task = await store.update(task.id, task.revision, (current) =>
      transitionTask(current, { type: "approve" }, transitionContext()),
    );
    task = await store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        {
          type: "start",
          worktree,
          endpoints: [
            {
              sessionId: "s",
              workspaceId: "w",
              tabId: "t",
              paneId: "p",
              role: "implementer",
              generation: 0,
            },
          ],
        },
        transitionContext(),
      ),
    );
    task = await store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        { type: "implementation-complete", head: "head-1", generation: 0 },
        transitionContext(),
      ),
    );
    task = await store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        {
          type: "validation-failed",
          head: "head-1",
          generation: 0,
          evidence: [
            {
              name: "check",
              argv: ["bun", "run", "check"],
              exitCode: 1,
              stdout: "",
              stderr: "failure",
              head: "head-1",
            },
          ],
        },
        transitionContext("validation-failed"),
      ),
    );
    const notificationId = task.notifications[0]?.id;
    expect(notificationId).toBe("validation-failed");
    task = await store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        { type: "acknowledge-notification", notificationId: notificationId ?? "missing" },
        transitionContext(),
      ),
    );
    const reloaded = await makeStore(directory, "reload").read(task.id);
    expect(reloaded?.notifications[0]?.acknowledged).toBe(true);
    expect(reloaded?.revision).toBe(task.revision);
  });
});

test("loads records written before cleanup notes existed and rejects malformed ones", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "cleanup-upgrade" });
    expect(created.cleanup).toBeUndefined();

    const readPayload = (): Record<string, unknown> => {
      const database = new Database(join(directory, "state.sqlite"));
      const row = database.query("SELECT payload FROM tasks WHERE id = ?").get(created.id) as {
        payload: string;
      };
      database.close();
      return JSON.parse(row.payload) as Record<string, unknown>;
    };
    const writePayload = (payload: Record<string, unknown>): void => {
      const database = new Database(join(directory, "state.sqlite"));
      database
        .query("UPDATE tasks SET payload = ? WHERE id = ?")
        .run(JSON.stringify(payload), created.id);
      database.close();
    };

    const legacy = readPayload();
    expect(Object.hasOwn(legacy, "cleanup")).toBe(false);
    expect(await store.read(created.id)).toEqual(created);

    writePayload({
      ...legacy,
      cleanup: {
        schemaVersion: 1,
        status: "quarantined",
        reason: "pane ownership could not be proven",
        observedAt: "2030-01-01T00:00:00.000Z",
      },
    });
    const upgraded = await store.read(created.id);
    expect(upgraded?.cleanup?.status).toBe("quarantined");
    expect(upgraded?.cleanup?.reason).toBe("pane ownership could not be proven");

    writePayload({ ...legacy, cleanup: { schemaVersion: 1, status: "sort-of-done" } });
    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);

    writePayload({ ...legacy, cleanup: "released" });
    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});
