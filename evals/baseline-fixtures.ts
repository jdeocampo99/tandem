/**
 * Fixture schema and loader for the control-arm baseline used by the Jev-vs-no-Jev benchmark
 * (`evals/benchmark.ts`).
 *
 * Every record here is a bounded, synthetic recording of what the normal coordinator path (no
 * classification) does for the matching `PromptRoutingFixture` in
 * `evals/fixtures/prompt-routing.jsonl`, keyed by the same fixture id. It is never a measured
 * production number: default CI must never call TypeSafe, Herdr, Treehouse, GitHub, or OMP, so the
 * control arm cannot be observed live inside `bun test`. `docs/jev-evaluation.md` documents how
 * each number was chosen and why it is safe to treat as a fixed, comparable baseline.
 *
 * A record's optional `directAction` describes what happens if the same prompt were ever routed
 * directly instead: the bounded outcome of executing the one matching read-only Tandem action. It
 * is present only on fixtures where a direct route is possible in fake-mode replay (the six
 * safe-direct fixtures, plus the deliberately miscalibrated adversarial fixture that a
 * misclassification routes directly by mistake); every other fixture never reaches a direct action,
 * so recording one for it would fabricate data no run can produce.
 */

import { readFile } from "node:fs/promises";

export const BASELINE_RECORDING_FIXTURE_SET_VERSION = "baseline-recordings-2026.09.20-v1";

export type VerifiedCorrectness = "correct" | "incorrect";
export type VerifiedSafety = "safe" | "unsafe";

export type BaselineDirectAction = Readonly<{
  readonly durationMs: number;
  readonly outcome: "success" | "failure";
  readonly correctness: VerifiedCorrectness;
  readonly safety: VerifiedSafety;
}>;

export type BaselineRecording = Readonly<{
  readonly fixtureId: string;
  readonly fixtureSetVersion: string;
  readonly description: string;
  readonly coordinatorTurns: number;
  readonly coordinatorDurationMs: number;
  readonly correctness: VerifiedCorrectness;
  readonly safety: VerifiedSafety;
  readonly actionFailures: number;
  readonly corrections: number;
  readonly reworkCount: number;
  readonly humanInterventionRequired: boolean;
  /** Recorded time a Jev fallback demonstrably avoided in the coordinator path; 0 unless documented. */
  readonly downstreamWorkAvoidedMs: number;
  readonly directAction?: BaselineDirectAction;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`baseline recording ${context}: ${field} must be a non-empty string`);
  }
  return value;
}

function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  context: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`baseline recording ${context}: ${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function requirePositiveInteger(value: unknown, field: string, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`baseline recording ${context}: ${field} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`baseline recording ${context}: ${field} must be a non-negative integer`);
  }
  return value;
}

function requireNonNegativeDuration(value: unknown, field: string, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`baseline recording ${context}: ${field} must be a non-negative number`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`baseline recording ${context}: ${field} must be a boolean`);
  }
  return value;
}

function validateDirectAction(value: unknown, context: string): BaselineDirectAction | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new Error(`baseline recording ${context}: directAction must be an object`);
  return {
    durationMs: requireNonNegativeDuration(value.durationMs, "directAction.durationMs", context),
    outcome: requireOneOf(value.outcome, ["success", "failure"], "directAction.outcome", context),
    correctness: requireOneOf(
      value.correctness,
      ["correct", "incorrect"],
      "directAction.correctness",
      context,
    ),
    safety: requireOneOf(value.safety, ["safe", "unsafe"], "directAction.safety", context),
  };
}

function validateRecording(value: unknown, lineNumber: number): BaselineRecording {
  const context = `at line ${lineNumber}`;
  if (!isRecord(value)) throw new Error(`baseline recording ${context}: must be a JSON object`);
  const fixtureId = requireString(value.fixtureId, "fixtureId", context);
  const fixtureSetVersion = requireString(value.fixtureSetVersion, "fixtureSetVersion", context);
  const description = requireString(value.description, "description", context);
  const directAction = validateDirectAction(value.directAction, context);
  return {
    fixtureId,
    fixtureSetVersion,
    description,
    coordinatorTurns: requirePositiveInteger(value.coordinatorTurns, "coordinatorTurns", context),
    coordinatorDurationMs: requireNonNegativeDuration(
      value.coordinatorDurationMs,
      "coordinatorDurationMs",
      context,
    ),
    correctness: requireOneOf(value.correctness, ["correct", "incorrect"], "correctness", context),
    safety: requireOneOf(value.safety, ["safe", "unsafe"], "safety", context),
    actionFailures: requireNonNegativeInteger(value.actionFailures, "actionFailures", context),
    corrections: requireNonNegativeInteger(value.corrections, "corrections", context),
    reworkCount: requireNonNegativeInteger(value.reworkCount, "reworkCount", context),
    humanInterventionRequired: requireBoolean(
      value.humanInterventionRequired,
      "humanInterventionRequired",
      context,
    ),
    downstreamWorkAvoidedMs:
      value.downstreamWorkAvoidedMs === undefined
        ? 0
        : requireNonNegativeDuration(
            value.downstreamWorkAvoidedMs,
            "downstreamWorkAvoidedMs",
            context,
          ),
    ...(directAction === undefined ? {} : { directAction }),
  };
}

/** Parses and validates the baseline recording set from JSONL text. Pure: no filesystem access. */
export function parseBaselineRecordings(jsonl: string): readonly BaselineRecording[] {
  const recordings: BaselineRecording[] = [];
  const seenIds = new Set<string>();
  const lines = jsonl.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`baseline recording at line ${index + 1} is not valid JSON: ${message}`);
    }
    const recording = validateRecording(parsed, index + 1);
    if (recording.fixtureSetVersion !== BASELINE_RECORDING_FIXTURE_SET_VERSION) {
      throw new Error(
        `baseline recording ${recording.fixtureId} declares version ${recording.fixtureSetVersion}, ` +
          `expected ${BASELINE_RECORDING_FIXTURE_SET_VERSION}`,
      );
    }
    if (seenIds.has(recording.fixtureId)) {
      throw new Error(`duplicate baseline recording fixtureId ${recording.fixtureId}`);
    }
    seenIds.add(recording.fixtureId);
    recordings.push(recording);
  }
  if (recordings.length === 0) throw new Error("baseline recording set is empty");
  return recordings;
}

/** Reads and validates the baseline recording set from disk. */
export async function loadBaselineRecordings(path: string): Promise<readonly BaselineRecording[]> {
  return parseBaselineRecordings(await readFile(path, "utf8"));
}
