import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptRoutingFixtures } from "../../evals/fixtures.ts";
import { runFakePromptRoutingFixtures, writePromptRoutingResults } from "../../evals/run-jev.ts";
import { summarizePromptRoutingRun } from "../../evals/summarize.ts";

const FIXTURE_PATH = new URL("../../evals/fixtures/prompt-routing.jsonl", import.meta.url).pathname;

/**
 * The one fixture deliberately crafted with a miscalibrated recorded response: a state-changing
 * "cancel" prompt paired with a fake Jev answer that confidently (and wrongly) classifies it as a
 * read-only inspect lookup. It exists to prove the false-direct-route metric actually detects a
 * safety failure, so every other fixture is expected to match its own ground truth exactly.
 */
const ADVERSARIAL_FIXTURE_ID = "adversarial-miscalibrated-cancel";

test("fake mode runs every fixture deterministically with no network and no credentials", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const first = await runFakePromptRoutingFixtures(fixtures);
  const second = await runFakePromptRoutingFixtures(fixtures);
  // A full comparison, including every nested duration: fake mode injects a fixed clock into
  // classifyPrompt (so its own duration and its nested usage record's duration both come from
  // it), so two runs over the same fixtures are byte-identical, not merely equal once durations
  // are set aside.
  expect(first).toEqual(second);
});

test("fake mode's injected clock makes every duration, including the nested usage record's, exactly zero", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const outcomes = await runFakePromptRoutingFixtures(fixtures);
  for (const outcome of outcomes) {
    expect(outcome.durationMs, `${outcome.fixtureId} durationMs`).toBe(0);
    if (outcome.usage !== undefined) {
      expect(outcome.usage.durationMs, `${outcome.fixtureId} usage.durationMs`).toBe(0);
    }
  }
});

test("every fixture except the adversarial one reaches its expected route and reason", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const outcomes = await runFakePromptRoutingFixtures(fixtures);
  for (const outcome of outcomes) {
    if (outcome.fixtureId === ADVERSARIAL_FIXTURE_ID) continue;
    expect(outcome.actualRoute, `${outcome.fixtureId} route`).toBe(outcome.expectedRoute);
    expect(outcome.actualReason, `${outcome.fixtureId} reason`).toBe(outcome.expectedReason);
  }
});

test("the adversarial fixture demonstrates a detected false direct route", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const outcomes = await runFakePromptRoutingFixtures(fixtures);
  const adversarial = outcomes.find((outcome) => outcome.fixtureId === ADVERSARIAL_FIXTURE_ID);
  expect(adversarial?.expectedRoute).toBe("fallback");
  expect(adversarial?.actualRoute).toBe("direct");
  expect(adversarial?.safety).toBe("state-changing");
  expect(adversarial?.fieldMatches).toMatchObject({ action: false, effect: false, target: true });
});

test("bypass fixtures never reach Jev classification or the Tandem service", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const outcomes = await runFakePromptRoutingFixtures(fixtures);
  const bypassed = outcomes.filter((outcome) => outcome.safety === "bypass");
  expect(bypassed).toHaveLength(2);
  for (const outcome of bypassed) {
    expect(outcome.providerOutcome).toBe("not-attempted");
    expect(outcome.actualRoute).toBe("fallback");
  }
});

test("provider failure fixtures are graded as provider errors or timeouts, never as zero usage", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const outcomes = await runFakePromptRoutingFixtures(fixtures);
  const failures = outcomes.filter((outcome) => outcome.safety === "provider-failure");
  expect(failures).toHaveLength(3);
  for (const outcome of failures) {
    expect(["error", "timeout"]).toContain(outcome.providerOutcome);
    expect(outcome.usage?.inputTokens).toBe("unavailable");
    expect(outcome.usage?.outputTokens).toBe("unavailable");
  }
});

test("the fixture set produces the expected route, field-accuracy, and reliability summary", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const outcomes = await runFakePromptRoutingFixtures(fixtures);
  const summary = summarizePromptRoutingRun(outcomes);

  expect(summary.totalOutcomes).toBe(20);
  expect(summary.directRoute).toEqual({
    actualDirectCount: 6,
    expectedDirectCount: 5,
    truePositiveCount: 5,
    falseDirectRouteCount: 1,
    missedDirectRouteCount: 0,
    precision: 5 / 6,
    recall: 1,
  });
  expect(summary.fallback).toEqual({
    fallbackCount: 14,
    fallbackRate: 14 / 20,
    shouldFallbackCount: 15,
    correctFallbackCount: 14,
    abstentionRecall: 14 / 15,
  });
  expect(summary.providerReliability).toEqual({
    attemptedCount: 18,
    errorCount: 2,
    timeoutCount: 1,
    errorRate: 2 / 18,
    timeoutRate: 1 / 18,
  });
  expect(summary.fieldAccuracy.action).toEqual({ correct: 14, total: 15, accuracy: 14 / 15 });
  expect(summary.fieldAccuracy.target).toEqual({ correct: 15, total: 15, accuracy: 1 });
  expect(summary.fieldAccuracy.effect).toEqual({ correct: 14, total: 15, accuracy: 14 / 15 });
  expect(summary.fieldAccuracy.scope).toEqual({ correct: 15, total: 15, accuracy: 1 });
  expect(summary.fieldAccuracy.composition).toEqual({ correct: 15, total: 15, accuracy: 1 });
  expect(summary.fieldAccuracy.taskId).toEqual({ correct: 10, total: 10, accuracy: 1 });
});

test("writePromptRoutingResults writes valid JSONL results and a comparable JSON summary", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const outcomes = await runFakePromptRoutingFixtures(fixtures.slice(0, 3));
  const outputDir = await mkdtemp(join(tmpdir(), "tandem-jev-eval-output-"));
  try {
    const { resultsPath, summaryPath } = await writePromptRoutingResults(outcomes, outputDir, {
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      writeFile: async (path, contents) => {
        await writeFile(path, contents, "utf8");
      },
    });
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
