import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaselineRecordings } from "../../evals/baseline-fixtures.ts";
import {
  runBaselineBenchmark,
  runLiveBaselineBenchmark,
  summarizeBaselineBenchmark,
  writeBaselineBenchmarkResults,
} from "../../evals/benchmark.ts";
import { loadPromptRoutingFixtures } from "../../evals/fixtures.ts";
import { JEV_MODEL } from "../../src/adapters/typesafe.ts";

const FIXTURE_PATH = new URL("../../evals/fixtures/prompt-routing.jsonl", import.meta.url).pathname;
const BASELINE_PATH = new URL("../../evals/fixtures/baseline-recordings.jsonl", import.meta.url)
  .pathname;

async function loadInputs(): Promise<{
  fixtures: Awaited<ReturnType<typeof loadPromptRoutingFixtures>>;
  baselines: Awaited<ReturnType<typeof loadBaselineRecordings>>;
}> {
  const [fixtures, baselines] = await Promise.all([
    loadPromptRoutingFixtures(FIXTURE_PATH),
    loadBaselineRecordings(BASELINE_PATH),
  ]);
  return { fixtures, baselines };
}

test("runs entirely offline: one benchmark row per fixture, no network or credentials", async () => {
  const { fixtures, baselines } = await loadInputs();
  const run = await runBaselineBenchmark(fixtures, baselines);
  expect(run.rows).toHaveLength(fixtures.length);
  expect(run.classification).toHaveLength(fixtures.length);
  expect(new Set(run.rows.map((row) => row.fixtureId))).toEqual(
    new Set(fixtures.map((fixture) => fixture.id)),
  );
});

test("control and treatment are deterministic and reproducible across runs", async () => {
  const { fixtures, baselines } = await loadInputs();
  const first = await runBaselineBenchmark(fixtures, baselines);
  const second = await runBaselineBenchmark(fixtures, baselines);
  // The default classifier (runFakePromptRoutingFixtures) injects a fixed clock, so jevDurationMs
  // is always exactly 0 and every row is byte-identical across runs with nothing to strip.
  expect(first.rows).toEqual(second.rows);
});

test("a successful direct route avoids the coordinator turn entirely", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows } = await runBaselineBenchmark(fixtures, baselines);
  const directListTasks = rows.find((row) => row.fixtureId === "direct-list-tasks");
  expect(directListTasks?.treatment.directRouted).toBe(true);
  expect(directListTasks?.treatment.coordinatorTurnAvoided).toBe(true);
  expect(directListTasks?.treatment.coordinatorTurns).toBe(0);
  expect(directListTasks?.treatment.totalDurationMs).toBeLessThan(
    directListTasks?.control.totalDurationMs ?? Number.POSITIVE_INFINITY,
  );
});

test("replay-mode treatment latency comes entirely from recorded fixture data, not from timing", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows } = await runBaselineBenchmark(fixtures, baselines);
  for (const row of rows) {
    // The default classifier injects a fixed clock (see evals/run-jev.ts), so every Jev latency
    // sample in replay mode is exactly 0; total duration must still equal the baseline recording's
    // own numbers, never a measured or fabricated figure.
    expect(row.treatment.jevDurationMs, `${row.fixtureId} jevDurationMs`).toBe(0);
  }
  const directListTasks = rows.find((row) => row.fixtureId === "direct-list-tasks");
  expect(directListTasks?.treatment.totalDurationMs).toBe(900);
  const missingTaskIdShow = rows.find((row) => row.fixtureId === "missing-task-id-show");
  expect(missingTaskIdShow?.treatment.totalDurationMs).toBe(60_000);
});

