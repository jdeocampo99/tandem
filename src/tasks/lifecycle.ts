import {
  type BlockCause,
  type Endpoint,
  type Finding,
  type FindingSeverity,
  type FindingVerdict,
  type IsoTimestamp,
  type IterationScope,
  isSafeRequestId,
  type Notification,
  type PullRequestMetadata,
  type ResearchContinuation,
  type ResearchHandoff,
  type ResolvedGuidance,
  type ReviewLens,
  type ReviewResult,
  type SkillInvocation,
  type TaskKind,
  type TaskRecord,
  type TaskStage,
  type ValidationContractName,
  type ValidationEvidence,
  type WorktreeLease,
} from "../contracts.ts";
import {
  FINAL_REVIEW_LENSES,
  type FinalRequirement,
  finalAcceptanceStatus,
  isPinnedEvidence,
} from "./acceptance.ts";
import { recordReviewFindings } from "./findings.ts";
import { checkResearchContinuation, defaultResearchContinuation } from "./research-continuation.ts";
import { recordedReviewLevel, requiredReviewLenses } from "./review-levels.ts";
import { checkSkillInvocation } from "./skill-invocation.ts";

export type TaskInput = Readonly<{
  readonly id: string;
  readonly repoPath: string;
  readonly kind: TaskKind;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  /** Hands-on checks a person makes before merging; never judged by review. */
  readonly manualVerification?: readonly string[];
  readonly surfaces: readonly string[];
  readonly policy: TaskRecord["policy"];
  /** The approved request brief this task is created under, when one governs it. */
  readonly requestId?: string;
  readonly researchHandoffs?: readonly ResearchHandoff[];
  /** Explicit post-research disposition; scouts fall back to the conservative default. */
  readonly researchContinuation?: ResearchContinuation;
  /** An explicit user-invoked skill to pin to this task, opaque to Tandem. */
  readonly skill?: SkillInvocation;
}>;

export type TaskTransitionContext = Readonly<{
  readonly now: IsoTimestamp;
  readonly notificationId: string;
}>;

type ApprovalEvent = Readonly<{
  readonly type: "approve";
}>;

type StartEvent = Readonly<{
  readonly type: "start";
  readonly worktree: WorktreeLease;
  readonly endpoints: readonly Endpoint[];
}>;

/**
 * Central recovery's single re-entry path for a stage whose worker is proven dead: it replaces the
 * current endpoint set with a freshly launched one without touching the worktree, stage, or reviewed
 * evidence. It never mutates a prior job or result; a new durable operation and job back it.
 */
type RelaunchEvent = Readonly<{
  readonly type: "relaunch";
  readonly endpoints: readonly Endpoint[];
  readonly generation: number;
}>;

type ImplementationCompleteEvent = Readonly<{
  readonly type: "implementation-complete";
  readonly head: string;
  readonly generation: number;
  readonly reportPath?: string;
}>;

type ValidationEvent = Readonly<{
  readonly head: string;
  readonly generation: number;
  readonly contract: ValidationContractName;
  readonly policyDigest: string;
  readonly evidence: readonly ValidationEvidence[];
}>;

type ValidationSucceededEvent = ValidationEvent &
  Readonly<{
    readonly type: "validation-succeeded";
  }>;

type ValidationFailedEvent = ValidationEvent &
  Readonly<{
    readonly type: "validation-failed";
  }>;
type RecordReviewEvent = Readonly<{
  readonly type: "record-review";
  readonly review: ReviewResult;
}>;

type FinishReviewEvent = Readonly<{
  readonly type: "finish-review";
  readonly head: string;
  readonly generation: number;
}>;
type InvalidateEvidenceEvent = Readonly<{
  readonly type: "invalidate-evidence";
  readonly head: string;
  readonly generation: number;
}>;
type FollowUpResearchEvent = Readonly<{
  readonly type: "follow-up-research";
}>;

/**
 * The user's explicit "publish now": the task goes to `ready` at its committed HEAD without
 * finishing validation or review, and the skip is recorded against that HEAD.
 */
type SkipReviewEvent = Readonly<{
  readonly type: "skip-review";
  readonly head: string;
}>;

type BeginFixesEvent = Readonly<{
  readonly type: "begin-fixes";
  readonly head: string;
  readonly generation: number;
  readonly iterationScope?: IterationScope;
}>;

type ScoutReportCompleteEvent = Readonly<{
  readonly type: "scout-report-complete";
  readonly reportPath: string;
  readonly generation: number;
}>;

type PauseEvent = Readonly<{
  readonly type: "pause";
  readonly reason: string;
}>;

type ResumeEvent = Readonly<{
  readonly type: "resume";
}>;

type CancelEvent = Readonly<{
  readonly type: "cancel";
  readonly reason?: string;
}>;
type BlockEvent = Readonly<{
  readonly type: "block";
  readonly reason: string;
  /** Typed cause behind `reason`, when the caller has one. Optional so every existing free-text
   *  block keeps working unchanged; a caller that has a cause should always supply it. */
  readonly cause?: BlockCause;
}>;

type MergeEvent = Readonly<{
  readonly type: "merge";
  readonly pullRequest: PullRequestMetadata;
  readonly approved: boolean;
  readonly verified: boolean;
}>;

type AcknowledgeNotificationEvent = Readonly<{
  readonly type: "acknowledge-notification";
  readonly notificationId: string;
}>;

