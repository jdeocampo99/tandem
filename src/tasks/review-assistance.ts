import { createHash } from "node:crypto";
import {
  evaluateJev,
  JEV_MODEL,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
  type JevQuestions,
  jevUsageRecord,
} from "../adapters/typesafe.ts";
import type { ReviewLevel, ReviewLevelPolicy, ReviewLevelRecord } from "../contracts.ts";
import type { DiagnosticValue } from "../runtime/diagnostics.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import type { AdvisoryReviewLead } from "./review-brief.ts";
import type { ChangedFileObservation } from "./review-levels.ts";

export const DEFAULT_REVIEW_ASSISTANCE_TIMEOUT_MS = 2_000;

/**
 * Every bound the assisted path is held to. The confidence and belief cutoffs are provisional
 * placeholders, not calibrated thresholds: issue #20's end-to-end evaluation has to report a
 * sweep over them before anybody may read them as tuned, and nothing here may enable a reduction
 * on its own. The byte and count bounds are hard transmission limits and are enforced regardless.
 */
export const REVIEW_ASSISTANCE_LIMITS = {
  maxTransmittedFiles: 8,
  maxTransmittedLinesPerFile: 40,
  maxTransmittedBytes: 24 * 1024,
  maxAdvisoryLeads: 4,
  minDepthConfidence: 0.8,
  minFlagBelief: 0.7,
} as const;

/** Paths whose content is never transmitted, whatever the opt-in says. */
const SECRET_BEARING_PATHS: readonly RegExp[] = [
  /(^|\/)\.env(\.|$)/u,
  /(^|\/)(secrets?|credentials?)(\/|$)/iu,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/iu,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/u,
  /(^|\/)(\.npmrc|\.netrc|\.pgpass|\.htpasswd)$/u,
  /(^|\/)\.(aws|ssh|gnupg)(\/|$)/u,
];

/** Content shapes that look like live secret material, which is never transmitted. */
const SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/u,
  /\b(api[_-]?key|secret|password|passwd|passphrase|token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}/iu,
];

export type ReviewAssistanceRefusal = Readonly<{
  readonly path: string;
  readonly reason: "secret-bearing-path" | "secret-pattern";
}>;

export type ScreenedReviewContext = Readonly<{
  readonly transmittable: readonly ChangedFileObservation[];
  readonly refusals: readonly ReviewAssistanceRefusal[];
  readonly boundedOutFiles: number;
  readonly transmittedBytes: number;
}>;

/** The exact identities one assisted request is cached and attributed under. */
export type ReviewAssistanceIdentity = Readonly<{
  readonly code: string;
  readonly context: string;
  readonly question: string;
  readonly schema: string;
  readonly policy: string;
  readonly model: string;
  readonly request: string;
}>;

export type ReviewAssistanceRequest = Readonly<{
  readonly files: readonly ChangedFileObservation[];
  readonly affectedCallers: readonly string[];
  readonly deterministic: ReviewLevelRecord;
  readonly impact: string;
  readonly policyDigest: string;
  /** The diff or context the answers are attributed to, recorded in every lead's provenance. */
  readonly source: string;
}>;

export type ReviewAssistanceOutcome = Readonly<{
  readonly status: "disabled" | "refused" | "failed" | "answered";
  readonly reason: string;
  readonly recommendation: ReviewLevel | "unavailable";
  readonly leads: readonly AdvisoryReviewLead[];
  readonly refusals: readonly ReviewAssistanceRefusal[];
  readonly cached: boolean;
  readonly identity?: ReviewAssistanceIdentity;
  readonly resultIdentity?: string;
  /** Bounded provider usage; present only when this call actually reached the provider. */
  readonly usage?: UsageRecord;
}>;

export type JevEvaluator = (
  input: JevEvaluationInput,
  options: JevEvaluationOptions,
) => Promise<JevEvaluationResponse>;

/** An exact-identity response cache. Nothing is reused unless every identity matches. */
export type ReviewAssistanceCache = Readonly<{
  readonly read: (identity: ReviewAssistanceIdentity) => JevEvaluationResponse | undefined;
  readonly write: (identity: ReviewAssistanceIdentity, response: JevEvaluationResponse) => void;
}>;

/** A monotonic duration clock, injected so a recorded provider duration is never an ambient read. */
export type ReviewAssistanceClock = () => number;

export type ReviewAssistanceRuntime = Readonly<{
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly evaluate: JevEvaluator;
  readonly cache: ReviewAssistanceCache;
  readonly now: ReviewAssistanceClock;
  readonly recordDiagnostic: (
    event: string,
    details: Readonly<Record<string, DiagnosticValue>>,
  ) => Promise<void>;
}>;

/**
 * The two bounded jobs, batched into one evaluation: recommend a depth, and flag a small set of
 * focus areas tied to the applicable principles. Every answer is a lead, never a finding.
 */
