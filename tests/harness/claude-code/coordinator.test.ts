import { expect, test } from "bun:test";
import { turnMessages } from "../../../src/harness/claude-code/coordinator.ts";
import type { OnboardingFacts } from "../../../src/onboarding/checklist.ts";
import type { SetupApplyResult } from "../../../src/onboarding/setup-page.ts";
import { OnboardingGuide } from "../../../src/session/onboarding-guide.ts";

const openPage: OnboardingFacts = {
  modelsChosen: true,
  terminalChosen: true,
  codeFolders: ["/Users/me/code"],
  projects: [],
  selfImprovementChosen: false,
  setupPage: "open",
};

/** A setup page with one comment waiting on the coordinator's answer. */
function waitingSetupPage() {
  const replies: (string | undefined)[] = [];
  const { promise: prompted, resolve: prompt } = Promise.withResolvers<string>();
  const { promise: answered, resolve: answer } = Promise.withResolvers<void>();
  let calls = 0;
  const guide = new OnboardingGuide({
    host: {
      perform: async (effect) => {
        if (effect.type === "promptAsUser") prompt(effect.text);
      },
    },
    service: () => ({
      onboardingFacts: async () => openPage,
      checkTools: async () => [],
      awaitSetupAnswer: async (_repo, _signal, reply) => {
        replies.push(reply);
        if (++calls === 1) return { kind: "comment", text: "Where are my repos?", ended: false };
        answer();
        return { kind: "closed" };
      },
      applySetup: async (): Promise<SetupApplyResult> => ({ message: "", complete: true }),
    }),
    repo: "/tandem",
  });
  return { guide, replies, prompted, answered };
}

test("a finished Claude Code run answers the setup page comment that started it", async () => {
  const { guide, replies, prompted, answered } = waitingSetupPage();
  await guide.afterAction();
  const prompt = await prompted;
  guide.agentEnd({
    willContinue: false,
    messages: () =>
      turnMessages({ type: "agentEnd", interrupted: false, prompt, answer: "In ~/code." }),
  });
  await answered;
  expect(replies).toEqual([undefined, "In ~/code."]);
});

test("a run without its prompt never passes for the comment's answer", async () => {
  const { guide, replies, prompted } = waitingSetupPage();
  await guide.afterAction();
  await prompted;
  guide.agentEnd({
    willContinue: false,
    messages: () => turnMessages({ type: "agentEnd", interrupted: false, answer: "Unrelated." }),
  });
  await Bun.sleep(0);
  expect(replies).toEqual([undefined]);
  guide.stop();
});
