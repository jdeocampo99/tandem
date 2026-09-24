import { expect, test } from "bun:test";
import {
  REQUEST_USAGE_EVENT_SCHEMA_VERSION,
  type RequestUsageEvent,
  requestUsageEventKey,
} from "../../src/runtime/usage.ts";
import {
  buildRequestUsageReceipt,
  coordinatorShare,
  renderRequestReceiptTable,
} from "../../src/runtime/usage-receipt.ts";

const REQUEST_ID = "req-receipt";

function at(minutes: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, minutes)).toISOString();
}

function intake(minutes = 0): RequestUsageEvent {
  return point("intake", minutes, undefined);
}

function terminal(minutes: number, outcome: "delivered" | "cancelled"): RequestUsageEvent {
  return point("terminal", minutes, outcome);
}

function point(
  kind: "intake" | "terminal",
  minutes: number,
  outcome: "delivered" | "cancelled" | undefined,
): RequestUsageEvent {
  const identity = { requestId: REQUEST_ID };
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({ kind, identity, discriminator: outcome ?? "created" }),
    kind,
    workKind: "coordinator",
    identity,
    startedAt: at(minutes),
    endedAt: at(minutes),
    status: outcome === "cancelled" ? "cancelled" : "succeeded",
    tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
    charge: { provenance: "unavailable", reason: "no-provider-boundary" },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
    ...(outcome === undefined ? {} : { outcome }),
  };
}

function work(
  operationId: string,
  fromMinutes: number,
  toMinutes: number,
  overrides: Partial<Omit<RequestUsageEvent, "identity">> & { readonly attempt?: number } = {},
): RequestUsageEvent {
  const { attempt, ...eventOverrides } = overrides;
  const identity = {
    requestId: REQUEST_ID,
    taskId: "task-1",
    operationId,
    ...(attempt === undefined ? {} : { attempt }),
  };
  return {
    schemaVersion: REQUEST_USAGE_EVENT_SCHEMA_VERSION,
    eventKey: requestUsageEventKey({ kind: "work", identity, discriminator: "settled" }),
    kind: "work",
    workKind: "implementation",
    identity,
    startedAt: at(fromMinutes),
    endedAt: at(toMinutes),
    status: "succeeded",
    tokens: { provenance: "unavailable", reason: "no-provider-boundary" },
    charge: { provenance: "unavailable", reason: "no-provider-boundary" },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
    ...eventOverrides,
  };
}

