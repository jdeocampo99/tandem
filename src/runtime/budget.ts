/**
 * Standing request budgets: what one request may spend, what it has already committed and
 * reserved, and whether the next spend-bearing operation may start.
 *
 * Everything here is pure arithmetic over durable records and the accounting ledger's own totals.
 * It decides; it never locks, persists, launches, or notifies. The only two outcomes are running
 * the next operation exactly as planned or stopping the whole request for one explicit decision:
 * nothing here switches a model tier, drops a check, narrows review, or replans.
 *
 * Money is integer USD micro-dollars throughout. `"unset"` is an amount nobody configured and
 * `"unavailable"` is an amount nobody reported; neither is zero, and neither is unlimited.
 */

import { createHash } from "node:crypto";
import type { IsoTimestamp, RequestBudgetPolicy } from "../contracts.ts";
import type {
  DurableOperationPhase,
  RequestBudgetPause,
  RequestBudgetReservation,
  RequestBudgetState,
  RequestSpendApproval,
  RequestSpendCapPin,
  RuntimeState,
  RuntimeTaskState,
} from "./schema.ts";
import { USD_MICROS_PER_DOLLAR } from "./usage.ts";
import {
  type AdditionalCharges,
  buildRequestUsageReceipt,
  type IncludedQuota,
  type RequestUsageReadout,
} from "./usage-receipt.ts";

export type RequestBudgetErrorCode =
  | "unknown-decision"
  | "stale-decision"
  | "cap-not-raised"
  | "invalid-amount";

export class RequestBudgetError extends Error {
  readonly code: RequestBudgetErrorCode;
  readonly requestId: string;

  constructor(code: RequestBudgetErrorCode, message: string, requestId: string) {
    super(message);
    this.name = "RequestBudgetError";
    this.code = code;
    this.requestId = requestId;
  }
}

/** The pinned-policy and agreement identities a cap decision is resolved and bound under. */
export type RequestSpendIdentity = Readonly<{
  readonly policyDigest: string;
  readonly briefRevision: number;
}>;

/** The cap in force, or the explicit absence of one. Absence never means unlimited. */
export type RequestSpendCap =
  | Readonly<{
      readonly source: RequestSpendCapPin["source"];
      readonly capMicros: number;
    }>
  | Readonly<{ readonly source: "none" }>;

/**
 * Whether a recorded approval still speaks for the identity now asking to spend. `recorded` is an
 * approval read without a governing task at hand: it exists, and whether it still speaks is
 * decided at the next admission rather than claimed here.
 */
export type RequestSpendApprovalState = "absent" | "recorded" | "current" | "superseded";

/**
 * What the ledger says one request has actually been charged, plus which operations it holds a
 * reported charge for. An operation missing from `pricedOperationIds` is unpriced, not free.
 */
export type RequestChargeObservation = Readonly<{
  readonly charges: AdditionalCharges;
  readonly quota: IncludedQuota;
  readonly pricedOperationIds: readonly string[];
}>;

/** Observed charges and outstanding estimates, kept apart so neither is read as the other. */
export type RequestSpendExposure = Readonly<{
  readonly committedMicros: number;
  readonly reservedMicros: number;
  readonly totalMicros: number;
  readonly inFlightReservations: number;
  readonly settledEstimateReservations: number;
  readonly unpricedSamples: number;
}>;

export type RequestSpendAdmissionInput = Readonly<{
  readonly requestId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly policy: RequestBudgetPolicy;
  readonly identity: RequestSpendIdentity;
  readonly observation: RequestChargeObservation;
  readonly budget: RequestBudgetState | undefined;
  readonly now: IsoTimestamp;
}>;

/**
 * The decision plus the budget record to persist with it. `raised` marks the one admission that
 * created a pause, so exactly one question is asked however many admissions the pause then stops.
 */
export type RequestSpendAdmission =
  | Readonly<{
      readonly outcome: "admitted";
      readonly budget: RequestBudgetState;
      readonly reservation: RequestBudgetReservation;
    }>
  | Readonly<{
      readonly outcome: "paused";
      readonly budget: RequestBudgetState;
      readonly pause: RequestBudgetPause;
      readonly raised: boolean;
    }>;

