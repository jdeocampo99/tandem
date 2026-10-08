import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { IsoTimestamp, QuickTaskApproval, TaskRecord } from "../contracts.ts";
import { quickScopeQuestionAllowed } from "./quick-scope.ts";

/**
 * Quick tasks: a clear, small change the user approves as they type it, with no interview. No
 * model ever decides that a request is quick; only the user does, through the native composer's
 * Start. There is deliberately no CLI entry: a worker's shell cannot be told apart from the user's.
 * Everything here is pure.
 */

/** What the quick task composer draws: its project chip and the checks that gate Start. */
export type QuickTaskView = Readonly<{
  schemaVersion: 1;
  /** The project the click is proved against: the focused coordinator's. */
  repo: string;
  /** The branch the task's pull request targets. */
  branch: string;
  placeholder: string;
  minChars: number;
  minWords: number;
  /** The longest trimmed text Start accepts; the backend refuses anything longer. */
  maxChars: number;
  tooShort: string;
  tooLong: string;
}>;

export function quickTaskView(
  input: Readonly<{ repoPath: string; branch: string }>,
): QuickTaskView {
  return {
    schemaVersion: 1,
    repo: basename(input.repoPath),
    branch: input.branch,
    placeholder: "Describe the change",
    minChars: QUICK_TASK_MIN_CHARS,
    minWords: QUICK_TASK_MIN_WORDS,
    maxChars: QUICK_TASK_MAX_CHARS,
    tooShort: QUICK_TASK_TOO_SHORT,
    tooLong: QUICK_TASK_TOO_LONG,
  };
}

/** Fewer characters or words than this is not yet a description of a change. */
export const QUICK_TASK_MIN_CHARS = 15;
export const QUICK_TASK_MIN_WORDS = 3;
/** A quick task is a sentence or two; anything longer is a request. */
export const QUICK_TASK_MAX_CHARS = 4_000;
export const QUICK_TASK_TOO_SHORT = "Describe the change in a sentence or two.";
export const QUICK_TASK_TOO_LONG = "Too long for a quick task. Start a request instead.";
/** How many characters of the first line name the task. */
const TITLE_MAX_CHARS = 60;

export type QuickTextCheck =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; problem: string }>;

/** Whether the typed text describes a change; only length and word count, never a model. */
export function checkQuickText(raw: string): QuickTextCheck {
  const text = raw.trim();
  if (text.includes("\0")) return { ok: false, problem: QUICK_TASK_TOO_SHORT };
  const words = text.split(/\s+/u).filter((word) => word.length > 0).length;
  if (text.length < QUICK_TASK_MIN_CHARS || words < QUICK_TASK_MIN_WORDS)
    return { ok: false, problem: QUICK_TASK_TOO_SHORT };
  if (text.length > QUICK_TASK_MAX_CHARS) return { ok: false, problem: QUICK_TASK_TOO_LONG };
  return { ok: true, text };
}

