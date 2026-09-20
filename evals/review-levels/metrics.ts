import { REVIEW_LEVEL_ORDER, type ReviewLevel, type SafetyFloor } from "../../src/contracts.ts";
import {
  classifyReviewLevel,
  maxReviewLevel,
  reclassifyReviewLevel,
} from "../../src/tasks/review-levels.ts";
import type { ReviewLevelFixture } from "./fixtures.ts";

/**
 * A measurement the harness cannot take without a provider that reports it. It stays
 * `unavailable` rather than becoming zero, so an unreported number is never read as a cheap one.
 */
export type ReportedMeasure = number | "unavailable";

/** Which selection produced a report: the deterministic rule, or a helper standing in for it. */
export type EvaluationArm = "deterministic" | "helper-as-selector";

export type FixtureOutcome = Readonly<{
  readonly fixtureId: string;
  readonly kind: ReviewLevelFixture["kind"];
  readonly selected: ReviewLevel;
  readonly requiredMinimum: ReviewLevel;
  readonly floors: readonly SafetyFloor[];
  /** The selection is below the level this change may ever be reviewed at. A safety failure. */
  readonly falseSafe: boolean;
  /** A serious issue this fixture carries that the selected level would not have covered. */
  readonly missedSeriousIssue?: string;
  /** The selection is above the required minimum, which costs work without being unsafe. */
  readonly escalated: boolean;
  /** A later observation of the same change forced a higher level than the first round did. */
  readonly rework: boolean;
}>;

export type ReviewLevelEvaluationReport = Readonly<{
  readonly arm: EvaluationArm;
  readonly fixtures: number;
  readonly outcomes: readonly FixtureOutcome[];
  /** Counted and reported on its own; never folded into an accuracy or agreement rate. */
  readonly falseSafeRouting: number;
  readonly missedSeriousIssues: readonly string[];
  readonly escalations: number;
  readonly rework: number;
  /** Agreement with the required minimum, measured only over the fixtures that routed safely. */
  readonly safeAgreement: Readonly<{ readonly matched: number; readonly of: number }>;
  readonly wallClockMs: ReportedMeasure;
  readonly providerLatencyMs: ReportedMeasure;
  readonly inputTokens: ReportedMeasure;
  readonly outputTokens: ReportedMeasure;
  readonly estimatedCost: ReportedMeasure;
}>;

/** Selects a level for one fixture. The deterministic arm ignores everything a helper would add. */
export type LevelSelector = (fixture: ReviewLevelFixture) => ReviewLevel;

/** The deterministic selection under evaluation, including its reclassification on scope growth. */
export const deterministicSelector: LevelSelector = (fixture) => {
  const first = classifyReviewLevel({
    files: fixture.files,
    affectedCallers: fixture.affectedCallers,
    impact: fixture.impact,
  });
  const grown = fixture.grownInto;
  if (grown === undefined) return first.level;
  return reclassifyReviewLevel(
    first,
    classifyReviewLevel({
      files: grown.files,
      affectedCallers: grown.affectedCallers,
      impact: grown.impact,
    }),
  ).level;
};

/**
 * A selector that trusts the recorded helper recommendation outright. It exists only as the
 * comparison arm: nothing in Tandem routes this way, and the report is expected to show why.
 */
export const helperSelector: LevelSelector = (fixture) =>
  fixture.helperRecommendation === "unavailable" ? "standard" : fixture.helperRecommendation;

function isBelow(selected: ReviewLevel, minimum: ReviewLevel): boolean {
  return REVIEW_LEVEL_ORDER.indexOf(selected) < REVIEW_LEVEL_ORDER.indexOf(minimum);
}

function requiredMinimumFor(fixture: ReviewLevelFixture): ReviewLevel {
  return fixture.grownInto === undefined
    ? fixture.requiredMinimum
    : maxReviewLevel(fixture.requiredMinimum, fixture.grownInto.requiredMinimum);
}

/**
 * Compares one selection arm across the fixtures. The result is a pure function of the fixtures
 * and the selector, so the same inputs always produce the same report.
 */
export function evaluateReviewLevelSelection(
  input: Readonly<{
    readonly arm: EvaluationArm;
    readonly selector: LevelSelector;
    readonly fixtures: readonly ReviewLevelFixture[];
    readonly reported?: Partial<
      Pick<
        ReviewLevelEvaluationReport,
        "wallClockMs" | "providerLatencyMs" | "inputTokens" | "outputTokens" | "estimatedCost"
      >
    >;
  }>,
): ReviewLevelEvaluationReport {
  const outcomes = input.fixtures.map<FixtureOutcome>((fixture) => {
    const requiredMinimum = requiredMinimumFor(fixture);
    const selected = input.selector(fixture);
    const falseSafe = isBelow(selected, requiredMinimum);
    const firstRoundMinimum = fixture.requiredMinimum;
    return {
      fixtureId: fixture.id,
      kind: fixture.kind,
      selected,
      requiredMinimum,
      floors: classifyReviewLevel({
        files: fixture.files,
        affectedCallers: fixture.affectedCallers,
        impact: fixture.impact,
      }).floors,
      falseSafe,
      ...(falseSafe && fixture.seriousIssue !== undefined
        ? { missedSeriousIssue: fixture.seriousIssue }
        : {}),
      escalated: !falseSafe && selected !== requiredMinimum,
      rework: fixture.grownInto !== undefined && requiredMinimum !== firstRoundMinimum,
    };
  });
  const safe = outcomes.filter((outcome) => !outcome.falseSafe);
  const reported = input.reported ?? {};
  return {
    arm: input.arm,
    fixtures: outcomes.length,
    outcomes,
    falseSafeRouting: outcomes.length - safe.length,
    missedSeriousIssues: outcomes.flatMap((outcome) =>
      outcome.missedSeriousIssue === undefined ? [] : [outcome.missedSeriousIssue],
    ),
    escalations: safe.filter((outcome) => outcome.escalated).length,
    rework: outcomes.filter((outcome) => outcome.rework).length,
    safeAgreement: {
      matched: safe.filter((outcome) => outcome.selected === outcome.requiredMinimum).length,
      of: safe.length,
    },
    wallClockMs: reported.wallClockMs ?? "unavailable",
    providerLatencyMs: reported.providerLatencyMs ?? "unavailable",
    inputTokens: reported.inputTokens ?? "unavailable",
    outputTokens: reported.outputTokens ?? "unavailable",
    estimatedCost: reported.estimatedCost ?? "unavailable",
  };
}

/** Renders one report as plain lines, with no speed or quality claim attached to the numbers. */
export function describeReviewLevelEvaluation(report: ReviewLevelEvaluationReport): string {
  return [
    `arm: ${report.arm} over ${report.fixtures} fixture(s)`,
    `false-safe routing (safety failures, reported separately): ${report.falseSafeRouting}`,
    `missed serious issues: ${
      report.missedSeriousIssues.length === 0 ? "none" : report.missedSeriousIssues.join("; ")
    }`,
    `escalation above the required minimum: ${report.escalations}`,
    `rework from a later observation: ${report.rework}`,
    `agreement with the required minimum among safely routed fixtures: ${report.safeAgreement.matched}/${report.safeAgreement.of}`,
    `wall-clock ms: ${report.wallClockMs}`,
    `provider latency ms: ${report.providerLatencyMs}`,
    `input tokens: ${report.inputTokens}`,
    `output tokens: ${report.outputTokens}`,
    `estimated cost: ${report.estimatedCost}`,
  ].join("\n");
}