/** Everything a spending decision needs, read without starting any work. */
export type RequestSpendReadout = Readonly<{
  readonly requestId: string;
  readonly cap: RequestSpendCap;
  readonly exposure: RequestSpendExposure;
  readonly charges: AdditionalCharges;
  readonly quota: IncludedQuota;
  readonly reservations: readonly RequestBudgetReservation[];
  readonly approvalState: RequestSpendApprovalState;
  readonly approval?: RequestSpendApproval;
  readonly pause?: RequestBudgetPause;
  readonly reconciledAt?: IsoTimestamp;
}>;

/** The policy and identity a cap is resolved from, when a reader has a governing task at hand. */
export type RequestSpendGovernance = Readonly<{
  readonly policy: RequestBudgetPolicy;
  readonly identity: RequestSpendIdentity;
}>;

/** What an approver claims to be authorizing; it must name the exact decision it answers. */
export type RequestSpendAuthorization = Readonly<{
  readonly requestId: string;
  readonly decisionId: string;
  readonly capMicros: number;
}>;

/** How a durable operation ended, as far as the runtime record can prove. */
export type RequestOperationSettlement = Readonly<{
  readonly operationId: string;
  readonly outcome: "settled" | "uncertain";
}>;

/**
 * How far each durable operation's end is actually proven. Completed, failed, and cancelled are
 * settled outcomes; anything still in flight, and anything quarantined because ownership or
 * resources could not be proven, stays uncertain and so keeps its reservation.
 */
export function requestOperationSettlements(
  source: Pick<RuntimeTaskState, "operation" | "operationHistory">,
): readonly RequestOperationSettlement[] {
  const operations = [
    ...(source.operationHistory ?? []),
    ...(source.operation ? [source.operation] : []),
  ];
  return operations.map((operation) => ({
    operationId: operation.id,
    outcome: SETTLED_OPERATION_PHASES.includes(operation.phase) ? "settled" : "uncertain",
  }));
}

export function emptyRequestBudget(requestId: string): RequestBudgetState {
  return { schemaVersion: 1, requestId, reservations: [] };
}

export function requestBudgetFor(
  state: RuntimeState,
  requestId: string,
): RequestBudgetState | undefined {
  return state.requestBudgets?.find((entry) => entry.requestId === requestId);
}

/** Replaces one request's budget, leaving every other request and every task untouched. */
export function withRequestBudget(state: RuntimeState, budget: RequestBudgetState): RuntimeState {
  const existing = state.requestBudgets ?? [];
  const replaced = existing.some((entry) => entry.requestId === budget.requestId);
  return {
    ...state,
    requestBudgets: replaced
      ? existing.map((entry) => (entry.requestId === budget.requestId ? budget : entry))
      : [...existing, budget],
  };
}

/**
 * Reduces the ledger's own events to what a budget needs. Totals come from the canonical receipt
 * rather than a second summation, so a budget can never disagree with the receipt it quotes.
 */
export function observeRequestCharges(
  requestId: string,
  readout: RequestUsageReadout,
): RequestChargeObservation {
  const receipt = buildRequestUsageReceipt(requestId, readout);
  const pricedOperationIds: string[] = [];
  for (const event of readout.events) {
    const operationId = event.identity.operationId;
    if (operationId === undefined || event.charge.provenance === "unavailable") continue;
    if (!pricedOperationIds.includes(operationId)) pricedOperationIds.push(operationId);
  }
  return { charges: receipt.charges, quota: receipt.quota, pricedOperationIds };
}

/**
 * Whether the recorded approval still speaks for this identity. It stops speaking when the pinned
 * policy changes, when the agreement is revised, or when the repository's own cap moves under it,
 * because none of those is the situation the approver was shown.
 */
export function requestSpendApprovalState(
  approval: RequestSpendApproval | undefined,
  policy: RequestBudgetPolicy,
  identity: RequestSpendIdentity,
): RequestSpendApprovalState {
  if (approval === undefined) return "absent";
  return approval.policyDigest === identity.policyDigest &&
    approval.briefRevision === identity.briefRevision &&
    approval.policyCapMicros === policy.capMicros
    ? "current"
    : "superseded";
}

