import type {
  IsoTimestamp,
  TaskCommunication,
  TaskInbox,
  TaskMessage,
  TaskQuestion,
  WorkerReceipt,
} from "../contracts.ts";

export const MAX_TASK_MESSAGE_CHARS = 1_000;
export const MAX_ACTIVE_TASK_MESSAGE_CHARS = 6_000;
const MAX_ACTIVE_TASK_PAYLOAD_CHARS = 12_000;
export const TASK_COMMUNICATION_MARKER = "TANDEM_TASK_COMMUNICATION_V1";

const MAX_IDENTIFIER_CHARS = 256;
const MAX_TOOL_CHARS = 256;

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: JsonRecord, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${field} contains unknown field ${key}`);
  }
}

export function readSingleLine(
  value: unknown,
  field: string,
  maxChars = MAX_IDENTIFIER_CHARS,
): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  if (value.includes("\0") || /[\r\n\u2028\u2029]/u.test(value)) {
    throw new TypeError(`${field} must be a single-line value without NUL characters`);
  }
  if (value.length > maxChars)
    throw new TypeError(`${field} exceeds the ${maxChars}-character limit`);
  return value;
}

export function readIdentifier(value: unknown, field: string): string {
  return readSingleLine(value, field);
}

export function readSafeTaskId(value: unknown, field: string): string {
  const id = readIdentifier(value, field);
  if (id === "." || id === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
    throw new TypeError(`${field} must be a safe task identifier`);
  }
  return id;
}

export function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function readBoundedText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  if (value.includes("\0")) throw new TypeError(`${field} must not contain NUL characters`);
  if (value.length > maxChars)
    throw new TypeError(`${field} exceeds the ${maxChars}-character limit`);
  return value;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function readMessageText(value: unknown, field: string): string {
  return readBoundedText(value, field, MAX_TASK_MESSAGE_CHARS);
}

function readTimestamp(value: unknown, field: string): IsoTimestamp {
  const timestamp = readSingleLine(value, field, 128);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new TypeError(`${field} must be an ISO timestamp`);
  return timestamp;
}

function readOptionalString(value: unknown, field: string, maxChars: number): string | undefined {
  return value === undefined ? undefined : readSingleLine(value, field, maxChars);
}

function readMessage(value: unknown, field: string): TaskMessage {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  assertExactKeys(
    value,
    ["id", "revision", "kind", "text", "createdAt", "supersedes", "replyTo"],
    field,
  );
  const id = readIdentifier(value.id, `${field}.id`);
  const revision = readPositiveInteger(value.revision, `${field}.revision`);
  if (value.kind !== "instruction" && value.kind !== "answer") {
    throw new TypeError(`${field}.kind must be instruction or answer`);
  }
  const text = readMessageText(value.text, `${field}.text`);
  const createdAt = readTimestamp(value.createdAt, `${field}.createdAt`);
  const supersedes =
    value.supersedes === undefined
      ? undefined
      : readReferences(value.supersedes, `${field}.supersedes`);
  const replyTo = readOptionalString(value.replyTo, `${field}.replyTo`, MAX_IDENTIFIER_CHARS);
  if (value.kind === "answer" && replyTo === undefined) {
    throw new TypeError(`${field}.replyTo is required for answer messages`);
  }
  return {
    id,
    revision,
    kind: value.kind,
    text,
    createdAt,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(replyTo === undefined ? {} : { replyTo }),
  };
}

function readReferences(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of ids`);
  const references: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const reference = readIdentifier(value[index], `${field}[${index}]`);
    if (seen.has(reference)) throw new TypeError(`${field} contains duplicate id ${reference}`);
    seen.add(reference);
    references.push(reference);
  }
  return references;
}

function readQuestion(value: unknown, field = "question"): TaskQuestion {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  assertExactKeys(value, ["id", "text", "recommendation"], field);
  const id = readIdentifier(value.id, `${field}.id`);
  const text = readMessageText(value.text, `${field}.text`);
  const recommendation =
    value.recommendation === undefined
      ? undefined
      : readMessageText(value.recommendation, `${field}.recommendation`);
  return {
    id,
    text,
    ...(recommendation === undefined ? {} : { recommendation }),
  };
}

function activeMessages(messages: readonly TaskMessage[]): readonly TaskMessage[] {
  const superseded = new Set<string>();
  for (const message of messages) {
    for (const id of message.supersedes ?? []) superseded.add(id);
  }
  return messages.filter((message) => !superseded.has(message.id));
}

function activeMessageCharacters(messages: readonly TaskMessage[]): number {
  let total = 0;
  for (const message of activeMessages(messages)) total += message.text.length;
  return total;
}

