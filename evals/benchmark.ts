/**
 * Baseline-vs-Jev benchmark (issue #20): replays the same sanitized `PromptRoutingFixture` set used
 * by the #22 routing harness through two arms and reports which arm reaches a verified result
 * faster, cheaper, and at least as correctly and safely.
 *
 * - Control: classification disabled. The normal coordinator path is represented by a bounded,
 *   synthetic recording per fixture (`evals/baseline-fixtures.ts`), never a live call, because
 *   default CI must never call TypeSafe, Herdr, Treehouse, GitHub, or OMP.
 * - Treatment: one Jev classification (replayed through the real `classifyPrompt`/`handlePromptInput`
 *   via the #22 runner, never reimplemented) followed by the existing direct read-only action when
 *   policy permits, otherwise the same recorded coordinator path the control arm uses.
 *
 * Every fixture and repository-state input is identical between arms; only the routing decision
 * differs. A fallback is counted as pure classifier overhead (Jev latency added on top of the full
 * recorded coordinator path) unless a fixture's baseline recording documents recorded downstream
 * work it demonstrably avoided (`downstreamWorkAvoidedMs`), and a direct action that fails at
 * runtime still falls back to the coordinator path to reach a verified result, counted as one
 * action failure rather than silently dropped.
 *
 * This module only computes and reports a recommendation (via `evals/decision.ts`); it never
 * changes routing thresholds, review policy, or any other production behavior.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateUsage,
  USAGE_RECORD_SCHEMA_VERSION,
  type UsageRecord,
} from "../src/runtime/usage.ts";
import {
  type BaselineDirectAction,
  type BaselineRecording,
  loadBaselineRecordings,
} from "./baseline-fixtures.ts";
import { evaluateNetBenefit, type NetBenefitCost, type NetBenefitDecision } from "./decision.ts";
import { loadPromptRoutingFixtures, type PromptRoutingFixture } from "./fixtures.ts";
import {
  type LiveJevBudget,
  type LiveJevCaller,
  liveEligibleFixtures,
  runFakePromptRoutingFixtures,
  runLivePromptRoutingFixtures,
} from "./run-jev.ts";
import {
  computeLatencyPercentiles,
  type LatencyPercentiles,
  type PromptRoutingSummary,
  type Rate,
  summarizePromptRoutingRun,
  type UsageSummary,
} from "./summarize.ts";
import type { PromptRoutingProviderOutcome, PromptRoutingRunOutcome } from "./types.ts";

export type VerifiedCorrectness = "correct" | "incorrect";
export type VerifiedSafety = "safe" | "unsafe";

export type ArmOutcome = Readonly<{
  readonly correctness: VerifiedCorrectness;
  readonly safetyOutcome: VerifiedSafety;
  readonly totalDurationMs: number;
  readonly coordinatorTurns: number;
  readonly actionFailures: number;
  readonly corrections: number;
  readonly reworkCount: number;
  readonly humanInterventionRequired: boolean;
}>;

export type TreatmentOutcome = ArmOutcome &
  Readonly<{
    readonly directRouted: boolean;
    readonly coordinatorTurnAvoided: boolean;
    readonly jevDurationMs: number;
    readonly jevProviderOutcome: PromptRoutingProviderOutcome;
    readonly downstreamWorkAvoidedMs: number;
  }>;

export type BenchmarkRow = Readonly<{
  readonly fixtureId: string;
  readonly safety: PromptRoutingFixture["safety"];
  readonly control: ArmOutcome;
  readonly treatment: TreatmentOutcome;
}>;

function controlArmOutcome(baseline: BaselineRecording): ArmOutcome {
  return {
    correctness: baseline.correctness,
    safetyOutcome: baseline.safety,
    totalDurationMs: baseline.coordinatorDurationMs,
    coordinatorTurns: baseline.coordinatorTurns,
    actionFailures: baseline.actionFailures,
    corrections: baseline.corrections,
    reworkCount: baseline.reworkCount,
    humanInterventionRequired: baseline.humanInterventionRequired,
  };
}

function fallbackTreatmentOutcome(
  baseline: BaselineRecording,
  jevDurationMs: number,
  jevProviderOutcome: PromptRoutingProviderOutcome,
): TreatmentOutcome {
  const coordinatorDurationMs = Math.max(
    0,
    baseline.coordinatorDurationMs - baseline.downstreamWorkAvoidedMs,
  );
  return {
    correctness: baseline.correctness,
    safetyOutcome: baseline.safety,
    totalDurationMs: jevDurationMs + coordinatorDurationMs,
    coordinatorTurns: baseline.coordinatorTurns,
    actionFailures: baseline.actionFailures,
    corrections: baseline.corrections,
    reworkCount: baseline.reworkCount,
    humanInterventionRequired: baseline.humanInterventionRequired,
    directRouted: false,
    coordinatorTurnAvoided: false,
    jevDurationMs,
    jevProviderOutcome,
    downstreamWorkAvoidedMs: baseline.downstreamWorkAvoidedMs,
  };
}

function directTreatmentOutcome(
  baseline: BaselineRecording,
  jevDurationMs: number,
  jevProviderOutcome: PromptRoutingProviderOutcome,
): TreatmentOutcome {
  const directAction: BaselineDirectAction | undefined = baseline.directAction;
  if (directAction === undefined) {
    // Only fixtures that must fall back lack a recorded direct action, so reaching here means a
    // live answer skipped the coordinator for one of them: a false direct route, scored as the
    // safety failure it is. The action's own duration was never recorded, so only Jev's counts.
    return {
      correctness: "incorrect",
      safetyOutcome: "unsafe",
      totalDurationMs: jevDurationMs,
      coordinatorTurns: 0,
      actionFailures: 0,
      corrections: 0,
      reworkCount: 0,
      humanInterventionRequired: false,
      directRouted: true,
      coordinatorTurnAvoided: true,
      jevDurationMs,
      jevProviderOutcome,
      downstreamWorkAvoidedMs: 0,
    };
  }
  if (directAction.outcome === "success") {
    return {
      correctness: directAction.correctness,
      safetyOutcome: directAction.safety,
      totalDurationMs: jevDurationMs + directAction.durationMs,
      coordinatorTurns: 0,
      actionFailures: 0,
      corrections: 0,
      reworkCount: 0,
      humanInterventionRequired: false,
      directRouted: true,
      coordinatorTurnAvoided: true,
      jevDurationMs,
      jevProviderOutcome,
      downstreamWorkAvoidedMs: 0,
    };
  }
  return {
    correctness: baseline.correctness,
    safetyOutcome: baseline.safety,
    totalDurationMs: jevDurationMs + directAction.durationMs + baseline.coordinatorDurationMs,
    coordinatorTurns: baseline.coordinatorTurns,
    actionFailures: baseline.actionFailures + 1,
    corrections: baseline.corrections,
    reworkCount: baseline.reworkCount + 1,
    humanInterventionRequired: baseline.humanInterventionRequired,
    directRouted: true,
    coordinatorTurnAvoided: false,
    jevDurationMs,
    jevProviderOutcome,
    downstreamWorkAvoidedMs: 0,
  };
}

function buildBenchmarkRow(
  fixture: PromptRoutingFixture,
  classification: PromptRoutingRunOutcome,
  baseline: BaselineRecording,
): BenchmarkRow {
  const treatment =
    classification.actualRoute === "direct"
      ? directTreatmentOutcome(baseline, classification.durationMs, classification.providerOutcome)
      : fallbackTreatmentOutcome(
          baseline,
          classification.durationMs,
          classification.providerOutcome,
        );
  return {
    fixtureId: fixture.id,
    safety: fixture.safety,
    control: controlArmOutcome(baseline),
    treatment,
  };
}

function requireBaseline(
  byId: ReadonlyMap<string, BaselineRecording>,
  fixtureId: string,
): BaselineRecording {
  const baseline = byId.get(fixtureId);
  if (baseline === undefined) {
    throw new Error(
      `no baseline recording for fixture ${fixtureId}: control and treatment must use identical fixtures`,
    );
  }
  return baseline;
}

export type ClassifyFixtures = (
  fixtures: readonly PromptRoutingFixture[],
) => Promise<readonly PromptRoutingRunOutcome[]>;

export type BaselineBenchmarkOptions = Readonly<{
  /** Defaults to the #22 fake-mode runner: deterministic, no network, safe for `bun test`. */
  readonly classify?: ClassifyFixtures;
}>;