/**
 * Precedence: a current approved request override, then whatever the pinned policy configured,
 * which is already the repository override layered over the standing default. A superseded
 * approval falls back to the policy amount, never to no cap at all.
 */
export function resolveRequestSpendCap(
  policy: RequestBudgetPolicy,
  approval: RequestSpendApproval | undefined,
  identity: RequestSpendIdentity,
): RequestSpendCap {
  if (
    approval !== undefined &&
    requestSpendApprovalState(approval, policy, identity) === "current"
  ) {
    return { source: "request-approval", capMicros: approval.capMicros };
  }
  return policy.capMicros === "unset"
    ? { source: "none" }
    : { source: "pinned-policy", capMicros: policy.capMicros };
}

export function requestSpendExposure(
  budget: RequestBudgetState | undefined,
  observation: RequestChargeObservation,
): RequestSpendExposure {
  const reservations = budget?.reservations ?? [];
  const reservedMicros = reservations.reduce(
    (total, reservation) => total + reservation.estimatedMicros,
    0,
  );
  const committedMicros = observation.charges.amountMicros;
  return {
    committedMicros,
    reservedMicros,
    totalMicros: committedMicros + reservedMicros,
    inFlightReservations: reservations.filter((entry) => entry.basis === "in-flight").length,
    settledEstimateReservations: reservations.filter((entry) => entry.basis === "settled-estimate")
      .length,
    unpricedSamples: observation.charges.unavailableSamples,
  };
}

/**
 * The one admission decision, taken against observed charges and every outstanding estimate at
 * once. The caller persists the returned budget in the same atomic write that records its
 * operation, which is what makes a second concurrent admission see this one's reservation.
 */
export function decideRequestSpendAdmission(
  input: RequestSpendAdmissionInput,
): RequestSpendAdmission {
  const budget = input.budget ?? emptyRequestBudget(input.requestId);
  if (budget.pause !== undefined) {
    return { outcome: "paused", budget, pause: budget.pause, raised: false };
  }
  const cap = resolveRequestSpendCap(input.policy, budget.approval, input.identity);
  const exposure = requestSpendExposure(budget, input.observation);
  const estimate = input.policy.operationEstimateMicros;
  const verdict = judgeRequestSpend(cap, estimate, exposure);
  if (verdict.kind === "refused") {
    const pause = budgetPause(input, cap, estimate, exposure, verdict.reason);
    return { outcome: "paused", budget: { ...budget, pause }, pause, raised: true };
  }
  const reservation: RequestBudgetReservation = {
    operationId: input.operationId,
    taskId: input.taskId,
    basis: "in-flight",
    estimatedMicros: verdict.estimateMicros,
    reservedAt: input.now,
  };
  const pin: RequestSpendCapPin = {
    source: verdict.source,
    capMicros: verdict.capMicros,
    policyDigest: input.identity.policyDigest,
    briefRevision: input.identity.briefRevision,
    pinnedAt: input.now,
  };
  return {
    outcome: "admitted",
    budget: {
      ...budget,
      cap: pin,
      reservations: [...withoutOperation(budget.reservations, input.operationId), reservation],
    },
    reservation,
  };
}

/**
 * Brings reservations level with the durable operations they back, which is what a restart runs
 * before admitting anything. An operation the ledger has priced leaves the record because its
 * actual charge is now committed; an operation that ended unpriced keeps its estimate standing;
 * an operation whose end is not proven keeps its reservation exactly as it was.
 */
export function reconcileRequestBudgetReservations(
  budget: RequestBudgetState,
  settlements: readonly RequestOperationSettlement[],
  observation: RequestChargeObservation,
  now: IsoTimestamp,
): RequestBudgetState {
  const reservations: RequestBudgetReservation[] = [];
  for (const reservation of budget.reservations) {
    if (observation.pricedOperationIds.includes(reservation.operationId)) continue;
    const settlement = settlements.find((entry) => entry.operationId === reservation.operationId);
    reservations.push(
      settlement?.outcome === "settled"
        ? { ...reservation, basis: "settled-estimate", settledAt: reservation.settledAt ?? now }
        : reservation,
    );
  }
  return { ...budget, reservations, reconciledAt: now };
}

