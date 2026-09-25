import { expect, test } from "bun:test";
import {
  JEV_MODEL,
  type JevChoiceAnswer,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import {
  checkIssueDraft,
  scrubIssueDraft,
  workContentOf,
} from "../../src/self-improvement/issue-draft.ts";
import { task } from "../session/fixtures.ts";

const WORK = task({
  repoPath: "/Users/me/Coding/acme-billing",
  objective: "Charge the late fee on overdue invoices. Keep the old rounding.",
  acceptanceCriteria: ["Overdue invoices get exactly one late fee."],
});

test("the scrub removes code, local paths, secrets, the task's words, and the project name", () => {
  const draft = scrubIssueDraft(
    {
      title: "Reviewer times out on acme-billing",
      body: [
        "The task (Charge the late fee on overdue invoices.) restarted twice.",
        "It stalled in /Users/me/Coding/acme-billing/src/fees.ts and ~/.tandem/jobs/task-1.",
        "```ts\nconst fee = invoice.total * 0.05;\n```",
        "Token ghp_abcdefghijklmnopqrstuvwxyz0123 leaked.",
        "Tandem's src/recovery/central.ts and https://github.com/jdeocampo99/tandem/issues/190 stay.",
      ].join("\n"),
    },
    workContentOf(WORK),
  );
  expect(draft.title).toBe("Reviewer times out on (project name removed)");
  expect(draft.body).toBe(
    [
      "The task ((task text removed)) restarted twice.",
      "It stalled in (path removed) and (path removed).",
      "(code removed)",
      "Token (secret removed) leaked.",
      "Tandem's src/recovery/central.ts and https://github.com/jdeocampo99/tandem/issues/190 stay.",
    ].join("\n"),
  );
});

test("the Tandem repository's own name is never scrubbed", () => {
  const content = workContentOf(task({ repoPath: "/Users/me/Coding/tandem" }));
  expect(content.names).toEqual([]);
});

function answer(choice: string, confidence = 0.95): JevChoiceAnswer {
  const other = choice === "clean" ? "flagged" : "clean";
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: { [choice]: confidence, [other]: 1 - confidence },
  };
}

test("only a confident clean answer passes; a flag, failure, or missing key is flagged", async () => {
  const draft = { title: "Reviewer times out", body: "It restarted twice." };
  const config = { apiKey: "key", timeoutMs: 1_500 };
  const seen: JevEvaluationInput[] = [];
  const replying =
    (reply: JevChoiceAnswer) =>
    async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
      seen.push(input);
      return {
        model: JEV_MODEL,
        answers: { leak: reply },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
  expect(await checkIssueDraft(draft, config, replying(answer("clean")))).toEqual({
    flagged: false,
  });
  expect(seen[0]?.state).toEqual(draft);
  expect((await checkIssueDraft(draft, config, replying(answer("flagged")))).flagged).toBe(true);
  expect((await checkIssueDraft(draft, config, replying(answer("clean", 0.6)))).flagged).toBe(true);
  const timingOut = async (): Promise<JevEvaluationResponse> => {
    throw new JevEvaluationError("timeout", "slow");
  };
  expect(await checkIssueDraft(draft, config, timingOut)).toEqual({
    flagged: true,
    warning: "The check for work details didn't finish.",
  });
  expect((await checkIssueDraft(draft, { timeoutMs: 1_500 })).flagged).toBe(true);
});
