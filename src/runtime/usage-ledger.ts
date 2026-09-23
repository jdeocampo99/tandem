/**
 * The durable request accounting ledger: append-only facts in the authoritative SQLite state.
 *
 * This is the one owner of usage, cost, quota, and timing records for a request, and the only
 * place they are written. It records what happened and how certain it is; it never authorizes,
 * pauses, retries, or blocks work. A downstream reader such as economical routing's usage-safety
 * check reads {@link RequestUsageLedger.read} or {@link RequestUsageLedger.receipt} on its own.
 */

import { resolve } from "node:path";
import { type Clock, isSafeRequestId } from "../contracts.ts";
import {
  insertRequestUsagePayload,
  readRequestUsagePayloads,
  withStateTransaction,
} from "./database.ts";
import type { RequestUsageEvent } from "./usage.ts";
import { parseRequestUsageEvent } from "./usage-codec.ts";
import {
  buildRequestUsageReceipt,
  type RequestUsageReadout,
  type RequestUsageReceipt,
} from "./usage-receipt.ts";

/** How many of the offered events were new, and how many had already been recorded. */
export type RequestUsageRecordResult = Readonly<{
  readonly recorded: number;
  readonly duplicates: number;
}>;

export type RequestUsageLedger = Readonly<{
  /** Appends every event not already present, keyed by its stable event identity. */
  readonly record: (events: readonly RequestUsageEvent[]) => Promise<RequestUsageRecordResult>;
  /** Every recorded event for one request, plus how many stored rows could not be read. */
  readonly read: (requestId: string) => Promise<RequestUsageReadout>;
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
      if (checked.length === 0) return { recorded: 0, duplicates: 0 };
      const recordedAt = options.clock();
      return withStateTransaction(home, (db) => {
        let recorded = 0;
        for (const event of checked) {
          const inserted = insertRequestUsagePayload(db, {
            eventKey: event.eventKey,
            requestId: event.identity.requestId,
            recordedAt,
            payload: event,
          });
          if (inserted) recorded += 1;
        }
        return { recorded, duplicates: checked.length - recorded };
      });
    },
    read,
    receipt: async (requestId) => buildRequestUsageReceipt(requestId, await read(requestId)),
  };
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
