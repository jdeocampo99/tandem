import { expect, test } from "bun:test";
import { formatDecisionQuestion, shortNote, taskName } from "../../src/tasks/question.ts";

test("a question is the ask, then at most one short note", () => {
  expect(formatDecisionQuestion({ ask: "Restart it?" })).toBe("Restart it?");
  expect(formatDecisionQuestion({ ask: "Restart it?", note: 'Reply "restart" or "stop".' })).toBe(
    'Restart it? Reply "restart" or "stop".',
  );
});

test("a task is named by its first sentence, cut at a word", () => {
  expect(taskName("Add a streak bar. Then polish it.")).toBe('"Add a streak bar"');
  const long = taskName(
    "Recover the already-implemented approved brief req-7367ed76 revision 2 from exact commit 7862bd0",
  );
  expect(long).toBe('"Recover the already-implemented approved brief…"');
});

test("a note is clipped to one line", () => {
  expect(shortNote("The worker ran out of time")).toBe("The worker ran out of time.");
  expect(shortNote("word ".repeat(40)).length).toBeLessThanOrEqual(101);
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
