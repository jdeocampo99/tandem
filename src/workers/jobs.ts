import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  type AgentRole,
  ALL_REVIEW_LENSES,
  FINDING_CATCH_STAGES,
  FINDING_CATEGORIES,
  type Finding,
  type FindingSeverity,
  type FindingVerdict,
  isAgentRole,
  type ModelSpec,
  type ReviewLens,
  type ReviewLevel,
  type ReviewMode,
  type ReviewResult,
  type SetupCommand,
  type StoredReviewLens,
  type ThinkingLevel,
} from "../contracts.ts";
import { DEFAULT_HARNESS, type HarnessName, parseHarnessName } from "../harness/contract.ts";
import { MAX_TASK_MESSAGE_CHARS } from "../tasks/communication-protocol.ts";
import type { TranscriptRef } from "../tasks/timeline.ts";
import type { ExecutionIdentity } from "./execution-gate.ts";

export type WorkerRole = Exclude<AgentRole, "coordinator">;

/**
 * ponytail: a job, result, or durable operation recorded before the verifier role was removed may
 * still carry it; only for decode of that existing data, never for choosing a role for new work.
 */
export type LegacyWorkerRole = WorkerRole | "verifier";

export type WorkerReviewContext = Readonly<{
  readonly head: string;
  readonly lens: ReviewLens;
  /** Which review of the task this is, counting from 1; absent on jobs written before it existed. */
  readonly round?: number;
  /** The round's review level; absent on jobs written before it existed, which read as standard. */
  readonly level?: ReviewLevel;
}>;

export type WorkerJob = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly role: WorkerRole;
  readonly cwd: string;
  /** The harness `model` runs in; jobs written before it existed ran on OMP. */
  readonly harness: HarnessName;
  readonly model: ModelSpec;
  readonly prompt: string;
  readonly resultPath: string;
  readonly execution?: ExecutionIdentity;
  readonly sessionDirectory?: string;
  readonly review?: WorkerReviewContext;
  readonly communication?: Readonly<{
    readonly inboxPath: string;
    readonly receiptPath: string;
    readonly initialRevision: number;
  }>;
  readonly timeoutMs?: number;
  /** The pinned worktree setup commands an implementer runs before OMP starts. */
  readonly setup?: readonly SetupCommand[];
  /** The implementer's playbook steps; its report is rejected while any is open in its to-do list. */
  readonly playbookSteps?: readonly string[];
  /**
   * A scout job reviewing a pull request: it gets a read-only git/gh shell, and when
   * `structuredReport` is set its report must be one PrReview JSON object.
   */
  readonly prReview?: Readonly<{
    readonly structuredReport: boolean;
    /** The run's raw diff; submitted comments must sit on lines it shows. */
    readonly diffPath?: string;
    /** False for an intent review, which posts no inline comments. */
    readonly inlineComments?: boolean;
  }>;
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
  readonly role: LegacyWorkerRole;
  readonly status: WorkerStatus;
  readonly text: string;
  readonly review?: ReviewResult;
  readonly artifactPath?: string;
  readonly question?: WorkerQuestion;
  readonly error?: string;
  readonly instructionRevision?: number;
  /** The conversation entry the worker submitted from; absent when the worker kept no transcript. */
  readonly transcript?: TranscriptRef;
  readonly finishedAt: string;
}>;

