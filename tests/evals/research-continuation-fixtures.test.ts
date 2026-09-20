import { expect, test } from "bun:test";
import {
  loadResearchContinuationFixtures,
  parseResearchContinuationFixtures,
  RESEARCH_CONTINUATION_FIXTURE_SET_VERSION,
} from "../../evals/research-continuation-fixtures.ts";

const FIXTURE_PATH = new URL("../../evals/fixtures/research-continuation.jsonl", import.meta.url)
  .pathname;

const VALID_LINE = JSON.stringify({
  id: "sample",
  fixtureSetVersion: RESEARCH_CONTINUATION_FIXTURE_SET_VERSION,
  description: "A sample fixture.",
  scenario: "explicit-report-only",
  objective: "Research only how the retry loop works; no changes.",
  expectedDisposition: "report-only",
  expectedSelectedBy: "deterministic",
  expectedClassifierReason: "explicit-report-only",
  scoutOutcome: "completed",
  expectedFollowUp: "report-only",
  contentMustContain: [],
  contentMustNotContain: [],
});

test("loads and validates the checked-in research-continuation fixture set", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  expect(fixtures.length).toBeGreaterThan(0);
  expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
  for (const fixture of fixtures) {
    expect(fixture.fixtureSetVersion).toBe(RESEARCH_CONTINUATION_FIXTURE_SET_VERSION);
  }
});

test("covers every required continuation scenario", async () => {
  const requiredScenarios = [
    "explicit-report-only",
    "explicit-implementation",
    "ambiguous-ticket",
    "contradictory-request",
    "jev-not-configured",
    "jev-unavailable",
    "jev-timeout",
    "jev-malformed",
    "jev-low-confidence",
    "scout-completed",
    "scout-blocked",
    "scout-failed",
    "scout-needs-decision",
    "scout-missing-report",
    "scout-stale-generation",
    "scout-restart-compaction",
  ];
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const scenarios = new Set(fixtures.map((fixture) => fixture.scenario));
  for (const scenario of requiredScenarios) {
    expect(scenarios.has(scenario as never)).toBe(true);
  }
});

test("covers every scout stage precedence outcome and both restart fixtures", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const scoutOutcomes = new Set(fixtures.map((fixture) => fixture.scoutOutcome));
  expect(scoutOutcomes).toEqual(
    new Set([
      "completed",
      "blocked",
      "cancelled",
      "needs-decision",
      "missing-report",
      "stale-generation",
    ]),
  );
  expect(fixtures.filter((fixture) => fixture.restartCheck === true)).toHaveLength(2);
  expect(fixtures.some((fixture) => fixture.jevFailureCode === "unavailable")).toBe(true);
  expect(fixtures.some((fixture) => fixture.jevFailureCode === "timeout")).toBe(true);
  expect(fixtures.some((fixture) => fixture.jevFailureCode === "invalid-response")).toBe(true);
  expect(fixtures.some((fixture) => fixture.jevConfigured === false)).toBe(true);
});

test("rejects malformed JSON", () => {
  expect(() => parseResearchContinuationFixtures("not json")).toThrow(/not valid JSON/);
});

test("rejects a fixture set declaring the wrong version", () => {
  const line = JSON.stringify({
    id: "sample",
    fixtureSetVersion: "some-other-version",
    description: "d",
    scenario: "explicit-report-only",
    objective: "Research only, no changes.",
    expectedDisposition: "report-only",
    expectedSelectedBy: "deterministic",
    expectedClassifierReason: "explicit-report-only",
    scoutOutcome: "completed",
    expectedFollowUp: "report-only",
  });
  expect(() => parseResearchContinuationFixtures(line)).toThrow(/declares version/);
});

test("rejects duplicate fixture ids", () => {
  expect(() => parseResearchContinuationFixtures(`${VALID_LINE}\n${VALID_LINE}`)).toThrow(
    /duplicate fixture id/,
  );
});

test("rejects a fixture declaring both a response and a failure code", () => {
  const line = JSON.stringify({
    id: "sample",
    fixtureSetVersion: RESEARCH_CONTINUATION_FIXTURE_SET_VERSION,
    description: "d",
    scenario: "ambiguous-ticket",
    objective: "Look into this ticket.",
    jevResponse: {
      model: "jev-1.13.0",
      answers: {
        continuation: {
          type: "choice",
          choice: "ask-intent",
          confidence: 1,
          probabilities: { "ask-intent": 1 },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    jevFailureCode: "timeout",
    expectedDisposition: "ask-intent",
    expectedSelectedBy: "deterministic",
    expectedClassifierReason: "jev-timeout",
    scoutOutcome: "completed",
    expectedFollowUp: "ask-intent",
  });
  expect(() => parseResearchContinuationFixtures(line)).toThrow(/mutually exclusive/);
});

test("rejects an empty fixture set", () => {
  expect(() => parseResearchContinuationFixtures("\n\n")).toThrow(/empty/);
});
