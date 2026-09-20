import {
  evaluateJev,
  JEV_MODEL,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
  type JevFetch,
  type JevQuestions,
  type JevUsage,
} from "../adapters/typesafe.ts";
import {
  RESEARCH_CONTINUATION_SCHEMA_VERSION,
  type ResearchContinuation,
  type ResearchContinuationDisposition,
  type TaskKind,
} from "../contracts.ts";

/** Pinned closed-set question and answer schema; bump whenever the options or wording change. */
export const RESEARCH_CONTINUATION_QUESTION_VERSION = "research-continuation/1";
/** Recorded as `classifierVersion` for a Jev-selected disposition; pins question and model. */
export const RESEARCH_CONTINUATION_CLASSIFIER_VERSION =
  `${RESEARCH_CONTINUATION_QUESTION_VERSION}@${JEV_MODEL}` as const;
/** A Jev choice below this confidence is discarded for the conservative default. */
export const RESEARCH_CONTINUATION_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS = 1_500;
export const MIN_RESEARCH_CONTINUATION_TIMEOUT_MS = 100;
export const MAX_RESEARCH_CONTINUATION_TIMEOUT_MS = 10_000;
/** Upper bound on the sanitized objective sent to Jev; nothing else leaves the process. */
export const MAX_CLASSIFIED_OBJECTIVE_CHARS = 2_000;

export type ResearchContinuationReason =
  | "explicit-report-only"
  | "explicit-implementation"
  | "contradictory-cues"
  | "empty-objective"
  | "jev-classified"
  | "jev-not-configured"
  | "jev-low-confidence"
  | "jev-invalid-classification"
  | "jev-error"
  | `jev-${JevEvaluationError["code"]}`;

/** A cue-resolved disposition, or the absence of any decisive cue. */
export type DeterministicContinuation =
  | Readonly<{
      readonly resolved: true;
      readonly disposition: ResearchContinuationDisposition;
      readonly reason: Extract<
        ResearchContinuationReason,
        | "explicit-report-only"
        | "explicit-implementation"
        | "contradictory-cues"
        | "empty-objective"
      >;
    }>
  | Readonly<{ readonly resolved: false }>;

export type ResearchContinuationRequest = Readonly<{
  readonly objective: string;
  readonly taskKind: TaskKind;
}>;

export type ResearchContinuationClassification = Readonly<{
  readonly continuation: ResearchContinuation;
  readonly reason: ResearchContinuationReason;
  readonly durationMs: number;
  /** Reported by the transport when Jev answered; absent for deterministic and failed calls. */
  readonly usage?: JevUsage;
}>;

export type ResearchContinuationClassifier = (
  request: ResearchContinuationRequest,
) => Promise<ResearchContinuationClassification>;

export type ResearchContinuationClassifierConfig = Readonly<{
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly fetch?: JevFetch;
}>;

export type JevEvaluator = (
  input: JevEvaluationInput,
  options: JevEvaluationOptions,
) => Promise<JevEvaluationResponse>;