function ensureActiveMessageLimit(messages: readonly TaskMessage[]): void {
  if (activeMessageCharacters(messages) > MAX_ACTIVE_TASK_MESSAGE_CHARS) {
    throw new TypeError(
      `active task communication exceeds the ${MAX_ACTIVE_TASK_MESSAGE_CHARS}-character limit`,
    );
  }
}
function ensureActiveMessagePayloadLimit(messages: readonly TaskMessage[]): void {
  const serialized = JSON.stringify({ messages: activeMessages(messages) });
  if (serialized.length > MAX_ACTIVE_TASK_PAYLOAD_CHARS) {
    throw new TypeError(
      `active task communication metadata exceeds ${MAX_ACTIVE_TASK_PAYLOAD_CHARS} characters; supersede obsolete directions`,
    );
  }
}

function readCanonicalMessages(value: unknown): readonly TaskMessage[] {
  if (!Array.isArray(value)) throw new TypeError("messages must be an array");
  const messages: TaskMessage[] = [];
  const ids = new Set<string>();
  let previousRevision = 0;
  for (let index = 0; index < value.length; index += 1) {
    const message = readMessage(value[index], `messages[${index}]`);
    if (ids.has(message.id)) throw new TypeError(`messages contains duplicate id ${message.id}`);
    if (message.revision <= previousRevision) {
      throw new TypeError("message revisions must be strictly increasing");
    }
    ids.add(message.id);
    previousRevision = message.revision;
    messages.push(message);
  }
  for (const message of messages) {
    for (const reference of message.supersedes ?? []) {
      const target = messages.find((candidate) => candidate.id === reference);
      if (target === undefined || target.revision >= message.revision) {
        throw new TypeError(`${message.id} supersedes an unknown or later message ${reference}`);
      }
    }
  }
  ensureActiveMessageLimit(messages);
  ensureActiveMessagePayloadLimit(messages);
  return messages;
}

export function parseTaskCommunication(value: unknown): TaskCommunication {
  if (!isRecord(value)) throw new TypeError("task communication must be an object");
  assertExactKeys(value, ["revision", "messages", "question"], "task communication");
  const revision = readNonNegativeInteger(value.revision, "revision");
  const messages = readCanonicalMessages(value.messages);
  if (messages.length === 0) {
    if (revision !== 0) throw new TypeError("empty task communication must have revision 0");
  } else {
    const last = messages[messages.length - 1];
    if (last === undefined || last.revision !== revision) {
      throw new TypeError("communication revision must equal the latest message revision");
    }
  }
  const question = value.question === undefined ? undefined : readQuestion(value.question);
  return {
    revision,
    messages,
    ...(question === undefined ? {} : { question }),
  };
}

export function activeTaskMessages(
  communication: TaskCommunication | undefined,
): readonly TaskMessage[] {
  if (communication === undefined) return [];
  const parsed = parseTaskCommunication(communication);
  const superseded = new Set<string>();
  for (const message of parsed.messages) {
    for (const id of message.supersedes ?? []) superseded.add(id);
  }
  return parsed.messages.filter((message) => !superseded.has(message.id));
}

export function appendTaskMessage(
  communication: TaskCommunication | undefined,
  message: Omit<TaskMessage, "revision">,
): TaskCommunication {
  const current =
    communication === undefined
      ? parseTaskCommunication({ revision: 0, messages: [] })
      : parseTaskCommunication(communication);
  if (!isRecord(message)) throw new TypeError("task message must be an object");
  const revision = current.revision + 1;
  if (!Number.isSafeInteger(revision) || revision <= 0)
    throw new TypeError("message revision overflow");
  const candidate = readMessage({ ...message, revision }, "message");
  const existingIds = new Set(current.messages.map((item) => item.id));
  for (const reference of candidate.supersedes ?? []) {
    if (!existingIds.has(reference)) {
      throw new TypeError(`message supersedes an unknown message ${reference}`);
    }
  }
  if (candidate.kind === "answer") {
    if (current.question === undefined) throw new TypeError("answer has no current question");
    if (candidate.replyTo !== current.question.id) {
      throw new TypeError("answer must reply to the current question");
    }
  }
  const messages = [...current.messages, candidate];
  ensureActiveMessageLimit(messages);
  ensureActiveMessagePayloadLimit(messages);
  return {
    revision,
    messages,
    ...(candidate.kind === "answer"
      ? {}
      : current.question === undefined
        ? {}
        : { question: current.question }),
  };
}

