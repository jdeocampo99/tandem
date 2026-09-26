import { expect, test } from "bun:test";
import type { TaskRecord } from "../../src/contracts.ts";
import type {
  DurableExecutionRouting,
  DurableJob,
  DurableOperation,
  RuntimePresentation,
  RuntimeTaskState,
} from "../../src/runtime/schema.ts";
import { JEV_PRICING_SNAPSHOT, type UsageRecord } from "../../src/runtime/usage.ts";
import { parseRequestUsageEvent } from "../../src/runtime/usage-codec.ts";
import {
  providerSampleEvent,
  requestIntakeEvent,
  requestTerminalEvent,
  settledWorkEvents,
} from "../../src/runtime/usage-events.ts";

const REQUEST_ID = "req-accounting";

function operation(overrides: Partial<DurableOperation> = {}): DurableOperation {
  return {
    schemaVersion: 1,
    id: "op-1",
    taskId: "task-1",
    kind: "implementation",
    role: "implementer",
    generation: 2,
    inputHead: "a".repeat(40),
    policyDigest: "digest",
    instructionRevision: 1,
    jobId: "job-1",
    phase: "completed",
    fencingRevision: 1,
    claimOwner: "session:1",
    createdAt: "2030-01-01T00:10:00.000Z",
    effects: [],
    resultConsumedAt: "2030-01-01T00:40:00.000Z",
    ...overrides,
  };
}

function routing(overrides: Partial<DurableExecutionRouting> = {}): DurableExecutionRouting {
  return {
    schemaVersion: 1,
    decisionId: "decision-1",
    basis: "comparable-reassignment",
    taskId: "task-1",
    jobId: "job-1",
    operationId: "op-1",
    role: "implementer",
    generation: 2,
    attempt: 1,
    policyDigest: "digest",
    inputHead: "a".repeat(40),
    provider: "anthropic",
    selector: "anthropic/claude-routed",
    thinking: "high",
    replaces: { selector: "anthropic/claude-pinned", thinking: "high" },
    evidence: {
      source: "catalogue-read",
      enabledProviders: ["anthropic"],
      usageSource: "request-ledger",
    },
    resolvedAt: "2030-01-01T00:09:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<DurableJob> = {}): DurableJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 2,
    role: "implementer",
    kind: "worker",
    cwd: "/tmp/worktree",
    jobPath: "/tmp/job.json",
    resultPath: "/tmp/result.json",
    attempt: 1,
    phase: "consumed",
    launchAttempted: true,
    createdAt: "2030-01-01T00:10:00.000Z",
    consumedAt: "2030-01-01T00:40:00.000Z",
    operationId: "op-1",
    ...overrides,
  };
}

/** A job whose result was never consumed, so the operation it belongs to has no durable end. */
function unconsumedJob(id: string): DurableJob {
  const { consumedAt: _consumedAt, ...rest } = job({ id, phase: "running" });
  return rest;
}

function runtime(overrides: Partial<RuntimeTaskState> = {}): RuntimeTaskState {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    sourceCheckpoint: {
      head: "b".repeat(40),
      base: "main",
      diff: "",
      dirty: false,
      unmerged: false,
    },
    taskName: "task-1",
    endpoints: [],
    jobs: [job()],
    ...overrides,
  };
}

function terminalTask(
  stage: TaskRecord["stage"],
  pullRequest?: TaskRecord["pullRequest"],
): Pick<TaskRecord, "id" | "stage" | "generation" | "updatedAt" | "pullRequest"> {
  return {
    id: "task-1",
    stage,
    generation: 2,
    updatedAt: "2030-01-01T01:00:00.000Z",
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

function jevUsage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: 1,
    provider: "typesafe",
    model: "jev-1.13.0",
    inputTokens: 1_000_000,
    outputTokens: 500,
    durationMs: 1_200,
    timedOut: false,
    reason: "review-level-assistance-answered",
    pricing: JEV_PRICING_SNAPSHOT,
    ...overrides,
  };
}

test("only settled operations become accounting facts", () => {
  const events = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({
      operation: operation({ id: "op-2", jobId: "job-2", phase: "running" }),
      operationHistory: [operation()],
      jobs: [job(), unconsumedJob("job-2")],
    }),
    presentations: [],
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.identity.operationId).toBe("op-1");
  expect(events[0]?.startedAt).toBe("2030-01-01T00:10:00.000Z");
  expect(events[0]?.endedAt).toBe("2030-01-01T00:40:00.000Z");
});

