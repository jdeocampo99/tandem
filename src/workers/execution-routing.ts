/**
 * Economical routing at one execution boundary, and the one contract that says which exact model
 * an attempt is authorized to invoke.
 *
 * Routing is resolved before a job is launched and before a bounded replacement attempt, never per
 * provider turn: nothing here switches a model mid-turn, learns from outcomes, promises a saving,
 * or enables a provider. It decides and returns records; it reads no catalogue, writes no state,
 * and asks no question itself.
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
import {
  type DurableExecutionRouting,
  type DurableExecutionRoutingPause,
  EXECUTION_ROUTING_PAUSE_REASONS,
  type ExecutionRoutingEvidence,
  type ExecutionRoutingPauseReason,
} from "../runtime/schema.ts";
import type { RequestUsageExposure } from "../runtime/usage-receipt.ts";
import { formatDecisionQuestion, taskName } from "../tasks/question.ts";
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

export type { RequestUsageExposure };

/**
 * What the request's own accounting ledger shows for this operation's request, read without
 * deciding anything. Routing consumes this observation; it never re-derives or resolves one.
 */
export type ExecutionUsageObservation =
  | Readonly<{ readonly status: "observed"; readonly exposure: RequestUsageExposure }>
  | Readonly<{ readonly status: "no-governing-request" }>;

export type ExecutionRoutingRequest = Readonly<{
  readonly boundary: ExecutionRoutingBoundary;
  readonly identity: ExecutionAttemptIdentity;
  /** The pinned role assignment. Routing reads it and never writes back to pinned policy. */
  readonly pinned: ModelSpec;
  readonly catalogue: ModelCatalogueSnapshot;
  readonly usage: ExecutionUsageObservation;
  readonly now: IsoTimestamp;
}>;

export type ExecutionRoutingDecision =
  | Readonly<{ readonly outcome: "authorized"; readonly routing: DurableExecutionRouting }>
  | Readonly<{ readonly outcome: "paused"; readonly pause: RaisedExecutionRoutingPause }>;

