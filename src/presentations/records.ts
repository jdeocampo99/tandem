import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { PresentationObservation } from "../adapters/lavish.ts";
import {
  type AgentRole,
  type Endpoint,
  isAgentRole,
  type NotificationKind,
  type TaskQuestion,
} from "../contracts.ts";
import { MAX_TASK_MESSAGE_CHARS } from "../tasks/communication-protocol.ts";
export type PendingPresentationNotification = Readonly<{
  readonly id: string;
  readonly message: string;
  readonly kind: NotificationKind;
}>;

export type PresentationRecord = Readonly<{
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly cwd: string;
  readonly artifactPath: string;
  readonly jobPath: string;
  readonly resultPath: string;
  readonly status: "queued" | "running" | "blocked" | "open" | "ended" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endpoint?: Endpoint;
  readonly sessionUrl?: string;
  readonly observation?: PresentationObservation;
  readonly question?: TaskQuestion;
  readonly pendingNotification?: PendingPresentationNotification;
  readonly pendingNotificationQueue?: readonly PendingPresentationNotification[];
  readonly error?: string;
}>;

export type PresentationFeedbackEvidence = Readonly<{
  readonly schemaVersion: 1;
  readonly presentationId: string;
  readonly eventId: string;
  readonly observedAt: string;
  readonly observation: PresentationObservation;
}>;

export type ValidatedRecordPaths = Readonly<{
  readonly cwd: string;
  readonly artifactPath: string;
  readonly jobPath: string;
  readonly resultPath: string;
}>;

const MAX_NOTIFICATION_BYTES = 4_000;
const ARTIFACT_FILE = "artifact.html";
const JOB_FILE = "job.json";
const RESULT_FILE = "result.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text without NUL characters`);
  }
  return value.trim();
}

function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function pathText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty path without NUL characters`);
  }
  if (hasPathControlCharacter(value)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  return value;
}

function singleLine(value: unknown, field: string): string {
  const result = text(value, field);
  if (/[\r\n\u2028\u2029]/u.test(result)) throw new TypeError(`${field} must be single-line`);
  return result;
}

function absoluteDirectory(value: unknown, field: string): string {
  const result = pathText(value, field);
  if (!isAbsolute(result)) throw new TypeError(`${field} must be absolute`);
  return resolve(result);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function parseQuestion(value: unknown, field: string): TaskQuestion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (key !== "id" && key !== "text" && key !== "recommendation") {
      throw new TypeError(`${field} contains unknown field ${key}`);
    }
  }
  const id = singleLine(candidate.id, `${field}.id`);
  const question = singleLine(candidate.text, `${field}.text`);
  if (question.length > MAX_TASK_MESSAGE_CHARS) {
    throw new TypeError(`${field}.text exceeds the ${MAX_TASK_MESSAGE_CHARS}-character limit`);
  }
  const recommendation =
    candidate.recommendation === undefined
      ? undefined
      : singleLine(candidate.recommendation, `${field}.recommendation`);
  if (recommendation !== undefined && recommendation.length > MAX_TASK_MESSAGE_CHARS) {
    throw new TypeError(
      `${field}.recommendation exceeds the ${MAX_TASK_MESSAGE_CHARS}-character limit`,
    );
  }
  return {
    id,
    text: question,
    ...(recommendation === undefined ? {} : { recommendation }),
  };
}
export function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text without NUL characters`);
  }
  return value.trim();
}

export function readSingleLine(value: unknown, field: string): string {
  const text = readText(value, field);
  if (/[\r\n\u2028\u2029]/u.test(text)) throw new TypeError(`${field} must be single-line value`);
  return text;
}
export function readAbsolutePath(value: unknown, field: string): string {
  const path = readSingleLine(value, field);
  if (!isAbsolute(path)) throw new TypeError(`${field} must be absolute`);
  return resolve(path);
}

export function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith("../") && !isAbsolute(relativePath))
  );
}

export function validateRecordPaths(record: PresentationRecord): ValidatedRecordPaths {
  const cwd = readAbsolutePath(record.cwd, "record.cwd");
  const artifactPath = readAbsolutePath(record.artifactPath, "record.artifactPath");
  const jobPath = readAbsolutePath(record.jobPath, "record.jobPath");
  const resultPath = readAbsolutePath(record.resultPath, "record.resultPath");
  if (!isWithin(cwd, artifactPath) || !isWithin(cwd, jobPath) || !isWithin(cwd, resultPath)) {
    throw new Error("presentation paths must remain inside the private artifact directory");
  }
  return { cwd, artifactPath, jobPath, resultPath };
}

