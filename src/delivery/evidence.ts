import type {
  FindingLedgerEntry,
  PinnedValidationEvidence,
  TaskRecord,
  TaskStage,
} from "../contracts.ts";
import { LEGACY_EVIDENCE_CONTRACT } from "../contracts.ts";
import { renderDraftPrDescription, renderPrDescription } from "../instructions.ts";
import {
  FINAL_REVIEW_LENSES,
  type FinalRequirement,
  finalAcceptanceContract,
  finalAcceptanceStatus,
  ValidationConfigurationError,
} from "../tasks/acceptance.ts";
import { findingHeadline, fixRoundBudget } from "../tasks/findings.ts";
import { recordedReviewLevel } from "../tasks/review-levels.ts";

export type PrSummary = Readonly<{
  readonly tldr: readonly string[];
  readonly what: readonly string[];
  readonly why: readonly string[];
}>;

export type DeliveryTaskShape = Readonly<{
  readonly cwd: string;
  readonly branch: string;
  readonly head: string;
}>;

const REQUIRED_LENSES = FINAL_REVIEW_LENSES;
const MAX_EVIDENCE_OUTPUT = 512;
const MAX_DRAFT_ENTRY = 220;
const MAX_DRAFT_BLOCKERS = 8;

/**
 * Stages whose durable state can back a draft. Draft eligibility is deliberately separate from
 * `assertTaskShape`: it proves only that unfinished work exists to show, never that it is ready.
 */
const DRAFT_ELIGIBLE_STAGES: readonly TaskStage[] = [
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
  "ready",
  "paused",
  "blocked",
];

