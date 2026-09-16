import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { MAX_TASK_MESSAGE_CHARS } from "./communication.ts";
import type {
  AgentRole,
  Finding,
  FindingSeverity,
  FindingVerdict,
  ModelSpec,
  ReviewLens,
  ReviewResult,
  ThinkingLevel,
} from "./contracts.ts";

export type WorkerRole = Exclude<AgentRole, "coordinator">;

export type WorkerReviewContext = Readonly<{
  readonly head: string;
  readonly lens: ReviewLens;
}>;

export type WorkerJob = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly role: WorkerRole;
  readonly cwd: string;
  readonly model: ModelSpec;
  readonly prompt: string;
  readonly resultPath: string;
  readonly sessionDirectory?: string;
  readonly review?: WorkerReviewContext;
  readonly communication?: Readonly<{
    readonly inboxPath: string;
    readonly receiptPath: string;
    readonly initialRevision: number;
  }>;
  readonly timeoutMs?: number;
}>;
export type WorkerQuestion = Readonly<{
  readonly text: string;
  readonly recommendation?: string;
}>;

export type WorkerStatus = "completed" | "needs-decision" | "failed";

export type WorkerResult = Readonly<{
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly role: WorkerRole;
  readonly status: WorkerStatus;
  readonly text: string;
  readonly review?: ReviewResult;
  readonly artifactPath?: string;
  readonly question?: WorkerQuestion;
  readonly error?: string;
  readonly instructionRevision?: number;
  readonly finishedAt: string;
}>;

