import { createHash } from "node:crypto";
import {
  type IsoTimestamp,
  isSafeRequestId,
  MAX_REQUEST_BRIEF_BYTES,
  MAX_REQUEST_BRIEF_ENTRIES,
  REQUEST_ID_PREFIX,
  type RequestBriefApproval,
  type RequestBriefChangeKind,
  type RequestBriefContent,
  type RequestBriefRecord,
  type RequestBriefRevision,
  type RequestReviewPane,
  type TaskRecord,
} from "../contracts.ts";

export type RequestBriefErrorCode =
  | "invalid-content"
  | "invalid-request-id"
  | "request-not-found"
  | "request-mismatch"
  | "stale-revision"
  | "stale-content"
  | "no-pending-approval"
  | "ambiguous-pending-approval"
  | "ambiguous-open-request";

export class RequestBriefError extends Error {
  readonly code: RequestBriefErrorCode;
  readonly requestId: string | undefined;

  constructor(code: RequestBriefErrorCode, message: string, requestId?: string) {
    super(message);
    this.name = "RequestBriefError";
    this.code = code;
    this.requestId = requestId;
  }
}

/** Whether an approval still speaks for the current draft. */
export type RequestApprovalState = "unapproved" | "current" | "superseded";

/** What an approver claims to be approving; every field must match the current draft exactly. */
export type RequestApprovalIntent = Readonly<{
  readonly requestId: string;
  readonly briefRevision: number;
  readonly contentDigest: string;
}>;

/** Whether work may be dispatched under this request right now. */
export type RequestDispatchDecision =
  | Readonly<{ readonly allowed: true; readonly approvedRevision: number }>
  | Readonly<{ readonly allowed: false; readonly reason: string }>;

/** The two digests a revision is identified by. */
export type RequestBriefDigests = Readonly<{
  readonly contentDigest: string;
  readonly agreementDigest: string;
}>;

/** The fields whose change requires reapproval, in the order the digest covers them. */
const AGREEMENT_FIELDS = [
  "goal",
  "scope",
  "constraints",
  "nonGoals",
  "acceptanceCriteria",
  "recommendedApproach",
  "keyDecisions",
] as const;

/**
 * Also agreement, but added later: it joins the agreement digest only when non-empty, so a brief
 * saved before it existed keeps its digests and its approval.
 */
const MANUAL_VERIFICATION_FIELD = "manualVerification";

/** Also agreement and added later: it joins the agreement digest only when set. */
const SKIP_REVIEW_FIELD = "skipReview";

const ANNOTATION_FIELDS = ["openQuestions", "researchLinks"] as const;

const TEXT_FIELDS = ["goal", "recommendedApproach"] as const;

const LIST_FIELDS = [
  "scope",
  "constraints",
  "nonGoals",
  "acceptanceCriteria",
  "manualVerification",
  "keyDecisions",
  "openQuestions",
  "researchLinks",
] as const;

/** Stages whose work is actually under way, and so must stop while a brief awaits reapproval. */
const PAUSABLE_STAGES: readonly TaskRecord["stage"][] = [
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
];

export function assertSafeRequestId(value: unknown): asserts value is string {
  if (!isSafeRequestId(value)) {
    throw new RequestBriefError(
      "invalid-request-id",
      `A request id must start with ${JSON.stringify(REQUEST_ID_PREFIX)} and contain only identifier characters; received ${JSON.stringify(String(value))}`,
    );
  }
}

/** Mints a request id that no task id can collide with, from an injected identifier source. */
export function requestIdFrom(rawId: string): string {
  const candidate = rawId.startsWith(REQUEST_ID_PREFIX) ? rawId : `${REQUEST_ID_PREFIX}${rawId}`;
  assertSafeRequestId(candidate);
  return candidate;
}

/**
 * Validates untrusted brief content at the boundary and returns it in canonical field order, so
 * two equal briefs always digest identically.
 */
export function checkedRequestBriefContent(value: unknown): RequestBriefContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestBriefError("invalid-content", "A request brief must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed: readonly string[] = [
    ...AGREEMENT_FIELDS,
    MANUAL_VERIFICATION_FIELD,
    SKIP_REVIEW_FIELD,
    ...ANNOTATION_FIELDS,
  ];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new RequestBriefError("invalid-content", `A request brief has no field ${key}`);
    }
  }
  const content: RequestBriefContent = {
    goal: briefText(record, "goal"),
    scope: briefList(record, "scope"),
    constraints: briefList(record, "constraints"),
    nonGoals: briefList(record, "nonGoals"),
    acceptanceCriteria: briefList(record, "acceptanceCriteria"),
    // A brief saved before manual verification existed has only automated checks.
    manualVerification:
      record.manualVerification === undefined ? [] : briefList(record, "manualVerification"),
    recommendedApproach: briefText(record, "recommendedApproach"),
    keyDecisions: briefList(record, "keyDecisions"),
    openQuestions: briefList(record, "openQuestions"),
    researchLinks: briefList(record, "researchLinks"),
    ...(briefFlag(record, SKIP_REVIEW_FIELD) ? { skipReview: true } : {}),
  };
  const bytes = Buffer.byteLength(JSON.stringify(content), "utf8");
  if (bytes > MAX_REQUEST_BRIEF_BYTES) {
    throw new RequestBriefError(
      "invalid-content",
      `A request brief may not exceed ${MAX_REQUEST_BRIEF_BYTES} UTF-8 bytes; received ${bytes}`,
    );
  }
  if (content.scope.length === 0 || content.acceptanceCriteria.length === 0) {
    throw new RequestBriefError(
      "invalid-content",
      "A request brief must name at least one scope item and one acceptance criterion",
    );
  }
  return content;
}

