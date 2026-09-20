/**
 * Fixture schema and loader for the fixture-driven Jev routing evaluation harness.
 *
 * A fixture is a single sanitized, synthetic prompt-routing scenario: the prompt, an optional
 * explicit task id, either a recorded typed Jev response or a simulated provider failure, the
 * route Tandem's routing policy (`src/extension/prompt-routing.ts`) is expected to take, the
 * classification fields it is expected to produce, and a safety classification describing why a
 * direct route would (or would not) be safe. The loader only validates fixture shape; it never
 * decides how a fixture should be routed, since that decision belongs to the production routing
 * policy under test, not to the harness.
 *
 * Exported for reuse by later stacked evaluation work (baseline-vs-Jev benchmarks, research
 * continuation evals) so every harness shares one fixture format and one loader.
 */

import { readFile } from "node:fs/promises";
import type { JevEvaluationError, JevEvaluationResponse } from "../src/adapters/typesafe.ts";
import type { PromptRoutingDecision } from "../src/extension/prompt-routing.ts";

/** Bump whenever a fixture field is added, removed, or reinterpreted. */
export const PROMPT_ROUTING_FIXTURE_SET_VERSION = "prompt-routing-fixtures-2026.09.20-v1";

/**
 * Why a direct route would or would not be safe for this fixture's prompt:
 * - `safe-direct`: the request is a supported read-only lookup; routing it directly is intended.
 * - `state-changing`: the request could create, control, or otherwise mutate durable state.
 * - `sensitive`: the request involves approval, credentials, publication, merging, or deletion.
 * - `ambiguous`: the request is unresolved, mixed, or otherwise unsafe to guess at.
 * - `provider-failure`: the provider call itself fails; no route decision is possible.
 * - `bypass`: the prompt never reaches classification (an image attachment or a slash command).
 */
export type PromptRoutingSafetyClass =
  | "safe-direct"
  | "state-changing"
  | "sensitive"
  | "ambiguous"
  | "provider-failure"
  | "bypass";

export type PromptRoutingFixtureBypass = "slash-command" | "image";

/** The classification fields a fixture expects, compared against Jev's raw per-field choices. */
export type PromptRoutingExpectedDecision = Readonly<
  Partial<
    Pick<PromptRoutingDecision, "action" | "target" | "effect" | "scope" | "composition" | "taskId">
  >
>;

export type PromptRoutingFixture = Readonly<{
  readonly id: string;
  readonly fixtureSetVersion: string;
  readonly description: string;
  readonly prompt: string;
  readonly taskId?: string;
  /** Set only for fixtures that never reach classification at all. */
  readonly bypass?: PromptRoutingFixtureBypass;
  /** A recorded typed Jev response to replay in fake mode. Mutually exclusive with `jevFailureCode`. */
  readonly jevResponse?: JevEvaluationResponse;
  /** A simulated provider failure to replay in fake mode. Mutually exclusive with `jevResponse`. */
  readonly jevFailureCode?: JevEvaluationError["code"];
  readonly expectedRoute: "direct" | "fallback";
  /** The exact `PromptRoutingEvaluation.reason` this fixture's recorded response should produce. */
  readonly expectedReason: string;
  readonly expectedDecision?: PromptRoutingExpectedDecision;
  readonly safety: PromptRoutingSafetyClass;
}>;

