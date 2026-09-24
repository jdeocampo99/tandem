import { isAbsolute, resolve } from "node:path";
import type { GitCheckpoint } from "../adapters/git.ts";
import {
  MODEL_TIER_EVIDENCE_GAPS,
  type ModelTierAxisRelation,
  type ModelTierEvidenceGap,
} from "../config/model-tier.ts";
import type {
  Endpoint,
  Finding,
  IsoTimestamp,
  ReviewMode,
  StoredReviewLens,
  ThinkingLevel,
  ValidationContractName,
  WorktreeLease,
} from "../contracts.ts";
import { ALL_REVIEW_LENSES, LEGACY_ENDPOINT_ROLES, THINKING_LEVELS } from "../contracts.ts";
import type { EscalationReason } from "../tasks/acceptance.ts";
import type { LegacyWorkerRole } from "../workers/jobs.ts";

const RUNTIME_SCHEMA_VERSION = 1;

export type RuntimeJobPhase = "reserved" | "launching" | "running" | "consumed" | "failed";
export type RuntimeReservationPhase = "reserved" | "worktree" | "endpoint" | "released";
export type RuntimeJobKind = "worker" | "validation";
export type DurableOperationKind =
  | "scout"
  | "implementation"
  | "fix"
  | "validation"
  | "review"
  // ponytail: an operation admitted before the verifier role was removed may still carry this
  // kind; no new operation is ever admitted with it (see workers/workflow.ts's reserveTask).
  | "verification"
  | "presentation";
export type DurableOperationPhase =
  | "prepared"
  | "admitted"
  | "acquiring"
  | "launching"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "quarantined"
  | "cancelled";

export type DurableOperationEffect = Readonly<{
  readonly id: string;
  readonly kind: "worktree" | "endpoint" | "worker";
  readonly phase: "intent" | "started" | "succeeded" | "unknown";
  readonly createdAt: IsoTimestamp;
  readonly identity?: string;
  readonly receipt?: string;
}>;

/**
 * How an attempt's exact model came to be authorized. `pinned-policy` is the role assignment the
 * repository pinned; `comparable-reassignment` is the one automatic move, taken only after a known
 * safe failure and only on proven same-or-lower tier evidence. A premium move is never one of
 * these: it is a question, not a basis.
 */
export const EXECUTION_ROUTING_BASES = ["pinned-policy", "comparable-reassignment"] as const;

export type ExecutionRoutingBasis = (typeof EXECUTION_ROUTING_BASES)[number];

/** Whether the tier evidence behind a routing choice was actually read at the boundary. */
export const EXECUTION_ROUTING_EVIDENCE_SOURCES = [
  "catalogue-read",
  "catalogue-unavailable",
] as const;

export type ExecutionRoutingEvidenceSource = (typeof EXECUTION_ROUTING_EVIDENCE_SOURCES)[number];

/** Where the usage evidence behind a routing choice came from, or that there was none to read. */
export const EXECUTION_ROUTING_USAGE_SOURCES = ["request-ledger", "no-governing-request"] as const;

export type ExecutionRoutingUsageSource = (typeof EXECUTION_ROUTING_USAGE_SOURCES)[number];

/** The configured limits a routing choice was taken under, recorded as they stood. */
export type ExecutionRoutingLimits = Readonly<{
  readonly maxWorkers: number;
}>;

/**
 * What the boundary knew about the two models it placed against each other, and how much of the
 * request's own spending nobody could observe. The sample counts are present exactly when a
 * governing request's ledger was read; they are what makes unmeasured work visible in the record
 * instead of leaving a charged total to be misread as a measurement.
 */
export type ExecutionRoutingEvidence = Readonly<{
  readonly source: ExecutionRoutingEvidenceSource;
  readonly catalogueReadAt?: IsoTimestamp;
  /** Providers explicitly enabled for spending; catalogue discovery alone never adds one. */
  readonly enabledProviders: readonly string[];
  readonly costRelation?: ModelTierAxisRelation;
  readonly quotaRelation?: ModelTierAxisRelation;
  readonly includedAllowancePlan?: string;
  readonly usageSource: ExecutionRoutingUsageSource;
  readonly unaccountedSamples?: number;
  readonly unmeasuredTokenSamples?: number;
}>;

/**
 * The recorded execution transition that authorizes one attempt's exact model. Job construction
 * writes it onto the operation that admitted the attempt and the execution gate reads it back; an
 * audit effect describing a model change never stands in for it, and it speaks only for the
 * operation, generation, HEAD, and pinned policy it names.
 */
export type DurableExecutionRouting = Readonly<{
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly basis: ExecutionRoutingBasis;
  readonly requestId?: string;
  readonly taskId: string;
  readonly jobId: string;
  readonly operationId: string;
  readonly role: LegacyWorkerRole;
  readonly generation: number;
  readonly attempt: number;
  readonly policyDigest: string;
  readonly inputHead: string;
  readonly provider: string;
  readonly selector: string;
  readonly thinking: ThinkingLevel;
  /** The model this transition moves away from; present only on an actual model change. */
  readonly replaces?: Readonly<{
    readonly selector: string;
    readonly thinking: ThinkingLevel;
  }>;
  readonly evidence: ExecutionRoutingEvidence;
  readonly limits: ExecutionRoutingLimits;
  readonly resolvedAt: IsoTimestamp;
}>;

export const EXECUTION_ROUTING_PAUSE_REASONS = [
  "prior-outcome-uncertain",
  "pinned-model-absent-from-catalogue",
  "pinned-model-ambiguous-in-catalogue",
  "pinned-model-thinking-level-unsupported",
] as const;

