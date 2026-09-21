import {
  type AgentRole,
  type CheckOrigin,
  type Endpoint,
  type Finding,
  type FindingLedgerEntry,
  type FindingObservation,
  type FindingSeverity,
  type FindingVerdict,
  type GuidanceProvenance,
  type InstructionChannel,
  type IterationScope,
  isSafeRequestId,
  LEGACY_EVIDENCE_CONTRACT,
  MAX_RESEARCH_HANDOFF_COUNT,
  MAX_RESEARCH_HANDOFF_EXCERPT_BYTES,
  MAX_RESEARCH_HANDOFF_TOTAL_BYTES,
  MODEL_ROLE_ORDER,
  type ModelSpec,
  type Notification,
  type PullRequestMetadata,
  REVIEW_LEVEL_ORDER,
  type RepoPolicy,
  type ResearchContinuation,
  type ResearchHandoff,
  type ResolvedGuidance,
  type ResolvedPolicy,
  type ReviewLens,
  type ReviewLevel,
  type ReviewLevelAssistance,
  type ReviewLevelPolicy,
  type ReviewLevelRecord,
  type ReviewMode,
  type ReviewResult,
  SAFETY_FLOOR_ORDER,
  type SafetyFloor,
  type SkillInvocation,
  type TaskCleanupState,
  type TaskCleanupStatus,
  type TaskKind,
  type TaskRecord,
  type TaskStage,
  type ValidationCommand,
  type ValidationContractName,
  type ValidationEvidence,
  type WorktreeLease,
} from "../contracts.ts";
import { FINAL_REVIEW_LENSES } from "./acceptance.ts";
import { parseTaskCommunication } from "./communication-protocol.ts";
import { FINDING_STATUSES } from "./findings.ts";
import { isSafeTaskId } from "./lifecycle.ts";
import { checkResearchContinuation, defaultResearchContinuation } from "./research-continuation.ts";
import { DEFAULT_REVIEW_LEVEL_POLICY } from "./review-levels.ts";
import { checkSkillInvocation } from "./skill-invocation.ts";
import { StateCorruptionError, StoreSerializationError } from "./store-errors.ts";

const TASK_STAGES: readonly TaskStage[] = [
  "awaiting-approval",
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
  "ready",
  "paused",
  "blocked",
  "cancelled",
  "completed",
  "merged",
];
const TASK_KINDS: readonly TaskKind[] = ["scout", "implementation"];
const INSTRUCTION_CHANNELS: readonly InstructionChannel[] = [
  "implementation",
  "validation",
  "review",
];
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;
const FINDING_SEVERITIES: readonly FindingSeverity[] = ["P0", "P1", "P2", "P3"];
const FINDING_VERDICTS: readonly FindingVerdict[] = ["confirmed", "plausible"];
const REVIEW_LENSES: readonly ReviewLens[] = FINAL_REVIEW_LENSES;
const VALIDATION_CONTRACT_NAMES: readonly ValidationContractName[] = ["iteration", "final"];
const CHECK_ORIGINS: readonly CheckOrigin[] = ["local", "github"];
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "id",
  "revision",
  "repoPath",
  "requestId",
  "kind",
  "objective",
  "acceptanceCriteria",
  "surfaces",
  "stage",
  "previousStage",
  "scopeApproved",
  "policy",
  "createdAt",
  "updatedAt",
  "worktree",
  "endpoints",
  "generation",
  "reviewRound",
  "reviewHead",
  "iterationScope",
  "reviewLevel",
  "validationEvidence",
  "reviews",
  "findingLedger",
  "researchHandoffs",
  "researchContinuation",
  "skill",
  "reportPath",
  "blockReason",
  "notifications",
  "communication",
  "pullRequest",
  "cleanup",
] as const;
const TASK_CLEANUP_STATUSES: readonly TaskCleanupStatus[] = [
  "released",
  "retained",
  "pending",
  "quarantined",
];
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<Value extends string>(value: unknown, values: readonly Value[]): value is Value {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function failState(source: string, message: string, cause?: unknown): never {
  if (cause instanceof Error) {
    throw new StateCorruptionError(source, message, { cause });
  }
  throw new StateCorruptionError(source, message);
}

function assertExactKeys(record: UnknownRecord, allowed: readonly string[], source: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      failState(source, `unexpected field ${key}`);
    }
  }
}

function requiredValue(record: UnknownRecord, key: string, source: string): unknown {
  if (!Object.hasOwn(record, key)) {
    failState(source, `missing field ${key}`);
  }
  const value = record[key];
  if (value === undefined) {
    failState(source, `field ${key} must not be undefined`);
  }
  return value;
}