export type BaselineBenchmarkRun = Readonly<{
  readonly rows: readonly BenchmarkRow[];
  /** The exact classification outcomes `rows` were built from, reused for the routing-only report. */
  readonly classification: readonly PromptRoutingRunOutcome[];
}>;

/**
 * Runs the treatment classification once per fixture (via the injected `classify`, defaulting to
 * the #22 fake runner) and pairs each outcome with its baseline recording to build one benchmark
 * row per fixture. `classification` is returned alongside `rows` so a caller (including live mode)
 * never has to classify the same fixture set twice just to get both the rows and the routing-only
 * summary.
 */
export async function runBaselineBenchmark(
  fixtures: readonly PromptRoutingFixture[],
  baselines: readonly BaselineRecording[],
  options: BaselineBenchmarkOptions = {},
): Promise<BaselineBenchmarkRun> {
  const classify = options.classify ?? runFakePromptRoutingFixtures;
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  for (const baseline of baselines) {
    if (!fixtureIds.has(baseline.fixtureId)) {
      throw new Error(
        `baseline recording ${baseline.fixtureId} has no matching prompt-routing fixture`,
      );
    }
  }
  const byId = new Map(baselines.map((baseline) => [baseline.fixtureId, baseline] as const));
  const classification = await classify(fixtures);
  if (classification.length !== fixtures.length) {
    throw new Error(
      `classification produced ${classification.length} outcomes for ${fixtures.length} fixtures; ` +
        "the benchmark requires exactly one classification per fixture",
    );
  }
  const classificationById = new Map(
    classification.map((outcome) => [outcome.fixtureId, outcome] as const),
  );
  const rows = fixtures.map((fixture) => {
    const outcome = classificationById.get(fixture.id);
    if (outcome === undefined) {
      throw new Error(`classification produced no outcome for fixture ${fixture.id}`);
    }
    return buildBenchmarkRow(fixture, outcome, requireBaseline(byId, fixture.id));
  });
  return { rows, classification };
}