export type ExecutionRoutingPauseReason = (typeof EXECUTION_ROUTING_PAUSE_REASONS)[number];

/**
 * Reasons older versions saved that routing no longer raises: each could only be answered "keep
 * the pinned model", so routing now does that. Still decoded so saved state loads; a saved pause
 * with one of these never stands (see `executionRoutingPauseStands`).
 */
export const RETIRED_ROUTING_PAUSE_REASONS = [
  "premium-tier-requires-approval",
  "tier-evidence-indeterminate",
  "usage-evidence-unmeasured",
] as const;

/**
 * The durable question one task's routing is stopped on. It is written once and read by every
 * later reservation, so the same question costs nothing to repeat and is never asked twice. It
 * stops speaking when the pinned policy, generation, or input HEAD moves under it.
 */
export type DurableExecutionRoutingPause = Readonly<{
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly reason: ExecutionRoutingPauseReason | (typeof RETIRED_ROUTING_PAUSE_REASONS)[number];
  readonly taskId: string;
  readonly jobId: string;
  readonly operationId: string;
  readonly role: LegacyWorkerRole;
  readonly generation: number;
  readonly attempt: number;
  readonly policyDigest: string;
  readonly inputHead: string;
  readonly pinnedSelector: string;
  readonly pinnedThinking: ThinkingLevel;
  readonly evidenceGaps: readonly ModelTierEvidenceGap[];
  readonly enabledProviders: readonly string[];
  readonly usageSource: ExecutionRoutingUsageSource;
  /** Work under this request whose cost or tokens nobody reported; present with a read ledger. */
  readonly unaccountedSamples?: number;
  readonly unmeasuredTokenSamples?: number;
  readonly limits: ExecutionRoutingLimits;
  readonly observedAt: IsoTimestamp;
}>;

export type DurableOperation = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly kind: DurableOperationKind;
  readonly role: LegacyWorkerRole | "validation";
  readonly generation: number;
  readonly inputHead: string;
  readonly policyDigest: string;
  readonly instructionRevision: number;
  readonly jobId: string;
  readonly fixContext?: Readonly<{
    readonly head: string;
    readonly generation: number;
    readonly validationEvidence: readonly unknown[];
    readonly findings: readonly Finding[];
  }>;
  readonly phase: DurableOperationPhase;
  readonly fencingRevision: number;
  readonly claimOwner: string;
  readonly createdAt: IsoTimestamp;
  readonly effects: readonly DurableOperationEffect[];
  /** The execution transition authorizing this attempt's exact model; absent means the pinned one. */
  readonly routing?: DurableExecutionRouting;
  readonly resultConsumedAt?: IsoTimestamp;
  readonly error?: string;
}>;

export type DurableJobConsumption = Readonly<{
  readonly schemaVersion: 1;
  readonly inputEventKey: string;
  readonly appliedEventKey: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly beforeFingerprint: string;
  readonly taskFingerprint: string;
  readonly now: IsoTimestamp;
  readonly notificationId: string;
}>;

export type DurableJob = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly role: LegacyWorkerRole | "validation";
  readonly kind: RuntimeJobKind;
  readonly cwd: string;
  readonly jobPath: string;
  readonly resultPath: string;
  readonly attempt: number;
  readonly phase: RuntimeJobPhase;
  readonly launchAttempted: boolean;
  readonly createdAt: IsoTimestamp;
  /** New jobs always carry the operation that admitted them; absent means legacy state. */
  readonly operationId?: string;
  readonly launchedAt?: IsoTimestamp;
  readonly consumedAt?: IsoTimestamp;
  readonly endpoint?: Endpoint;
  readonly head?: string;
  /** Validation jobs carry the contract and policy identity their evidence is pinned to. */
  readonly contract?: ValidationContractName;
  readonly policyDigest?: string;
  /** Present when targeted iteration checks were refused for the complete manifest. */
  readonly escalation?: EscalationReason;
  readonly reviewLens?: StoredReviewLens;
  readonly receiptPath?: string;
  readonly instructionRevision?: number;
  readonly progressWarningAt?: IsoTimestamp;
  readonly consumption?: DurableJobConsumption;
  readonly error?: string;
}>;
export type DurableEndpointLaunch = Readonly<{
  readonly schemaVersion: 1;
  readonly reservationId: string;
  readonly operationId?: string;
  readonly sessionId: string;
  readonly taskName: string;
  readonly workspaceLabel: string;
  readonly cwd: string;
  readonly role: Endpoint["role"];
  readonly generation: number;
  readonly createdAt: IsoTimestamp;
  readonly parentWorkspaceId?: string;
}>;

export type DurableStopRequest = Readonly<{
  readonly schemaVersion: 1;
  readonly action: "pause" | "cancel";
  readonly generation: number;
  readonly requestedAt: IsoTimestamp;
  /** The user approved deleting the worktree with the cancel, so cleanup discards its changes. */
  readonly discard?: true;
}>;

export type DurableReservation = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly ownerSessionId: string;
  /** New reservations always reference a durable operation; absent means legacy state. */
  readonly operationId?: string;
  readonly phase: RuntimeReservationPhase;
  readonly createdAt: IsoTimestamp;
  readonly releasedAt?: IsoTimestamp;
}>;

