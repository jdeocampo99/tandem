import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  type AgentRole,
  type Finding,
  type FindingSeverity,
  type FindingVerdict,
  isAgentRole,
  type ModelSpec,
  type ReviewLens,
  type ReviewMode,
  type ReviewResult,
  type SetupCommand,
  type ThinkingLevel,
  type UserCheckEvidence,
} from "../contracts.ts";
import { MAX_TASK_MESSAGE_CHARS } from "../tasks/communication-protocol.ts";
import {
  isClipPath,
  isImagePath,
  isPathWithinDirectory,
  MAX_USER_CHECK_FILE_BYTES,
} from "../tasks/user-checks.ts";
import type { ExecutionIdentity } from "./execution-gate.ts";

/** Bounds on the implementer's saved "you check" evidence, checked at submission and again after
 *  the job completes. */
const MAX_USER_CHECK_FILES_PER_CRITERION = 8;
const MAX_USER_CHECK_FILES_TOTAL = 24;

export type WorkerRole = Exclude<AgentRole, "coordinator">;

export type WorkerReviewContext = Readonly<{
  readonly head: string;
  readonly lens: ReviewLens;
  /** The Tandem-check acceptance criteria, used to validate `ReviewResult.handToUser`. */
  readonly criteria?: readonly string[];
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
  readonly execution?: ExecutionIdentity;
  readonly sessionDirectory?: string;
  readonly review?: WorkerReviewContext;
  readonly communication?: Readonly<{
    readonly inboxPath: string;
    readonly receiptPath: string;
    readonly initialRevision: number;
  }>;
  readonly timeoutMs?: number;
  /** "You check" directory and criteria; only an implementer job may carry this. */
  readonly userChecks?: Readonly<{
    readonly directory: string;
    readonly criteria: readonly string[];
  }>;
  /** The pinned worktree setup commands an implementer runs before OMP starts. */
  readonly setup?: readonly SetupCommand[];
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
  /** The implementer's saved evidence for each "you check" criterion; only an implementer result
   *  may carry this. */
  readonly userCheckEvidence?: readonly UserCheckEvidence[];
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

function isWorkerRole(value: unknown): value is WorkerRole {
  return isAgentRole(value) && value !== "coordinator";
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

function readTextArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return value.map((entry, index) => readNonEmptyText(entry, `${field}[${index}]`));
}

function readReviewContext(value: unknown): WorkerReviewContext {
  if (!isRecord(value)) {
    throw new TypeError("review must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "head" && key !== "lens" && key !== "criteria") {
      throw new TypeError(`review contains unknown field ${key}`);
    }
  }
  const head = readSingleLineText(value.head, "review.head");
  if (!isReviewLens(value.lens)) {
    throw new TypeError("review.lens must be a valid review lens");
  }
  const criteria =
    value.criteria === undefined ? undefined : readTextArray(value.criteria, "review.criteria");
  return { head, lens: value.lens, ...(criteria === undefined ? {} : { criteria }) };
}

function readUserChecks(
  value: unknown,
): Readonly<{ directory: string; criteria: readonly string[] }> {
  if (!isRecord(value)) throw new TypeError("userChecks must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "directory" && key !== "criteria") {
      throw new TypeError(`userChecks contains unknown field ${key}`);
    }
  }
  const directory = readAbsolutePath(value.directory, "userChecks.directory");
  const criteria = readTextArray(value.criteria, "userChecks.criteria");
  if (criteria.length === 0) {
    throw new TypeError("userChecks.criteria must contain at least one entry");
  }
  return { directory, criteria };
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

function readUserCheckEvidenceEntry(value: unknown, index: number): UserCheckEvidence {
  if (!isRecord(value)) {
    throw new TypeError(`userCheckEvidence[${index}] must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "criterion" && key !== "paths") {
      throw new TypeError(`userCheckEvidence[${index}] contains unknown field ${key}`);
    }
  }
  const criterion = readNonEmptyText(value.criterion, `userCheckEvidence[${index}].criterion`);
  const paths = readTextArray(value.paths, `userCheckEvidence[${index}].paths`).map(
    (path, pathIndex) => readAbsolutePath(path, `userCheckEvidence[${index}].paths[${pathIndex}]`),
  );
  return { criterion, paths };
}

export function readUserCheckEvidenceArray(value: unknown): readonly UserCheckEvidence[] {
  if (!Array.isArray(value)) {
    throw new TypeError("userCheckEvidence must be an array");
  }
  return value.map((entry, index) => readUserCheckEvidenceEntry(entry, index));
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
  const mode =
    value.mode === undefined
      ? undefined
      : value.mode === "review_changed_diff" || value.mode === "review_existing_head"
        ? (value.mode as ReviewMode)
        : (() => {
            throw new TypeError("review.mode must be review_changed_diff or review_existing_head");
          })();
  const summary = readNonEmptyText(value.summary, "review.summary");
  const handToUser =
    value.handToUser === undefined
      ? undefined
      : readTextArray(value.handToUser, "review.handToUser");
  return {
    lens: value.lens,
    head,
    generation,
    pass: value.pass,
    findings,
    summary,
    ...(mode === undefined ? {} : { mode }),
    ...(handToUser === undefined ? {} : { handToUser }),
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
  const userChecks = value.userChecks === undefined ? undefined : readUserChecks(value.userChecks);
  if (userChecks !== undefined && role !== "implementer") {
    throw new TypeError("userChecks is only permitted for implementer jobs");
  }
  const setup = value.setup === undefined ? undefined : readSetupCommands(value.setup);
  if (setup !== undefined && role !== "implementer") {
    throw new TypeError("setup is only permitted for implementer jobs");
  }

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
    ...(execution === undefined ? {} : { execution }),
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    ...(review === undefined ? {} : { review }),
    ...(communication === undefined ? {} : { communication }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(userChecks === undefined ? {} : { userChecks }),
    ...(setup === undefined ? {} : { setup }),
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
  const userCheckEvidence =
    value.userCheckEvidence === undefined
      ? undefined
      : readUserCheckEvidenceArray(value.userCheckEvidence);
  if (userCheckEvidence !== undefined && role !== "implementer") {
    throw new TypeError("userCheckEvidence is only permitted for implementer results");
  }

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
    finishedAt,
    ...(userCheckEvidence === undefined ? {} : { userCheckEvidence }),
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

/**
 * Verifies "you check" evidence on disk: every path must be a non-empty regular file (never a
 * symlink), of a supported screenshot or clip type, and lexically inside the job's private
 * user-check directory once symlinks are resolved. Returns the reason for the first failure found,
 * or `undefined` when every path passes. Called both at `submit_report` and again after the job
 * completes, since the worker's claim about its own files is never trusted on its own.
 */
export async function checkUserCheckFiles(
  directory: string,
  evidence: readonly UserCheckEvidence[],
): Promise<string | undefined> {
  let realDirectory: string;
  try {
    realDirectory = await realpath(directory);
  } catch {
    return `the user-check directory ${directory} could not be read`;
  }
  let total = 0;
  for (const entry of evidence) {
    if (entry.paths.length > MAX_USER_CHECK_FILES_PER_CRITERION) {
      return `"${entry.criterion}" has more than ${MAX_USER_CHECK_FILES_PER_CRITERION} files`;
    }
    for (const path of entry.paths) {
      total += 1;
      if (total > MAX_USER_CHECK_FILES_TOTAL) {
        return `more than ${MAX_USER_CHECK_FILES_TOTAL} user-check files were submitted`;
      }
      if (!isImagePath(path) && !isClipPath(path)) {
        return `${path} is not a supported screenshot or clip file type`;
      }
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(path);
      } catch {
        return `${path} does not exist`;
      }
      if (!stats.isFile()) {
        return `${path} must be a regular file, not a symlink or directory`;
      }
      if (stats.size <= 0) {
        return `${path} is empty`;
      }
      if (stats.size > MAX_USER_CHECK_FILE_BYTES) {
        return `${path} is larger than ${MAX_USER_CHECK_FILE_BYTES} bytes`;
      }
      let realPath: string;
      try {
        realPath = await realpath(path);
      } catch {
        return `${path} could not be resolved`;
      }
      if (!isPathWithinDirectory(realDirectory, realPath)) {
        return `${path} is outside the user-check directory`;
      }
    }
  }
  return undefined;
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
