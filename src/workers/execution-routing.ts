/**
 * Economical routing at one execution boundary, and the one contract that says which exact model
 * an attempt is authorized to invoke.
 *
 * Routing is resolved before a job is launched and before a bounded replacement attempt, never per
 * provider turn: nothing here switches a model mid-turn, learns from outcomes, promises a saving,
 * enables a provider, or works around a spending decision. It decides and returns records; it
 * reads no catalogue, writes no state, and asks no question itself.
 *
 * The one automatic move is a same-or-lower-tier reassignment after a known safe failure, taken
 * only on evidence the catalogue actually published for both models and only among providers the
 * pinned profile explicitly enabled. A higher-cost or higher-quota-consumption model is a question
 * for the user, including when it is prepaid, bundled, or expected to bill nothing extra, and so
 * is any move whose tier evidence is missing, ambiguous, or contradictory.
 *
 * Tiers are placed against each other on published catalogue figures alone. The ledger's charged
 * total is never read as a measurement of anything: it is a floor on what a request cost, and the
 * unaccounted and unmeasured sample counts beside it are what a move has to be proven against.
 */

import { createHash } from "node:crypto";
import type { OmpModelRecord } from "../adapters/omp.ts";
import {
  catalogueCostTotal,
  compareModelTier,
  lookupModelTierEvidence,
  type ModelCatalogueGap,
  type ModelTierAxisRelation,
  type ModelTierComparison,
  type ModelTierEvidence,
  type ModelTierEvidenceGap,
  type ModelTierEvidenceLookup,
  modelTierEvidence,
} from "../config/model-tier.ts";
import type { IsoTimestamp, ModelSpec } from "../contracts.ts";
import type {
  DurableExecutionRouting,
  DurableExecutionRoutingPause,
  ExecutionRoutingEvidence,
  ExecutionRoutingLimits,
  ExecutionRoutingPauseReason,
} from "../runtime/schema.ts";
import { formatDecisionQuestion } from "../tasks/question.ts";
import type { WorkerRole } from "./jobs.ts";

/** Why no catalogue evidence is on hand. None of these ever reads as "nothing is included". */
export type ModelCatalogueUnavailableReason =
  | "not-consulted"
  | "catalogue-unreadable"
  | "catalogue-empty";

/**
 * The OMP catalogue and the explicitly enabled providers as one boundary observed them. A snapshot
 * is evidence with a time on it, so a later boundary reads its own rather than reusing this one.
 */
export type ModelCatalogueSnapshot =
  | Readonly<{
      readonly status: "read";
      readonly models: readonly OmpModelRecord[];
      /** Providers explicitly approved for spending; catalogue discovery alone never adds one. */
      readonly enabledProviders: readonly string[];
      readonly readAt: IsoTimestamp;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: ModelCatalogueUnavailableReason;
    }>;

/** Reads the catalogue for one repository checkout at an execution boundary. */
export type ModelCatalogueReader = (cwd: string) => Promise<ModelCatalogueSnapshot>;

/** The identities one routing choice is resolved under and recorded against. */
export type ExecutionAttemptIdentity = Readonly<{
  readonly requestId?: string;
  readonly taskId: string;
  readonly jobId: string;
  readonly operationId: string;
  readonly role: WorkerRole;
  readonly generation: number;
  readonly attempt: number;
  readonly policyDigest: string;
  readonly inputHead: string;
}>;

/**
 * How the previous attempt for this role ended, as far as the durable record proves. `uncertain`
 * is a quarantined outcome: it keeps its capacity and resources and is never replaced automatically.
 */
export type PriorExecutionAttempt = Readonly<{
  readonly operationId: string;
  readonly selector: string;
  readonly outcome: "known-safe-failure" | "uncertain";
}>;

/** The two boundaries routing is resolved at. There is no third, and no per-turn boundary. */
export type ExecutionRoutingBoundary =
  | Readonly<{ readonly kind: "job-launch" }>
  | Readonly<{
      readonly kind: "replacement-attempt";
      readonly prior: PriorExecutionAttempt;
    }>;

/**
 * How much of a request's own spending nobody could observe. `unaccountedSamples` is unpriced work
 * no reservation stands for and `unmeasuredTokenSamples` is work that reported no tokens at all;
 * either one means the request's usage and allowance draw are unknown rather than small, so no
 * tier move can be proven against them.
 */
