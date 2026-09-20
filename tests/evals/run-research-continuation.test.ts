import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadResearchContinuationFixtures } from "../../evals/research-continuation-fixtures.ts";
import { runFakeResearchContinuationFixtures } from "../../evals/run-research-continuation.ts";
import { summarizeResearchContinuationRun } from "../../evals/summarize.ts";
import { writeEvalResults } from "../../evals/write-results.ts";

const FIXTURE_PATH = new URL("../../evals/fixtures/research-continuation.jsonl", import.meta.url)
  .pathname;

/**
 * The one fixture deliberately crafted with a miscalibrated recorded Jev response: a report-only
 * request paired with a fake answer that confidently (and wrongly) classifies it as wanting an
 * implementation interview. It exists to prove the false-interview-rate metric actually detects a
 * quality miss, so every other fixture is expected to match its own ground truth exactly.
 */
const ADVERSARIAL_FIXTURE_ID = "adversarial-miscalibrated-report-only";

test("fake mode runs every fixture deterministically with no network and no credentials", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const first = await runFakeResearchContinuationFixtures(fixtures);
  const second = await runFakeResearchContinuationFixtures(fixtures);
  // A full comparison, including every nested duration: fake mode injects a fixed clock into
  // classifyResearchContinuation (so its own duration and its nested usage record's duration both
  // come from it), so two runs over the same fixtures are byte-identical, not merely equal once
  // durations are set aside.
  expect(first).toEqual(second);
});

test("fake mode's injected clock makes every duration, including the nested usage record's, exactly zero", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const outcomes = await runFakeResearchContinuationFixtures(fixtures);
  for (const outcome of outcomes) {
    expect(outcome.durationMs, `${outcome.fixtureId} durationMs`).toBe(0);
    if (outcome.usage !== undefined) {
      expect(outcome.usage.durationMs, `${outcome.fixtureId} usage.durationMs`).toBe(0);
    }
  }
});

test("every fixture except the adversarial one reaches its expected disposition and follow-up", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const outcomes = await runFakeResearchContinuationFixtures(fixtures);
  for (const outcome of outcomes) {
    if (outcome.fixtureId === ADVERSARIAL_FIXTURE_ID) continue;
    const fixture = fixtures.find((entry) => entry.id === outcome.fixtureId);
    if (fixture === undefined) throw new Error(`no fixture for outcome ${outcome.fixtureId}`);
    expect(outcome.actualDisposition, `${outcome.fixtureId} disposition`).toBe(
      outcome.expectedDisposition,
    );
    expect(outcome.actualSelectedBy, `${outcome.fixtureId} selectedBy`).toBe(
      outcome.expectedSelectedBy,
    );
    expect(outcome.classifierReason, `${outcome.fixtureId} reason`).toBe(
      fixture.expectedClassifierReason,
    );
    expect(outcome.actualFollowUp, `${outcome.fixtureId} followUp`).toBe(outcome.expectedFollowUp);
    expect(outcome.actualOverride, `${outcome.fixtureId} override`).toEqual(
      outcome.expectedOverride,
    );
    expect(outcome.jevCallMade, `${outcome.fixtureId} jev call discipline`).toBe(
      outcome.jevCallExpected,
    );
    expect(outcome.contentFailures, `${outcome.fixtureId} content invariants`).toEqual([]);
    expect(outcome.safetyFailure, `${outcome.fixtureId} safety`).toBe(false);
  }
});

test("the adversarial fixture demonstrates a detected false interview", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const outcomes = await runFakeResearchContinuationFixtures(fixtures);
  const adversarial = outcomes.find((outcome) => outcome.fixtureId === ADVERSARIAL_FIXTURE_ID);
  expect(adversarial?.expectedFollowUp).toBe("report-only");
  expect(adversarial?.actualFollowUp).toBe("implementation-interview");
  expect(adversarial?.expectedSelectedBy).toBe("jev");

  const summary = summarizeResearchContinuationRun(outcomes);
  expect(summary.interview.falseInterviewCount).toBe(1);
  expect(summary.interview.missedInterviewRate).toBe(0);
});