export type WorkerResultExpectation = Readonly<{
  readonly id: string;
  readonly generation: number;
  readonly taskId?: string;
  readonly role?: WorkerRole;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${field} must not contain NUL characters`);
  }
  return value;
}

function readSingleLineText(value: unknown, field: string): string {
  const text = readNonEmptyText(value, field);
  if (/[\r\n\u2028\u2029]/u.test(text)) {
    throw new TypeError(`${field} must be a single-line value`);
  }
  return text;
}

function readBoundedSingleLineText(value: unknown, field: string): string {
  const text = readSingleLineText(value, field);
  if (text.length > MAX_TASK_MESSAGE_CHARS) {
    throw new TypeError(`${field} exceeds the ${MAX_TASK_MESSAGE_CHARS}-character limit`);
  }
  return text;
}

function readWorkerQuestion(value: unknown): WorkerQuestion {
  if (!isRecord(value)) throw new TypeError("question must be an object");
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "text" && key !== "recommendation") {
      throw new TypeError(`question contains unknown field ${key}`);
    }
  }
  const text = readBoundedSingleLineText(value.text, "question.text");
  const recommendation =
    value.recommendation === undefined
      ? undefined
      : readBoundedSingleLineText(value.recommendation, "question.recommendation");
  return {
    text,
    ...(recommendation === undefined ? {} : { recommendation }),
  };
}

function readAbsolutePath(value: unknown, field: string): string {
  const path = readSingleLineText(value, field);
  if (!isAbsolute(path)) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return path;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function isWorkerRole(value: unknown): value is WorkerRole {
  switch (value) {
    case "scout":
    case "implementer":
    case "reviewer":
    case "verifier":
    case "presentation":
      return true;
    default:
      return false;
  }
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "auto":
      return true;
    default:
      return false;
  }
}

function isReviewLens(value: unknown): value is ReviewLens {
  switch (value) {
    case "behavior":
    case "design":
    case "coverage":
    case "verification":
      return true;
    default:
      return false;
  }
}

function readModel(value: unknown): ModelSpec {
  if (!isRecord(value)) {
    throw new TypeError("model must be an object");
  }
  const model = readSingleLineText(value.model, "model.model");
  if (!/^[^\s/]+\/[^\s/]+$/u.test(model)) {
    throw new TypeError("model.model must be an exact provider/model selector");
  }
  if (!isThinkingLevel(value.thinking)) {
    throw new TypeError("model.thinking must be a valid thinking level");
  }
  return { model, thinking: value.thinking };
}

function readReviewContext(value: unknown): WorkerReviewContext {
  if (!isRecord(value)) {
    throw new TypeError("review must be an object");
  }
  const head = readSingleLineText(value.head, "review.head");
  if (!isReviewLens(value.lens)) {
    throw new TypeError("review.lens must be a valid review lens");
  }
  return { head, lens: value.lens };
}

function readWorkerCommunication(
  value: unknown,
): Readonly<{ inboxPath: string; receiptPath: string; initialRevision: number }> {
  if (!isRecord(value)) throw new TypeError("communication must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "inboxPath" && key !== "receiptPath" && key !== "initialRevision") {
      throw new TypeError(`communication contains unknown field ${key}`);
    }
  }
  const inboxPath = readAbsolutePath(value.inboxPath, "communication.inboxPath");
  const receiptPath = readAbsolutePath(value.receiptPath, "communication.receiptPath");
  const initialRevision = readNonNegativeInteger(
    value.initialRevision,
    "communication.initialRevision",
  );
  return { inboxPath, receiptPath, initialRevision };
}
function readFinding(value: unknown, index: number): Finding {
  if (!isRecord(value)) {
    throw new TypeError(`review.findings[${index}] must be an object`);
  }
  const id = readSingleLineText(value.id, `review.findings[${index}].id`);
  if (!isFindingSeverity(value.severity)) {
    throw new TypeError(`review.findings[${index}].severity must be P0, P1, P2, or P3`);
  }
  if (!isFindingVerdict(value.verdict)) {
    throw new TypeError(`review.findings[${index}].verdict must be confirmed or plausible`);
  }
  const file =
    value.file === undefined
      ? undefined
      : readSingleLineText(value.file, `review.findings[${index}].file`);
  const line =
    value.line === undefined
      ? undefined
      : readPositiveInteger(value.line, `review.findings[${index}].line`);
  const description = readNonEmptyText(value.description, `review.findings[${index}].description`);

  return line === undefined
    ? file === undefined
      ? { id, severity: value.severity, verdict: value.verdict, description }
      : { id, severity: value.severity, verdict: value.verdict, file, description }
    : file === undefined
      ? { id, severity: value.severity, verdict: value.verdict, line, description }
      : { id, severity: value.severity, verdict: value.verdict, file, line, description };
}

function isFindingSeverity(value: unknown): value is FindingSeverity {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function isFindingVerdict(value: unknown): value is FindingVerdict {
  return value === "confirmed" || value === "plausible";
}

export function parseReviewResult(value: unknown): ReviewResult {
  if (!isRecord(value)) {
    throw new TypeError("review result must be an object");
  }
  if (!isReviewLens(value.lens)) {
    throw new TypeError("review.lens must be a valid review lens");
  }
  const head = readSingleLineText(value.head, "review.head");
  const generation = readNonNegativeInteger(value.generation, "review.generation");
  if (typeof value.pass !== "boolean") {
    throw new TypeError("review.pass must be a boolean");
  }
  if (!Array.isArray(value.findings)) {
    throw new TypeError("review.findings must be an array");
  }
  const findings: Finding[] = [];
  for (let index = 0; index < value.findings.length; index += 1) {
    findings.push(readFinding(value.findings[index], index));
  }
  const summary = readNonEmptyText(value.summary, "review.summary");
  return { lens: value.lens, head, generation, pass: value.pass, findings, summary };
}

export function parseWorkerJob(value: unknown): WorkerJob {
  if (!isRecord(value)) {
    throw new TypeError("worker job must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new TypeError("worker job schemaVersion must be 1");
  }
  const id = readSingleLineText(value.id, "id");
  const taskId = readSingleLineText(value.taskId, "taskId");
  const generation = readNonNegativeInteger(value.generation, "generation");
  if (!isWorkerRole(value.role)) {
    throw new TypeError("role must be a worker role");
  }
  const role = value.role;
  const cwd = readAbsolutePath(value.cwd, "cwd");
  const model = readModel(value.model);
  const prompt = readNonEmptyText(value.prompt, "prompt");
  const resultPath = readAbsolutePath(value.resultPath, "resultPath");
  const sessionDirectory =
    value.sessionDirectory === undefined
      ? undefined
      : readAbsolutePath(value.sessionDirectory, "sessionDirectory");
  if (sessionDirectory !== undefined && role !== "implementer") {
    throw new TypeError("sessionDirectory is only permitted for implementer jobs");
  }
  const review = value.review === undefined ? undefined : readReviewContext(value.review);
  const communication =
    value.communication === undefined ? undefined : readWorkerCommunication(value.communication);
  const timeoutMs =
    value.timeoutMs === undefined ? undefined : readPositiveInteger(value.timeoutMs, "timeoutMs");

  return {
    schemaVersion: 1,
    id,
    taskId,
    generation,
    role,
    cwd,
    model,
    prompt,
    resultPath,
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    ...(review === undefined ? {} : { review }),
    ...(communication === undefined ? {} : { communication }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

export function parseWorkerResult(value: unknown): WorkerResult {
  if (!isRecord(value)) {
    throw new TypeError("worker result must be an object");
  }
  const id = readSingleLineText(value.id, "id");
  const taskId = readSingleLineText(value.taskId, "taskId");
  const generation = readNonNegativeInteger(value.generation, "generation");
  if (!isWorkerRole(value.role)) {
    throw new TypeError("role must be a worker role");
  }
  const role = value.role;
  if (
    value.status !== "completed" &&
    value.status !== "needs-decision" &&
    value.status !== "failed"
  ) {
    throw new TypeError("status must be completed, needs-decision, or failed");
  }
  const status = value.status;
  if (typeof value.text !== "string" || value.text.includes("\0")) {
    throw new TypeError("text must be a string without NUL characters");
  }
  const text = value.text;
  const review = value.review === undefined ? undefined : parseReviewResult(value.review);
  const artifactPath =
    value.artifactPath === undefined
      ? undefined
      : readAbsolutePath(value.artifactPath, "artifactPath");
  const error = value.error === undefined ? undefined : readNonEmptyText(value.error, "error");
  const instructionRevision =
    value.instructionRevision === undefined
      ? undefined
      : readNonNegativeInteger(value.instructionRevision, "instructionRevision");
  const question = value.question === undefined ? undefined : readWorkerQuestion(value.question);
  const finishedAt = readSingleLineText(value.finishedAt, "finishedAt");

  const requiresReview = role === "reviewer" || role === "verifier";
  if (review === undefined && requiresReview && status !== "failed") {
    throw new TypeError("completed review worker result must include review");
  }
  if (review !== undefined && !requiresReview) {
    throw new TypeError("only reviewer and verifier results may include review");
  }
  if (question !== undefined && status !== "needs-decision") {
    throw new TypeError("question is only valid for needs-decision results");
  }

  return {
    id,
    taskId,
    generation,
    role,
    status,
    text,
    ...(review === undefined ? {} : { review }),
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(error === undefined ? {} : { error }),
    ...(instructionRevision === undefined ? {} : { instructionRevision }),
    ...(question === undefined ? {} : { question }),
    finishedAt,
  };
}

function validateExpectedIdentity(value: WorkerResultExpectation): WorkerResultExpectation {
  if (!isRecord(value)) {
    throw new TypeError("expected worker identity must be an object");
  }
  const id = readSingleLineText(value.id, "expected.id");
  const generation = readNonNegativeInteger(value.generation, "expected.generation");
  const taskId =
    value.taskId === undefined ? undefined : readSingleLineText(value.taskId, "expected.taskId");
  const role =
    value.role === undefined ? undefined : isWorkerRole(value.role) ? value.role : undefined;
  if (value.role !== undefined && role === undefined) {
    throw new TypeError("expected.role must be a worker role");
  }
  if (taskId === undefined) {
    if (role === undefined) {
      return { id, generation };
    }
    return { id, generation, role };
  }
  if (role === undefined) {
    return { id, generation, taskId };
  }
  return { id, generation, taskId, role };
}

export async function readWorkerResult(
  resultPath: string,
  expected: WorkerResultExpectation,
): Promise<WorkerResult> {
  const path = readAbsolutePath(resultPath, "resultPath");
  const identity = validateExpectedIdentity(expected);
  const contents = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TypeError(
      `worker result at ${path} is not valid JSON: ${error instanceof Error ? error.message : "parse failure"}`,
    );
  }
  const result = parseWorkerResult(parsed);
  if (result.id !== identity.id || result.generation !== identity.generation) {
    throw new Error("worker result identity is stale");
  }
  if (identity.taskId !== undefined && result.taskId !== identity.taskId) {
    throw new Error("worker result task identity does not match");
  }
  if (identity.role !== undefined && result.role !== identity.role) {
    throw new Error("worker result role does not match");
  }
  return result;
}

export async function persistWorkerResult(resultPath: string, result: WorkerResult): Promise<void> {
  const path = readAbsolutePath(resultPath, "resultPath");
  const validated = parseWorkerResult(result);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