function requiredText(record: UnknownRecord, key: string, source: string): string {
  const value = requiredValue(record, key, source);
  if (typeof value !== "string" || value.trim().length === 0) {
    failState(source, `field ${key} must be a non-empty string`);
  }
  return value;
}

function optionalText(record: UnknownRecord, key: string, source: string): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    failState(source, `optional field ${key} must be a non-empty string when present`);
  }
  return value;
}

function requiredInteger(record: UnknownRecord, key: string, source: string, minimum = 0): number {
  const value = requiredValue(record, key, source);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    failState(source, `field ${key} must be an integer >= ${minimum}`);
  }
  return value;
}

function requiredBoolean(record: UnknownRecord, key: string, source: string): boolean {
  const value = requiredValue(record, key, source);
  if (typeof value !== "boolean") {
    failState(source, `field ${key} must be a boolean`);
  }
  return value;
}

function requiredEnum<Value extends string>(
  record: UnknownRecord,
  key: string,
  values: readonly Value[],
  source: string,
): Value {
  const value = requiredValue(record, key, source);
  if (!isOneOf(value, values)) {
    failState(source, `field ${key} has unsupported value ${String(value)}`);
  }
  return value;
}

function requiredTextArray(record: UnknownRecord, key: string, source: string): readonly string[] {
  const value = requiredValue(record, key, source);
  if (!Array.isArray(value)) {
    failState(source, `field ${key} must be an array of non-empty strings`);
  }
  const entries: readonly unknown[] = value;
  if (!entries.every(isNonEmptyText)) {
    failState(source, `field ${key} must be an array of non-empty strings`);
  }
  return entries.filter(isNonEmptyText);
}

function optionalInteger(
  record: UnknownRecord,
  key: string,
  source: string,
  minimum = 0,
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    failState(source, `optional field ${key} must be an integer >= ${minimum} when present`);
  }
  return value;
}

function parseModelSpec(value: unknown, source: string): ModelSpec {
  if (!isRecord(value)) {
    failState(source, "model specification must be an object");
  }
  assertExactKeys(value, ["model", "thinking"], source);
  return {
    model: requiredText(value, "model", source),
    thinking: requiredEnum(value, "thinking", THINKING_LEVELS, source),
  };
}

function parseInstructionChannels(
  value: unknown,
  source: string,
): Readonly<Record<InstructionChannel, readonly string[]>> {
  if (!isRecord(value)) {
    failState(source, "instruction channels must be an object");
  }
  assertExactKeys(value, INSTRUCTION_CHANNELS, source);
  const result: Record<InstructionChannel, readonly string[]> = {
    implementation: requiredTextArray(value, "implementation", `${source}.implementation`),
    validation: requiredTextArray(value, "validation", `${source}.validation`),
    review: requiredTextArray(value, "review", `${source}.review`),
  };
  return result;
}

function parseValidationCommand(value: unknown, source: string): ValidationCommand {
  if (!isRecord(value)) {
    failState(source, "validation command must be an object");
  }
  assertExactKeys(value, ["name", "argv", "surfaces", "timeoutMs"], source);
  const timeoutMs = requiredInteger(value, "timeoutMs", source, 1);
  return {
    name: requiredText(value, "name", source),
    argv: requiredTextArray(value, "argv", source),
    surfaces: requiredTextArray(value, "surfaces", source),
    timeoutMs,
  };
}

