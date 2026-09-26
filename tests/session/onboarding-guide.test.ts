import { expect, test } from "bun:test";
import { ONBOARDING_DONE_TEXT, type OnboardingFacts } from "../../src/onboarding/checklist.ts";
import type { ToolCheck } from "../../src/onboarding/tools.ts";
import type { SessionEffect } from "../../src/session/events.ts";
import { OnboardingGuide } from "../../src/session/onboarding-guide.ts";

function guide(initial: OnboardingFacts, tools: readonly ToolCheck[] = []) {
  let facts = initial;
  const said: SessionEffect[] = [];
  const onboarding = new OnboardingGuide({
    host: {
      perform: async (effect) => {
        said.push(effect);
      },
    },
    service: () => ({
      onboardingFacts: async () => facts,
      checkTools: async () => tools,
    }),
    repo: "/tandem",
  });
  const texts = () => said.flatMap((effect) => (effect.type === "deliver" ? [effect.text] : []));
  return {
    onboarding,
    texts,
    set: (next: Partial<OnboardingFacts>) => {
      facts = { ...facts, ...next };
    },
  };
}

const unfinished: OnboardingFacts = {
  modelsChosen: true,
  codeFolders: ["/Users/me/code"],
  projects: [],
  workerSkillOffer: [],
  selfImprovementChosen: false,
};

test("setup reports missing tools at start and asks each plain question once", async () => {
  const { onboarding, texts } = guide(unfinished, [
    { name: "OMP", ok: false, detail: "not found", fix: "bun install -g omp" },
    { name: "Git", ok: true, detail: "git 2.50" },
  ]);
  await onboarding.sessionStart();
  expect(texts()).toHaveLength(2);
  expect(texts()[0]).toContain("- OMP, not found: run `bun install -g omp`");
  expect(texts()[1]).toStartWith("When a task keeps failing");
  await onboarding.afterAction();
  expect(texts()).toHaveLength(2);
});

test("the closing message comes once, when the last step is saved", async () => {
  const { onboarding, texts, set } = guide(unfinished);
  await onboarding.sessionStart();
  set({ selfImprovementChosen: true, projects: ["/Users/me/code/api"] });
  await onboarding.afterAction();
  await onboarding.afterAction();
  expect(texts().filter((text) => text === ONBOARDING_DONE_TEXT)).toHaveLength(1);
  expect(await onboarding.context()).toEqual([]);
});

test("a home that was already set up hears nothing", async () => {
  const { onboarding, texts } = guide({
    ...unfinished,
    selfImprovementChosen: true,
    projects: ["/Users/me/code/api"],
  });
  await onboarding.sessionStart();
  await onboarding.afterAction();
  expect(texts()).toEqual([]);
});
