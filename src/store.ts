import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskCommunication } from "./communication.ts";
import type {
  AgentRole,
  Clock,
  Endpoint,
  Finding,
  FindingSeverity,
  FindingVerdict,
  GuidanceProvenance,
  IdFactory,
  InstructionChannel,
  ModelSpec,
  Notification,
  PullRequestMetadata,
  RepoPolicy,
  ResolvedGuidance,
  ResolvedPolicy,
  ReviewLens,
  ReviewResult,
  TaskKind,
  TaskRecord,
  TaskStage,
  ValidationCommand,
  ValidationEvidence,
  WorktreeLease,
} from "./contracts.ts";
import {
  createTask,
  isSafeTaskId,
  type TaskEvent,
  type TaskInput,
  type TaskTransitionContext,
  transitionTask,
} from "./lifecycle.ts";

export type StoreTaskInput = Readonly<Omit<TaskInput, "id"> & { readonly id?: string }>;
export type TaskTransform = (task: TaskRecord) => TaskRecord | PromiseLike<TaskRecord>;
/** Methods received by exclusive run under one repository lock; do not call a parent store method from the callback. */

export type TaskStoreTransaction = Readonly<{
  readonly create: (input: StoreTaskInput) => Promise<TaskRecord>;
  readonly read: (id: string) => Promise<TaskRecord | undefined>;
  readonly list: () => Promise<readonly TaskRecord[]>;
  readonly update: (
    id: string,
    expectedRevision: number,
    transform: TaskTransform,
  ) => Promise<TaskRecord>;
}>;

export type TaskStore = TaskStoreTransaction &
  Readonly<{
    readonly exclusive: <Result>(
      operation: (store: TaskStoreTransaction) => Result | PromiseLike<Result>,
    ) => Promise<Result>;
  }>;

export type TaskStoreOptions = Readonly<{
  readonly directory: string;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly lockTimeoutMs?: number;
  readonly lockPollMs?: number;
}>;

export type TaskStoreErrorCode =
  | "invalid-options"
  | "unsafe-task-id"
  | "task-not-found"
  | "task-already-exists"
  | "state-corruption"
  | "stale-revision"
  | "invalid-mutation"
  | "serialization-failure"
  | "lock-timeout"
  | "lock-corruption"
  | "filesystem-failure";

export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;

  constructor(code: TaskStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

export class UnsafeTaskIdError extends TaskStoreError {
  constructor(id: unknown) {
    super("unsafe-task-id", `Unsafe task id: ${String(id)}`);
    this.name = "UnsafeTaskIdError";
  }
}

export class TaskNotFoundError extends TaskStoreError {
  constructor(id: string) {
    super("task-not-found", `Task ${id} does not exist`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskAlreadyExistsError extends TaskStoreError {
  constructor(id: string) {
    super("task-already-exists", `Task ${id} already exists`);
    this.name = "TaskAlreadyExistsError";
  }
}

export class StateCorruptionError extends TaskStoreError {
  readonly source: string;

  constructor(source: string, message: string, options?: ErrorOptions) {
    super("state-corruption", `${source}: ${message}`, options);
    this.name = "StateCorruptionError";
    this.source = source;
  }
}

export class StaleTaskRevisionError extends TaskStoreError {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(taskId: string, expectedRevision: number, actualRevision: number) {
    super(
      "stale-revision",
      `Task ${taskId} revision ${actualRevision} does not match expected ${expectedRevision}`,
    );
    this.name = "StaleTaskRevisionError";
    this.taskId = taskId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class InvalidTaskMutationError extends TaskStoreError {
  constructor(message: string) {
    super("invalid-mutation", message);
    this.name = "InvalidTaskMutationError";
  }
}

export class StoreSerializationError extends TaskStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("serialization-failure", message, options);
    this.name = "StoreSerializationError";
  }
}

export class StoreLockTimeoutError extends TaskStoreError {
  constructor(directory: string, timeoutMs: number) {
    super(
      "lock-timeout",
      `Could not acquire repository lock for ${directory} within ${timeoutMs}ms`,
    );
    this.name = "StoreLockTimeoutError";
  }
}

export class StoreLockError extends TaskStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("lock-corruption", message, options);
    this.name = "StoreLockError";
  }
}

export class StoreFilesystemError extends TaskStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("filesystem-failure", message, options);
    this.name = "StoreFilesystemError";
  }
}

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
const AGENT_ROLES: readonly AgentRole[] = [
  "coordinator",
  "scout",
  "implementer",
  "reviewer",
  "verifier",
  "presentation",
];
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
const REVIEW_LENSES: readonly ReviewLens[] = ["behavior", "design", "coverage", "verification"];
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "id",
  "revision",
  "repoPath",
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
  "validationEvidence",
  "reviews",
  "reportPath",
  "blockReason",
  "notifications",
  "communication",
  "pullRequest",
] as const;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 20;
// Bun omits Darwin's open(2) lock flags from fs.constants; values mirror fcntl.h.
const DARWIN_O_RDWR = 0x0002;
const DARWIN_O_NONBLOCK = 0x0004;
const DARWIN_O_EXLOCK = 0x0020;
const DARWIN_O_NOFOLLOW = 0x0100;
const DARWIN_O_CREAT = 0x0200;
const LOCK_FLAGS =
  DARWIN_O_RDWR | DARWIN_O_NONBLOCK | DARWIN_O_EXLOCK | DARWIN_O_NOFOLLOW | DARWIN_O_CREAT;

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
  assertExactKeys(modelsValue, AGENT_ROLES, `${source}.models`);
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

