import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TaskRecord } from "../contracts.ts";
import { parseTaskRecord } from "../tasks/store-codec.ts";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
import { appendDiagnosticEvent } from "./diagnostics.ts";
import { parseRuntimeState, type RuntimeState } from "./schema.ts";

export type MigrationStatus = "absent" | "pending" | "complete" | "failed";

export type DatabaseInspection = Readonly<{
  path: string;
  exists: boolean;
  initialized: boolean;
  migrationStatus: MigrationStatus;
  legacyRuntimePath: string;
  legacyTaskDirectory: string;
  legacyTaskCount: number;
}>;
export type LegacyImportManifest = Readonly<{
  schemaVersion?: number;
  id: string;
  home?: string;
  createdAt?: string;
  phase?: "prepared" | "archived" | "imported" | "fenced" | "complete";
  sources?: readonly Readonly<{ path: string; sha256: string; bytes: number }>[];
  archivePath?: string;
  sourceHash?: string;
}>;

export type LegacyStateImport = Readonly<{
  tasks: readonly TaskRecord[];
  runtime: RuntimeState;
  manifest?: LegacyImportManifest;
}>;

type StateDatabase = Database;
type DatabaseContext = { home: string; db: StateDatabase; rollbackOnly: boolean };
const databaseContext = new AsyncLocalStorage<DatabaseContext>();

export function databasePath(home: string): string {
  const root = resolve(home);
  return join(root, "state.sqlite");
}

type NativeLockContext = Readonly<{ home: string; release: () => Promise<void> }>;
const nativeLockContext = new AsyncLocalStorage<NativeLockContext>();

function normalizedHome(home: string): string {
  return resolve(home);
}

function legacyRuntimePath(home: string): string {
  return join(normalizedHome(home), "runtime.json");
}

