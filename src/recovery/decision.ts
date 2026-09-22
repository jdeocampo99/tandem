import { createHash } from "node:crypto";
import type { BlockCause, BlockCauseKind, IsoTimestamp } from "../contracts.ts";

/** Version of the durable recovery decision and bounded-wait contract. */
export const RECOVERY_CONTRACT_SCHEMA_VERSION = 1;

/** Prefix shared by every durable recovery question id, so an answer path can recognize one. */
export const RECOVERY_QUESTION_ID_PREFIX = "recovery-";

/** The supported recovery mutations a decision may recommend; nothing outside this set is offered. */
export const RECOVERY_ACTION_NAMES = [
  "reconcile",
  "review-existing",
  "validation-retry",
  "evidence-repair",
] as const;

export type RecoveryActionName = (typeof RECOVERY_ACTION_NAMES)[number];

/** Whether the panes and leases behind a task are proved to belong to this coordinator. */
export type RecoveryOwnership = "proven-owned" | "foreign" | "unknown";

/** Whether durable state says what the last owned operation actually did. */
export type RecoveryPriorOutcome = "known" | "uncertain";

export type RecoveryApprovalRequirement = "preapproved" | "user-approval";

/** How one decision ended. Every value is terminal for that decision. */
export const RECOVERY_DISPOSITIONS = ["applied", "asked", "waiting", "refused", "none"] as const;

export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];

/** The named facts a preapproved action needs proved before it may run without a fresh decision. */
export const RECOVERY_PROOFS = [
  "task-in-scope",
  "task-scope-approved",
  "request-approval-current",
  "repository-identity-proven",
  "endpoint-ownership-proven",
  "prior-outcome-known",
  "no-active-durable-job",
  "no-pending-stop-request",
  "reviewed-head-exact-and-clean",
  "recovery-attempt-budget-remaining",
  "evidence-repair-budget-remaining",
] as const;

export type RecoveryProof = (typeof RECOVERY_PROOFS)[number];

export type RecoveryProvenFacts = Readonly<Record<RecoveryProof, boolean>>;

/** The actions that can run without a human in the loop, so an applier can never be handed another. */
export type UnattendedRecoveryActionName = Extract<
  RecoveryActionName,
  "reconcile" | "evidence-repair"
>;

export type PreapprovedRecoveryAction = Readonly<{
  readonly action: UnattendedRecoveryActionName;
  readonly effect: string;
  readonly requiredProofs: readonly RecoveryProof[];
}>;

/**
 * The only recovery actions Tandem may run without asking, each with the exact proof it needs.
 * Membership plus proof is what makes an action preapproved; no action is ever eligible because of
 * what it is called. Everything else, including anything that spends model or quota budget, keeps
 * its own explicit approval.
 */
export const PREAPPROVED_RECOVERY_ACTIONS: readonly PreapprovedRecoveryAction[] = [
  {
    action: "reconcile",
    effect:
      "clears only proven stale endpoint records and repairs a detached branch at the reviewed HEAD; the worktree, reports, provenance, and unmerged changes are preserved",
    requiredProofs: [
      "task-in-scope",
      "task-scope-approved",
      "request-approval-current",
      "repository-identity-proven",
      "endpoint-ownership-proven",
      "prior-outcome-known",
      "no-active-durable-job",
      "no-pending-stop-request",
      "recovery-attempt-budget-remaining",
    ],
  },
  {
    action: "evidence-repair",
    effect:
      "re-points durable report evidence at artifacts that already exist at the reviewed HEAD; no pane, worker, or lease is touched",
    requiredProofs: [
      "task-in-scope",
      "task-scope-approved",
      "request-approval-current",
      "repository-identity-proven",
      "endpoint-ownership-proven",
      "prior-outcome-known",
      "no-active-durable-job",
      "no-pending-stop-request",
      "reviewed-head-exact-and-clean",
      "evidence-repair-budget-remaining",
    ],
  },
];

/**
 * The proof every recovery action needs before a planner may propose it at all, preapproved or not.
 * `plan()` is the single place that gates action proposal on these; nothing else re-derives which
 * facts a proposal needs. `review-existing` and `validation-retry` are never preapproved (they are
 * absent from `PREAPPROVED_RECOVERY_ACTIONS`), so proposing them still always needs an explicit
 * decision, but they must not be proposed while their own proof is unmet either.
 */
function preapprovedProofsFor(action: UnattendedRecoveryActionName): readonly RecoveryProof[] {
  const found = PREAPPROVED_RECOVERY_ACTIONS.find((entry) => entry.action === action);
  if (found === undefined)
    throw new Error(`no preapproved recovery action is registered for ${action}`);
  return found.requiredProofs;
}

export const RECOVERY_ACTION_REQUIRED_PROOFS: Readonly<
  Record<RecoveryActionName, readonly RecoveryProof[]>