export type RuntimeRecoveryState = Readonly<{
  readonly schemaVersion: 1;
  readonly validationRetries: number;
  /** Automatic worker restarts already used for the task's current generation; a new generation resets it. */
  readonly restarts?: number;
  readonly restartGeneration?: number;
  /** The failure class the most recent restart responded to, read by the same-class guard. */
  readonly lastRestartFailureClass?: "provider-unavailable" | "unknown";
  readonly lastRestartAt?: IsoTimestamp;
}>;

export type RuntimeTaskState = Readonly<{
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sourceCheckpoint: GitCheckpoint;
  readonly sourceRepoPath?: string;
  readonly taskName: string;
  readonly operation?: DurableOperation;
  readonly operationHistory?: readonly DurableOperation[];
  /** The routing question this task is stopped on, until its policy, generation, or HEAD moves. */
  readonly routingPause?: DurableExecutionRoutingPause;
  readonly reservation?: DurableReservation;
  readonly endpointLaunch?: DurableEndpointLaunch;
  readonly stopRequest?: DurableStopRequest;
  readonly worktree?: WorktreeLease;
  readonly endpoints: readonly Endpoint[];
  readonly jobs: readonly DurableJob[];
  readonly reviewMode?: ReviewMode;
  readonly reviewProvenancePath?: string;
  readonly recovery?: RuntimeRecoveryState;
  readonly sessionDirectory?: string;
  readonly fixContextPath?: string;
  readonly lastError?: string;
  readonly poolAdmissionKey?: string;
  readonly poolNotice?: string;
  readonly terminalCleanupRevision?: number;
  readonly legacyQuarantine?: RuntimeLegacyQuarantine;
}>;

export type RuntimeLegacyQuarantine = Readonly<{
  readonly schemaVersion: 1;
  readonly reservationId: string;
  readonly reason: string;
  readonly observedAt: IsoTimestamp;
}>;

export type RuntimePresentation = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly recordPath: string;
  readonly operation?: DurableOperation;
  readonly operationHistory?: readonly DurableOperation[];
  readonly reservation?: DurableReservation;
  readonly endpointLaunch?: DurableEndpointLaunch;
  readonly job: DurableJob;
  readonly endpoint?: Endpoint;
  readonly lastError?: string;
}>;