function parseRepoPolicy(value: unknown, source: string): RepoPolicy {
  if (!isRecord(value)) {
    failState(source, "policy config must be an object");
  }
  assertExactKeys(
    value,
    [
      "version",
      "models",
      "instructions",
      "instructionFiles",
      "validationCommands",
      "maxWorkers",
      "maxFixRounds",
      "reviewLevels",
    ],
    source,
  );
  const version = requiredInteger(value, "version", source, 1);
  if (version !== 1) {
    failState(source, `unsupported policy version ${version}`);
  }
  const modelsValue = requiredValue(value, "models", source);
  if (!isRecord(modelsValue)) {
    failState(`${source}.models`, "models must be an object");
  }
  assertExactKeys(modelsValue, MODEL_ROLE_ORDER, `${source}.models`);
  const models: Record<AgentRole, ModelSpec> = {
    coordinator: parseModelSpec(
      requiredValue(modelsValue, "coordinator", `${source}.models`),
      `${source}.models.coordinator`,
    ),
    scout: parseModelSpec(
      requiredValue(modelsValue, "scout", `${source}.models`),
      `${source}.models.scout`,
    ),
    implementer: parseModelSpec(
      requiredValue(modelsValue, "implementer", `${source}.models`),
      `${source}.models.implementer`,
    ),
    reviewer: parseModelSpec(
      requiredValue(modelsValue, "reviewer", `${source}.models`),
      `${source}.models.reviewer`,
    ),
    verifier: parseModelSpec(
      requiredValue(modelsValue, "verifier", `${source}.models`),
      `${source}.models.verifier`,
    ),
    presentation: parseModelSpec(
      requiredValue(modelsValue, "presentation", `${source}.models`),
      `${source}.models.presentation`,
    ),
  };
  const validationCommandsValue = requiredValue(value, "validationCommands", source);
  if (!Array.isArray(validationCommandsValue)) {
    failState(`${source}.validationCommands`, "validationCommands must be an array");
  }
  const validationCommands: readonly unknown[] = validationCommandsValue;
  return {
    version: 1,
    models,
    instructions: parseInstructionChannels(
      requiredValue(value, "instructions", source),
      `${source}.instructions`,
    ),
    instructionFiles: parseInstructionChannels(
      requiredValue(value, "instructionFiles", source),
      `${source}.instructionFiles`,
    ),
    validationCommands: validationCommands.map((entry, index) =>
      parseValidationCommand(entry, `${source}.validationCommands[${index}]`),
    ),
    maxWorkers: requiredInteger(value, "maxWorkers", source, 1),
    maxFixRounds: requiredInteger(value, "maxFixRounds", source, 0),
    reviewLevels: parseReviewLevelPolicy(value, `${source}.reviewLevels`),
  };
}

/**
 * Reads the review-level opt-ins from a pinned policy. A record written before review levels
 * existed carries none, and it loads with every opt-in off, which is exactly the review behavior
 * that record was pinned under. A present but malformed section fails closed.
 */
function parseReviewLevelPolicy(record: UnknownRecord, source: string): ReviewLevelPolicy {
  if (!Object.hasOwn(record, "reviewLevels")) return { ...DEFAULT_REVIEW_LEVEL_POLICY };
  const value = requiredValue(record, "reviewLevels", source);
  if (!isRecord(value)) {
    failState(source, "reviewLevels must be an object");
  }
  assertExactKeys(
    value,
    ["reducedRouting", "deepScrutiny", "jevAssistance", "sourceTransmission"],
    source,
  );
  return {
    reducedRouting: requiredBoolean(value, "reducedRouting", source),
    deepScrutiny: requiredBoolean(value, "deepScrutiny", source),
    jevAssistance: requiredEnum(value, "jevAssistance", ["off", "shadow"] as const, source),
    sourceTransmission: requiredBoolean(value, "sourceTransmission", source),
  };
}

function parseGuidance(
  value: unknown,
  source: string,
): Readonly<Record<InstructionChannel, readonly ResolvedGuidance[]>> {
  if (!isRecord(value)) {
    failState(source, "guidance must be an object");
  }
  assertExactKeys(value, INSTRUCTION_CHANNELS, source);
  const result: Record<InstructionChannel, readonly ResolvedGuidance[]> = {
    implementation: parseGuidanceEntries(
      requiredValue(value, "implementation", source),
      `${source}.implementation`,
    ),
    validation: parseGuidanceEntries(
      requiredValue(value, "validation", source),
      `${source}.validation`,
    ),
    review: parseGuidanceEntries(requiredValue(value, "review", source), `${source}.review`),
  };
  return result;
}
function parseGuidanceEntries(value: unknown, source: string): readonly ResolvedGuidance[] {
  if (!Array.isArray(value)) {
    failState(source, "guidance entries must be an array");
  }
  const entries: readonly unknown[] = value;
  return entries.map((entry, index) => {
    const entrySource = `${source}[${index}]`;
    if (!isRecord(entry)) {
      failState(entrySource, "guidance entry must be an object");
    }
    assertExactKeys(entry, ["text", "provenance"], entrySource);
    const provenanceValue = requiredValue(entry, "provenance", entrySource);
    if (!isRecord(provenanceValue)) {
      failState(`${entrySource}.provenance`, "provenance must be an object");
    }
    assertExactKeys(provenanceValue, ["channel", "source"], `${entrySource}.provenance`);
    const channel = requiredEnum(
      provenanceValue,
      "channel",
      INSTRUCTION_CHANNELS,
      `${entrySource}.provenance`,
    );
    return {
      text: requiredText(entry, "text", entrySource),
      provenance: {
        channel,
        source: requiredText(provenanceValue, "source", `${entrySource}.provenance`),
      } satisfies GuidanceProvenance,
    } satisfies ResolvedGuidance;
  });
}

