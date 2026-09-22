/**
 * Pure domain helpers for "you check" criteria: hands-on/visual acceptance criteria the user judges
 * from builder screenshots instead of a validation command. Review lenses never block or ask on
 * these; the task asks one short end question instead. See docs/agent-reference.md.
 */

import type { Finding, TaskQuestion, TaskRecord, UserCheckEvidence } from "../contracts.js";
import { type DecisionQuestion, formatDecisionQuestion, taskName } from "./question.js";

export const USER_CHECK_QUESTION_ID_PREFIX = "user-check-";

export function userCheckQuestionId(generation: number, head: string): string {
  return `${USER_CHECK_QUESTION_ID_PREFIX}${generation}-${head}`;
}

export function userCheckCriteriaOf(task: TaskRecord): readonly string[] {
  return task.userCheckCriteria ?? [];
}

export type UserCheckStatus = "none" | "pending" | "confirmed" | "changes-requested";

export function userCheckStatus(task: TaskRecord): UserCheckStatus {
  if (userCheckCriteriaOf(task).length === 0) return "none";
  const record = task.userCheck;
  if (
    record === undefined ||
    record.head !== task.reviewHead ||
    record.generation !== task.generation ||
    record.answer === undefined
  ) {
    return "pending";
  }
  return record.answer.outcome;
}

export const USER_CHECK_EXTENSIONS = {
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif"],
  clip: [".webm", ".mp4", ".mov"],
} as const;

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

export function isImagePath(path: string): boolean {
  return hasExtension(path, USER_CHECK_EXTENSIONS.image);
}

export function isClipPath(path: string): boolean {
  return hasExtension(path, USER_CHECK_EXTENSIONS.clip);
}

function countEvidence(evidence: readonly UserCheckEvidence[]): {
  readonly images: number;
  readonly clips: number;
  readonly withoutEvidence: number;
} {
  let images = 0;
  let clips = 0;
  let withoutEvidence = 0;
  for (const entry of evidence) {
    if (entry.paths.length === 0) {
      withoutEvidence += 1;
      continue;
    }
    for (const path of entry.paths) {
      if (isImagePath(path)) images += 1;
      else if (isClipPath(path)) clips += 1;
    }
  }
  return { images, clips, withoutEvidence };
}

function evidenceNote(evidence: readonly UserCheckEvidence[]): string {
  const { images, clips, withoutEvidence } = countEvidence(evidence);
  const parts: string[] = [];
  if (images > 0) parts.push(`${images} screenshot${images === 1 ? "" : "s"}`);
  if (clips > 0) parts.push(`${clips} clip${clips === 1 ? "" : "s"}`);
  const base =
    parts.length === 0 ? "No screenshots were saved." : `${parts.join(" and ")} attached.`;
  const withNote =
    withoutEvidence > 0
      ? `${base} ${withoutEvidence} item${withoutEvidence === 1 ? "" : "s"} have none.`
      : base;
  return withNote.length <= 100 ? withNote : base;
}

/** The unformatted ask/note pair, for a caller that needs them shown separately (e.g. a title and
 *  message in a confirmation dialog) rather than joined into one line. */
export function userCheckDecisionQuestion(task: TaskRecord): DecisionQuestion {
  const evidence = task.userCheck?.evidence ?? [];
  return {
    ask: `Does ${taskName(task.objective)} look right?`,
    note: evidenceNote(evidence),
  };
}

export function userCheckQuestion(task: TaskRecord, head: string): TaskQuestion {
  return {
    id: userCheckQuestionId(task.generation, head),
    text: formatDecisionQuestion(userCheckDecisionQuestion(task)),
  };
}

export function isUserCheckYes(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "");
  return normalized === "yes" || normalized === "y";
}

export function userCheckFinding(task: TaskRecord): Finding | undefined {
  if (userCheckStatus(task) !== "changes-requested") return undefined;
  const answer = task.userCheck?.answer;
  if (answer === undefined || answer.outcome !== "changes-requested") return undefined;
  return {
    id: "user-check",
    severity: "P1",
    verdict: "confirmed",
    description: `The user checked the screenshots and asked for changes: ${answer.text ?? ""}`,
  };
}
