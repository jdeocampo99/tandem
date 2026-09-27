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
  type RequestPlanningAnswer,
  type RequestPlanningInterview,
  type RequestPlanningOption,
  type RequestPlanningQuestion,
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
  | "ambiguous-open-request"
  | "request-abandoned"
  | "planning-interview-incomplete"
  | "planning-question-pending"
  | "planning-question-stale"
  | "request-in-use";

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
  "planningAnswers",
  "openQuestions",
  "researchLinks",
] as const;

export const MAX_REQUEST_PLANNING_QUESTIONS = 8;
const MAX_PLANNING_INTERVIEW_BYTES = 32 * 1024;
const PLANNING_ANSWER_TEXT_FIELD = "planningAnswers";
const RESERVED_OMP_ASK_OPTION_LABELS = new Set([
  "Other (type your own)",
  "Chat about this",
  "Next →",
]);

/** Stages whose work must stop while its request cannot dispatch. */
const PAUSABLE_STAGES: readonly TaskRecord["stage"][] = [
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
  "ready",
];

/** Stages whose work is over, so it no longer holds its request open. */
const FINISHED_STAGES: readonly TaskRecord["stage"][] = ["cancelled", "completed", "merged"];

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
    PLANNING_ANSWER_TEXT_FIELD,
    SKIP_REVIEW_FIELD,
    ...ANNOTATION_FIELDS,
  ];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new RequestBriefError("invalid-content", `A request brief has no field ${key}`);
    }
  }
  const planningAnswers =
    record.planningAnswers === undefined ? [] : briefList(record, "planningAnswers");
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
    ...(planningAnswers.length === 0 ? {} : { planningAnswers }),
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

export function checkedRequestPlanningAnswer(value: unknown): RequestPlanningAnswer {
  const record = planningRecord(value, "answer");
  assertPlanningKeys(record, ["kind", "value", "note"], "answer");
  const kind = record.kind;
  if (kind !== "option" && kind !== "custom") {
    throw planningError("answer kind must be option or custom");
  }
  const note =
    record.note === undefined ? undefined : planningText(record.note, "answer note", 1000);
  return {
    kind,
    value: planningText(record.value, "answer value", 2000),
    ...(note === undefined ? {} : { note }),
  };
}

export function checkedRequestPlanningInterview(value: unknown): RequestPlanningInterview {
  const record = planningRecord(value, "interview");
  assertPlanningKeys(
    record,
    ["schemaVersion", "status", "researchTaskIds", "questions"],
    "interview",
  );
  if (record.schemaVersion !== 1) throw planningError("unsupported interview schemaVersion");
  if (record.status !== "active" && record.status !== "complete") {
    throw planningError("interview status must be active or complete");
  }
  if (!Array.isArray(record.researchTaskIds) || record.researchTaskIds.length > 24) {
    throw planningError("researchTaskIds must be an array with at most 24 entries");
  }
  const researchTaskIds = record.researchTaskIds.map((id, index) =>
    planningText(id, `researchTaskIds[${index}]`, 160),
  );
  if (new Set(researchTaskIds).size !== researchTaskIds.length) {
    throw planningError("researchTaskIds must be unique");
  }
  if (
    !Array.isArray(record.questions) ||
    record.questions.length > MAX_REQUEST_PLANNING_QUESTIONS
  ) {
    throw planningError(
      `questions must be an array with at most ${MAX_REQUEST_PLANNING_QUESTIONS} entries`,
    );
  }
  const questions = record.questions.map((question, index) =>
    checkedPlanningQuestion(question, `questions[${index}]`),
  );
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw planningError("question ids must be unique");
  }
  if (
    record.status === "complete" &&
    (questions.length === 0 || questions.some((question) => question.answer === undefined))
  ) {
    throw planningError("a complete interview must contain answered planning questions");
  }
  if (
    record.status === "active" &&
    questions.some(
      (question, index) => index < questions.length - 1 && question.answer === undefined,
    )
  ) {
    throw planningError("an active interview may leave only its final question unanswered");
  }
  const interview: RequestPlanningInterview = {
    schemaVersion: 1,
    status: record.status,
    researchTaskIds,
    questions,
  };
  const bytes = Buffer.byteLength(JSON.stringify(interview), "utf8");
  if (bytes > MAX_PLANNING_INTERVIEW_BYTES) {
    throw planningError(`interview may not exceed ${MAX_PLANNING_INTERVIEW_BYTES} UTF-8 bytes`);
  }
  return interview;
}