function parseResolvedPolicy(value: unknown, source: string): ResolvedPolicy {
  if (!isRecord(value)) {
    failState(source, "resolved policy must be an object");
  }
  assertExactKeys(value, ["config", "guidance"], source);
  return {
    config: parseRepoPolicy(requiredValue(value, "config", source), `${source}.config`),
    guidance: parseGuidance(requiredValue(value, "guidance", source), `${source}.guidance`),
  };
}

export function parseWorktree(value: unknown, source: string): WorktreeLease {
  if (!isRecord(value)) {
    failState(source, "worktree must be an object");
  }
  assertExactKeys(
    value,
    ["root", "path", "name", "baseHead", "branch", "leaseId", "leaseHolder", "leasedAt"],
    source,
  );
  return {
    root: requiredText(value, "root", source),
    path: requiredText(value, "path", source),
    name: requiredText(value, "name", source),
    baseHead: requiredText(value, "baseHead", source),
    branch: requiredText(value, "branch", source),
    leaseId: requiredText(value, "leaseId", source),
    leaseHolder: requiredText(value, "leaseHolder", source),
    leasedAt: requiredText(value, "leasedAt", source),
  };
}

function parseEndpoint(value: unknown, source: string): Endpoint {
  if (!isRecord(value)) {
    failState(source, "endpoint must be an object");
  }
  assertExactKeys(
    value,
    ["sessionId", "workspaceId", "tabId", "paneId", "role", "generation"],
    source,
  );
  return {
    sessionId: requiredText(value, "sessionId", source),
    workspaceId: requiredText(value, "workspaceId", source),
    tabId: requiredText(value, "tabId", source),
    paneId: requiredText(value, "paneId", source),
    role: requiredEnum(value, "role", MODEL_ROLE_ORDER, source),
    generation: requiredInteger(value, "generation", source),
  };
}

function parseFinding(value: unknown, source: string): Finding {
  if (!isRecord(value)) {
    failState(source, "finding must be an object");
  }
  assertExactKeys(value, ["id", "severity", "verdict", "file", "line", "description"], source);
  const file = optionalText(value, "file", source);
  const line = optionalInteger(value, "line", source, 1);
  return {
    id: requiredText(value, "id", source),
    severity: requiredEnum(value, "severity", FINDING_SEVERITIES, source),
    verdict: requiredEnum(value, "verdict", FINDING_VERDICTS, source),
    description: requiredText(value, "description", source),
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
  };
}

export function parseReview(value: unknown, source: string): ReviewResult {
  if (!isRecord(value)) {
    failState(source, "review must be an object");
  }
  assertExactKeys(
    value,
    ["lens", "head", "generation", "pass", "findings", "summary", "mode"],
    source,
  );
  const findingsValue = requiredValue(value, "findings", source);
  if (!Array.isArray(findingsValue)) {
    failState(`${source}.findings`, "findings must be an array");
  }
  const findings: readonly unknown[] = findingsValue;
  const mode = optionalText(value, "mode", source);
  if (mode !== undefined && mode !== "review_changed_diff" && mode !== "review_existing_head") {
    failState(`${source}.mode`, `unsupported review mode ${mode}`);
  }
  return {
    lens: requiredEnum(value, "lens", REVIEW_LENSES, source),
    head: requiredText(value, "head", source),
    generation: requiredInteger(value, "generation", source),
    pass: requiredBoolean(value, "pass", source),
    findings: findings.map((entry, index) => parseFinding(entry, `${source}.findings[${index}]`)),
    summary: requiredText(value, "summary", source),
    ...(mode === undefined ? {} : { mode: mode as ReviewMode }),
  };
}

/**
 * Records written before validation contracts existed carry none of `contract`, `origin`, or
 * `policyDigest`. Those load unchanged and are marked legacy, which no contract accepts, so the
 * candidate must run the complete final manifest again. A record carrying only some of the three
 * is a corrupt shape rather than a recoverable one, and fails closed.
 */
