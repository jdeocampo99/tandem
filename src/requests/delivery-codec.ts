import type {
  Notification,
  PinnedValidationEvidence,
  RequestConflict,
  RequestDeliveryRecord,
  RequestDependency,
  RequestIntegratedMember,
  RequestIntegration,
  RequestMember,
  RequestPublication,
  RequestRelationStatus,
  ReviewResult,
} from "../contracts.ts";
import { isSafeRequestId } from "../contracts.ts";
import { isPinnedEvidence } from "../tasks/acceptance.ts";
import {
  parseNotification,
  parsePullRequest,
  parseReview,
  parseValidationEvidence,
  parseWorktree,
} from "../tasks/store-codec.ts";
import { StateCorruptionError } from "../tasks/store-errors.ts";

type UnknownRecord = Record<string, unknown>;

const RECORD_KEYS = [
  "schemaVersion",
  "id",
  "revision",
  "repoPath",
  "createdAt",
  "updatedAt",
  "members",
  "dependencies",
  "conflicts",
  "integration",
  "publication",
  "splitApproved",
  "notifications",
] as const;

const MEMBER_KEYS = [
  "taskId",
  "briefRevision",
  "agreementDigest",
  "surfaces",
  "admittedAt",
  "status",
  "quarantineReason",
] as const;

const DEPENDENCY_KEYS = [
  "taskId",
  "dependsOn",
  "reason",
  "briefRevision",
  "recordedAt",
  "status",
  "quarantineReason",
] as const;

const CONFLICT_KEYS = [
  "id",
  "taskIds",
  "reason",
  "briefRevision",
  "recordedAt",
  "status",
  "quarantineReason",
  "decision",
] as const;

const INTEGRATION_KEYS = [
  "worktree",
  "baseHead",
  "head",
  "members",
  "policyDigest",
  "ownerSessionId",
  "integratedAt",
  "evidence",
  "reviews",
] as const;

const INTEGRATED_MEMBER_KEYS = ["taskId", "branch", "head"] as const;

const PUBLICATION_KEYS = ["pullRequest", "integratedHead", "draft", "publishedAt"] as const;

const RELATION_STATUSES: readonly RequestRelationStatus[] = ["active", "quarantined"];

function failState(source: string, message: string): never {
  throw new StateCorruptionError(source, message);
}

function requiredRecord(value: unknown, source: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failState(source, "must be an object");
  }
  return value as UnknownRecord;
}

function assertExactKeys(record: UnknownRecord, allowed: readonly string[], source: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) failState(source, `unexpected field ${key}`);
  }
}

function requiredValue(record: UnknownRecord, key: string, source: string): unknown {
  if (!Object.hasOwn(record, key)) failState(source, `missing field ${key}`);
  const value = record[key];
  if (value === undefined) failState(source, `field ${key} must not be undefined`);
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
  return Object.hasOwn(record, key) && record[key] !== undefined
    ? requiredText(record, key, source)
    : undefined;
}

function requiredInteger(record: UnknownRecord, key: string, source: string, minimum = 0): number {
  const value = requiredValue(record, key, source);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    failState(source, `field ${key} must be an integer >= ${minimum}`);
  }
  return value;
}

function requiredTextArray(record: UnknownRecord, key: string, source: string): readonly string[] {
  const value = requiredValue(record, key, source);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    failState(source, `field ${key} must be an array of strings`);
  }
  return value as readonly string[];
}

function requiredArray(record: UnknownRecord, key: string, source: string): readonly unknown[] {
  const value = requiredValue(record, key, source);
  if (!Array.isArray(value)) failState(source, `field ${key} must be an array`);
  return value;
}

function requiredStatus(record: UnknownRecord, source: string): RequestRelationStatus {
  const value = requiredText(record, "status", source);
  if (!RELATION_STATUSES.some((status) => status === value)) {
    failState(source, `field status has unsupported value ${value}`);
  }
  return value as RequestRelationStatus;
}

