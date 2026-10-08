import { isAbsolute } from "node:path";
import type { ReviewResult } from "../contracts.ts";
import {
  anchorProblems,
  PR_REVIEW_SCHEMA,
  type PrReview,
  parsePrReview,
} from "../pr-review/review.ts";
import { MAX_TASK_MESSAGE_CHARS, parseQuickScopeReport } from "../tasks/communication-protocol.ts";
import { isBlockingFinding } from "../tasks/findings.ts";
import { quickScopeQuestionText } from "../tasks/quick-scope.ts";
import {
  parseReviewResult,
  type WorkerJob,
  type WorkerQuestion,
  type WorkerRole,
  type WorkerStatus,
} from "./jobs.ts";

type JsonObject = Readonly<Record<string, unknown>>;

export type ExpectedModel = Readonly<{
  readonly selector: string;
  readonly provider: string;
  readonly id: string;
}>;

export class WorkerOutputError extends Error {
  readonly outputText: string;

  constructor(message: string, outputText = "") {
    super(message);
    this.name = "WorkerOutputError";
    this.outputText = outputText;
  }
}

type ModelObservation = Readonly<{
  readonly provider?: string;
  readonly model?: string;
}>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectedModelParts(selector: string): ExpectedModel {
  const separator = selector.indexOf("/");
  return {
    selector,
    provider: selector.slice(0, separator),
    id: selector.slice(separator + 1),
  };
}

function modelObservation(value: unknown): ModelObservation | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  let provider: string | undefined =
    typeof value.provider === "string" ? value.provider : undefined;
  let model: string | undefined;
  if (typeof value.model === "string") {
    model = value.model;
  } else if (isJsonObject(value.model)) {
    if (provider === undefined && typeof value.model.provider === "string") {
      provider = value.model.provider;
    }
    if (typeof value.model.id === "string") {
      model = value.model.id;
    } else if (typeof value.model.name === "string") {
      model = value.model.name;
    } else if (typeof value.model.model === "string") {
      model = value.model.model;
    }
  }
  if (provider === undefined && model === undefined) {
    return undefined;
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

function modelMismatchReason(event: JsonObject, expected: ExpectedModel): string | undefined {
  const values: unknown[] = [event, event.message, event.metadata];
  if (Array.isArray(event.messages)) {
    values.push(...event.messages);
  }
  for (const value of values) {
    const observation = modelObservation(value);
    if (observation === undefined) {
      continue;
    }
    if (observation.provider !== undefined && observation.provider !== expected.provider) {
      return `OMP selected provider ${observation.provider}, expected ${expected.provider}`;
    }
    if (
      observation.model !== undefined &&
      observation.model !== expected.id &&
      observation.model !== expected.selector
    ) {
      return `OMP selected model ${observation.model}, expected ${expected.selector}`;
    }
  }
  return undefined;
}

function readEventFailure(event: JsonObject): string | undefined {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  if (type.includes("error") || type.includes("abort") || type.includes("cancel")) {
    return describeFailure(
      event.error ?? event.message,
      `OMP emitted ${type || "a failure event"}`,
    );
  }

  const status = typeof event.status === "string" ? event.status.toLowerCase() : "";
  if (status === "error" || status === "failed" || status === "aborted" || status === "cancelled") {
    return describeFailure(event.error ?? event.message, `OMP reported status ${status}`);
  }
  if (event.isError === true || event.aborted === true || event.cancelled === true) {
    return describeFailure(event.error ?? event.message, "OMP reported an unsuccessful turn");
  }
  if (event.error !== undefined && event.error !== null && event.error !== "") {
    return describeFailure(event.error, "OMP reported a provider error");
  }
  if (
    isJsonObject(event.message) &&
    event.message.error !== undefined &&
    event.message.error !== null &&
    event.message.error !== ""
  ) {
    return describeFailure(event.message.error, "OMP reported a provider error");
  }

  const stopReason = stopReasonFrom(event);
  if (stopReason === "error" || stopReason === "aborted" || stopReason === "cancelled") {
    return `OMP stopped with ${stopReason}`;
  }
  return undefined;
}

function describeFailure(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (isJsonObject(value) && typeof value.message === "string" && value.message.trim().length > 0) {
    return value.message.trim();
  }
  return fallback;
}

function stopReasonFrom(event: JsonObject): string | undefined {
  if (typeof event.stopReason === "string") {
    return event.stopReason.toLowerCase();
  }
  if (isJsonObject(event.message) && typeof event.message.stopReason === "string") {
    return event.message.stopReason.toLowerCase();
  }
  if (Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (isJsonObject(message) && typeof message.stopReason === "string") {
        return message.stopReason.toLowerCase();
      }
    }
  }
  return undefined;
}

