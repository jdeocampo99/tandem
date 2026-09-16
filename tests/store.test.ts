import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InstructionChannels,
  RepoPolicy,
  ResolvedPolicy,
  WorktreeLease,
} from "../src/contracts.ts";
import { type TaskTransitionContext, transitionTask } from "../src/lifecycle.ts";
import {
  createTaskStore,
  StaleTaskRevisionError,
  StateCorruptionError,
  StoreLockTimeoutError,
  type StoreTaskInput,
  type TaskStore,
  UnsafeTaskIdError,
} from "../src/store.ts";

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
    const taskStat = await stat(join(directory, `${created.id}.json`));
    expect(taskStat.mode & 0o777).toBe(0o600);
    const directoryStat = await stat(directory);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    const lockStat = await stat(join(directory, ".lock"));
    expect(lockStat.mode & 0o777).toBe(0o600);
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

test("rejects corrupt JSON, schema mismatch, and traversal IDs instead of skipping state", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    await store.list();
    await writeFile(join(directory, "broken.json"), "{not-json", "utf8");
    await expect(store.list()).rejects.toBeInstanceOf(StateCorruptionError);

    await unlink(join(directory, "broken.json"));
    await writeFile(join(directory, "schema.json"), JSON.stringify({ schemaVersion: 99 }), "utf8");
    await expect(store.read("schema")).rejects.toBeInstanceOf(StateCorruptionError);
    await expect(store.read("../outside")).rejects.toBeInstanceOf(UnsafeTaskIdError);
    await expect(store.create({ ...input, id: "../outside" })).rejects.toBeInstanceOf(
      UnsafeTaskIdError,
    );
  });
});

test("rejects unsafe persisted revisions before they can participate in CAS", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "unsafe-revision" });
    const path = join(directory, `${created.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    persisted.revision = Number.MAX_SAFE_INTEGER + 1;
    await writeFile(path, JSON.stringify(persisted), "utf8");

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
    const files = await readdir(directory);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });
});

test("recovers from stale temporary files without overwriting their contents", async () => {
  await withTemporaryDirectory(async (directory) => {
    const leftoverPath = join(directory, `.task-${process.pid}-1.tmp`);
    await writeFile(leftoverPath, "crash-leftover", "utf8");

    const store = makeStore(directory);
    const recovered = await store.create({ ...input, id: "recovered-task" });

    expect(recovered.id).toBe("recovered-task");
    expect(await readFile(leftoverPath, "utf8")).toBe("crash-leftover");
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
    const lockPath = join(directory, ".lock");
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