function parseMember(value: unknown, source: string): RequestMember {
  const record = requiredRecord(value, source);
  assertExactKeys(record, MEMBER_KEYS, source);
  const quarantineReason = optionalText(record, "quarantineReason", source);
  return {
    taskId: requiredText(record, "taskId", source),
    briefRevision: requiredInteger(record, "briefRevision", source, 1),
    agreementDigest: requiredText(record, "agreementDigest", source),
    surfaces: requiredTextArray(record, "surfaces", source),
    admittedAt: requiredText(record, "admittedAt", source),
    status: requiredStatus(record, source),
    ...(quarantineReason === undefined ? {} : { quarantineReason }),
  };
}

function parseDependency(value: unknown, source: string): RequestDependency {
  const record = requiredRecord(value, source);
  assertExactKeys(record, DEPENDENCY_KEYS, source);
  const quarantineReason = optionalText(record, "quarantineReason", source);
  return {
    taskId: requiredText(record, "taskId", source),
    dependsOn: requiredText(record, "dependsOn", source),
    reason: requiredText(record, "reason", source),
    briefRevision: requiredInteger(record, "briefRevision", source, 1),
    recordedAt: requiredText(record, "recordedAt", source),
    status: requiredStatus(record, source),
    ...(quarantineReason === undefined ? {} : { quarantineReason }),
  };
}

function parseConflict(value: unknown, source: string): RequestConflict {
  const record = requiredRecord(value, source);
  assertExactKeys(record, CONFLICT_KEYS, source);
  const quarantineReason = optionalText(record, "quarantineReason", source);
  const decisionValue = Object.hasOwn(record, "decision") ? record.decision : undefined;
  const taskIds = requiredTextArray(record, "taskIds", source);
  if (taskIds.length < 2) failState(source, "a conflict must name at least two member tasks");
  return {
    id: requiredText(record, "id", source),
    taskIds,
    reason: requiredText(record, "reason", source),
    briefRevision: requiredInteger(record, "briefRevision", source, 1),
    recordedAt: requiredText(record, "recordedAt", source),
    status: requiredStatus(record, source),
    ...(quarantineReason === undefined ? {} : { quarantineReason }),
    ...(decisionValue === undefined
      ? {}
      : { decision: parseConflictDecision(decisionValue, `${source}.decision`) }),
  };
}

function parseConflictDecision(
  value: unknown,
  source: string,
): NonNullable<RequestConflict["decision"]> {
  const record = requiredRecord(value, source);
  assertExactKeys(record, ["instruction", "decidedAt"], source);
  return {
    instruction: requiredText(record, "instruction", source),
    decidedAt: requiredText(record, "decidedAt", source),
  };
}

function parseIntegratedMember(value: unknown, source: string): RequestIntegratedMember {
  const record = requiredRecord(value, source);
  assertExactKeys(record, INTEGRATED_MEMBER_KEYS, source);
  return {
    taskId: requiredText(record, "taskId", source),
    branch: requiredText(record, "branch", source),
    head: requiredText(record, "head", source),
  };
}

/**
 * Reads integration evidence and refuses anything that is not pinned to a contract and policy.
 * Legacy evidence can never prove a request was verified at its integrated commit.
 */
function parseIntegrationEvidence(
  value: unknown,
  source: string,
): readonly PinnedValidationEvidence[] {
  const entries = Array.isArray(value) ? value : failState(source, "evidence must be an array");
  return entries.map((entry, index) => {
    const parsed = parseValidationEvidence(entry, `${source}[${index}]`);
    if (!isPinnedEvidence(parsed)) {
      failState(`${source}[${index}]`, "integration evidence must name a validation contract");
    }
    return parsed;
  });
}