export function parseValidationEvidence(value: unknown, source: string): ValidationEvidence {
  if (!isRecord(value)) {
    failState(source, "validation evidence must be an object");
  }
  assertExactKeys(
    value,
    ["name", "argv", "exitCode", "stdout", "stderr", "head", "contract", "origin", "policyDigest"],
    source,
  );
  const stdout = requiredValue(value, "stdout", source);
  const stderr = requiredValue(value, "stderr", source);
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    failState(source, "stdout and stderr must be strings");
  }
  const recorded = {
    name: requiredText(value, "name", source),
    argv: requiredTextArray(value, "argv", source),
    exitCode: requiredInteger(value, "exitCode", source),
    stdout,
    stderr,
    head: requiredText(value, "head", source),
  };

  const pinningKeys = ["contract", "origin", "policyDigest"] as const;
  const present = pinningKeys.filter((key) => Object.hasOwn(value, key));
  if (present.length === 0) {
    return { ...recorded, contract: LEGACY_EVIDENCE_CONTRACT };
  }
  if (value.contract === LEGACY_EVIDENCE_CONTRACT) {
    if (present.length !== 1) {
      failState(source, "legacy validation evidence must not carry an origin or policy digest");
    }
    return { ...recorded, contract: LEGACY_EVIDENCE_CONTRACT };
  }
  if (present.length !== pinningKeys.length) {
    failState(
      source,
      `validation evidence must name its contract, origin, and policy digest together; missing ${pinningKeys
        .filter((key) => !present.includes(key))
        .join(", ")}`,
    );
  }
  return {
    ...recorded,
    contract: requiredEnum(value, "contract", VALIDATION_CONTRACT_NAMES, source),
    origin: requiredEnum(value, "origin", CHECK_ORIGINS, source),
    policyDigest: requiredText(value, "policyDigest", source),
  };
}

function parseFindingObservation(value: unknown, source: string): FindingObservation {
  if (!isRecord(value)) {
    failState(source, "finding observation must be an object");
  }
  assertExactKeys(value, ["head", "generation", "reviewRound"], source);
  return {
    head: requiredText(value, "head", source),
    generation: requiredInteger(value, "generation", source),
    reviewRound: requiredInteger(value, "reviewRound", source),
  };
}

function parseFindingLedgerEntry(value: unknown, source: string): FindingLedgerEntry {
  if (!isRecord(value)) {
    failState(source, "finding ledger entry must be an object");
  }
  assertExactKeys(
    value,
    [
      "id",
      "lens",
      "severity",
      "verdict",
      "description",
      "file",
      "line",
      "status",
      "raisedAt",
      "statusAt",
    ],
    source,
  );
  const file = optionalText(value, "file", source);
  const line = optionalInteger(value, "line", source, 1);
  return {
    id: requiredText(value, "id", source),
    lens: requiredEnum(value, "lens", REVIEW_LENSES, source),
    severity: requiredEnum(value, "severity", FINDING_SEVERITIES, source),
    verdict: requiredEnum(value, "verdict", FINDING_VERDICTS, source),
    description: requiredText(value, "description", source),
    status: requiredEnum(value, "status", FINDING_STATUSES, source),
    raisedAt: parseFindingObservation(
      requiredValue(value, "raisedAt", source),
      `${source}.raisedAt`,
    ),
    statusAt: parseFindingObservation(
      requiredValue(value, "statusAt", source),
      `${source}.statusAt`,
    ),
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
  };
}

function parseIterationScope(value: unknown, source: string): IterationScope {
  if (!isRecord(value)) {
    failState(source, "iteration scope must be an object");
  }
  assertExactKeys(
    value,
    ["head", "generation", "policyDigest", "reproduces", "surfaces", "findingIds"],
    source,
  );
  return {
    head: requiredText(value, "head", source),
    generation: requiredInteger(value, "generation", source),
    policyDigest: requiredText(value, "policyDigest", source),
    reproduces: requiredTextArray(value, "reproduces", source),
    surfaces: requiredTextArray(value, "surfaces", source),
    findingIds: requiredTextArray(value, "findingIds", source),
  };
}

function parseReviewLevelAssistance(value: unknown, source: string): ReviewLevelAssistance {
  if (!isRecord(value)) {
    failState(source, "review level assistance must be an object");
  }
  assertExactKeys(
    value,
    ["mode", "recommendation", "reason", "requestIdentity", "resultIdentity"],
    source,
  );
  const recommendation = requiredText(value, "recommendation", source);
  if (
    recommendation !== "unavailable" &&
    !REVIEW_LEVEL_ORDER.includes(recommendation as ReviewLevel)
  ) {
    failState(source, `unsupported assistance recommendation ${recommendation}`);
  }
  return {
    mode: requiredEnum(value, "mode", ["shadow"] as const, source),
    recommendation: recommendation as ReviewLevel | "unavailable",
    reason: requiredText(value, "reason", source),
    requestIdentity: requiredText(value, "requestIdentity", source),
    resultIdentity: requiredText(value, "resultIdentity", source),
  };
}