export type NativeAgentEnd = Readonly<{
  readonly type: "agent_end";
  readonly messages: readonly unknown[];
  readonly willContinue?: boolean;
}>;

function nativeAgentEnd(value: unknown): NativeAgentEnd {
  if (!isJsonObject(value) || value.type !== "agent_end" || !Array.isArray(value.messages)) {
    throw new WorkerOutputError("OMP emitted a malformed agent_end event");
  }
  return {
    type: "agent_end",
    messages: value.messages,
    ...(value.willContinue === undefined ? {} : { willContinue: value.willContinue === true }),
  };
}

/** Why a settled agent_end must fail the job before any report arrives, if it must. */
export function nativeAgentEndFailure(
  value: unknown,
  expectedModel: ExpectedModel,
): string | undefined {
  const failure = readNativeEventFailure(value);
  if (failure !== undefined) return failure;
  return modelMismatchReason(nativeAgentEnd(value), expectedModel);
}

/** Reject a report submitted while OMP runs any model other than the job's pinned one. */
export function assertSelectedModel(expectedModel: ExpectedModel, selectedModel: unknown): void {
  const mismatch = modelMismatchReason({ model: selectedModel }, expectedModel);
  if (mismatch !== undefined) throw new WorkerOutputError(mismatch);
  const selected = modelObservation({ model: selectedModel });
  if (selected === undefined || selected.provider === undefined || selected.model === undefined) {
    throw new WorkerOutputError("OMP did not expose complete selected model metadata");
  }
}

/** Whether a settled agent_end stopped because its run was aborted (Esc, or an extension abort). */
export function nativeAgentEndAborted(value: unknown): boolean {
  return isJsonObject(value) && stopReasonFrom(value) === "aborted";
}

export function nativeAgentEndWillContinue(value: unknown): boolean {
  return nativeAgentEnd(value).willContinue === true;
}

export function readNativeEventFailure(value: unknown): string | undefined {
  return isJsonObject(value) ? readEventFailure(value) : "OMP emitted a malformed lifecycle event";
}

/** A malformed submit_report call the worker must correct and resubmit; it never settles the job. */
export class ReportRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRejection";
  }
}

const MAX_LISTED_UNCOMMITTED_PATHS = 5;

/**
 * An implementer that reports `implemented` with changes still uncommitted would block the task
 * once it settles, so the report is sent back while the worker can still commit. Takes
 * `git status --porcelain=v1` output; an empty status passes.
 */
export function uncommittedWorkRejection(porcelainStatus: string): ReportRejection | undefined {
  const paths = porcelainStatus
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
  if (paths.length === 0) return undefined;
  const listed = paths.slice(0, MAX_LISTED_UNCOMMITTED_PATHS).join(", ");
  const more =
    paths.length > MAX_LISTED_UNCOMMITTED_PATHS
      ? ` and ${paths.length - MAX_LISTED_UNCOMMITTED_PATHS} more`
      : "";
  return new ReportRejection(
    `the worktree has uncommitted changes (${listed}${more}); commit your work, or remove files you did not mean to keep, before submitting implemented`,
  );
}

export const IMPLEMENTER_OUTCOMES = ["implemented", "needs-decision", "failed"] as const;
export const WORKER_OUTCOMES = ["completed", "needs-decision", "failed"] as const;

export function outcomesFor(role: WorkerRole): readonly [string, ...string[]] {
  return role === "implementer" ? IMPLEMENTER_OUTCOMES : WORKER_OUTCOMES;
}