export function requestBriefDigests(content: RequestBriefContent): RequestBriefDigests {
  return {
    contentDigest: digestOf(canonicalContent(content)),
    agreementDigest: digestOf(canonicalAgreement(content)),
  };
}

export function createRequestBriefRecord(
  input: Readonly<{
    readonly id: string;
    readonly repoPath: string;
    readonly content: RequestBriefContent;
  }>,
  now: IsoTimestamp,
): RequestBriefRecord {
  assertSafeRequestId(input.id);
  const repoPath = checkedLine(input.repoPath, "repoPath");
  const timestamp = checkedLine(now, "timestamp");
  return {
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    repoPath,
    createdAt: timestamp,
    updatedAt: timestamp,
    draft: revisionOf(checkedRequestBriefContent(input.content), 1, "agreement", timestamp),
    history: [],
  };
}

/**
 * Advances the draft to new content. The revision number always moves forward; whether the prior
 * approval survives is decided by `requestApprovalState`, which compares agreement digests.
 */
export function reviseRequestBriefRecord(
  record: RequestBriefRecord,
  content: RequestBriefContent,
  now: IsoTimestamp,
): RequestBriefRecord {
  const timestamp = checkedLine(now, "timestamp");
  const checked = checkedRequestBriefContent(content);
  const digests = requestBriefDigests(checked);
  const changeKind: RequestBriefChangeKind =
    digests.agreementDigest === record.draft.agreementDigest ? "annotation" : "agreement";
  return {
    ...record,
    revision: record.revision + 1,
    updatedAt: timestamp,
    draft: revisionOf(checked, record.draft.revision + 1, changeKind, timestamp),
    history: [...record.history, record.draft],
  };
}

/**
 * Records an approval of one exact draft revision. A claim that names another request, an earlier
 * or later revision, or content that no longer matches is refused rather than repaired, so an
 * approval can never travel to a revision the approver did not see.
 */
export function approveRequestBriefRecord(
  record: RequestBriefRecord,
  intent: RequestApprovalIntent,
  now: IsoTimestamp,
): RequestBriefRecord {
  const timestamp = checkedLine(now, "timestamp");
  if (intent.requestId !== record.id) {
    throw new RequestBriefError(
      "request-mismatch",
      `Approval names request ${JSON.stringify(intent.requestId)}, not ${JSON.stringify(record.id)}`,
      record.id,
    );
  }
  if (intent.briefRevision !== record.draft.revision) {
    throw new RequestBriefError(
      "stale-revision",
      `Approval names brief revision ${String(intent.briefRevision)}; request ${record.id} is at revision ${record.draft.revision}`,
      record.id,
    );
  }
  if (intent.contentDigest !== record.draft.contentDigest) {
    throw new RequestBriefError(
      "stale-content",
      `Approval carries content digest ${JSON.stringify(intent.contentDigest)}, which is not the digest of revision ${record.draft.revision}`,
      record.id,
    );
  }
  const approval: RequestBriefApproval = {
    requestId: record.id,
    briefRevision: record.draft.revision,
    contentDigest: record.draft.contentDigest,
    agreementDigest: record.draft.agreementDigest,
    approvedAt: timestamp,
  };
  return { ...record, revision: record.revision + 1, updatedAt: timestamp, approval };
}

export function withRequestReviewPane(
  record: RequestBriefRecord,
  pane: RequestReviewPane,
  now: IsoTimestamp,
): RequestBriefRecord {
  return {
    ...record,
    revision: record.revision + 1,
    updatedAt: checkedLine(now, "timestamp"),
    reviewPane: pane,
  };
}

export function requestApprovalState(record: RequestBriefRecord): RequestApprovalState {
  if (record.approval === undefined) return "unapproved";
  return record.approval.agreementDigest === record.draft.agreementDigest
    ? "current"
    : "superseded";
}

/**
 * The one request whose brief is awaiting approval, so an approver need not name it. Fails closed
 * rather than guessing: an approval must never land on a request the caller did not mean, so zero
 * or several candidates are both refused with the exact ids, for the caller to name one explicitly.
 */