test("deterministic and jev-failure fixtures never leave usage as zero when unavailable", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const outcomes = await runFakeResearchContinuationFixtures(fixtures);
  const providerFailures = outcomes.filter((outcome) =>
    [
      "jev-unavailable-ambiguous",
      "jev-timeout-ambiguous",
      "jev-invalid-response-ambiguous",
    ].includes(outcome.fixtureId),
  );
  expect(providerFailures).toHaveLength(3);
  for (const outcome of providerFailures) {
    expect(["error", "timeout"]).toContain(outcome.providerOutcome);
    expect(outcome.usage?.inputTokens).toBe("unavailable");
    expect(outcome.usage?.outputTokens).toBe("unavailable");
  }
  const deterministic = outcomes.find(
    (outcome) => outcome.fixtureId === "explicit-web-research-report-only",
  );
  expect(deterministic?.providerOutcome).toBe("not-attempted");
  expect(deterministic?.usage).toBeUndefined();
});

test("restart/compaction fixtures rebuild identical content from a fresh store instance", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const restartFixtures = fixtures.filter((fixture) => fixture.restartCheck === true);
  expect(restartFixtures).toHaveLength(2);
  const outcomes = await runFakeResearchContinuationFixtures(restartFixtures);
  for (const outcome of outcomes) {
    expect(outcome.restartContent, `${outcome.fixtureId} restart content`).toBe(outcome.content);
  }
});

test("scout stage precedence overrides the recorded implementation-interview disposition", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const outcomes = await runFakeResearchContinuationFixtures(fixtures);
  const overridden = [
    "scout-blocked-overrides-interview",
    "scout-failed-overrides-interview",
    "scout-needs-decision-outranks-interview",
    "scout-missing-report-blocks-interview",
    "scout-stale-generation-blocks-interview",
  ];
  for (const id of overridden) {
    const outcome = outcomes.find((entry) => entry.fixtureId === id);
    expect(outcome?.actualDisposition, id).toBe("implementation-interview");
    expect(outcome?.actualFollowUp, id).not.toBe("implementation-interview");
    expect(outcome?.content, id).not.toContain("Propose one initial direction");
  }
});

test("the fixture set produces a comparable, separated summary", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const outcomes = await runFakeResearchContinuationFixtures(fixtures);
  const summary = summarizeResearchContinuationRun(outcomes);

  expect(summary.totalOutcomes).toBe(fixtures.length);
  expect(summary.safetyFailures).toEqual({ count: 0, fixtureIds: [] });
  expect(summary.jevCallDiscipline).toEqual({ unexpectedCallCount: 0, missingCallCount: 0 });
  expect(summary.restartConsistency).toEqual({ checkedCount: 2, matchedCount: 2, matchRate: 1 });
  expect(summary.classifierOverhead.attemptedCount).toBeGreaterThan(0);
  expect(summary.classifierOverhead.attemptedCount).toBeLessThan(summary.totalOutcomes);
  expect(summary.avoidedCoordinatorWork.count).toBeGreaterThan(0);
});

test("writeEvalResults writes valid JSONL results and a comparable JSON summary", async () => {
  const fixtures = await loadResearchContinuationFixtures(FIXTURE_PATH);
  const outcomes = await runFakeResearchContinuationFixtures(fixtures.slice(0, 3));
  const outputDir = await mkdtemp(join(tmpdir(), "tandem-continuation-eval-output-"));
  try {
    const { resultsPath, summaryPath } = await writeEvalResults(
      outcomes,
      outputDir,
      {
        mkdir: async (path) => {
          await mkdir(path, { recursive: true });
        },
        writeFile: async (path, contents) => {
          await writeFile(path, contents, "utf8");
        },
      },
      summarizeResearchContinuationRun,
    );
    const resultLines = (await readFile(resultsPath, "utf8")).trim().split("\n");
    expect(resultLines).toHaveLength(3);
    expect(
      resultLines.map((line) => (JSON.parse(line) as { fixtureId: string }).fixtureId),
    ).toEqual(outcomes.map((outcome) => outcome.fixtureId));
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { totalOutcomes: number };
    expect(summary.totalOutcomes).toBe(3);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