/** The submit_report tool arguments, before role rules are applied. */
export type SubmittedReport = Readonly<{
  readonly outcome: string;
  readonly report?: string | undefined;
  readonly question?: string | undefined;
  readonly recommendation?: string | undefined;
  readonly artifactPath?: string | undefined;
  readonly review?: unknown;
  /** A quick task's one scope question: Tandem renders the question from these fields. */
  readonly scopeExceeded?: unknown;
}>;

export type ResolvedReport = Readonly<{
  readonly status: WorkerStatus;
  readonly text: string;
  readonly error?: string;
  readonly question?: WorkerQuestion;
  readonly artifactPath?: string;
  readonly review?: ReviewResult;
}>;

/**
 * Apply the role's report contract to a submission. Throws ReportRejection for anything the
 * worker can fix, so a formatting slip is corrected in the conversation instead of failing the task.
 */
export function resolveSubmittedReport(
  job: WorkerJob,
  submission: SubmittedReport,
  /** New-side lines of a PR review's diff; when given, every inline comment must sit on one. */
  commentable?: ReadonlyMap<string, ReadonlySet<number>>,
): ResolvedReport {
  const { role } = job;
  const reviews = role === "reviewer";
  if (!outcomesFor(role).includes(submission.outcome)) {
    throw new ReportRejection(`outcome must be one of ${outcomesFor(role).join(", ")}`);
  }
  const status: WorkerStatus =
    submission.outcome === "needs-decision" || submission.outcome === "failed"
      ? submission.outcome
      : "completed";
  const report = submission.report?.trim() ?? "";
  if (!reviews && report.length === 0) throw new ReportRejection("report must not be empty");

  const question =
    status === "needs-decision" ? decisionQuestion(job, submission) : noQuestion(submission);
  if (submission.artifactPath !== undefined && role !== "presentation") {
    throw new ReportRejection(`${role} reports do not take an artifactPath`);
  }
  if (submission.review !== undefined && !reviews) {
    throw new ReportRejection(`${role} reports do not take a review`);
  }

  if (status !== "completed") {
    if (submission.artifactPath !== undefined) {
      throw new ReportRejection("artifactPath is only for a completed presentation");
    }
    if (submission.review !== undefined) {
      throw new ReportRejection("review is only for a completed review");
    }
    return {
      status,
      text: renderReport(submission.outcome, question, undefined, report),
      ...(status === "failed" ? { error: `${role} reported a failed outcome` } : {}),
      ...(question === undefined ? {} : { question }),
    };
  }
  if (reviews) {
    const review = submittedReview(job, submission.review);
    return { status, text: JSON.stringify(review), review };
  }
  if (role === "presentation") {
    const artifactPath = submission.artifactPath?.trim();
    if (artifactPath === undefined || !isAbsolute(artifactPath)) {
      throw new ReportRejection("a completed presentation must include an absolute artifactPath");
    }
    return {
      status,
      text: renderReport(submission.outcome, undefined, artifactPath, report),
      artifactPath,
    };
  }
  if (job.prReview?.structuredReport === true) {
    const review = submittedPrReview(report);
    if (commentable !== undefined) {
      const problems = anchorProblems(review, commentable, job.prReview.inlineComments !== false);
      if (problems.length > 0) {
        throw new ReportRejection(
          `fix these comments, then submit again:\n- ${problems.join("\n- ")}`,
        );
      }
    }
    return { status, text: JSON.stringify(review) };
  }
  return { status, text: renderReport(submission.outcome, undefined, undefined, report) };
}

/** The PR review JSON from the report field; a code fence around it is tolerated. */
function submittedPrReview(report: string): PrReview {
  const json = report.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ReportRejection(`the report must be one PrReview JSON object. ${PR_REVIEW_SCHEMA}`);
  }
  try {
    return parsePrReview(value);
  } catch (error) {
    throw new ReportRejection(
      `${error instanceof Error ? error.message : String(error)}. ${PR_REVIEW_SCHEMA}`,
    );
  }
}

