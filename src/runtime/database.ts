import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";

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

/**
 * Request tables arrived after the initialization marker was fixed at version 1, so they are
 * created on every open instead of through the marker. A database written by an older build gains
 * the empty tables and keeps every task and runtime row it already holds.
 */
function ensureRequestTables(db: StateDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_briefs (
      id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);
}

/**
 * Request accounting arrived after the initialization marker was fixed at version 1, so its table
 * is created on every open the way request briefs are. The event key is the primary key, which is
 * what makes recording the same observed event twice a no-op instead of a double count.
 */
function ensureRequestUsageTable(db: StateDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_usage_events (
      event_key TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS request_usage_events_by_request
      ON request_usage_events(request_id);
  `);
}

/**
 * Where each GitHub repository was last found on disk, so a PR review skips the folder crawl. A row
 * is a hint: callers re-check the folder and its remotes before trusting it.
 */
function ensureRepoLocationsTable(db: StateDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_locations (
      repo TEXT PRIMARY KEY NOT NULL,
      path TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
  `);
}

/**
 * PR watch records, one row per watched pull request keyed by `owner/repo#number`. Like the other
 * later tables it is created on every open, so an older database gains it empty.
 */
function ensurePrWatchTable(db: StateDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_watches (
      key TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL
    );
  `);
}

/**
 * The task timeline, one row per event, appended in the same transaction as the task change it
 * describes and never updated or deleted. `seq` orders events within and across tasks.
 */
function ensureTaskEventsTable(db: StateDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_events_by_task ON task_events(task_id, seq);
  `);
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