export type TaskEvent =
  | ApprovalEvent
  | StartEvent
  | RelaunchEvent
  | ImplementationCompleteEvent
  | ValidationSucceededEvent
  | ValidationFailedEvent
  | RecordReviewEvent
  | FinishReviewEvent
  | InvalidateEvidenceEvent
  | FollowUpResearchEvent
  | BeginFixesEvent
  | SkipReviewEvent
  | ScoutReportCompleteEvent
  | PauseEvent
  | ResumeEvent
  | CancelEvent
  | BlockEvent
  | MergeEvent
  | AcknowledgeNotificationEvent;

export type TaskTransitionErrorCode =
  | "invalid-stage"
  | "invalid-event"
  | "invalid-input"
  | "stale-result"
  | "duplicate-review"
  | "invalid-review"
  | "review-incomplete"
  | "validation-mismatch"
  | "final-acceptance-incomplete"
  | "max-fix-rounds"
  | "approval-required"
  | "merge-not-verified"
  | "notification-not-found"
  | "notification-already-acknowledged";

export class TaskTransitionError extends Error {
  readonly code: TaskTransitionErrorCode;
  readonly taskId: string;
  readonly stage: TaskStage;

  constructor(code: TaskTransitionErrorCode, task: TaskRecord, message: string) {
    super(message);
    this.name = "TaskTransitionError";
    this.code = code;
    this.taskId = task.id;
    this.stage = task.stage;
  }
}

const TASK_STAGES: readonly TaskStage[] = [
  "awaiting-approval",
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
  "ready",
  "paused",
  "blocked",
  "cancelled",
  "completed",
  "merged",
];

const REVIEW_LENSES: readonly ReviewLens[] = FINAL_REVIEW_LENSES;

const FINDING_SEVERITIES: readonly FindingSeverity[] = ["P0", "P1", "P2", "P3"];
const FINDING_VERDICTS: readonly FindingVerdict[] = ["confirmed", "plausible"];
const TERMINAL_STAGES: readonly TaskStage[] = ["cancelled", "completed", "merged"];

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function assertTimestamp(now: unknown): asserts now is IsoTimestamp {
  if (!isNonEmptyText(now)) {
    throw new TypeError("Task timestamps must be non-empty strings");
  }
}

export function isSafeTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function assertTaskInput(input: TaskInput): void {
  if (!input || typeof input !== "object") {
    throw new TypeError("Task input must be an object");
  }
  if (!isSafeTaskId(input.id)) {
    throw new TypeError(`Unsafe task id: ${String(input.id)}`);
  }
  if (!isNonEmptyText(input.repoPath)) {
    throw new TypeError("Task repoPath must be a non-empty string");
  }
  if (input.kind !== "scout" && input.kind !== "implementation") {
    throw new TypeError(`Unsupported task kind: ${String(input.kind)}`);
  }
  if (!isNonEmptyText(input.objective)) {
    throw new TypeError("Task objective must be a non-empty string");
  }
  assertTextList(input.acceptanceCriteria, "acceptanceCriteria");
  if (input.manualVerification !== undefined) {
    assertTextList(input.manualVerification, "manualVerification");
  }
  assertTextList(input.surfaces, "surfaces");
  if (input.requestId !== undefined && !isSafeRequestId(input.requestId)) {
    throw new TypeError(`Unsafe request id: ${String(input.requestId)}`);
  }
  assertResearchContinuationInput(input);
  assertSkillInput(input);
  const maxFixRounds = input.policy?.config?.maxFixRounds;
  if (!isInteger(maxFixRounds) || maxFixRounds < 0) {
    throw new TypeError("Task policy must define a non-negative integer maxFixRounds");
  }
}

function assertResearchContinuationInput(input: TaskInput): void {
  if (input.researchContinuation === undefined) return;
  if (input.kind !== "scout") {
    throw new TypeError("Only scout tasks accept a research continuation disposition");
  }
  const check = checkResearchContinuation(input.researchContinuation);
  if (!check.valid) throw new TypeError(`Task researchContinuation is invalid: ${check.defect}`);
}

function assertSkillInput(input: TaskInput): void {
  if (input.skill === undefined) return;
  const check = checkSkillInvocation(input.skill);
  if (!check.valid) throw new TypeError(`Task skill is invalid: ${check.defect}`);
}

function assertTextList(values: readonly string[], field: string): void {
  if (!Array.isArray(values) || values.some((value) => !isNonEmptyText(value))) {
    throw new TypeError(`Task ${field} must contain only non-empty strings`);
  }
}

function assertContext(context: TaskTransitionContext): void {
  if (!context || typeof context !== "object") {
    throw new TypeError("Task transition context must be an object");
  }
  assertTimestamp(context.now);
  if (!isNonEmptyText(context.notificationId)) {
    throw new TypeError("Task notificationId must be a non-empty string");
  }
}