function parseIntegration(value: unknown, source: string): RequestIntegration {
  const record = requiredRecord(value, source);
  assertExactKeys(record, INTEGRATION_KEYS, source);
  const members = requiredArray(record, "members", source).map((entry, index) =>
    parseIntegratedMember(entry, `${source}.members[${index}]`),
  );
  if (members.length === 0) failState(source, "an integration must name the members it contains");
  const reviews: readonly ReviewResult[] = requiredArray(record, "reviews", source).map(
    (entry, index) => parseReview(entry, `${source}.reviews[${index}]`),
  );
  return {
    worktree: parseWorktree(requiredValue(record, "worktree", source), `${source}.worktree`),
    baseHead: requiredText(record, "baseHead", source),
    head: requiredText(record, "head", source),
    members,
    policyDigest: requiredText(record, "policyDigest", source),
    ownerSessionId: requiredText(record, "ownerSessionId", source),
    integratedAt: requiredText(record, "integratedAt", source),
    evidence: parseIntegrationEvidence(
      requiredValue(record, "evidence", source),
      `${source}.evidence`,
    ),
    reviews,
  };
}

function parsePublication(value: unknown, source: string): RequestPublication {
  const record = requiredRecord(value, source);
  assertExactKeys(record, PUBLICATION_KEYS, source);
  const draft = requiredValue(record, "draft", source);
  if (typeof draft !== "boolean") failState(source, "field draft must be a boolean");
  return {
    pullRequest: parsePullRequest(
      requiredValue(record, "pullRequest", source),
      `${source}.pullRequest`,
    ),
    integratedHead: requiredText(record, "integratedHead", source),
    draft,
    publishedAt: requiredText(record, "publishedAt", source),
  };
}

export function parseRequestDeliveryRecord(
  value: unknown,
  source = "request delivery record",
): RequestDeliveryRecord {
  const record = requiredRecord(value, source);
  assertExactKeys(record, RECORD_KEYS, source);
  const schemaVersion = requiredInteger(record, "schemaVersion", source, 1);
  if (schemaVersion !== 1) failState(source, `unsupported schemaVersion ${schemaVersion}`);
  const id = requiredText(record, "id", source);
  if (!isSafeRequestId(id)) failState(source, `unsafe request id ${id}`);
  const members = requiredArray(record, "members", source).map((entry, index) =>
    parseMember(entry, `${source}.members[${index}]`),
  );
  const integration = Object.hasOwn(record, "integration") ? record.integration : undefined;
  const publication = Object.hasOwn(record, "publication") ? record.publication : undefined;
  const splitApproved = Object.hasOwn(record, "splitApproved") ? record.splitApproved : undefined;
  if (splitApproved !== undefined && typeof splitApproved !== "boolean") {
    failState(source, "field splitApproved must be a boolean");
  }
  const notifications: readonly Notification[] = requiredArray(record, "notifications", source).map(
    (entry, index) => parseNotification(entry, `${source}.notifications[${index}]`),
  );
  assertUniqueMembers(members, source);
  return {
    schemaVersion: 1,
    id,
    revision: requiredInteger(record, "revision", source),
    repoPath: requiredText(record, "repoPath", source),
    createdAt: requiredText(record, "createdAt", source),
    updatedAt: requiredText(record, "updatedAt", source),
    members,
    dependencies: requiredArray(record, "dependencies", source).map((entry, index) =>
      parseDependency(entry, `${source}.dependencies[${index}]`),
    ),
    conflicts: requiredArray(record, "conflicts", source).map((entry, index) =>
      parseConflict(entry, `${source}.conflicts[${index}]`),
    ),
    ...(integration === undefined
      ? {}
      : { integration: parseIntegration(integration, `${source}.integration`) }),
    ...(publication === undefined
      ? {}
      : { publication: parsePublication(publication, `${source}.publication`) }),
    ...(splitApproved === undefined ? {} : { splitApproved }),
    notifications,
  };
}

function assertUniqueMembers(members: readonly RequestMember[], source: string): void {
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.taskId)) failState(source, `task ${member.taskId} is admitted twice`);
    seen.add(member.taskId);
  }
}