const REPORT_ONLY_CUES: readonly RegExp[] = [
  /\b(?:research|investigation|report|analysis|reading|review)[\s-]only\b/u,
  /\b(?:just|only) (?:research|investigate|look|read|report|summar(?:ize|ise))\b/u,
  /\b(?:do not|don['’]t|never) (?:implement|fix|patch|change|modify|edit|write)\b/u,
  /\bno (?:code )?(?:changes?|implementation|fixes?|patches?|edits?)\b/u,
  /\bwithout (?:implementing|fixing|patching|changing|modifying|editing)\b/u,
  /\b(?:summar(?:ize|ise)|explain|compare|write[\s-]?up|find out|look up|read up on)\b/u,
  /^(?:what|which|why|how|when|where|who)\b/u,
];

const IMPLEMENTATION_CUES: readonly RegExp[] = [
  /\b(?:then|and|afterwards?|next|finally)[,\s]+(?:fix|implement|patch|repair|refactor|resolve|correct)\b/u,
  /\b(?:fix|patch|repair|refactor)\s+(?:it|this|that|them|these|those|the|our|my)\b/u,
  /\bimplement(?:s|ing|ed)?\b/u,
  /\b(?:prepare|write|produce|open|draft|make|submit)\s+(?:a|an|the)?\s*(?:patch|fix|pull request|pr|code change|changes?|implementation)\b/u,
];

const CONTINUATION_QUESTION_ID = "continuation";

const CONTINUATION_QUESTIONS: JevQuestions = {
  [CONTINUATION_QUESTION_ID]: {
    type: "choice",
    instructions:
      "Decide what the requester wants after this research finishes. Choose exactly one listed option. The choice is routing metadata only: it never approves, schedules, or scopes implementation work.",
    criteria: {
      "report-only":
        "The requester asked for information, an answer, or a written summary and did not ask for any change to be made.",
      "implementation-interview":
        "The requester explicitly asked for the researched problem to be fixed, implemented, or prepared as a patch after the research.",
      "ask-intent":
        "The request does not state clearly whether implementation work is wanted after the research.",
    },
  },
};

function isDisposition(choice: string): choice is ResearchContinuationDisposition {
  return (
    choice === "report-only" || choice === "ask-intent" || choice === "implementation-interview"
  );
}

/** C0/C1 controls plus the line and paragraph separators Jev refuses in state text. */
const CONTROL_CHARACTERS = /\p{Cc}|\p{Zl}|\p{Zp}/gu;

/** Collapse a free-text objective to bounded single-line text safe to send off the machine. */
export function sanitizeObjective(objective: string): string {
  return objective
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_CLASSIFIED_OBJECTIVE_CHARS);
}

/**
 * Pure deterministic cue table. Explicit information-only wording resolves to `report-only`;
 * explicit investigate-then-change wording resolves to `implementation-interview`; wording that
 * carries both cues resolves conservatively to `ask-intent` so a classifier can never upgrade it.
 */
export function classifyContinuationCues(objective: string): DeterministicContinuation {
  const text = sanitizeObjective(objective).toLowerCase();
  if (text.length === 0) {
    return { resolved: true, disposition: "ask-intent", reason: "empty-objective" };
  }
  const reportOnly = REPORT_ONLY_CUES.some((cue) => cue.test(text));
  const implementation = IMPLEMENTATION_CUES.some((cue) => cue.test(text));
  if (reportOnly && implementation) {
    return { resolved: true, disposition: "ask-intent", reason: "contradictory-cues" };
  }
  if (reportOnly) {
    return { resolved: true, disposition: "report-only", reason: "explicit-report-only" };
  }
  if (implementation) {
    return {
      resolved: true,
      disposition: "implementation-interview",
      reason: "explicit-implementation",
    };
  }
  return { resolved: false };
}

export function researchContinuationClassifierConfig(
  source: Readonly<Record<string, string | undefined>>,
): ResearchContinuationClassifierConfig {
  const apiKey = source.TYPESAFE_API_KEY?.trim();
  return {
    timeoutMs: parseTimeout(source.TANDEM_JEV_TIMEOUT_MS),
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
  };
}

function parseTimeout(source: string | undefined): number {
  if (source === undefined) return DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS;
  const value = Number(source);
  return Number.isSafeInteger(value) &&
    value >= MIN_RESEARCH_CONTINUATION_TIMEOUT_MS &&
    value <= MAX_RESEARCH_CONTINUATION_TIMEOUT_MS
    ? value
    : DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function selected(
  disposition: ResearchContinuationDisposition,
  reason: ResearchContinuationReason,
  startedAt: number,
): ResearchContinuationClassification {
  return {
    continuation: {
      schemaVersion: RESEARCH_CONTINUATION_SCHEMA_VERSION,
      disposition,
      selectedBy: "deterministic",
    },
    reason,
    durationMs: elapsedMs(startedAt),
  };
}

/** Every unusable classifier outcome records the same durable, conservative disposition. */
function conservative(
  reason: ResearchContinuationReason,
  startedAt: number,
  usage?: JevUsage,
): ResearchContinuationClassification {
  return {
    ...selected("ask-intent", reason, startedAt),
    ...(usage === undefined ? {} : { usage }),
  };
}

function classifiedChoice(
  response: JevEvaluationResponse,
): Readonly<{ disposition: ResearchContinuationDisposition; confidence: number }> | undefined {
  const answer = response.answers[CONTINUATION_QUESTION_ID];
  if (answer === undefined || answer.type !== "choice" || !isDisposition(answer.choice)) {
    return undefined;
  }
  const probability = answer.probabilities[answer.choice];
  if (
    probability === undefined ||
    !Number.isFinite(probability) ||
    !Number.isFinite(answer.confidence)
  ) {
    return undefined;
  }
  return {
    disposition: answer.choice,
    confidence: Math.min(answer.confidence, probability),
  };
}

/**
 * Classify what a scout's research should lead to. Deterministic cues decide on their own and
 * make no provider call; only unresolved wording reaches Jev, whose failures, malformed answers,
 * and low-confidence answers all fall back to the conservative `ask-intent` disposition.
 */
export async function classifyResearchContinuation(
  request: ResearchContinuationRequest,
  config: ResearchContinuationClassifierConfig,
  evaluate: JevEvaluator = evaluateJev,
): Promise<ResearchContinuationClassification> {
  const startedAt = performance.now();
  const objective = sanitizeObjective(request.objective);
  const deterministic = classifyContinuationCues(objective);
  if (deterministic.resolved) {
    return selected(deterministic.disposition, deterministic.reason, startedAt);
  }
  if (config.apiKey === undefined) return conservative("jev-not-configured", startedAt);

  const input: JevEvaluationInput = {
    model: JEV_MODEL,
    state: { objective, taskKind: request.taskKind },
    questions: CONTINUATION_QUESTIONS,
  };
  const options: JevEvaluationOptions = {
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  };

  let response: JevEvaluationResponse;
  try {
    response = await evaluate(input, options);
  } catch (error) {
    return conservative(
      error instanceof JevEvaluationError ? `jev-${error.code}` : "jev-error",
      startedAt,
    );
  }

  const choice = classifiedChoice(response);
  if (choice === undefined) {
    return conservative("jev-invalid-classification", startedAt, response.usage);
  }
  if (choice.confidence < RESEARCH_CONTINUATION_CONFIDENCE_THRESHOLD) {
    return conservative("jev-low-confidence", startedAt, response.usage);
  }
  return {
    continuation: {
      schemaVersion: RESEARCH_CONTINUATION_SCHEMA_VERSION,
      disposition: choice.disposition,
      selectedBy: "jev",
      classifierVersion: RESEARCH_CONTINUATION_CLASSIFIER_VERSION,
    },
    reason: "jev-classified",
    durationMs: elapsedMs(startedAt),
    usage: response.usage,
  };
}

/** Bind one configuration and transport so callers classify with a single-argument seam. */
export function researchContinuationClassifier(
  config: ResearchContinuationClassifierConfig,
  evaluate: JevEvaluator = evaluateJev,
): ResearchContinuationClassifier {
  return async (request) => classifyResearchContinuation(request, config, evaluate);
}