function isKnownValue<Value extends string>(
  value: unknown,
  values: readonly Value[],
): value is Value {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function isTaskStage(value: unknown): value is TaskStage {
  return isKnownValue(value, TASK_STAGES);
}

function isReviewLens(value: unknown): value is ReviewLens {
  return isKnownValue(value, REVIEW_LENSES);
}

function isFindingSeverity(value: unknown): value is FindingSeverity {
  return isKnownValue(value, FINDING_SEVERITIES);
}

function isFindingVerdict(value: unknown): value is FindingVerdict {
  return isKnownValue(value, FINDING_VERDICTS);
}

function commitTask(task: TaskRecord, now: IsoTimestamp, changes: Partial<TaskRecord>): TaskRecord {
  return {
    ...task,
    ...changes,
    revision: task.revision + 1,
    updatedAt: now,
  };
}

function notification(
  task: TaskRecord,
  context: TaskTransitionContext,
  message: string,
  kind: Notification["kind"] = "routine",
): Notification {
  if (task.notifications.some((entry) => entry.id === context.notificationId)) {
    throw new TaskTransitionError(
      "invalid-input",
      task,
      `Notification id ${context.notificationId} is already present on task ${task.id}`,
    );
  }
  return { id: context.notificationId, message, acknowledged: false, kind };
}

function commitWithNotification(
  task: TaskRecord,
  context: TaskTransitionContext,
  changes: Partial<TaskRecord>,
  message: string,
  kind: Notification["kind"] = "routine",
): TaskRecord {
  const entry = notification(task, context, message, kind);
  return commitTask(task, context.now, {
    ...changes,
    notifications: [...task.notifications, entry],
  });
}

function invalidStage(task: TaskRecord, eventType: string, expected: readonly TaskStage[]): never {
  throw new TaskTransitionError(
    "invalid-stage",
    task,
    `Cannot apply ${eventType} while task ${task.id} is ${task.stage}; expected ${expected.join(", ")}`,
  );
}

function staleResult(task: TaskRecord, detail: string): never {
  throw new TaskTransitionError(
    "stale-result",
    task,
    `Stale result for task ${task.id}: ${detail}`,
  );
}

function assertCurrentGeneration(task: TaskRecord, generation: number, detail: string): void {
  if (!isInteger(generation) || generation < 0 || generation !== task.generation) {
    staleResult(
      task,
      `${detail} generation ${String(generation)} does not match ${task.generation}`,
    );
  }
}

function assertCurrentHead(task: TaskRecord, head: string, detail: string): void {
  if (!isNonEmptyText(head) || task.reviewHead !== head) {
    staleResult(task, `${detail} head ${String(head)} does not match ${String(task.reviewHead)}`);
  }
}

function assertWorktree(worktree: WorktreeLease, task: TaskRecord): void {
  if (
    !worktree ||
    typeof worktree !== "object" ||
    !isNonEmptyText(worktree.root) ||
    !isNonEmptyText(worktree.path) ||
    !isNonEmptyText(worktree.name) ||
    !isNonEmptyText(worktree.baseHead) ||
    !isNonEmptyText(worktree.branch) ||
    !isNonEmptyText(worktree.leaseId) ||
    !isNonEmptyText(worktree.leaseHolder) ||
    !isNonEmptyText(worktree.leasedAt)
  ) {
    throw new TaskTransitionError(
      "invalid-input",
      task,
      "A worktree lease must contain all identifying fields",
    );
  }
}

function assertEndpoints(endpoints: readonly Endpoint[], task: TaskRecord): void {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new TaskTransitionError(
      "invalid-input",
      task,
      "Starting a task requires at least one endpoint",
    );
  }
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (
      !endpoint ||
      typeof endpoint !== "object" ||
      !isNonEmptyText(endpoint.sessionId) ||
      !isNonEmptyText(endpoint.workspaceId) ||
      !isNonEmptyText(endpoint.tabId) ||
      !isNonEmptyText(endpoint.paneId) ||
      !isNonEmptyText(endpoint.role) ||
      !isInteger(endpoint.generation) ||
      endpoint.generation !== task.generation
    ) {
      throw new TaskTransitionError(
        "invalid-input",
        task,
        "Every endpoint must be complete and bound to the task generation",
      );
    }
    if (seen.has(endpoint.paneId)) {
      throw new TaskTransitionError(
        "invalid-input",
        task,
        `Duplicate endpoint pane ${endpoint.paneId}`,
      );
    }
    seen.add(endpoint.paneId);
  }
}

function assertHeadEvent(task: TaskRecord, head: string, generation: number, detail: string): void {
  assertCurrentGeneration(task, generation, detail);
  if (!isNonEmptyText(head)) {
    throw new TaskTransitionError("invalid-input", task, `${detail} requires a non-empty head`);
  }
}

function assertEvidence(task: TaskRecord, event: ValidationEvent): void {
  if (!Array.isArray(event.evidence) || event.evidence.length === 0) {
    throw new TaskTransitionError(
      "validation-mismatch",
      task,
      "Validation requires at least one evidence record",
    );
  }
  if (event.contract !== "iteration" && event.contract !== "final") {
    throw new TaskTransitionError(
      "validation-mismatch",
      task,
      "Validation must name the iteration or final contract",
    );
  }
  if (!isNonEmptyText(event.policyDigest)) {
    throw new TaskTransitionError(
      "validation-mismatch",
      task,
      "Validation must carry the policy identity it ran under",
    );
  }
  for (const entry of event.evidence) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !isNonEmptyText(entry.name) ||
      !Array.isArray(entry.argv) ||
      entry.argv.some((argument: string) => !isNonEmptyText(argument)) ||
      !isInteger(entry.exitCode) ||
      entry.exitCode < 0 ||
      typeof entry.stdout !== "string" ||
      typeof entry.stderr !== "string" ||
      entry.head !== event.head ||
      entry.contract !== event.contract ||
      entry.policyDigest !== event.policyDigest ||
      (entry.origin !== "local" && entry.origin !== "github")
    ) {
      throw new TaskTransitionError(
        "validation-mismatch",
        task,
        "Validation evidence must be complete and bound to one contract, head, and policy identity",
      );
    }
  }
  const conflicting = task.validationEvidence
    .filter(isPinnedEvidence)
    .find((entry) => entry.head === event.head && entry.policyDigest !== event.policyDigest);
  if (conflicting !== undefined) {
    throw new TaskTransitionError(
      "validation-mismatch",
      task,
      `Evidence at head ${event.head} already exists under a different policy identity`,
    );
  }
}