export type RequestPlanningQuestionInput = Readonly<{
  readonly context: string;
  readonly question: string;
  readonly options: readonly RequestPlanningOption[];
  readonly recommendedOption: number;
}>;

export function addRequestPlanningQuestion(
  record: RequestBriefRecord,
  input: RequestPlanningQuestionInput,
  questionId: string,
  now: IsoTimestamp,
): RequestBriefRecord {
  const interview = requireActivePlanningInterview(record);
  const last = interview.questions.at(-1);
  if (last?.answer === undefined && last !== undefined) {
    throw new RequestBriefError(
      "planning-question-pending",
      `Request ${record.id} already has an unanswered planning question`,
      record.id,
    );
  }
  if (interview.questions.length >= MAX_REQUEST_PLANNING_QUESTIONS) {
    throw new RequestBriefError(
      "planning-interview-incomplete",
      `Request ${record.id} reached the ${MAX_REQUEST_PLANNING_QUESTIONS}-question planning limit`,
      record.id,
    );
  }
  const question = checkedPlanningQuestion({ ...input, id: questionId }, "planning question");
  const planningInterview = checkedRequestPlanningInterview({
    ...interview,
    questions: [...interview.questions, question],
  });
  return {
    ...record,
    revision: record.revision + 1,
    updatedAt: checkedLine(now, "timestamp"),
    planningInterview,
  };
}

export function recordRequestPlanningAnswer(
  record: RequestBriefRecord,
  questionId: string,
  answerValue: unknown,
  now: IsoTimestamp,
): Readonly<{ readonly record: RequestBriefRecord; readonly duplicate: boolean }> {
  const interview = requireActivePlanningInterview(record);
  const answer = checkedRequestPlanningAnswer(answerValue);
  const questionIndex = interview.questions.findIndex((question) => question.id === questionId);
  const question = interview.questions[questionIndex];
  if (question === undefined) {
    throw new RequestBriefError(
      "planning-question-stale",
      `Planning question ${JSON.stringify(questionId)} is not in request ${record.id}`,
      record.id,
    );
  }
  if (question.answer !== undefined) {
    if (JSON.stringify(question.answer) === JSON.stringify(answer)) {
      return { record, duplicate: true };
    }
    throw new RequestBriefError(
      "planning-question-stale",
      `Planning question ${JSON.stringify(questionId)} already has a different saved answer`,
      record.id,
    );
  }
  if (interview.status !== "active" || questionIndex !== interview.questions.length - 1) {
    throw new RequestBriefError(
      "planning-question-stale",
      `Planning question ${JSON.stringify(questionId)} is no longer the current question`,
      record.id,
    );
  }
  const questions = interview.questions.map((entry, index) =>
    index === questionIndex ? { ...entry, answer } : entry,
  );
  const planningInterview = checkedRequestPlanningInterview({ ...interview, questions });
  return {
    record: {
      ...record,
      revision: record.revision + 1,
      updatedAt: checkedLine(now, "timestamp"),
      planningInterview,
    },
    duplicate: false,
  };
}

export function completeRequestPlanningInterview(
  record: RequestBriefRecord,
  now: IsoTimestamp,
): RequestBriefRecord {
  const interview = requireActivePlanningInterview(record);
  if (interview.questions.length === 0) {
    throw new RequestBriefError(
      "planning-interview-incomplete",
      `Request ${record.id} needs at least one saved planning decision before completion`,
      record.id,
    );
  }
  if (interview.questions.some((question) => question.answer === undefined)) {
    throw new RequestBriefError(
      "planning-interview-incomplete",
      `Request ${record.id} still has an unanswered planning question`,
      record.id,
    );
  }
  if (record.draft.content.openQuestions.length > 0) {
    throw new RequestBriefError(
      "planning-interview-incomplete",
      `Request ${record.id} still has unresolved open questions in its brief`,
      record.id,
    );
  }
  const planningAnswers = interview.questions.map((question) => {
    const answer = question.answer;
    if (answer === undefined) throw planningError("complete interview is missing an answer");
    return `${question.question}\nAnswer: ${answer.value}${answer.note === undefined ? "" : `\nNote: ${answer.note}`}`;
  });
  const content = checkedRequestBriefContent({
    ...record.draft.content,
    ...(planningAnswers.length === 0 ? {} : { planningAnswers }),
  });
  const base =
    requestBriefDigests(content).contentDigest === record.draft.contentDigest
      ? record
      : reviseRequestBriefRecord(record, content, now);
  return {
    ...base,
    revision: record.revision + 1,
    updatedAt: checkedLine(now, "timestamp"),
    planningInterview: { ...interview, status: "complete" },
  };
}