export type LiveBaselineBenchmarkOptions = Readonly<{
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly budget: LiveJevBudget;
  /** Injected live Jev caller; defaults to the real network call. Tests inject a fake caller. */
  readonly evaluate?: LiveJevCaller;
}>;

/**
 * Live treatment mode: reuses the #22 live runner's pinned model, timeout, and budget verbatim
 * rather than reimplementing them. The repeat count is always 1 here (not configurable): a
 * benchmark row compares exactly one classification per fixture against one baseline recording,
 * unlike #22's routing-accuracy harness, which repeats fixtures to measure calibration.
 */
export async function runLiveBaselineBenchmark(
  fixtures: readonly PromptRoutingFixture[],
  baselines: readonly BaselineRecording[],
  options: LiveBaselineBenchmarkOptions,
): Promise<BaselineBenchmarkRun> {
  const liveFixtures = liveEligibleFixtures(fixtures);
  const liveFixtureIds = new Set(liveFixtures.map((fixture) => fixture.id));
  const liveBaselines = baselines.filter((baseline) => liveFixtureIds.has(baseline.fixtureId));
  return runBaselineBenchmark(liveFixtures, liveBaselines, {
    classify: (classifyFixtures) =>
      runLivePromptRoutingFixtures(classifyFixtures, { ...options, repeatCount: 1 }),
  });
}

export type BenchmarkArmSummary = Readonly<{
  readonly correctRate: Rate;
  readonly safeRate: Rate;
  readonly latency: LatencyPercentiles;
  readonly coordinatorTurnsTotal: number;
  readonly actionFailures: number;
  readonly corrections: number;
  readonly reworkCount: number;
  readonly humanInterventionCount: number;
  readonly usage: UsageSummary;
}>;

export type BenchmarkSummary = Readonly<{
  readonly totalFixtures: number;
  /** Reused wholesale from the #22 summarizer: field accuracy, direct-route/fallback metrics
   *  (including `directRoute.falseDirectRouteCount`, the routing-policy safety-failure count),
   *  provider reliability, the confidence-threshold sweep, and the Jev-only latency/usage. */
  readonly routing: PromptRoutingSummary;
  readonly coordinatorTurnAvoidance: Readonly<{
    readonly avoidedCount: number;
    readonly rate: Rate;
  }>;
  readonly control: BenchmarkArmSummary;
  readonly treatment: BenchmarkArmSummary;
  readonly decision: NetBenefitDecision;
}>;

function rate(numerator: number, denominator: number): Rate {
  return denominator === 0 ? "unavailable" : numerator / denominator;
}

const CONTROL_USAGE_REASON = "coordinator-baseline-unmeasured";

/**
 * The control arm's coordinator token usage is always reported as "unavailable", never fabricated:
 * bounded production telemetry for the coordinator/worker path (issue #21) is not wired into this
 * synthetic benchmark, so no real figure exists to report. This keeps the control arm's usage
 * honest rather than presenting an invented number as measured.
 */
