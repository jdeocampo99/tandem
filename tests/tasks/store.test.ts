import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockCause,
  type InstructionChannels,
  type RepoPolicy,
  type ResolvedPolicy,
  type ReviewLevelRecord,
  type WorktreeLease,
} from "../../src/contracts.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { emptyRuntimeState } from "../../src/runtime/schema.ts";
import {
  FINAL_REVIEW_LENSES,
  finalAcceptanceStatus,
  policyIdentity,
} from "../../src/tasks/acceptance.ts";
import { ledgerBlockers } from "../../src/tasks/findings.ts";
import { type TaskTransitionContext, transitionTask } from "../../src/tasks/lifecycle.ts";
import {
  DEFAULT_REVIEW_LEVEL_POLICY,
  recordedReviewLevel,
  requiredReviewLenses,
} from "../../src/tasks/review-levels.ts";
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
      { name: "check", argv: ["bun", "run", "check"], surfaces: ["store"], timeoutMs: 10_000 },
    ],
    setupCommands: [],
    maxFixRounds: 1,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
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

/** Rewrites a stored record's payload in place, standing in for state written by an older build. */
function rewritePayload(
  directory: string,
  taskId: string,
  edit: (payload: Record<string, unknown>) => void,
): void {
  const database = new Database(join(directory, "state.sqlite"));
  const row = database.query("SELECT payload FROM tasks WHERE id = ?").get(taskId) as {
    payload: string;
  };
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  edit(payload);
  database.query("UPDATE tasks SET payload = ? WHERE id = ?").run(JSON.stringify(payload), taskId);
  database.close();
}

const LEGACY_EVIDENCE = {
  name: "check",
  argv: ["bun", "run", "check"],
  exitCode: 0,
  stdout: "56 tests passed",
  stderr: "",
  head: "legacy-head",
} as const;

test("loads validation evidence written before contracts existed and marks it legacy", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-evidence" });
    rewritePayload(directory, created.id, (payload) => {
      payload.stage = "reviewing";
      payload.reviewHead = LEGACY_EVIDENCE.head;
      payload.validationEvidence = [{ ...LEGACY_EVIDENCE }];
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("legacy task did not reload");
    expect(reloaded.validationEvidence[0]).toEqual({ ...LEGACY_EVIDENCE, contract: "legacy" });
    expect(finalAcceptanceStatus(reloaded, LEGACY_EVIDENCE.head).satisfied).toBe(false);
  });
});

test("keeps a completed record with legacy evidence readable", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-completed" });
    rewritePayload(directory, created.id, (payload) => {
      payload.stage = "completed";
      payload.reviewHead = LEGACY_EVIDENCE.head;
      payload.validationEvidence = [{ ...LEGACY_EVIDENCE }];
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("legacy task did not reload");
    expect(reloaded.stage).toBe("completed");
    expect(reloaded.validationEvidence).toHaveLength(1);
  });
});

const LEDGER_ENTRY = {
  id: "f-1",
  lens: "behavior",
  severity: "P1",
  verdict: "confirmed",
  description: "The retry loop drops the cancellation signal.",
  file: "src/service/controller.ts",
  line: 42,
  status: "unresolved",
  raisedAt: { head: "head-1", generation: 0, reviewRound: 0 },
  statusAt: { head: "head-1", generation: 0, reviewRound: 0 },
} as const;

test("loads a record written before the finding ledger existed with no prior finding status", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-ledger" });
    rewritePayload(directory, created.id, (payload) => {
      payload.stage = "reviewing";
      payload.reviewHead = "head-1";
      delete payload.findingLedger;
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("legacy task did not reload");
    expect(reloaded.findingLedger).toBeUndefined();
    expect(ledgerBlockers(reloaded.findingLedger ?? [])).toEqual([]);
  });
});

test("persists a typed block cause and round-trips it through the store", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "block-cause-round-trip" });
    const cause = blockCause("resource-lost", {
      summary: "The task's worktree is missing, so no further work can run against it.",
      detail: "task is implementing but its durable worktree is missing",
      jobId: "job-1",
    });
    await store.update(created.id, created.revision, (current) =>
      transitionTask(current, { type: "block", reason: cause.summary, cause }, transitionContext()),
    );

    const reloaded = await makeStore(directory, "reload").read(created.id);
    if (reloaded === undefined) throw new Error("task did not reload");
    expect(reloaded.blockCause).toEqual(cause);
    expect(reloaded.blockReason).toBe(cause.summary);
  });
});