test("a work span exposes the durable role, attempt, and job identities", () => {
  const [event] = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({
      operationHistory: [operation({ kind: "verification", role: "verifier" })],
      jobs: [job({ attempt: 3, role: "verifier" })],
    }),
    presentations: [],
  });

  expect(event?.workKind).toBe("verification");
  expect(event?.identity).toMatchObject({
    requestId: REQUEST_ID,
    taskId: "task-1",
    jobId: "job-1",
    operationId: "op-1",
    generation: 2,
    attempt: 3,
    role: "verifier",
  });
});

test("scout and fix work is accounted as research and implementation", () => {
  const events = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({
      operationHistory: [
        operation({ id: "op-scout", jobId: "job-scout", kind: "scout", role: "scout" }),
        operation({ id: "op-fix", jobId: "job-fix", kind: "fix" }),
      ],
      jobs: [job({ id: "job-scout" }), job({ id: "job-fix" })],
    }),
    presentations: [],
  });

  expect(events.map((event) => event.workKind)).toEqual(["research", "implementation"]);
});

test("presentation work run under the request is accounted too", () => {
  const presentation: RuntimePresentation = {
    schemaVersion: 1,
    id: "presentation-1",
    taskId: "task-1",
    recordPath: "/tmp/presentation.json",
    operationHistory: [
      operation({
        id: "op-present",
        jobId: "job-present",
        kind: "presentation",
        role: "presentation",
      }),
    ],
    job: job({ id: "job-present", role: "presentation" }),
  };

  const events = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({ operationHistory: [], jobs: [] }),
    presentations: [presentation],
  });

  expect(events.map((event) => event.workKind)).toEqual(["presentation"]);
});

test("re-deriving the same records reproduces the same event identity", () => {
  const observation = {
    requestId: REQUEST_ID,
    runtime: runtime({ operationHistory: [operation()] }),
    presentations: [],
  };

  const first = settledWorkEvents(observation);
  const second = settledWorkEvents(observation);

  expect(first[0]?.eventKey).toBe(second[0]?.eventKey ?? "");
});

test("a distinct retry keys differently from the attempt it replaced", () => {
  const [first] = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({ operationHistory: [operation({ phase: "failed" })] }),
    presentations: [],
  });
  const [retry] = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({
      operationHistory: [operation({ id: "op-2", jobId: "job-2" })],
      jobs: [job({ id: "job-2", attempt: 2 })],
    }),
    presentations: [],
  });

  expect(first?.eventKey).not.toBe(retry?.eventKey ?? "");
  expect(retry?.identity.attempt).toBe(2);
});

test("a completed or ready task delivers the request; a later publish or merge adds nothing new", () => {
  const pullRequest = (state: "draft" | "open" | "merged") => ({
    repository: "owner/app",
    number: 7,
    state,
    head: "abc",
    base: "main",
  });
  expect(requestTerminalEvent(REQUEST_ID, terminalTask("completed"))?.outcome).toBe("delivered");
  expect(requestTerminalEvent(REQUEST_ID, terminalTask("cancelled"))?.outcome).toBe("cancelled");
  expect(requestTerminalEvent(REQUEST_ID, terminalTask("merged"))).toBeUndefined();
  expect(requestTerminalEvent(REQUEST_ID, terminalTask("implementing"))).toBeUndefined();
  const ready = requestTerminalEvent(REQUEST_ID, terminalTask("ready", pullRequest("draft")));
  const published = requestTerminalEvent(REQUEST_ID, terminalTask("ready", pullRequest("open")));
  const merged = requestTerminalEvent(REQUEST_ID, terminalTask("merged", pullRequest("merged")));
  expect(ready?.outcome).toBe("delivered");
  expect(requestTerminalEvent(REQUEST_ID, terminalTask("ready"))?.outcome).toBe("delivered");
  // Same identity, so the ledger keeps the ready moment and ignores the later publish and merge.
  expect(published?.eventKey).toBe(ready?.eventKey);
  expect(merged?.eventKey).toBe(ready?.eventKey);
});

test("intake is the durable brief creation, not the first worker launch", () => {
  const event = requestIntakeEvent({ id: REQUEST_ID, createdAt: "2030-01-01T00:00:00.000Z" });

  expect(event.kind).toBe("intake");
  expect(event.startedAt).toBe("2030-01-01T00:00:00.000Z");
  expect(event.endedAt).toBe("2030-01-01T00:00:00.000Z");
});