export type WorkerResultExpectation = Readonly<{
  readonly id: string;
  readonly generation: number;
  readonly taskId?: string;
  readonly role?: LegacyWorkerRole;
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

export function parseWorkerQuestion(value: unknown): WorkerQuestion {
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

const readWorkerQuestion = parseWorkerQuestion;

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

function readSetupCommands(value: unknown): readonly SetupCommand[] {
  if (!Array.isArray(value)) throw new TypeError("setup must be an array");
  return value.map((entry: unknown, index) => {
    const field = `setup[${index}]`;
    if (!isRecord(entry)) throw new TypeError(`${field} must be an object`);
    const argv = entry.argv;
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new TypeError(`${field}.argv must be a non-empty array`);
    }
    return {
      name: readSingleLineText(entry.name, `${field}.name`),
      argv: argv.map((argument: unknown, argumentIndex) =>
        readNonEmptyText(argument, `${field}.argv[${argumentIndex}]`),
      ),
      timeoutMs: readPositiveInteger(entry.timeoutMs, `${field}.timeoutMs`),
    };
  });
}

function readExecutionIdentity(value: unknown): ExecutionIdentity {
  if (!isRecord(value)) throw new TypeError("execution must be an object");
  for (const key of Object.keys(value)) {
    if (!["schemaVersion", "home", "operationId", "fencingRevision", "claimOwner"].includes(key)) {
      throw new TypeError(`execution contains unknown field ${key}`);
    }
  }
  if (value.schemaVersion !== 1) throw new TypeError("execution.schemaVersion must be 1");
  return {
    schemaVersion: 1,
    home: readAbsolutePath(value.home, "execution.home"),
    operationId: readSingleLineText(value.operationId, "execution.operationId"),
    fencingRevision: readPositiveInteger(value.fencingRevision, "execution.fencingRevision"),
    claimOwner: readSingleLineText(value.claimOwner, "execution.claimOwner"),
  };
}

export function isWorkerRole(value: unknown): value is WorkerRole {
  return isAgentRole(value) && value !== "coordinator";
}

// ponytail: accepts legacy "verifier" too (see LegacyWorkerRole) so a job already in flight when
// the role was removed still decodes.
function isLegacyWorkerRole(value: unknown): value is LegacyWorkerRole {
  return isWorkerRole(value) || value === "verifier";
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
  return value === "review";
}

// ponytail: accepts every legacy lens name too (see ALL_REVIEW_LENSES) so a review result already
// in flight when the lenses were merged still decodes.
function isStoredReviewLens(value: unknown): value is StoredReviewLens {
  return (ALL_REVIEW_LENSES as readonly unknown[]).includes(value);
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
  const round =
    value.round === undefined ? undefined : readPositiveInteger(value.round, "review.round");
  if (value.level !== undefined && value.level !== "light" && value.level !== "standard") {
    throw new TypeError("review.level must be light or standard");
  }
  return {
    head,
    lens: value.lens,
    ...(round === undefined ? {} : { round }),
    ...(value.level === undefined ? {} : { level: value.level }),
  };
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
  const category = readOptionalEnum(
    value.category,
    FINDING_CATEGORIES,
    `review.findings[${index}].category`,
  );
  const catchStage = readOptionalEnum(
    value.catchStage,
    FINDING_CATCH_STAGES,
    `review.findings[${index}].catchStage`,
  );
  return {
    id,
    severity: value.severity,
    verdict: value.verdict,
    description,
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
    ...(category === undefined ? {} : { category }),
    ...(catchStage === undefined ? {} : { catchStage }),
  };
}

function readOptionalEnum<Value extends string>(
  value: unknown,
  values: readonly Value[],
  field: string,
): Value | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`${field} must be one of ${values.join(", ")}`);
  }
  return value as Value;
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
  if (!isStoredReviewLens(value.lens)) {
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
  const mode =
    value.mode === undefined
      ? undefined
      : value.mode === "review_changed_diff" || value.mode === "review_existing_head"
        ? (value.mode as ReviewMode)
        : (() => {
            throw new TypeError("review.mode must be review_changed_diff or review_existing_head");
          })();
  const summary = readNonEmptyText(value.summary, "review.summary");
  return {
    lens: value.lens,
    head,
    generation,
    pass: value.pass,
    findings,
    summary,
    ...(mode === undefined ? {} : { mode }),
  };
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
  const harness =
    value.harness === undefined ? DEFAULT_HARNESS : parseHarnessName(value.harness, "harness");
  const model = readModel(value.model);
  const prompt = readNonEmptyText(value.prompt, "prompt");
  const resultPath = readAbsolutePath(value.resultPath, "resultPath");
  const execution =
    value.execution === undefined ? undefined : readExecutionIdentity(value.execution);
  const sessionDirectory =
    value.sessionDirectory === undefined
      ? undefined
      : readAbsolutePath(value.sessionDirectory, "sessionDirectory");
  if (sessionDirectory !== undefined && role !== "implementer" && role !== "scout") {
    throw new TypeError("sessionDirectory is only permitted for implementer or scout jobs");
  }
  const review = value.review === undefined ? undefined : readReviewContext(value.review);
  const communication =
    value.communication === undefined ? undefined : readWorkerCommunication(value.communication);
  const timeoutMs =
    value.timeoutMs === undefined ? undefined : readPositiveInteger(value.timeoutMs, "timeoutMs");
  const setup = value.setup === undefined ? undefined : readSetupCommands(value.setup);
  if (setup !== undefined && role !== "implementer") {
    throw new TypeError("setup is only permitted for implementer jobs");
  }
  const playbookSteps =
    value.playbookSteps === undefined ? undefined : readPlaybookSteps(value.playbookSteps);
  if (playbookSteps !== undefined && role !== "implementer") {
    throw new TypeError("playbookSteps is only permitted for implementer jobs");
  }
  const prReview = value.prReview === undefined ? undefined : readPrReviewJob(value.prReview);
  if (prReview !== undefined && role !== "scout") {
    throw new TypeError("prReview is only permitted for scout jobs");
  }

  return {
    schemaVersion: 1,
    id,
    taskId,
    generation,
    role,
    cwd,
    harness,
    model,
    prompt,
    resultPath,
    ...(execution === undefined ? {} : { execution }),
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    ...(review === undefined ? {} : { review }),
    ...(communication === undefined ? {} : { communication }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(setup === undefined ? {} : { setup }),
    ...(playbookSteps === undefined ? {} : { playbookSteps }),
    ...(prReview === undefined ? {} : { prReview }),
  };
}

function readPlaybookSteps(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("playbookSteps must be a non-empty array");
  }
  return value.map((step, index) => readSingleLineText(step, `playbookSteps[${index}]`));
}

