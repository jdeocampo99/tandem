/**
 * The one short shape every question Tandem asks a person uses: a single plain-English question,
 * optionally followed by one short sentence. Recovery questions, routing pauses, spending pauses,
 * and approval prompts all render through this, so no prompt grows into a report. Task, decision,
 * request, and generation identifiers never appear in it; `tandem inspect` has them.
 */

/**
 * One structured decision question. `details` carries identifiers (task/decision/request ids,
 * generations, attempts) for durable records and for the answering model's tool calls; it is
 * never included in the rendered text and a caller displaying this question to a person must keep
 * it out of what they show.
 */
export type DecisionQuestion = Readonly<{
  /** The question itself, ending in "?". */
  readonly ask: string;
  /** At most one short sentence: the reason, or how to answer. */
  readonly note?: string;
  readonly details?: string;
}>;

export function formatDecisionQuestion(question: Omit<DecisionQuestion, "details">): string {
  return question.note === undefined ? question.ask : `${question.ask} ${question.note}`;
}

const TASK_NAME_MAX_CHARS = 48;
const NOTE_MAX_CHARS = 100;

/** Cuts text at a word boundary so a prompt never grows past one short line. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:]$/u, "")}…`;
}

/**
 * Names a task by its objective's first sentence, cut at a word boundary, so a prompt can say
 * which work it means without pasting the whole objective.
 */
export function taskName(objective: string): string {
  const sentence =
    objective
      .trim()
      .split(/(?<=[.!?])\s|\n/u)[0]
      ?.replace(/[.!?]$/u, "") ?? "";
  return `"${clip(sentence, TASK_NAME_MAX_CHARS)}"`;
}

/** One reason sentence, clipped to fit the single line a prompt allows. */
export function shortNote(text: string): string {
  const trimmed = text
    .trim()
    .replace(/[.]$/u, "")
    .replace(/^./u, (first) => first.toUpperCase());
  const clipped = clip(trimmed, NOTE_MAX_CHARS);
  return clipped.endsWith("…") ? clipped : `${clipped}.`;
}