export type RequestUsageExposure = Readonly<{
  readonly unaccountedSamples: number;
  readonly unmeasuredTokenSamples: number;
}>;

/**
 * What the request's spending checkpoint already decided about this operation, and what it observed
 * deciding it. Routing consumes this decision; it never re-derives, relaxes, or resolves one.
 */
export type ExecutionSpendAdmission =
  | Readonly<{
      readonly status: "admitted" | "paused";
      readonly exposure: RequestUsageExposure;
    }>
  | Readonly<{ readonly status: "no-governing-request" }>;

export type ExecutionRoutingRequest = Readonly<{
  readonly boundary: ExecutionRoutingBoundary;
  readonly identity: ExecutionAttemptIdentity;
  /** The pinned role assignment. Routing reads it and never writes back to pinned policy. */
  readonly pinned: ModelSpec;
  readonly catalogue: ModelCatalogueSnapshot;
  readonly limits: ExecutionRoutingLimits;
  readonly admission: ExecutionSpendAdmission;
  readonly now: IsoTimestamp;
}>;

export type ExecutionRoutingDecision =
  | Readonly<{ readonly outcome: "authorized"; readonly routing: DurableExecutionRouting }>
  | Readonly<{ readonly outcome: "paused"; readonly pause: DurableExecutionRoutingPause }>;

/** The operation identity a recorded transition has to still speak for. */
export type ExecutionRoutingFence = Readonly<{
  readonly operationId: string;
  readonly jobId: string;
  readonly generation: number;
  readonly inputHead: string;
  readonly policyDigest: string;
}>;

export type ExecutionModelAuthorizationRequest = Readonly<{
  /** The exact model the job about to run says it will invoke. */
  readonly claimed: ModelSpec | undefined;
  readonly pinned: ModelSpec;
  readonly routing: DurableExecutionRouting | undefined;
  readonly fence: ExecutionRoutingFence;
}>;

export type ExecutionModelAuthorization =
  | Readonly<{ readonly authorized: true; readonly model: ModelSpec }>
  | Readonly<{ readonly authorized: false; readonly reason: string }>;

/** The identity a recorded routing question has to still speak for to keep a task stopped. */
export type ExecutionRoutingIdentity = Readonly<{
  readonly role: WorkerRole;
  readonly generation: number;
  readonly policyDigest: string;
  readonly inputHead: string;
}>;

/**
 * The one routing decision, taken at a defined boundary against the evidence actually on hand.
 * The caller records the returned transition on the operation that admits the attempt, or the
 * returned question on the task, in its own durable write.
 */
export function resolveExecutionRouting(
  request: ExecutionRoutingRequest,
): ExecutionRoutingDecision {
  if (request.admission.status === "paused") {
    return routingQuestion(request, "spending-decision-pending", {});
  }
  const boundary = request.boundary;
  if (boundary.kind === "replacement-attempt" && boundary.prior.outcome === "uncertain") {
    return routingQuestion(request, "prior-outcome-uncertain", {});
  }
  const catalogue = publishedCatalogue(request.catalogue);
  if (catalogue === undefined) {
    return continueWithPinnedModel(request, unreadEvidence(request.admission));
  }
  const pinned = lookupModelTierEvidence(catalogue.models, request.pinned);
  if (boundary.kind === "job-launch") {
    return pinned.status === "known"
      ? continueWithPinnedModel(request, readEvidence(catalogue, request.admission))
      : routingQuestion(request, pinnedGapReason(pinned.gap), {
          evidenceGaps: [`incumbent-${pinned.gap}` as const],
          enabledProviders: catalogue.enabledProviders,
        });
  }
  return resolveReplacementAttempt(request, boundary.prior, catalogue, pinned);
}

/**
 * Whether one attempt may invoke the exact model it claims. The recorded transition decides when
 * there is one; otherwise only the pinned role assignment is authorized, so an audit record
 * describing a model change never lets a job and this gate disagree.
 */