function requireActivePlanningInterview(record: RequestBriefRecord): RequestPlanningInterview {
  assertNotAbandoned(record);
  const interview = record.planningInterview;
  if (interview === undefined) {
    throw new RequestBriefError(
      "planning-interview-incomplete",
      `Request ${record.id} has no planning interview`,
      record.id,
    );
  }
  if (interview.status !== "active") {
    throw new RequestBriefError(
      "planning-interview-incomplete",
      `Request ${record.id} planning interview is already complete`,
      record.id,
    );
  }
  return interview;
}

function checkedPlanningQuestion(value: unknown, field: string): RequestPlanningQuestion {
  const record = planningRecord(value, field);
  assertPlanningKeys(
    record,
    ["id", "context", "question", "options", "recommendedOption", "answer"],
    field,
  );
  if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 3) {
    throw planningError(`${field}.options must contain two or three choices`);
  }
  const options = record.options.map((option, index) => {
    const choice = planningRecord(option, `${field}.options[${index}]`);
    assertPlanningKeys(choice, ["label", "description"], `${field}.options[${index}]`);
    const description =
      choice.description === undefined
        ? undefined
        : planningAskText(choice.description, `${field}.options[${index}].description`, 240);
    const label = planningAskText(choice.label, `${field}.options[${index}].label`, 100);
    if (RESERVED_OMP_ASK_OPTION_LABELS.has(label)) {
      throw planningError(`${field}.options[${index}].label collides with an OMP reserved choice`);
    }
    return {
      label,
      ...(description === undefined ? {} : { description }),
    };
  });
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw planningError(`${field}.options labels must be unique`);
  }
  const recommendedOption = record.recommendedOption;
  if (
    typeof recommendedOption !== "number" ||
    !Number.isSafeInteger(recommendedOption) ||
    recommendedOption < 0 ||
    recommendedOption >= options.length
  ) {
    throw planningError(`${field}.recommendedOption must index one of its choices`);
  }
  const answer =
    record.answer === undefined ? undefined : checkedRequestPlanningAnswer(record.answer);
  if (answer?.kind === "option" && !options.some((option) => option.label === answer.value)) {
    throw planningError(`${field}.answer must name one of its saved option labels`);
  }
  return {
    id: planningAskText(record.id, `${field}.id`, 160),
    context: planningAskText(record.context, `${field}.context`, 800),
    question: planningAskText(record.question, `${field}.question`, 600),
    options,
    recommendedOption,
    ...(answer === undefined ? {} : { answer }),
  };
}

function planningRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw planningError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertPlanningKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw planningError(`${field} has no field ${key}`);
  }
}

function planningAskText(value: unknown, field: string, maximumBytes: number): string {
  const text = planningText(value, field, maximumBytes);
  if (text.includes("\r")) throw planningError(`${field} must not contain carriage returns`);
  return text;
}