const ASSISTANCE_QUESTIONS: JevQuestions = {
  depth: {
    type: "choice",
    instructions:
      "Given the changed code below, recommend how much independent review scrutiny it needs. Recommend unclear whenever the excerpt does not settle it.",
    criteria: {
      light: "The change is contained and touches no sensitive or shared surface.",
      standard: "The change needs the normal behavior, design, and coverage review.",
      deep: "The change is sensitive or broad and needs specialist scrutiny.",
      unclear: "The excerpt does not settle how much scrutiny the change needs.",
    },
  },
  "hidden-effects": {
    type: "noul",
    instructions:
      "The changed code introduces an effect that its signature does not make visible, such as filesystem, process, network, clock, or global mutation reached from a function that reads as pure.",
  },
  "weakened-tests": {
    type: "noul",
    instructions:
      "The change removes, skips, loosens, or narrows an assertion or test that previously covered the changed behavior.",
  },
  "auth-change": {
    type: "noul",
    instructions:
      "The change alters an authentication, authorization, ownership, approval, or credential path.",
  },
};

const FLAG_PRINCIPLES: Readonly<Record<string, string>> = {
  "hidden-effects":
    "Maximize Honesty: every meaningful dependency is visible in the signature and effects are separated from decisions",
  "weakened-tests":
    "Coverage and affected surface: changed behavior keeps evidence-backed coverage",
  "auth-change":
    "Permissions and security safety floor: an authorization path change is reviewed in full",
};

export function createReviewAssistanceCache(): ReviewAssistanceCache {
  const entries = new Map<string, JevEvaluationResponse>();
  return {
    read: (identity) => entries.get(identity.request),
    write: (identity, response) => {
      entries.set(identity.request, response);
    },
  };
}

/** Reads the transport settings from an environment-shaped record without touching the process. */
export function reviewAssistanceConfig(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<{ readonly apiKey?: string; readonly timeoutMs: number }> {
  const apiKey = source.TYPESAFE_API_KEY?.trim();
  const requested = Number(source.TANDEM_JEV_TIMEOUT_MS);
  const timeoutMs =
    Number.isSafeInteger(requested) && requested >= 100 && requested <= 10_000
      ? requested
      : DEFAULT_REVIEW_ASSISTANCE_TIMEOUT_MS;
  return { timeoutMs, ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }) };
}

/**
 * Refuses every file whose path or observed content looks secret-bearing, then bounds what is
 * left to the transmitted file, line, and byte limits. A file is only ever a candidate when its
 * content was actually observed.
 */
export function screenReviewContext(
  files: readonly ChangedFileObservation[],
): ScreenedReviewContext {
  const refusals: ReviewAssistanceRefusal[] = [];
  const candidates: ChangedFileObservation[] = [];
  for (const file of files) {
    if (SECRET_BEARING_PATHS.some((pattern) => pattern.test(file.path))) {
      refusals.push({ path: file.path, reason: "secret-bearing-path" });
      continue;
    }
    if (!file.contentObserved) continue;
    if (
      file.changedLines.some((line) =>
        SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(line)),
      )
    ) {
      refusals.push({ path: file.path, reason: "secret-pattern" });
      continue;
    }
    candidates.push(file);
  }

  const transmittable: ChangedFileObservation[] = [];
  let transmittedBytes = 0;
  for (const file of candidates) {
    if (transmittable.length >= REVIEW_ASSISTANCE_LIMITS.maxTransmittedFiles) break;
    const lines = file.changedLines.slice(0, REVIEW_ASSISTANCE_LIMITS.maxTransmittedLinesPerFile);
    const bytes = Buffer.byteLength(`${file.path}\n${lines.join("\n")}`, "utf8");
    if (transmittedBytes + bytes > REVIEW_ASSISTANCE_LIMITS.maxTransmittedBytes) break;
    transmittedBytes += bytes;
    transmittable.push({ path: file.path, changedLines: lines, contentObserved: true });
  }
  return {
    transmittable,
    refusals,
    boundedOutFiles: candidates.length - transmittable.length,
    transmittedBytes,
  };
}

/** Builds the one batched evaluation and the exact identities it is cached and attributed under. */
export function buildAssistanceRequest(
  request: ReviewAssistanceRequest,
  screened: ScreenedReviewContext,
): Readonly<{ readonly input: JevEvaluationInput; readonly identity: ReviewAssistanceIdentity }> {
  const code = screened.transmittable.map((file) => ({
    path: file.path,
    changedLines: file.changedLines,
  }));
  const context = {
    deterministicLevel: request.deterministic.level,
    safetyFloors: request.deterministic.floors,
    impact: request.impact,
    affectedCallers: request.affectedCallers.slice(0, REVIEW_ASSISTANCE_LIMITS.maxTransmittedFiles),
  };
  const input: JevEvaluationInput = {
    model: JEV_MODEL,
    state: { changedCode: code, reviewContext: context },
    questions: ASSISTANCE_QUESTIONS,
  };
  const identity = requestIdentity({ code, context, policyDigest: request.policyDigest });
  return { input, identity };
}

