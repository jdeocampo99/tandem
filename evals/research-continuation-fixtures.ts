/**
 * Fixture schema and loader for the fixture-driven post-research continuation evaluation harness
 * (issue #28). A fixture drives two production seams in sequence: the classifier
 * (`classifyResearchContinuation` in `src/tasks/research-continuation-classifier.ts`) decides a
 * disposition from a request objective, and the pure follow-up decision
 * (`decideResearchFollowUp`/`buildResearchFollowUpContent` in `src/tasks/research-continuation.ts`
 * and `src/session/research-follow-up.ts`) turns that disposition, plus the scout's durable
 * stage, into the coordinator-facing wake content. The loader only validates fixture shape; it
 * never decides how a fixture should classify or resolve, since that decision belongs to the
 * production code under test.
 *
 * Reuses the generic JSONL parsing shell (`parseFixtureLines`) from `./fixtures.ts` rather than
 * writing a second one, per issue #28's instruction not to duplicate harness plumbing.
 */

import { readFile } from "node:fs/promises";
import type { JevEvaluationError, JevEvaluationResponse } from "../src/adapters/typesafe.ts";
import {
  RESEARCH_CONTINUATION_DISPOSITIONS,
  RESEARCH_CONTINUATION_SELECTORS,
  type ResearchContinuationDisposition,
  type ResearchContinuationSelector,
} from "../src/contracts.ts";
import type {
  ResearchContinuationOverride,
  ResearchFollowUp,
} from "../src/tasks/research-continuation.ts";
import { isRecord, parseFixtureLines, requireOneOf, requireString } from "./fixtures.ts";

/** Bump whenever a fixture field is added, removed, or reinterpreted. */
export const RESEARCH_CONTINUATION_FIXTURE_SET_VERSION =
  "research-continuation-fixtures-2026.09.20-v1";

/**
 * The category of continuation scenario this fixture exercises, named after the coverage buckets
 * issue #28 asks for. `scout-failed` and `scout-blocked` both land on Tandem's single `blocked`
 * `TaskStage` (there is no separate "failed" stage), distinguished here only for reporting.
 */
export type ResearchContinuationScenario =
  | "explicit-report-only"
  | "explicit-implementation"
  | "ambiguous-ticket"
  | "contradictory-request"
  | "jev-not-configured"
  | "jev-unavailable"
  | "jev-timeout"
  | "jev-malformed"
  | "jev-low-confidence"
  | "scout-completed"
  | "scout-blocked"
  | "scout-failed"
  | "scout-cancelled"
  | "scout-needs-decision"
  | "scout-missing-report"
  | "scout-stale-generation"
  | "scout-restart-compaction";

/**
 * The durable scout state to build before deciding the follow-up: which override (if any)
 * `decideResearchFollowUp` should apply on top of the classified disposition.
 */
export type ResearchContinuationScoutOutcome =
  | "completed"
  | "blocked"
  | "cancelled"
  | "needs-decision"
  | "missing-report"
  | "stale-generation";

const SCENARIOS: readonly ResearchContinuationScenario[] = [
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
  "scout-cancelled",
  "scout-needs-decision",
  "scout-missing-report",
  "scout-stale-generation",
  "scout-restart-compaction",
];

const SCOUT_OUTCOMES: readonly ResearchContinuationScoutOutcome[] = [
  "completed",
  "blocked",
  "cancelled",
  "needs-decision",
  "missing-report",
  "stale-generation",
];

const FOLLOW_UPS: readonly ResearchFollowUp[] = [
  ...RESEARCH_CONTINUATION_DISPOSITIONS,
  "answer-question",
  "disclose-blocker",
];

const OVERRIDES: readonly ResearchContinuationOverride[] = [
  "not-a-scout",
  "open-question",
  "blocked",
  "cancelled",
  "incomplete",
  "stale-generation",
  "missing-report",
];

const JEV_FAILURE_CODES: readonly JevEvaluationError["code"][] = [
  "invalid-request",
  "unavailable",
  "invalid-response",
  "timeout",
];