/**
 * Records one explicit decision to spend more. The claim must name the pending decision exactly,
 * so an approval cannot travel to a later pause, a different request, or a cap the approver never
 * saw; a restart that finds no answer finds the pause still standing.
 */
export function authorizeRequestSpend(
  budget: RequestBudgetState | undefined,
  intent: RequestSpendAuthorization,
  now: IsoTimestamp,
): RequestBudgetState {
  const pause = budget?.pause;
  if (budget === undefined || pause === undefined) {
    throw new RequestBudgetError(
      "unknown-decision",
      `Request ${intent.requestId} has no pending spending decision`,
      intent.requestId,
    );
  }
  if (pause.decisionId !== intent.decisionId) {
    throw new RequestBudgetError(
      "stale-decision",
      `Decision ${intent.decisionId} is not the pending decision ${pause.decisionId} for request ${intent.requestId}`,
      intent.requestId,
    );
  }
  if (!Number.isSafeInteger(intent.capMicros) || intent.capMicros < 0) {
    throw new RequestBudgetError(
      "invalid-amount",
      `A cap must be a non-negative integer number of USD micro-dollars; received ${String(intent.capMicros)}`,
      intent.requestId,
    );
  }
  if (pause.capMicros !== "unset" && intent.capMicros < pause.capMicros) {
    throw new RequestBudgetError(
      "cap-not-raised",
      `Request ${intent.requestId} is stopped at ${describeSpendMicros(pause.capMicros)}; authorizing ${describeSpendMicros(intent.capMicros)} would lower it rather than resolve the decision`,
      intent.requestId,
    );
  }
  const approval: RequestSpendApproval = {
    requestId: intent.requestId,
    decisionId: pause.decisionId,
    capMicros: intent.capMicros,
    previousCapMicros: pause.capMicros,
    policyCapMicros: pause.policyCapMicros,
    policyDigest: pause.policyDigest,
    briefRevision: pause.briefRevision,
    approvedAt: now,
  };
  const { pause: _resolved, ...resumed } = budget;
  return { ...resumed, approval };
}

/**
 * The budget as it stands. Given the governing policy and identity it reports the cap those
 * resolve to now; given neither it reports the cap that last governed an admission, which is what
 * a coordinator reading a stopped request has to answer against.
 */
export function requestSpendReadout(
  requestId: string,
  budget: RequestBudgetState | undefined,
  observation: RequestChargeObservation,
  governance?: RequestSpendGovernance,
): RequestSpendReadout {
  return {
    requestId,
    cap:
      governance === undefined
        ? recordedCap(budget)
        : resolveRequestSpendCap(governance.policy, budget?.approval, governance.identity),
    exposure: requestSpendExposure(budget, observation),
    charges: observation.charges,
    quota: observation.quota,
    reservations: budget?.reservations ?? [],
    approvalState:
      governance === undefined
        ? budget?.approval === undefined
          ? "absent"
          : "recorded"
        : requestSpendApprovalState(budget?.approval, governance.policy, governance.identity),
    ...(budget?.approval === undefined ? {} : { approval: budget.approval }),
    ...(budget?.pause === undefined ? {} : { pause: budget.pause }),
    ...(budget?.reconciledAt === undefined ? {} : { reconciledAt: budget.reconciledAt }),
  };
}

/** Prints an amount of money without ever letting an unknown amount read as zero dollars. */
export function describeSpendMicros(value: number | "unset" | "unavailable"): string {
  if (value === "unset") return "none configured";
  if (value === "unavailable") return "unavailable";
  return `USD ${(value / USD_MICROS_PER_DOLLAR).toFixed(6)}`;
}

/**
 * The whole spending decision in one question: the cap in force, what has been charged, what is
 * still reserved, what the next step is estimated to cost, and why the request stopped. Estimates
 * are labelled as estimates and unmeasured amounts are named as unmeasured.
 */