export type RuntimeState = Readonly<{
  readonly schemaVersion: 1;
  readonly tasks: readonly RuntimeTaskState[];
  readonly presentations: readonly RuntimePresentation[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty string without NUL characters`);
  }
  return value;
}

function singleLine(value: unknown, field: string): string {
  const result = text(value, field);
  if (/[\r\n\u2028\u2029]/u.test(result)) {
    throw new TypeError(`${field} must be a single-line value`);
  }
  return result;
}

export function absolutePath(value: unknown, field: string): string {
  const result = singleLine(value, field);
  if (!isAbsolute(result)) throw new TypeError(`${field} must be absolute`);
  return resolve(result);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function enumValue<Value extends string>(
  value: unknown,
  values: readonly Value[],
  field: string,
): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) {
    throw new TypeError(`${field} has an unsupported value`);
  }
  return value as Value;
}
// ponytail: keeps "verifier" decodable on routing decisions pinned to a job admitted before the
// role was removed; see workers/jobs.ts's LegacyWorkerRole.
const WORKER_ROLES = ["scout", "implementer", "reviewer", "verifier", "presentation"] as const;

function parseRoutingLimits(value: unknown, field: string): ExecutionRoutingLimits {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return {
    maxWorkers: positiveInteger(value.maxWorkers, `${field}.maxWorkers`),
  };
}

function parseProviderList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((entry, index) => singleLine(entry, `${field}[${index}]`));
}

function parseAxisRelation(value: unknown, field: string): ModelTierAxisRelation | undefined {
  return value === undefined
    ? undefined
    : enumValue(value, ["lower", "equal", "higher"] as const, field);
}

/** The observed sample counts, present together exactly when a governing request's ledger was read. */
function parseObservedSamples(
  value: Record<string, unknown>,
  field: string,
): Readonly<{ unaccountedSamples?: number; unmeasuredTokenSamples?: number }> {
  const source = enumValue(
    value.usageSource,
    EXECUTION_ROUTING_USAGE_SOURCES,
    `${field}.usageSource`,
  );
  if (source === "no-governing-request") return {};
  return {
    unaccountedSamples: nonNegativeInteger(value.unaccountedSamples, `${field}.unaccountedSamples`),
    unmeasuredTokenSamples: nonNegativeInteger(
      value.unmeasuredTokenSamples,
      `${field}.unmeasuredTokenSamples`,
    ),
  };
}

function parseRoutingEvidence(value: unknown, field: string): ExecutionRoutingEvidence {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const catalogueReadAt =
    value.catalogueReadAt === undefined
      ? undefined
      : singleLine(value.catalogueReadAt, `${field}.catalogueReadAt`);
  const costRelation = parseAxisRelation(value.costRelation, `${field}.costRelation`);
  const quotaRelation = parseAxisRelation(value.quotaRelation, `${field}.quotaRelation`);
  const includedAllowancePlan =
    value.includedAllowancePlan === undefined
      ? undefined
      : singleLine(value.includedAllowancePlan, `${field}.includedAllowancePlan`);
  return {
    source: enumValue(value.source, EXECUTION_ROUTING_EVIDENCE_SOURCES, `${field}.source`),
    ...(catalogueReadAt === undefined ? {} : { catalogueReadAt }),
    enabledProviders: parseProviderList(value.enabledProviders, `${field}.enabledProviders`),
    ...(costRelation === undefined ? {} : { costRelation }),
    ...(quotaRelation === undefined ? {} : { quotaRelation }),
    ...(includedAllowancePlan === undefined ? {} : { includedAllowancePlan }),
    usageSource: enumValue(
      value.usageSource,
      EXECUTION_ROUTING_USAGE_SOURCES,
      `${field}.usageSource`,
    ),
    ...parseObservedSamples(value, field),
  };
}

function parseExecutionRouting(value: unknown, field: string): DurableExecutionRouting {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const requestId =
    value.requestId === undefined ? undefined : singleLine(value.requestId, `${field}.requestId`);
  const replaces =
    value.replaces === undefined
      ? undefined
      : (() => {
          if (!isRecord(value.replaces)) {
            throw new TypeError(`${field}.replaces must be an object`);
          }
          return {
            selector: singleLine(value.replaces.selector, `${field}.replaces.selector`),
            thinking: enumValue(
              value.replaces.thinking,
              THINKING_LEVELS,
              `${field}.replaces.thinking`,
            ),
          };
        })();
  return {
    schemaVersion: 1,
    decisionId: singleLine(value.decisionId, `${field}.decisionId`),
    basis: enumValue(value.basis, EXECUTION_ROUTING_BASES, `${field}.basis`),
    ...(requestId === undefined ? {} : { requestId }),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    jobId: singleLine(value.jobId, `${field}.jobId`),
    operationId: singleLine(value.operationId, `${field}.operationId`),
    role: enumValue(value.role, WORKER_ROLES, `${field}.role`),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    attempt: positiveInteger(value.attempt, `${field}.attempt`),
    policyDigest: singleLine(value.policyDigest, `${field}.policyDigest`),
    inputHead: singleLine(value.inputHead, `${field}.inputHead`),
    provider: singleLine(value.provider, `${field}.provider`),
    selector: singleLine(value.selector, `${field}.selector`),
    thinking: enumValue(value.thinking, THINKING_LEVELS, `${field}.thinking`),
    ...(replaces === undefined ? {} : { replaces }),
    evidence: parseRoutingEvidence(value.evidence, `${field}.evidence`),
    limits: parseRoutingLimits(value.limits, `${field}.limits`),
    resolvedAt: singleLine(value.resolvedAt, `${field}.resolvedAt`),
  };
}

function parseRoutingPause(value: unknown, field: string): DurableExecutionRoutingPause {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  if (!Array.isArray(value.evidenceGaps)) {
    throw new TypeError(`${field}.evidenceGaps must be an array`);
  }
  return {
    schemaVersion: 1,
    decisionId: singleLine(value.decisionId, `${field}.decisionId`),
    reason: enumValue(
      value.reason,
      [...EXECUTION_ROUTING_PAUSE_REASONS, ...RETIRED_ROUTING_PAUSE_REASONS],
      `${field}.reason`,
    ),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    jobId: singleLine(value.jobId, `${field}.jobId`),
    operationId: singleLine(value.operationId, `${field}.operationId`),
    role: enumValue(value.role, WORKER_ROLES, `${field}.role`),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    attempt: positiveInteger(value.attempt, `${field}.attempt`),
    policyDigest: singleLine(value.policyDigest, `${field}.policyDigest`),
    inputHead: singleLine(value.inputHead, `${field}.inputHead`),
    pinnedSelector: singleLine(value.pinnedSelector, `${field}.pinnedSelector`),
    pinnedThinking: enumValue(value.pinnedThinking, THINKING_LEVELS, `${field}.pinnedThinking`),
    evidenceGaps: value.evidenceGaps.map(
      (entry, index): ModelTierEvidenceGap =>
        enumValue(entry, MODEL_TIER_EVIDENCE_GAPS, `${field}.evidenceGaps[${index}]`),
    ),
    enabledProviders: parseProviderList(value.enabledProviders, `${field}.enabledProviders`),
    usageSource: enumValue(
      value.usageSource,
      EXECUTION_ROUTING_USAGE_SOURCES,
      `${field}.usageSource`,
    ),
    ...parseObservedSamples(value, field),
    limits: parseRoutingLimits(value.limits, `${field}.limits`),
    observedAt: singleLine(value.observedAt, `${field}.observedAt`),
  };
}

function parseOperationEffect(value: unknown, field: string): DurableOperationEffect {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const identity =
    value.identity === undefined ? undefined : singleLine(value.identity, `${field}.identity`);
  const receipt =
    value.receipt === undefined ? undefined : singleLine(value.receipt, `${field}.receipt`);
  return {
    id: singleLine(value.id, `${field}.id`),
    kind: enumValue(value.kind, ["worktree", "endpoint", "worker"] as const, `${field}.kind`),
    phase: enumValue(
      value.phase,
      ["intent", "started", "succeeded", "unknown"] as const,
      `${field}.phase`,
    ),
    createdAt: singleLine(value.createdAt, `${field}.createdAt`),
    ...(identity === undefined ? {} : { identity }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

function parseOperation(value: unknown, field: string): DurableOperation {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  if (!Array.isArray(value.effects)) throw new TypeError(`${field}.effects must be an array`);
  const resultConsumedAt =
    value.resultConsumedAt === undefined
      ? undefined
      : singleLine(value.resultConsumedAt, `${field}.resultConsumedAt`);
  const error = value.error === undefined ? undefined : text(value.error, `${field}.error`);
  const routing =
    value.routing === undefined
      ? undefined
      : parseExecutionRouting(value.routing, `${field}.routing`);
  const fixContext =
    value.fixContext === undefined
      ? undefined
      : (() => {
          if (!isRecord(value.fixContext))
            throw new TypeError(`${field}.fixContext must be an object`);
          if (!Array.isArray(value.fixContext.validationEvidence)) {
            throw new TypeError(`${field}.fixContext.validationEvidence must be an array`);
          }
          if (!Array.isArray(value.fixContext.findings)) {
            throw new TypeError(`${field}.fixContext.findings must be an array`);
          }
          return {
            head: singleLine(value.fixContext.head, `${field}.fixContext.head`),
            generation: nonNegativeInteger(
              value.fixContext.generation,
              `${field}.fixContext.generation`,
            ),
            validationEvidence: value.fixContext.validationEvidence,
            findings: value.fixContext.findings as Finding[],
          };
        })();
  return {
    schemaVersion: 1,
    id: singleLine(value.id, `${field}.id`),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    // ponytail: "verification"/"verifier" stay accepted so an operation admitted before the role
    // was removed still decodes; see DurableOperationKind and LegacyWorkerRole.
    kind: enumValue(
      value.kind,
      [
        "scout",
        "implementation",
        "fix",
        "validation",
        "review",
        "verification",
        "presentation",
      ] as const,
      `${field}.kind`,
    ),
    role: enumValue(
      value.role,
      ["scout", "implementer", "reviewer", "verifier", "presentation", "validation"] as const,
      `${field}.role`,
    ),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    inputHead: singleLine(value.inputHead, `${field}.inputHead`),
    policyDigest: singleLine(value.policyDigest, `${field}.policyDigest`),
    instructionRevision: nonNegativeInteger(
      value.instructionRevision,
      `${field}.instructionRevision`,
    ),
    jobId: singleLine(value.jobId, `${field}.jobId`),
    ...(fixContext === undefined ? {} : { fixContext }),
    phase: enumValue(
      value.phase,
      [
        "prepared",
        "admitted",
        "acquiring",
        "launching",
        "running",
        "finalizing",
        "completed",
        "failed",
        "quarantined",
        "cancelled",
      ] as const,
      `${field}.phase`,
    ),
    fencingRevision: positiveInteger(value.fencingRevision, `${field}.fencingRevision`),
    claimOwner: singleLine(value.claimOwner, `${field}.claimOwner`),
    createdAt: singleLine(value.createdAt, `${field}.createdAt`),
    effects: value.effects.map((entry, index) =>
      parseOperationEffect(entry, `${field}.effects[${index}]`),
    ),
    ...(routing === undefined ? {} : { routing }),
    ...(resultConsumedAt === undefined ? {} : { resultConsumedAt }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseEndpointLaunch(value: unknown, field: string): DurableEndpointLaunch {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const operationId =
    value.operationId === undefined
      ? undefined
      : singleLine(value.operationId, `${field}.operationId`);
  const parentWorkspaceId =
    value.parentWorkspaceId === undefined
      ? undefined
      : singleLine(value.parentWorkspaceId, `${field}.parentWorkspaceId`);
  return {
    schemaVersion: 1,
    reservationId: singleLine(value.reservationId, `${field}.reservationId`),
    ...(operationId === undefined ? {} : { operationId }),
    sessionId: singleLine(value.sessionId, `${field}.sessionId`),
    taskName: singleLine(value.taskName, `${field}.taskName`),
    workspaceLabel: singleLine(value.workspaceLabel, `${field}.workspaceLabel`),
    cwd: absolutePath(value.cwd, `${field}.cwd`),
    // ponytail: legacy panes/launches may still carry role "verifier"; see LEGACY_ENDPOINT_ROLES.
    role: enumValue(value.role, LEGACY_ENDPOINT_ROLES, `${field}.role`),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    createdAt: singleLine(value.createdAt, `${field}.createdAt`),
    ...(parentWorkspaceId === undefined ? {} : { parentWorkspaceId }),
  };
}

function parseStopRequest(value: unknown, field: string): DurableStopRequest {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return {
    schemaVersion: 1,
    action: enumValue(value.action, ["pause", "cancel"] as const, `${field}.action`),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    requestedAt: singleLine(value.requestedAt, `${field}.requestedAt`),
    ...(value.discard === true ? { discard: true } : {}),
  };
}

function parseJobConsumption(value: unknown, field: string): DurableJobConsumption {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return {
    schemaVersion: 1,
    inputEventKey: text(value.inputEventKey, `${field}.inputEventKey`),
    appliedEventKey: text(value.appliedEventKey, `${field}.appliedEventKey`),
    beforeRevision: nonNegativeInteger(value.beforeRevision, `${field}.beforeRevision`),
    afterRevision: nonNegativeInteger(value.afterRevision, `${field}.afterRevision`),
    beforeFingerprint: text(value.beforeFingerprint, `${field}.beforeFingerprint`),
    taskFingerprint: text(value.taskFingerprint, `${field}.taskFingerprint`),
    now: singleLine(value.now, `${field}.now`),
    notificationId: singleLine(value.notificationId, `${field}.notificationId`),
  };
}

function endpoint(value: unknown, field: string): Endpoint {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  // ponytail: legacy panes/launches may still carry role "verifier"; see LEGACY_ENDPOINT_ROLES.
  const role = enumValue(value.role, LEGACY_ENDPOINT_ROLES, `${field}.role`);
  return {
    sessionId: singleLine(value.sessionId, `${field}.sessionId`),
    workspaceId: singleLine(value.workspaceId, `${field}.workspaceId`),
    tabId: singleLine(value.tabId, `${field}.tabId`),
    paneId: singleLine(value.paneId, `${field}.paneId`),
    role,
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
  };
}

function checkpoint(value: unknown, field: string): GitCheckpoint {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const diff = value.diff;
  if (typeof diff !== "string" || diff.includes("\0")) {
    throw new TypeError(`${field}.diff must be text without NUL characters`);
  }
  return {
    head: singleLine(value.head, `${field}.head`),
    base: singleLine(value.base, `${field}.base`),
    diff,
    dirty: boolean(value.dirty, `${field}.dirty`),
    unmerged: boolean(value.unmerged, `${field}.unmerged`),
  };
}

function worktree(value: unknown, field: string): WorktreeLease {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return {
    root: absolutePath(value.root, `${field}.root`),
    path: absolutePath(value.path, `${field}.path`),
    name: singleLine(value.name, `${field}.name`),
    baseHead: singleLine(value.baseHead, `${field}.baseHead`),
    branch: singleLine(value.branch, `${field}.branch`),
    leaseId: singleLine(value.leaseId, `${field}.leaseId`),
    leaseHolder: singleLine(value.leaseHolder, `${field}.leaseHolder`),
    leasedAt: singleLine(value.leasedAt, `${field}.leasedAt`),
  };
}

function parseReservation(value: unknown, field: string): DurableReservation {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const operationId =
    value.operationId === undefined
      ? undefined
      : singleLine(value.operationId, `${field}.operationId`);
  const releasedAt =
    value.releasedAt === undefined
      ? undefined
      : singleLine(value.releasedAt, `${field}.releasedAt`);
  return {
    schemaVersion: 1,
    id: singleLine(value.id, `${field}.id`),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    ownerSessionId: singleLine(value.ownerSessionId, `${field}.ownerSessionId`),
    ...(operationId === undefined ? {} : { operationId }),
    phase: enumValue(
      value.phase,
      ["reserved", "worktree", "endpoint", "released"] as const,
      `${field}.phase`,
    ),
    createdAt: singleLine(value.createdAt, `${field}.createdAt`),
    ...(releasedAt === undefined ? {} : { releasedAt }),
  };
}

function parseJob(value: unknown, field: string): DurableJob {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  // ponytail: "verifier" stays accepted so a job admitted before the role was removed still
  // decodes; see LegacyWorkerRole.
  const role = enumValue(
    value.role,
    ["scout", "implementer", "reviewer", "verifier", "presentation", "validation"] as const,
    `${field}.role`,
  );
  const kind = enumValue(value.kind, ["worker", "validation"] as const, `${field}.kind`);
  const operationId =
    value.operationId === undefined
      ? undefined
      : singleLine(value.operationId, `${field}.operationId`);
  const launchedAt =
    value.launchedAt === undefined
      ? undefined
      : singleLine(value.launchedAt, `${field}.launchedAt`);
  const consumedAt =
    value.consumedAt === undefined
      ? undefined
      : singleLine(value.consumedAt, `${field}.consumedAt`);
  const endpointValue =
    value.endpoint === undefined ? undefined : endpoint(value.endpoint, `${field}.endpoint`);
  const head = value.head === undefined ? undefined : singleLine(value.head, `${field}.head`);
  const contract =
    value.contract === undefined
      ? undefined
      : enumValue(value.contract, ["iteration", "final"] as const, `${field}.contract`);
  const policyDigest =
    value.policyDigest === undefined
      ? undefined
      : singleLine(value.policyDigest, `${field}.policyDigest`);
  const escalation =
    value.escalation === undefined
      ? undefined
      : enumValue(
          value.escalation,
          ["unknown-impact", "broad-impact", "stale-identity", "disputed-result"] as const,
          `${field}.escalation`,
        );
  if ((contract === undefined) !== (policyDigest === undefined)) {
    throw new TypeError(`${field} must name its contract and policy digest together`);
  }
  // ponytail: a job admitted before the lenses were merged may still name a legacy lens; see
  // ALL_REVIEW_LENSES.
  const reviewLens =
    value.reviewLens === undefined
      ? undefined
      : enumValue(value.reviewLens, ALL_REVIEW_LENSES, `${field}.reviewLens`);
  const receiptPath =
    value.receiptPath === undefined
      ? undefined
      : absolutePath(value.receiptPath, `${field}.receiptPath`);
  const instructionRevision =
    value.instructionRevision === undefined
      ? undefined
      : nonNegativeInteger(value.instructionRevision, `${field}.instructionRevision`);
  const progressWarningAt =
    value.progressWarningAt === undefined
      ? undefined
      : singleLine(value.progressWarningAt, `${field}.progressWarningAt`);
  const error = value.error === undefined ? undefined : text(value.error, `${field}.error`);
  const consumption =
    value.consumption === undefined
      ? undefined
      : parseJobConsumption(value.consumption, `${field}.consumption`);
  if (kind === "validation" && role !== "validation") {
    throw new TypeError(`${field}.role must be validation for validation jobs`);
  }
  if (kind === "worker" && role === "validation") {
    throw new TypeError(`${field}.role cannot be validation for worker jobs`);
  }
  return {
    schemaVersion: 1,
    id: singleLine(value.id, `${field}.id`),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    role,
    kind,
    cwd: absolutePath(value.cwd, `${field}.cwd`),
    jobPath: absolutePath(value.jobPath, `${field}.jobPath`),
    resultPath: absolutePath(value.resultPath, `${field}.resultPath`),
    attempt: positiveInteger(value.attempt, `${field}.attempt`),
    phase: enumValue(
      value.phase,
      ["reserved", "launching", "running", "consumed", "failed"] as const,
      `${field}.phase`,
    ),
    launchAttempted: boolean(value.launchAttempted, `${field}.launchAttempted`),
    createdAt: singleLine(value.createdAt, `${field}.createdAt`),
    ...(operationId === undefined ? {} : { operationId }),
    ...(launchedAt === undefined ? {} : { launchedAt }),
    ...(consumption === undefined ? {} : { consumption }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(endpointValue === undefined ? {} : { endpoint: endpointValue }),
    ...(head === undefined ? {} : { head }),
    ...(contract === undefined ? {} : { contract }),
    ...(policyDigest === undefined ? {} : { policyDigest }),
    ...(escalation === undefined ? {} : { escalation }),
    ...(reviewLens === undefined ? {} : { reviewLens }),
    ...(receiptPath === undefined ? {} : { receiptPath }),
    ...(instructionRevision === undefined ? {} : { instructionRevision }),
    ...(progressWarningAt === undefined ? {} : { progressWarningAt }),
    ...(error === undefined ? {} : { error }),
  };
}
function parseTask(value: unknown, field: string): RuntimeTaskState {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const operation =
    value.operation === undefined
      ? undefined
      : parseOperation(value.operation, `${field}.operation`);
  const operationHistory =
    value.operationHistory === undefined
      ? undefined
      : !Array.isArray(value.operationHistory)
        ? (() => {
            throw new TypeError(`${field}.operationHistory must be an array`);
          })()
        : value.operationHistory.map((entry, index) =>
            parseOperation(entry, `${field}.operationHistory[${index}]`),
          );
  const routingPause =
    value.routingPause === undefined
      ? undefined
      : parseRoutingPause(value.routingPause, `${field}.routingPause`);
  const reservation =
    value.reservation === undefined
      ? undefined
      : parseReservation(value.reservation, `${field}.reservation`);
  const endpointLaunch =
    value.endpointLaunch === undefined
      ? undefined
      : parseEndpointLaunch(value.endpointLaunch, `${field}.endpointLaunch`);
  const stopRequest =
    value.stopRequest === undefined
      ? undefined
      : parseStopRequest(value.stopRequest, `${field}.stopRequest`);
  const worktreeValue =
    value.worktree === undefined ? undefined : worktree(value.worktree, `${field}.worktree`);
  if (!Array.isArray(value.endpoints)) throw new TypeError(`${field}.endpoints must be an array`);
  if (!Array.isArray(value.jobs)) throw new TypeError(`${field}.jobs must be an array`);
  const endpoints = value.endpoints.map((entry, index) =>
    endpoint(entry, `${field}.endpoints[${index}]`),
  );
  const jobs = value.jobs.map((entry, index) => parseJob(entry, `${field}.jobs[${index}]`));
  const sourceRepoPath =
    value.sourceRepoPath === undefined
      ? undefined
      : absolutePath(value.sourceRepoPath, `${field}.sourceRepoPath`);
  const sessionDirectory =
    value.sessionDirectory === undefined
      ? undefined
      : absolutePath(value.sessionDirectory, `${field}.sessionDirectory`);
  const fixContextPath =
    value.fixContextPath === undefined
      ? undefined
      : absolutePath(value.fixContextPath, `${field}.fixContextPath`);
  const poolAdmissionKey =
    value.poolAdmissionKey === undefined
      ? undefined
      : text(value.poolAdmissionKey, `${field}.poolAdmissionKey`);
  const poolNotice =
    value.poolNotice === undefined ? undefined : text(value.poolNotice, `${field}.poolNotice`);
  const terminalCleanupRevision =
    value.terminalCleanupRevision === undefined
      ? undefined
      : nonNegativeInteger(value.terminalCleanupRevision, `${field}.terminalCleanupRevision`);
  const lastError =
    value.lastError === undefined ? undefined : text(value.lastError, `${field}.lastError`);
  const reviewMode =
    value.reviewMode === undefined
      ? undefined
      : enumValue(
          value.reviewMode,
          ["review_changed_diff", "review_existing_head"] as const,
          `${field}.reviewMode`,
        );
  const reviewProvenancePath =
    value.reviewProvenancePath === undefined
      ? undefined
      : absolutePath(value.reviewProvenancePath, `${field}.reviewProvenancePath`);
  const recovery =
    value.recovery === undefined
      ? undefined
      : (() => {
          if (!isRecord(value.recovery)) throw new TypeError(`${field}.recovery must be an object`);
          const restarts =
            value.recovery.restarts === undefined
              ? undefined
              : nonNegativeInteger(value.recovery.restarts, `${field}.recovery.restarts`);
          const restartGeneration =
            value.recovery.restartGeneration === undefined
              ? undefined
              : nonNegativeInteger(
                  value.recovery.restartGeneration,
                  `${field}.recovery.restartGeneration`,
                );
          const lastRestartFailureClass =
            value.recovery.lastRestartFailureClass === undefined
              ? undefined
              : enumValue(
                  value.recovery.lastRestartFailureClass,
                  ["provider-unavailable", "unknown"] as const,
                  `${field}.recovery.lastRestartFailureClass`,
                );
          const lastRestartAt =
            value.recovery.lastRestartAt === undefined
              ? undefined
              : singleLine(value.recovery.lastRestartAt, `${field}.recovery.lastRestartAt`);
          return {
            schemaVersion: 1 as const,
            validationRetries: nonNegativeInteger(
              value.recovery.validationRetries,
              `${field}.recovery.validationRetries`,
            ),
            ...(restarts === undefined ? {} : { restarts }),
            ...(restartGeneration === undefined ? {} : { restartGeneration }),
            ...(lastRestartFailureClass === undefined ? {} : { lastRestartFailureClass }),
            ...(lastRestartAt === undefined ? {} : { lastRestartAt }),
          };
        })();
  const legacyQuarantine =
    value.legacyQuarantine === undefined
      ? undefined
      : (() => {
          if (!isRecord(value.legacyQuarantine))
            throw new TypeError(`${field}.legacyQuarantine must be an object`);
          return {
            schemaVersion: 1 as const,
            reservationId: singleLine(
              value.legacyQuarantine.reservationId,
              `${field}.legacyQuarantine.reservationId`,
            ),
            reason: text(value.legacyQuarantine.reason, `${field}.legacyQuarantine.reason`),
            observedAt: singleLine(
              value.legacyQuarantine.observedAt,
              `${field}.legacyQuarantine.observedAt`,
            ),
          };
        })();
  return {
    schemaVersion: 1,
    taskId: singleLine(value.taskId, `${field}.taskId`),
    sourceCheckpoint: checkpoint(value.sourceCheckpoint, `${field}.sourceCheckpoint`),
    ...(sourceRepoPath === undefined ? {} : { sourceRepoPath }),
    taskName: singleLine(value.taskName, `${field}.taskName`),
    ...(operation === undefined ? {} : { operation }),
    ...(operationHistory === undefined ? {} : { operationHistory }),
    ...(routingPause === undefined ? {} : { routingPause }),
    ...(reservation === undefined ? {} : { reservation }),
    ...(endpointLaunch === undefined ? {} : { endpointLaunch }),
    ...(stopRequest === undefined ? {} : { stopRequest }),
    ...(worktreeValue === undefined ? {} : { worktree: worktreeValue }),
    endpoints,
    jobs,
    ...(fixContextPath === undefined ? {} : { fixContextPath }),
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    ...(reviewMode === undefined ? {} : { reviewMode }),
    ...(reviewProvenancePath === undefined ? {} : { reviewProvenancePath }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(poolAdmissionKey === undefined ? {} : { poolAdmissionKey }),
    ...(legacyQuarantine === undefined ? {} : { legacyQuarantine }),
    ...(poolNotice === undefined ? {} : { poolNotice }),
    ...(terminalCleanupRevision === undefined ? {} : { terminalCleanupRevision }),
  };
}

function parsePresentation(value: unknown, field: string): RuntimePresentation {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const operation =
    value.operation === undefined
      ? undefined
      : parseOperation(value.operation, `${field}.operation`);
  let operationHistory: readonly DurableOperation[] | undefined;
  if (value.operationHistory !== undefined) {
    if (!Array.isArray(value.operationHistory)) {
      throw new TypeError(`${field}.operationHistory must be an array`);
    }
    operationHistory = value.operationHistory.map((entry, index) =>
      parseOperation(entry, `${field}.operationHistory[${index}]`),
    );
  }
  const endpointLaunch =
    value.endpointLaunch === undefined
      ? undefined
      : parseEndpointLaunch(value.endpointLaunch, `${field}.endpointLaunch`);
  const reservation =
    value.reservation === undefined
      ? undefined
      : parseReservation(value.reservation, `${field}.reservation`);
  const endpointValue =
    value.endpoint === undefined ? undefined : endpoint(value.endpoint, `${field}.endpoint`);
  const lastError =
    value.lastError === undefined ? undefined : text(value.lastError, `${field}.lastError`);
  const job = parseJob(value.job, `${field}.job`);
  if (job.kind !== "worker" || job.role !== "presentation") {
    throw new TypeError(`${field}.job must be a presentation worker job`);
  }
  return {
    schemaVersion: 1,
    id: singleLine(value.id, `${field}.id`),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    recordPath: absolutePath(value.recordPath, `${field}.recordPath`),
    ...(operation === undefined ? {} : { operation }),
    ...(operationHistory === undefined ? {} : { operationHistory }),
    ...(reservation === undefined ? {} : { reservation }),
    ...(endpointLaunch === undefined ? {} : { endpointLaunch }),
    job,
    ...(endpointValue === undefined ? {} : { endpoint: endpointValue }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

export function parseRuntimeState(value: unknown, source = "runtime state"): RuntimeState {
  if (!isRecord(value)) throw new TypeError(`${source} must be an object`);
  if (value.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
    throw new TypeError(`${source}.schemaVersion must be ${RUNTIME_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.tasks)) throw new TypeError(`${source}.tasks must be an array`);
  if (!Array.isArray(value.presentations))
    throw new TypeError(`${source}.presentations must be an array`);
  const tasks = value.tasks.map((entry, index) => parseTask(entry, `${source}.tasks[${index}]`));
  const presentations = value.presentations.map((entry, index) =>
    parsePresentation(entry, `${source}.presentations[${index}]`),
  );
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.taskId))
      throw new TypeError(`${source} contains duplicate task ${task.taskId}`);
    taskIds.add(task.taskId);
  }
  const presentationIds = new Set<string>();
  for (const presentation of presentations) {
    if (presentationIds.has(presentation.id)) {
      throw new TypeError(`${source} contains duplicate presentation ${presentation.id}`);
    }
    presentationIds.add(presentation.id);
  }
  return {
    schemaVersion: 1,
    tasks,
    presentations,
  };
}

export function emptyRuntimeState(): RuntimeState {
  return { schemaVersion: 1, tasks: [], presentations: [] };
}