export function authorizeExecutionModel(
  request: ExecutionModelAuthorizationRequest,
): ExecutionModelAuthorization {
  const claimed = request.claimed;
  if (claimed === undefined) {
    return { authorized: false, reason: "execution carries no resolved model" };
  }
  const routing = request.routing;
  if (routing === undefined) {
    return sameModel(claimed, request.pinned)
      ? { authorized: true, model: request.pinned }
      : {
          authorized: false,
          reason:
            "resolved model is not the pinned assignment and no execution transition authorizes it",
        };
  }
  if (!fenceMatches(routing, request.fence)) {
    return { authorized: false, reason: "execution routing evidence is stale" };
  }
  const authorized = resolvedExecutionModel(routing, request.pinned);
  if (routing.basis === "pinned-policy" && !sameModel(authorized, request.pinned)) {
    return {
      authorized: false,
      reason: "recorded pinned-policy routing does not match the pinned assignment",
    };
  }
  return sameModel(claimed, authorized)
    ? { authorized: true, model: authorized }
    : {
        authorized: false,
        reason: "resolved model does not match the recorded execution transition",
      };
}

/**
 * The exact model one attempt runs: the transition recorded on its operation when there is one,
 * and the pinned role assignment otherwise. Job construction and the execution gate both read the
 * attempt's model through this, so neither can arrive at a model the other did not.
 */
export function resolvedExecutionModel(
  routing: DurableExecutionRouting | undefined,
  pinned: ModelSpec,
): ModelSpec {
  return routing === undefined ? pinned : { model: routing.selector, thinking: routing.thinking };
}

/** The fence a durable operation imposes on any transition recorded against it. */
export function executionRoutingFence(
  operation: Readonly<{
    readonly id: string;
    readonly generation: number;
    readonly inputHead: string;
    readonly policyDigest: string;
  }>,
  jobId: string,
): ExecutionRoutingFence {
  return {
    operationId: operation.id,
    jobId,
    generation: operation.generation,
    inputHead: operation.inputHead,
    policyDigest: operation.policyDigest,
  };
}

/**
 * Whether a recorded question still speaks for the identity now asking to run. It stops speaking
 * when the pinned policy, the generation, or the input HEAD moves, because none of those is the
 * situation the question was raised about.
 */
export function executionRoutingPauseStands(
  pause: DurableExecutionRoutingPause | undefined,
  identity: ExecutionRoutingIdentity,
): boolean {
  if (pause === undefined) return false;
  return (
    pause.role === identity.role &&
    pause.generation === identity.generation &&
    pause.policyDigest === identity.policyDigest &&
    pause.inputHead === identity.inputHead
  );
}

/**
 * The whole routing question in one plain-English prompt: the move that was on the table, why it
 * is not automatic, and what answering it means. It never proposes a saving, never offers to
 * proceed on the user's behalf, and never names a task, decision, generation, or attempt id — a
 * caller that needs those for durable records or a tool call reads them off `pause` directly,
 * never out of this text. `taskObjective`, when the caller has it, names the task in its own
 * words instead of its id; omit it and the prompt falls back to a generic "this task".
 */
export function describeExecutionRoutingDecision(
  pause: DurableExecutionRoutingPause,
  taskObjective?: string,
): string {
  const subject = taskObjective === undefined ? "this task" : `"${taskObjective}"`;
  const candidate =
    pause.candidateSelector === undefined
      ? ""
      : ` The candidate is ${pause.candidateSelector}${pause.candidateProvider === undefined ? "" : ` from ${pause.candidateProvider}`}${pause.premiumAxis === undefined ? "" : `, which uses more ${PREMIUM_AXIS_NAMES[pause.premiumAxis]} than the current model`}.`;
  const gaps =
    pause.evidenceGaps.length === 0
      ? ""
      : ` Missing or unclear pricing: ${pause.evidenceGaps.map(describeEvidenceGap).join("; ")}.`;
  const usage = describeUnobservedUsage(pause);
  return formatDecisionQuestion({
    what: `Before running ${subject}, Tandem paused a model change: ${ROUTING_PAUSE_EXPLANATIONS[pause.reason]}.${candidate}${gaps}${usage === undefined ? "" : ` ${usage}`}`,
    recommendation: `Keep using ${pause.pinnedSelector} (thinking: ${pause.pinnedThinking}) unless you say otherwise.`,
  });
}

