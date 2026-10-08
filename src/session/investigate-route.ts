import type { JevQuestions } from "../adapters/typesafe.ts";
import type { TaskRecord } from "../contracts.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import {
  JevChoiceAttempt,
  type JevChoiceConfig,
  type JevChoiceEvaluator,
} from "./jev-choice-attempt.ts";

/** Bumped whenever the questions below change shape or meaning. */
export const INVESTIGATE_ROUTE_QUESTION_VERSION = "investigate-route/1";
export const INVESTIGATE_ROUTE_CONFIDENCE_THRESHOLD = 0.8;
export const MAX_INVESTIGATE_CANDIDATES = 15;
const MAX_LABEL_CHARS = 200;

const WHY = /\bwhy\b/iu;
const TASK_TROUBLE =
  /\b(?:task|take|took|taking|long|slow|restart\w*|stuck|block\w*|fix\w*|review\w*|fail\w*)\b/iu;

export type InvestigateRouteConfig = JevChoiceConfig;
export type InvestigateEvaluator = JevChoiceEvaluator;

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
  evaluate?: InvestigateEvaluator,
  now?: () => number,
): Promise<InvestigateRouteEvaluation> {
  const attempt = new JevChoiceAttempt(config, evaluate, now);
  const listed = candidates.slice(0, MAX_INVESTIGATE_CANDIDATES);
  if (listed.length === 0) return attempt.finish("no-candidates");
  if (config.apiKey === undefined) return attempt.finish("jev-not-configured");
  const failure = await attempt.run(prompt.slice(0, 2_000), () => questions(listed));
  if (failure !== undefined) return attempt.finish(failure);
  const request = attempt.read("request", INVESTIGATE_ROUTE_CONFIDENCE_THRESHOLD);
  if (request.kind !== "confident" || request.choice !== "investigate") {
    return attempt.finish("not-an-investigation");
  }
  const target = attempt.read("target", INVESTIGATE_ROUTE_CONFIDENCE_THRESHOLD);
  const task =
    target.kind === "confident" && target.choice.startsWith("c")
      ? listed[Number(target.choice.slice(1)) - 1]
      : undefined;
  if (task === undefined) return attempt.finish("no-confident-match");
  return attempt.finish("jev-matched", { taskId: task.id });
}
