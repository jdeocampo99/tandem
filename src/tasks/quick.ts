import { createHash } from "node:crypto";
import type {
  IsoTimestamp,
  QuickScopeReport,
  QuickTaskApproval,
  TaskRecord,
} from "../contracts.ts";

/**
 * Quick tasks: a clear, small change the user approves as they type it, with no interview. No
 * model ever decides that a request is quick; only the user does, through the native composer's
 * Start or `tandem quick`. Everything here is pure: the native verb and the CLI share it.
 */

/** Fewer characters or words than this is not yet a description of a change. */
export const QUICK_TASK_MIN_CHARS = 15;
export const QUICK_TASK_MIN_WORDS = 3;
/** A quick task is a sentence or two; anything longer is a request. */
export const QUICK_TASK_MAX_CHARS = 4_000;
export const QUICK_TASK_TOO_SHORT = "Describe the change in a sentence or two.";
export const QUICK_TASK_TOO_LONG =
  "That is more than a quick task. Start a request instead, so it gets an interview.";
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

/** The durable record of the user's approval: who (the user), when, how, and of exactly what. */
export function quickApproval(
  input: Readonly<{ text: string; at: IsoTimestamp; via: QuickTaskApproval["via"] }>,
): QuickTaskApproval {
  return {
    kind: "quick-task",
    text: input.text,
    textDigest: quickTextDigest(input.text),
    approvedAt: input.at,
    via: input.via,
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

/** The question's title line in the Needs you row and the alert. */
export const QUICK_SCOPE_TITLE = "Scope exceeds quick task";

function sentence(text: string): string {
  return text.trim().replace(/[.!?]+$/u, "");
}

function listed(names: readonly string[]): string {
  const clean = names.map((name) => name.trim()).filter((name) => name.length > 0);
  return clean.length < 2
    ? clean.join("")
    : `${clean.slice(0, -1).join(", ")} and ${clean.at(-1) ?? ""}`;
}

/** The scope question as the user reads it, one line per part, rendered from the worker's fields. */
export function quickScopeLines(taskId: string, scope: QuickScopeReport): readonly string[] {
  return [
    `${taskId} · ${QUICK_SCOPE_TITLE}`,
    `Affects ${scope.files} file${scope.files === 1 ? "" : "s"} across ${listed(scope.areas)}.`,
    ...(scope.decision === undefined ? [] : [`Open decision: ${sentence(scope.decision)}.`]),
    "No changes made.",
    `Proposed: ${sentence(scope.plan)}.`,
  ];
}

/** The same question as one line, for the task's durable question text. */
export function quickScopeQuestionText(scope: QuickScopeReport): string {
  return [`${QUICK_SCOPE_TITLE}.`, ...quickScopeLines("", scope).slice(1)].join(" ");
}

/** The three answers, in the order they are offered. */
export const QUICK_SCOPE_CHOICES = ["proceed", "convert", "cancel"] as const;
export type QuickScopeChoice = (typeof QUICK_SCOPE_CHOICES)[number];
export const QUICK_SCOPE_LABELS: Readonly<Record<QuickScopeChoice, string>> = {
  proceed: "Proceed",
  convert: "Convert to request",
  cancel: "Cancel",
};

/** Reads an answer by its label or its short name; anything else is not one of the three. */
export function parseQuickScopeAnswer(text: string): QuickScopeChoice | undefined {
  const answer = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "");
  return QUICK_SCOPE_CHOICES.find(
    (choice) => answer === choice || answer === QUICK_SCOPE_LABELS[choice].toLowerCase(),
  );
}

export const QUICK_SCOPE_ANSWER_REFUSAL = `This question takes ${QUICK_SCOPE_CHOICES.map((choice) => `"${QUICK_SCOPE_LABELS[choice]}"`).join(", ")} only. The question is still open.`;

/** What the worker is told when the user answers Proceed. */
export const QUICK_SCOPE_PROCEED_TEXT =
  "Proceed: the user approved going beyond a quick task with your proposed plan. Make the change now. Do not ask about scope again.";

/**
 * Whether a quick task's implementer may still ask its one scope question: only a quick task, and
 * only before it has asked one.
 */
export function quickScopeQuestionAllowed(task: Pick<TaskRecord, "quick">): boolean {
  return task.quick !== undefined && task.quick.scopeQuestionId === undefined;
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
  return [
    approved,
    quick.scopeExtendedAt === undefined
      ? "You already asked the scope question for this task; do not submit scopeExceeded again."
      : "The user chose to proceed beyond a quick task with your proposed plan. Make the change; do not ask about scope again.",
  ];
}

/**
 * The request the coordinator receives when the user converts a quick task: the original words and
 * what the worker found, so the interview starts from them.
 */
export function quickConvertedText(
  task: Pick<TaskRecord, "id" | "quick">,
  scope: QuickScopeReport | undefined,
): string {
  const text = task.quick?.text ?? "";
  return [
    `${task.id} · Converted to a request`,
    `The user's request: ${JSON.stringify(text)}`,
    ...(scope === undefined
      ? []
      : [`What the worker found: ${quickScopeLines(task.id, scope).slice(1).join(" ")}`]),
  ].join("\n");
}
