import {
  choiceConfidence,
  evaluateJev,
  JEV_MODEL,
  type JevQuestions,
} from "../adapters/typesafe.ts";
import {
  type JevEvaluator,
  type ResearchContinuationClassifierConfig,
  sanitizeObjective,
} from "../tasks/research-continuation-classifier.ts";

export type SpecialistCandidate = Readonly<{ readonly name: string; readonly description: string }>;
export type SpecialistClassifier = (
  goal: string,
  candidates: readonly SpecialistCandidate[],
) => Promise<string | undefined>;

/** A pick below this confidence is no pick. */
const CONFIDENCE_THRESHOLD = 0.8;
/** Jev's per-question option limit, `no_fit` included; above it Tandem doesn't guess. */
const MAX_CHOICES = 64;
/** The underscore keeps it outside the specialist name pattern, so no specialist can claim it. */
const NO_FIT = "no_fit";
const QUESTION_ID = "specialist";

/** How many described specialists Tandem can still guess between. */
export const MAX_GUESS_CANDIDATES = MAX_CHOICES - 1;

/** One Jev call; any missing key, failure, malformed answer, or low confidence is undefined. */
export async function classifySpecialist(
  goal: string,
  candidates: readonly SpecialistCandidate[],
  config: ResearchContinuationClassifierConfig,
  evaluate: JevEvaluator = evaluateJev,
): Promise<string | undefined> {
  const objective = sanitizeObjective(goal);
  if (config.apiKey === undefined || objective.length === 0) return undefined;
  if (candidates.length === 0 || candidates.length > MAX_GUESS_CANDIDATES) return undefined;
  const questions: JevQuestions = {
    [QUESTION_ID]: {
      type: "choice",
      instructions:
        "Pick the specialist whose description best fits this goal. Choose exactly one listed option. The choice only picks instructions and a checklist for the engineer; it never approves or scopes work.",
      criteria: {
        ...Object.fromEntries(candidates.map(({ name, description }) => [name, description])),
        [NO_FIT]: "None of the listed specialists fits, or more than one fits equally.",
      },
    },
  };
  try {
    const response = await evaluate(
      { model: JEV_MODEL, state: { goal: objective }, questions },
      {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(config.gateway === undefined ? {} : { gateway: config.gateway }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      },
    );
    const answer = response.answers[QUESTION_ID];
    if (answer?.type !== "choice") return undefined;
    if (!candidates.some((candidate) => candidate.name === answer.choice)) return undefined;
    const confidence = choiceConfidence(answer);
    if (confidence === undefined || confidence < CONFIDENCE_THRESHOLD) return undefined;
    return answer.choice;
  } catch {
    return undefined;
  }
}

export function specialistClassifier(
  config: ResearchContinuationClassifierConfig,
  evaluate: JevEvaluator = evaluateJev,
): SpecialistClassifier {
  return (goal, candidates) => classifySpecialist(goal, candidates, config, evaluate);
}