export type ResearchContinuationFixture = Readonly<{
  readonly id: string;
  readonly fixtureSetVersion: string;
  readonly description: string;
  readonly scenario: ResearchContinuationScenario;
  /** The sanitized, synthetic request objective fed to the classifier. */
  readonly objective: string;
  /** Whether a Jev API key is configured for this fixture's classification attempt. Default true. */
  readonly jevConfigured?: boolean;
  /** A recorded typed Jev response to replay when the deterministic cues leave this ambiguous. */
  readonly jevResponse?: JevEvaluationResponse;
  /** A simulated provider failure to replay instead. Mutually exclusive with `jevResponse`. */
  readonly jevFailureCode?: JevEvaluationError["code"];
  readonly expectedDisposition: ResearchContinuationDisposition;
  readonly expectedSelectedBy: ResearchContinuationSelector;
  /** The exact `ResearchContinuationClassification.reason` this fixture is expected to produce. */
  readonly expectedClassifierReason: string;
  /** The scout durable state to build before deciding the follow-up. */
  readonly scoutOutcome: ResearchContinuationScoutOutcome;
  /**
   * When true, the runner rebuilds the scout from a fresh task-store instance over the same
   * temporary home before deciding the follow-up a second time, and asserts identical content.
   */
  readonly restartCheck?: boolean;
  readonly expectedFollowUp: ResearchFollowUp;
  readonly expectedOverride?: ResearchContinuationOverride;
  /** Substrings the rendered follow-up content must contain. */
  readonly contentMustContain: readonly string[];
  /** Substrings the rendered follow-up content must never contain. */
  readonly contentMustNotContain: readonly string[];
}>;

function requireStringArray(value: unknown, field: string, context: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`fixture ${context}: ${field} must be an array of strings`);
  }
  return value as readonly string[];
}

function validateFixture(value: unknown, lineNumber: number): ResearchContinuationFixture {
  const context = `at line ${lineNumber}`;
  if (!isRecord(value)) throw new Error(`fixture ${context}: must be a JSON object`);
  const id = requireString(value.id, "id", context);
  const fixtureSetVersion = requireString(value.fixtureSetVersion, "fixtureSetVersion", context);
  const description = requireString(value.description, "description", context);
  const scenario = requireOneOf(value.scenario, SCENARIOS, "scenario", context);
  const objective = requireString(value.objective, "objective", context);
  const jevConfigured =
    value.jevConfigured === undefined ? undefined : Boolean(value.jevConfigured);
  const jevResponse = value.jevResponse as JevEvaluationResponse | undefined;
  const jevFailureCode =
    value.jevFailureCode === undefined
      ? undefined
      : requireOneOf(value.jevFailureCode, JEV_FAILURE_CODES, "jevFailureCode", context);
  if (jevResponse !== undefined && jevFailureCode !== undefined) {
    throw new Error(`fixture ${context}: jevResponse and jevFailureCode are mutually exclusive`);
  }
  const expectedDisposition = requireOneOf(
    value.expectedDisposition,
    RESEARCH_CONTINUATION_DISPOSITIONS,
    "expectedDisposition",
    context,
  );
  const expectedSelectedBy = requireOneOf(
    value.expectedSelectedBy,
    RESEARCH_CONTINUATION_SELECTORS,
    "expectedSelectedBy",
    context,
  );
  const expectedClassifierReason = requireString(
    value.expectedClassifierReason,
    "expectedClassifierReason",
    context,
  );
  const scoutOutcome = requireOneOf(value.scoutOutcome, SCOUT_OUTCOMES, "scoutOutcome", context);
  const restartCheck = value.restartCheck === undefined ? undefined : Boolean(value.restartCheck);
  const expectedFollowUp = requireOneOf(
    value.expectedFollowUp,
    FOLLOW_UPS,
    "expectedFollowUp",
    context,
  );
  const expectedOverride =
    value.expectedOverride === undefined
      ? undefined
      : requireOneOf(value.expectedOverride, OVERRIDES, "expectedOverride", context);
  const contentMustContain = requireStringArray(
    value.contentMustContain ?? [],
    "contentMustContain",
    context,
  );
  const contentMustNotContain = requireStringArray(
    value.contentMustNotContain ?? [],
    "contentMustNotContain",
    context,
  );
  return {
    id,
    fixtureSetVersion,
    description,
    scenario,
    objective,
    ...(jevConfigured === undefined ? {} : { jevConfigured }),
    ...(jevResponse === undefined ? {} : { jevResponse }),
    ...(jevFailureCode === undefined ? {} : { jevFailureCode }),
    expectedDisposition,
    expectedSelectedBy,
    expectedClassifierReason,
    scoutOutcome,
    ...(restartCheck === undefined ? {} : { restartCheck }),
    expectedFollowUp,
    ...(expectedOverride === undefined ? {} : { expectedOverride }),
    contentMustContain,
    contentMustNotContain,
  };
}

/** Parses and validates a research-continuation fixture set from JSONL text. Pure: no filesystem. */
export function parseResearchContinuationFixtures(
  jsonl: string,
): readonly ResearchContinuationFixture[] {
  return parseFixtureLines(jsonl, RESEARCH_CONTINUATION_FIXTURE_SET_VERSION, validateFixture);
}

/** Reads and validates a research-continuation fixture set from disk. */
export async function loadResearchContinuationFixtures(
  path: string,
): Promise<readonly ResearchContinuationFixture[]> {
  return parseResearchContinuationFixtures(await readFile(path, "utf8"));
}
