import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, IdFactory, TaskRecord } from "../contracts.ts";
import {
  createTask,
  isSafeTaskId,
  type TaskEvent,
  type TaskInput,
  type TaskTransitionContext,
  transitionTask,
} from "./lifecycle.ts";
import { parseTaskRecord, serializeTaskRecord } from "./store-codec.ts";
import {
  errorCode,
  InvalidTaskMutationError,
  StaleTaskRevisionError,
  StateCorruptionError,
  StoreFilesystemError,
  TaskAlreadyExistsError,
  TaskNotFoundError,
  TaskStoreError,
  UnsafeTaskIdError,
} from "./store-errors.ts";
import { acquireDarwinFileLock } from "./store-lock.ts";

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
  if (!isSafeTaskId(id)) {
    throw new UnsafeTaskIdError(id);
  }
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

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } catch (error) {
    throw new StoreFilesystemError(`Could not prepare task store directory ${directory}`, {
      cause: error,
    });
  }
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function taskPath(directory: string, id: string): string {
  return join(directory, `${id}.json`);
}

function lockPath(directory: string): string {
  return join(directory, ".lock");
}

async function acquireRepositoryLock(
  directory: string,
  timeoutMs: number,
  pollMs: number,
): Promise<() => Promise<void>> {
  return acquireDarwinFileLock(lockPath(directory), timeoutMs, pollMs);
}

async function writeTaskAtomically(directory: string, task: TaskRecord): Promise<void> {
  const id = task.id;
  const destination = taskPath(directory, id);
  const temporary = join(directory, `.task-${process.pid}-${randomUUID()}.tmp`);
  const serialized = serializeTaskRecord(task);
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (temporaryCreated) {
      await unlink(temporary).catch(() => undefined);
    }
    if (error instanceof TaskStoreError) {
      throw error;
    }
    throw new StoreFilesystemError(`Could not atomically write task ${id}`, { cause: error });
  }
}

async function readTaskUnlocked(directory: string, id: string): Promise<TaskRecord | undefined> {
  ensureSafeId(id);
  const path = taskPath(directory, id);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new StoreFilesystemError(`Could not inspect task ${id}`, { cause: error });
  }
  if (!metadata.isFile()) {
    throw new StateCorruptionError(path, "task path is not a regular file");
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new StoreFilesystemError(`Could not read task ${id}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new StateCorruptionError(path, "task file is not valid JSON", { cause: error });
  }
  return parseTaskRecord(value, path);
}

async function listTasksUnlocked(directory: string): Promise<readonly TaskRecord[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new StoreFilesystemError(`Could not list task store directory ${directory}`, {
      cause: error,
    });
  }
  const taskEntries = entries.filter((entry) => entry.name.endsWith(".json"));
  const ids = taskEntries.map((entry) => entry.name.slice(0, -5));
  for (const id of ids) {
    ensureSafeId(id);
  }
  const sortedIds = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const tasks: TaskRecord[] = [];
  for (const id of sortedIds) {
    const task = await readTaskUnlocked(directory, id);
    if (task === undefined) {
      throw new StateCorruptionError(
        taskPath(directory, id),
        "task disappeared during locked listing",
      );
    }
    tasks.push(task);
  }
  return tasks;
}

function validateCreatedTaskInput(input: StoreTaskInput): void {
  if (!input || typeof input !== "object") {
    throw new TaskStoreError("invalid-options", "Task input must be an object");
  }
  if (input.id !== undefined) {
    ensureSafeId(input.id);
  }
}

export function createTaskStore(options: TaskStoreOptions): TaskStore {
  const { timeoutMs, pollMs } = ensureStoreOptions(options);
  const directory = options.directory;

  async function createUnlocked(input: StoreTaskInput): Promise<TaskRecord> {
    validateCreatedTaskInput(input);
    const id = input.id ?? options.idFactory();
    ensureSafeId(id);
    const existing = await readTaskUnlocked(directory, id);
    if (existing !== undefined) {
      throw new TaskAlreadyExistsError(id);
    }
    const taskInput: TaskInput = {
      id,
      repoPath: input.repoPath,
      kind: input.kind,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      surfaces: input.surfaces,
      policy: input.policy,
    };
    const task = createTask(taskInput, options.clock());
    await writeTaskAtomically(directory, task);
    return task;
  }

  async function readUnlocked(id: string): Promise<TaskRecord | undefined> {
    ensureSafeId(id);
    return readTaskUnlocked(directory, id);
  }

  async function listUnlocked(): Promise<readonly TaskRecord[]> {
    return listTasksUnlocked(directory);
  }

  async function updateUnlocked(
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
    const current = await readTaskUnlocked(directory, id);
    if (current === undefined) {
      throw new TaskNotFoundError(id);
    }
    if (current.revision !== expectedRevision) {
      throw new StaleTaskRevisionError(id, expectedRevision, current.revision);
    }
    const candidate = await transform(current);
    const next = parseTaskRecord(candidate, `updated task ${id}`);
    if (next.id !== id) {
      throw new InvalidTaskMutationError(`Task update cannot change id ${id} to ${next.id}`);
    }
    if (next.revision !== current.revision + 1) {
      throw new InvalidTaskMutationError(
        `Task ${id} update must increment revision exactly once from ${current.revision}`,
      );
    }
    await writeTaskAtomically(directory, next);
    return next;
  }

  const transaction: TaskStoreTransaction = {
    create: createUnlocked,
    read: readUnlocked,
    list: listUnlocked,
    update: updateUnlocked,
  };

  async function withLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    await ensureDirectory(directory);
    const release = await acquireRepositoryLock(directory, timeoutMs, pollMs);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  return {
    create: async (input) => withLock(() => createUnlocked(input)),
    read: async (id) => withLock(() => readUnlocked(id)),
    list: async () => withLock(listUnlocked),
    update: async (id, expectedRevision, transform) =>
      withLock(() => updateUnlocked(id, expectedRevision, transform)),
    exclusive: async <Result>(
      operation: (store: TaskStoreTransaction) => Result | PromiseLike<Result>,
    ): Promise<Result> => {
      if (typeof operation !== "function") {
        throw new TaskStoreError("invalid-mutation", "exclusive operation must be a function");
      }
      return withLock(async () => operation(transaction));
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