/** The first non-empty line, collapsed and cut at a word boundary. */
export function quickTaskTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/u)
      .map((entry) => entry.replace(/\s+/gu, " ").trim())
      .find((entry) => entry.length > 0) ?? "";
  if (line.length <= TITLE_MAX_CHARS) return line;
  const cut = line.slice(0, TITLE_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[,;:.]$/u, "")}…`;
}

export function quickTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The durable record of the user's approval: who (the user), when, and of exactly what. */
export function quickApproval(
  input: Readonly<{ text: string; at: IsoTimestamp }>,
): QuickTaskApproval {
  return {
    kind: "quick-task",
    text: input.text,
    textDigest: quickTextDigest(input.text),
    approvedAt: input.at,
  };
}

/** `HH:MM` on a 24-hour clock, in the given time zone or the machine's. */
export function clockTime(at: IsoTimestamp, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(at));
}

/** The one chat text the coordinator gets when a quick task starts. */
export function quickStartedText(
  task: Pick<TaskRecord, "id" | "title" | "objective">,
  approval: Pick<QuickTaskApproval, "approvedAt">,
  timeZone?: string,
): string {
  return [
    "Quick task started",
    `${task.id} · ${task.title ?? quickTaskTitle(task.objective)}`,
    `Scope approved ${clockTime(approval.approvedAt, timeZone)}`,
  ].join("\n");
}

/** The heading of the verbatim scope on the task page and in the pull request. */
export function approvedScopeLabel(
  approval: Pick<QuickTaskApproval, "approvedAt">,
  timeZone?: string,
): string {
  return `Approved scope (quick task, ${clockTime(approval.approvedAt, timeZone)})`;
}

/** The scope section of a quick task's pull request: the user's words, quoted verbatim. */
export function approvedScopeMarkdown(approval: QuickTaskApproval, timeZone?: string): string {
  const quoted = approval.text.split(/\r?\n/u).map((line) => (line === "" ? ">" : `> ${line}`));
  const stretched =
    approval.scopeExtendedAt === undefined
      ? []
      : [
          "",
          `The user chose to proceed beyond a quick task at ${clockTime(approval.scopeExtendedAt, timeZone)}.`,
        ];
  return [`# ${approvedScopeLabel(approval, timeZone)}`, ...quoted, ...stretched].join("\n");
}

/** How the reviewer is told the scope was approved: the objective is the user's own words. */
export function quickApprovalLine(approval: QuickTaskApproval): string {
  const base = `quick task; the objective is the user's own text, approved as typed at ${approval.approvedAt} (sha256 ${approval.textDigest})`;
  return approval.scopeExtendedAt === undefined
    ? base
    : `${base}. At ${approval.scopeExtendedAt} the user chose Proceed on the worker's scope question, approving work beyond a small change along the plan in that question`;
}

/** How long a quick task may sit unapproved before a tick decides its Start never finished. */
export const QUICK_START_GRACE_MS = 60_000;
export const QUICK_START_UNFINISHED = "Quick task did not finish starting";

/**
 * Whether a quick task's Start stopped between creating and approving it: a quick task is never
 * shown for approval, so one still awaiting it past the grace (which spares a Start in flight)
 * is cancelled.
 */
export function quickStartUnfinished(
  task: Pick<TaskRecord, "quick" | "stage" | "createdAt">,
  now: IsoTimestamp,
): boolean {
  return (
    task.quick !== undefined &&
    task.stage === "awaiting-approval" &&
    Date.parse(now) - Date.parse(task.createdAt) >= QUICK_START_GRACE_MS
  );
}

/**
 * What a quick task's implementer is told: the objective is the user's own approved words, and it
 * may stop once, before changing anything, when the request clearly exceeds a small change.
 */
export function quickTaskInstructions(task: Pick<TaskRecord, "quick">): readonly string[] {
  const quick = task.quick;
  if (quick === undefined) return [];
  const approved =
    "This is a quick task: the objective is the user's request exactly as they typed it, and they approved it as the scope without an interview. Stay inside their words.";
  if (quickScopeQuestionAllowed(task))
    return [
      approved,
      "Before you change any file, check whether the request clearly exceeds a small change: for example many files across different areas of the code, or a design decision the request leaves open. If it does, make no changes and call submit_report with outcome needs-decision, your reasons in report, and scopeExceeded with files, areas, decision (only if one is open) and a one-sentence plan. Tandem asks the user whether to proceed, turn it into a request, or cancel. You can ask this once.",
    ];
  // An unanswered question is never permission to proceed: Tandem refuses to resume such a task,
  // and a brief written anyway tells the worker to change nothing.
  return [
    approved,
    quick.scopeExtendedAt === undefined
      ? "You already asked the scope question for this task and the user has not chosen Proceed. Do not change any file and do not submit scopeExceeded again; the scope is still only their original words."
      : "The user chose to proceed beyond a quick task with your proposed plan. Make the change; do not ask about scope again.",
  ];
}
