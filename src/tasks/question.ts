/**
 * The one plain-English shape every approval prompt uses: what happened, what Tandem wants to do
 * about it, and what is at stake either way. Every surface that stops on a human decision —
 * recovery questions, routing pauses, spending pauses, and (eventually) brief/delivery approvals —
 * renders its prompt through this formatter, so a user never has to learn a different shape per
 * subsystem and never sees a task, decision, request, or generation identifier in the sentence
 * they are asked to read.
 */

/**
 * One structured decision question. `details` carries identifiers (task/decision/request ids,
 * generations, attempts) for durable records and for the answering model's tool calls; it is
 * never included in the rendered text and a caller displaying this question to a person must keep
 * it out of what they show.
 */
export type DecisionQuestion = Readonly<{
  readonly what: string;
  readonly recommendation: string;
  readonly risk: string;
  /** Short, plain labels for the answers this question accepts, when it is a closed choice. */
  readonly choices?: readonly string[];
  readonly details?: string;
}>;

/** Renders `what`/`recommendation`/`risk` (and `choices`, when given) into one plain-English question. */
export function formatDecisionQuestion(question: Omit<DecisionQuestion, "details">): string {
  const lines = [
    `What happened: ${question.what}`,
    `What I want to do: ${question.recommendation}`,
    `What you risk: ${question.risk}`,
  ];
  if (question.choices !== undefined && question.choices.length > 0) {
    lines.push(`Choices: ${question.choices.join(", ")}.`);
  }
  return lines.join(" ");
}