const EVIDENCE_GAP_EXPLANATIONS: Readonly<Record<ModelTierEvidenceGap, string>> = {
  "incumbent-absent-from-catalogue": "the current model isn't listed",
  "incumbent-ambiguous-in-catalogue": "the current model matches more than one listing",
  "incumbent-thinking-level-unsupported":
    "the current model doesn't support the configured thinking level",
  "candidate-absent-from-catalogue": "the candidate model isn't listed",
  "candidate-ambiguous-in-catalogue": "the candidate model matches more than one listing",
  "candidate-thinking-level-unsupported":
    "the candidate model doesn't support the configured thinking level",
  "catalogue-cost-unpublished": "no published price for one of the models",
  "included-allowance-unpublished": "no published included-usage allowance for one of the models",
  "included-allowance-plan-differs":
    "the two models are on different included-usage plans, so their allowances can't be compared",
  "included-allowance-unit-differs":
    "the two models measure included usage in different units, so their allowances can't be compared",
};

/** Plain English for one reason two models cannot be placed on the same tier scale. */
function describeEvidenceGap(gap: ModelTierEvidenceGap): string {
  return EVIDENCE_GAP_EXPLANATIONS[gap];
}

/**
 * What this request has spent that nobody reported. It is stated as unmeasured work rather than as
 * an amount, because the charged total beside it is a floor on the cost and not a measurement.
 */
function describeUnobservedUsage(pause: DurableExecutionRoutingPause): string | undefined {
  if (pause.usageSource === "no-governing-request") {
    return "No request governs this task, so there is no accounting ledger to prove what a different model would draw.";
  }
  const unaccounted = pause.unaccountedSamples ?? 0;
  const unmeasured = pause.unmeasuredTokenSamples ?? 0;
  if (unaccounted === 0 && unmeasured === 0) return undefined;
  return `${unaccounted} recorded sample(s) under this request carry no published price and no reserved estimate, and ${unmeasured} reported no tokens, so what this request has actually drawn is unknown rather than small. Nothing about a different model's cost or allowance can be proven against that.`;
}

const DECISION_ID_PREFIX = "routing-";

const PREMIUM_AXIS_NAMES = {
  "monetary-cost": "money",
  "quota-consumption": "included allowance",
} as const;

const ROUTING_PAUSE_EXPLANATIONS: Readonly<Record<ExecutionRoutingPauseReason, string>> = {
  "spending-decision-pending":
    "this request already stopped on a separate spending decision, which comes first",
  "prior-outcome-uncertain":
    "Tandem can't yet prove what the last attempt actually did, so it is held as-is instead of being retried or replaced",
  "pinned-model-absent-from-catalogue":
    "the model you pinned isn't listed right now, so nothing confirms it can still run",
  "pinned-model-ambiguous-in-catalogue":
    "the model you pinned matches more than one listing, so which model would actually run is unknown",
  "pinned-model-thinking-level-unsupported":
    "the model you pinned no longer supports the thinking level configured for this step",
  "premium-tier-requires-approval":
    "the only replacement available costs more or uses more of your included usage, even when it is prepaid, bundled, or expected to bill nothing extra",
  "tier-evidence-indeterminate":
    "Tandem can't get clear pricing for the available replacements, so none of them can be treated as an equal swap",
  "usage-evidence-unmeasured":
    "Tandem can't fully see what this request has already spent, so it can't prove a replacement would cost no more than the model you pinned",
};

type ClassifiedCandidate = Readonly<{
  readonly evidence: ModelTierEvidence;
  readonly comparison: ModelTierComparison;
}>;

type RoutingQuestionDetail = Readonly<{
  readonly candidate?: ModelTierEvidence;
  readonly premiumAxis?: DurableExecutionRoutingPause["premiumAxis"];
  readonly evidenceGaps?: readonly ModelTierEvidenceGap[];
  readonly enabledProviders?: readonly string[];
}>;

function sameModel(left: ModelSpec, right: ModelSpec): boolean {
  return left.model === right.model && left.thinking === right.thinking;
}

function fenceMatches(routing: DurableExecutionRouting, fence: ExecutionRoutingFence): boolean {
  return (
    routing.operationId === fence.operationId &&
    routing.jobId === fence.jobId &&
    routing.generation === fence.generation &&
    routing.inputHead === fence.inputHead &&
    routing.policyDigest === fence.policyDigest
  );
}

