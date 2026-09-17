export type TaskStoreErrorCode =
  | "invalid-options"
  | "unsafe-task-id"
  | "task-not-found"
  | "task-already-exists"
  | "state-corruption"
  | "stale-revision"
  | "invalid-mutation"
  | "serialization-failure"
  | "lock-timeout"
  | "lock-corruption"
  | "filesystem-failure";

export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;

  constructor(code: TaskStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

export class UnsafeTaskIdError extends TaskStoreError {
  constructor(id: unknown) {
    super("unsafe-task-id", `Unsafe task id: ${String(id)}`);
    this.name = "UnsafeTaskIdError";
  }
}

export class TaskNotFoundError extends TaskStoreError {
  constructor(id: string) {
    super("task-not-found", `Task ${id} does not exist`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskAlreadyExistsError extends TaskStoreError {
  constructor(id: string) {
    super("task-already-exists", `Task ${id} already exists`);
    this.name = "TaskAlreadyExistsError";
  }
}

export class StateCorruptionError extends TaskStoreError {
  readonly source: string;

  constructor(source: string, message: string, options?: ErrorOptions) {
    super("state-corruption", `${source}: ${message}`, options);
    this.name = "StateCorruptionError";
    this.source = source;
  }
}

export class StaleTaskRevisionError extends TaskStoreError {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(taskId: string, expectedRevision: number, actualRevision: number) {
    super(
      "stale-revision",
      `Task ${taskId} revision ${actualRevision} does not match expected ${expectedRevision}`,
    );
    this.name = "StaleTaskRevisionError";
    this.taskId = taskId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class InvalidTaskMutationError extends TaskStoreError {
  constructor(message: string) {
    super("invalid-mutation", message);
    this.name = "InvalidTaskMutationError";
  }
}

export class StoreSerializationError extends TaskStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("serialization-failure", message, options);
    this.name = "StoreSerializationError";
  }
}

export class StoreLockTimeoutError extends TaskStoreError {
  constructor(directory: string, timeoutMs: number) {
    super(
      "lock-timeout",
      `Could not acquire repository lock for ${directory} within ${timeoutMs}ms`,
    );
    this.name = "StoreLockTimeoutError";
  }
}

export class StoreLockError extends TaskStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("lock-corruption", message, options);
    this.name = "StoreLockError";
  }
}

export class StoreFilesystemError extends TaskStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("filesystem-failure", message, options);
    this.name = "StoreFilesystemError";
  }
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}