function legacyTaskDirectory(home: string): string {
  return join(normalizedHome(home), "tasks");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function legacyTaskCount(home: string): Promise<number> {
  try {
    const entries = await readdir(legacyTaskDirectory(home), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function migrationStatusFromValue(value: unknown): MigrationStatus {
  if (value === undefined) return "absent";
  if (value === "pending" || value === "complete" || value === "failed") return value;
  throw new Error("authoritative state database has an invalid migration status");
}

function createSchema(db: StateDatabase): void {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE runtime_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    );
  `);
  db.query(
    "INSERT INTO metadata(key, value) VALUES ('schema_version', '1'), ('initialized', '1')",
  ).run();
}

function assertSchema(db: StateDatabase): void {
  const rows = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('metadata','tasks','runtime_state')",
    )
    .all() as readonly { name?: unknown }[];
  const names = new Set(rows.map((row) => row.name));
  if (!names.has("metadata") || !names.has("tasks") || !names.has("runtime_state")) {
    throw new Error("authoritative state database is missing required tables");
  }
  const markers = db
    .query("SELECT key, value FROM metadata WHERE key IN ('schema_version','initialized')")
    .all() as readonly {
    key?: unknown;
    value?: unknown;
  }[];
  const markerValues = new Map(markers.map((row) => [row.key, row.value]));
  if (markerValues.get("schema_version") !== "1" || markerValues.get("initialized") !== "1") {
    throw new Error("authoritative state database has no valid initialization marker");
  }
}

function readMigrationStatusInDatabase(db: StateDatabase): MigrationStatus {
  const row = db.query("SELECT value FROM metadata WHERE key = 'migration_status'").get() as
    | { value?: unknown }
    | null
    | undefined;
  return migrationStatusFromValue(row?.value);
}
function migrationReceiptPresent(db: StateDatabase): boolean {
  const row = db
    .query(
      "SELECT COUNT(*) AS count FROM metadata WHERE key IN ('migration_id','migration_source_hash')",
    )
    .get() as { count?: number } | null;
  return (row?.count ?? 0) > 0;
}

function setMigrationStatusInDatabase(db: StateDatabase, status: MigrationStatus): void {
  if (status === "absent") {
    db.query("DELETE FROM metadata WHERE key = 'migration_status'").run();
    return;
  }
  db.query(
    "INSERT INTO metadata(key, value) VALUES ('migration_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(status);
}

async function openDatabase(home: string, allowMigrationState = false): Promise<StateDatabase> {
  const root = normalizedHome(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const path = databasePath(root);
  const exists = await pathExists(path);
  if (!exists) {
    const hasLegacyRuntime = await pathExists(legacyRuntimePath(root));
    const taskCount = await legacyTaskCount(root);
    if ((hasLegacyRuntime || taskCount > 0) && !allowMigrationState) {
      throw new Error(
        `legacy JSON state found under ${root}; run 'tandem migrate-state --yes' before using SQLite state`,
      );
    }
  }

  let db: StateDatabase | undefined;
  try {
    db = new Database(path, { create: true });
    if (!exists) {
      createSchema(db);
    } else {
      assertSchema(db);
    }
    await chmod(path, 0o600);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the original database error.
    }
    throw new Error(`could not open authoritative state database ${path}`, { cause: error });
  }
  if (db === undefined) throw new Error(`could not open authoritative state database ${path}`);
  let status: MigrationStatus;
  try {
    status = readMigrationStatusInDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
  if (
    !allowMigrationState &&
    (status === "pending" ||
      status === "failed" ||
      (status === "absent" && migrationReceiptPresent(db)))
  ) {
    db.close();
    throw new Error(
      `state migration is incomplete (${status}); complete or repair migration before normal use`,
    );
  }
  return db;
}

export function currentStateDatabase(home: string): StateDatabase | undefined {
  const current = databaseContext.getStore();
  if (current === undefined) return undefined;
  if (current.home !== normalizedHome(home)) {
    throw new Error(
      `nested state transaction home mismatch: ${current.home} versus ${normalizedHome(home)}`,
    );
  }
  return current.db;
}

export async function withStateLock<Result>(
  home: string,
  operation: () => Result | PromiseLike<Result>,
  timeoutMs = 5_000,
  pollMs = 20,
): Promise<Result> {
  const root = normalizedHome(home);
  const current = nativeLockContext.getStore();
  if (typeof operation !== "function")
    throw new TypeError("state lock operation must be a function");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs <= 0
  ) {
    throw new TypeError("state lock timeout and poll intervals must be positive integers");
  }
  if (current !== undefined) {
    if (current.home !== root) {
      throw new Error(`nested state lock home mismatch: ${current.home} versus ${root}`);
    }
    return operation();
  }
  const waitStartedAt = Date.now();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireDarwinFileLock(join(root, ".state.lock"), timeoutMs, pollMs);
  } catch (error) {
    await appendDiagnosticEvent(root, {
      event: "state-lock-acquisition-failed",
      details: {
        waitMs: Date.now() - waitStartedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
  const acquiredAt = Date.now();
  await appendDiagnosticEvent(root, {
    event: "state-lock-acquired",
    details: { waitMs: acquiredAt - waitStartedAt },
  });
  try {
    return await nativeLockContext.run({ home: root, release }, operation);
  } finally {
    const heldMs = Date.now() - acquiredAt;
    await release();
    await appendDiagnosticEvent(root, {
      event: "state-lock-released",
      details: { heldMs },
    });
  }
}

export async function withStateTransaction<Result>(
  home: string,
  operation: (db: StateDatabase) => Result | PromiseLike<Result>,
  lockOptions?: Readonly<{ timeoutMs?: number; pollMs?: number }>,
): Promise<Result> {
  if (typeof operation !== "function")
    throw new TypeError("database transaction operation must be a function");
  const root = normalizedHome(home);
  const current = databaseContext.getStore();
  if (current !== undefined) {
    if (current.home !== root) {
      throw new Error(`nested state transaction home mismatch: ${current.home} versus ${root}`);
    }
    try {
      return await operation(current.db);
    } catch (error) {
      current.rollbackOnly = true;
      throw error;
    }
  }
  return withStateLock(
    root,
    async () => {
      const db = await openDatabase(root);
      try {
        db.exec("BEGIN IMMEDIATE");
        return await databaseContext.run({ home: root, db, rollbackOnly: false }, async () => {
          try {
            const result = await operation(db);
            if (databaseContext.getStore()?.rollbackOnly) {
              throw new Error("state transaction marked rollback-only by a nested failure");
            }
            db.exec("COMMIT");
            return result;
          } catch (error) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // Preserve the callback failure.
            }
            throw error;
          }
        });
      } finally {
        db.close();
      }
    },
    lockOptions?.timeoutMs,
    lockOptions?.pollMs,
  );
}

async function openReadonlyDatabase(path: string): Promise<StateDatabase> {
  let db: StateDatabase | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    assertSchema(db);
    return db;
  } catch (error) {
    db?.close();
    throw new Error(`could not inspect authoritative state database ${path}`, { cause: error });
  }
}

export async function inspectDatabase(home: string): Promise<DatabaseInspection> {
  const root = normalizedHome(home);
  const path = databasePath(root);
  const exists = await pathExists(path);
  const runtimePath = legacyRuntimePath(root);
  const taskDirectory = legacyTaskDirectory(root);
  const taskCount = await legacyTaskCount(root);
  if (!exists) {
    return {
      path,
      exists: false,
      initialized: false,
      migrationStatus: "absent",
      legacyRuntimePath: runtimePath,
      legacyTaskDirectory: taskDirectory,
      legacyTaskCount: taskCount,
    };
  }
  const db = await openReadonlyDatabase(path);
  try {
    return {
      path,
      exists: true,
      initialized: true,
      migrationStatus: readMigrationStatusInDatabase(db),
      legacyRuntimePath: runtimePath,
      legacyTaskDirectory: taskDirectory,
      legacyTaskCount: taskCount,
    };
  } finally {
    db.close();
  }
}

export async function readMigrationStatus(home: string): Promise<MigrationStatus> {
  const root = normalizedHome(home);
  const path = databasePath(root);
  if (!(await pathExists(path))) return "absent";
  const db = await openReadonlyDatabase(path);
  try {
    return readMigrationStatusInDatabase(db);
  } finally {
    db.close();
  }
}

export async function setMigrationStatus(
  home: string,
  status: Exclude<MigrationStatus, "absent">,
): Promise<void> {
  await withStateTransactionAllowingMigration(home, (db) => {
    setMigrationStatusInDatabase(db, status);
  });
}

async function withStateTransactionAllowingMigration<Result>(
  home: string,
  operation: (db: StateDatabase) => Result | PromiseLike<Result>,
): Promise<Result> {
  const root = normalizedHome(home);
  const current = databaseContext.getStore();
  if (current !== undefined) {
    if (current.home !== root)
      throw new Error(`nested state transaction home mismatch: ${current.home} versus ${root}`);
    try {
      return await operation(current.db);
    } catch (error) {
      current.rollbackOnly = true;
      throw error;
    }
  }
  return withStateLock(root, async () => {
    const db = await openDatabase(root, true);
    try {
      db.exec("BEGIN IMMEDIATE");
      return await databaseContext.run({ home: root, db, rollbackOnly: false }, async () => {
        try {
          const result = await operation(db);
          if (databaseContext.getStore()?.rollbackOnly) {
            throw new Error("state transaction marked rollback-only by a nested failure");
          }
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve original error.
          }
          throw error;
        }
      });
    } finally {
      db.close();
    }
  });
}

export async function importLegacyState(home: string, snapshot: LegacyStateImport): Promise<void> {
  const tasks = snapshot?.tasks;
  const runtime = snapshot?.runtime;
  if (!Array.isArray(tasks)) throw new TypeError("legacy task snapshot must be an array");
  const parsedRuntime = parseRuntimeState(runtime, "legacy runtime snapshot");
  const parsedTasks = tasks.map((task, index) => parseTaskRecord(task, `legacy task ${index}`));
  await withStateTransactionAllowingMigration(home, (db) => {
    const existingTasks = db.query("SELECT COUNT(*) AS count FROM tasks").get() as {
      count?: number;
    } | null;
    const existingRuntime = db.query("SELECT COUNT(*) AS count FROM runtime_state").get() as {
      count?: number;
    } | null;
    const manifestId = snapshot.manifest?.id;
    const manifestHash =
      snapshot.manifest === undefined
        ? undefined
        : (snapshot.manifest.sourceHash ?? JSON.stringify(snapshot.manifest));
    if (manifestId !== undefined && manifestHash !== undefined) {
      const existingManifest = db
        .query(
          "SELECT value FROM metadata WHERE key IN ('migration_id','migration_source_hash') ORDER BY key",
        )
        .all() as readonly { value?: unknown }[];
      if (
        existingManifest.length === 2 &&
        existingManifest[0]?.value === manifestId &&
        existingManifest[1]?.value === manifestHash
      ) {
        return;
      }
      db.query(
        "INSERT INTO metadata(key, value) VALUES ('migration_id', ?), ('migration_source_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(manifestId, manifestHash);
    }
    if ((existingTasks?.count ?? 0) !== 0 || (existingRuntime?.count ?? 0) !== 0) {
      throw new Error("authoritative state database is not empty; refusing legacy import");
    }
    for (const task of parsedTasks) {
      db.query("INSERT INTO tasks(id, revision, payload) VALUES (?, ?, ?)").run(
        task.id,
        task.revision,
        JSON.stringify(task),
      );
    }
    db.query("INSERT INTO runtime_state(id, payload) VALUES (1, ?)").run(
      JSON.stringify(parsedRuntime),
    );
    db.query(
      "INSERT INTO metadata(key, value) VALUES ('runtime_initialized', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
    setMigrationStatusInDatabase(db, "pending");
  });
}
export function readTaskPayload(db: StateDatabase, id: string): unknown | undefined {
  const row = db.query("SELECT payload FROM tasks WHERE id = ?").get(id) as
    | { payload?: unknown }
    | null
    | undefined;
  if (row === null || row === undefined || typeof row.payload !== "string") return undefined;
  return JSON.parse(row.payload) as unknown;
}

export function readAllTaskPayloads(db: StateDatabase): readonly unknown[] {
  const rows = db.query("SELECT payload FROM tasks ORDER BY id").all() as readonly {
    payload?: unknown;
  }[];
  return rows.map((row) => {
    if (typeof row.payload !== "string") throw new Error("task payload is not text");
    return JSON.parse(row.payload) as unknown;
  });
}

export function writeTaskPayload(
  db: StateDatabase,
  id: string,
  revision: number,
  payload: unknown,
): void {
  db.query(
    "INSERT INTO tasks(id, revision, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload",
  ).run(id, revision, JSON.stringify(payload));
}

export function deleteTaskPayload(db: StateDatabase, id: string): void {
  db.query("DELETE FROM tasks WHERE id = ?").run(id);
}

export function readRuntimePayload(db: StateDatabase): unknown | undefined {
  const row = db.query("SELECT payload FROM runtime_state WHERE id = 1").get() as
    | { payload?: unknown }
    | null
    | undefined;
  if (row === null || row === undefined) return undefined;
  if (typeof row.payload !== "string") throw new Error("runtime payload is not text");
  try {
    return JSON.parse(row.payload) as unknown;
  } catch (error) {
    throw new Error("runtime payload is invalid JSON", { cause: error });
  }
}

export function runtimeStateWasInitialized(db: StateDatabase): boolean {
  const row = db.query("SELECT value FROM metadata WHERE key = 'runtime_initialized'").get() as
    | { value?: unknown }
    | null
    | undefined;
  return row?.value === "1";
}

export function writeRuntimePayload(db: StateDatabase, payload: unknown): void {
  db.query(
    "INSERT INTO runtime_state(id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
  ).run(JSON.stringify(payload));
  db.query(
    "INSERT INTO metadata(key, value) VALUES ('runtime_initialized', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run();
}

export type { StateDatabase };