function pinnedGapReason(gap: ModelCatalogueGap): ExecutionRoutingPauseReason {
  if (gap === "absent-from-catalogue") return "pinned-model-absent-from-catalogue";
  if (gap === "ambiguous-in-catalogue") return "pinned-model-ambiguous-in-catalogue";
  return "pinned-model-thinking-level-unsupported";
}

/**
 * The snapshot's models when it actually published some. A listing with no entries is a boundary
 * that reported nothing, not a catalogue asserting that the pinned model does not exist, so it
 * supplies no evidence either way rather than contradicting the pin.
 */
function publishedCatalogue(
  snapshot: ModelCatalogueSnapshot,
): Extract<ModelCatalogueSnapshot, { readonly status: "read" }> | undefined {
  if (snapshot.status === "unavailable" || snapshot.models.length === 0) return undefined;
  return snapshot;
}

/**
 * Whether the request's own spending is fully observed. A governing request with any unaccounted or
 * unmeasured sample has usage nobody reported, and a task with no governing request has no ledger
 * to report one at all; neither is a basis for calling a move comparable.
 */
function usageIsFullyObserved(admission: ExecutionSpendAdmission): boolean {
  if (admission.status !== "admitted") return false;
  return (
    admission.exposure.unaccountedSamples === 0 && admission.exposure.unmeasuredTokenSamples === 0
  );
}

/** How much of the request's spending the boundary could actually see, recorded as it stood. */
function observedUsage(
  admission: ExecutionSpendAdmission,
): Pick<ExecutionRoutingEvidence, "usageSource" | "unaccountedSamples" | "unmeasuredTokenSamples"> {
  if (admission.status === "no-governing-request") {
    return { usageSource: "no-governing-request" };
  }
  return {
    usageSource: "request-ledger",
    unaccountedSamples: admission.exposure.unaccountedSamples,
    unmeasuredTokenSamples: admission.exposure.unmeasuredTokenSamples,
  };
}

function unreadEvidence(admission: ExecutionSpendAdmission): ExecutionRoutingEvidence {
  return { source: "catalogue-unavailable", enabledProviders: [], ...observedUsage(admission) };
}

/** The relations a comparison established; an indeterminate one established neither. */
function axisRelations(
  comparison: ModelTierComparison | undefined,
): Readonly<{ cost?: ModelTierAxisRelation; quota?: ModelTierAxisRelation }> {
  if (comparison === undefined || comparison.status === "indeterminate") return {};
  return {
    ...(comparison.cost === undefined ? {} : { cost: comparison.cost }),
    ...(comparison.quota === undefined ? {} : { quota: comparison.quota }),
  };
}

function readEvidence(
  catalogue: Extract<ModelCatalogueSnapshot, { readonly status: "read" }>,
  admission: ExecutionSpendAdmission,
  chosen?: ClassifiedCandidate,
): ExecutionRoutingEvidence {
  const relations = axisRelations(chosen?.comparison);
  const plan = chosen?.evidence.includedAllowance?.plan;
  return {
    source: "catalogue-read",
    catalogueReadAt: catalogue.readAt,
    enabledProviders: catalogue.enabledProviders,
    ...(relations.cost === undefined ? {} : { costRelation: relations.cost }),
    ...(relations.quota === undefined ? {} : { quotaRelation: relations.quota }),
    ...(plan === undefined ? {} : { includedAllowancePlan: plan }),
    ...observedUsage(admission),
  };
}

/**
 * The candidates a reassignment may even consider: models from a provider the pinned profile
 * explicitly enabled, supporting the thinking level this role is pinned to, and neither the model
 * that just failed nor the pinned model itself.
 */
function eligibleCandidates(
  catalogue: Extract<ModelCatalogueSnapshot, { readonly status: "read" }>,
  pinned: ModelSpec,
  failedSelector: string,
): readonly ModelTierEvidence[] {
  const enabled = new Set(catalogue.enabledProviders);
  return catalogue.models
    .filter(
      (entry) =>
        enabled.has(entry.provider) &&
        entry.thinking.includes(pinned.thinking) &&
        entry.selector !== failedSelector &&
        entry.selector !== pinned.model,
    )
    .map((entry) => modelTierEvidence(entry, pinned.thinking));
}