test("a failed direct action falls back to the coordinator path and counts one action failure", async () => {
  const { fixtures, baselines } = await loadInputs();
  // Synthetic: the inspect lookup's direct action is recorded as failing.
  const failing = baselines.map((baseline) =>
    baseline.fixtureId === "direct-inspect-task" && baseline.directAction !== undefined
      ? {
          ...baseline,
          directAction: {
            ...baseline.directAction,
            outcome: "failure" as const,
            correctness: "incorrect" as const,
          },
        }
      : baseline,
  );
  const { rows } = await runBaselineBenchmark(fixtures, failing);
  const inspect = rows.find((row) => row.fixtureId === "direct-inspect-task");
  expect(inspect?.treatment.directRouted).toBe(true);
  expect(inspect?.treatment.coordinatorTurnAvoided).toBe(false);
  expect(inspect?.treatment.actionFailures).toBe(1);
  expect(inspect?.treatment.correctness).toBe("correct");
  expect(inspect?.treatment.totalDurationMs).toBe(900 + 45_000);
});

test("a fallback with no documented avoided work costs the full coordinator path plus Jev overhead", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows } = await runBaselineBenchmark(fixtures, baselines);
  const showStatus = rows.find((row) => row.fixtureId === "missing-task-id-show");
  expect(showStatus?.treatment.directRouted).toBe(false);
  expect(showStatus?.treatment.totalDurationMs).toBeGreaterThanOrEqual(
    showStatus?.control.totalDurationMs ?? 0,
  );
});

test("a fallback with documented avoided work can cost less than the full coordinator path alone", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows } = await runBaselineBenchmark(fixtures, baselines);
  const missingTaskId = rows.find((row) => row.fixtureId === "missing-task-id-inspect");
  expect(missingTaskId?.treatment.downstreamWorkAvoidedMs).toBe(5_000);
  expect(missingTaskId?.treatment.totalDurationMs).toBeLessThan(
    missingTaskId?.control.totalDurationMs ?? 0,
  );
});

test("the adversarial fixture routes directly, silently wrong and unsafe, with no correction", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows } = await runBaselineBenchmark(fixtures, baselines);
  const adversarial = rows.find((row) => row.fixtureId === "adversarial-miscalibrated-cancel");
  expect(adversarial?.treatment.directRouted).toBe(true);
  expect(adversarial?.treatment.correctness).toBe("incorrect");
  expect(adversarial?.treatment.safetyOutcome).toBe("unsafe");
  expect(adversarial?.control.correctness).toBe("correct");
  expect(adversarial?.control.safetyOutcome).toBe("safe");
});

test("bypass and provider-failure fixtures never avoid the coordinator turn", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows } = await runBaselineBenchmark(fixtures, baselines);
  const neverDirect = rows.filter(
    (row) => row.safety === "bypass" || row.safety === "provider-failure",
  );
  expect(neverDirect).toHaveLength(5);
  for (const row of neverDirect) {
    expect(row.treatment.directRouted).toBe(false);
    expect(row.treatment.coordinatorTurnAvoided).toBe(false);
  }
});

test("the aggregate summary reports the same false-direct-route count the #22 harness would", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows, classification } = await runBaselineBenchmark(fixtures, baselines);
  const summary = summarizeBaselineBenchmark(rows, classification);
  expect(summary.totalFixtures).toBe(fixtures.length);
  expect(summary.routing.directRoute.falseDirectRouteCount).toBe(1);
  expect(summary.coordinatorTurnAvoidance.avoidedCount).toBe(6);
});

test("control usage is always reported unavailable, never zero, through aggregation", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows, classification } = await runBaselineBenchmark(fixtures, baselines);
  const summary = summarizeBaselineBenchmark(rows, classification);
  expect(summary.control.usage.knownInputTokens).toBe(0);
  expect(summary.control.usage.knownOutputTokens).toBe(0);
  expect(summary.control.usage.unavailableInputSamples).toBe(rows.length);
  expect(summary.control.usage.unavailableOutputSamples).toBe(rows.length);
  expect(summary.control.usage.costUnavailableSamples).toBe(rows.length);
});