export function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text without NUL characters`);
  }
  return value.trim();
}

export function readSingleLine(value: unknown, field: string): string {
  const text = readText(value, field);
  if (/[\r\n\u2028\u2029]/u.test(text)) {
    throw new TypeError(`${field} must be a single-line value`);
  }
  return text;
}

export function assertEvidence(
  task: TaskRecord,
  head: string,
): readonly PinnedValidationEvidence[] {
  if (!Array.isArray(task.validationEvidence) || task.validationEvidence.length === 0) {
    throw new Error("delivery requires nonempty validation evidence");
  }

  const evidence: PinnedValidationEvidence[] = [];
  for (const candidate of task.validationEvidence) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("delivery requires complete validation evidence bound to the reviewed HEAD");
    }
    const candidateRecord = candidate as Record<string, unknown>;
    const name = candidateRecord.name;
    const argv = candidateRecord.argv;
    const exitCode = candidateRecord.exitCode;
    const stdout = candidateRecord.stdout;
    const stderr = candidateRecord.stderr;
    const contract = candidateRecord.contract;
    const origin = candidateRecord.origin;
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((argument) => typeof argument !== "string" || argument.length === 0) ||
      typeof exitCode !== "number" ||
      !Number.isSafeInteger(exitCode) ||
      typeof stdout !== "string" ||
      typeof stderr !== "string" ||
      candidateRecord.head !== head
    ) {
      throw new Error("delivery requires complete validation evidence bound to the reviewed HEAD");
    }
    if (contract === LEGACY_EVIDENCE_CONTRACT) {
      throw new Error(
        `delivery requires evidence pinned to a validation contract; ${name} predates validation contracts and the final acceptance manifest must run again at HEAD ${head}`,
      );
    }
    if (
      (contract !== "iteration" && contract !== "final") ||
      (origin !== "local" && origin !== "github") ||
      typeof candidateRecord.policyDigest !== "string" ||
      candidateRecord.policyDigest.trim().length === 0
    ) {
      throw new Error("delivery requires complete validation evidence bound to the reviewed HEAD");
    }
    if (exitCode !== 0) {
      throw new Error(`delivery requires successful validation; ${name} exited with ${exitCode}`);
    }
    evidence.push(candidateRecord as PinnedValidationEvidence);
  }
  return evidence;
}

/** Refuses delivery unless the complete final manifest passed for the delivered code and policy. */
export function assertFinalAcceptance(task: TaskRecord, head: string): void {
  const status = finalAcceptanceStatus(task, head);
  if (status.satisfied) return;
  const outstanding = [...status.missing, ...status.failed, ...status.stale]
    .map((requirement) => `${requirement.name} (${requirement.origin})`)
    .join(", ");
  if (outstanding.length > 0) {
    throw new Error(
      `delivery requires a complete final acceptance run at HEAD ${head}; outstanding: ${outstanding}`,
    );
  }
  throw new Error(
    `delivery requires passing ${status.pendingLenses.join(", ")} review at HEAD ${head}`,
  );
}

export function assertCurrentReviews(task: TaskRecord, head: string): void {
  if (!Array.isArray(task.reviews)) throw new Error("delivery requires recorded review lenses");
  const current = task.reviews.filter(
    (review) => review.head === head && review.generation === task.generation,
  );
  if (current.length !== REQUIRED_LENSES.length) {
    throw new Error("delivery requires exactly one current result for each review lens");
  }
  for (const lens of REQUIRED_LENSES) {
    const matching = current.filter((review) => review.lens === lens);
    if (matching.length !== 1 || matching[0]?.pass !== true) {
      throw new Error("delivery requires a passing current review");
    }
  }
}

export function assertTaskShape(task: TaskRecord): DeliveryTaskShape {
  if (task === null || typeof task !== "object" || Array.isArray(task)) {
    throw new TypeError("task must be a TaskRecord");
  }
  if (task.stage !== "ready") throw new Error(`task ${String(task.id)} is not ready for delivery`);
  if (task.scopeApproved !== true)
    throw new Error(`task ${String(task.id)} has not received scope approval`);
  const worktree = task.worktree;
  if (worktree === null || typeof worktree !== "object" || Array.isArray(worktree)) {
    throw new Error("delivery requires a task worktree lease");
  }

  const cwd = readSingleLine(worktree.path, "task.worktree.path");
  const branch = readSingleLine(worktree.branch, "task.worktree.branch");
  const head = readSingleLine(task.reviewHead, "task.reviewHead");
  if (!Number.isSafeInteger(task.generation) || task.generation < 0) {
    throw new Error("delivery requires a non-negative task generation");
  }
  // The user's explicit "publish now" at this exact HEAD stands in for the review gates.
  if (task.reviewSkippedHead !== head) {
    assertEvidence(task, head);
    assertCurrentReviews(task, head);
    assertFinalAcceptance(task, head);
  }
  return { cwd, branch, head };
}

function evidenceOutput(value: string): string {
  const compact = value.replace(/[\r\n]+/gu, "\\n");
  const bounded =
    compact.length <= MAX_EVIDENCE_OUTPUT
      ? compact
      : `${compact.slice(0, MAX_EVIDENCE_OUTPUT - 1)}…`;
  return JSON.stringify(bounded);
}

function evidenceBullet(entry: PinnedValidationEvidence): string {
  const argv = entry.argv.map((argument) => JSON.stringify(argument)).join(" ");
  return `${entry.name} [${entry.contract} contract, ${entry.origin} check]: exit code ${entry.exitCode} at reviewed HEAD ${entry.head}; argv ${argv}; stdout ${evidenceOutput(entry.stdout)}; stderr ${evidenceOutput(entry.stderr)}`;
}

function validateSummary(summary: PrSummary): PrSummary {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    throw new TypeError("summary must be a PrSummary");
  }
  return { tldr: summary.tldr, what: summary.what, why: summary.why };
}

function findingBullet(entry: FindingLedgerEntry): string {
  const where =
    entry.file === undefined
      ? ""
      : ` (${entry.file}${entry.line === undefined ? "" : `:${entry.line}`})`;
  return `${entry.severity}: ${findingHeadline(entry.description)}${where}`;
}

function acceptedValidation(task: TaskRecord, head: string): readonly string[] {
  const manifest = finalAcceptanceContract(task, head);
  return [
    `final acceptance manifest at HEAD ${head}: ${manifest.requirements.length} required checks, ${manifest.lenses.length} review lenses, ${manifest.criteria.length} acceptance criteria`,
    ...assertEvidence(task, head).map(evidenceBullet),
  ];
}

function skippedValidation(task: TaskRecord, head: string): readonly string[] {
  const floors = task.reviewLevel?.floors ?? [];
  return [
    `Review was skipped at the user's request at HEAD ${head}.`,
    ...(floors.length === 0 ? [] : [`Risk checks the change tripped: ${floors.join(", ")}.`]),
    ...passedValidation(task, head),
  ];
}

