/**
 * The durable request accounting ledger: append-only facts in the authoritative SQLite state.
 *
 * This is the one owner of usage, cost, quota, and timing records for a request, and the only
 * place they are written. Work no request governs, such as standalone research or a PR review, is
 * kept in the same ledger under its task's own scope, so it is counted without touching any
 * request's receipt. It records what happened and how certain it is; it never authorizes,
 * pauses, retries, or blocks work. A downstream reader such as economical routing's usage-safety
 * check reads {@link RequestUsageLedger.read} or {@link RequestUsageLedger.receipt} on its own.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Clock, isSafeRequestId } from "../contracts.ts";
import { isSafeTaskId } from "../tasks/lifecycle.ts";
import {
  insertRequestUsagePayload,
  insertTaskUsagePayload,
  readRequestUsagePayloads,
  readTaskUsagePayloads,
  withStateTransaction,
} from "./database.ts";
import type { RequestUsageEvent } from "./usage.ts";
import { parseRequestUsageEvent } from "./usage-codec.ts";
import {
  buildRequestUsageReceipt,
  type CoordinatorUsageEntry,
  type RequestUsageReadout,
  type RequestUsageReceipt,
} from "./usage-receipt.ts";

/** How many of the offered events were new, and how many had already been recorded. */
export type RequestUsageRecordResult = Readonly<{
  readonly recorded: number;
  readonly duplicates: number;
  /** The events this call added, so a first-time fact such as a delivery can be acted on once. */
  readonly added: readonly RequestUsageEvent[];
}>;

export type RequestUsageLedger = Readonly<{
  /** Appends every event not already present, keyed by its stable event identity. */
  readonly record: (events: readonly RequestUsageEvent[]) => Promise<RequestUsageRecordResult>;
  /** Every recorded event for one request, plus how many stored rows could not be read. */
  readonly read: (requestId: string) => Promise<RequestUsageReadout>;
  /**
   * The events recorded under one task's own scope: the settled work of a task no request
   * governs. A governed task's work is in its request's readout instead.
   */
  readonly readTask: (taskId: string) => Promise<RequestUsageReadout>;
  /** The compact receipt and expandable breakdown built from those events. */
  readonly receipt: (requestId: string) => Promise<RequestUsageReceipt>;
}>;

export type RequestUsageLedgerOptions = Readonly<{
  readonly home: string;
  readonly clock: Clock;
}>;

export function createRequestUsageLedger(options: RequestUsageLedgerOptions): RequestUsageLedger {
  if (typeof options?.home !== "string" || options.home.trim().length === 0) {
    throw new TypeError("Request usage ledger home must be a non-empty path");
  }
  if (typeof options.clock !== "function") {
    throw new TypeError("Request usage ledger requires a clock function");
  }
  const home = resolve(options.home);
  const read = async (requestId: string): Promise<RequestUsageReadout> => {
    assertRequestId(requestId);
    return withStateTransaction(home, (db) => readoutOf(readRequestUsagePayloads(db, requestId)));
  };
  return {
    record: async (events) => {
      const checked = events.map(checkedEvent);
      if (checked.length === 0) return { recorded: 0, duplicates: 0, added: [] };
      const recordedAt = options.clock();
      return withStateTransaction(home, (db) => {
        const added: RequestUsageEvent[] = [];
        for (const event of checked) {
          const { requestId } = event.identity;
          const entry = { eventKey: event.eventKey, recordedAt, payload: event };
          const inserted =
            requestId === undefined
              ? insertTaskUsagePayload(db, { ...entry, taskId: taskScope(event) })
              : insertRequestUsagePayload(db, { ...entry, requestId });
          if (inserted) added.push(event);
        }
        return { recorded: added.length, duplicates: checked.length - added.length, added };
      });
    },
    read,
    readTask: async (taskId) => {
      if (!isSafeTaskId(taskId)) {
        throw new TypeError(
          `A task usage read needs a task id; received ${JSON.stringify(String(taskId))}`,
        );
      }
      return withStateTransaction(home, (db) => readoutOf(readTaskUsagePayloads(db, taskId)));
    },
    receipt: async (requestId) => buildRequestUsageReceipt(requestId, await read(requestId)),
  };
}

/** The readout that holds a task's own work: its request's, or its own scope without one. */
export function readTaskUsage(
  ledger: RequestUsageLedger,
  task: Readonly<{ readonly id: string; readonly requestId?: string }>,
): Promise<RequestUsageReadout> {
  return task.requestId === undefined ? ledger.readTask(task.id) : ledger.read(task.requestId);
}

/** The task an event without a request is scoped to; the codec has already refused one without. */
function taskScope(event: RequestUsageEvent): string {
  const taskId = event.identity.taskId;
  if (taskId === undefined) throw new TypeError("A usage event must name a request or a task");
  return taskId;
}

function assertRequestId(value: unknown): asserts value is string {
  if (!isSafeRequestId(value)) {
    throw new TypeError(
      `A request usage ledger read needs a request id; received ${JSON.stringify(String(value))}`,
    );
  }
}

/**
 * Round-trips the event through the durable parser before it is written, so nothing reaches the
 * database that a later read would have to reject as malformed or that exceeds the receipt's
 * privacy bounds.
 */
function checkedEvent(event: RequestUsageEvent, index: number): RequestUsageEvent {
  return parseRequestUsageEvent(event, `recorded request usage event ${index}`);
}

/**
 * Reads what is readable. A stale, truncated, or malformed row is counted rather than thrown,
 * because accounting must keep reporting latency and status when telemetry is unavailable.
 */
function readoutOf(payloads: readonly (unknown | null)[]): RequestUsageReadout {
  const events: RequestUsageEvent[] = [];
  let malformedEvents = 0;
  for (const [index, payload] of payloads.entries()) {
    if (payload === null) {
      malformedEvents += 1;
      continue;
    }
    try {
      events.push(parseRequestUsageEvent(payload, `stored request usage event ${index}`));
    } catch {
      malformedEvents += 1;
    }
  }
  return { events, malformedEvents };
}

/**
 * The coordinator's own model replies, one line each. The coordinator's conversation serves every
 * request in its repository at once, so it is kept apart from any one request's ledger and shown
 * on a receipt only as a shared line.
 */
export async function appendCoordinatorUsage(
  home: string,
  entry: CoordinatorUsageEntry,
): Promise<void> {
  await appendFile(join(home, "coordinator-usage.jsonl"), `${JSON.stringify(entry)}\n`, {
    mode: 0o600,
  });
}

/** Every readable coordinator usage line; a missing file is no usage, and a bad line is skipped. */
export async function readCoordinatorUsage(home: string): Promise<readonly unknown[]> {
  let text: string;
  try {
    text = await readFile(join(home, "coordinator-usage.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}