export function validateRecord(record: PresentationRecord): ValidatedRecordPaths {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("record must be a PresentationRecord");
  }
  readSingleLine(record.id, "record.id");
  readSingleLine(record.taskId, "record.taskId");
  if (!Number.isSafeInteger(record.generation) || record.generation < 0) {
    throw new TypeError("record.generation must be a non-negative integer");
  }
  const statuses: readonly PresentationRecord["status"][] = [
    "queued",
    "running",
    "blocked",
    "open",
    "ended",
    "failed",
  ];
  if (!statuses.includes(record.status)) throw new TypeError("record.status is unsupported");
  readSingleLine(record.createdAt, "record.createdAt");
  readSingleLine(record.updatedAt, "record.updatedAt");
  if (record.sessionUrl !== undefined) readSingleLine(record.sessionUrl, "record.sessionUrl");
  if (record.question !== undefined) parseQuestion(record.question, "record.question");
  const pendingNotifications = [
    ...(record.pendingNotification === undefined ? [] : [record.pendingNotification]),
    ...(record.pendingNotificationQueue ?? []),
  ];
  for (const pending of pendingNotifications) {
    readSingleLine(pending.id, "record pending notification id");
    readText(pending.message, "record pending notification message");
    if (pending.kind !== "routine" && pending.kind !== "coordinator") {
      throw new TypeError("record pending notification kind is unsupported");
    }
  }
  if (record.error !== undefined) readText(record.error, "record.error");
  return validateRecordPaths(record);
}

export function statusForObservation(
  observation: PresentationObservation,
): PresentationRecord["status"] {
  if (observation.status === "error" || observation.status === "missing") return "failed";
  if (observation.terminal || observation.status === "ended" || observation.status === "user-ended")
    return "ended";
  return "open";
}

