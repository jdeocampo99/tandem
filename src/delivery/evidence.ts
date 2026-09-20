import type {
  ResolvedPolicy,
  ReviewLens,
  TaskRecord,
  TaskStage,
  ValidationEvidence,
} from "../contracts.ts";
import { renderDraftPrDescription, renderPrDescription } from "../instructions.ts";
import { commandMatchesSurfaces } from "../workers/validation.ts";

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

const REQUIRED_LENSES: readonly ReviewLens[] = ["behavior", "design", "coverage", "verification"];
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

export function assertEvidence(task: TaskRecord, head: string): readonly ValidationEvidence[] {
  if (!Array.isArray(task.validationEvidence) || task.validationEvidence.length === 0) {
    throw new Error("delivery requires nonempty validation evidence");
  }

  const evidence: ValidationEvidence[] = [];
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
    if (exitCode !== 0) {
      throw new Error(`delivery requires successful validation; ${name} exited with ${exitCode}`);
    }
    evidence.push(candidateRecord as ValidationEvidence);
  }
  return evidence;
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
      throw new Error(`delivery requires a passing current ${lens} review`);
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
  assertEvidence(task, head);
  assertCurrentReviews(task, head);
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

function evidenceBullet(entry: ValidationEvidence): string {
  const argv = entry.argv.map((argument) => JSON.stringify(argument)).join(" ");
  return `${entry.name}: exit code ${entry.exitCode} at reviewed HEAD ${entry.head}; argv ${argv}; stdout ${evidenceOutput(entry.stdout)}; stderr ${evidenceOutput(entry.stderr)}`;
}

function validateSummary(summary: PrSummary): PrSummary {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    throw new TypeError("summary must be a PrSummary");
  }
  return { tldr: summary.tldr, what: summary.what, why: summary.why };
}

export function describeTaskPr(task: TaskRecord, summary: PrSummary): string {
  const shape = assertTaskShape(task);
  const evidence = assertEvidence(task, shape.head);
  const validatedSummary = validateSummary(summary);
  return renderPrDescription({
    tldr: validatedSummary.tldr,
    what: validatedSummary.what,
    why: validatedSummary.why,
    validation: evidence.map(evidenceBullet),
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
 * Report the review contract the currently pinned repository policy demands. A later risk-based
 * classification may supply the level instead; the final gates this describes do not change.
 */
export function pinnedReviewLevel(policy: ResolvedPolicy): ReviewLevelSummary {
  const config = policy?.config;
  if (config === undefined || !Number.isSafeInteger(config.maxFixRounds)) {
    throw new TypeError("draft progress requires a pinned repository policy");
  }
  const commands = config.validationCommands.length;
  return {
    level: "standard",
    reason: `the pinned repository policy requires ${REQUIRED_LENSES.join(", ")} review by fresh read-only reviewers, ${commands} pinned validation command(s), and at most ${config.maxFixRounds} bounded fix round(s)`,
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
      return [`The runner is executing the pinned validation commands against ${head}.`];
    case "reviewing": {
      const recorded = currentReviews(task);
      const detail =
        recorded.length === 0
          ? "no lens has been recorded yet"
          : recorded
              .map((review) => `${review.lens}=${review.pass ? "pass" : "findings"}`)
              .join(", ");
      return [
        `Fresh read-only reviewers are recording lenses at ${head}; ${recorded.length} of ${REQUIRED_LENSES.length} recorded (${detail}).`,
      ];
    }
    case "awaiting-fixes":
      return [
        `Review recorded findings at ${head}; fix round ${task.reviewRound} of ${task.policy.config.maxFixRounds} has been used.`,
      ];
    case "ready":
      return [
        `Current validation and all ${REQUIRED_LENSES.length} review lenses pass at ${head}. Delivery acceptance is still a separate explicit step.`,
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
  if (task.stage === "awaiting-fixes" && task.reviewRound >= task.policy.config.maxFixRounds) {
    blockers.push(
      `The bounded fix-round loop is exhausted at ${task.reviewRound} of ${task.policy.config.maxFixRounds}; no further fix round is admitted automatically.`,
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

function draftRemainingChecks(task: TaskRecord): readonly string[] {
  const remaining: string[] = [];
  const commands = task.policy.config.validationCommands.filter((command) =>
    commandMatchesSurfaces(command, task.surfaces),
  );
  if (commands.length === 0) {
    remaining.push(
      "No pinned validation command matches this task's surfaces; that is a validation configuration failure, not a pass.",
    );
  }
  for (const command of commands) {
    const passed = task.validationEvidence.some(
      (evidence) =>
        evidence.name === command.name &&
        evidence.exitCode === 0 &&
        task.reviewHead !== undefined &&
        evidence.head === task.reviewHead,
    );
    if (!passed) {
      remaining.push(
        `Pinned validation command ${draftText(command.name)} has no passing evidence at the current HEAD.`,
      );
    }
  }
  const passing = currentReviews(task).filter((review) => review.pass);
  for (const lens of REQUIRED_LENSES) {
    if (!passing.some((review) => review.lens === lens)) {
      remaining.push(
        `A passing ${lens} review by a fresh independent read-only reviewer at the current HEAD.`,
      );
    }
  }
  remaining.push("Runner-owned required GitHub checks on the delivered commit.");
  return remaining.map(draftText);
}

/** Summarize durable task state for a draft. Pure: no checkout, remote, or runtime observation. */
export function summarizeDraftProgress(task: TaskRecord): DraftProgress {
  assertDraftTaskShape(task);
  return {
    reviewLevel: pinnedReviewLevel(task.policy),
    activity: draftActivity(task),
    blockers: draftBlockers(task),
    remainingChecks: draftRemainingChecks(task),
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
  const progress = summarizeDraftProgress(input.task);
  const status = [
    `Task ${input.task.id} is ${input.task.stage} at generation ${shape.generation}, fix round ${input.task.reviewRound} of ${input.task.policy.config.maxFixRounds}.`,
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
    ],
    activity: progress.activity.map(draftText),
    blockers: progress.blockers,
    remainingChecks: progress.remainingChecks,
  });
}
