import { expect, test } from "bun:test";
import { summarizeRequestSpend } from "../../src/extension/summary.ts";
import type { RequestSpendReadout } from "../../src/runtime/budget.ts";
import { expectNoIdentifiers } from "../tasks/question.test.ts";

function readout(overrides: Partial<RequestSpendReadout> = {}): RequestSpendReadout {
  return {
    requestId: "req-1",
    cap: { source: "pinned-policy", capMicros: 5_000_000 },
    exposure: {
      committedMicros: 1_000_000,
      reservedMicros: 250_000,
      totalMicros: 1_250_000,
      inFlightReservations: 1,
      settledEstimateReservations: 0,
      unpricedSamples: 0,
      unaccountedSamples: 0,
      unmeasuredTokenSamples: 0,
    },
    charges: {
      currency: "USD",
      amountMicros: 500_000,
      actualSamples: 3,
      estimatedSamples: 0,
      unavailableSamples: 0,
    },
    quota: { entries: [], unavailableSamples: 0 },
    reservations: [],
    approvalState: "absent",
    ...overrides,
  };
}

test("summarizeRequestSpend prints plain dollar amounts, not USD micro-dollar strings", () => {
  const text = summarizeRequestSpend(readout());
  expect(text).toContain("$5.00 from pinned-policy");
  expect(text).toContain("$0.50");
  expect(text).toContain("$1.25");
  expect(text).not.toContain("USD 5.000000");
  expect(text).not.toContain("USD 0.500000");
});

test("a pending spending decision explains itself in plain English and does not lead with the decision id", () => {
  const text = summarizeRequestSpend(
    readout({
      pause: {
        decisionId: "spend-9",
        reason: "cap-would-be-exceeded",
        taskId: "task-9",
        capMicros: 5_000_000,
        policyCapMicros: 5_000_000,
        policyDigest: "digest-1",
        briefRevision: 1,
        committedMicros: 1_000_000,
        reservedMicros: 250_000,
        nextStepMicros: 400_000,
        unpricedSamples: 0,
        unaccountedSamples: 0,
        unmeasuredTokenSamples: 0,
        observedAt: "2030-01-01T00:00:00.000Z",
      },
    }),
  );
  expect(text).toContain("Spending question waiting. The next step won't fit under the cap.");
  expectNoIdentifiers(text, ["spend-9", "task-9"]);
});