> = {
  reconcile: preapprovedProofsFor("reconcile"),
  "evidence-repair": preapprovedProofsFor("evidence-repair"),
  "review-existing": [
    "task-in-scope",
    "task-scope-approved",
    "repository-identity-proven",
    "endpoint-ownership-proven",
    "prior-outcome-known",
    "no-active-durable-job",
    "no-pending-stop-request",
    "reviewed-head-exact-and-clean",
    "recovery-attempt-budget-remaining",
  ],
  "validation-retry": [
    "task-in-scope",
    "task-scope-approved",
    "repository-identity-proven",
    "endpoint-ownership-proven",
    "prior-outcome-known",
    "no-active-durable-job",
    "no-pending-stop-request",
  ],
};

/** What kind of blocker durable state recorded, which decides whether a bounded wait applies. */
export type RecoveryEvidenceKind = "temporary-availability" | "durable-blocker";

/**
 * The triggering evidence, identified so repeated signals for one unresolved incident collapse onto
 * the same decision and the same wait instead of starting new ones.
 */
export type RecoveryEvidence = Readonly<{
  readonly kind: RecoveryEvidenceKind;
  readonly identity: string;
  readonly summary: string;
  readonly observedAt: IsoTimestamp;
  /** When durable evidence itself names the time the block lifts. */
  readonly knownAvailableAt?: IsoTimestamp;
}>;

export type RecoveryBudgetRemaining = Readonly<{
  readonly recoveryAttempts: number;
  readonly validationRetries: number;
  readonly evidenceRepairs: number;
}>;

/** The durable receipt of one recovery decision, preserving the request and task it was made for. */
export type RecoveryDecisionReceipt = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly requestId?: string;
  readonly evidence: RecoveryEvidence;
  readonly ownership: RecoveryOwnership;
  readonly priorOutcome: RecoveryPriorOutcome;
  readonly recommendedAction?: RecoveryActionName;
  readonly approval: RecoveryApprovalRequirement;
  readonly unmetProofs: readonly RecoveryProof[];
  readonly consequences: string;
  readonly disposition: RecoveryDisposition;
  readonly dispositionReason: string;
  readonly questionId?: string;
  readonly decidedAt: IsoTimestamp;
}>;

/** One endpoint as inspection observed it; only its ownership matters to classification. */
export type EndpointOwnershipObservation = Readonly<{
  readonly ownership: "owned" | "foreign" | "unknown";
}>;

/** One durable job as inspection observed it; only liveness and its result artifact matter here. */
export type JobOutcomeObservation = Readonly<{
  readonly active: boolean;
  readonly resultExists: boolean;
}>;

/** One durable operation as inspection observed it; a quarantined phase hides its real outcome. */
export type OperationOutcomeObservation = Readonly<{ readonly phase: string }>;

export function classifyEndpointOwnership(
  endpoints: readonly EndpointOwnershipObservation[],
): RecoveryOwnership {
  if (endpoints.some((entry) => entry.ownership === "foreign")) return "foreign";
  if (endpoints.some((entry) => entry.ownership === "unknown")) return "unknown";
  return "proven-owned";
}

/**
 * A job that is still live without a result artifact, or an operation held in quarantine, means the
 * worker outcome is not known. Retrying either of those would risk running the work twice.
 */
export function classifyPriorOutcome(
  input: Readonly<{
    readonly jobs: readonly JobOutcomeObservation[];
    readonly operations: readonly OperationOutcomeObservation[];
  }>,
): RecoveryPriorOutcome {
  if (input.jobs.some((job) => job.active && !job.resultExists)) return "uncertain";
  return input.operations.some((operation) => operation.phase === "quarantined")
    ? "uncertain"
    : "known";
}

export function preapprovedRecoveryAction(
  action: RecoveryActionName,
): PreapprovedRecoveryAction | undefined {
  return PREAPPROVED_RECOVERY_ACTIONS.find((entry) => entry.action === action);
}

export function unmetRecoveryProofs(
  action: PreapprovedRecoveryAction,
  facts: RecoveryProvenFacts,
): readonly RecoveryProof[] {
  return action.requiredProofs.filter((proof) => !facts[proof]);
}

/** A stable identity for one incident, so a repeated signal is recognized rather than restarted. */
export function recoveryEvidenceIdentity(
  input: Readonly<{
    readonly taskId: string;
    readonly generation: number;
    readonly requestId?: string;
    readonly kind: RecoveryEvidenceKind;
    readonly summary: string;
  }>,
): string {
  const parts = [
    input.requestId ?? "",
    input.taskId,
    String(input.generation),
    input.kind,
    normalizedIncidentText(input.summary),
  ];
  return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
}