/**
 * Turns one evaluation into a depth recommendation and a bounded set of untrusted leads. A
 * malformed, low-confidence, or unrecognized answer yields no recommendation and no lead rather
 * than a guess.
 */
export function interpretReviewAssistance(
  input: Readonly<{
    readonly response: JevEvaluationResponse;
    readonly identity: ReviewAssistanceIdentity;
    readonly source: string;
  }>,
): Readonly<{
  readonly recommendation: ReviewLevel | "unavailable";
  readonly reason: string;
  readonly leads: readonly AdvisoryReviewLead[];
  readonly resultIdentity: string;
}> {
  const resultIdentity = digest(JSON.stringify(input.response) ?? "");
  const provenanceRequest = describeIdentity(input.identity);
  const depth = input.response.answers.depth;
  let recommendation: ReviewLevel | "unavailable" = "unavailable";
  let reason = "the helper returned no usable depth answer";
  if (depth !== undefined && depth.type === "choice") {
    const probability = depth.probabilities[depth.choice] ?? 0;
    const confidence = Math.min(depth.confidence, probability);
    if (confidence < REVIEW_ASSISTANCE_LIMITS.minDepthConfidence) {
      reason = `the helper's depth answer was below the provisional ${REVIEW_ASSISTANCE_LIMITS.minDepthConfidence} confidence bound`;
    } else if (isReviewLevel(depth.choice)) {
      recommendation = depth.choice;
      reason = `the helper recommended ${depth.choice} at confidence ${confidence.toFixed(3)}`;
    } else {
      reason = "the helper could not settle a depth from the transmitted excerpt";
    }
  }

  const leads: AdvisoryReviewLead[] = [];
  for (const [id, principle] of Object.entries(FLAG_PRINCIPLES)) {
    if (leads.length >= REVIEW_ASSISTANCE_LIMITS.maxAdvisoryLeads) break;
    const answer = input.response.answers[id];
    if (answer === undefined || answer.type !== "noul") continue;
    if (answer.noul < REVIEW_ASSISTANCE_LIMITS.minFlagBelief) continue;
    const question = ASSISTANCE_QUESTIONS[id];
    leads.push({
      id: `jev-${id}`,
      summary: `${question === undefined ? id : question.instructions} (helper belief ${answer.noul.toFixed(3)}); confirm or discard it against the source at this HEAD`,
      principle,
      provenance: {
        source: input.source,
        question: `${id}: ${question === undefined ? "unknown question" : question.instructions}`,
        requestIdentity: provenanceRequest,
        resultIdentity: `result=${resultIdentity.slice(0, 16)}`,
      },
    });
  }
  return { recommendation, reason, leads, resultIdentity };
}

/**
 * Asks the helper for a depth recommendation and focus flags. Returns without calling the
 * evaluator at all unless the repository enabled assistance, opted into source transmission, and
 * configured a key, so with the default policy zero source bytes leave the process. Every failure
 * mode returns leads-free, recommendation-free, and never changes the deterministic level.
 */
