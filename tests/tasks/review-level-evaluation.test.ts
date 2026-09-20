import { expect, test } from "bun:test";
import { REVIEW_LEVEL_FIXTURES } from "../../evals/review-levels/fixtures.ts";
import {
  describeReviewLevelEvaluation,
  deterministicSelector,
  evaluateReviewLevelSelection,
  helperSelector,
} from "../../evals/review-levels/metrics.ts";

function deterministicReport() {
  return evaluateReviewLevelSelection({
    arm: "deterministic",
    selector: deterministicSelector,
    fixtures: REVIEW_LEVEL_FIXTURES,
  });
}

test("the fixtures cover low-risk, high-risk, Tagalog, and adversarial changes", () => {
  const kinds = new Set(REVIEW_LEVEL_FIXTURES.map((fixture) => fixture.kind));
  expect([...kinds].sort()).toEqual(["adversarial", "high-risk", "low-risk", "tagalog"]);
  expect(REVIEW_LEVEL_FIXTURES.length).toBeGreaterThanOrEqual(10);
});

test("deterministic selection routes every fixture at or above its required minimum", () => {
  const report = deterministicReport();
  expect(report.falseSafeRouting).toBe(0);
  expect(report.missedSeriousIssues).toEqual([]);
  expect(report.safeAgreement.of).toBe(report.fixtures);
});

test("deterministic selection keeps the light band reachable for contained low-risk changes", () => {
  const report = deterministicReport();
  const light = report.outcomes.filter((outcome) => outcome.selected === "light");
  expect(light.map((outcome) => outcome.fixtureId)).toEqual([
    "low-risk-message-wording",
    "low-risk-test-only",
    "tagalog-contained-cleanup",
  ]);
});

test("Tagalog input changes nothing about how a security change is routed", () => {
  const report = deterministicReport();
  const tagalogSecurity = report.outcomes.find(
    (outcome) => outcome.fixtureId === "tagalog-security-change",
  );
  expect(tagalogSecurity?.selected).toBe("deep");
  expect(tagalogSecurity?.floors).toContain("permissions-security");
});

test("scope growth is recorded as rework rather than as a missed issue", () => {
  const report = deterministicReport();
  const grown = report.outcomes.find((outcome) => outcome.fixtureId === "adversarial-scope-growth");
  expect(grown?.rework).toBe(true);
  expect(grown?.falseSafe).toBe(false);
  expect(grown?.selected).toBe("standard");
  expect(report.rework).toBe(1);
});

test("trusting the helper's recommendation outright produces false-safe routing", () => {
  const report = evaluateReviewLevelSelection({
    arm: "helper-as-selector",
    selector: helperSelector,
    fixtures: REVIEW_LEVEL_FIXTURES,
  });
  expect(report.falseSafeRouting).toBeGreaterThan(0);
  expect(report.missedSeriousIssues.length).toBeGreaterThan(0);
  expect(report.missedSeriousIssues).toContain("an authorization check is skipped");
  expect(report.falseSafeRouting).toBeGreaterThan(deterministicReport().falseSafeRouting);
});

test("unreported latency and cost stay unavailable rather than becoming zero", () => {
  const report = deterministicReport();
  expect(report.wallClockMs).toBe("unavailable");
  expect(report.providerLatencyMs).toBe("unavailable");
  expect(report.inputTokens).toBe("unavailable");
  expect(report.outputTokens).toBe("unavailable");
  expect(report.estimatedCost).toBe("unavailable");

  const withUsage = evaluateReviewLevelSelection({
    arm: "deterministic",
    selector: deterministicSelector,
    fixtures: REVIEW_LEVEL_FIXTURES,
    reported: { inputTokens: 0, providerLatencyMs: 12 },
  });
  expect(withUsage.inputTokens).toBe(0);
  expect(withUsage.providerLatencyMs).toBe(12);
  expect(withUsage.outputTokens).toBe("unavailable");
});

test("the rendered report names the safety count separately from agreement", () => {
  const rendered = describeReviewLevelEvaluation(deterministicReport());
  expect(rendered).toContain("false-safe routing (safety failures, reported separately): 0");
  expect(rendered).toContain("agreement with the required minimum among safely routed fixtures:");
  expect(rendered).toContain("estimated cost: unavailable");
});

test("the harness needs no credential, network, or repository to produce its report", () => {
  const first = describeReviewLevelEvaluation(deterministicReport());
  const second = describeReviewLevelEvaluation(deterministicReport());
  expect(second).toBe(first);
});
