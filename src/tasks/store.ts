import { chmod, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Clock, IdFactory, TaskRecord } from "../contracts.ts";
import {
  currentStateDatabase,
  readAllTaskPayloads,
  readTaskPayload,
  type StateDatabase,
  withStateLock,
  withStateTransaction,
  writeTaskPayload,
} from "../runtime/database.ts";
import {
  createTask,
  isSafeTaskId,
  type TaskEvent,
  type TaskInput,
  type TaskTransitionContext,
  transitionTask,
} from "./lifecycle.ts";
import { parseTaskRecord } from "./store-codec.ts";
import {
  InvalidTaskMutationError,
  StaleTaskRevisionError,
  StateCorruptionError,
  StoreFilesystemError,
  TaskAlreadyExistsError,
  TaskNotFoundError,
  TaskStoreError,
  UnsafeTaskIdError,
} from "./store-errors.ts";

export type StoreTaskInput = Readonly<Omit<TaskInput, "id"> & { readonly id?: string }>;
export type TaskTransform = (task: TaskRecord) => TaskRecord | PromiseLike<TaskRecord>;
/** Methods received by exclusive run under one repository lock; do not call a parent store method from the callback. */
export type TaskStoreTransaction = Readonly<{
  readonly create: (input: StoreTaskInput) => Promise<TaskRecord>;
  readonly read: (id: string) => Promise<TaskRecord | undefined>;
  readonly list: () => Promise<readonly TaskRecord[]>;
  readonly update: (
    id: string,
    expectedRevision: number,
    transform: TaskTransform,
  ) => Promise<TaskRecord>;
}>;

export type TaskStore = TaskStoreTransaction &
  Readonly<{
    readonly exclusive: <Result>(
      operation: (store: TaskStoreTransaction) => Result | PromiseLike<Result>,
    ) => Promise<Result>;
    readonly serialized: <Result>(
      operation: (store: TaskStoreTransaction) => Result | PromiseLike<Result>,
    ) => Promise<Result>;
  }>;
export type TaskStoreOptions = Readonly<{
  readonly directory: string;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly lockTimeoutMs?: number;
  readonly lockPollMs?: number;
}>;

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 20;

function ensureSafeId(id: unknown): asserts id is string {
  if (!isSafeTaskId(id)) throw new UnsafeTaskIdError(id);
}

function ensureStoreOptions(options: TaskStoreOptions): { timeoutMs: number; pollMs: number } {
  if (!options || typeof options.directory !== "string" || options.directory.trim().length === 0) {
    throw new TaskStoreError("invalid-options", "Task store directory must be a non-empty string");
  }
  if (typeof options.clock !== "function" || typeof options.idFactory !== "function") {
    throw new TaskStoreError(
      "invalid-options",
      "Task store requires clock and idFactory functions",
    );
  }
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs <= 0
  ) {
    throw new TaskStoreError(
      "invalid-options",
      "Lock timeout and poll intervals must be positive integers",
    );
  }
  return { timeoutMs, pollMs };
}

function taskDatabaseHome(directory: string): string {
  const root = resolve(directory);
  return basename(root) === "tasks" ? dirname(root) : root;
}

async function ensureDirectory(directory: string): Promise<void> {
  const root = resolve(directory);
  if (basename(root) === "tasks") {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await chmod(dirname(root), 0o700);
    return;
  }
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  } catch (error) {
    throw new StoreFilesystemError(`Could not prepare task store directory ${directory}`, {
      cause: error,
    });
  }
}

function corruption(source: string, error: unknown): StateCorruptionError {
  if (error instanceof StateCorruptionError) return error;
  return new StateCorruptionError(source, "authoritative SQLite payload is invalid", {
    cause: error,
  });
}

function databaseFor(directory: string): StateDatabase {
  const db = currentStateDatabase(taskDatabaseHome(directory));
  if (db === undefined) {
    throw new Error("task database access requires an active transaction");
  }
  return db;
}

function readTaskFromDatabase(db: StateDatabase, id: string): TaskRecord | undefined {
  try {
    const payload = readTaskPayload(db, id);
    return payload === undefined ? undefined : parseTaskRecord(payload, `task ${id}`);
  } catch (error) {
    throw corruption(`task ${id}`, error);
  }
}

function listTasksFromDatabase(db: StateDatabase): readonly TaskRecord[] {
  try {
    return readAllTaskPayloads(db).map((payload, index) =>
      parseTaskRecord(payload, `task ${index}`),
    );
  } catch (error) {
    throw corruption("task database", error);
  }
}

function validateCreatedTaskInput(input: StoreTaskInput): void {
  if (!input || typeof input !== "object") {
    throw new TaskStoreError("invalid-options", "Task input must be an object");
  }
  if (input.id !== undefined) ensureSafeId(input.id);
}