function assertIterationScope(task: TaskRecord, scope: IterationScope): void {
  if (
    !scope ||
    typeof scope !== "object" ||
    !isNonEmptyText(scope.head) ||
    !isNonEmptyText(scope.policyDigest) ||
    !isInteger(scope.generation) ||
    scope.generation < 0 ||
    !Array.isArray(scope.reproduces) ||
    scope.reproduces.some((name) => !isNonEmptyText(name)) ||
    !Array.isArray(scope.surfaces) ||
    scope.surfaces.some((surface) => !isNonEmptyText(surface)) ||
    !Array.isArray(scope.findingIds) ||
    scope.findingIds.some((id) => !isNonEmptyText(id))
  ) {
    throw new TaskTransitionError(
      "invalid-input",
      task,
      "An iteration scope must name its head, policy identity, targeted checks, and findings",
    );
  }
  if (scope.head !== task.reviewHead || scope.generation !== task.generation) {
    staleResult(
      task,
      `iteration scope ${scope.head}/${scope.generation} does not match ${String(task.reviewHead)}/${task.generation}`,
    );
  }
}

function clearIterationScope<Task extends { readonly iterationScope?: IterationScope }>(
  task: Task,
): Omit<Task, "iterationScope"> {
  const { iterationScope: _iterationScope, ...rest } = task;
  return rest;
}

function assertFinding(finding: Finding, task: TaskRecord): void {
  if (
    !finding ||
    typeof finding !== "object" ||
    !isNonEmptyText(finding.id) ||
    !isFindingSeverity(finding.severity) ||
    !isFindingVerdict(finding.verdict) ||
    !isNonEmptyText(finding.description) ||
    (finding.file !== undefined && !isNonEmptyText(finding.file)) ||
    (finding.line !== undefined && (!isInteger(finding.line) || finding.line < 1))
  ) {
    throw new TaskTransitionError(
      "invalid-review",
      task,
      "Review findings must use known severity, verdict, and descriptions",
    );
  }
}

function assertReview(review: ReviewResult, task: TaskRecord): void {
  if (
    !review ||
    typeof review !== "object" ||
    !isReviewLens(review.lens) ||
    !isNonEmptyText(review.head) ||
    !isInteger(review.generation) ||
    review.generation < 0
  ) {
    throw new TaskTransitionError(
      "invalid-review",
      task,
      "Review must identify a known lens, head, and generation",
    );
  }
  if (
    review.mode !== undefined &&
    review.mode !== "review_changed_diff" &&
    review.mode !== "review_existing_head"
  ) {
    throw new TaskTransitionError(
      "invalid-review",
      task,
      "Review mode must be review_changed_diff or review_existing_head",
    );
  }
  if (
    typeof review.pass !== "boolean" ||
    !Array.isArray(review.findings) ||
    !isNonEmptyText(review.summary)
  ) {
    throw new TaskTransitionError(
      "invalid-review",
      task,
      "Review must contain pass, findings, and summary values",
    );
  }
  for (const finding of review.findings) {
    assertFinding(finding, task);
    if (
      review.pass &&
      (finding.severity === "P0" || finding.severity === "P1" || finding.severity === "P2") &&
      (finding.verdict === "confirmed" ||
        (finding.verdict === "plausible" &&
          (finding.severity === "P0" || finding.severity === "P1")))
    ) {
      throw new TaskTransitionError(
        "invalid-review",
        task,
        `Review lens ${review.lens} cannot pass with a ${finding.verdict} ${finding.severity} finding`,
      );
    }
  }
}

/** A merge must land the pull request at exactly the task's own reviewed commit. */
function assertMergedHead(task: TaskRecord, event: MergeEvent): void {
  if (task.reviewHead === event.pullRequest.head) return;
  throw new TaskTransitionError(
    "merge-not-verified",
    task,
    "Merged pull request must match the reviewed head",
  );
}

function activeReviews(task: TaskRecord): readonly ReviewResult[] {
  if (task.reviewHead === undefined) {
    return [];
  }
  return task.reviews.filter(
    (review) => review.head === task.reviewHead && review.generation === task.generation,
  );
}

function allReviewLensesPass(task: TaskRecord, required: readonly ReviewLens[]): boolean {
  const current = activeReviews(task);
  return required.every((lens) => current.some((review) => review.lens === lens && review.pass));
}

function describeRequirements(requirements: readonly FinalRequirement[]): string {
  return requirements.map((entry) => `${entry.name} (${entry.origin})`).join(", ");
}