test("loads a record written before the block cause existed with no cause", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-block-reason" });
    rewritePayload(directory, created.id, (payload) => {
      payload.stage = "blocked";
      payload.previousStage = "implementing";
      payload.blockReason = "worker timed out";
      delete payload.blockCause;
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("legacy task did not reload");
    expect(reloaded.blockReason).toBe("worker timed out");
    expect(reloaded.blockCause).toBeUndefined();
  });
});

test("persists manual verification and reloads it; a task created without it has none", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const manual = await store.create({
      ...input,
      id: "manual-verification",
      manualVerification: ["the learner sees the lesson in the browser"],
    });
    const plain = await store.create({ ...input, id: "no-manual-verification" });

    const reloaded = makeStore(directory, "reload");
    expect((await reloaded.read(manual.id))?.manualVerification).toEqual([
      "the learner sees the lesson in the browser",
    ]);
    const reloadedPlain = await reloaded.read(plain.id);
    if (reloadedPlain === undefined) throw new Error("task did not reload");
    expect("manualVerification" in reloadedPlain).toBe(false);
  });
});

test("reloads a recorded finding ledger unchanged", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "ledger-roundtrip" });
    rewritePayload(directory, created.id, (payload) => {
      payload.findingLedger = [{ ...LEDGER_ENTRY }];
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("ledger task did not reload");
    expect(reloaded.findingLedger).toEqual([LEDGER_ENTRY]);
  });
});

test("refuses a finding ledger entry with an unknown status", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "ledger-status" });
    rewritePayload(directory, created.id, (payload) => {
      payload.findingLedger = [{ ...LEDGER_ENTRY, status: "probably-fine" }];
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("refuses a finding ledger entry missing the change that supports its status", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "ledger-observation" });
    rewritePayload(directory, created.id, (payload) => {
      const { statusAt: _dropped, ...withoutStatusAt } = LEDGER_ENTRY;
      payload.findingLedger = [withoutStatusAt];
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("refuses a finding ledger that is not an array", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "ledger-shape" });
    rewritePayload(directory, created.id, (payload) => {
      payload.findingLedger = { "f-1": LEDGER_ENTRY };
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("refuses validation evidence that names only part of its contract identity", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "partial-evidence" });
    rewritePayload(directory, created.id, (payload) => {
      payload.validationEvidence = [{ ...LEGACY_EVIDENCE, contract: "final" }];
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("refuses legacy-marked validation evidence that also claims a policy identity", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "mixed-evidence" });
    rewritePayload(directory, created.id, (payload) => {
      payload.validationEvidence = [
        { ...LEGACY_EVIDENCE, contract: "legacy", origin: "local", policyDigest: "digest" },
      ];
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

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

const skill = {
  name: "refactor-functions",
  origin: "personal",
  directory: "/Users/me/.claude/skills/refactor-functions",
  instructions: "Apply the five function-review principles.",
} as const;

test("round-trips pinned skills and refuses a malformed one at creation", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const without = await store.create({ ...input, id: "without-skill" });
    const withSkill = await store.create({ ...input, id: "with-skill", skills: [skill] });
    expect(without.skills).toBeUndefined();
    expect((await store.read(without.id))?.skills).toBeUndefined();
    expect((await store.read(withSkill.id))?.skills).toEqual([skill]);

    const reloaded = makeStore(directory, "reloaded");
    expect((await reloaded.read(withSkill.id))?.skills).toEqual([skill]);

    await expect(
      store.create({ ...input, id: "invalid-skill", skills: [{ ...skill, name: "" }] }),
    ).rejects.toThrow(TypeError);
  });
});

test("fails closed on a persisted skill with an unexpected field or both skill fields", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "with-skill", skills: [skill] });
    rewritePayload(directory, created.id, (payload) => {
      payload.skills = [{ ...skill, scope: "everything" }];
    });
    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);

    const both = await store.create({ ...input, id: "both-skill-fields", skills: [skill] });
    rewritePayload(directory, both.id, (payload) => {
      payload.skill = { name: "refactor-functions", context: "Summary." };
    });
    await expect(store.read(both.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("reads the single skill an older task recorded as the coordinator's summary", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-skill" });
    rewritePayload(directory, created.id, (payload) => {
      payload.skill = { name: "refactor-functions", context: "Apply the principles." };
    });
    expect((await store.read(created.id))?.skills).toEqual([
      { name: "refactor-functions", origin: "summary", instructions: "Apply the principles." },
    ]);
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
          contract: "final",
          policyDigest: policyIdentity(input.policy),
          evidence: [
            {
              name: "check",
              argv: ["bun", "run", "check"],
              exitCode: 1,
              stdout: "",
              stderr: "failure",
              head: "head-1",
              contract: "final",
              origin: "local",
              policyDigest: policyIdentity(input.policy),
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

const scoutInput: StoreTaskInput = {
  repoPath: "/repo",
  kind: "scout",
  objective: "Research the reported defect",
  acceptanceCriteria: ["The findings are durable"],
  surfaces: ["store"],
  policy,
};

test("persists an explicit scout disposition across restart and later transitions", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory, "continuation");
    const created = await store.create({
      ...scoutInput,
      id: "explicit-scout",
      researchContinuation: {
        schemaVersion: 1,
        disposition: "implementation-interview",
        selectedBy: "jev",
        classifierVersion: "jev-continuation-1",
      },
    });
    expect(created.researchContinuation?.disposition).toBe("implementation-interview");

    const transitioned = await store.update(created.id, created.revision, (task) =>
      transitionTask(
        task,
        {
          type: "start",
          worktree,
          endpoints: [
            {
              sessionId: "session-1",
              workspaceId: "workspace-1",
              tabId: "tab-1",
              paneId: "pane-1",
              role: "scout",
              generation: task.generation,
            },
          ],
        },
        transitionContext("scout-start"),
      ),
    );
    expect(transitioned.researchContinuation?.classifierVersion).toBe("jev-continuation-1");

    const reloaded = await makeStore(directory, "continuation-reload").read(created.id);
    expect(reloaded?.researchContinuation).toEqual(created.researchContinuation);
  });
});

test("loads scout records written without a disposition using the conservative default", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory, "legacy");
    const created = await store.create({ ...scoutInput, id: "legacy-scout" });
    rewritePayload(directory, created.id, (payload) => {
      delete payload.researchContinuation;
    });

    const reloaded = await makeStore(directory, "legacy-reload").read(created.id);
    expect(reloaded?.researchContinuation).toEqual({
      schemaVersion: 1,
      disposition: "ask-intent",
      selectedBy: "deterministic",
    });
    expect(reloaded?.scopeApproved).toBe(true);
    expect(reloaded?.stage).toBe("queued");
  });
});

