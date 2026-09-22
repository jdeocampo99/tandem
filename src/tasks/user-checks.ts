/**
 * Pure domain helpers for "you check" criteria: hands-on/visual acceptance criteria the user judges
 * from builder screenshots instead of a validation command. Review lenses never block or ask on
 * these; the task asks one short end question instead. See docs/agent-reference.md.
 */

import { isAbsolute, relative, sep } from "node:path";
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

/** Cap on a single "you check" evidence file's size, shared by submission-time verification
 *  (`checkUserCheckFiles`) and inline attachment (`readUserCheckAttachment`). */
export const MAX_USER_CHECK_FILE_BYTES = 5 * 1024 * 1024;

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

/** Whether `path` is lexically inside `directory`, given both are already absolute. Neither is
 *  resolved here: a caller that needs symlink-resolved containment (evidence already saved to
 *  disk) resolves both with `realpath` first and passes the resolved pair; a caller checking a raw
 *  submitted path before any file necessarily exists (the worker's own report tool) passes it as
 *  is. The single owner for both. */
export function isPathWithinDirectory(directory: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const rel = relative(directory, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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

function evidenceNote(evidence: readonly UserCheckEvidence[], handedOffCount: number): string {
  const { images, clips, withoutEvidence } = countEvidence(evidence);
  const parts: string[] = [];
  if (images > 0) parts.push(`${images} screenshot${images === 1 ? "" : "s"}`);
  if (clips > 0) parts.push(`${clips} clip${clips === 1 ? "" : "s"}`);
  const base =
    parts.length === 0 ? "No screenshots were saved." : `${parts.join(" and ")} attached.`;
  const notes: string[] = [];
  if (withoutEvidence > 0) {
    notes.push(`${withoutEvidence} item${withoutEvidence === 1 ? " has" : "s have"} none.`);
  }
  if (handedOffCount > 0) {
    notes.push(
      `Review handed you ${handedOffCount} item${handedOffCount === 1 ? "" : "s"} with no screenshots.`,
    );
  }
  const withNote = notes.length === 0 ? base : `${base} ${notes.join(" ")}`;
  return withNote.length <= 100 ? withNote : base;
}

/** The unformatted ask/note pair, for a caller that needs them shown separately (e.g. a title and
 *  message in a confirmation dialog) rather than joined into one line. */
export function userCheckDecisionQuestion(task: TaskRecord): DecisionQuestion {
  const evidence = task.userCheck?.evidence ?? [];
  const handedOffCount = task.handedOffCriteria?.length ?? 0;
  return {
    ask: `Does ${taskName(task.objective)} look right?`,
    note: evidenceNote(evidence, handedOffCount),
  };
}

export function userCheckQuestion(task: TaskRecord, head: string): TaskQuestion {
  return {
    id: userCheckQuestionId(task.generation, head),
    text: formatDecisionQuestion(userCheckDecisionQuestion(task)),
  };
}

/** Conservative: only a clear leading yes counts, immediately followed by punctuation or the end
 *  of the reply — never a bare prefix inside a longer word ("yesterday") or a qualified reply
 *  ("yes but the color is off"), and never an implied yes with no "yes" at all ("looks good"). */
const USER_CHECK_YES = /^(?:yes|yep|yeah|y)(?:[.,!?;:]|$)/u;

export function isUserCheckYes(text: string): boolean {
  return USER_CHECK_YES.test(text.trim().toLowerCase());
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
