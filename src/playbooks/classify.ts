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
import type { PinnablePlaybookId } from "./catalog.ts";
import { JOB_TYPES, type JobType, selectPlaybook } from "./selection.ts";

export type PlaybookClassifier = (goal: string) => Promise<PinnablePlaybookId>;

const QUESTION_ID = "jobType";

const QUESTIONS: JevQuestions = {
  [QUESTION_ID]: {
    type: "choice",
    instructions:
      "Classify what kind of code change this goal asks for. Choose exactly one listed option. The choice only picks a checklist for the engineer; it never approves or scopes work.",
    criteria: {
      "bug-fix": "Something that used to work, or should work, behaves wrongly and must be fixed.",
      feature: "New behavior or capability is added.",
      refactor: "The code's structure changes while its behavior stays the same.",
      perf: "Existing behavior must get faster or use fewer resources.",
      other: "None of the above, or more than one fits equally.",
    },
  },
};

function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

/**
 * One Jev call that picks the playbook for a goal. Jev never approves anything: every missing key,
 * failure, malformed answer, or low-confidence pick falls back to the general playbook.
 */
export async function classifyPlaybook(
  goal: string,
  config: ResearchContinuationClassifierConfig,
  evaluate: JevEvaluator = evaluateJev,
): Promise<PinnablePlaybookId> {
  const objective = sanitizeObjective(goal);
  if (config.apiKey === undefined || objective.length === 0) return "general";
  try {
    const response = await evaluate(
      { model: JEV_MODEL, state: { goal: objective }, questions: QUESTIONS },
      {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      },
    );
    const answer = response.answers[QUESTION_ID];
    if (answer?.type !== "choice" || !isJobType(answer.choice)) return "general";
    const confidence = choiceConfidence(answer);
    return confidence === undefined
      ? "general"
      : selectPlaybook({ jobType: answer.choice, confidence });
  } catch {
    return "general";
  }
}

export function playbookClassifier(
  config: ResearchContinuationClassifierConfig,
  evaluate: JevEvaluator = evaluateJev,
): PlaybookClassifier {
  return (goal) => classifyPlaybook(goal, config, evaluate);
}
