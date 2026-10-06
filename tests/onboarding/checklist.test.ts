import { expect, test } from "bun:test";
import {
  type OnboardingFacts,
  onboardingContext,
  onboardingQuestion,
  remainingOnboardingSteps,
} from "../../src/onboarding/checklist.ts";

const fresh: OnboardingFacts = {
  modelsChosen: false,
  codeFolders: [],
  projects: [],
  selfImprovementChosen: false,
};

const done: OnboardingFacts = {
  modelsChosen: true,
  codeFolders: ["/Users/me/code"],
  projects: ["/Users/me/code/api"],
  selfImprovementChosen: true,
};

test("setup walks the fixed choices before repositories", () => {
  expect(remainingOnboardingSteps(fresh)).toEqual([
    "models",
    "code-folders",
    "self-improvement",
    "repositories",
  ]);
});

test("the chat reads only the current step's guidance, and nothing once setup is done", () => {
  const halfway = {
    ...fresh,
    modelsChosen: true,
    codeFolders: ["/Users/me/code"],
  };
  const context = onboardingContext(halfway) ?? "";
  expect(context).toContain("self-improvement");
  expect(context).toEndWith("Then: repositories.");
  expect(context).not.toContain("configure-models");
  expect(onboardingContext(done)).toBeUndefined();
});

test("plain-choice steps have fixed wording; open-ended steps have none", () => {
  expect(onboardingQuestion("self-improvement")?.hidden).toContain("self-improvement");
  expect(onboardingQuestion("models")).toBeUndefined();
  expect(onboardingQuestion("repositories")).toBeUndefined();
});