test("a reported provider sample carries actual tokens and an attributable charge", () => {
  const event = providerSampleEvent({
    requestId: REQUEST_ID,
    workKind: "review",
    usage: jevUsage(),
    startedAt: "2030-01-01T00:20:00.000Z",
    endedAt: "2030-01-01T00:20:01.200Z",
    sampleIdentity: "assistance-digest",
    taskId: "task-1",
    generation: 2,
    role: "reviewer",
  });

  expect(event?.tokens).toEqual({
    provenance: "actual",
    inputTokens: 1_000_000,
    outputTokens: 500,
  });
  expect(event?.charge).toMatchObject({
    provenance: "actual",
    currency: "USD",
    amountMicros: 42_000,
    pricingSource: "typesafe-jev-published-rate",
  });
  expect(event?.quota).toEqual({ provenance: "unavailable", reason: "no-quota-contract" });
});

test("a provider that never answered reports unavailable rather than zero", () => {
  const event = providerSampleEvent({
    requestId: REQUEST_ID,
    workKind: "review",
    usage: jevUsage({ inputTokens: "unavailable", outputTokens: "unavailable", timedOut: true }),
    startedAt: "2030-01-01T00:20:00.000Z",
    endedAt: "2030-01-01T00:20:02.000Z",
    sampleIdentity: "assistance-digest",
  });

  expect(event?.status).toBe("timed-out");
  expect(event?.tokens).toEqual({ provenance: "unavailable", reason: "provider-unavailable" });
  expect(event?.charge).toEqual({ provenance: "unavailable", reason: "provider-unavailable" });
});

test("child agent work states that no provider boundary reported tokens or price", () => {
  const [event] = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({ operationHistory: [operation()] }),
    presentations: [],
  });

  expect(event?.tokens).toEqual({ provenance: "unavailable", reason: "no-provider-boundary" });
  expect(event?.charge).toEqual({ provenance: "unavailable", reason: "no-provider-boundary" });
});

test("a settled worker's token tally becomes actual tokens and an estimated list-price charge", () => {
  const measured = {
    requestId: REQUEST_ID,
    runtime: runtime({ operationHistory: [operation()], jobs: [job()] }),
    presentations: [],
  };
  const [withTally] = settledWorkEvents({
    ...measured,
    tallies: new Map([["job-1", { inputTokens: 120_000, outputTokens: 8_000, costUsd: 0.4 }]]),
  });
  const [withoutTally] = settledWorkEvents(measured);

  expect(withTally?.tokens).toEqual({
    provenance: "actual",
    inputTokens: 120_000,
    outputTokens: 8_000,
  });
  expect(withTally?.charge).toMatchObject({ provenance: "estimated", amountMicros: 400_000 });
  expect(withoutTally?.tokens).toEqual({
    provenance: "unavailable",
    reason: "no-provider-boundary",
  });
  // The tally never changes the span's identity, so a later pass cannot record it twice.
  expect(withTally?.eventKey).toBe(withoutTally?.eventKey);
});

test("a work span names the provider and model its operation was routed to at admission", () => {
  const [event] = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({ operationHistory: [operation({ routing: routing() })] }),
    presentations: [],
  });

  expect(event?.identity).toMatchObject({
    provider: "anthropic",
    model: "anthropic/claude-routed",
  });
});

test("validation work and a legacy operation without routing carry no model", () => {
  const events = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({
      operationHistory: [
        operation({
          id: "op-validate",
          jobId: "job-validate",
          kind: "validation",
          role: "validation",
        }),
        operation(),
      ],
      jobs: [job({ id: "job-validate", role: "validation", kind: "validation" }), job()],
    }),
    presentations: [],
  });

  expect(
    events.map((event) => [event.workKind, event.identity.model, event.identity.provider]),
  ).toEqual([
    ["validation", undefined, undefined],
    ["implementation", undefined, undefined],
  ]);
});

test("attributing the model keeps a span's event key, so an earlier record is not counted twice", () => {
  const [unattributed] = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({ operationHistory: [operation()] }),
    presentations: [],
  });
  const [attributed] = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({ operationHistory: [operation({ routing: routing() })] }),
    presentations: [],
  });

  expect(attributed?.identity.model).toBe("anthropic/claude-routed");
  expect(attributed?.eventKey).toBe(unattributed?.eventKey ?? "");
});

test("a model name too long to store as a label is left off rather than failing the record", () => {
  const [event] = settledWorkEvents({
    requestId: REQUEST_ID,
    runtime: runtime({
      operationHistory: [operation({ routing: routing({ selector: "m".repeat(500) }) })],
    }),
    presentations: [],
  });

  expect(event?.identity.provider).toBe("anthropic");
  expect(event?.identity.model).toBeUndefined();
  expect(() => parseRequestUsageEvent(event)).not.toThrow();
});