test("treatment usage reports Jev tokens for every fixture that actually reached the provider", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows, classification } = await runBaselineBenchmark(fixtures, baselines);
  const summary = summarizeBaselineBenchmark(rows, classification);
  expect(summary.treatment.usage.totalSamples).toBe(summary.routing.usage.totalSamples);
  expect(summary.treatment.usage.knownInputTokens).toBeGreaterThan(0);
});

test("the decision rule rejects the real fixture set because it contains one false direct route", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows, classification } = await runBaselineBenchmark(fixtures, baselines);
  const summary = summarizeBaselineBenchmark(rows, classification);
  expect(summary.decision.recommendation).toBe("reject");
  expect(
    summary.decision.rejectionReasons.some((reason) => /false direct route/i.test(reason)),
  ).toBe(true);
});

test("throws when a fixture has no matching baseline recording", async () => {
  const { fixtures, baselines } = await loadInputs();
  await expect(runBaselineBenchmark(fixtures, baselines.slice(1))).rejects.toThrow(
    /no baseline recording for fixture/,
  );
});

test("throws when a baseline recording has no matching fixture", async () => {
  const { fixtures, baselines } = await loadInputs();
  const [firstBaseline] = baselines;
  if (firstBaseline === undefined) throw new Error("expected at least one baseline recording");
  const extra = { ...firstBaseline, fixtureId: "no-such-fixture" };
  await expect(runBaselineBenchmark(fixtures, [...baselines, extra])).rejects.toThrow(
    /has no matching prompt-routing fixture/,
  );
});

test("writeBaselineBenchmarkResults writes JSONL rows plus a JSON summary", async () => {
  const { fixtures, baselines } = await loadInputs();
  const { rows, classification } = await runBaselineBenchmark(fixtures, baselines);
  const summary = summarizeBaselineBenchmark(rows, classification);
  const dir = await mkdtemp(join(tmpdir(), "tandem-baseline-benchmark-"));
  try {
    const { resultsPath, summaryPath } = await writeBaselineBenchmarkResults(rows, summary, dir, {
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      writeFile: async (path, contents) => {
        await writeFile(path, contents, "utf8");
      },
    });
    const resultsContents = await readFile(resultsPath, "utf8");
    const summaryContents = await readFile(summaryPath, "utf8");
    expect(resultsContents.trim().split("\n")).toHaveLength(rows.length);
    expect(JSON.parse(summaryContents).totalFixtures).toBe(fixtures.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function choice(value: string) {
  return { type: "choice" as const, choice: value, confidence: 1, probabilities: { [value]: 1 } };
}

/** A live provider that confidently answers every prompt as a safe repository-wide list lookup. */
async function alwaysDirectLiveCaller() {
  return {
    model: JEV_MODEL,
    answers: {
      action: choice("list"),
      target: choice("repository"),
      effect: choice("read-only"),
      scope: choice("within"),
      composition: choice("single"),
    },
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

test("a live run over the real fixtures scores unrecorded direct routes as unsafe instead of crashing", async () => {
  const { fixtures, baselines } = await loadInputs();
  const run = await runLiveBaselineBenchmark(fixtures, baselines, {
    apiKey: "test-key",
    timeoutMs: 1_000,
    budget: { maxTotalCostUsd: 1 },
    evaluate: alwaysDirectLiveCaller,
  });

  const scriptedOutages = fixtures.filter((fixture) => fixture.safety === "provider-failure");
  expect(scriptedOutages.length).toBeGreaterThan(0);
  expect(run.rows).toHaveLength(fixtures.length - scriptedOutages.length);
  expect(run.rows.some((row) => row.safety === "provider-failure")).toBe(false);

  const cancel = run.rows.find((row) => row.fixtureId === "state-changing-cancel");
  expect(cancel?.treatment).toMatchObject({
    directRouted: true,
    correctness: "incorrect",
    safetyOutcome: "unsafe",
  });
  expect(summarizeBaselineBenchmark(run.rows, run.classification).decision.recommendation).toBe(
    "reject",
  );
});
