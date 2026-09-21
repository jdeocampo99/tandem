import { resolve } from "node:path";
import type { Clock, RequestDeliveryRecord } from "../contracts.ts";
import {
  readAllRequestDeliveryPayloads,
  readRequestDeliveryPayload,
  type StateDatabase,
  withStateTransaction,
  writeRequestDeliveryPayload,
} from "../runtime/database.ts";
import { StateCorruptionError, TaskStoreError } from "../tasks/store-errors.ts";
import { createRequestDeliveryRecord, RequestDeliveryError } from "./aggregate.ts";
import { assertSafeRequestId } from "./brief.ts";
import { parseRequestDeliveryRecord } from "./delivery-codec.ts";

export type RequestDeliveryTransform = (
  record: RequestDeliveryRecord,
) => RequestDeliveryRecord | PromiseLike<RequestDeliveryRecord>;

/** Durable whole-request coordination in the authoritative SQLite state, written under compare-and-swap. */
export type RequestDeliveryStore = Readonly<{
  /** Reads the request's coordination record, creating an empty one the first time it is needed. */
  readonly open: (
    input: Readonly<{ readonly requestId: string; readonly repoPath: string }>,
  ) => Promise<RequestDeliveryRecord>;
  readonly read: (requestId: string) => Promise<RequestDeliveryRecord | undefined>;
  readonly list: () => Promise<readonly RequestDeliveryRecord[]>;
  readonly update: (
    requestId: string,
    expectedRevision: number,
    transform: RequestDeliveryTransform,
  ) => Promise<RequestDeliveryRecord>;
}>;

export type RequestDeliveryStoreOptions = Readonly<{
  readonly home: string;
  readonly clock: Clock;
}>;

export function createRequestDeliveryStore(
  options: RequestDeliveryStoreOptions,
): RequestDeliveryStore {
  if (typeof options?.home !== "string" || options.home.trim().length === 0) {
    throw new TaskStoreError(
      "invalid-options",
      "Request delivery store home must be a non-empty path",
    );
  }
  if (typeof options.clock !== "function") {
    throw new TaskStoreError("invalid-options", "Request delivery store requires a clock function");
  }
  const home = resolve(options.home);
  return {
    open: async (input) =>
      withStateTransaction(home, (db) => {
        assertSafeRequestId(input.requestId);
        const existing = readRecord(db, input.requestId);
        if (existing !== undefined) return existing;
        const created = createRequestDeliveryRecord(
          { id: input.requestId, repoPath: input.repoPath },
          options.clock(),
        );
        writeRequestDeliveryPayload(db, created.id, created.revision, created);
        return created;
      }),
    read: async (requestId) =>
      withStateTransaction(home, (db) => {
        assertSafeRequestId(requestId);
        return readRecord(db, requestId);
      }),
    list: async () =>
      withStateTransaction(home, (db) => {
        try {
          return readAllRequestDeliveryPayloads(db).map((payload, index) =>
            parseRequestDeliveryRecord(payload, `request delivery ${index}`),
          );
        } catch (error) {
          throw corruption("request delivery database", error);
        }
      }),
    update: async (requestId, expectedRevision, transform) =>
      withStateTransaction(home, async (db) => {
        assertSafeRequestId(requestId);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw new TaskStoreError(
            "invalid-mutation",
            "expectedRevision must be a non-negative integer",
          );
        }
        const current = readRecord(db, requestId);
        if (current === undefined) {
          throw new RequestDeliveryError(
            "request-not-found",
            `Request ${requestId} has no delivery record`,
            requestId,
          );
        }
        if (current.revision !== expectedRevision) {
          throw new TaskStoreError(
            "stale-revision",
            `Request ${requestId} delivery revision ${current.revision} does not match expected ${expectedRevision}`,
          );
        }
        const next = checkedSuccessor(await transform(current), current);
        writeRequestDeliveryPayload(db, next.id, next.revision, next);
        return next;
      }),
  };
}

function corruption(source: string, error: unknown): StateCorruptionError {
  if (error instanceof StateCorruptionError) return error;
  return new StateCorruptionError(source, "authoritative SQLite payload is invalid", {
    cause: error,
  });
}

function readRecord(db: StateDatabase, id: string): RequestDeliveryRecord | undefined {
  try {
    const payload = readRequestDeliveryPayload(db, id);
    return payload === undefined
      ? undefined
      : parseRequestDeliveryRecord(payload, `request delivery ${id}`);
  } catch (error) {
    throw corruption(`request delivery ${id}`, error);
  }
}

/** Keeps an update to one identity and at most one revision step, the way task updates are kept. */
function checkedSuccessor(
  candidate: RequestDeliveryRecord,
  current: RequestDeliveryRecord,
): RequestDeliveryRecord {
  let next: RequestDeliveryRecord;
  try {
    next = parseRequestDeliveryRecord(candidate, `updated request delivery ${current.id}`);
  } catch (error) {
    throw corruption(`updated request delivery ${current.id}`, error);
  }
  if (next.id !== current.id) {
    throw new TaskStoreError(
      "invalid-mutation",
      `Request delivery update cannot change id ${current.id} to ${next.id}`,
    );
  }
  if (next.revision !== current.revision && next.revision !== current.revision + 1) {
    throw new TaskStoreError(
      "invalid-mutation",
      `Request ${current.id} delivery update must advance revision at most once from ${current.revision}`,
    );
  }
  return next;
}