const SAFETY_CLASSES: readonly PromptRoutingSafetyClass[] = [
  "safe-direct",
  "state-changing",
  "sensitive",
  "ambiguous",
  "provider-failure",
  "bypass",
];
const BYPASS_KINDS: readonly PromptRoutingFixtureBypass[] = ["slash-command", "image"];
const JEV_FAILURE_CODES: readonly JevEvaluationError["code"][] = [
  "invalid-request",
  "unavailable",
  "invalid-response",
  "timeout",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`fixture ${context}: ${field} must be a non-empty string`);
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
    throw new Error(`fixture ${context}: ${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function validateExpectedDecision(
  value: unknown,
  context: string,
): PromptRoutingExpectedDecision | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`fixture ${context}: expectedDecision must be an object`);
  const decision: Record<string, string> = {};
  for (const field of ["action", "target", "effect", "scope", "composition", "taskId"]) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    decision[field] = requireString(fieldValue, `expectedDecision.${field}`, context);
  }
  return decision as PromptRoutingExpectedDecision;
}

function validateFixture(value: unknown, lineNumber: number): PromptRoutingFixture {
  const context = `at line ${lineNumber}`;
  if (!isRecord(value)) throw new Error(`fixture ${context}: must be a JSON object`);
  const id = requireString(value.id, "id", context);
  const fixtureSetVersion = requireString(value.fixtureSetVersion, "fixtureSetVersion", context);
  const description = requireString(value.description, "description", context);
  const prompt = requireString(value.prompt, "prompt", context);
  const bypass =
    value.bypass === undefined
      ? undefined
      : requireOneOf(value.bypass, BYPASS_KINDS, "bypass", context);
  const jevResponse = value.jevResponse as JevEvaluationResponse | undefined;
  const jevFailureCode =
    value.jevFailureCode === undefined
      ? undefined
      : requireOneOf(value.jevFailureCode, JEV_FAILURE_CODES, "jevFailureCode", context);
  if (jevResponse !== undefined && jevFailureCode !== undefined) {
    throw new Error(`fixture ${context}: jevResponse and jevFailureCode are mutually exclusive`);
  }
  if (bypass === undefined && jevResponse === undefined && jevFailureCode === undefined) {
    throw new Error(`fixture ${context}: needs a jevResponse, a jevFailureCode, or a bypass`);
  }
  const expectedRoute = requireOneOf(
    value.expectedRoute,
    ["direct", "fallback"],
    "expectedRoute",
    context,
  );
  const expectedReason = requireString(value.expectedReason, "expectedReason", context);
  const expectedDecision = validateExpectedDecision(value.expectedDecision, context);
  const safety = requireOneOf(value.safety, SAFETY_CLASSES, "safety", context);
  return {
    id,
    fixtureSetVersion,
    description,
    prompt,
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(bypass === undefined ? {} : { bypass }),
    ...(jevResponse === undefined ? {} : { jevResponse }),
    ...(jevFailureCode === undefined ? {} : { jevFailureCode }),
    expectedRoute,
    expectedReason,
    ...(expectedDecision === undefined ? {} : { expectedDecision }),
    safety,
  };
}

/** Parses and validates a prompt-routing fixture set from JSONL text. Pure: no filesystem access. */
export function parsePromptRoutingFixtures(jsonl: string): readonly PromptRoutingFixture[] {
  const fixtures: PromptRoutingFixture[] = [];
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
      throw new Error(`prompt-routing fixture at line ${index + 1} is not valid JSON: ${message}`);
    }
    const fixture = validateFixture(parsed, index + 1);
    if (fixture.fixtureSetVersion !== PROMPT_ROUTING_FIXTURE_SET_VERSION) {
      throw new Error(
        `fixture ${fixture.id} declares version ${fixture.fixtureSetVersion}, ` +
          `expected ${PROMPT_ROUTING_FIXTURE_SET_VERSION}`,
      );
    }
    if (seenIds.has(fixture.id)) throw new Error(`duplicate fixture id ${fixture.id}`);
    seenIds.add(fixture.id);
    fixtures.push(fixture);
  }
  if (fixtures.length === 0) throw new Error("prompt-routing fixture set is empty");
  return fixtures;
}

/** Reads and validates a prompt-routing fixture set from disk. */
export async function loadPromptRoutingFixtures(
  path: string,
): Promise<readonly PromptRoutingFixture[]> {
  return parsePromptRoutingFixtures(await readFile(path, "utf8"));
}