export function createTaskStore(options: TaskStoreOptions): TaskStore {
  const { timeoutMs, pollMs } = ensureStoreOptions(options);
  const directory = resolve(options.directory);
  const home = taskDatabaseHome(directory);

  async function createInTransaction(
    db: StateDatabase,
    input: StoreTaskInput,
  ): Promise<TaskRecord> {
    validateCreatedTaskInput(input);
    const id = input.id ?? options.idFactory();
    ensureSafeId(id);
    const existing = readTaskFromDatabase(db, id);
    if (existing !== undefined) throw new TaskAlreadyExistsError(id);
    const taskInput: TaskInput = {
      id,
      repoPath: input.repoPath,
      kind: input.kind,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      surfaces: input.surfaces,
      policy: input.policy,
      ...(input.researchHandoffs === undefined ? {} : { researchHandoffs: input.researchHandoffs }),
      ...(input.researchContinuation === undefined
        ? {}
        : { researchContinuation: input.researchContinuation }),
    };
    const task = createTask(taskInput, options.clock());
    writeTaskPayload(db, task.id, task.revision, task);
    return task;
  }

  async function readInTransaction(db: StateDatabase, id: string): Promise<TaskRecord | undefined> {
    ensureSafeId(id);
    return readTaskFromDatabase(db, id);
  }

  async function listInTransaction(db: StateDatabase): Promise<readonly TaskRecord[]> {
    return listTasksFromDatabase(db);
  }

  async function updateInTransaction(
    db: StateDatabase,
    id: string,
    expectedRevision: number,
    transform: TaskTransform,
  ): Promise<TaskRecord> {
    ensureSafeId(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TaskStoreError(
        "invalid-mutation",
        "expectedRevision must be a non-negative integer",
      );
    }
    if (typeof transform !== "function") {
      throw new TaskStoreError("invalid-mutation", "Task update transform must be a function");
    }
    const current = readTaskFromDatabase(db, id);
    if (current === undefined) throw new TaskNotFoundError(id);
    if (current.revision !== expectedRevision) {
      throw new StaleTaskRevisionError(id, expectedRevision, current.revision);
    }
    const candidate = await transform(current);
    let next: TaskRecord;
    try {
      next = parseTaskRecord(candidate, `updated task ${id}`);
    } catch (error) {
      throw corruption(`updated task ${id}`, error);
    }
    if (next.id !== id) {
      throw new InvalidTaskMutationError(`Task update cannot change id ${id} to ${next.id}`);
    }
    if (next.revision !== current.revision + 1) {
      throw new InvalidTaskMutationError(
        `Task ${id} update must increment revision exactly once from ${current.revision}`,
      );
    }
    writeTaskPayload(db, next.id, next.revision, next);
    return next;
  }

  const transaction: TaskStoreTransaction = {
    create: async (input) => createInTransaction(databaseFor(directory), input),
    read: async (id) => readInTransaction(databaseFor(directory), id),
    list: async () => listInTransaction(databaseFor(directory)),
    update: async (id, expectedRevision, transform) =>
      updateInTransaction(databaseFor(directory), id, expectedRevision, transform),
  };

  async function withLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    await ensureDirectory(directory);
    return withStateTransaction(home, operation, { timeoutMs, pollMs });
  }

  const serializedTransaction: TaskStoreTransaction = {
    create: async (input) => withStateTransaction(home, (db) => createInTransaction(db, input)),
    read: async (id) => withStateTransaction(home, (db) => readInTransaction(db, id)),
    list: async () => withStateTransaction(home, (db) => listInTransaction(db)),
    update: async (id, expectedRevision, transform) =>
      withStateTransaction(home, (db) => updateInTransaction(db, id, expectedRevision, transform)),
  };

  return {
    create: async (input) => withLock(() => createInTransaction(databaseFor(directory), input)),
    read: async (id) => withLock(() => readInTransaction(databaseFor(directory), id)),
    list: async () => withLock(() => listInTransaction(databaseFor(directory))),
    update: async (id, expectedRevision, transform) =>
      withLock(() => updateInTransaction(databaseFor(directory), id, expectedRevision, transform)),
    exclusive: async <Result>(
      operation: (store: TaskStoreTransaction) => Result | PromiseLike<Result>,
    ): Promise<Result> => {
      if (typeof operation !== "function") {
        throw new TaskStoreError("invalid-mutation", "exclusive operation must be a function");
      }
      return withLock(async () => operation(transaction));
    },
    serialized: async <Result>(
      operation: (store: TaskStoreTransaction) => Result | PromiseLike<Result>,
    ): Promise<Result> => {
      if (typeof operation !== "function") {
        throw new TaskStoreError("invalid-mutation", "serialized operation must be a function");
      }
      await ensureDirectory(directory);
      return withStateLock(home, () => operation(serializedTransaction), timeoutMs, pollMs);
    },
  };
}

export async function transitionStoredTask(
  store: TaskStore,
  id: string,
  expectedRevision: number,
  event: TaskEvent,
  context: TaskTransitionContext,
): Promise<TaskRecord> {
  return store.update(id, expectedRevision, (task) => transitionTask(task, event, context));
}