/** Validation that did pass before a skip; a skip mid-validation may have none. */
function passedValidation(task: TaskRecord, head: string): readonly string[] {
  try {
    return assertEvidence(task, head).map(evidenceBullet);
  } catch {
    return [];
  }
}

export function describeTaskPr(task: TaskRecord, summary: PrSummary): string {
  const shape = assertTaskShape(task);
  const validatedSummary = validateSummary(summary);
  const skipped = task.reviewSkippedHead === shape.head;
  const validation = skipped
    ? skippedValidation(task, shape.head)
    : acceptedValidation(task, shape.head);
  const openFindings = (task.findingLedger ?? []).filter((entry) => entry.status !== "addressed");
  return renderPrDescription({
    tldr: validatedSummary.tldr,
    what: validatedSummary.what,
    why: validatedSummary.why,
    validation,
    ...(openFindings.length > 0 ? { openFindings: openFindings.map(findingBullet) } : {}),
    ...(task.manualVerification === undefined
      ? {}
      : { manualVerification: task.manualVerification }),
  });
}

export type DraftTaskShape = Readonly<{
  readonly cwd: string;
  readonly branch: string;
  readonly generation: number;
}>;

export type ReviewLevelSummary = Readonly<{
  readonly level: string;
  readonly reason: string;
  /** What the pinned policy still demands at final acceptance, whatever the level is. */
  readonly finalRequirements: string;
}>;

export type DraftProgress = Readonly<{
  readonly reviewLevel: ReviewLevelSummary;
  readonly activity: readonly string[];
  readonly blockers: readonly string[];
  readonly remainingChecks: readonly string[];
}>;

export type DraftDescriptionInput = Readonly<{
  readonly task: TaskRecord;
  /** The commit this draft actually publishes, which may lag the task worktree. */
  readonly publishedHead: string;
  readonly worktreeHead: string;
  readonly uncommittedChanges: boolean;
}>;

function draftText(value: string): string {
  const compact = value.split(/\s+/u).join(" ").trim();
  if (compact.length <= MAX_DRAFT_ENTRY) return compact;
  return `${compact.slice(0, MAX_DRAFT_ENTRY - 1)}…`;
}

/**
 * Report the review level the task is actually recorded under, together with the classifier's own
 * reason and any safety floors, plus what the pinned policy demands at that level. Showing the
 * level is visibility only; it never changes the final gates below it.
 */
export function pinnedReviewLevel(task: TaskRecord): ReviewLevelSummary {
  const config = task.policy?.config;
  if (config === undefined || !Number.isSafeInteger(config.maxFixRounds)) {
    throw new TypeError("draft progress requires a pinned repository policy");
  }
  const recorded = recordedReviewLevel(task);
  const floors =
    recorded.floors.length === 0 ? "" : `; safety floors: ${recorded.floors.join(", ")}`;
  return {
    level: recorded.level,
    reason: `${recorded.reason}${floors}`,
    finalRequirements: `Whatever the level, the pinned repository policy requires review at final acceptance by a fresh read-only reviewer, ${config.validationCommands.length} pinned validation command(s), and at most ${config.maxFixRounds} bounded fix round(s).`,
  };
}

/**
 * Prove that unfinished work exists to show. Scope approval alone is not publication approval, and
 * this check never asserts readiness, mergeability, or acceptance.
 */