export function parseTaskInbox(value: unknown): TaskInbox {
  if (!isRecord(value)) throw new TypeError("task inbox must be an object");
  assertExactKeys(value, ["schemaVersion", "taskId", "revision", "messages"], "task inbox");
  if (value.schemaVersion !== 1) throw new TypeError("task inbox schemaVersion must be 1");
  const taskId = readSafeTaskId(value.taskId, "taskId");
  const revision = readNonNegativeInteger(value.revision, "revision");
  if (!Array.isArray(value.messages)) throw new TypeError("task inbox messages must be an array");
  const messages: TaskMessage[] = [];
  const ids = new Set<string>();
  let previousRevision = 0;
  for (let index = 0; index < value.messages.length; index += 1) {
    const message = readMessage(value.messages[index], `messages[${index}]`);
    if (
      ids.has(message.id) ||
      message.revision <= previousRevision ||
      message.revision > revision
    ) {
      throw new TypeError("inbox message revisions must be ordered and bounded by revision");
    }
    ids.add(message.id);
    previousRevision = message.revision;
    messages.push(message);
  }
  if (messages.length === 0 && revision !== 0) {
    throw new TypeError("an empty task inbox must have revision 0");
  }
  if (messages.length > 0 && messages[messages.length - 1]?.revision !== revision) {
    throw new TypeError("inbox revision must equal the latest message revision");
  }
  ensureActiveMessageLimit(messages);
  ensureActiveMessagePayloadLimit(messages);
  return { schemaVersion: 1, taskId, revision, messages };
}

export function taskInbox(taskId: string, communication: TaskCommunication | undefined): TaskInbox {
  const safeTaskId = readSafeTaskId(taskId, "taskId");
  const parsed =
    communication === undefined
      ? parseTaskCommunication({ revision: 0, messages: [] })
      : parseTaskCommunication(communication);
  return {
    schemaVersion: 1,
    taskId: safeTaskId,
    revision: parsed.revision,
    messages: activeTaskMessages(parsed),
  };
}

export function parseWorkerReceipt(value: unknown): WorkerReceipt {
  if (!isRecord(value)) throw new TypeError("worker receipt must be an object");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "jobId",
      "taskId",
      "generation",
      "receivedRevision",
      "appliedRevision",
      "heartbeatAt",
      "progressAt",
      "phase",
      "tool",
    ],
    "worker receipt",
  );
  if (value.schemaVersion !== 1) throw new TypeError("worker receipt schemaVersion must be 1");
  const jobId = readIdentifier(value.jobId, "jobId");
  const taskId = readIdentifier(value.taskId, "taskId");
  const generation = readNonNegativeInteger(value.generation, "generation");
  const receivedRevision = readNonNegativeInteger(value.receivedRevision, "receivedRevision");
  const appliedRevision = readNonNegativeInteger(value.appliedRevision, "appliedRevision");
  if (appliedRevision > receivedRevision) {
    throw new TypeError("appliedRevision cannot exceed receivedRevision");
  }
  const heartbeatAt = readTimestamp(value.heartbeatAt, "heartbeatAt");
  const progressAt = readTimestamp(value.progressAt, "progressAt");
  if (
    value.phase !== "starting" &&
    value.phase !== "model" &&
    value.phase !== "tool" &&
    value.phase !== "idle" &&
    value.phase !== "finished"
  ) {
    throw new TypeError("worker receipt phase is invalid");
  }
  const tool =
    value.tool === undefined ? undefined : readSingleLine(value.tool, "tool", MAX_TOOL_CHARS);
  return {
    schemaVersion: 1,
    jobId,
    taskId,
    generation,
    receivedRevision,
    appliedRevision,
    heartbeatAt,
    progressAt,
    phase: value.phase,
    ...(tool === undefined ? {} : { tool }),
  };
}

export type TaskMessageBatch = Readonly<{
  readonly taskId: string;
  readonly revision: number;
  readonly messages: readonly TaskMessage[];
}>;

export function parseTaskMessageBatch(value: unknown): TaskMessageBatch {
  if (!isRecord(value)) throw new TypeError("task message batch must be an object");
  assertExactKeys(value, ["taskId", "revision", "messages"], "task message batch");
  const taskId = readSafeTaskId(value.taskId, "taskId");
  const revision = readNonNegativeInteger(value.revision, "revision");
  if (!Array.isArray(value.messages))
    throw new TypeError("task message batch messages must be an array");
  const messages: TaskMessage[] = [];
  const ids = new Set<string>();
  let previousRevision = 0;
  for (let index = 0; index < value.messages.length; index += 1) {
    const message = readMessage(value.messages[index], `messages[${index}]`);
    if (
      ids.has(message.id) ||
      message.revision <= previousRevision ||
      message.revision > revision
    ) {
      throw new TypeError("task message batch revisions or ids are invalid");
    }
    ids.add(message.id);
    previousRevision = message.revision;
    messages.push(message);
  }
  if (messages.length === 0 && revision !== 0) {
    throw new TypeError("an empty task message batch must have revision 0");
  }
  if (messages.length > 0 && messages[messages.length - 1]?.revision !== revision) {
    throw new TypeError("task message batch revision must equal the latest message revision");
  }
  ensureActiveMessageLimit(messages);
  ensureActiveMessagePayloadLimit(messages);
  return { taskId, revision, messages };
}

export function formatTaskMessages(
  taskId: string,
  revision: number,
  messages: readonly TaskMessage[],
): string {
  const parsed = parseTaskMessageBatch({ taskId, revision, messages });
  return `${TASK_COMMUNICATION_MARKER} ${JSON.stringify(parsed)}`;
}
