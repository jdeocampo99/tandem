import { expect, test } from "bun:test";
import type { RequestUsageEvent } from "../../src/runtime/usage.ts";
import { limitMeter, taskUsageView, usageView } from "../../src/runtime/usage-view.ts";

const now = "2030-01-02T12:00:00Z";
function event(key: string, overrides: Partial<RequestUsageEvent> = {}): RequestUsageEvent {
  return {
    schemaVersion: 1,
    eventKey: key,
    kind: "work",
    workKind: "implementation",
    identity: { taskId: "task-1", provider: "claude-code", model: "opus" },
    startedAt: "2030-01-02T11:00:00Z",
    endedAt: now,
    status: "succeeded",
    tokens: { provenance: "unavailable", reason: "provider-did-not-report" },
    charge: {
      provenance: "estimated",
      currency: "USD",
      amountMicros: 2_000_000,
      pricingSource: "list-price",
      pricingVersion: 1,
    },
    quota: { provenance: "unavailable", reason: "no-quota-contract" },
    ...overrides,
  };
}

test("usage shows limits first, deduplicates ledger scopes and keeps unpriced samples visible", () => {
  const a = event("a");
  const b = event("b", {
    workKind: "review",
    startedAt: "2030-01-02T11:30:00Z",
    charge: { provenance: "unavailable", reason: "provider-did-not-report" },
  });
  const input = {
    now,
    todayStart: "2030-01-02T00:00:00Z",
    weekStart: "2029-12-31T00:00:00Z",
    limits: [
      {
        provider: "anthropic",
        account: "personal",
        window: "five-hour" as const,
        label: "5-hour",
        remainingPercent: 62,
        resetsAt: "2030-01-02T14:14:00Z",
        fetchedAt: now,
      },
    ],
    readout: { events: [a, a, b], malformedEvents: 1 },
    finished: [
      { taskId: "task-1", at: now },
      { taskId: "task-1", at: now },
    ],
  };
  const view = usageView(input);
  expect(view.limits[0]?.resetInMs).toBe(8_040_000);
  expect(view.today).toEqual({
    costMicros: 2_000_000,
    unpricedSamples: 1,
    agentMs: 5_400_000,
    tasksDone: 1,
  });
  expect(view.byModel[0]?.today.costMicros).toBe(2_000_000);
  expect(view.byStage.find((row) => row.stage === "review")?.todayMs).toBe(1_800_000);
  expect(view.malformedEvents).toBe(1);
});

test("usage clips work crossing midnight and keeps older weekly cost out of today", () => {
  const a = event("a", { startedAt: "2030-01-01T23:30:00Z", endedAt: "2030-01-02T00:30:00Z" });
  const b = event("b", { endedAt: "2030-01-01T11:00:00Z", startedAt: "2030-01-01T10:00:00Z" });
  const view = usageView({
    now,
    todayStart: "2030-01-02T00:00:00Z",
    weekStart: "2029-12-31T00:00:00Z",
    limits: [],
    readout: { events: [a, b], malformedEvents: 0 },
    finished: [],
  });
  expect(view.today.agentMs).toBe(1_800_000);
  expect(view.week.agentMs).toBe(7_200_000);
  expect(view.today.costMicros).toBe(2_000_000);
  expect(view.week.costMicros).toBe(4_000_000);
});

test("unreported resets and unrecorded task cost stay explicitly unavailable", () => {
  expect(
    limitMeter(
      {
        provider: "codex",
        account: "team",
        window: "weekly",
        label: "Week",
        remainingPercent: "unavailable",
        fetchedAt: now,
      },
      now,
    ).resetInMs,
  ).toBe("unavailable");
  expect(
    taskUsageView("task-1", {
      events: [event("a", { identity: { taskId: "task-other" } })],
      malformedEvents: 0,
    }).recorded,
  ).toBe(false);
});

test("research credited to both a task and a request counts its durable operation once", () => {
  const a = event("task-scope", {
    workKind: "research",
    identity: {
      taskId: "task-scout",
      operationId: "op-scout",
      jobId: "job-scout",
      generation: 0,
      attempt: 1,
      provider: "codex",
      model: "luna",
    },
  });
  const credited = {
    ...a,
    eventKey: "request-scope",
    identity: { ...a.identity, requestId: "req-implementation" },
  };
  const view = usageView({
    now,
    todayStart: "2030-01-02T00:00:00Z",
    weekStart: "2029-12-31T00:00:00Z",
    limits: [],
    readout: { events: [a, credited], malformedEvents: 0 },
    finished: [],
  });
  expect(view.today.costMicros).toBe(2_000_000);
  expect(view.today.agentMs).toBe(3_600_000);
});