export function assertDraftTaskShape(task: TaskRecord): DraftTaskShape {
  if (task === null || typeof task !== "object" || Array.isArray(task)) {
    throw new TypeError("task must be a TaskRecord");
  }
  if (task.kind !== "implementation") {
    throw new Error(`task ${String(task.id)} is not an implementation task`);
  }
  if (task.scopeApproved !== true) {
    throw new Error(`task ${String(task.id)} has not received scope approval`);
  }
  if (!DRAFT_ELIGIBLE_STAGES.includes(task.stage)) {
    throw new Error(
      `task ${String(task.id)} is ${String(task.stage)} and has no draft-eligible work`,
    );
  }
  const worktree = task.worktree;
  if (worktree === null || typeof worktree !== "object" || Array.isArray(worktree)) {
    throw new Error("a draft requires a task worktree lease");
  }
  if (!Number.isSafeInteger(task.generation) || task.generation < 0) {
    throw new Error("a draft requires a non-negative task generation");
  }
  return {
    cwd: readSingleLine(worktree.path, "task.worktree.path"),
    branch: readSingleLine(worktree.branch, "task.worktree.branch"),
    generation: task.generation,
  };
}

function currentReviews(task: TaskRecord): readonly TaskRecord["reviews"][number][] {
  if (task.reviewHead === undefined || !Array.isArray(task.reviews)) return [];
  return task.reviews.filter(
    (review) => review.head === task.reviewHead && review.generation === task.generation,
  );
}

function draftActivity(task: TaskRecord): readonly string[] {
  const head = task.reviewHead === undefined ? "no reviewed HEAD yet" : `HEAD ${task.reviewHead}`;
  switch (task.stage) {
    case "implementing":
      return [`An implementer is working in the task worktree at generation ${task.generation}.`];
    case "validating":
      return [
        `The runner is executing the planned validation contract against ${head}; a targeted iteration run never substitutes for the final acceptance manifest.`,
      ];
    case "reviewing": {
      const recorded = currentReviews(task);
      const detail =
        recorded.length === 0
          ? "not yet recorded"
          : recorded.map((review) => (review.pass ? "pass" : "findings")).join(", ");
      return [`A fresh read-only reviewer is recording the review at ${head}; ${detail}.`];
    }
    case "awaiting-fixes":
      return [
        `Review recorded findings at ${head}; fix round ${task.reviewRound} of ${fixRoundBudget(task)} has been used.`,
      ];
    case "ready":
      return [
        `The final acceptance manifest and the review pass at ${head}. Delivery acceptance is still a separate explicit step.`,
      ];
    case "paused":
      return [
        `Work is paused${task.previousStage === undefined ? "" : ` from ${task.previousStage}`} and is not progressing.`,
      ];
    default:
      return ["Work is blocked and needs coordinator judgment before it can progress."];
  }
}

function draftBlockers(task: TaskRecord): readonly string[] {
  const blockers: string[] = [];
  if (task.blockReason !== undefined) {
    blockers.push(`Durable blocker: ${draftText(task.blockReason)}`);
  }
  if (task.stage === "awaiting-fixes" && task.reviewRound >= fixRoundBudget(task)) {
    blockers.push(
      `The bounded fix-round loop is exhausted at ${task.reviewRound} of ${fixRoundBudget(task)}; no further fix round runs until the user says to keep fixing.`,
    );
  }
  const question = task.communication?.question;
  if (question !== undefined) {
    blockers.push(`A question is awaiting an answer: ${draftText(question.text)}`);
  }
  for (const evidence of task.validationEvidence) {
    if (evidence.exitCode === 0 || evidence.head !== task.reviewHead) continue;
    blockers.push(
      `Validation command ${draftText(evidence.name)} exited with ${evidence.exitCode} at HEAD ${evidence.head}.`,
    );
  }
  for (const review of currentReviews(task)) {
    if (review.pass) continue;
    const findings = review.findings
      .map((finding) => `${finding.id}/${finding.severity}: ${finding.description}`)
      .join("; ");
    blockers.push(
      `Review lens ${review.lens} recorded findings: ${draftText(findings.length === 0 ? review.summary : findings)}`,
    );
  }
  return blockers.slice(0, MAX_DRAFT_BLOCKERS).map(draftText);
}