function readPrReviewJob(value: unknown): NonNullable<WorkerJob["prReview"]> {
  if (!isRecord(value) || typeof value.structuredReport !== "boolean") {
    throw new TypeError("prReview must be an object with a boolean structuredReport");
  }
  if (value.inlineComments !== undefined && typeof value.inlineComments !== "boolean") {
    throw new TypeError("prReview.inlineComments must be a boolean");
  }
  return {
    structuredReport: value.structuredReport,
    ...(value.diffPath === undefined
      ? {}
      : { diffPath: readAbsolutePath(value.diffPath, "prReview.diffPath") }),
    ...(value.inlineComments === undefined ? {} : { inlineComments: value.inlineComments }),
  };
}
export function parseWorkerResult(value: unknown): WorkerResult {
  if (!isRecord(value)) {
    throw new TypeError("worker result must be an object");
  }
  const id = readSingleLineText(value.id, "id");
  const taskId = readSingleLineText(value.taskId, "taskId");
  const generation = readNonNegativeInteger(value.generation, "generation");
  if (!isLegacyWorkerRole(value.role)) {
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
  const transcript =
    value.transcript === undefined ? undefined : readTranscriptRef(value.transcript);
  const finishedAt = readSingleLineText(value.finishedAt, "finishedAt");

  const requiresReview = role === "reviewer" || role === "verifier";
  if (review === undefined && requiresReview && status === "completed") {
    throw new TypeError("completed review worker result must include review");
  }
  if (review !== undefined && !requiresReview) {
    throw new TypeError("only reviewer and verifier results may include review");
  }
  if (question !== undefined && status !== "needs-decision") {
    throw new TypeError("question is only valid for needs-decision results");
  }
  if (status === "needs-decision" && question === undefined) {
    throw new TypeError("needs-decision results must include a question");
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
    ...(transcript === undefined ? {} : { transcript }),
    finishedAt,
  };
}

function readTranscriptRef(value: unknown): TranscriptRef {
  if (!isRecord(value)) throw new TypeError("transcript must be an object");
  return {
    file: readAbsolutePath(value.file, "transcript.file"),
    entryId: readSingleLineText(value.entryId, "transcript.entryId"),
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
    value.role === undefined ? undefined : isLegacyWorkerRole(value.role) ? value.role : undefined;
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
