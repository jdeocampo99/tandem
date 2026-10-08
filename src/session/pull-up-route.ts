import type { JevQuestions } from "../adapters/typesafe.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import {
  JevChoiceAttempt,
  type JevChoiceConfig,
  type JevChoiceEvaluator,
} from "./jev-choice-attempt.ts";

/** Bumped whenever the questions below change shape or meaning. */
export const PULL_UP_ROUTE_QUESTION_VERSION = "pull-up-route/1";
export const PULL_UP_ROUTE_CONFIDENCE_THRESHOLD = 0.8;
export const MAX_PULL_UP_CANDIDATES = 15;
const MAX_LABEL_CHARS = 200;

const PULL_UP_VERB = /\b(?:pull|bring|open|reopen|show|see|view|look|display)\b/iu;
const PULL_UP_NOUN =
  /\b(?:brief|briefs|mock|mocks|mockups?|mock-ups?|wireframes?|diagrams?|presentations?|visuals?|lavish)\b/iu;

export type PullUpCandidate = Readonly<{
  readonly kind: "brief" | "presentation";
  readonly id: string;
  /** What it is about, in the user's terms: a brief's goal or a presentation's objective. */
  readonly about: string;
}>;

export type PullUpRouteConfig = JevChoiceConfig;
export type PullUpEvaluator = JevChoiceEvaluator;

export type PullUpRouteEvaluation = Readonly<{
  reason: string;
  durationMs: number;
  target?: PullUpCandidate;
  usage?: UsageRecord;
}>;

/** A cheap screen so only prompts that name a brief or a visual pay for a Jev call. */
export function mentionsPullUp(prompt: string): boolean {
  return PULL_UP_VERB.test(prompt) && PULL_UP_NOUN.test(prompt);
}

function describe(candidate: PullUpCandidate): string {
  const about = candidate.about.replace(/\s+/gu, " ").trim().slice(0, MAX_LABEL_CHARS);
  return candidate.kind === "brief"
    ? `The request brief (the written plan) for: ${about}`
    : `The visual (mockup, diagram, or presentation) for: ${about}`;
}

function questions(candidates: readonly PullUpCandidate[]): JevQuestions {
  const criteria: Record<string, string> = {};
  candidates.forEach((candidate, index) => {
    criteria[`c${index + 1}`] = describe(candidate);
  });
  criteria.none = "None of the listed items clearly matches what the user named.";
  return {
    request: {
      type: "choice",
      instructions: "Decide what the user wants done.",
      criteria: {
        open: "They only ask to open, pull up, or show one existing brief or visual so they can look at it.",
        other:
          "Anything else: making, changing, approving, or discussing one, listing them, asking several things, or asking about something else.",
      },
    },
    target: {
      type: "choice",
      instructions:
        "Choose the listed item the user asks to see. Match both what it is about and whether they want the brief or the visual.",
      criteria,
    },
  };
}

/**
 * Picks the one brief or presentation a prompt asks to see. Anything short of a confident single
 * match goes back to the caller, which lets the coordinator handle it.
 */
export async function classifyPullUpPrompt(
  prompt: string,
  candidates: readonly PullUpCandidate[],
  config: PullUpRouteConfig,
  evaluate?: PullUpEvaluator,
  now?: () => number,
): Promise<PullUpRouteEvaluation> {
  const attempt = new JevChoiceAttempt(config, evaluate, now);
  const listed = candidates.slice(0, MAX_PULL_UP_CANDIDATES);
  if (listed.length === 0) return attempt.finish("no-candidates");
  if (config.apiKey === undefined) return attempt.finish("jev-not-configured");
  const failure = await attempt.run(prompt.slice(0, 2_000), () => questions(listed));
  if (failure !== undefined) return attempt.finish(failure);
  const request = attempt.read("request", PULL_UP_ROUTE_CONFIDENCE_THRESHOLD);
  if (request.kind !== "confident" || request.choice !== "open") {
    return attempt.finish("not-a-pull-up");
  }
  const match = attempt.read("target", PULL_UP_ROUTE_CONFIDENCE_THRESHOLD);
  const target =
    match.kind === "confident" && match.choice.startsWith("c")
      ? listed[Number(match.choice.slice(1)) - 1]
      : undefined;
  if (target === undefined) return attempt.finish("no-confident-match");
  return attempt.finish("jev-matched", { target });
}
