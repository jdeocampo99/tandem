import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
import { isRecord } from "./schema.ts";

type StateDatabase = Database;
type DatabaseContext = { home: string; db: StateDatabase; rollbackOnly: boolean };
const databaseContext = new AsyncLocalStorage<DatabaseContext>();

export function databasePath(home: string): string {
  return join(resolve(home), "state.sqlite");
}

type NativeLockContext = Readonly<{ home: string }>;
const nativeLockContext = new AsyncLocalStorage<NativeLockContext>();

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
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
 * The task-scoped half of the accounting ledger: settled work of a task no request governs, such
 * as standalone research or a PR review. It is kept apart from request rows so a request's receipt
 * reads exactly what it read before, and is created on every open like the request tables.
 */
function ensureTaskUsageTable(db: StateDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_usage_events (
      event_key TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_usage_events_by_task
      ON task_usage_events(task_id);
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
    .all();
  const names = new Set(rows.filter(isRecord).map((row) => row.name));
  if (!names.has("metadata") || !names.has("tasks") || !names.has("runtime_state")) {
    throw new Error("authoritative state database is missing required tables");
  }
  const markers = db
    .query("SELECT key, value FROM metadata WHERE key IN ('schema_version','initialized')")
    .all();
  const markerValues = new Map(markers.filter(isRecord).map((row) => [row.key, row.value]));
  if (markerValues.get("schema_version") !== "1" || markerValues.get("initialized") !== "1") {
    throw new Error("authoritative state database has no valid initialization marker");
  }
}

async function openDatabase(home: string): Promise<StateDatabase> {
  const root = resolve(home);
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
    ensureTaskUsageTable(db);
    ensureRepoLocationsTable(db);
    ensurePrWatchTable(db);
    ensureTaskEventsTable(db);
    await chmod(path, 0o600);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the original database error.
    }
    throw new Error(`could not open authoritative state database ${path}`, { cause: error });
  }
}

export function currentStateDatabase(home: string): StateDatabase | undefined {
  const current = databaseContext.getStore();
  if (current === undefined) return undefined;
  if (current.home !== resolve(home)) {
    throw new Error(
      `nested state transaction home mismatch: ${current.home} versus ${resolve(home)}`,
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
  const root = resolve(home);
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
    return await nativeLockContext.run({ home: root }, operation);
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
  const root = resolve(home);
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
    () => runStateTransaction(root, operation),
    lockOptions?.timeoutMs,
    lockOptions?.pollMs,
  );
}

async function runStateTransaction<Result>(
  home: string,
  operation: (db: StateDatabase) => Result | PromiseLike<Result>,
): Promise<Result> {
  const db = await openDatabase(home);
  try {
    db.exec("BEGIN IMMEDIATE");
    const context: DatabaseContext = { home, db, rollbackOnly: false };
    return await databaseContext.run(context, () => commitStateTransaction(context, operation));
  } finally {
    db.close();
  }
}

async function commitStateTransaction<Result>(
  context: DatabaseContext,
  operation: (db: StateDatabase) => Result | PromiseLike<Result>,
): Promise<Result> {
  const { db } = context;
  try {
    const result = await operation(db);
    if (context.rollbackOnly) {
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
}

export function readTaskPayload(db: StateDatabase, id: string): unknown | undefined {
  const payload = payloadText(db.query("SELECT payload FROM tasks WHERE id = ?").get(id));
  return payload === undefined ? undefined : (JSON.parse(payload) as unknown);
}

export function readAllTaskPayloads(db: StateDatabase): readonly unknown[] {
  const rows = db.query("SELECT payload FROM tasks ORDER BY id").all();
  return parsePayloads(rows, "task payload is not text");
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
  const payload = payloadText(db.query("SELECT payload FROM request_briefs WHERE id = ?").get(id));
  return payload === undefined ? undefined : (JSON.parse(payload) as unknown);
}

export function readAllRequestBriefPayloads(db: StateDatabase): readonly unknown[] {
  const rows = db.query("SELECT payload FROM request_briefs ORDER BY id").all();
  return parsePayloads(rows, "request brief payload is not text");
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
    .get(entry.eventKey);
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
    .all(requestId);
  return rows.map(parseOptionalPayload);
}

/** Appends one task-scoped usage event unless its key is already recorded. */
export function insertTaskUsagePayload(
  db: StateDatabase,
  entry: Readonly<{
    readonly eventKey: string;
    readonly taskId: string;
    readonly recordedAt: string;
    readonly payload: unknown;
  }>,
): boolean {
  const existing = db
    .query("SELECT 1 AS present FROM task_usage_events WHERE event_key = ?")
    .get(entry.eventKey);
  if (existing !== null && existing !== undefined) return false;
  db.query(
    "INSERT INTO task_usage_events(event_key, task_id, recorded_at, payload) VALUES (?, ?, ?, ?)",
  ).run(entry.eventKey, entry.taskId, entry.recordedAt, JSON.stringify(entry.payload));
  return true;
}

/** One task's task-scoped rows, in the same order and with the same tolerance as a request's. */
export function readTaskUsagePayloads(
  db: StateDatabase,
  taskId: string,
): readonly (unknown | null)[] {
  const rows = db
    .query(
      "SELECT payload FROM task_usage_events WHERE task_id = ? ORDER BY recorded_at, event_key",
    )
    .all(taskId);
  return rows.map(parseOptionalPayload);
}

function payloadText(row: unknown): string | undefined {
  return isRecord(row) && typeof row.payload === "string" ? row.payload : undefined;
}

function parsePayloads(rows: readonly unknown[], message: string): readonly unknown[] {
  return rows.map((row) => {
    const payload = payloadText(row);
    if (payload === undefined) throw new Error(message);
    return JSON.parse(payload) as unknown;
  });
}

function parseOptionalPayload(row: unknown): unknown | null {
  const payload = payloadText(row);
  if (payload === undefined) return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

export function readRepoLocation(db: StateDatabase, repo: string): string | undefined {
  const row = db.query("SELECT path FROM repo_locations WHERE repo = ?").get(repo);
  return isRecord(row) && typeof row.path === "string" ? row.path : undefined;
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
  const rows = db.query("SELECT payload FROM pr_watches ORDER BY key").all();
  return parsePayloads(rows, "PR watch payload is not text");
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
    .all(taskId);
  return rows.map((row) => ({
    seq: isRecord(row) && typeof row.seq === "number" ? row.seq : 0,
    payload: parseOptionalPayload(row),
  }));
}

/** A value kept in the metadata table by its own key, such as the PR watch poll schedule. */
export function readMetadataPayload(db: StateDatabase, key: string): unknown | undefined {
  const row = db.query("SELECT value FROM metadata WHERE key = ?").get(key);
  return isRecord(row) && typeof row.value === "string"
    ? (JSON.parse(row.value) as unknown)
    : undefined;
}

export function writeMetadataPayload(db: StateDatabase, key: string, payload: unknown): void {
  db.query(
    "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(payload));
}

export function readRuntimePayload(db: StateDatabase): unknown | undefined {
  const row = db.query("SELECT payload FROM runtime_state WHERE id = 1").get();
  if (row === null || row === undefined) return undefined;
  const payload = payloadText(row);
  if (payload === undefined) throw new Error("runtime payload is not text");
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error("runtime payload is invalid JSON", { cause: error });
  }
}

export function runtimeStateWasInitialized(db: StateDatabase): boolean {
  const row = db.query("SELECT value FROM metadata WHERE key = 'runtime_initialized'").get();
  return isRecord(row) && row.value === "1";
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
