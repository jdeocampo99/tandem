import {
  choiceConfidence,
  evaluateJev,
  JEV_MODEL,
  type JevAttemptOutcome,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
  type JevGateway,
  type JevQuestions,
  jevUsageRecord,
} from "../adapters/typesafe.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import { findPullRequestRef } from "./pull-request.ts";
import type { ReviewLens } from "./review.ts";

/** Bumped whenever the questions below change shape or meaning. */
export const PR_REVIEW_ROUTE_QUESTION_VERSION = "pr-review-route/1";
const PR_REVIEW_ROUTE_CONFIDENCE_THRESHOLD = 0.8;

export type PrReviewRouteConfig = Readonly<{
  apiKey?: string;
  gateway?: JevGateway;
  timeoutMs: number;
}>;

export type PrReviewEvaluator = (
  input: JevEvaluationInput,
  options: JevEvaluationOptions,
) => Promise<JevEvaluationResponse>;

type PrReviewRoute = Readonly<{ pullRequest: string; lens: ReviewLens }>;

export type PrReviewRouteEvaluation = Readonly<{
  reason: string;
  durationMs: number;
  route?: PrReviewRoute;
  usage?: UsageRecord;
}>;

const QUESTIONS: JevQuestions = {
  request: {
    type: "choice",
    instructions:
      "The user message contains a GitHub pull request link. Decide what the user wants done with that pull request.",
    criteria: {
      review:
        "They ask to review it, look it over, check it, or give feedback on it, or they paste the link with no other request.",
      other:
        "They mention it for something else: to implement, fix, merge, compare with, or ask about status or history.",
    },
  },
  lens: {
    type: "choice",
    instructions: "If this is a review request, choose how deep the review should go.",
    criteria: {
      full: "A normal, complete review, or no depth is stated.",
      intent:
        "Only the overall idea, approach, intent, or direction; they say they do not want implementation details.",
      focus: "They name one area, file, or concern to look at, such as security or a migration.",
    },
  },
};

/**
 * Decides whether a prompt with a PR link asks for a review, and with which lens. Anything short of
 * a confident review request goes to the coordinator; an unsure lens becomes a full review.
 */
export async function classifyPrReviewPrompt(
  prompt: string,
  config: PrReviewRouteConfig,
  evaluate: PrReviewEvaluator = evaluateJev,
  now: () => number = () => performance.now(),
): Promise<PrReviewRouteEvaluation> {
  const startedAt = now();
  const done = (
    reason: string,
    outcome?: JevAttemptOutcome,
    route?: PrReviewRoute,
  ): PrReviewRouteEvaluation => {
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    return {
      reason,
      durationMs,
      ...(route === undefined ? {} : { route }),
      ...(outcome === undefined ? {} : { usage: jevUsageRecord({ outcome, durationMs, reason }) }),
    };
  };
  const ref = findPullRequestRef(prompt);
  if (ref === undefined) return done("no-pr-link");
  if (config.apiKey === undefined) return done("jev-not-configured");
  let response: JevEvaluationResponse;
  try {
    response = await evaluate(
      { model: JEV_MODEL, state: { message: prompt.slice(0, 2_000) }, questions: QUESTIONS },
      {
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        ...(config.gateway === undefined ? {} : { gateway: config.gateway }),
      },
    );
  } catch (error) {
    const code = error instanceof JevEvaluationError ? error.code : "unavailable";
    return done(`jev-${code}`, { kind: "failed", code });
  }
  const outcome: JevAttemptOutcome = { kind: "answered", usage: response.usage };
  const request = confident(response.answers.request);
  if (request !== "review") return done("not-a-review-request", outcome);
  const pullRequest = `${ref.repo}#${ref.number}`;
  const lens = confident(response.answers.lens);
  if (lens === "intent")
    return done("jev-classified", outcome, { pullRequest, lens: { kind: "intent" } });
  if (lens === "focus") {
    const focus = focusWords(prompt);
    if (focus !== undefined) {
      return done("jev-classified", outcome, { pullRequest, lens: { kind: "focus", focus } });
    }
  }
  return done("jev-classified", outcome, { pullRequest, lens: { kind: "full" } });
}

function confident(
  answer: JevEvaluationResponse["answers"][string] | undefined,
): string | undefined {
  if (answer === undefined || answer.type !== "choice") return undefined;
  const confidence = choiceConfidence(answer);
  return confidence !== undefined && confidence >= PR_REVIEW_ROUTE_CONFIDENCE_THRESHOLD
    ? answer.choice
    : undefined;
}

/** The user's own words around the link, which the reviewer reads as the area to focus on. */
function focusWords(prompt: string): string | undefined {
  const words = prompt
    .split(/\s+/)
    .filter((word) => findPullRequestRef(word) === undefined)
    .join(" ")
    .trim();
  return words.length === 0 ? undefined : words.slice(0, 300);
}