/**
 * A stable identity for one block cause, keyed to the task, its generation, the cause's own kind,
 * and (when the site recorded one) the exact job it happened to. Unlike `recoveryEvidenceIdentity`,
 * this never hashes `summary`: rewording a cause's plain-English summary can never orphan an
 * outstanding recovery question or decision, because nothing about the wording feeds the identity.
 */
export function blockCauseEvidenceIdentity(
  input: Readonly<{
    readonly taskId: string;
    readonly generation: number;
    readonly kind: BlockCauseKind;
    readonly jobId?: string;
  }>,
): string {
  const parts = [input.taskId, String(input.generation), input.kind, input.jobId ?? ""];
  return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
}

/**
 * Reads the durable blockers recorded for one task and answers what the coordinator is deciding
 * about. Blockers are ordered by authority, so the task's own reason wins over a runtime note. When
 * the task's own blocker carries a typed `cause`, the evidence identity is keyed off the cause's kind
 * (and job, when it has one) via `blockCauseEvidenceIdentity` instead of the free-text hash, so a
 * later rewording of the summary can never orphan an outstanding decision or question.
 */
export function classifyRecoveryEvidence(
  input: Readonly<{
    readonly taskId: string;
    readonly generation: number;
    readonly requestId?: string;
    readonly blockers: readonly string[];
    readonly observedAt: IsoTimestamp;
    /** The task's own typed block cause, when one was recorded for its current blocker. */
    readonly cause?: BlockCause;
  }>,
): RecoveryEvidence | undefined {
  const blockers = input.blockers.filter((entry) => entry.trim().length > 0);
  const availability = blockers.find((entry) => isTemporaryAvailabilityText(entry));
  const summary = availability ?? blockers[0];
  if (summary === undefined) return undefined;
  const kind: RecoveryEvidenceKind =
    availability === undefined ? "durable-blocker" : "temporary-availability";
  const knownAvailableAt =
    availability === undefined ? undefined : availabilityTimeIn(availability, input.observedAt);
  const identity =
    kind === "durable-blocker" && input.cause !== undefined
      ? blockCauseEvidenceIdentity({
          taskId: input.taskId,
          generation: input.generation,
          kind: input.cause.kind,
          ...(input.cause.jobId === undefined ? {} : { jobId: input.cause.jobId }),
        })
      : recoveryEvidenceIdentity({ ...input, kind, summary });
  return {
    kind,
    identity,
    summary: boundedSummary(summary),
    observedAt: input.observedAt,
    ...(knownAvailableAt === undefined ? {} : { knownAvailableAt }),
  };
}

export type RecoveryActionChoice = Readonly<{
  readonly recommendedAction?: RecoveryActionName;
  readonly approval: RecoveryApprovalRequirement;
  readonly unmetProofs: readonly RecoveryProof[];
  readonly consequences: string;
}>;

export type RecoveryActionChoiceInput = Readonly<{
  /** The operation the current dry-run recovery plan proposes, or "none" when it proposes nothing. */
  readonly plannedAction: RecoveryActionName | "none";
  readonly plannedEffect: string;
  readonly planRefusals: readonly string[];
  readonly facts: RecoveryProvenFacts;
  readonly budget: RecoveryBudgetRemaining;
}>;

/**
 * Turns the current dry-run plan into what should happen next: an action that is preapproved and
 * fully proved, or a recommendation that needs a fresh decision. Nothing here touches state.
 */
export function chooseRecoveryAction(input: RecoveryActionChoiceInput): RecoveryActionChoice {
  const budget = describeRemainingBudget(input.budget);
  if (input.planRefusals.length > 0) {
    return {
      approval: "user-approval",
      unmetProofs: failingProofs(input.facts),
      consequences: `No resource is changed while ${input.planRefusals.join("; ")}. ${budget}`,
    };
  }
  if (input.plannedAction === "none") {
    return {
      approval: "user-approval",
      unmetProofs: failingProofs(input.facts),
      consequences: `No supported recovery action is currently proven, so nothing is changed. ${budget}`,
    };
  }
  const preapproved = preapprovedRecoveryAction(input.plannedAction);
  if (preapproved === undefined) {
    return {
      recommendedAction: input.plannedAction,
      approval: "user-approval",
      unmetProofs: [],
      consequences: `${input.plannedEffect}. This action is not preapproved and needs an explicit decision. ${budget}`,
    };
  }
  const unmetProofs = unmetRecoveryProofs(preapproved, input.facts);
  return {
    recommendedAction: preapproved.action,
    approval: unmetProofs.length === 0 ? "preapproved" : "user-approval",
    unmetProofs,
    consequences: `${preapproved.effect}. ${budget}`,
  };
}

const MAX_EVIDENCE_SUMMARY_CHARS = 300;

