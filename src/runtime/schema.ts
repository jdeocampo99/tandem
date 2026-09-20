import { isAbsolute, resolve } from "node:path";
import type { GitCheckpoint } from "../adapters/git.ts";
import type {
  Endpoint,
  Finding,
  IsoTimestamp,
  ReviewLens,
  ReviewMode,
  ValidationContractName,
  WorktreeLease,
} from "../contracts.ts";
import { MODEL_ROLE_ORDER } from "../contracts.ts";
import type { EscalationReason } from "../tasks/acceptance.ts";
import type { WorkerRole } from "../workers/jobs.ts";

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

export type DurableOperation = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly kind: DurableOperationKind;
  readonly role: WorkerRole | "validation";
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
  readonly role: WorkerRole | "validation";
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
  readonly reviewLens?: ReviewLens;
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
  readonly recoveryAttempts: number;
  readonly validationRetries: number;
  readonly evidenceRepairs: number;
  readonly lastOperation?: "reconcile" | "validation-retry" | "evidence-repair" | "review-existing";
  readonly lastAt?: IsoTimestamp;
}>;

export type RuntimeTaskState = Readonly<{
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sourceCheckpoint: GitCheckpoint;
  readonly sourceRepoPath?: string;
  readonly taskName: string;
  readonly operation?: DurableOperation;
  readonly operationHistory?: readonly DurableOperation[];
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
    role: enumValue(value.role, MODEL_ROLE_ORDER, `${field}.role`),
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
  const role = enumValue(value.role, MODEL_ROLE_ORDER, `${field}.role`);
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
  const reviewLens =
    value.reviewLens === undefined
      ? undefined
      : enumValue(
          value.reviewLens,
          ["behavior", "design", "coverage", "verification"] as const,
          `${field}.reviewLens`,
        );
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
          const lastOperation =
            value.recovery.lastOperation === undefined
              ? undefined
              : enumValue(
                  value.recovery.lastOperation,
                  ["reconcile", "validation-retry", "evidence-repair", "review-existing"] as const,
                  `${field}.recovery.lastOperation`,
                );
          const lastAt =
            value.recovery.lastAt === undefined
              ? undefined
              : singleLine(value.recovery.lastAt, `${field}.recovery.lastAt`);
          return {
            schemaVersion: 1 as const,
            recoveryAttempts: nonNegativeInteger(
              value.recovery.recoveryAttempts,
              `${field}.recovery.recoveryAttempts`,
            ),
            validationRetries: nonNegativeInteger(
              value.recovery.validationRetries,
              `${field}.recovery.validationRetries`,
            ),
            evidenceRepairs: nonNegativeInteger(
              value.recovery.evidenceRepairs,
              `${field}.recovery.evidenceRepairs`,
            ),
            ...(lastOperation === undefined ? {} : { lastOperation }),
            ...(lastAt === undefined ? {} : { lastAt }),
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
  return { schemaVersion: 1, tasks, presentations };
}

export function emptyRuntimeState(): RuntimeState {
  return { schemaVersion: 1, tasks: [], presentations: [] };
}