function decisionQuestion(job: WorkerJob, submission: SubmittedReport): WorkerQuestion {
  if (submission.scopeExceeded !== undefined) return scopeQuestion(job, submission);
  const text = boundedLine(submission.question, "question");
  if (text === undefined) throw new ReportRejection("needs-decision requires a question");
  const recommendation = boundedLine(submission.recommendation, "recommendation");
  return recommendation === undefined ? { text } : { text, recommendation };
}

/**
 * A quick task's one scope question. Only its implementer may ask it, only once, and Tandem writes
 * the question from the fields, so the worker supplies facts, never the wording.
 */
function scopeQuestion(job: WorkerJob, submission: SubmittedReport): WorkerQuestion {
  if (job.role !== "implementer" || job.quickScope === undefined)
    throw new ReportRejection("scopeExceeded is only for a quick task's implementer");
  if (job.quickScope === "spent")
    throw new ReportRejection(
      "this quick task already asked its scope question and the user chose to proceed; make the change within your proposed plan, or ask an ordinary needs-decision question",
    );
  if (submission.question !== undefined || submission.recommendation !== undefined)
    throw new ReportRejection(
      "a scope question takes only scopeExceeded; Tandem writes the question from it",
    );
  let scope: ReturnType<typeof parseQuickScopeReport>;
  try {
    scope = parseQuickScopeReport(submission.scopeExceeded, "scopeExceeded");
  } catch (error) {
    throw new ReportRejection(error instanceof Error ? error.message : String(error));
  }
  return { text: quickScopeQuestionText(scope), scope };
}

function noQuestion(submission: SubmittedReport): undefined {
  if (submission.question !== undefined || submission.recommendation !== undefined) {
    throw new ReportRejection("question and recommendation are only for needs-decision");
  }
  if (submission.scopeExceeded !== undefined)
    throw new ReportRejection("scopeExceeded is only for a needs-decision outcome");
  return undefined;
}

function boundedLine(value: string | undefined, field: string): string | undefined {
  const text = value?.trim();
  if (text === undefined || text.length === 0) return undefined;
  if (/[\r\n]/u.test(text)) throw new ReportRejection(`${field} must be a single line`);
  if (text.length > MAX_TASK_MESSAGE_CHARS) {
    throw new ReportRejection(`${field} exceeds the ${MAX_TASK_MESSAGE_CHARS}-character limit`);
  }
  return text;
}

/**
 * The reviewer submits only its findings and summary. The lens, HEAD, generation, and level come
 * from the job, and the review passes exactly when no finding blocks at that level, so none of them
 * can be mistyped or disagree with the findings.
 */
function submittedReview(job: WorkerJob, value: unknown): ReviewResult {
  if (job.review === undefined) {
    throw new WorkerOutputError("review worker job is missing review identity");
  }
  if (!isJsonObject(value)) {
    throw new ReportRejection("a completed review must include review with findings and summary");
  }
  let review: ReviewResult;
  try {
    review = parseReviewResult({
      lens: job.review.lens,
      head: job.review.head,
      generation: job.generation,
      pass: false,
      findings: value.findings,
      summary: value.summary,
    });
  } catch (error) {
    throw new ReportRejection(error instanceof Error ? error.message : "review is invalid");
  }
  const level = job.review.level ?? "standard";
  return { ...review, pass: !review.findings.some((finding) => isBlockingFinding(finding, level)) };
}

/** Human-readable report file text; structured fields stay authoritative on the result. */
function renderReport(
  outcome: string,
  question: WorkerQuestion | undefined,
  artifactPath: string | undefined,
  report: string,
): string {
  const lines = [`Outcome: ${outcome}`];
  if (question !== undefined) {
    lines.push(`Question: ${question.text}`);
    if (question.recommendation !== undefined) {
      lines.push(`Recommendation: ${question.recommendation}`);
    }
  }
  if (artifactPath !== undefined) lines.push(`Artifact: ${artifactPath}`);
  return report.length === 0 ? lines.join("\n") : `${lines.join("\n")}\n\n${report}`;
}