/** Phrases that mark a provider-side quota or availability block rather than a defect in the work. */
const TEMPORARY_AVAILABILITY_PATTERNS: readonly RegExp[] = [
  /\brate[ -]?limit/iu,
  /\bquota\b/iu,
  /\bover capacity\b/iu,
  /\boverloaded\b/iu,
  /\bthrottled\b/iu,
  /\b429\b/u,
  /\b503\b/u,
  /\bservice unavailable\b/iu,
  /\btemporarily unavailable\b/iu,
  /\btry again later\b/iu,
];

const RETRY_AFTER_SECONDS = /\bretry[ -]?after[:= ]\s*(\d{1,6})\b/iu;
const RETRY_IN_UNITS =
  /\b(?:try again|retry|available|resets?)\s+in\s+(\d{1,6})\s*(s|m|h|sec|min|hour)/iu;
const AVAILABLE_AT_TIMESTAMP =
  /\b(?:available|resets?|retry)\s+(?:again\s+)?at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/iu;

const UNIT_MILLISECONDS: Readonly<Record<string, number>> = {
  s: 1_000,
  sec: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
};

function normalizedIncidentText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z/gu, "<time>")
    .replace(/\d+/gu, "<n>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_EVIDENCE_SUMMARY_CHARS);
}

function boundedSummary(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, MAX_EVIDENCE_SUMMARY_CHARS);
}

/**
 * Whether text reads as a provider-side quota or availability block rather than a defect in the
 * work. Shared by the availability-wait classifier above and by the restart same-failure-class
 * guard in the central recovery module, so both name a provider outage the same way.
 */
export function isTemporaryAvailabilityText(value: string): boolean {
  return TEMPORARY_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(value));
}

/** The time durable evidence itself says the block lifts, or undefined when it names none. */
function availabilityTimeIn(value: string, observedAt: IsoTimestamp): IsoTimestamp | undefined {
  const explicit = AVAILABLE_AT_TIMESTAMP.exec(value)?.[1];
  if (explicit !== undefined) return new Date(explicit).toISOString();
  const delayMs = announcedDelayMilliseconds(value);
  if (delayMs === undefined) return undefined;
  const observedMs = Date.parse(observedAt);
  return Number.isNaN(observedMs) ? undefined : new Date(observedMs + delayMs).toISOString();
}

function announcedDelayMilliseconds(value: string): number | undefined {
  const seconds = RETRY_AFTER_SECONDS.exec(value)?.[1];
  if (seconds !== undefined) return Number(seconds) * 1_000;
  const inUnits = RETRY_IN_UNITS.exec(value);
  const amount = inUnits?.[1];
  const unit = inUnits?.[2]?.toLowerCase();
  if (amount === undefined || unit === undefined) return undefined;
  const scale = UNIT_MILLISECONDS[unit];
  return scale === undefined ? undefined : Number(amount) * scale;
}

function failingProofs(facts: RecoveryProvenFacts): readonly RecoveryProof[] {
  return RECOVERY_PROOFS.filter((proof) => !facts[proof]);
}

function describeRemainingBudget(budget: RecoveryBudgetRemaining): string {
  return `Remaining budget: ${budget.recoveryAttempts} recovery attempt(s), ${budget.validationRetries} validation retry/retries, ${budget.evidenceRepairs} evidence repair(s).`;
}

/** The two failure classes the central recovery module distinguishes for the same-class guard. */
export const RESTART_FAILURE_CLASSES = ["provider-unavailable", "unknown"] as const;

export type RestartFailureClass = (typeof RESTART_FAILURE_CLASSES)[number];

/** Classifies a dead worker's failure text for the restart same-failure-class guard. */
export function classifyRestartFailure(text: string): RestartFailureClass {
  return isTemporaryAvailabilityText(text) ? "provider-unavailable" : "unknown";
}

/**
 * A stable identity for one dead-worker incident, keyed to the task, its generation, and the exact
 * job that died. Unlike `recoveryEvidenceIdentity` (which hashes blocker text and so reshuffles when
 * the wording of a blocker changes), this identity survives re-diagnosis: the same dead job always
 * resolves to the same question and decision, so an outstanding approval is never orphaned by a
 * second inspection describing the same incident in different words.
 */
export function restartIncidentIdentity(
  input: Readonly<{
    readonly taskId: string;
    readonly generation: number;
    readonly deadJobId: string;
  }>,
): string {
  return createHash("sha256")
    .update(`${input.taskId} ${input.generation} ${input.deadJobId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The plain-English shape every recovery question and coordinator notice uses: what happened, what
 * Tandem wants to do about it, and what the person answering risks either way. IDs, paths, and other
 * identifiers belong in a details/consequences string, never in `what`.
 */
export function formatRecoveryQuestion(
  input: Readonly<{ readonly what: string; readonly want: string; readonly risk: string }>,
): string {
  return [
    `What happened: ${input.what}`,
    `What I want to do: ${input.want}`,
    `What you risk: ${input.risk}`,
  ].join(" ");
}
