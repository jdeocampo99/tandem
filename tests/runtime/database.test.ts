import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentStateDatabase,
  databasePath,
  insertRequestUsagePayload,
  insertTaskEventPayload,
  insertTaskUsagePayload,
  readAllRequestBriefPayloads,
  readAllTaskPayloads,
  readMetadataPayload,
  readPrWatchPayloads,
  readRepoLocation,
  readRequestBriefPayload,
  readRequestUsagePayloads,
  readRuntimePayload,
  readTaskEventPayloads,
  readTaskPayload,
  readTaskUsagePayloads,
  runtimeStateWasInitialized,
  type StateDatabase,
  withStateLock,
  withStateTransaction,
  writeMetadataPayload,
  writePrWatchPayload,
  writeRepoLocation,
  writeRequestBriefPayload,
  writeRuntimePayload,
  writeTaskPayload,
} from "../../src/runtime/database.ts";
import { readRuntimeState } from "../../src/runtime/persistence.ts";

async function withHome(operation: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tandem-database-"));
  try {
    await operation(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("database payload readers leave domain validation to their callers", async () => {
  await withHome(async (home) => {
    await withStateTransaction(home, (db) => {
      expect(readTaskPayload(db, "missing")).toBeUndefined();
      expect(readRequestBriefPayload(db, "missing")).toBeUndefined();
      expect(readRuntimePayload(db)).toBeUndefined();
      expect(readMetadataPayload(db, "missing")).toBeUndefined();
      expect(runtimeStateWasInitialized(db)).toBe(false);
      writeTaskPayload(db, "b", 0, []);
      writeTaskPayload(db, "a", 0, {});
      writeRequestBriefPayload(db, "b", 0, null);
      writeRequestBriefPayload(db, "a", 0, false);
      writePrWatchPayload(db, "b", []);
      writePrWatchPayload(db, "a", {});
      writeRuntimePayload(db, {});
      writeMetadataPayload(db, "pr_watch_poll", []);
      expect(readTaskPayload(db, "a")).toEqual({});
      expect(readAllTaskPayloads(db)).toEqual([{}, []]);
      expect(readRequestBriefPayload(db, "a")).toBe(false);
      expect(readAllRequestBriefPayloads(db)).toEqual([false, null]);
      expect(readPrWatchPayloads(db)).toEqual([{}, []]);
      expect(readRuntimePayload(db)).toEqual({});
      expect(readMetadataPayload(db, "pr_watch_poll")).toEqual([]);
      expect(runtimeStateWasInitialized(db)).toBe(true);
    });
    const path = join(home, "runtime.json");
    await expect(readRuntimeState(path)).rejects.toThrow(
      new Error(`runtime state at ${path} is invalid: ${path}.schemaVersion must be 1`),
    );
  });
});

const strictPayloadReaders = [
  { table: "tasks", read: readAllTaskPayloads, message: "task payload is not text" },
  {
    table: "request_briefs",
    read: readAllRequestBriefPayloads,
    message: "request brief payload is not text",
  },
  { table: "pr_watches", read: readPrWatchPayloads, message: "PR watch payload is not text" },
];

test.each(strictPayloadReaders)(
  "$table readers preserve non-text errors and JSON syntax errors",
  async ({ table, read, message }) => {
    await withHome(async (home) => {
      await withStateTransaction(home, (db) => {
        writeTaskPayload(db, "row", 0, {});
        writeRequestBriefPayload(db, "row", 0, {});
        writePrWatchPayload(db, "row", {});
        db.query(`UPDATE ${table} SET payload = ?`).run(new Uint8Array([1]));
        expect(() => read(db)).toThrow(new Error(message));
        if (table === "tasks") expect(readTaskPayload(db, "row")).toBeUndefined();
        if (table === "request_briefs") {
          expect(readRequestBriefPayload(db, "row")).toBeUndefined();
        }
        db.query(`UPDATE ${table} SET payload = ?`).run("{invalid");
        expect(() => read(db)).toThrow(SyntaxError);
        if (table === "tasks") expect(() => readTaskPayload(db, "row")).toThrow(SyntaxError);
        if (table === "request_briefs") {
          expect(() => readRequestBriefPayload(db, "row")).toThrow(SyntaxError);
        }
      });
    });
  },
);

test("runtime payload corruption keeps its error message and syntax-error cause", async () => {
  await withHome(async (home) => {
    await withStateTransaction(home, (db) => {
      writeRuntimePayload(db, {});
      db.query("UPDATE runtime_state SET payload = ?").run(new Uint8Array([1]));
      expect(() => readRuntimePayload(db)).toThrow(new Error("runtime payload is not text"));
      db.query("UPDATE runtime_state SET payload = ?").run("{invalid");
      expect(() => readRuntimePayload(db)).toThrow(new Error("runtime payload is invalid JSON"));
      try {
        readRuntimePayload(db);
        throw new Error("expected invalid runtime JSON to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        expect(error.constructor).toBe(Error);
        expect(error.cause).toBeInstanceOf(SyntaxError);
      }
    });
  });
});

const usageReaders = [
  {
    table: "request_usage_events",
    insert: insertRequestUsagePayload,
    read: readRequestUsagePayloads,
  },
  { table: "task_usage_events", insert: insertTaskUsagePayload, read: readTaskUsagePayloads },
];

test.each(usageReaders)(
  "$table readers preserve replay detection, ordering and corrupt-row tolerance",
  async ({ table, insert, read }) => {
    await withHome(async (home) => {
      await withStateTransaction(home, (db) => {
        const entry = { requestId: "owner", taskId: "owner", recordedAt: "2030-01-01" };
        expect(insert(db, { ...entry, eventKey: "z", payload: [] })).toBe(true);
        expect(insert(db, { ...entry, eventKey: "a", payload: {} })).toBe(true);
        expect(insert(db, { ...entry, eventKey: "z", payload: "replacement" })).toBe(false);
        expect(
          insert(db, { ...entry, recordedAt: "2029-01-01", eventKey: "b", payload: false }),
        ).toBe(true);
        expect(read(db, "owner")).toEqual([false, {}, []]);
        expect(read(db, "missing")).toEqual([]);
        db.query(`UPDATE ${table} SET payload = ? WHERE event_key = 'a'`).run("{invalid");
        db.query(`UPDATE ${table} SET payload = ? WHERE event_key = 'z'`).run(new Uint8Array([1]));
        expect(read(db, "owner")).toEqual([false, null, null]);
      });
    });
  },
);

test("task event readers retain append order and corrupt rows with their sequence", async () => {
  await withHome(async (home) => {
    await withStateTransaction(home, (db) => {
      const entry = { taskId: "task", at: "2030-01-01", type: "event" };
      insertTaskEventPayload(db, { ...entry, payload: {} });
      insertTaskEventPayload(db, { ...entry, taskId: "other", payload: "other" });
      insertTaskEventPayload(db, { ...entry, payload: [] });
      insertTaskEventPayload(db, { ...entry, payload: false });
      expect(readTaskEventPayloads(db, "task")).toEqual([
        { seq: 1, payload: {} },
        { seq: 3, payload: [] },
        { seq: 4, payload: false },
      ]);
      expect(readTaskEventPayloads(db, "missing")).toEqual([]);
      db.query("UPDATE task_events SET payload = ? WHERE seq = 3").run("{invalid");
      db.query("UPDATE task_events SET payload = ? WHERE seq = 4").run(new Uint8Array([1]));
      expect(readTaskEventPayloads(db, "task")).toEqual([
        { seq: 1, payload: {} },
        { seq: 3, payload: null },
        { seq: 4, payload: null },
      ]);
    });
  });
});

test("location and metadata readers preserve missing and non-text values", async () => {
  await withHome(async (home) => {
    await withStateTransaction(home, (db) => {
      expect(readRepoLocation(db, "repo")).toBeUndefined();
      writeRepoLocation(db, { repo: "repo", path: "", lastUsedAt: "2030-01-01" });
      expect(readRepoLocation(db, "repo")).toBe("");
      db.query("UPDATE repo_locations SET path = ?").run(new Uint8Array([1]));
      expect(readRepoLocation(db, "repo")).toBeUndefined();
      writeMetadataPayload(db, "poll", null);
      expect(readMetadataPayload(db, "poll")).toBeNull();
      db.query("UPDATE metadata SET value = ? WHERE key = 'poll'").run(new Uint8Array([1]));
      expect(readMetadataPayload(db, "poll")).toBeUndefined();
      db.query("UPDATE metadata SET value = ? WHERE key = 'poll'").run("{invalid");
      expect(() => readMetadataPayload(db, "poll")).toThrow(SyntaxError);
    });
  });
});

test("nested transactions share the database and commit after the outer callback", async () => {
  await withHome(async (home) => {
    expect(currentStateDatabase(home)).toBeUndefined();
    let opened: StateDatabase | undefined;
    const result = await withStateLock(home, () =>
      withStateTransaction(home, async (db) => {
        opened = db;
        expect(db.inTransaction).toBe(true);
        expect(currentStateDatabase(join(home, "."))).toBe(db);
        writeTaskPayload(db, "outer", 0, {});
        await withStateTransaction(home, (nested) => {
          expect(nested).toBe(db);
          writeTaskPayload(nested, "inner", 0, []);
        });
        expect(db.inTransaction).toBe(true);
        return "committed";
      }),
    );
    expect(result).toBe("committed");
    expect(currentStateDatabase(home)).toBeUndefined();
    expect(() => opened?.query("SELECT 1").get()).toThrow();
    await withStateTransaction(home, (db) => expect(readAllTaskPayloads(db)).toEqual([[], {}]));
  });
});

test("caught nested failures roll back all writes and release the state lock", async () => {
  await withHome(async (home) => {
    const failure = new TypeError("nested failure");
    await expect(
      withStateTransaction(home, async (db) => {
        writeTaskPayload(db, "outer", 0, {});
        await expect(
          withStateTransaction(home, (nested) => {
            writeTaskPayload(nested, "inner", 0, []);
            throw failure;
          }),
        ).rejects.toBe(failure);
      }),
    ).rejects.toThrow(new Error("state transaction marked rollback-only by a nested failure"));
    await withStateTransaction(home, (db) => expect(readAllTaskPayloads(db)).toEqual([]));
    await expect(
      withStateTransaction(home, (db) => {
        writeTaskPayload(db, "failed", 0, {});
        throw failure;
      }),
    ).rejects.toBe(failure);
    await withStateTransaction(home, (db) => expect(readAllTaskPayloads(db)).toEqual([]));
  });
});

test("nested home mismatches preserve their errors without poisoning the owning transaction", async () => {
  await withHome(async (home) => {
    const other = join(home, "other");
    const transactionError = new Error(
      `nested state transaction home mismatch: ${home} versus ${other}`,
    );
    await withStateTransaction(home, async (db) => {
      await expect(withStateTransaction(other, () => undefined)).rejects.toThrow(transactionError);
      expect(() => currentStateDatabase(other)).toThrow(transactionError);
      await expect(withStateLock(other, () => undefined)).rejects.toThrow(
        new Error(`nested state lock home mismatch: ${home} versus ${other}`),
      );
      writeTaskPayload(db, "committed", 0, {});
    });
    await withStateTransaction(home, (db) => expect(readTaskPayload(db, "committed")).toEqual({}));
  });
});

test.each([
  { sql: "DROP TABLE tasks", message: "authoritative state database is missing required tables" },
  {
    sql: "UPDATE metadata SET value = '2' WHERE key = 'schema_version'",
    message: "authoritative state database has no valid initialization marker",
  },
])("opening a corrupt database preserves the wrapped error: $message", async ({ sql, message }) => {
  await withHome(async (home) => {
    await withStateTransaction(home, (db) => db.exec(sql));
    try {
      await withStateTransaction(home, () => {
        throw new Error("corrupt database must not run the callback");
      });
      throw new Error("expected corrupt database to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.constructor).toBe(Error);
      expect(error.message).toBe(
        `could not open authoritative state database ${databasePath(home)}`,
      );
      expect(error.cause).toEqual(new Error(message));
    }
  });
});
