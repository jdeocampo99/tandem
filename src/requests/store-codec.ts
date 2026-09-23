import {
  type Endpoint,
  isSafeRequestId,
  LEGACY_ENDPOINT_ROLES,
  type RequestBriefApproval,
  type RequestBriefChangeKind,
  type RequestBriefContent,
  type RequestBriefRecord,
  type RequestBriefRevision,
  type RequestReviewPane,
  type RequestReviewPaneStatus,
} from "../contracts.ts";
import { StateCorruptionError } from "../tasks/store-errors.ts";
import { checkedRequestBriefContent, requestBriefDigests } from "./brief.ts";

const RECORD_KEYS = [
  "schemaVersion",
  "id",
  "revision",
  "repoPath",
  "createdAt",
  "updatedAt",
  "draft",
  "history",
  "approval",
  "reviewPane",
] as const;

const REVISION_KEYS = [
  "revision",
  "content",
  "contentDigest",
  "agreementDigest",
  "changeKind",
  "recordedAt",
] as const;

const APPROVAL_KEYS = [
  "requestId",
  "briefRevision",
  "contentDigest",
  "agreementDigest",
  "approvedAt",
] as const;

const PANE_KEYS = [
  "status",
  "endpoint",
  "renderedRevision",
  "renderedPath",
  "observedAt",
  "reason",
] as const;

const ENDPOINT_KEYS = [
  "sessionId",
  "workspaceId",
  "tabId",
  "paneId",
  "role",
  "generation",
] as const;

const CHANGE_KINDS: readonly RequestBriefChangeKind[] = ["agreement", "annotation"];

const PANE_STATUSES: readonly RequestReviewPaneStatus[] = [
  "open",
  "closed",
  "retained",
  "quarantined",
];

type UnknownRecord = Record<string, unknown>;

export function parseRequestBriefRecord(
  value: unknown,
  source = "request brief record",
): RequestBriefRecord {
  const record = requiredRecord(value, source);
  assertExactKeys(record, RECORD_KEYS, source);
  const schemaVersion = requiredInteger(record, "schemaVersion", source, 1);
  if (schemaVersion !== 1) failState(source, `unsupported schemaVersion ${schemaVersion}`);
  const id = requiredText(record, "id", source);
  if (!isSafeRequestId(id)) failState(source, `unsafe request id ${id}`);
  const historyValue = requiredValue(record, "history", source);
  if (!Array.isArray(historyValue)) failState(`${source}.history`, "history must be an array");
  const entries: readonly unknown[] = historyValue;
  const history = entries.map((entry, index) =>
    parseRevision(entry, `${source}.history[${index}]`),
  );
  const draft = parseRevision(requiredValue(record, "draft", source), `${source}.draft`);
  assertMonotonicHistory(history, draft, source);
  const approval = optionalSection(record, "approval");
  const reviewPane = optionalSection(record, "reviewPane");
  return {
    schemaVersion: 1,
    id,
    revision: requiredInteger(record, "revision", source),
    repoPath: requiredText(record, "repoPath", source),
    createdAt: requiredText(record, "createdAt", source),
    updatedAt: requiredText(record, "updatedAt", source),
    draft,
    history,
    ...(approval === undefined
      ? {}
      : { approval: parseApproval(approval, id, `${source}.approval`) }),
    ...(reviewPane === undefined
      ? {}
      : { reviewPane: parseReviewPane(reviewPane, `${source}.reviewPane`) }),
  };
}

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

function requiredInteger(record: UnknownRecord, key: string, source: string, minimum = 0): number {
  const value = requiredValue(record, key, source);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    failState(source, `field ${key} must be an integer >= ${minimum}`);
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
  if (typeof value !== "string" || !values.some((candidate) => candidate === value)) {
    failState(source, `field ${key} has unsupported value ${String(value)}`);
  }
  return value as Value;
}

function optionalSection(record: UnknownRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function parseBriefContent(value: unknown, source: string): RequestBriefContent {
  try {
    return checkedRequestBriefContent(value);
  } catch (error) {
    failState(source, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reads one stored revision and recomputes both digests from its content. A stored digest that
 * disagrees with the content it claims to describe would let stale approval pass unnoticed, so it
 * fails the read rather than being trusted or silently corrected.
 */
function parseRevision(value: unknown, source: string): RequestBriefRevision {
  const record = requiredRecord(value, source);
  assertExactKeys(record, REVISION_KEYS, source);
  const content = parseBriefContent(requiredValue(record, "content", source), `${source}.content`);
  const digests = requestBriefDigests(content);
  const contentDigest = requiredText(record, "contentDigest", source);
  const agreementDigest = requiredText(record, "agreementDigest", source);
  if (contentDigest !== digests.contentDigest || agreementDigest !== digests.agreementDigest) {
    failState(source, "recorded digests do not describe the recorded brief content");
  }
  return {
    revision: requiredInteger(record, "revision", source, 1),
    content,
    contentDigest,
    agreementDigest,
    changeKind: requiredEnum(record, "changeKind", CHANGE_KINDS, source),
    recordedAt: requiredText(record, "recordedAt", source),
  };
}

function assertMonotonicHistory(
  history: readonly RequestBriefRevision[],
  draft: RequestBriefRevision,
  source: string,
): void {
  const revisions = [...history.map((entry) => entry.revision), draft.revision];
  for (let index = 1; index < revisions.length; index += 1) {
    const previous = revisions[index - 1];
    const current = revisions[index];
    if (previous === undefined || current === undefined || current <= previous) {
      failState(source, "brief revisions must increase from oldest history entry to the draft");
    }
  }
}

function parseApproval(value: unknown, requestId: string, source: string): RequestBriefApproval {
  const record = requiredRecord(value, source);
  assertExactKeys(record, APPROVAL_KEYS, source);
  const approvedRequestId = requiredText(record, "requestId", source);
  if (approvedRequestId !== requestId) {
    failState(source, `approval belongs to request ${approvedRequestId}`);
  }
  return {
    requestId: approvedRequestId,
    briefRevision: requiredInteger(record, "briefRevision", source, 1),
    contentDigest: requiredText(record, "contentDigest", source),
    agreementDigest: requiredText(record, "agreementDigest", source),
    approvedAt: requiredText(record, "approvedAt", source),
  };
}

function parseEndpoint(value: unknown, source: string): Endpoint {
  const record = requiredRecord(value, source);
  assertExactKeys(record, ENDPOINT_KEYS, source);
  return {
    sessionId: requiredText(record, "sessionId", source),
    workspaceId: requiredText(record, "workspaceId", source),
    tabId: requiredText(record, "tabId", source),
    paneId: requiredText(record, "paneId", source),
    // ponytail: legacy panes may still carry role "verifier"; see LEGACY_ENDPOINT_ROLES.
    role: requiredEnum(record, "role", LEGACY_ENDPOINT_ROLES, source),
    generation: requiredInteger(record, "generation", source),
  };
}

function parseReviewPane(value: unknown, source: string): RequestReviewPane {
  const record = requiredRecord(value, source);
  assertExactKeys(record, PANE_KEYS, source);
  const reason = Object.hasOwn(record, "reason")
    ? requiredText(record, "reason", source)
    : undefined;
  return {
    status: requiredEnum(record, "status", PANE_STATUSES, source),
    endpoint: parseEndpoint(requiredValue(record, "endpoint", source), `${source}.endpoint`),
    renderedRevision: requiredInteger(record, "renderedRevision", source, 1),
    renderedPath: requiredText(record, "renderedPath", source),
    observedAt: requiredText(record, "observedAt", source),
    ...(reason === undefined ? {} : { reason }),
  };
}