function describeRequirement(requirement: FinalRequirement, detail: string): string {
  return `Final acceptance requirement ${requirement.name} (${requirement.origin} check) ${detail}.`;
}

/**
 * Report what the final acceptance manifest still needs, read from the manifest owner in
 * `tasks/acceptance.ts` so the draft shows exactly the checks the final gate will require.
 */
function draftRemainingChecks(task: TaskRecord, candidateHead: string | undefined): string[] {
  if (candidateHead === undefined) {
    return [
      "The complete final acceptance manifest at the first validated candidate commit; no candidate commit has been recorded yet.",
    ];
  }
  let status: ReturnType<typeof finalAcceptanceStatus>;
  try {
    status = finalAcceptanceStatus(task, candidateHead);
  } catch (error) {
    if (error instanceof ValidationConfigurationError) {
      return [
        `${error.message}; that is a validation configuration failure the final gate refuses, not a pass.`,
      ];
    }
    throw error;
  }
  const remaining: string[] = [];
  for (const requirement of status.missing) {
    remaining.push(describeRequirement(requirement, "has no recorded evidence"));
  }
  for (const requirement of status.stale) {
    remaining.push(
      describeRequirement(requirement, "has only stale evidence from another commit or policy"),
    );
  }
  for (const requirement of status.failed) {
    remaining.push(describeRequirement(requirement, "recorded a failing result"));
  }
  for (const _lens of status.pendingLenses) {
    remaining.push(
      "A passing review by a fresh independent read-only reviewer at the candidate commit.",
    );
  }
  return remaining;
}

/** Summarize durable task state for a draft. Pure: no checkout, remote, or runtime observation. */
export function summarizeDraftProgress(
  task: TaskRecord,
  candidateHead = task.reviewHead,
): DraftProgress {
  assertDraftTaskShape(task);
  return {
    reviewLevel: pinnedReviewLevel(task),
    activity: draftActivity(task),
    blockers: draftBlockers(task),
    remainingChecks: [
      ...draftRemainingChecks(task, candidateHead),
      "Runner-owned required GitHub checks on the delivered commit.",
    ].map(draftText),
  };
}

/**
 * Identify the durable task state a draft body renders, so a refresh happens when that state
 * changes rather than on every revision bump.
 */
export function draftProgressDigest(task: TaskRecord): string {
  return JSON.stringify([
    task.stage,
    task.generation,
    task.reviewRound,
    task.reviewHead ?? "",
    task.objective,
    summarizeDraftProgress(task),
  ]);
}

export function describeTaskDraftPr(input: DraftDescriptionInput): string {
  const shape = assertDraftTaskShape(input.task);
  const publishedHead = readSingleLine(input.publishedHead, "publishedHead");
  const worktreeHead = readSingleLine(input.worktreeHead, "worktreeHead");
  const progress = summarizeDraftProgress(input.task, input.task.reviewHead ?? publishedHead);
  const status = [
    `Task ${input.task.id} is ${input.task.stage} at generation ${shape.generation}, fix round ${input.task.reviewRound} of ${fixRoundBudget(input.task)}.`,
    `Draft commit: ${publishedHead} on branch ${shape.branch}.`,
    `Objective: ${draftText(input.task.objective)}`,
  ];
  if (worktreeHead !== publishedHead) {
    status.push(
      `The task worktree is at ${worktreeHead}; the branch could not be advanced, so this draft shows the older commit.`,
    );
  }
  if (input.uncommittedChanges) {
    status.push(
      "The task worktree has uncommitted changes that are not part of this draft; the draft shows committed work only.",
    );
  }
  return renderDraftPrDescription({
    status,
    reviewLevel: [
      `Review level: ${progress.reviewLevel.level}.`,
      `Reason: ${draftText(progress.reviewLevel.reason)}`,
      progress.reviewLevel.finalRequirements,
    ],
    activity: progress.activity.map(draftText),
    blockers: progress.blockers,
    remainingChecks: progress.remainingChecks,
  });
}