function pricedSample(
  sampleIdentity: string,
  fromMinutes: number,
  toMinutes: number,
  amountMicros: number,
): RequestUsageEvent {
  const identity = { requestId: REQUEST_ID, provider: "typesafe", model: "jev-1.13.0" };
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
    startedAt: at(fromMinutes),
    endedAt: at(toMinutes),
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

function receiptOf(events: readonly RequestUsageEvent[], malformedEvents = 0) {
  return buildRequestUsageReceipt(REQUEST_ID, { events, malformedEvents });
}

const MINUTE_MS = 60_000;

test("concurrent work does not inflate elapsed time", () => {
  const receipt = receiptOf([
    intake(),
    work("op-1", 10, 40),
    work("op-2", 20, 50),
    terminal(60, "delivered"),
  ]);

  expect(receipt.timing.elapsedMs).toBe(60 * MINUTE_MS);
  expect(receipt.timing.activeMs).toBe(40 * MINUTE_MS);
  expect(receipt.timing.overlappingMs).toBe(20 * MINUTE_MS);
  expect(receipt.timing.waitingMs).toBe(20 * MINUTE_MS);
});

test("research, approval, and recovery waits stay inside the elapsed wall time", () => {
  const receipt = receiptOf([intake(), work("op-1", 45, 50), terminal(60, "delivered")]);

  expect(receipt.timing.elapsedMs).toBe(60 * MINUTE_MS);
  expect(receipt.timing.waitingMs).toBe(55 * MINUTE_MS);
});

test("a request with no terminal fact is open and reports no elapsed time", () => {
  const receipt = receiptOf([intake(), work("op-1", 10, 20)]);

  expect(receipt.status).toBe("open");
  expect(receipt.timing.elapsedMs).toBe("unavailable");
  expect(receipt.timing.waitingMs).toBe("unavailable");
  expect(receipt.timing.terminalAt).toBe("unavailable");
});

test("unavailable tokens and charges are counted, never summed as zero", () => {
  const receipt = receiptOf([
    intake(),
    work("op-1", 10, 20),
    pricedSample("first", 12, 13, 42_000),
    terminal(30, "delivered"),
  ]);

  expect(receipt.charges.amountMicros).toBe(42_000);
  expect(receipt.charges.actualSamples).toBe(1);
  expect(receipt.charges.unavailableSamples).toBe(1);
  expect(receipt.tokens.actualInputTokens).toBe(1_000);
  expect(receipt.tokens.unavailableSamples).toBe(1);
  expect(receipt.quota.entries).toEqual([]);
  expect(receipt.quota.unavailableSamples).toBe(2);
});

test("point events are not counted as samples with unknown cost", () => {
  const receipt = receiptOf([intake(), terminal(30, "delivered")]);

  expect(receipt.charges.unavailableSamples).toBe(0);
  expect(receipt.tokens.unavailableSamples).toBe(0);
  expect(receipt.breakdown.byWorkKind).toEqual([]);
});

test("replaying the same receipt does not double count", () => {
  const sample = pricedSample("first", 12, 13, 42_000);
  const receipt = receiptOf([intake(), sample, sample, terminal(30, "delivered")]);

  expect(receipt.charges.amountMicros).toBe(42_000);
  expect(receipt.charges.actualSamples).toBe(1);
  expect(receipt.breakdown.duplicateSamples).toBe(1);
});

test("a distinct retry stays attributable after a duplicate is dropped", () => {
  const receipt = receiptOf([
    intake(),
    work("op-1", 10, 20, { status: "failed" }),
    work("op-1", 10, 20, { status: "failed" }),
    work("op-2", 20, 30, { attempt: 2 }),
    terminal(40, "delivered"),
  ]);

  const implementation = receipt.breakdown.byWorkKind.find(
    (total) => total.workKind === "implementation",
  );
  expect(receipt.breakdown.duplicateSamples).toBe(1);
  expect(implementation?.sampleCount).toBe(2);
  expect(implementation?.failures).toBe(1);
  expect(implementation?.retries).toBe(1);
});

test("a late cost receipt updates totals without moving the recorded delivery time", () => {
  const delivered = [intake(), work("op-1", 10, 20), terminal(30, "delivered")];
  const before = receiptOf(delivered);
  const after = receiptOf([...delivered, pricedSample("late", 45, 46, 42_000)]);

  expect(after.timing.elapsedMs).toBe(before.timing.elapsedMs);
  expect(after.timing.terminalAt).toBe(before.timing.terminalAt);
  expect(after.timing.activeMs).toBe(before.timing.activeMs);
  expect(after.charges.amountMicros).toBe(42_000);
});

test("rows that could not be read stay visible without failing the receipt", () => {
  const receipt = receiptOf([intake(), work("op-1", 10, 20), terminal(30, "delivered")], 2);

  expect(receipt.breakdown.malformedSamples).toBe(2);
  expect(receipt.status).toBe("delivered");
  expect(receipt.timing.elapsedMs).toBe(30 * MINUTE_MS);
});

test("the breakdown groups by work kind and by provider", () => {
  const receipt = receiptOf([
    intake(),
    work("op-1", 10, 20),
    work("op-2", 20, 25, { workKind: "review" }),
    pricedSample("first", 21, 22, 42_000),
    terminal(30, "delivered"),
  ]);

  expect(receipt.breakdown.byWorkKind.map((total) => total.workKind)).toEqual([
    "implementation",
    "review",
  ]);
  expect(receipt.breakdown.byProvider).toEqual([
    expect.objectContaining({ provider: "typesafe", model: "jev-1.13.0", sampleCount: 1 }),
  ]);
  expect(receipt.breakdown.samples.every((sample) => sample.kind !== "intake")).toBe(true);
});

test("the coordinator's shared line counts only its replies in this repository and window", () => {
  const entry = (minutes: number, repoPath: string) => ({
    at: at(minutes),
    repoPath,
    inputTokens: 1_000,
    outputTokens: 500,
    costUsd: 0.01,
  });
  const share = coordinatorShare(
    [entry(5, "/app"), entry(50, "/app"), entry(200, "/app"), entry(10, "/other"), "garbage"],
    "/app",
    at(0),
    at(120),
  );

  expect(share).toEqual({ replies: 2, tokens: 3_000, costMicros: 20_000 });
});

test("the receipt table lists each stage, the coordinator apart, and the wall time", () => {
  const measured = (tokens: number, costMicros: number) => ({
    tokens: { provenance: "actual" as const, inputTokens: tokens, outputTokens: 0 },
    charge: {
      provenance: "estimated" as const,
      currency: "USD" as const,
      amountMicros: costMicros,
      pricingSource: "omp-model-price-table",
      pricingVersion: 1,
    },
  });
  const receipt = receiptOf([
    intake(0),
    work("research", 0, 12, { workKind: "research", ...measured(180_000, 400_000) }),
    work("build-1", 30, 60, measured(700_000, 1_200_000)),
    work("build-2", 70, 81, measured(500_000, 900_000)),
    work("review", 81, 89, { workKind: "review", ...measured(300_000, 550_000) }),
    work("checks", 89, 95, { workKind: "validation" }),
    terminal(130, "delivered"),
  ]);

  const table = renderRequestReceiptTable({
    ...receipt,
    coordinator: { replies: 40, tokens: 90_000, costMicros: 300_000 },
  });

  expect(table.split("\n")).toEqual([
    "Research           12m   180k tokens  ~$0.40",
    "Implementation     41m   1.2M tokens  ~$2.10  (2 runs)",
    "Review              8m   300k tokens  ~$0.55",
    "Validation          6m  not measured",
    "Coordinator     shared    90k tokens  ~$0.30  (also serves other requests)",
    "Total: 2h10m elapsed (1h07m working, 1h03m waiting)",
    "Costs are OMP's list-price estimates, not what a subscription is billed.",
  ]);
});

test("an open request's receipt names its goal and measures up to now", () => {
  const receipt = receiptOf([intake(0), work("research", 0, 12, { workKind: "research" })]);

  const table = renderRequestReceiptTable({
    ...receipt,
    goal: "Make Settings familiar and consistent",
    asOf: at(80),
  });

  expect(table.split("\n")).toEqual([
    "Make Settings familiar and consistent",
    "Research  12m  not measured",
    "So far: 1h20m since the request started (12m working)",
    "Still open: work that is running now is added when it finishes.",
    "Costs are OMP's list-price estimates, not what a subscription is billed.",
  ]);
});