test("upgrades a scout row that has old-shape evidence and no continuation together", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory, "legacy-both");
    const created = await store.create({ ...scoutInput, id: "legacy-both-scout" });
    rewritePayload(directory, created.id, (payload) => {
      delete payload.researchContinuation;
      payload.reviewHead = LEGACY_EVIDENCE.head;
      payload.validationEvidence = [{ ...LEGACY_EVIDENCE }];
    });

    const reloaded = await makeStore(directory, "legacy-both-reload").read(created.id);
    expect(reloaded?.researchContinuation).toEqual({
      schemaVersion: 1,
      disposition: "ask-intent",
      selectedBy: "deterministic",
    });
    expect(reloaded?.validationEvidence).toEqual([{ ...LEGACY_EVIDENCE, contract: "legacy" }]);
    expect(reloaded?.scopeApproved).toBe(true);
  });
});

test("fails closed on invalid dispositions, malformed provenance, and non-scout records", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory, "invalid");
    const scout = await store.create({ ...scoutInput, id: "invalid-scout" });
    rewritePayload(directory, scout.id, (payload) => {
      payload.researchContinuation = {
        schemaVersion: 1,
        disposition: "implement-now",
        selectedBy: "deterministic",
      };
    });
    await expect(store.read(scout.id)).rejects.toBeInstanceOf(StateCorruptionError);

    rewritePayload(directory, scout.id, (payload) => {
      payload.researchContinuation = {
        schemaVersion: 1,
        disposition: "implementation-interview",
        selectedBy: "jev",
      };
    });
    await expect(store.read(scout.id)).rejects.toBeInstanceOf(StateCorruptionError);

    const implementation = await store.create({ ...input, id: "invalid-implementation" });
    rewritePayload(directory, implementation.id, (payload) => {
      payload.researchContinuation = {
        schemaVersion: 1,
        disposition: "implementation-interview",
        selectedBy: "explicit",
      };
    });
    await expect(store.read(implementation.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("a record written before review levels existed loads at the conservative default", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-review-level" });
    rewritePayload(directory, created.id, (payload) => {
      const policyValue = payload.policy as Record<string, Record<string, unknown>>;
      delete policyValue.config?.reviewLevels;
      delete payload.reviewLevel;
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("the upgraded record did not reload");
    expect(reloaded.reviewLevel).toBeUndefined();
    expect(recordedReviewLevel(reloaded).level).toBe("standard");
    expect(reloaded.policy.config.reviewLevels).toEqual(DEFAULT_REVIEW_LEVEL_POLICY);
    expect(requiredReviewLenses(reloaded, "any-head")).toEqual(FINAL_REVIEW_LENSES);
  });
});

test("a record written while standing request budgets still existed loads, ignoring the stored cap", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-request-budget" });
    rewritePayload(directory, created.id, (payload) => {
      const policyValue = payload.policy as Record<string, Record<string, unknown>>;
      policyValue.config = {
        ...policyValue.config,
        requestBudget: { capMicros: 10_000_000, operationEstimateMicros: 500_000 },
      };
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("the upgraded record did not reload");
    expect(reloaded.policy.config).not.toHaveProperty("requestBudget");
  });
});