function reviewSummary(task: TaskRecord): string {
  const current = activeReviews(task);
  const failed = current.some((review) => !review.pass);
  return failed
    ? `Task ${task.id} requires fixes after review`
    : `Task ${task.id} passed review at the ${recordedReviewLevel(task).level} review level`;
}

/**
 * The outcome announced only at true readiness: every required lens passes and the final acceptance
 * manifest is satisfied for the delivered code and policy. It never implies delivery.
 */
function readySummary(task: TaskRecord, head: string): string {
  return `Ready: task ${task.id} passed review at the ${recordedReviewLevel(task).level} review level and the final acceptance manifest at HEAD ${head}. Ready is not publication, merge, or deploy approval; each remains explicit.`;
}

function hasSuccessfulCurrentValidation(task: TaskRecord): boolean {
  return (
    task.stage === "reviewing" &&
    task.reviewHead !== undefined &&
    task.validationEvidence.length > 0 &&
    task.validationEvidence.every((entry) => entry.head === task.reviewHead && entry.exitCode === 0)
  );
}

function clearReviewHead(task: TaskRecord): Omit<TaskRecord, "reviewHead" | "reviewSkippedHead"> {
  const { reviewHead: _reviewHead, reviewSkippedHead: _reviewSkippedHead, ...rest } = task;
  return rest;
}

function clearPreviousAndBlock(
  task: TaskRecord,
): Omit<TaskRecord, "previousStage" | "blockReason" | "blockCause"> {
  const {
    previousStage: _previousStage,
    blockReason: _blockReason,
    blockCause: _blockCause,
    ...rest
  } = task;
  return rest;
}

/** Leaving a terminal stage invalidates the cleanup note written about that stage's resources. */
function clearCleanup(task: TaskRecord): Omit<TaskRecord, "cleanup"> {
  const { cleanup: _cleanup, ...rest } = task;
  return rest;
}

function cloneGuidanceEntries(entries: readonly ResolvedGuidance[]): readonly ResolvedGuidance[] {
  return entries.map((entry) => ({
    text: entry.text,
    provenance: { ...entry.provenance },
  }));
}

function cloneResolvedPolicy(policy: TaskRecord["policy"]): TaskRecord["policy"] {
  return {
    config: {
      version: policy.config.version,
      models: {
        coordinator: { ...policy.config.models.coordinator },
        scout: { ...policy.config.models.scout },
        implementer: { ...policy.config.models.implementer },
        reviewer: { ...policy.config.models.reviewer },
        presentation: { ...policy.config.models.presentation },
      },
      instructions: {
        implementation: [...policy.config.instructions.implementation],
        validation: [...policy.config.instructions.validation],
        review: [...policy.config.instructions.review],
      },
      instructionFiles: {
        implementation: [...policy.config.instructionFiles.implementation],
        validation: [...policy.config.instructionFiles.validation],
        review: [...policy.config.instructionFiles.review],
      },
      validationCommands: policy.config.validationCommands.map((command) => ({
        name: command.name,
        argv: [...command.argv],
        surfaces: [...command.surfaces],
        timeoutMs: command.timeoutMs,
      })),
      setupCommands: policy.config.setupCommands.map((command) => ({
        name: command.name,
        argv: [...command.argv],
        timeoutMs: command.timeoutMs,
      })),
      maxWorkers: policy.config.maxWorkers,
      maxFixRounds: policy.config.maxFixRounds,
      reviewLevels: { ...policy.config.reviewLevels },
    },
    guidance: {
      implementation: cloneGuidanceEntries(policy.guidance.implementation),
      validation: cloneGuidanceEntries(policy.guidance.validation),
      review: cloneGuidanceEntries(policy.guidance.review),
    },
  };
}

export function createTask(input: TaskInput, now: IsoTimestamp): TaskRecord {
  assertTimestamp(now);
  assertTaskInput(input);
  const scopeApproved = input.kind === "scout";
  return {
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    repoPath: input.repoPath,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    kind: input.kind,
    objective: input.objective,
    acceptanceCriteria: [...input.acceptanceCriteria],
    ...(input.manualVerification === undefined || input.manualVerification.length === 0
      ? {}
      : { manualVerification: [...input.manualVerification] }),
    surfaces: [...input.surfaces],
    stage: scopeApproved ? "queued" : "awaiting-approval",
    scopeApproved,
    policy: cloneResolvedPolicy(input.policy),
    createdAt: now,
    updatedAt: now,
    generation: 0,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    notifications: [],
    ...(input.researchHandoffs === undefined
      ? {}
      : { researchHandoffs: [...input.researchHandoffs] }),
    ...(input.skill === undefined ? {} : { skill: { ...input.skill } }),
    ...(input.kind === "scout"
      ? {
          researchContinuation:
            input.researchContinuation === undefined
              ? defaultResearchContinuation()
              : { ...input.researchContinuation },
        }
      : {}),
  };
}

