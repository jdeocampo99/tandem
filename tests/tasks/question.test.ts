import { expect, test } from "bun:test";
import { formatDecisionQuestion } from "../../src/tasks/question.ts";

test("formatDecisionQuestion renders what/recommendation/risk in order", () => {
  const text = formatDecisionQuestion({
    what: "A task is blocked.",
    recommendation: "Run reconcile.",
    risk: "Nothing changes until you decide.",
  });
  expect(text).toBe(
    "What happened: A task is blocked. What I want to do: Run reconcile. What you risk: Nothing changes until you decide.",
  );
});

test("choices are appended as a labelled, comma-joined list when given", () => {
  const withChoices = formatDecisionQuestion({
    what: "A task is blocked.",
    recommendation: "Pick one.",
    risk: "Nothing changes until you decide.",
    choices: ["restart", "stop"],
  });
  expect(withChoices).toContain("Choices: restart, stop.");

  const withoutChoices = formatDecisionQuestion({
    what: "A task is blocked.",
    recommendation: "Pick one.",
    risk: "Nothing changes until you decide.",
  });
  expect(withoutChoices).not.toContain("Choices:");
});

/**
 * Fails with a readable diff when any of `ids` appears in `text`. Every prompt built through
 * {@link formatDecisionQuestion} — recovery questions, routing pauses, spending pauses — is
 * expected to pass this: task, decision, request, generation, and attempt identifiers belong in a
 * durable record or a hidden channel, never in the sentence a person reads.
 */
export function expectNoIdentifiers(text: string, ids: readonly string[]): void {
  for (const id of ids) {
    expect(text).not.toContain(id);
  }
}