/** A known included allowance first, then the lower published cost, then the selector. */
function compareCandidatePreference(a: ModelTierEvidence, b: ModelTierEvidence): number {
  const allowanceDelta =
    (a.includedAllowance === undefined ? 1 : 0) - (b.includedAllowance === undefined ? 1 : 0);
  if (allowanceDelta !== 0) return allowanceDelta;
  const unitsDelta =
    (a.includedAllowance?.unitsPerRequest ?? 0) - (b.includedAllowance?.unitsPerRequest ?? 0);
  if (unitsDelta !== 0) return unitsDelta;
  const costDelta =
    (catalogueCostTotal(a) ?? Number.POSITIVE_INFINITY) -
    (catalogueCostTotal(b) ?? Number.POSITIVE_INFINITY);
  if (costDelta !== 0) return costDelta;
  return a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0;
}

function cheapestPremiumCandidate(
  classified: readonly ClassifiedCandidate[],
): ClassifiedCandidate | undefined {
  const premium = classified.filter((entry) => entry.comparison.status === "premium");
  return [...premium].sort((a, b) => compareCandidatePreference(a.evidence, b.evidence))[0];
}

function indeterminateGaps(
  classified: readonly ClassifiedCandidate[],
): readonly ModelTierEvidenceGap[] {
  const gaps = new Set<ModelTierEvidenceGap>();
  for (const entry of classified) {
    if (entry.comparison.status !== "indeterminate") continue;
    for (const gap of entry.comparison.gaps) gaps.add(gap);
  }
  return [...gaps];
}

/**
 * The bounded replacement attempt. A comparable candidate may be taken automatically only when the
 * model that just failed is the pinned one, because returning to the pinned assignment after a
 * reassignment failed is not a routing move that needs evidence.
 */
function resolveReplacementAttempt(
  request: ExecutionRoutingRequest,
  prior: PriorExecutionAttempt,
  catalogue: Extract<ModelCatalogueSnapshot, { readonly status: "read" }>,
  pinned: ModelTierEvidenceLookup,
): ExecutionRoutingDecision {
  if (pinned.status === "unknown") {
    return routingQuestion(request, "tier-evidence-indeterminate", {
      evidenceGaps: [`incumbent-${pinned.gap}` as const],
      enabledProviders: catalogue.enabledProviders,
    });
  }
  if (prior.selector !== request.pinned.model) {
    return continueWithPinnedModel(request, readEvidence(catalogue, request.admission));
  }
  const candidates = eligibleCandidates(catalogue, request.pinned, prior.selector);
  const preferred = [...candidates].sort(compareCandidatePreference)[0];
  if (preferred !== undefined && !usageIsFullyObserved(request.admission)) {
    return routingQuestion(request, "usage-evidence-unmeasured", {
      candidate: preferred,
      enabledProviders: catalogue.enabledProviders,
    });
  }
  const classified = candidates.map(
    (evidence): ClassifiedCandidate => ({
      evidence,
      comparison: compareModelTier(pinned.evidence, evidence),
    }),
  );
  const comparable = classified.filter((entry) => entry.comparison.status === "comparable");
  const chosen = [...comparable].sort((a, b) =>
    compareCandidatePreference(a.evidence, b.evidence),
  )[0];
  if (chosen !== undefined) return reassignToComparableModel(request, catalogue, prior, chosen);
  const premium = cheapestPremiumCandidate(classified);
  if (premium !== undefined) {
    return routingQuestion(request, "premium-tier-requires-approval", {
      candidate: premium.evidence,
      ...(premium.comparison.status === "premium" ? { premiumAxis: premium.comparison.axis } : {}),
      enabledProviders: catalogue.enabledProviders,
    });
  }
  const gaps = indeterminateGaps(classified);
  if (gaps.length > 0) {
    return routingQuestion(request, "tier-evidence-indeterminate", {
      evidenceGaps: gaps,
      enabledProviders: catalogue.enabledProviders,
    });
  }
  return continueWithPinnedModel(request, readEvidence(catalogue, request.admission));
}