export function singlePendingApprovalId(records: readonly RequestBriefRecord[]): string {
  const pending = records.filter((record) => requestApprovalState(record) !== "current");
  if (pending.length === 0) {
    throw new RequestBriefError("no-pending-approval", "No request brief is awaiting approval");
  }
  if (pending.length > 1) {
    throw new RequestBriefError(
      "ambiguous-pending-approval",
      `Several requests have a brief awaiting approval (${pending.map((record) => record.id).join(", ")}); name one explicitly`,
    );
  }
  const only = pending[0];
  if (only === undefined) {
    throw new RequestBriefError("no-pending-approval", "No request brief is awaiting approval");
  }
  return only.id;
}

/**
 * The request new implementation work in this repository belongs to when the coordinator named
 * none: the one approved request whose work is not finished. None means the work stands alone;
 * several means it cannot be attributed safely, so the coordinator must name one.
 */
export function openRequestForNewWork(
  records: readonly RequestBriefRecord[],
  tasks: readonly Pick<TaskRecord, "requestId" | "stage">[],
  repoPath: string,
): string | undefined {
  const finished = (task: Pick<TaskRecord, "stage">): boolean =>
    task.stage === "cancelled" || task.stage === "completed" || task.stage === "merged";
  const open = records.filter((record) => {
    if (record.repoPath !== repoPath || requestApprovalState(record) !== "current") return false;
    const governed = tasks.filter((task) => task.requestId === record.id);
    return governed.length === 0 || !governed.every(finished);
  });
  if (open.length > 1) {
    throw new RequestBriefError(
      "ambiguous-open-request",
      `Several approved requests are open for this repository (${open.map((record) => record.id).join(", ")}); pass requestId`,
    );
  }
  return open[0]?.id;
}

/** Whether the user's approved agreement for this request says its work needs no code review. */
export function briefSkipsReview(record: RequestBriefRecord): boolean {
  return requestApprovalState(record) === "current" && record.draft.content.skipReview === true;
}

export function decideRequestDispatch(record: RequestBriefRecord): RequestDispatchDecision {
  const state = requestApprovalState(record);
  if (state === "current" && record.approval !== undefined) {
    return { allowed: true, approvedRevision: record.approval.briefRevision };
  }
  if (state === "unapproved") {
    return {
      allowed: false,
      reason: `Request ${record.id} has no approved brief; its draft is at revision ${record.draft.revision}`,
    };
  }
  return {
    allowed: false,
    reason: `Request ${record.id} changed what was agreed after approval of revision ${String(record.approval?.briefRevision)}; revision ${record.draft.revision} needs reapproval`,
  };
}

/** The tasks a superseded brief must stop, named without touching any of them. */
export function tasksAwaitingReapproval(
  record: RequestBriefRecord,
  tasks: readonly Pick<TaskRecord, "id" | "requestId" | "stage">[],
): readonly string[] {
  if (requestApprovalState(record) !== "superseded") return [];
  return tasks
    .filter((task) => task.requestId === record.id && PAUSABLE_STAGES.includes(task.stage))
    .map((task) => task.id);
}

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalContent(content: RequestBriefContent): string {
  return JSON.stringify([
    canonicalAgreement(content),
    ...ANNOTATION_FIELDS.map((field) => content[field]),
  ]);
}

function canonicalAgreement(content: RequestBriefContent): string {
  const agreement: unknown[] = AGREEMENT_FIELDS.map((field) => content[field]);
  if (content.manualVerification.length > 0) agreement.push(content.manualVerification);
  if (content.skipReview === true) agreement.push({ skipReview: true });
  return JSON.stringify(agreement);
}

function checkedLine(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RequestBriefError("invalid-content", `${field} must be a non-empty string`);
  }
  return value;
}

function briefFlag(record: Record<string, unknown>, field: typeof SKIP_REVIEW_FIELD): boolean {
  const value = record[field];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new RequestBriefError("invalid-content", `${field} must be a boolean`);
  }
  return value;
}

function briefText(record: Record<string, unknown>, field: (typeof TEXT_FIELDS)[number]): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RequestBriefError(
      "invalid-content",
      `A request brief ${field} must be a non-empty string`,
    );
  }
  return value;
}

function briefList(
  record: Record<string, unknown>,
  field: (typeof LIST_FIELDS)[number],
): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new RequestBriefError(
      "invalid-content",
      `A request brief ${field} must be an array of non-empty strings`,
    );
  }
  if (value.length > MAX_REQUEST_BRIEF_ENTRIES) {
    throw new RequestBriefError(
      "invalid-content",
      `A request brief ${field} may hold at most ${MAX_REQUEST_BRIEF_ENTRIES} entries`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new RequestBriefError(
        "invalid-content",
        `A request brief ${field}[${index}] must be a non-empty string`,
      );
    }
    return entry;
  });
}

function revisionOf(
  content: RequestBriefContent,
  revision: number,
  changeKind: RequestBriefChangeKind,
  recordedAt: IsoTimestamp,
): RequestBriefRevision {
  const digests = requestBriefDigests(content);
  return { revision, content, ...digests, changeKind, recordedAt };
}