export function transitionTask(
  task: TaskRecord,
  event: TaskEvent,
  context: TaskTransitionContext,
): TaskRecord {
  assertContext(context);
  if (task?.schemaVersion !== 1 || !isTaskStage(task.stage)) {
    throw new TypeError("Cannot transition an invalid task record");
  }
  if (!event || typeof event.type !== "string") {
    throw new TaskTransitionError(
      "invalid-event",
      task,
      "Task event must have a discriminant type",
    );
  }

  switch (event.type) {
    case "approve": {
      if (task.stage !== "awaiting-approval") {
        invalidStage(task, event.type, ["awaiting-approval"]);
      }
      return commitTask(task, context.now, { stage: "queued", scopeApproved: true });
    }
    case "start": {
      if (task.stage !== "queued") {
        invalidStage(task, event.type, ["queued"]);
      }
      if (!task.scopeApproved) {
        throw new TaskTransitionError(
          "approval-required",
          task,
          `Task ${task.id} has not received scope approval`,
        );
      }
      assertWorktree(event.worktree, task);
      assertEndpoints(event.endpoints, task);
      return commitTask(task, context.now, {
        stage: task.kind === "scout" ? "scouting" : "implementing",
        worktree: event.worktree,
        endpoints: [...event.endpoints],
      });
    }
    case "relaunch": {
      if (task.stage !== "implementing" && task.stage !== "scouting") {
        invalidStage(task, event.type, ["implementing", "scouting"]);
      }
      assertCurrentGeneration(task, event.generation, "Relaunch");
      assertEndpoints(event.endpoints, task);
      return commitTask(task, context.now, {
        endpoints: [...event.endpoints],
      });
    }
    case "implementation-complete": {
      if (task.stage !== "implementing" || task.kind !== "implementation") {
        invalidStage(task, event.type, ["implementing"]);
      }
      assertHeadEvent(task, event.head, event.generation, "Implementation completion");
      if (event.reportPath !== undefined && !isNonEmptyText(event.reportPath)) {
        throw new TaskTransitionError(
          "invalid-input",
          task,
          "Implementation reportPath must be non-empty when supplied",
        );
      }
      return commitTask(task, context.now, {
        stage: "validating",
        reviewHead: event.head,
        validationEvidence: [],
        ...(event.reportPath === undefined ? {} : { reportPath: event.reportPath }),
      });
    }
    case "validation-succeeded": {
      if (task.stage !== "validating") {
        invalidStage(task, event.type, ["validating"]);
      }
      assertHeadEvent(task, event.head, event.generation, "Validation");
      assertCurrentHead(task, event.head, "Validation");
      assertEvidence(task, event);
      if (event.evidence.some((entry) => entry.exitCode !== 0)) {
        throw new TaskTransitionError(
          "validation-mismatch",
          task,
          "Validation success cannot contain a non-zero exit code",
        );
      }
      return commitTask(task, context.now, {
        stage: "reviewing",
        validationEvidence: [...task.validationEvidence, ...event.evidence],
      });
    }
    case "validation-failed": {
      if (task.stage !== "validating") {
        invalidStage(task, event.type, ["validating"]);
      }
      assertHeadEvent(task, event.head, event.generation, "Validation");
      assertCurrentHead(task, event.head, "Validation");
      assertEvidence(task, event);
      if (event.evidence.every((entry) => entry.exitCode === 0)) {
        throw new TaskTransitionError(
          "validation-mismatch",
          task,
          "Validation failure requires at least one non-zero exit code",
        );
      }
      return commitWithNotification(
        task,
        context,
        {
          stage: "awaiting-fixes",
          validationEvidence: [...task.validationEvidence, ...event.evidence],
        },
        `The ${event.contract} contract failed for task ${task.id}; fixes are required`,
      );
    }
    case "record-review": {
      if (task.stage !== "reviewing") {
        invalidStage(task, event.type, ["reviewing"]);
      }
      assertReview(event.review, task);
      assertCurrentHead(task, event.review.head, "Review");
      assertCurrentGeneration(task, event.review.generation, "Review");
      if (
        task.reviews.some(
          (review) =>
            review.head === event.review.head &&
            review.generation === event.review.generation &&
            review.lens === event.review.lens,
        )
      ) {
        throw new TaskTransitionError(
          "duplicate-review",
          task,
          `Review lens ${event.review.lens} already exists for head ${event.review.head} generation ${event.review.generation}`,
        );
      }
      return commitTask(task, context.now, {
        reviews: [...task.reviews, event.review],
        findingLedger: recordReviewFindings({
          ledger: task.findingLedger ?? [],
          review: event.review,
          reviewRound: task.reviewRound,
        }),
      });
    }
    case "finish-review": {
      if (task.stage !== "reviewing") {
        invalidStage(task, event.type, ["reviewing"]);
      }
      assertHeadEvent(task, event.head, event.generation, "Review completion");
      assertCurrentHead(task, event.head, "Review completion");
      if (!hasSuccessfulCurrentValidation(task)) {
        throw new TaskTransitionError(
          "validation-mismatch",
          task,
          "Review completion requires successful validation for the current head",
        );
      }
      const current = activeReviews(task);
      const required = requiredReviewLenses(task, event.head);
      if (required.some((lens) => !current.some((review) => review.lens === lens))) {
        throw new TaskTransitionError(
          "review-incomplete",
          task,
          `Review completion requires the ${required.join(", ")} lens(es) for this round`,
        );
      }
      if (!allReviewLensesPass(task, required)) {
        return commitWithNotification(
          task,
          context,
          { stage: "awaiting-fixes" },
          reviewSummary(task),
        );
      }
      const acceptance = finalAcceptanceStatus(task, event.head);
      if (acceptance.satisfied) {
        return commitWithNotification(
          clearIterationScope(task),
          context,
          { stage: "ready" },
          readySummary(task, event.head),
          "coordinator",
        );
      }
      const outstanding = [...acceptance.missing, ...acceptance.failed, ...acceptance.stale];
      const finalRunRecorded = task.validationEvidence.some(
        (entry) =>
          entry.contract === "final" &&
          entry.head === acceptance.identity.head &&
          entry.policyDigest === acceptance.identity.policyDigest,
      );
      if (acceptance.failed.length > 0 || acceptance.stale.length > 0 || finalRunRecorded) {
        throw new TaskTransitionError(
          "final-acceptance-incomplete",
          task,
          `Task ${task.id} cannot be accepted: ${describeRequirements(outstanding)} did not pass under the delivered code and policy`,
        );
      }
      return commitWithNotification(
        task,
        context,
        { stage: "validating" },
        `Task ${task.id} is otherwise ready; running the final acceptance manifest for ${describeRequirements(outstanding)}`,
      );
    }
    case "invalidate-evidence": {
      if (
        task.kind !== "implementation" ||
        !["validating", "reviewing", "awaiting-fixes", "ready"].includes(task.stage)
      ) {
        invalidStage(task, event.type, ["validating", "reviewing", "awaiting-fixes", "ready"]);
      }
      assertHeadEvent(task, event.head, event.generation, "Evidence invalidation");
      const withoutHead = clearIterationScope(clearReviewHead(task));
      return commitTask(withoutHead, context.now, {
        stage: "implementing",
        generation: task.generation + 1,
        validationEvidence: [],
        reviews: [],
      });
    }
    case "follow-up-research": {
      if (task.kind !== "scout" || task.stage !== "completed") {
        invalidStage(task, event.type, ["completed"]);
      }
      const withoutCleanup = clearCleanup(task);
      return commitTask(withoutCleanup, context.now, {
        stage: "queued",
        generation: task.generation + 1,
      });
    }
    case "begin-fixes": {
      if (task.stage !== "awaiting-fixes") {
        invalidStage(task, event.type, ["awaiting-fixes"]);
      }
      if (event.head !== task.reviewHead || event.generation !== task.generation) {
        staleResult(
          task,
          `Fix attempt expectation ${event.head}/${event.generation} does not match ${String(task.reviewHead)}/${task.generation}`,
        );
      }
      if (
        !isInteger(task.policy.config.maxFixRounds) ||
        task.reviewRound >= task.policy.config.maxFixRounds
      ) {
        throw new TaskTransitionError(
          "max-fix-rounds",
          task,
          `Task ${task.id} has exhausted maxFixRounds=${String(task.policy.config.maxFixRounds)}`,
        );
      }
      if (event.iterationScope !== undefined) {
        assertIterationScope(task, event.iterationScope);
      }
      const withoutHead = clearIterationScope(clearReviewHead(task));
      return commitTask(withoutHead, context.now, {
        stage: "implementing",
        reviewRound: task.reviewRound + 1,
        generation: task.generation + 1,
        validationEvidence: [],
        ...(event.iterationScope === undefined ? {} : { iterationScope: event.iterationScope }),
      });
    }
    case "skip-review": {
      // `paused` only as the stopping step of a publish-now from validating or reviewing.
      const allowed: readonly TaskStage[] = [
        "validating",
        "reviewing",
        "awaiting-fixes",
        "blocked",
      ];
      const stoppedFrom = task.stage === "paused" ? task.previousStage : task.stage;
      if (
        task.kind !== "implementation" ||
        stoppedFrom === undefined ||
        !allowed.includes(stoppedFrom) ||
        (task.stage === "paused" && stoppedFrom === "blocked")
      ) {
        invalidStage(task, event.type, allowed);
      }
      if (task.worktree === undefined || !isNonEmptyText(event.head)) {
        throw new TaskTransitionError(
          "invalid-input",
          task,
          "Skipping review requires a task worktree and a committed HEAD",
        );
      }
      if (task.reviewHead !== undefined && task.reviewHead !== event.head) {
        staleResult(
          task,
          `Publish-now HEAD ${event.head} does not match the task HEAD ${task.reviewHead}`,
        );
      }
      return commitWithNotification(
        clearIterationScope(clearPreviousAndBlock(task)),
        context,
        { stage: "ready", reviewHead: event.head, reviewSkippedHead: event.head },
        `Task ${task.id} is ready without a finished review, at the user's request`,
        "coordinator",
      );
    }
    case "scout-report-complete": {
      if (task.stage !== "scouting" || task.kind !== "scout") {
        invalidStage(task, event.type, ["scouting"]);
      }
      assertCurrentGeneration(task, event.generation, "Scout report");
      if (!isNonEmptyText(event.reportPath)) {
        throw new TaskTransitionError("invalid-input", task, "Scout reportPath must be non-empty");
      }
      return commitWithNotification(
        task,
        context,
        { stage: "completed", reportPath: event.reportPath },
        `Scout report completed for task ${task.id}`,
        "coordinator",
      );
    }
    case "pause": {
      if (
        TERMINAL_STAGES.includes(task.stage) ||
        task.stage === "paused" ||
        task.stage === "blocked"
      ) {
        invalidStage(task, event.type, [
          "awaiting-approval",
          "queued",
          "scouting",
          "implementing",
          "validating",
          "reviewing",
          "awaiting-fixes",
          "ready",
        ]);
      }
      if (!isNonEmptyText(event.reason)) {
        throw new TaskTransitionError("invalid-input", task, "Pause requires a non-empty reason");
      }
      return commitWithNotification(
        task,
        context,
        { stage: "paused", previousStage: task.stage },
        `Task ${task.id} paused: ${event.reason}`,
      );
    }
    case "resume": {
      if (task.stage !== "paused" && task.stage !== "blocked") {
        invalidStage(task, event.type, ["paused", "blocked"]);
      }
      if (
        task.previousStage === undefined ||
        task.previousStage === "paused" ||
        task.previousStage === "blocked" ||
        TERMINAL_STAGES.includes(task.previousStage)
      ) {
        throw new TaskTransitionError(
          "invalid-stage",
          task,
          `Task ${task.id} has no resumable previous stage`,
        );
      }
      const resumed = clearPreviousAndBlock(task);
      return commitTask(resumed, context.now, { stage: task.previousStage });
    }
    case "cancel": {
      if (TERMINAL_STAGES.includes(task.stage)) {
        invalidStage(task, event.type, [
          "awaiting-approval",
          "queued",
          "scouting",
          "implementing",
          "validating",
          "reviewing",
          "awaiting-fixes",
          "ready",
          "paused",
          "blocked",
        ]);
      }
      if (event.reason !== undefined && !isNonEmptyText(event.reason)) {
        throw new TaskTransitionError(
          "invalid-input",
          task,
          "Cancel reason must be non-empty when supplied",
        );
      }
      const withoutPrevious = clearPreviousAndBlock(task);
      return commitWithNotification(
        withoutPrevious,
        context,
        { stage: "cancelled" },
        event.reason === undefined
          ? `Task ${task.id} cancelled`
          : `Task ${task.id} cancelled: ${event.reason}`,
      );
    }
    case "block": {
      if (
        TERMINAL_STAGES.includes(task.stage) ||
        task.stage === "paused" ||
        task.stage === "blocked"
      ) {
        invalidStage(task, event.type, [
          "awaiting-approval",
          "queued",
          "scouting",
          "implementing",
          "validating",
          "reviewing",
          "awaiting-fixes",
          "ready",
        ]);
      }
      if (!isNonEmptyText(event.reason)) {
        throw new TaskTransitionError("invalid-input", task, "Block requires a non-empty reason");
      }
      // A typed cause always shows its plain-English summary; the technical text stays in its detail.
      const shown = event.cause?.summary ?? event.reason;
      return commitWithNotification(
        task,
        context,
        {
          stage: "blocked",
          previousStage: task.stage,
          blockReason: shown,
          ...(event.cause === undefined ? {} : { blockCause: event.cause }),
        },
        `Task ${task.id} blocked: ${shown}`,
        "coordinator",
      );
    }
    case "merge": {
      if (task.stage !== "ready" || task.kind !== "implementation") {
        invalidStage(task, event.type, ["ready"]);
      }
      if (!event.approved || !event.verified) {
        throw new TaskTransitionError(
          "merge-not-verified",
          task,
          "Merge requires explicit approval and verified merge evidence",
        );
      }
      if (event.pullRequest?.state !== "merged" || !isNonEmptyText(event.pullRequest.head)) {
        throw new TaskTransitionError(
          "merge-not-verified",
          task,
          "Merged pull request must match the reviewed head",
        );
      }
      assertMergedHead(task, event);
      return commitWithNotification(
        task,
        context,
        { stage: "merged", pullRequest: event.pullRequest },
        `Task ${task.id} merged after approved and verified merge`,
      );
    }
    case "acknowledge-notification": {
      if (!isNonEmptyText(event.notificationId)) {
        throw new TaskTransitionError(
          "invalid-input",
          task,
          "Notification acknowledgement requires an id",
        );
      }
      const index = task.notifications.findIndex((entry) => entry.id === event.notificationId);
      if (index < 0) {
        throw new TaskTransitionError(
          "notification-not-found",
          task,
          `Notification ${event.notificationId} does not exist`,
        );
      }
      const current = task.notifications[index];
      if (current === undefined) {
        throw new TaskTransitionError(
          "notification-not-found",
          task,
          `Notification ${event.notificationId} does not exist`,
        );
      }
      if (current.acknowledged) {
        throw new TaskTransitionError(
          "notification-already-acknowledged",
          task,
          `Notification ${event.notificationId} is already acknowledged`,
        );
      }
      const notifications = [...task.notifications];
      notifications[index] = { ...current, acknowledged: true };
      return commitTask(task, context.now, { notifications });
    }
    default: {
      const neverEvent: never = event;
      throw new TaskTransitionError(
        "invalid-event",
        task,
        `Unsupported task event ${String(neverEvent)}`,
      );
    }
  }
}

export function isActiveTask(task: Pick<TaskRecord, "stage">): boolean {
  return !TERMINAL_STAGES.includes(task.stage);
}

export function pendingNotifications(
  task: Pick<TaskRecord, "notifications">,
): readonly Notification[] {
  return task.notifications.filter((entry) => !entry.acknowledged);
}

export function notificationDigest(task: Pick<TaskRecord, "notifications">): string {
  return pendingNotifications(task)
    .map((entry) => `[${entry.id}] ${entry.message}`)
    .join("\n");
}

export const ACTIVE_TASK_STAGES = TASK_STAGES.filter((stage) => !TERMINAL_STAGES.includes(stage));
export const ALL_REVIEW_LENSES = REVIEW_LENSES;