function continueWithPinnedModel(
  request: ExecutionRoutingRequest,
  evidence: ExecutionRoutingEvidence,
): ExecutionRoutingDecision {
  const identity = request.identity;
  return {
    outcome: "authorized",
    routing: {
      schemaVersion: 1,
      decisionId: routingDecisionId(request, "pinned-policy", request.pinned.model),
      basis: "pinned-policy",
      ...(identity.requestId === undefined ? {} : { requestId: identity.requestId }),
      taskId: identity.taskId,
      jobId: identity.jobId,
      operationId: identity.operationId,
      role: identity.role,
      generation: identity.generation,
      attempt: identity.attempt,
      policyDigest: identity.policyDigest,
      inputHead: identity.inputHead,
      provider: providerOf(request.pinned.model),
      selector: request.pinned.model,
      thinking: request.pinned.thinking,
      evidence,
      limits: request.limits,
      resolvedAt: request.now,
    },
  };
}

function reassignToComparableModel(
  request: ExecutionRoutingRequest,
  catalogue: Extract<ModelCatalogueSnapshot, { readonly status: "read" }>,
  prior: PriorExecutionAttempt,
  chosen: ClassifiedCandidate,
): ExecutionRoutingDecision {
  const identity = request.identity;
  return {
    outcome: "authorized",
    routing: {
      schemaVersion: 1,
      decisionId: routingDecisionId(request, "comparable-reassignment", chosen.evidence.selector),
      basis: "comparable-reassignment",
      ...(identity.requestId === undefined ? {} : { requestId: identity.requestId }),
      taskId: identity.taskId,
      jobId: identity.jobId,
      operationId: identity.operationId,
      role: identity.role,
      generation: identity.generation,
      attempt: identity.attempt,
      policyDigest: identity.policyDigest,
      inputHead: identity.inputHead,
      provider: chosen.evidence.provider,
      selector: chosen.evidence.selector,
      thinking: chosen.evidence.thinking,
      replaces: { selector: prior.selector, thinking: request.pinned.thinking },
      evidence: readEvidence(catalogue, request.admission, chosen),
      limits: request.limits,
      resolvedAt: request.now,
    },
  };
}

function routingQuestion(
  request: ExecutionRoutingRequest,
  reason: ExecutionRoutingPauseReason,
  detail: RoutingQuestionDetail,
): ExecutionRoutingDecision {
  const identity = request.identity;
  const candidate = detail.candidate;
  return {
    outcome: "paused",
    pause: {
      schemaVersion: 1,
      decisionId: routingDecisionId(request, reason, candidate?.selector ?? request.pinned.model),
      reason,
      taskId: identity.taskId,
      jobId: identity.jobId,
      operationId: identity.operationId,
      role: identity.role,
      generation: identity.generation,
      attempt: identity.attempt,
      policyDigest: identity.policyDigest,
      inputHead: identity.inputHead,
      pinnedSelector: request.pinned.model,
      pinnedThinking: request.pinned.thinking,
      ...(candidate === undefined
        ? {}
        : { candidateSelector: candidate.selector, candidateProvider: candidate.provider }),
      ...(detail.premiumAxis === undefined ? {} : { premiumAxis: detail.premiumAxis }),
      evidenceGaps: detail.evidenceGaps ?? [],
      enabledProviders: detail.enabledProviders ?? [],
      ...observedUsage(request.admission),
      limits: request.limits,
      observedAt: request.now,
    },
  };
}

/**
 * The decision's identity, derived from what makes it this decision rather than a random value, so
 * re-resolving it after a restart reproduces the same question instead of raising another.
 */
function routingDecisionId(
  request: ExecutionRoutingRequest,
  discriminator: string,
  selector: string,
): string {
  const canonical = JSON.stringify([
    request.identity.taskId,
    request.identity.operationId,
    request.identity.role,
    request.identity.generation,
    request.identity.attempt,
    request.identity.policyDigest,
    request.identity.inputHead,
    discriminator,
    selector,
  ]);
  return `${DECISION_ID_PREFIX}${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/** The provider half of an exact `provider/model` selector. */
function providerOf(selector: string): string {
  const [provider] = selector.split("/");
  if (provider === undefined || provider.length === 0) {
    throw new TypeError(`model selector ${JSON.stringify(selector)} names no provider`);
  }
  return provider;
}