/** Parses a recorded classification. A present section must be complete and well formed. */
function parseReviewLevelRecord(value: unknown, source: string): ReviewLevelRecord {
  if (!isRecord(value)) {
    failState(source, "review level must be an object");
  }
  assertExactKeys(value, ["level", "reason", "floors", "assistance"], source);
  const floors = requiredTextArray(value, "floors", source);
  for (const floor of floors) {
    if (!SAFETY_FLOOR_ORDER.includes(floor as SafetyFloor)) {
      failState(source, `unsupported safety floor ${floor}`);
    }
  }
  const assistanceValue = Object.hasOwn(value, "assistance")
    ? requiredValue(value, "assistance", source)
    : undefined;
  return {
    level: requiredEnum(value, "level", REVIEW_LEVEL_ORDER, source),
    reason: requiredText(value, "reason", source),
    floors: floors as readonly SafetyFloor[],
    ...(assistanceValue === undefined
      ? {}
      : {
          assistance: parseReviewLevelAssistance(assistanceValue, `${source}.assistance`),
        }),
  };
}

export function parseNotification(value: unknown, source: string): Notification {
  if (!isRecord(value)) {
    failState(source, "notification must be an object");
  }
  assertExactKeys(value, ["id", "message", "acknowledged", "kind"], source);
  const kind =
    value.kind === undefined
      ? undefined
      : requiredEnum(value, "kind", ["routine", "coordinator"] as const, source);
  return {
    id: requiredText(value, "id", source),
    message: requiredText(value, "message", source),
    acknowledged: requiredBoolean(value, "acknowledged", source),
    ...(kind === undefined ? {} : { kind }),
  };
}

export function parsePullRequest(value: unknown, source: string): PullRequestMetadata {
  if (!isRecord(value)) {
    failState(source, "pull request metadata must be an object");
  }
  assertExactKeys(value, ["repository", "number", "url", "title", "state", "head", "base"], source);
  const url = optionalText(value, "url", source);
  const title = optionalText(value, "title", source);
  return {
    repository: requiredText(value, "repository", source),
    number: requiredInteger(value, "number", source, 1),
    state: requiredEnum(value, "state", ["draft", "open", "closed", "merged"], source),
    head: requiredText(value, "head", source),
    base: requiredText(value, "base", source),
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
  };
}
/**
 * Reads the cleanup note written by a newer build. Records written before cleanup notes existed
 * simply omit the field and load unchanged; a present-but-malformed note is state corruption and
 * fails the read rather than being coerced into a plausible-looking status.
 */
function parseTaskCleanup(value: unknown, source: string): TaskCleanupState {
  if (!isRecord(value)) {
    failState(source, "cleanup state must be an object");
  }
  assertExactKeys(value, ["schemaVersion", "status", "reason", "observedAt"], source);
  const schemaVersion = requiredInteger(value, "schemaVersion", source, 1);
  if (schemaVersion !== 1) {
    failState(source, `unsupported cleanup schemaVersion ${schemaVersion}`);
  }
  return {
    schemaVersion: 1,
    status: requiredEnum(value, "status", TASK_CLEANUP_STATUSES, source),
    reason: requiredText(value, "reason", source),
    observedAt: requiredText(value, "observedAt", source),
  };
}

function parseResearchHandoff(value: unknown, source: string): ResearchHandoff {
  if (!isRecord(value)) failState(source, "research handoff must be an object");
  assertExactKeys(
    value,
    [
      "scoutTaskId",
      "scoutRepoPath",
      "scoutSourceHead",
      "scoutSourceBase",
      "reportPath",
      "reportDigest",
      "excerpt",
    ],
    source,
  );
  const excerpt = requiredText(value, "excerpt", source);
  const excerptBytes = Buffer.byteLength(excerpt, "utf8");
  if (excerptBytes > MAX_RESEARCH_HANDOFF_EXCERPT_BYTES) {
    failState(source, `excerpt exceeds ${MAX_RESEARCH_HANDOFF_EXCERPT_BYTES} UTF-8 bytes`);
  }
  const reportDigest = requiredText(value, "reportDigest", source);
  if (!/^[a-f0-9]{64}$/u.test(reportDigest)) {
    failState(source, "reportDigest must be a lowercase SHA-256 digest");
  }
  return {
    scoutTaskId: requiredText(value, "scoutTaskId", source),
    scoutRepoPath: requiredText(value, "scoutRepoPath", source),
    scoutSourceHead: requiredText(value, "scoutSourceHead", source),
    scoutSourceBase: requiredText(value, "scoutSourceBase", source),
    reportPath: requiredText(value, "reportPath", source),
    reportDigest,
    excerpt,
  };
}

function parseSkillInvocation(value: unknown, source: string): SkillInvocation {
  const check = checkSkillInvocation(value);
  if (!check.valid) failState(source, check.defect);
  return check.invocation;
}

/**
 * Scout records carry a durable post-research disposition. Records written before the field
 * existed load with the conservative default; anything else present is rejected rather than
 * repaired, and non-scout records may never carry one.
 */
