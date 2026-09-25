import {
  choiceConfidence,
  evaluateJev,
  JEV_MODEL,
  type JevAttemptOutcome,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
  type JevFetch,
  type JevGateway,
  type JevQuestions,
  jevUsageRecord,
} from "../adapters/typesafe.ts";
import type { TaskRecord } from "../contracts.ts";
import type { UsageRecord } from "../runtime/usage.ts";

/** Bumped whenever the questions below change shape or meaning. */
export const INVESTIGATE_ROUTE_QUESTION_VERSION = "investigate-route/1";
export const INVESTIGATE_ROUTE_CONFIDENCE_THRESHOLD = 0.8;
export const MAX_INVESTIGATE_CANDIDATES = 15;
const MAX_LABEL_CHARS = 200;

const WHY = /\bwhy\b/iu;
const TASK_TROUBLE =
  /\b(?:task|take|took|taking|long|slow|restart\w*|stuck|block\w*|fix\w*|review\w*|fail\w*)\b/iu;

export type InvestigateRouteConfig = Readonly<{
  apiKey?: string;
  gateway?: JevGateway;
  timeoutMs: number;
  fetch?: JevFetch;
}>;

export type InvestigateEvaluator = (
  input: JevEvaluationInput,
  options: JevEvaluationOptions,
) => Promise<JevEvaluationResponse>;

export type InvestigateRouteEvaluation = Readonly<{
  reason: string;
  durationMs: number;
  taskId?: string;
  usage?: UsageRecord;
}>;

/** A cheap screen so only "why did that task..." prompts pay for a Jev call. */
export function mentionsInvestigation(prompt: string): boolean {
  return WHY.test(prompt) && TASK_TROUBLE.test(prompt);
}

/** The tasks a question could be about, most recently changed first. */
export function investigateCandidates(tasks: readonly TaskRecord[]): readonly TaskRecord[] {
  return tasks
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_INVESTIGATE_CANDIDATES);
}

function questions(candidates: readonly TaskRecord[]): JevQuestions {
  const criteria: Record<string, string> = {};
  candidates.forEach((task, index) => {
    const about = task.objective.replace(/\s+/gu, " ").trim().slice(0, MAX_LABEL_CHARS);
    criteria[`c${index + 1}`] = `The task (now ${task.stage}) to: ${about}`;
  });
  criteria.none = "None of the listed tasks clearly matches the one the user means.";
  return {
    request: {
      type: "choice",
      instructions: "Decide what the user wants.",
      criteria: {
        investigate:
          "They ask why a task went the way it did: why it took so long, kept restarting, got stuck, or needed many rounds of fixes.",
        other:
          "Anything else: asking about the task's code or results, asking for a change, asking how it is going, or asking several things.",
      },
    },
    target: {
      type: "choice",
      instructions:
        "Choose the listed task the user asks about. When they say 'that task' or 'it', choose the one the rest of the message points to.",
      criteria,
    },
  };
}

/**
 * Picks the one task a "why did that take so long?" prompt asks about. Anything short of a
 * confident single match goes back to the caller, which lets the coordinator handle it.
 */
export async function classifyInvestigatePrompt(
  prompt: string,
  candidates: readonly TaskRecord[],
  config: InvestigateRouteConfig,
  evaluate: InvestigateEvaluator = evaluateJev,
  now: () => number = () => performance.now(),
): Promise<InvestigateRouteEvaluation> {
  const startedAt = now();
  const done = (
    reason: string,
    outcome?: JevAttemptOutcome,
    taskId?: string,
  ): InvestigateRouteEvaluation => {
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    return {
      reason,
      durationMs,
      ...(taskId === undefined ? {} : { taskId }),
      ...(outcome === undefined ? {} : { usage: jevUsageRecord({ outcome, durationMs, reason }) }),
    };
  };
  const listed = candidates.slice(0, MAX_INVESTIGATE_CANDIDATES);
  if (listed.length === 0) return done("no-candidates");
  if (config.apiKey === undefined) return done("jev-not-configured");
  let response: JevEvaluationResponse;
  try {
    response = await evaluate(
      {
        model: JEV_MODEL,
        state: { message: prompt.slice(0, 2_000) },
        questions: questions(listed),
      },
      {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
        ...(config.gateway === undefined ? {} : { gateway: config.gateway }),
      },
    );
  } catch (error) {
    const code = error instanceof JevEvaluationError ? error.code : "unavailable";
    return done(`jev-${code}`, { kind: "failed", code });
  }
  const outcome: JevAttemptOutcome = { kind: "answered", usage: response.usage };
  if (confident(response.answers.request) !== "investigate") {
    return done("not-an-investigation", outcome);
  }
  const choice = confident(response.answers.target);
  const task = choice?.startsWith("c") ? listed[Number(choice.slice(1)) - 1] : undefined;
  if (task === undefined) return done("no-confident-match", outcome);
  return done("jev-matched", outcome, task.id);
}

function confident(
  answer: JevEvaluationResponse["answers"][string] | undefined,
): string | undefined {
  if (answer === undefined || answer.type !== "choice") return undefined;
  const confidence = choiceConfidence(answer);
  return confidence !== undefined && confidence >= INVESTIGATE_ROUTE_CONFIDENCE_THRESHOLD
    ? answer.choice
    : undefined;
}