function parseWorktree(value: unknown, source: string): WorktreeLease {
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
    role: requiredEnum(value, "role", AGENT_ROLES, source),
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

function parseReview(value: unknown, source: string): ReviewResult {
  if (!isRecord(value)) {
    failState(source, "review must be an object");
  }
  assertExactKeys(value, ["lens", "head", "generation", "pass", "findings", "summary"], source);
  const findingsValue = requiredValue(value, "findings", source);
  if (!Array.isArray(findingsValue)) {
    failState(`${source}.findings`, "findings must be an array");
  }
  const findings: readonly unknown[] = findingsValue;
  return {
    lens: requiredEnum(value, "lens", REVIEW_LENSES, source),
    head: requiredText(value, "head", source),
    generation: requiredInteger(value, "generation", source),
    pass: requiredBoolean(value, "pass", source),
    findings: findings.map((entry, index) => parseFinding(entry, `${source}.findings[${index}]`)),
    summary: requiredText(value, "summary", source),
  };
}

function parseValidationEvidence(value: unknown, source: string): ValidationEvidence {
  if (!isRecord(value)) {
    failState(source, "validation evidence must be an object");
  }
  assertExactKeys(value, ["name", "argv", "exitCode", "stdout", "stderr", "head"], source);
  const stdout = requiredValue(value, "stdout", source);
  const stderr = requiredValue(value, "stderr", source);
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    failState(source, "stdout and stderr must be strings");
  }
  return {
    name: requiredText(value, "name", source),
    argv: requiredTextArray(value, "argv", source),
    exitCode: requiredInteger(value, "exitCode", source),
    stdout,
    stderr,
    head: requiredText(value, "head", source),
  };
}