/** A pause routing raises now, as opposed to a saved one with a reason it no longer raises. */
export type RaisedExecutionRoutingPause = DurableExecutionRoutingPause &
  Readonly<{ readonly reason: ExecutionRoutingPauseReason }>;

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
  const boundary = request.boundary;
  if (boundary.kind === "replacement-attempt" && boundary.prior.outcome === "uncertain") {
    return routingQuestion(request, "prior-outcome-uncertain", {});
  }
  const catalogue = publishedCatalogue(request.catalogue);
  if (catalogue === undefined) {
    return continueWithPinnedModel(request, unreadEvidence(request.usage));
  }
  const pinned = lookupModelTierEvidence(catalogue.models, request.pinned);
  if (boundary.kind === "job-launch") {
    return pinned.status === "known"
      ? continueWithPinnedModel(request, readEvidence(catalogue, request.usage))
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
 * situation the question was raised about. A saved reason routing no longer raises never speaks.
 */
export function executionRoutingPauseStands(
  pause: DurableExecutionRoutingPause | undefined,
  identity: ExecutionRoutingIdentity,
): pause is RaisedExecutionRoutingPause {
  if (pause === undefined || !isRaisedReason(pause.reason)) return false;
  return (
    pause.role === identity.role &&
    pause.generation === identity.generation &&
    pause.policyDigest === identity.policyDigest &&
    pause.inputHead === identity.inputHead
  );
}

/**
 * The routing question as one short question: keep the pinned model, and why Tandem stopped.
 * It never proposes a saving or names a task, decision, generation, or attempt id; a caller that
 * needs those reads them off `pause` directly. `taskObjective`, when given, names the task.
 */
export function describeExecutionRoutingDecision(
  pause: RaisedExecutionRoutingPause,
  taskObjective?: string,
): string {
  const subject = taskObjective === undefined ? "this task" : taskName(taskObjective);
  return formatDecisionQuestion({
    ask: `Keep ${subject} on ${pause.pinnedSelector}?`,
    note: routingPauseExplanation(pause),
  });
}

/** Why routing stopped, as one plain sentence with no ids. */
export function routingPauseExplanation(pause: RaisedExecutionRoutingPause): string {
  return ROUTING_PAUSE_EXPLANATIONS[pause.reason];
}

/** Whether a saved pause is one routing still raises, not a retired reason that never stands. */
export function raisedRoutingPause(
  pause: DurableExecutionRoutingPause,
): pause is RaisedExecutionRoutingPause {
  return isRaisedReason(pause.reason);
}

function isRaisedReason(reason: string): reason is ExecutionRoutingPauseReason {
  return (EXECUTION_ROUTING_PAUSE_REASONS as readonly string[]).includes(reason);
}

const DECISION_ID_PREFIX = "routing-";

const ROUTING_PAUSE_EXPLANATIONS: Readonly<Record<ExecutionRoutingPauseReason, string>> = {
  "prior-outcome-uncertain": "I can't tell what the last attempt did.",
  "pinned-model-absent-from-catalogue": "That model isn't listed right now.",
  "pinned-model-ambiguous-in-catalogue": "That model name matches more than one model.",
  "pinned-model-thinking-level-unsupported": "It no longer supports this thinking level.",
};

type ClassifiedCandidate = Readonly<{
  readonly evidence: ModelTierEvidence;
  readonly comparison: ModelTierComparison;
}>;

type RoutingQuestionDetail = Readonly<{
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
 * Whether the request's own usage is fully observed. A governing request with any unaccounted or
 * unmeasured sample has usage nobody reported, and a task with no governing request has no ledger
 * to report one at all; neither is a basis for calling a move comparable.
 */
function usageIsFullyObserved(usage: ExecutionUsageObservation): boolean {
  if (usage.status !== "observed") return false;
  return usage.exposure.unaccountedSamples === 0 && usage.exposure.unmeasuredTokenSamples === 0;
}

/** How much of the request's usage the boundary could actually see, recorded as it stood. */
function observedUsage(
  usage: ExecutionUsageObservation,
): Pick<ExecutionRoutingEvidence, "usageSource" | "unaccountedSamples" | "unmeasuredTokenSamples"> {
  if (usage.status === "no-governing-request") {
    return { usageSource: "no-governing-request" };
  }
  return {
    usageSource: "request-ledger",
    unaccountedSamples: usage.exposure.unaccountedSamples,
    unmeasuredTokenSamples: usage.exposure.unmeasuredTokenSamples,
  };
}

function unreadEvidence(usage: ExecutionUsageObservation): ExecutionRoutingEvidence {
  return { source: "catalogue-unavailable", enabledProviders: [], ...observedUsage(usage) };
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
  usage: ExecutionUsageObservation,
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
    ...observedUsage(usage),
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

/**
 * The bounded replacement attempt. Only a comparable move is taken automatically, and only when the
 * model that just failed is the pinned one. Anything that cannot justify a switch (unobserved usage,
 * an unlisted pinned model, a costlier or unclear alternative) keeps the pinned model: a running
 * task's policy is fixed, so a question here could only ever be answered "keep it".
 */
function resolveReplacementAttempt(
  request: ExecutionRoutingRequest,
  prior: PriorExecutionAttempt,
  catalogue: Extract<ModelCatalogueSnapshot, { readonly status: "read" }>,
  pinned: ModelTierEvidenceLookup,
): ExecutionRoutingDecision {
  const keepPinned = continueWithPinnedModel(request, readEvidence(catalogue, request.usage));
  if (
    pinned.status === "unknown" ||
    prior.selector !== request.pinned.model ||
    !usageIsFullyObserved(request.usage)
  ) {
    return keepPinned;
  }
  const comparable = eligibleCandidates(catalogue, request.pinned, prior.selector)
    .map(
      (evidence): ClassifiedCandidate => ({
        evidence,
        comparison: compareModelTier(pinned.evidence, evidence),
      }),
    )
    .filter((entry) => entry.comparison.status === "comparable");
  const chosen = [...comparable].sort((a, b) =>
    compareCandidatePreference(a.evidence, b.evidence),
  )[0];
  return chosen === undefined
    ? keepPinned
    : reassignToComparableModel(request, catalogue, prior, chosen);
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
      evidence: readEvidence(catalogue, request.usage, chosen),
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
  return {
    outcome: "paused",
    pause: {
      schemaVersion: 1,
      decisionId: routingDecisionId(request, reason, request.pinned.model),
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
      evidenceGaps: detail.evidenceGaps ?? [],
      enabledProviders: detail.enabledProviders ?? [],
      ...observedUsage(request.usage),
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
