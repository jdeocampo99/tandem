import type { QuickScopeReport, TaskRecord } from "../contracts.ts";

/**
 * A quick task's one scope question: how it reads, its three answers, and what each answer still
 * has to do. The worker only fills the fields; Tandem renders the question. Everything here is pure.
 */
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

/**
 * The answer a scope-question link sends: only while that very question is still the task's open
 * scope question, and only as one of the three labels, so it goes through the ordinary answer path.
 */
export function quickScopeAnswer(
  task: Pick<TaskRecord, "communication">,
  questionId: string,
  choice: QuickScopeChoice,
): Readonly<{ questionId: string; text: string }> {
  const question = task.communication?.question;
  if (question?.id !== questionId || question.scope === undefined)
    throw new Error("That scope question is no longer open; nothing was answered");
  return { questionId: question.id, text: QUICK_SCOPE_LABELS[choice] };
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
 * Whether a quick task is waiting on the user's answer to its scope question: the worker asked,
 * the user has not chosen Proceed, and the task is not cancelled. Until they answer, nothing may
 * resume or re-dispatch its implementer, because the request it would build was never approved.
 */
export function quickScopeAwaitingAnswer(task: Pick<TaskRecord, "quick" | "stage">): boolean {
  return (
    task.quick?.scopeQuestionId !== undefined &&
    task.quick.scopeExtendedAt === undefined &&
    task.stage !== "cancelled"
  );
}

/**
 * What is left of a recorded scope answer, or undefined when nothing is: the answer is recorded
 * first, so each step here is one of its effects that has not happened yet. Proceed answers the
 * worker while the question is still open, then resumes the task still blocked on that question
 * (its block names the question's job). Cancel and Convert cancel the task, then close the
 * question in one write that, for Convert, also hands the request to the coordinator. A cancel that
 * was already tried and could not prove the worker stopped `waits`: it is never retried on its own,
 * only when the user answers again.
 */
export function quickScopeNextStep(
  task: Pick<TaskRecord, "quick" | "stage" | "previousStage" | "blockCause" | "communication">,
  cancelTried: boolean,
): "answer-worker" | "resume" | "cancel" | "close-question" | "wait" | undefined {
  const answer = task.quick?.scopeAnswer;
  const questionId = task.quick?.scopeQuestionId;
  if (answer === undefined || questionId === undefined) return undefined;
  if (task.communication?.question?.id !== questionId)
    return answer.choice === "proceed" &&
      task.communication?.question === undefined &&
      task.stage === "blocked" &&
      task.blockCause?.jobId === questionId &&
      task.previousStage !== undefined &&
      task.previousStage !== "paused" &&
      task.previousStage !== "blocked"
      ? "resume"
      : undefined;
  if (answer.choice === "proceed") return task.stage === "cancelled" ? undefined : "answer-worker";
  if (task.stage === "cancelled") return "close-question";
  return cancelTried ? "wait" : "cancel";
}

/** Why a quick task waiting on its scope question cannot resume, and how to move it on. */
export function quickScopeResumeRefusal(taskId: string): string {
  return `Task ${taskId} is waiting on its scope question. Answer it with ${QUICK_SCOPE_CHOICES.map((choice) => `"${QUICK_SCOPE_LABELS[choice]}"`).join(", ")}; it can't resume until then.`;
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