export async function requestReviewAssistance(
  runtime: ReviewAssistanceRuntime,
  policy: ReviewLevelPolicy,
  request: ReviewAssistanceRequest,
): Promise<ReviewAssistanceOutcome> {
  if (policy.jevAssistance === "off") {
    return disabled("review-level assistance is off in the pinned repository policy");
  }
  if (!policy.sourceTransmission) {
    return disabled(
      "source transmission to an external provider is not opted into in the pinned repository policy",
    );
  }
  const apiKey = runtime.apiKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return disabled("no Jev credential is configured");
  }

  const screened = screenReviewContext(request.files);
  if (screened.transmittable.length === 0) {
    await runtime.recordDiagnostic("review-level-assistance-refused", {
      reason: "no-transmittable-context",
      refusedFiles: screened.refusals.length,
      boundedOutFiles: screened.boundedOutFiles,
    });
    return {
      status: "refused",
      reason: "no changed file was both observable and safe to transmit",
      recommendation: "unavailable",
      leads: [],
      refusals: screened.refusals,
      cached: false,
    };
  }

  const { input, identity } = buildAssistanceRequest(request, screened);
  const cachedResponse = runtime.cache.read(identity);
  if (cachedResponse !== undefined) {
    const interpreted = interpretReviewAssistance({
      response: cachedResponse,
      identity,
      source: request.source,
    });
    return {
      status: "answered",
      reason: `${interpreted.reason} (reused an exact-identity cached result)`,
      recommendation: interpreted.recommendation,
      leads: interpreted.leads,
      refusals: screened.refusals,
      cached: true,
      identity,
      resultIdentity: interpreted.resultIdentity,
    };
  }

  const startedAt = runtime.now();
  let response: JevEvaluationResponse;
  try {
    response = await runtime.evaluate(input, {
      apiKey,
      timeoutMs: runtime.timeoutMs,
    });
  } catch (error) {
    const code = error instanceof JevEvaluationError ? error.code : "unavailable";
    const reason = error instanceof JevEvaluationError ? `jev-${error.code}` : "jev-error";
    await runtime.recordDiagnostic("review-level-assistance-failed", {
      reason,
      requestIdentity: identity.request.slice(0, 16),
      transmittedFiles: screened.transmittable.length,
      transmittedBytes: screened.transmittedBytes,
      refusedFiles: screened.refusals.length,
    });
    return {
      status: "failed",
      reason: `the helper was unavailable (${reason}); the deterministic level stands`,
      recommendation: "unavailable",
      leads: [],
      refusals: screened.refusals,
      cached: false,
      identity,
      usage: jevUsageRecord({
        outcome: { kind: "failed", code },
        durationMs: elapsedMs(startedAt, runtime.now()),
        reason,
      }),
    };
  }

  const durationMs = elapsedMs(startedAt, runtime.now());
  runtime.cache.write(identity, response);
  const interpreted = interpretReviewAssistance({ response, identity, source: request.source });
  await runtime.recordDiagnostic("review-level-assistance-answered", {
    recommendation: interpreted.recommendation,
    leads: interpreted.leads.length,
    requestIdentity: identity.request.slice(0, 16),
    transmittedFiles: screened.transmittable.length,
    transmittedBytes: screened.transmittedBytes,
    refusedFiles: screened.refusals.length,
  });
  return {
    status: "answered",
    reason: interpreted.reason,
    recommendation: interpreted.recommendation,
    leads: interpreted.leads,
    refusals: screened.refusals,
    cached: false,
    identity,
    resultIdentity: interpreted.resultIdentity,
    usage: jevUsageRecord({
      outcome: { kind: "answered", usage: response.usage },
      durationMs,
      reason: "review-level-assistance-answered",
    }),
  };
}

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/** The default runtime: the one existing Jev transport, a fresh cache, and no diagnostics sink. */
export function reviewAssistanceRuntime(
  input: Readonly<{
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly evaluate?: JevEvaluator;
    readonly cache?: ReviewAssistanceCache;
    readonly now?: ReviewAssistanceClock;
    readonly recordDiagnostic?: ReviewAssistanceRuntime["recordDiagnostic"];
  }>,
): ReviewAssistanceRuntime {
  return {
    timeoutMs: input.timeoutMs,
    evaluate: input.evaluate ?? evaluateJev,
    cache: input.cache ?? createReviewAssistanceCache(),
    now: input.now ?? (() => performance.now()),
    recordDiagnostic: input.recordDiagnostic ?? (async () => undefined),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
  };
}

function disabled(reason: string): ReviewAssistanceOutcome {
  return {
    status: "disabled",
    reason,
    recommendation: "unavailable",
    leads: [],
    refusals: [],
    cached: false,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isReviewLevel(value: string): value is ReviewLevel {
  return value === "light" || value === "standard" || value === "deep";
}

function requestIdentity(
  input: Readonly<{
    readonly code: unknown;
    readonly context: unknown;
    readonly policyDigest: string;
  }>,
): ReviewAssistanceIdentity {
  const code = digest(JSON.stringify(input.code) ?? "");
  const context = digest(JSON.stringify(input.context) ?? "");
  const question = digest(
    JSON.stringify(
      Object.entries(ASSISTANCE_QUESTIONS).map(([id, value]) => [id, value.instructions]),
    ) ?? "",
  );
  const schema = digest(
    JSON.stringify(
      Object.entries(ASSISTANCE_QUESTIONS).map(([id, value]) => [
        id,
        value.type,
        value.type === "choice" ? Object.keys(value.criteria) : [],
      ]),
    ) ?? "",
  );
  const request = digest(
    [code, context, question, schema, input.policyDigest, JEV_MODEL].join(":"),
  );
  return {
    code,
    context,
    question,
    schema,
    policy: input.policyDigest,
    model: JEV_MODEL,
    request,
  };
}

function describeIdentity(identity: ReviewAssistanceIdentity): string {
  return [
    `code=${identity.code.slice(0, 16)}`,
    `context=${identity.context.slice(0, 16)}`,
    `question=${identity.question.slice(0, 16)}`,
    `schema=${identity.schema.slice(0, 16)}`,
    `policy=${identity.policy.slice(0, 16)}`,
    `model=${identity.model}`,
    `request=${identity.request.slice(0, 16)}`,
  ].join(" ");
}