test("a record pinned while the worker limit existed keeps its policy digest across reloads and updates", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-max-workers" });
    let pinnedDigest = "";
    rewritePayload(directory, created.id, (payload) => {
      const policyValue = payload.policy as Record<string, Record<string, unknown>>;
      // Where the worker limit sat when it was pinned: after setupCommands, before maxFixRounds.
      const { maxFixRounds, reviewLevels, ...before } = policyValue.config ?? {};
      policyValue.config = { ...before, maxWorkers: 3, maxFixRounds, reviewLevels };
      pinnedDigest = createHash("sha256").update(JSON.stringify(policyValue)).digest("hex");
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("the legacy record did not reload");
    expect(policyIdentity(reloaded.policy)).toBe(pinnedDigest);
    await store.update(created.id, reloaded.revision, (task) =>
      transitionTask(task, { type: "approve" }, transitionContext()),
    );
    const updated = await store.read(created.id);
    if (updated === undefined) throw new Error("the updated record did not reload");
    expect(policyIdentity(updated.policy)).toBe(pinnedDigest);
  });
});

test("a record written before setup commands existed loads with none", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "legacy-setup-commands" });
    rewritePayload(directory, created.id, (payload) => {
      const policyValue = payload.policy as Record<string, Record<string, unknown>>;
      delete policyValue.config?.setupCommands;
    });

    const reloaded = await store.read(created.id);
    if (reloaded === undefined) throw new Error("the upgraded record did not reload");
    expect(reloaded.policy.config.setupCommands).toEqual([]);
  });
});

test("a recorded review level round-trips with its reason, floors, and shadow assistance", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "review-level-roundtrip" });
    const record: ReviewLevelRecord = {
      level: "deep",
      reason: "the permissions and security floor fired",
      floors: ["permissions-security"],
      assistance: {
        mode: "shadow",
        recommendation: "light",
        reason: "the helper recommended light at confidence 0.990",
        requestIdentity: "request-1",
        resultIdentity: "result-1",
      },
    };
    rewritePayload(directory, created.id, (payload) => {
      payload.reviewLevel = record;
    });

    expect((await store.read(created.id))?.reviewLevel).toEqual(record);
  });
});

test("refuses a review level that names an unsupported level", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "review-level-unknown" });
    rewritePayload(directory, created.id, (payload) => {
      payload.reviewLevel = { level: "skim", reason: "fast", floors: [] };
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("refuses a review level that names an unsupported safety floor", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "review-level-floor" });
    rewritePayload(directory, created.id, (payload) => {
      payload.reviewLevel = { level: "deep", reason: "broad", floors: ["vibes"] };
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("refuses a review level missing its recorded reason", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "review-level-reason" });
    rewritePayload(directory, created.id, (payload) => {
      payload.reviewLevel = { level: "standard", floors: [] };
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
  });
});

test("refuses a pinned review-level policy with an unsupported assistance mode", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, id: "review-policy-mode" });
    rewritePayload(directory, created.id, (payload) => {
      const policyValue = payload.policy as Record<string, Record<string, unknown>>;
      policyValue.config = {
        ...policyValue.config,
        reviewLevels: {
          deepScrutiny: false,
          jevAssistance: "active",
          sourceTransmission: false,
        },
      };
    });

    await expect(store.read(created.id)).rejects.toBeInstanceOf(StateCorruptionError);
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

test("the request brief a task was created under survives the authoritative round trip", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = makeStore(directory);
    const created = await store.create({ ...input, requestId: "req-1" });

    expect(created.requestId).toBe("req-1");
    expect((await makeStore(directory).read(created.id))?.requestId).toBe("req-1");
    await expect(store.create({ ...input, requestId: "task-1" })).rejects.toThrow(
      /Unsafe request id/u,
    );
  });
});