function parseResearchContinuation(
  value: UnknownRecord,
  kind: TaskKind,
  source: string,
): ResearchContinuation | undefined {
  const present = Object.hasOwn(value, "researchContinuation");
  if (kind !== "scout") {
    if (present) {
      failState(source, "only scout tasks may record a research continuation disposition");
    }
    return undefined;
  }
  if (!present) return defaultResearchContinuation();
  const check = checkResearchContinuation(value.researchContinuation);
  if (!check.valid) failState(`${source}.researchContinuation`, check.defect);
  return check.continuation;
}

export function parseTaskRecord(value: unknown, source = "task record"): TaskRecord {
  if (!isRecord(value)) {
    failState(source, "task record must be an object");
  }
  assertExactKeys(value, TOP_LEVEL_KEYS, source);
  const researchHandoffsValue = Object.hasOwn(value, "researchHandoffs")
    ? requiredValue(value, "researchHandoffs", source)
    : undefined;
  if (
    researchHandoffsValue !== undefined &&
    (!Array.isArray(researchHandoffsValue) ||
      researchHandoffsValue.length > MAX_RESEARCH_HANDOFF_COUNT)
  ) {
    failState(
      source,
      `researchHandoffs must be an array with at most ${MAX_RESEARCH_HANDOFF_COUNT} entries`,
    );
  }
  const researchHandoffEntries: readonly unknown[] =
    researchHandoffsValue === undefined ? [] : researchHandoffsValue;
  const totalResearchBytes = researchHandoffEntries.reduce<number>(
    (total, entry) =>
      total +
      (isRecord(entry) && typeof entry.excerpt === "string"
        ? Buffer.byteLength(entry.excerpt, "utf8")
        : 0),
    0,
  );
  if (totalResearchBytes > MAX_RESEARCH_HANDOFF_TOTAL_BYTES) {
    failState(source, `researchHandoffs exceed ${MAX_RESEARCH_HANDOFF_TOTAL_BYTES} UTF-8 bytes`);
  }
  const endpointsValue = Object.hasOwn(value, "endpoints")
    ? requiredValue(value, "endpoints", source)
    : undefined;
  const validationEvidenceValue = requiredValue(value, "validationEvidence", source);
  const reviewsValue = requiredValue(value, "reviews", source);
  const notificationsValue = requiredValue(value, "notifications", source);
  if (endpointsValue !== undefined && !Array.isArray(endpointsValue)) {
    failState(`${source}.endpoints`, "endpoints must be an array when present");
  }
  if (
    !Array.isArray(validationEvidenceValue) ||
    !Array.isArray(reviewsValue) ||
    !Array.isArray(notificationsValue)
  ) {
    failState(source, "validationEvidence, reviews, and notifications must be arrays");
  }
  const validationEntries: readonly unknown[] = validationEvidenceValue;
  const reviewEntries: readonly unknown[] = reviewsValue;
  const notificationEntries: readonly unknown[] = notificationsValue;
  const endpointEntries: readonly unknown[] = endpointsValue === undefined ? [] : endpointsValue;
  const schemaVersion = requiredInteger(value, "schemaVersion", source, 1);
  if (schemaVersion !== 1) {
    failState(source, `unsupported schemaVersion ${schemaVersion}`);
  }
  const id = requiredText(value, "id", source);
  if (!isSafeTaskId(id)) {
    failState(source, `unsafe task id ${id}`);
  }
  const requestId = optionalText(value, "requestId", source);
  if (requestId !== undefined && !isSafeRequestId(requestId)) {
    failState(source, `unsafe request id ${requestId}`);
  }
  const previousStage = optionalText(value, "previousStage", source);
  if (previousStage !== undefined && !isOneOf(previousStage, TASK_STAGES)) {
    failState(source, `unsupported previousStage ${previousStage}`);
  }
  const reportPath = optionalText(value, "reportPath", source);
  const blockReason = optionalText(value, "blockReason", source);
  const communicationValue = Object.hasOwn(value, "communication")
    ? requiredValue(value, "communication", source)
    : undefined;
  let communication: TaskRecord["communication"] | undefined;
  if (communicationValue !== undefined) {
    try {
      communication = parseTaskCommunication(communicationValue);
    } catch (error) {
      failState(`${source}.communication`, error instanceof Error ? error.message : String(error));
    }
  }
  const findingLedgerValue = Object.hasOwn(value, "findingLedger")
    ? requiredValue(value, "findingLedger", source)
    : undefined;
  if (findingLedgerValue !== undefined && !Array.isArray(findingLedgerValue)) {
    failState(`${source}.findingLedger`, "findingLedger must be an array when present");
  }
  const findingLedgerEntries: readonly unknown[] =
    findingLedgerValue === undefined ? [] : findingLedgerValue;
  const reviewHead = optionalText(value, "reviewHead", source);
  const iterationScopeValue = Object.hasOwn(value, "iterationScope")
    ? requiredValue(value, "iterationScope", source)
    : undefined;
  const reviewLevelValue = Object.hasOwn(value, "reviewLevel")
    ? requiredValue(value, "reviewLevel", source)
    : undefined;
  const pullRequestValue = Object.hasOwn(value, "pullRequest")
    ? requiredValue(value, "pullRequest", source)
    : undefined;
  const worktreeValue = Object.hasOwn(value, "worktree")
    ? requiredValue(value, "worktree", source)
    : undefined;
  const cleanupValue = Object.hasOwn(value, "cleanup")
    ? requiredValue(value, "cleanup", source)
    : undefined;
  const skillValue = Object.hasOwn(value, "skill")
    ? requiredValue(value, "skill", source)
    : undefined;
  const kind = requiredEnum(value, "kind", TASK_KINDS, source);
  const researchContinuation = parseResearchContinuation(value, kind, source);
  const taskBase = {
    schemaVersion: 1 as const,
    id,
    revision: requiredInteger(value, "revision", source),
    repoPath: requiredText(value, "repoPath", source),
    ...(requestId === undefined ? {} : { requestId }),
    kind,
    objective: requiredText(value, "objective", source),
    acceptanceCriteria: requiredTextArray(value, "acceptanceCriteria", source),
    surfaces: requiredTextArray(value, "surfaces", source),
    stage: requiredEnum(value, "stage", TASK_STAGES, source),
    scopeApproved: requiredBoolean(value, "scopeApproved", source),
    policy: parseResolvedPolicy(requiredValue(value, "policy", source), `${source}.policy`),
    createdAt: requiredText(value, "createdAt", source),
    updatedAt: requiredText(value, "updatedAt", source),
    generation: requiredInteger(value, "generation", source),
    reviewRound: requiredInteger(value, "reviewRound", source),
    validationEvidence: validationEntries.map((entry, index) =>
      parseValidationEvidence(entry, `${source}.validationEvidence[${index}]`),
    ),
    reviews: reviewEntries.map((entry, index) => parseReview(entry, `${source}.reviews[${index}]`)),
    ...(findingLedgerValue === undefined
      ? {}
      : {
          findingLedger: findingLedgerEntries.map((entry, index) =>
            parseFindingLedgerEntry(entry, `${source}.findingLedger[${index}]`),
          ),
        }),
    notifications: notificationEntries.map((entry, index) =>
      parseNotification(entry, `${source}.notifications[${index}]`),
    ),
    ...(researchHandoffsValue === undefined
      ? {}
      : {
          researchHandoffs: researchHandoffEntries.map((entry, index) =>
            parseResearchHandoff(entry, `${source}.researchHandoffs[${index}]`),
          ),
        }),
    ...(researchContinuation === undefined ? {} : { researchContinuation }),
    ...(skillValue === undefined
      ? {}
      : { skill: parseSkillInvocation(skillValue, `${source}.skill`) }),
  };
  return {
    ...taskBase,
    ...(previousStage === undefined ? {} : { previousStage }),
    ...(worktreeValue === undefined
      ? {}
      : { worktree: parseWorktree(worktreeValue, `${source}.worktree`) }),
    ...(endpointEntries.length === 0 && endpointsValue === undefined
      ? {}
      : {
          endpoints: endpointEntries.map((entry, index) =>
            parseEndpoint(entry, `${source}.endpoints[${index}]`),
          ),
        }),
    ...(reviewHead === undefined ? {} : { reviewHead }),
    ...(iterationScopeValue === undefined
      ? {}
      : {
          iterationScope: parseIterationScope(iterationScopeValue, `${source}.iterationScope`),
        }),
    ...(reviewLevelValue === undefined
      ? {}
      : { reviewLevel: parseReviewLevelRecord(reviewLevelValue, `${source}.reviewLevel`) }),
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(blockReason === undefined ? {} : { blockReason }),
    ...(communication === undefined ? {} : { communication }),
    ...(pullRequestValue === undefined
      ? {}
      : { pullRequest: parsePullRequest(pullRequestValue, `${source}.pullRequest`) }),
    ...(cleanupValue === undefined
      ? {}
      : { cleanup: parseTaskCleanup(cleanupValue, `${source}.cleanup`) }),
  };
}

export function serializeTaskRecord(task: TaskRecord): string {
  const parsed = parseTaskRecord(task);
  try {
    return `${JSON.stringify(parsed)}\n`;
  } catch (error) {
    throw new StoreSerializationError("Could not serialize task record", { cause: error });
  }
}