function controlUsageRecord(durationMs: number): UsageRecord {
  return {
    schemaVersion: USAGE_RECORD_SCHEMA_VERSION,
    provider: "coordinator",
    model: "unassigned",
    inputTokens: "unavailable",
    outputTokens: "unavailable",
    durationMs,
    timedOut: false,
    reason: CONTROL_USAGE_REASON,
    pricing: "unavailable",
  };
}

/** Folds usage samples the same way `evals/summarize.ts`'s `computeUsageSummary` does, reusing
 *  `aggregateUsage`/`calculateUsageCost` from `src/runtime/usage.ts` rather than a second
 *  accounting path; kept local because the control arm's samples are not `PromptRoutingRunOutcome`s. */
function foldUsage(
  samples: readonly Readonly<{ context: { fixture: string }; usage: UsageRecord }>[],
): UsageSummary {
  const aggregates = aggregateUsage(samples);
  let knownInputTokens = 0;
  let knownOutputTokens = 0;
  let unavailableInputSamples = 0;
  let unavailableOutputSamples = 0;
  let timedOutSamples = 0;
  let knownCostUsd = 0;
  let costUnavailableSamples = 0;
  for (const aggregate of aggregates) {
    knownInputTokens += aggregate.knownInputTokens;
    knownOutputTokens += aggregate.knownOutputTokens;
    unavailableInputSamples += aggregate.unavailableInputSamples;
    unavailableOutputSamples += aggregate.unavailableOutputSamples;
    timedOutSamples += aggregate.timedOutSamples;
    knownCostUsd += aggregate.knownCost;
    costUnavailableSamples += aggregate.costUnavailableSamples;
  }
  return {
    totalSamples: samples.length,
    knownInputTokens,
    knownOutputTokens,
    unavailableInputSamples,
    unavailableOutputSamples,
    timedOutSamples,
    knownCostUsd,
    costUnavailableSamples,
  };
}

function armOutcomeSummary(outcomes: readonly ArmOutcome[]): Omit<BenchmarkArmSummary, "usage"> {
  const correctCount = outcomes.filter((outcome) => outcome.correctness === "correct").length;
  const safeCount = outcomes.filter((outcome) => outcome.safetyOutcome === "safe").length;
  return {
    correctRate: rate(correctCount, outcomes.length),
    safeRate: rate(safeCount, outcomes.length),
    latency: computeLatencyPercentiles(outcomes.map((outcome) => outcome.totalDurationMs)),
    coordinatorTurnsTotal: outcomes.reduce((sum, outcome) => sum + outcome.coordinatorTurns, 0),
    actionFailures: outcomes.reduce((sum, outcome) => sum + outcome.actionFailures, 0),
    corrections: outcomes.reduce((sum, outcome) => sum + outcome.corrections, 0),
    reworkCount: outcomes.reduce((sum, outcome) => sum + outcome.reworkCount, 0),
    humanInterventionCount: outcomes.filter((outcome) => outcome.humanInterventionRequired).length,
  };
}

function controlArmSummary(rows: readonly BenchmarkRow[]): BenchmarkArmSummary {
  const samples = rows.map((row) => ({
    context: { fixture: row.fixtureId },
    usage: controlUsageRecord(row.control.totalDurationMs),
  }));
  return { ...armOutcomeSummary(rows.map((row) => row.control)), usage: foldUsage(samples) };
}

function treatmentArmSummary(
  rows: readonly BenchmarkRow[],
  jevUsage: UsageSummary,
): BenchmarkArmSummary {
  return { ...armOutcomeSummary(rows.map((row) => row.treatment)), usage: jevUsage };
}

function coordinatorTurnAvoidance(
  rows: readonly BenchmarkRow[],
): Readonly<{ readonly avoidedCount: number; readonly rate: Rate }> {
  const avoidedCount = rows.filter((row) => row.treatment.coordinatorTurnAvoided).length;
  return { avoidedCount, rate: rate(avoidedCount, rows.length) };
}

function requireKnownDurationMs(value: Rate, label: string): number {
  if (value === "unavailable") {
    throw new Error(
      `${label} latency percentile is unavailable: the benchmark requires at least one fixture`,
    );
  }
  return value;
}

/**
 * A total cost is reported only when every priced sample is known; one unpriceable sample makes
 * the total "unavailable" rather than a silently understated partial sum, the same "never zero"
 * rule the usage telemetry module applies to individual token counts.
 */
function totalCostUsd(usage: UsageSummary): NetBenefitCost {
  return usage.costUnavailableSamples > 0 ? "unavailable" : usage.knownCostUsd;
}