function parseNotification(value: unknown, source: string): Notification {
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

function parsePullRequest(value: unknown, source: string): PullRequestMetadata {
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

export function parseTaskRecord(value: unknown, source = "task record"): TaskRecord {
  if (!isRecord(value)) {
    failState(source, "task record must be an object");
  }
  assertExactKeys(value, TOP_LEVEL_KEYS, source);
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
  const reviewHead = optionalText(value, "reviewHead", source);
  const pullRequestValue = Object.hasOwn(value, "pullRequest")
    ? requiredValue(value, "pullRequest", source)
    : undefined;
  const worktreeValue = Object.hasOwn(value, "worktree")
    ? requiredValue(value, "worktree", source)
    : undefined;
  const taskBase = {
    schemaVersion: 1 as const,
    id,
    revision: requiredInteger(value, "revision", source),
    repoPath: requiredText(value, "repoPath", source),
    kind: requiredEnum(value, "kind", TASK_KINDS, source),
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
    notifications: notificationEntries.map((entry, index) =>
      parseNotification(entry, `${source}.notifications[${index}]`),
    ),
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
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(blockReason === undefined ? {} : { blockReason }),
    ...(communication === undefined ? {} : { communication }),
    ...(pullRequestValue === undefined
      ? {}
      : { pullRequest: parsePullRequest(pullRequestValue, `${source}.pullRequest`) }),
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

function ensureSafeId(id: unknown): asserts id is string {
  if (!isSafeTaskId(id)) {
    throw new UnsafeTaskIdError(id);
  }
}

function ensureStoreOptions(options: TaskStoreOptions): { timeoutMs: number; pollMs: number } {
  if (!options || typeof options.directory !== "string" || options.directory.trim().length === 0) {
    throw new TaskStoreError("invalid-options", "Task store directory must be a non-empty string");
  }
  if (typeof options.clock !== "function" || typeof options.idFactory !== "function") {
    throw new TaskStoreError(
      "invalid-options",
      "Task store requires clock and idFactory functions",
    );
  }
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs <= 0
  ) {
    throw new TaskStoreError(
      "invalid-options",
      "Lock timeout and poll intervals must be positive integers",
    );
  }
  return { timeoutMs, pollMs };
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } catch (error) {
    throw new StoreFilesystemError(`Could not prepare task store directory ${directory}`, {
      cause: error,
    });
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function taskPath(directory: string, id: string): string {
  return join(directory, `${id}.json`);
}

function lockPath(directory: string): string {
  return join(directory, ".lock");
}

function assertNativeRepositoryLock(): void {
  if (process.platform !== "darwin") {
    throw new StoreLockError("Repository locks require Darwin O_EXLOCK support");
  }
}

function isLockBusy(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pauseFor(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export async function acquireDarwinFileLock(
  path: string,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  assertNativeRepositoryLock();
  const assertNotAborted = (): void => {
    if (signal?.aborted) {
      throw new StoreLockError(`Repository lock ${path} acquisition was aborted`, {
        cause: signal.reason,
      });
    }
  };
  assertNotAborted();
  const startedAt = Date.now();
  while (true) {
    assertNotAborted();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, LOCK_FLAGS, 0o600);
      const lockStat = await handle.stat();
      if (!lockStat.isFile()) {
        throw new StoreLockError(`Repository lock ${path} is not a regular file`);
      }
      const pathStat = await lstat(path);
      if (!sameFile(pathStat, lockStat)) {
        throw new StoreLockError(`Repository lock ${path} changed during acquisition`);
      }
      await handle.chmod(0o600);
      const lease = handle;
      handle = undefined;
      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          const currentStat = await lstat(path);
          const ownerStat = await lease.stat();
          if (!sameFile(currentStat, ownerStat)) {
            throw new StoreLockError(`Repository lock ${path} changed before release`);
          }
        } finally {
          await lease.close();
        }
      };
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (error instanceof StoreLockError) {
        throw error;
      }
      if (!isLockBusy(error)) {
        throw new StoreLockError(`Could not acquire repository lock ${path}`, { cause: error });
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new StoreLockTimeoutError(path, timeoutMs);
      }
      assertNotAborted();
      await pauseFor(pollMs);
    }
  }
}

async function acquireRepositoryLock(
  directory: string,
  timeoutMs: number,
  pollMs: number,
): Promise<() => Promise<void>> {
  return acquireDarwinFileLock(lockPath(directory), timeoutMs, pollMs);
}

async function writeTaskAtomically(directory: string, task: TaskRecord): Promise<void> {
  const id = task.id;
  const destination = taskPath(directory, id);
  const temporary = join(directory, `.task-${process.pid}-${randomUUID()}.tmp`);
  const serialized = serializeTaskRecord(task);
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (temporaryCreated) {
      await unlink(temporary).catch(() => undefined);
    }
    if (error instanceof TaskStoreError) {
      throw error;
    }
    throw new StoreFilesystemError(`Could not atomically write task ${id}`, { cause: error });
  }
}

async function readTaskUnlocked(directory: string, id: string): Promise<TaskRecord | undefined> {
  ensureSafeId(id);
  const path = taskPath(directory, id);
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new StoreFilesystemError(`Could not inspect task ${id}`, { cause: error });
  }
  if (!metadata.isFile()) {
    throw new StateCorruptionError(path, "task path is not a regular file");
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new StoreFilesystemError(`Could not read task ${id}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new StateCorruptionError(path, "task file is not valid JSON", { cause: error });
  }
  return parseTaskRecord(value, path);
}

async function listTasksUnlocked(directory: string): Promise<readonly TaskRecord[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new StoreFilesystemError(`Could not list task store directory ${directory}`, {
      cause: error,
    });
  }
  const taskEntries = entries.filter((entry) => entry.name.endsWith(".json"));
  const ids = taskEntries.map((entry) => entry.name.slice(0, -5));
  for (const id of ids) {
    ensureSafeId(id);
  }
  const sortedIds = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const tasks: TaskRecord[] = [];
  for (const id of sortedIds) {
    const task = await readTaskUnlocked(directory, id);
    if (task === undefined) {
      throw new StateCorruptionError(
        taskPath(directory, id),
        "task disappeared during locked listing",
      );
    }
    tasks.push(task);
  }
  return tasks;
}

function validateCreatedTaskInput(input: StoreTaskInput): void {
  if (!input || typeof input !== "object") {
    throw new TaskStoreError("invalid-options", "Task input must be an object");
  }
  if (input.id !== undefined) {
    ensureSafeId(input.id);
  }
}

export function createTaskStore(options: TaskStoreOptions): TaskStore {
  const { timeoutMs, pollMs } = ensureStoreOptions(options);
  const directory = options.directory;

  async function createUnlocked(input: StoreTaskInput): Promise<TaskRecord> {
    validateCreatedTaskInput(input);
    const id = input.id ?? options.idFactory();
    ensureSafeId(id);
    const existing = await readTaskUnlocked(directory, id);
    if (existing !== undefined) {
      throw new TaskAlreadyExistsError(id);
    }
    const taskInput: TaskInput = {
      id,
      repoPath: input.repoPath,
      kind: input.kind,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      surfaces: input.surfaces,
      policy: input.policy,
    };
    const task = createTask(taskInput, options.clock());
    await writeTaskAtomically(directory, task);
    return task;
  }

  async function readUnlocked(id: string): Promise<TaskRecord | undefined> {
    ensureSafeId(id);
    return readTaskUnlocked(directory, id);
  }

  async function listUnlocked(): Promise<readonly TaskRecord[]> {
    return listTasksUnlocked(directory);
  }

  async function updateUnlocked(
    id: string,
    expectedRevision: number,
    transform: TaskTransform,
  ): Promise<TaskRecord> {
    ensureSafeId(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TaskStoreError(
        "invalid-mutation",
        "expectedRevision must be a non-negative integer",
      );
    }
    if (typeof transform !== "function") {
      throw new TaskStoreError("invalid-mutation", "Task update transform must be a function");
    }
    const current = await readTaskUnlocked(directory, id);
    if (current === undefined) {
      throw new TaskNotFoundError(id);
    }
    if (current.revision !== expectedRevision) {
      throw new StaleTaskRevisionError(id, expectedRevision, current.revision);
    }
    const candidate = await transform(current);
    const next = parseTaskRecord(candidate, `updated task ${id}`);
    if (next.id !== id) {
      throw new InvalidTaskMutationError(`Task update cannot change id ${id} to ${next.id}`);
    }
    if (next.revision !== current.revision + 1) {
      throw new InvalidTaskMutationError(
        `Task ${id} update must increment revision exactly once from ${current.revision}`,
      );
    }
    await writeTaskAtomically(directory, next);
    return next;
  }

  const transaction: TaskStoreTransaction = {
    create: createUnlocked,
    read: readUnlocked,
    list: listUnlocked,
    update: updateUnlocked,
  };

  async function withLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    await ensureDirectory(directory);
    const release = await acquireRepositoryLock(directory, timeoutMs, pollMs);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  return {
    create: async (input) => withLock(() => createUnlocked(input)),
    read: async (id) => withLock(() => readUnlocked(id)),
    list: async () => withLock(listUnlocked),
    update: async (id, expectedRevision, transform) =>
      withLock(() => updateUnlocked(id, expectedRevision, transform)),
    exclusive: async <Result>(
      operation: (store: TaskStoreTransaction) => Result | PromiseLike<Result>,
    ): Promise<Result> => {
      if (typeof operation !== "function") {
        throw new TaskStoreError("invalid-mutation", "exclusive operation must be a function");
      }
      return withLock(async () => operation(transaction));
    },
  };
}

export async function transitionStoredTask(
  store: TaskStore,
  id: string,
  expectedRevision: number,
  event: TaskEvent,
  context: TaskTransitionContext,
): Promise<TaskRecord> {
  return store.update(id, expectedRevision, (task) => transitionTask(task, event, context));
}