async function openDatabase(home: string): Promise<StateDatabase> {
  const root = normalizedHome(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const path = databasePath(root);
  const exists = await pathExists(path);

  let db: StateDatabase | undefined;
  try {
    db = new Database(path, { create: true });
    if (!exists) {
      createSchema(db);
    } else {
      assertSchema(db);
    }
    ensureRequestTables(db);
    ensureRequestUsageTable(db);
    ensureRepoLocationsTable(db);
    ensurePrWatchTable(db);
    ensureTaskEventsTable(db);
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
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const release = await acquireDarwinFileLock(join(root, ".state.lock"), timeoutMs, pollMs);
  try {
    return await nativeLockContext.run({ home: root, release }, operation);
  } finally {
    await release();
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

export function readRequestBriefPayload(db: StateDatabase, id: string): unknown | undefined {
  const row = db.query("SELECT payload FROM request_briefs WHERE id = ?").get(id) as
    | { payload?: unknown }
    | null
    | undefined;
  if (row === null || row === undefined || typeof row.payload !== "string") return undefined;
  return JSON.parse(row.payload) as unknown;
}

export function readAllRequestBriefPayloads(db: StateDatabase): readonly unknown[] {
  const rows = db.query("SELECT payload FROM request_briefs ORDER BY id").all() as readonly {
    payload?: unknown;
  }[];
  return rows.map((row) => {
    if (typeof row.payload !== "string") throw new Error("request brief payload is not text");
    return JSON.parse(row.payload) as unknown;
  });
}

export function writeRequestBriefPayload(
  db: StateDatabase,
  id: string,
  revision: number,
  payload: unknown,
): void {
  db.query(
    "INSERT INTO request_briefs(id, revision, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload",
  ).run(id, revision, JSON.stringify(payload));
}

/** Answers whether this event was new, so a caller can tell a fresh attempt from a replayed one. */
export function insertRequestUsagePayload(
  db: StateDatabase,
  entry: Readonly<{
    readonly eventKey: string;
    readonly requestId: string;
    readonly recordedAt: string;
    readonly payload: unknown;
  }>,
): boolean {
  const existing = db
    .query("SELECT 1 AS present FROM request_usage_events WHERE event_key = ?")
    .get(entry.eventKey) as { present?: unknown } | null | undefined;
  if (existing !== null && existing !== undefined) return false;
  db.query(
    "INSERT INTO request_usage_events(event_key, request_id, recorded_at, payload) VALUES (?, ?, ?, ?)",
  ).run(entry.eventKey, entry.requestId, entry.recordedAt, JSON.stringify(entry.payload));
  return true;
}

/**
 * Stored rows in a stable observation order, oldest recording first. A row whose text is not JSON
 * is reported as null so the caller can count it rather than lose the rest of the request.
 */
export function readRequestUsagePayloads(
  db: StateDatabase,
  requestId: string,
): readonly (unknown | null)[] {
  const rows = db
    .query(
      "SELECT payload FROM request_usage_events WHERE request_id = ? ORDER BY recorded_at, event_key",
    )
    .all(requestId) as readonly { payload?: unknown }[];
  return rows.map((row) => {
    if (typeof row.payload !== "string") return null;
    try {
      return JSON.parse(row.payload) as unknown;
    } catch {
      return null;
    }
  });
}

export function readRepoLocation(db: StateDatabase, repo: string): string | undefined {
  const row = db.query("SELECT path FROM repo_locations WHERE repo = ?").get(repo) as
    | { path?: unknown }
    | null
    | undefined;
  return typeof row?.path === "string" ? row.path : undefined;
}

export function writeRepoLocation(
  db: StateDatabase,
  entry: Readonly<{ repo: string; path: string; lastUsedAt: string }>,
): void {
  db.query(
    "INSERT INTO repo_locations(repo, path, last_used_at) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET path = excluded.path, last_used_at = excluded.last_used_at",
  ).run(entry.repo, entry.path, entry.lastUsedAt);
}

export function deleteRepoLocation(db: StateDatabase, repo: string): void {
  db.query("DELETE FROM repo_locations WHERE repo = ?").run(repo);
}

export function readPrWatchPayloads(db: StateDatabase): readonly unknown[] {
  const rows = db.query("SELECT payload FROM pr_watches ORDER BY key").all() as readonly {
    payload?: unknown;
  }[];
  return rows.map((row) => {
    if (typeof row.payload !== "string") throw new Error("PR watch payload is not text");
    return JSON.parse(row.payload) as unknown;
  });
}

export function writePrWatchPayload(db: StateDatabase, key: string, payload: unknown): void {
  db.query(
    "INSERT INTO pr_watches(key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload",
  ).run(key, JSON.stringify(payload));
}

export function insertTaskEventPayload(
  db: StateDatabase,
  entry: Readonly<{ taskId: string; at: string; type: string; payload: unknown }>,
): void {
  db.query("INSERT INTO task_events(task_id, at, type, payload) VALUES (?, ?, ?, ?)").run(
    entry.taskId,
    entry.at,
    entry.type,
    JSON.stringify(entry.payload),
  );
}

/** One task's events in the order they were written; a row whose text is not JSON reads as null. */
export function readTaskEventPayloads(
  db: StateDatabase,
  taskId: string,
): readonly Readonly<{ seq: number; payload: unknown }>[] {
  const rows = db
    .query("SELECT seq, payload FROM task_events WHERE task_id = ? ORDER BY seq")
    .all(taskId) as readonly { seq?: unknown; payload?: unknown }[];
  return rows.map((row) => {
    const seq = typeof row.seq === "number" ? row.seq : 0;
    if (typeof row.payload !== "string") return { seq, payload: null };
    try {
      return { seq, payload: JSON.parse(row.payload) as unknown };
    } catch {
      return { seq, payload: null };
    }
  });
}

/** A value kept in the metadata table by its own key, such as the PR watch poll schedule. */
export function readMetadataPayload(db: StateDatabase, key: string): unknown | undefined {
  const row = db.query("SELECT value FROM metadata WHERE key = ?").get(key) as
    | { value?: unknown }
    | null
    | undefined;
  return typeof row?.value === "string" ? (JSON.parse(row.value) as unknown) : undefined;
}

export function writeMetadataPayload(db: StateDatabase, key: string, payload: unknown): void {
  db.query(
    "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(payload));
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