export function observationError(observation: PresentationObservation): string | undefined {
  if (observation.status !== "error" && observation.status !== "missing") return undefined;
  return observation.raw.trim().length > 0
    ? observation.raw
    : `Lavish presentation reported ${observation.status}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return String(error);
}

export function failedRecord(
  record: PresentationRecord,
  now: string,
  error: unknown,
): PresentationRecord {
  return {
    ...record,
    status: "failed",
    updatedAt: now,
    error: describeError(error),
  };
}

export function clearRecordError(record: PresentationRecord): Omit<PresentationRecord, "error"> {
  const { error: _error, ...withoutError } = record;
  return withoutError;
}

function boundedNotificationText(value: string, limit = MAX_NOTIFICATION_BYTES): string {
  const normalized = value.trim();
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (normalized.length <= boundedLimit) return normalized;
  const suffix = "…";
  if (boundedLimit <= suffix.length) return normalized.slice(0, boundedLimit);
  return `${normalized.slice(0, boundedLimit - suffix.length)}${suffix}`;
}

export function presentationNotificationForTransition(
  previous: PresentationRecord,
  next: PresentationRecord,
  feedbackEvidencePath?: string,
): Pick<PendingPresentationNotification, "message" | "kind"> | undefined {
  const previousObservation = previous.observation;
  const observation = next.observation;
  if (next.status === "blocked") {
    if (previous.status === "blocked" && previous.question?.id === next.question?.id)
      return undefined;
    const questionId = boundedNotificationText(
      next.question?.id ?? next.id,
      MAX_NOTIFICATION_BYTES,
    );
    const question = boundedNotificationText(
      next.question?.text ?? "presentation worker needs a decision",
      MAX_TASK_MESSAGE_CHARS,
    );
    const recommendation =
      next.question?.recommendation === undefined
        ? ""
        : ` Recommendation: ${boundedNotificationText(next.question.recommendation, MAX_TASK_MESSAGE_CHARS)}`;
    return {
      message: `Presentation ${next.id} needs a decision (question ${questionId}): ${question}${recommendation}`,
      kind: "coordinator",
    };
  }
  if (next.status === "failed") {
    if (previous.status === "failed" && previous.error === next.error) return undefined;
    const detail = boundedNotificationText(
      next.error ?? "the presentation controller reported an error",
    );
    return {
      message: `Presentation ${next.id} failed: ${detail}`,
      kind: "coordinator",
    };
  }
  if (observation === undefined) return undefined;
  if (observation.status === "feedback") {
    const terminalSuffix = next.status === "ended" ? " and the session ended" : "";
    const prefix =
      feedbackEvidencePath === undefined
        ? `Presentation ${next.id} received feedback${terminalSuffix}:`
        : `${feedbackEvidencePath} — Presentation ${next.id} feedback evidence${terminalSuffix}:`;
    const excerptLimit =
      feedbackEvidencePath === undefined
        ? MAX_NOTIFICATION_BYTES
        : MAX_NOTIFICATION_BYTES - prefix.length - 1;
    const feedback = boundedNotificationText(observation.rawFeedback, excerptLimit);
    if (feedbackEvidencePath !== undefined) {
      return {
        message: feedback.length === 0 ? prefix : `${prefix}\n${feedback}`,
        kind: "coordinator",
      };
    }
    if (feedback.length > 0) {
      return {
        message: `${prefix}\n${feedback}`,
        kind: "coordinator",
      };
    }
  }
  if (observation.status === "browser_disconnected") {
    if (
      previousObservation?.status === "browser_disconnected" &&
      previousObservation.raw === observation.raw
    )
      return undefined;
    const location = next.sessionUrl === undefined ? "" : ` at ${next.sessionUrl}`;
    const base = `Presentation ${next.id} lost its browser connection${location}; it remains resumable and was not reopened.`;
    const raw = boundedNotificationText(observation.raw);
    return {
      message: raw.length === 0 ? base : `${base}\n${raw}`,
      kind: "coordinator",
    };
  }
  if (
    observation.status === "opened" ||
    observation.status === "ready" ||
    observation.status === "user-ended"
  ) {
    if (
      previousObservation?.status === observation.status &&
      previousObservation.raw === observation.raw
    )
      return undefined;
    const detail =
      observation.status === "user-ended"
        ? "was ended by the user; no reopen was attempted."
        : next.sessionUrl === undefined
          ? "is ready."
          : `is ready at ${next.sessionUrl}.`;
    const raw = boundedNotificationText(observation.raw);
    return {
      message:
        raw.length === 0
          ? `Presentation ${next.id} ${detail}`
          : `Presentation ${next.id} ${detail}\n${raw}`,
      kind: "routine",
    };
  }
  if (next.status !== "ended") return undefined;
  if (
    previous.status === "ended" &&
    previousObservation?.status === observation.status &&
    previousObservation.raw === observation.raw
  )
    return undefined;
  return {
    message:
      next.sessionUrl === undefined
        ? `Presentation ${next.id} ended.`
        : `Presentation ${next.id} ended at ${next.sessionUrl}.`,
    kind: "routine",
  };
}

export function parseEndpointValue(value: unknown, field: string): Endpoint {
  if (!isRecord(value)) throw new TypeError(`${field} must be an endpoint object`);
  const role = value.role;
  if (!isAgentRole(role)) throw new TypeError(`${field}.role is invalid`);
  const generation = value.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0)
    throw new TypeError(`${field}.generation is invalid`);
  return {
    sessionId: singleLine(value.sessionId, `${field}.sessionId`),
    workspaceId: singleLine(value.workspaceId, `${field}.workspaceId`),
    tabId: singleLine(value.tabId, `${field}.tabId`),
    paneId: singleLine(value.paneId, `${field}.paneId`),
    role: role as AgentRole,
    generation: generation as number,
  };
}
export function presentationPendingNotifications(
  record: Pick<PresentationRecord, "pendingNotification" | "pendingNotificationQueue">,
): readonly PendingPresentationNotification[] {
  const queued = record.pendingNotificationQueue ?? [];
  return record.pendingNotification === undefined
    ? queued
    : [record.pendingNotification, ...queued];
}

export function hasPendingPresentationNotification(
  record: Pick<PresentationRecord, "pendingNotification" | "pendingNotificationQueue">,
): boolean {
  return presentationPendingNotifications(record).length > 0;
}

export function samePresentationRecord(
  left: PresentationRecord,
  right: PresentationRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function parsePresentationObservation(
  value: unknown,
  source: string,
): PresentationObservation {
  if (!isRecord(value)) throw new TypeError(`${source} must be an observation object`);
  const statuses: readonly PresentationObservation["status"][] = [
    "feedback",
    "ended",
    "waiting",
    "missing",
    "unknown",
    "error",
    "browser_disconnected",
    "opened",
    "ready",
    "user-ended",
  ];
  const status = value.status;
  if (
    typeof status !== "string" ||
    !statuses.includes(status as PresentationObservation["status"])
  ) {
    throw new TypeError(`${source}.status is invalid`);
  }
  const readRaw = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== "string" || raw.includes("\0"))
      throw new TypeError(`${source}.${field} must be text`);
    return raw;
  };
  const terminal = value.terminal;
  const sessionEnded = value.sessionEnded;
  const sessionUrl =
    value.sessionUrl === undefined
      ? undefined
      : singleLine(value.sessionUrl, `${source}.sessionUrl`);
  if (typeof terminal !== "boolean" || typeof sessionEnded !== "boolean") {
    throw new TypeError(`${source}.terminal and ${source}.sessionEnded must be booleans`);
  }
  return {
    artifact: absoluteDirectory(value.artifact, `${source}.artifact`),
    status: status as PresentationObservation["status"],
    terminal,
    sessionEnded,
    ...(sessionUrl === undefined ? {} : { sessionUrl }),
    raw: readRaw("raw"),
    rawFeedback: readRaw("rawFeedback"),
  };
}

export function parsePendingPresentationNotification(
  value: unknown,
  source: string,
): PendingPresentationNotification {
  if (!isRecord(value)) throw new TypeError(`${source} must be an object`);
  const id = singleLine(value.id, `${source}.id`);
  const message = text(value.message, `${source}.message`);
  const kind = value.kind;
  if (kind !== "routine" && kind !== "coordinator") {
    throw new TypeError(`${source}.kind is invalid`);
  }
  return { id, message, kind };
}

export function parsePendingPresentationNotificationQueue(
  value: unknown,
  source: string,
): readonly PendingPresentationNotification[] {
  if (!Array.isArray(value)) throw new TypeError(`${source} must be an array`);
  return value.map((entry, index) =>
    parsePendingPresentationNotification(entry, `${source}[${index}]`),
  );
}

export function parsePresentationRecord(value: unknown, source: string): PresentationRecord {
  if (!isRecord(value)) throw new TypeError(`${source} must be an object`);
  const statuses: readonly PresentationRecord["status"][] = [
    "queued",
    "running",
    "blocked",
    "open",
    "ended",
    "failed",
  ];
  const status = value.status;
  if (typeof status !== "string" || !statuses.includes(status as PresentationRecord["status"])) {
    throw new TypeError(`${source}.status is invalid`);
  }
  const endpoint =
    value.endpoint === undefined
      ? undefined
      : parseEndpointValue(value.endpoint, `${source}.endpoint`);
  const observation =
    value.observation === undefined
      ? undefined
      : parsePresentationObservation(value.observation, `${source}.observation`);
  const sessionUrl =
    value.sessionUrl === undefined
      ? observation?.sessionUrl
      : singleLine(value.sessionUrl, `${source}.sessionUrl`);
  const question =
    value.question === undefined ? undefined : parseQuestion(value.question, `${source}.question`);
  const pendingNotification =
    value.pendingNotification === undefined
      ? undefined
      : parsePendingPresentationNotification(
          value.pendingNotification,
          `${source}.pendingNotification`,
        );
  const pendingNotificationQueue =
    value.pendingNotificationQueue === undefined
      ? undefined
      : parsePendingPresentationNotificationQueue(
          value.pendingNotificationQueue,
          `${source}.pendingNotificationQueue`,
        );
  const error = value.error === undefined ? undefined : text(value.error, `${source}.error`);
  return {
    id: singleLine(value.id, `${source}.id`),
    taskId: singleLine(value.taskId, `${source}.taskId`),
    generation: nonNegativeInteger(value.generation, `${source}.generation`),
    cwd: absoluteDirectory(value.cwd, `${source}.cwd`),
    artifactPath: absoluteDirectory(value.artifactPath, `${source}.artifactPath`),
    jobPath: absoluteDirectory(value.jobPath, `${source}.jobPath`),
    resultPath: absoluteDirectory(value.resultPath, `${source}.resultPath`),
    status: status as PresentationRecord["status"],
    createdAt: singleLine(value.createdAt, `${source}.createdAt`),
    updatedAt: singleLine(value.updatedAt, `${source}.updatedAt`),
    ...(question === undefined ? {} : { question }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(sessionUrl === undefined ? {} : { sessionUrl }),
    ...(observation === undefined ? {} : { observation }),
    ...(pendingNotification === undefined ? {} : { pendingNotification }),
    ...(pendingNotificationQueue === undefined ? {} : { pendingNotificationQueue }),
    ...(error === undefined ? {} : { error }),
  };
}

export async function readPresentationRecord(path: string): Promise<PresentationRecord> {
  const contents = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TypeError(`presentation record is invalid JSON: ${describeError(error)}`);
  }
  return parsePresentationRecord(parsed, path);
}
export { ARTIFACT_FILE, JOB_FILE, RESULT_FILE };
