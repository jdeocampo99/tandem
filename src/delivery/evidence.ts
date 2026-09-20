import type { TaskRecord, ValidationEvidence } from "../contracts.ts";
import { renderPrDescription } from "../instructions.ts";
import {
  FINAL_REVIEW_LENSES,
  finalAcceptanceContract,
  finalAcceptanceStatus,
} from "../tasks/acceptance.ts";

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
      candidateRecord.head !== head ||
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
    evidence.push(candidateRecord as ValidationEvidence);
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
  assertFinalAcceptance(task, head);
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
  return `${entry.name} [${entry.contract} contract, ${entry.origin} check]: exit code ${entry.exitCode} at reviewed HEAD ${entry.head}; argv ${argv}; stdout ${evidenceOutput(entry.stdout)}; stderr ${evidenceOutput(entry.stderr)}`;
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
  const manifest = finalAcceptanceContract(task, shape.head);
  const validatedSummary = validateSummary(summary);
  return renderPrDescription({
    tldr: validatedSummary.tldr,
    what: validatedSummary.what,
    why: validatedSummary.why,
    validation: [
      `final acceptance manifest at HEAD ${shape.head}: ${manifest.requirements.length} required checks, ${manifest.lenses.length} review lenses, ${manifest.criteria.length} acceptance criteria`,
      ...evidence.map(evidenceBullet),
    ],
  });
}
