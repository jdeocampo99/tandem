import { expect, test } from "bun:test";
import type { JevEvaluationInput } from "../../src/adapters/typesafe.ts";
import type { RequestBriefContent } from "../../src/contracts.ts";
import { checkBriefLanguage } from "../../src/requests/plain-language.ts";

const plain: RequestBriefContent = {
  goal: "Customers who cancel keep Premium until the period they paid for ends.",
  summary: {
    title: "Keep Premium after cancelling",
    beforeAfter: [
      { moment: "Cancelling", before: "Premium ends at once.", after: "Premium lasts." },
    ],
    size: { level: "large", reason: "Changes every Premium check." },
    risk: { level: "high", reason: "Touches money." },
  },
  scope: ["src/billing/access.ts"],
  constraints: [],
  nonGoals: [],
  acceptanceCriteria: ["`bun test` passes"],
  manualVerification: ["Cancel in the sandbox and keep paid content."],
  recommendedApproach: ["Use one access rule everywhere Premium is checked."],
  keyDecisions: [],
  openQuestions: [],
  researchLinks: [],
};

const config = { apiKey: "key", timeoutMs: 1000 };

function jevSays(choices: Readonly<Record<string, string>>) {
  const calls: JevEvaluationInput[] = [];
  const evaluate = async (input: JevEvaluationInput) => {
    calls.push(input);
    const answers = Object.fromEntries(
      Object.keys(input.questions).map((key) => {
        const choice = choices[key] ?? "plain";
        return [
          key,
          { type: "choice" as const, choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 },
        ];
      }),
    );
    return { model: "jev", answers, usage: { input_tokens: 1, output_tokens: 0 } };
  };
  return { calls, evaluate };
}

test("a plain top passes, and the details below the divider are never checked", async () => {
  const jev = jevSays({});

  expect(await checkBriefLanguage(plain, config, jev.evaluate)).toEqual([]);
  expect(JSON.stringify(jev.calls[0]?.state)).not.toContain("src/billing");
});

test("exact tells are named with the text that tripped them, even without Jev", async () => {
  const findings = await checkBriefLanguage(
    {
      ...plain,
      goal: "Fix the `entitlement_state` check — a robust fix.",
      recommendedApproach: ["Edit src/billing/access.ts"],
    },
    { timeoutMs: 1000 },
  );

  expect(findings).toEqual([
    'TL;DR has an em dash: "—"',
    'TL;DR has code formatting: "`entitlement_state`"',
    'TL;DR has a code name: "entitlement_state"',
    'TL;DR has a filler word: "robust"',
    'Approach has a file path: "src/billing/access.ts"',
  ]);
});

test("Jev flags a section only when it is confident the section is jargon", async () => {
  const jev = jevSays({ section0: "jargon" });
  const findings = await checkBriefLanguage(plain, config, jev.evaluate);

  expect(findings).toEqual(["TL;DR may not read plainly to someone who never read the code"]);

  const unsure = await checkBriefLanguage(plain, config, async (input) => ({
    model: "jev",
    answers: Object.fromEntries(
      Object.keys(input.questions).map((key) => [
        key,
        {
          type: "choice" as const,
          choice: "jargon",
          probabilities: { jargon: 0.55 },
          confidence: 0.55,
        },
      ]),
    ),
    usage: { input_tokens: 1, output_tokens: 0 },
  }));
  expect(unsure).toEqual([]);
});

test("a Jev failure never blocks the draft", async () => {
  const findings = await checkBriefLanguage(plain, config, async () => {
    throw new Error("down");
  });

  expect(findings).toEqual([]);
});
