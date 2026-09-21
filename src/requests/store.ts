import { resolve } from "node:path";
import type { Clock, IdFactory, RequestBriefContent, RequestBriefRecord } from "../contracts.ts";
import {
  readAllRequestBriefPayloads,
  readRequestBriefPayload,
  type StateDatabase,
  withStateTransaction,
  writeRequestBriefPayload,
} from "../runtime/database.ts";
import { StateCorruptionError, TaskStoreError } from "../tasks/store-errors.ts";
import {
  assertSafeRequestId,
  createRequestBriefRecord,
  RequestBriefError,
  requestIdFrom,
} from "./brief.ts";
import { parseRequestBriefRecord } from "./store-codec.ts";

export type CreateRequestBriefInput = Readonly<{
  readonly repoPath: string;
  readonly content: RequestBriefContent;
}>;

export type RequestBriefTransform = (
  record: RequestBriefRecord,
) => RequestBriefRecord | PromiseLike<RequestBriefRecord>;

/** Durable request briefs in the authoritative SQLite state, written under compare-and-swap. */
export type RequestBriefStore = Readonly<{
  readonly create: (input: CreateRequestBriefInput) => Promise<RequestBriefRecord>;
  readonly read: (id: string) => Promise<RequestBriefRecord | undefined>;
  readonly list: () => Promise<readonly RequestBriefRecord[]>;
  readonly update: (
    id: string,
    expectedRevision: number,
    transform: RequestBriefTransform,
  ) => Promise<RequestBriefRecord>;
}>;

export type RequestBriefStoreOptions = Readonly<{
  readonly home: string;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
}>;

export function createRequestBriefStore(options: RequestBriefStoreOptions): RequestBriefStore {
  if (typeof options?.home !== "string" || options.home.trim().length === 0) {
    throw new TaskStoreError(
      "invalid-options",
      "Request brief store home must be a non-empty path",
    );
  }
  if (typeof options.clock !== "function" || typeof options.idFactory !== "function") {
    throw new TaskStoreError(
      "invalid-options",
      "Request brief store requires clock and idFactory functions",
    );
  }
  const home = resolve(options.home);
  return {
    create: async (input) =>
      withStateTransaction(home, (db) => {
        const id = requestIdFrom(options.idFactory());
        if (readRecord(db, id) !== undefined) {
          throw new RequestBriefError("invalid-request-id", `Request ${id} already exists`, id);
        }
        const record = createRequestBriefRecord(
          { id, repoPath: input.repoPath, content: input.content },
          options.clock(),
        );
        writeRequestBriefPayload(db, record.id, record.revision, record);
        return record;
      }),
    read: async (id) =>
      withStateTransaction(home, (db) => {
        assertSafeRequestId(id);
        return readRecord(db, id);
      }),
    list: async () =>
      withStateTransaction(home, (db) => {
        try {
          return readAllRequestBriefPayloads(db).map((payload, index) =>
            parseRequestBriefRecord(payload, `request brief ${index}`),
          );
        } catch (error) {
          throw corruption("request brief database", error);
        }
      }),
    update: async (id, expectedRevision, transform) =>
      withStateTransaction(home, async (db) => {
        assertSafeRequestId(id);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw new TaskStoreError(
            "invalid-mutation",
            "expectedRevision must be a non-negative integer",
          );
        }
        const current = readRecord(db, id);
        if (current === undefined) {
          throw new RequestBriefError("request-not-found", `Request ${id} does not exist`, id);
        }
        if (current.revision !== expectedRevision) {
          throw new TaskStoreError(
            "stale-revision",
            `Request ${id} revision ${current.revision} does not match expected ${expectedRevision}`,
          );
        }
        const next = checkedSuccessor(await transform(current), current);
        writeRequestBriefPayload(db, next.id, next.revision, next);
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

function readRecord(db: StateDatabase, id: string): RequestBriefRecord | undefined {
  try {
    const payload = readRequestBriefPayload(db, id);
    return payload === undefined ? undefined : parseRequestBriefRecord(payload, `request ${id}`);
  } catch (error) {
    throw corruption(`request ${id}`, error);
  }
}

/** Keeps an update to one identity and exactly one revision step, the way task updates are kept. */
function checkedSuccessor(
  candidate: RequestBriefRecord,
  current: RequestBriefRecord,
): RequestBriefRecord {
  let next: RequestBriefRecord;
  try {
    next = parseRequestBriefRecord(candidate, `updated request ${current.id}`);
  } catch (error) {
    throw corruption(`updated request ${current.id}`, error);
  }
  if (next.id !== current.id) {
    throw new TaskStoreError(
      "invalid-mutation",
      `Request update cannot change id ${current.id} to ${next.id}`,
    );
  }
  if (next.revision !== current.revision + 1) {
    throw new TaskStoreError(
      "invalid-mutation",
      `Request ${current.id} update must increment revision exactly once from ${current.revision}`,
    );
  }
  if (next.draft.revision < current.draft.revision) {
    throw new TaskStoreError(
      "invalid-mutation",
      `Request ${current.id} brief revision cannot move back from ${current.draft.revision} to ${next.draft.revision}`,
    );
  }
  return next;
}
