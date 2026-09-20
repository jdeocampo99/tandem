import { expect, test } from "bun:test";
import {
  BASELINE_RECORDING_FIXTURE_SET_VERSION,
  loadBaselineRecordings,
  parseBaselineRecordings,
} from "../../evals/baseline-fixtures.ts";
import { loadPromptRoutingFixtures } from "../../evals/fixtures.ts";

const BASELINE_PATH = new URL("../../evals/fixtures/baseline-recordings.jsonl", import.meta.url)
  .pathname;
const FIXTURE_PATH = new URL("../../evals/fixtures/prompt-routing.jsonl", import.meta.url).pathname;

const VALID_LINE = JSON.stringify({
  fixtureId: "sample",
  fixtureSetVersion: BASELINE_RECORDING_FIXTURE_SET_VERSION,
  description: "A sample baseline recording.",
  coordinatorTurns: 1,
  coordinatorDurationMs: 1000,
  correctness: "correct",
  safety: "safe",
  actionFailures: 0,
  corrections: 0,
  reworkCount: 0,
  humanInterventionRequired: false,
});

test("loads and validates the checked-in baseline recording set", async () => {
  const recordings = await loadBaselineRecordings(BASELINE_PATH);
  expect(recordings.length).toBeGreaterThan(0);
  expect(new Set(recordings.map((recording) => recording.fixtureId)).size).toBe(recordings.length);
  for (const recording of recordings) {
    expect(recording.fixtureSetVersion).toBe(BASELINE_RECORDING_FIXTURE_SET_VERSION);
  }
});

test("has exactly one baseline recording per prompt-routing fixture", async () => {
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const recordings = await loadBaselineRecordings(BASELINE_PATH);
  expect(new Set(recordings.map((recording) => recording.fixtureId))).toEqual(
    new Set(fixtures.map((fixture) => fixture.id)),
  );
});

test("carries a directAction only on fixtures where fake-mode replay can route directly", async () => {
  const recordings = await loadBaselineRecordings(BASELINE_PATH);
  const withDirectAction = recordings.filter((recording) => recording.directAction !== undefined);
  const ids = new Set(withDirectAction.map((recording) => recording.fixtureId));
  expect(ids).toEqual(
    new Set([
      "direct-list-tasks",
      "direct-presentations",
      "direct-show-task",
      "direct-messages-task",
      "direct-inspect-task",
      "direct-recovery-plan-task",
      "adversarial-miscalibrated-cancel",
    ]),
  );
});

test("records the adversarial fixture's directAction as incorrect and unsafe", async () => {
  const recordings = await loadBaselineRecordings(BASELINE_PATH);
  const adversarial = recordings.find(
    (recording) => recording.fixtureId === "adversarial-miscalibrated-cancel",
  );
  expect(adversarial?.directAction).toMatchObject({ correctness: "incorrect", safety: "unsafe" });
});

test("records one fixture demonstrating downstream work avoided by a fallback", async () => {
  const recordings = await loadBaselineRecordings(BASELINE_PATH);
  const withAvoidedWork = recordings.filter((recording) => recording.downstreamWorkAvoidedMs > 0);
  expect(withAvoidedWork).toHaveLength(1);
  expect(withAvoidedWork[0]?.fixtureId).toBe("missing-task-id-inspect");
});

test("rejects malformed JSON", () => {
  expect(() => parseBaselineRecordings("not json")).toThrow(/not valid JSON/);
});

test("rejects a recording set declaring the wrong version", () => {
  const line = JSON.stringify({
    fixtureId: "sample",
    fixtureSetVersion: "some-other-version",
    description: "d",
    coordinatorTurns: 1,
    coordinatorDurationMs: 1000,
    correctness: "correct",
    safety: "safe",
    actionFailures: 0,
    corrections: 0,
    reworkCount: 0,
    humanInterventionRequired: false,
  });
  expect(() => parseBaselineRecordings(line)).toThrow(/declares version/);
});

test("rejects duplicate fixture ids", () => {
  expect(() => parseBaselineRecordings(`${VALID_LINE}\n${VALID_LINE}`)).toThrow(
    /duplicate baseline recording fixtureId/,
  );
});

test("rejects a negative coordinatorTurns", () => {
  const line = JSON.stringify({
    fixtureId: "sample",
    fixtureSetVersion: BASELINE_RECORDING_FIXTURE_SET_VERSION,
    description: "d",
    coordinatorTurns: 0,
    coordinatorDurationMs: 1000,
    correctness: "correct",
    safety: "safe",
    actionFailures: 0,
    corrections: 0,
    reworkCount: 0,
    humanInterventionRequired: false,
  });
  expect(() => parseBaselineRecordings(line)).toThrow(
    /coordinatorTurns must be a positive integer/,
  );
});

test("rejects a malformed directAction", () => {
  const line = JSON.stringify({
    fixtureId: "sample",
    fixtureSetVersion: BASELINE_RECORDING_FIXTURE_SET_VERSION,
    description: "d",
    coordinatorTurns: 1,
    coordinatorDurationMs: 1000,
    correctness: "correct",
    safety: "safe",
    actionFailures: 0,
    corrections: 0,
    reworkCount: 0,
    humanInterventionRequired: false,
    directAction: { durationMs: 100, outcome: "maybe" },
  });
  expect(() => parseBaselineRecordings(line)).toThrow(/directAction.outcome must be one of/);
});

test("rejects an empty recording set", () => {
  expect(() => parseBaselineRecordings("\n\n")).toThrow(/empty/);
});