function planningText(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw planningError(`${field} must be non-empty and at most ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function planningError(message: string): RequestBriefError {
  return new RequestBriefError("invalid-content", message);
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
    readonly planningInterview?: RequestPlanningInterview;
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
    ...(input.planningInterview === undefined
      ? {}
      : { planningInterview: checkedRequestPlanningInterview(input.planningInterview) }),
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
  assertNotAbandoned(record);
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
  assertNotAbandoned(record);
  if (record.planningInterview?.status === "active") {
    throw new RequestBriefError(
      "planning-interview-incomplete",
      `Request ${record.id} planning interview must be complete before brief approval`,
      record.id,
    );
  }
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

/**
 * Records that the user dropped this request. Only a brief awaiting approval with no unfinished
 * work under it can be abandoned: an approved agreement, or one whose tasks still run, is ended by
 * cancelling that work, so abandoning never strands a task under a request nobody owns.
 */
export function abandonRequestBriefRecord(
  record: RequestBriefRecord,
  tasks: readonly Pick<TaskRecord, "id" | "requestId" | "stage">[],
  now: IsoTimestamp,
): RequestBriefRecord {
  const timestamp = checkedLine(now, "timestamp");
  assertNotAbandoned(record);
  if (requestApprovalState(record) === "current") {
    throw new RequestBriefError(
      "request-in-use",
      `Request ${record.id} is approved; cancel its work instead of abandoning it`,
      record.id,
    );
  }
  const unfinished = tasks.filter(
    (task) => task.requestId === record.id && !FINISHED_STAGES.includes(task.stage),
  );
  if (unfinished.length > 0) {
    throw new RequestBriefError(
      "request-in-use",
      `Request ${record.id} still has unfinished tasks (${unfinished.map((task) => task.id).join(", ")}); cancel them first`,
      record.id,
    );
  }
  return { ...record, revision: record.revision + 1, updatedAt: timestamp, abandonedAt: timestamp };
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

/** A brief whose current draft nobody approved, new or changed after approval, and not dropped. */
export function awaitsApproval(record: RequestBriefRecord): boolean {
  return record.abandonedAt === undefined && requestApprovalState(record) !== "current";
}

/**
 * The one request whose brief is awaiting approval, so an approver need not name it. Fails closed
 * rather than guessing: an approval must never land on a request the caller did not mean, so zero
 * or several candidates are both refused with the exact ids, for the caller to name one explicitly.
 */
export function singlePendingApprovalId(records: readonly RequestBriefRecord[]): string {
  const pending = records.filter(awaitsApproval);
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

/** How long an approved request may wait for its first task before it stops counting as open. */
const UNSTARTED_REQUEST_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The request new implementation work in this repository belongs to when the coordinator named
 * none: the one approved request whose work is not finished. An approved request that got no task
 * within three days has lapsed and is skipped. None means the work stands alone; several means it
 * cannot be attributed safely, so the coordinator must name one.
 */
export function openRequestForNewWork(
  records: readonly RequestBriefRecord[],
  tasks: readonly Pick<TaskRecord, "requestId" | "stage">[],
  repoPath: string,
  now: string,
): string | undefined {
  const finished = (task: Pick<TaskRecord, "stage">): boolean =>
    FINISHED_STAGES.includes(task.stage);
  const open = records.filter((record) => {
    if (record.repoPath !== repoPath || requestApprovalState(record) !== "current") return false;
    const governed = tasks.filter((task) => task.requestId === record.id);
    if (governed.length > 0) return !governed.every(finished);
    const approvedAt =
      record.approval === undefined ? Number.NaN : Date.parse(record.approval.approvedAt);
    return Date.parse(now) - approvedAt <= UNSTARTED_REQUEST_EXPIRY_MS;
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
  if (record.abandonedAt !== undefined) {
    return {
      allowed: false,
      reason: `Request ${record.id} was abandoned on ${record.abandonedAt}`,
    };
  }
  if (record.planningInterview?.status === "active") {
    return {
      allowed: false,
      reason: `Request ${record.id} still has an active planning interview`,
    };
  }
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

/** The tasks a request prevents from dispatching, named without touching any of them. */
export function tasksBlockedByRequest(
  record: RequestBriefRecord,
  tasks: readonly Pick<TaskRecord, "id" | "requestId" | "stage">[],
): readonly string[] {
  if (decideRequestDispatch(record).allowed) return [];
  return tasks
    .filter((task) => task.requestId === record.id && PAUSABLE_STAGES.includes(task.stage))
    .map((task) => task.id);
}

export function assertNotAbandoned(record: RequestBriefRecord): void {
  if (record.abandonedAt !== undefined) {
    throw new RequestBriefError(
      "request-abandoned",
      `Request ${record.id} was abandoned on ${record.abandonedAt}; draft a new request instead`,
      record.id,
    );
  }
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
  if (content.planningAnswers !== undefined && content.planningAnswers.length > 0) {
    agreement.push({ planningAnswers: content.planningAnswers });
  }
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
