import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/contracts.ts";
import { withStateTransaction } from "../../src/runtime/database.ts";
import {
  REQUEST_USAGE_EVENT_SCHEMA_VERSION,
  type RequestUsageEvent,
  requestUsageEventKey,
} from "../../src/runtime/usage.ts";
import {
  createRequestUsageLedger,
  type RequestUsageLedger,
} from "../../src/runtime/usage-ledger.ts";

const REQUEST_ID = "req-ledger";
const NOW = "2030-01-01T02:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, minutes)).toISOString();
}

function intake(): RequestUsageEvent {
  const identity = { requestId: REQUEST_ID };
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({ kind: "intake", identity, discriminator: "brief-created" }),
    kind: "intake",
    workKind: "coordinator",
    identity,
    startedAt: at(0),
    endedAt: at(0),
    status: "observed",
    tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
    charge: { provenance: "unavailable", reason: "no-provider-boundary" },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
  };
}

function terminal(): RequestUsageEvent {
  const identity = { requestId: REQUEST_ID, taskId: "task-1", generation: 1 };
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({ kind: "terminal", identity, discriminator: "delivered" }),
    kind: "terminal",
    workKind: "coordinator",
    identity,
    startedAt: at(60),
    endedAt: at(60),
    status: "succeeded",
    tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
    charge: { provenance: "unavailable", reason: "no-provider-boundary" },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
    outcome: "delivered",
  };
}

function sample(sampleIdentity: string, attempt: number, amountMicros: number): RequestUsageEvent {
  const identity = {
    requestId: REQUEST_ID,
    taskId: "task-1",
    attempt,
    provider: "typesafe",
    model: "jev-1.13.0",
  };
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({
      kind: "provider-sample",
      identity,
      discriminator: sampleIdentity,
    }),
    kind: "provider-sample",
    workKind: "review",
    identity,
    startedAt: at(20),
    endedAt: at(21),
    status: "succeeded",
    tokens: { provenance: "actual", inputTokens: 1_000, outputTokens: 40 },
    charge: {
      provenance: "actual",
      currency: "USD",
      amountMicros,
      pricingSource: "typesafe-jev-published-rate",
      pricingVersion: 1,
    },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
  };
}

async function withHome(
  run: (home: string, newLedger: () => RequestUsageLedger) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-usage-ledger-")));
  const home = join(root, "home");
  const clock: Clock = () => NOW;
  try {
    await run(home, () => createRequestUsageLedger({ home, clock }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("recorded events survive a restart and are read back intact", async () => {
  await withHome(async (_home, newLedger) => {
    await newLedger().record([intake(), sample("first", 1, 42_000), terminal()]);

    const readout = await newLedger().read(REQUEST_ID);

    expect(readout.malformedEvents).toBe(0);
    expect(readout.events.map((event) => event.kind).toSorted()).toEqual([
      "intake",
      "provider-sample",
      "terminal",
    ]);
  });
});

test("replaying the same events after a restart does not double count", async () => {
  await withHome(async (_home, newLedger) => {
    const events = [intake(), sample("first", 1, 42_000), terminal()];
    await newLedger().record(events);

    const replay = await newLedger().record(events);
    const receipt = await newLedger().receipt(REQUEST_ID);

    expect(replay).toEqual({ recorded: 0, duplicates: 3 });
    expect(receipt.charges.amountMicros).toBe(42_000);
    expect(receipt.charges.actualSamples).toBe(1);
    expect(receipt.breakdown.duplicateSamples).toBe(0);
  });
});

test("a distinct retry is recorded even when an earlier attempt is replayed", async () => {
  await withHome(async (_home, newLedger) => {
    const ledger = newLedger();
    await ledger.record([sample("first", 1, 42_000)]);

    const retry = await ledger.record([sample("first", 1, 42_000), sample("second", 2, 42_000)]);
    const receipt = await ledger.receipt(REQUEST_ID);

    expect(retry).toEqual({ recorded: 1, duplicates: 1 });
    expect(receipt.charges.amountMicros).toBe(84_000);
    expect(receipt.breakdown.byWorkKind[0]?.retries).toBe(1);
  });
});

test("a stored row that cannot be read is counted without failing the receipt", async () => {
  await withHome(async (home, newLedger) => {
    await newLedger().record([intake(), terminal()]);
    await withStateTransaction(home, (db) => {
      db.query(
        "INSERT INTO request_usage_events(event_key, request_id, recorded_at, payload) VALUES (?, ?, ?, ?)",
      ).run("corrupt", REQUEST_ID, NOW, "{not json");
    });

    const receipt = await newLedger().receipt(REQUEST_ID);

    expect(receipt.breakdown.malformedSamples).toBe(1);
    expect(receipt.status).toBe("delivered");
    expect(receipt.timing.elapsedMs).toBe(60 * 60_000);
  });
});

test("a row whose stored shape no longer parses is counted, not trusted", async () => {
  await withHome(async (home, newLedger) => {
    await newLedger().record([intake()]);
    await withStateTransaction(home, (db) => {
      db.query(
        "INSERT INTO request_usage_events(event_key, request_id, recorded_at, payload) VALUES (?, ?, ?, ?)",
      ).run("stale", REQUEST_ID, NOW, JSON.stringify({ schemaVersion: 99, eventKey: "stale" }));
    });

    const readout = await newLedger().read(REQUEST_ID);

    expect(readout.events).toHaveLength(1);
    expect(readout.malformedEvents).toBe(1);
  });
});

test("an event carrying unbounded or unknown content is refused before it is stored", async () => {
  await withHome(async (_home, newLedger) => {
    const ledger = newLedger();
    const oversized = { ...sample("first", 1, 42_000) };
    const leaky = {
      ...oversized,
      identity: { ...oversized.identity, model: "x".repeat(200) },
    };
    const extra = { ...oversized, prompt: "the raw user prompt" } as RequestUsageEvent;

    expect(ledger.record([leaky])).rejects.toThrow();
    expect(ledger.record([extra])).rejects.toThrow();
    await expect(ledger.read(REQUEST_ID)).resolves.toEqual({ events: [], malformedEvents: 0 });
  });
});

test("reading needs a durable request identity rather than any string", async () => {
  await withHome(async (_home, newLedger) => {
    expect(newLedger().read("task-1")).rejects.toThrow(TypeError);
  });
});