/** Combines the routing-only summary, both arms' outcomes, and the net-benefit decision (see
 *  `evals/decision.ts`) into one report comparable across runs. */
export function summarizeBaselineBenchmark(
  rows: readonly BenchmarkRow[],
  classification: readonly PromptRoutingRunOutcome[],
): BenchmarkSummary {
  const routing = summarizePromptRoutingRun(classification);
  const control = controlArmSummary(rows);
  const treatment = treatmentArmSummary(rows, routing.usage);
  const decision = evaluateNetBenefit({
    falseDirectRouteCount: routing.directRoute.falseDirectRouteCount,
    control: {
      correctRate: control.correctRate,
      safeRate: control.safeRate,
      totalDurationMsP50: requireKnownDurationMs(control.latency.p50, "control"),
      totalDurationMsP95: requireKnownDurationMs(control.latency.p95, "control"),
      costUsd: totalCostUsd(control.usage),
      reworkCount: control.reworkCount,
    },
    treatment: {
      correctRate: treatment.correctRate,
      safeRate: treatment.safeRate,
      totalDurationMsP50: requireKnownDurationMs(treatment.latency.p50, "treatment"),
      totalDurationMsP95: requireKnownDurationMs(treatment.latency.p95, "treatment"),
      costUsd: totalCostUsd(treatment.usage),
      reworkCount: treatment.reworkCount,
    },
  });
  return {
    totalFixtures: rows.length,
    routing,
    coordinatorTurnAvoidance: coordinatorTurnAvoidance(rows),
    control,
    treatment,
    decision,
  };
}

export type BaselineBenchmarkResultIo = Readonly<{
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
}>;

/** Writes per-fixture JSONL rows plus the concise summary. Never called by `bun test`. */
export async function writeBaselineBenchmarkResults(
  rows: readonly BenchmarkRow[],
  summary: BenchmarkSummary,
  outputDir: string,
  io: BaselineBenchmarkResultIo,
): Promise<Readonly<{ resultsPath: string; summaryPath: string }>> {
  await io.mkdir(outputDir);
  const resultsPath = join(outputDir, "results.jsonl");
  const summaryPath = join(outputDir, "summary.json");
  const lines = rows.map((row) => JSON.stringify(row));
  await io.writeFile(resultsPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  await io.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { resultsPath, summaryPath };
}

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/prompt-routing.jsonl", import.meta.url));
const BASELINE_PATH = fileURLToPath(
  new URL("./fixtures/baseline-recordings.jsonl", import.meta.url),
);
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL("./results/baseline-benchmark", import.meta.url));

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function realIo(): Promise<BaselineBenchmarkResultIo> {
  return {
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    writeFile: async (path, contents) => {
      await writeFile(path, contents, "utf8");
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixtures = await loadPromptRoutingFixtures(FIXTURE_PATH);
  const baselines = await loadBaselineRecordings(BASELINE_PATH);
  const io = await realIo();
  if (!args.includes("--live")) {
    const run = await runBaselineBenchmark(fixtures, baselines);
    const summary = summarizeBaselineBenchmark(run.rows, run.classification);
    const { resultsPath, summaryPath } = await writeBaselineBenchmarkResults(
      run.rows,
      summary,
      DEFAULT_OUTPUT_DIR,
      io,
    );
    console.log(`fake mode: wrote ${resultsPath} and ${summaryPath}`);
    console.log(`decision: ${summary.decision.recommendation}`);
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("--live requires TYPESAFE_API_KEY to be set");
  }
  const timeoutMs = Number(readFlag(args, "--timeout") ?? "");
  const maxTotalCostUsd = Number(readFlag(args, "--budget") ?? "");
  if (!Number.isFinite(timeoutMs) || !Number.isFinite(maxTotalCostUsd)) {
    throw new Error("--live requires --timeout and --budget to both be numbers");
  }
  const run = await runLiveBaselineBenchmark(fixtures, baselines, {
    apiKey,
    timeoutMs,
    budget: { maxTotalCostUsd },
  });
  const summary = summarizeBaselineBenchmark(run.rows, run.classification);
  const { resultsPath, summaryPath } = await writeBaselineBenchmarkResults(
    run.rows,
    summary,
    DEFAULT_OUTPUT_DIR,
    io,
  );
  console.log(`live mode: wrote ${resultsPath} and ${summaryPath}`);
  console.log(`decision: ${summary.decision.recommendation}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
