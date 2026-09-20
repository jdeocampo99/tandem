import { expect, test } from "bun:test";
import {
  evaluateNetBenefit,
  type NetBenefitArm,
  type NetBenefitInput,
} from "../../evals/decision.ts";

function arm(overrides: Partial<NetBenefitArm> = {}): NetBenefitArm {
  return {
    correctRate: 1,
    safeRate: 1,
    totalDurationMsP50: 45_000,
    totalDurationMsP95: 50_000,
    costUsd: "unavailable",
    reworkCount: 0,
    ...overrides,
  };
}

test("rejects a faster, cheaper treatment because of a safety failure", () => {
  const input: NetBenefitInput = {
    falseDirectRouteCount: 1,
    control: arm({ costUsd: 0.01 }),
    treatment: arm({
      totalDurationMsP50: 900,
      totalDurationMsP95: 1_500,
      costUsd: 0.0001,
    }),
  };
  const decision = evaluateNetBenefit(input);
  expect(decision.recommendation).toBe("reject");
  expect(decision.rejectionReasons.some((reason) => /false direct route/i.test(reason))).toBe(true);
  const safety = decision.factors.find((factor) => factor.dimension === "safety");
  expect(safety?.regressed).toBe(true);
});

test("rejects a treatment whose fallback overhead makes the whole task slower", () => {
  const input: NetBenefitInput = {
    falseDirectRouteCount: 0,
    control: arm({ totalDurationMsP50: 45_000, totalDurationMsP95: 50_000 }),
    treatment: arm({
      totalDurationMsP50: 46_500,
      totalDurationMsP95: 52_000,
      costUsd: 0.000_007_5,
    }),
  };
  const decision = evaluateNetBenefit(input);
  expect(decision.recommendation).toBe("reject");
  expect(decision.rejectionReasons.some((reason) => /slower/i.test(reason))).toBe(true);
  const time = decision.factors.find((factor) => factor.dimension === "time");
  expect(time?.regressed).toBe(true);
});

test("accepts a treatment that is faster, cheaper, and at least as correct, safe, and rework-free", () => {
  const input: NetBenefitInput = {
    falseDirectRouteCount: 0,
    control: arm({ totalDurationMsP50: 45_000, totalDurationMsP95: 50_000, reworkCount: 1 }),
    treatment: arm({
      totalDurationMsP50: 900,
      totalDurationMsP95: 1_500,
      costUsd: 0.000_007_5,
      reworkCount: 0,
    }),
  };
  const decision = evaluateNetBenefit(input);
  expect(decision.recommendation).toBe("adopt");
  expect(decision.rejectionReasons).toEqual([]);
  expect(decision.factors.every((factor) => !factor.regressed)).toBe(true);
});

test("rejects a correctness regression even when everything else favors treatment", () => {
  const input: NetBenefitInput = {
    falseDirectRouteCount: 0,
    control: arm({ correctRate: 1 }),
    treatment: arm({
      correctRate: 0.9,
      totalDurationMsP50: 900,
      totalDurationMsP95: 1_500,
      costUsd: 0.000_007_5,
    }),
  };
  const decision = evaluateNetBenefit(input);
  expect(decision.recommendation).toBe("reject");
  expect(decision.rejectionReasons.some((reason) => /correctness/i.test(reason))).toBe(true);
});

test("treats an unavailable treatment correctness rate as a regression against a known control rate", () => {
  const input: NetBenefitInput = {
    falseDirectRouteCount: 0,
    control: arm({ correctRate: 1 }),
    treatment: arm({ correctRate: "unavailable" }),
  };
  const decision = evaluateNetBenefit(input);
  expect(decision.recommendation).toBe("reject");
});

test("skips cost comparison rather than treating an unavailable cost as free", () => {
  const input: NetBenefitInput = {
    falseDirectRouteCount: 0,
    control: arm({ costUsd: "unavailable" }),
    treatment: arm({
      totalDurationMsP50: 900,
      totalDurationMsP95: 1_500,
      costUsd: 5, // deliberately large; must not reject since control's cost cannot be compared
    }),
  };
  const decision = evaluateNetBenefit(input);
  expect(decision.recommendation).toBe("adopt");
  const cost = decision.factors.find((factor) => factor.dimension === "cost");
  expect(cost?.regressed).toBe(false);
});