export function describeRequestSpendDecision(pause: RequestBudgetPause): string {
  return [
    `Spending decision ${pause.decisionId} for this request: ${PAUSE_EXPLANATIONS[pause.reason]}.`,
    `Cap in force ${describeSpendMicros(pause.capMicros)}; charged so far ${describeSpendMicros(pause.committedMicros)}; reserved for work already admitted ${describeSpendMicros(pause.reservedMicros)} (estimate); next step estimated at ${describeSpendMicros(pause.nextStepMicros)}.`,
    pause.unpricedSamples === 0
      ? undefined
      : `${pause.unpricedSamples} recorded sample(s) carry no published price and are counted as unmeasured rather than as zero.`,
    "Nothing under this request will start until the cap is raised through budget-approve naming this decision. Tandem will not switch models, skip checks, narrow review, or replan to fit.",
  ]
    .filter((line): line is string => line !== undefined)
    .join(" ");
}

const SETTLED_OPERATION_PHASES: readonly DurableOperationPhase[] = [
  "completed",
  "failed",
  "cancelled",
];

const PAUSE_EXPLANATIONS: Readonly<Record<RequestBudgetPause["reason"], string>> = {
  "no-configured-cap": "no standing cap is configured for it, so no amount has been authorized",
  "estimate-unavailable":
    "no conservative per-operation estimate is configured, so the next step's exposure is unknown",
  "cap-would-be-exceeded": "the next step no longer fits under the cap",
};

const DECISION_ID_PREFIX = "spend-";

/** The cap on record for a reader with no governing task: the approval first, then the last pin. */
function recordedCap(budget: RequestBudgetState | undefined): RequestSpendCap {
  if (budget?.approval !== undefined) {
    return { source: "request-approval", capMicros: budget.approval.capMicros };
  }
  const pin = budget?.cap;
  return pin === undefined ? { source: "none" } : { source: pin.source, capMicros: pin.capMicros };
}

function withoutOperation(
  reservations: readonly RequestBudgetReservation[],
  operationId: string,
): readonly RequestBudgetReservation[] {
  return reservations.filter((entry) => entry.operationId !== operationId);
}

/** Either the reason the next step cannot start, or the exact amounts that let it start. */
type SpendVerdict =
  | Readonly<{ readonly kind: "refused"; readonly reason: RequestBudgetPause["reason"] }>
  | Readonly<{
      readonly kind: "fits";
      readonly source: RequestSpendCapPin["source"];
      readonly capMicros: number;
      readonly estimateMicros: number;
    }>;

function judgeRequestSpend(
  cap: RequestSpendCap,
  estimate: number | "unset",
  exposure: RequestSpendExposure,
): SpendVerdict {
  if (cap.source === "none") return { kind: "refused", reason: "no-configured-cap" };
  if (estimate === "unset") return { kind: "refused", reason: "estimate-unavailable" };
  if (exposure.totalMicros + estimate > cap.capMicros) {
    return { kind: "refused", reason: "cap-would-be-exceeded" };
  }
  return {
    kind: "fits",
    source: cap.source,
    capMicros: cap.capMicros,
    estimateMicros: estimate,
  };
}

/**
 * The question's identity, derived from what makes it this question rather than a random value,
 * so re-deriving it after a restart reproduces the pending decision instead of inventing another.
 */
function spendDecisionId(
  requestId: string,
  identity: RequestSpendIdentity,
  cap: RequestSpendCap,
  reason: RequestBudgetPause["reason"],
): string {
  const canonical = JSON.stringify([
    requestId,
    identity.policyDigest,
    identity.briefRevision,
    cap.source === "none" ? null : cap.capMicros,
    reason,
  ]);
  return `${DECISION_ID_PREFIX}${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

function budgetPause(
  input: RequestSpendAdmissionInput,
  cap: RequestSpendCap,
  estimate: number | "unset",
  exposure: RequestSpendExposure,
  reason: RequestBudgetPause["reason"],
): RequestBudgetPause {
  return {
    decisionId: spendDecisionId(input.requestId, input.identity, cap, reason),
    reason,
    taskId: input.taskId,
    capMicros: cap.source === "none" ? "unset" : cap.capMicros,
    policyCapMicros: input.policy.capMicros,
    policyDigest: input.identity.policyDigest,
    briefRevision: input.identity.briefRevision,
    committedMicros: exposure.committedMicros,
    reservedMicros: exposure.reservedMicros,
    nextStepMicros: estimate === "unset" ? "unavailable" : estimate,
    unpricedSamples: exposure.unpricedSamples,
    observedAt: input.now,
  };
}
