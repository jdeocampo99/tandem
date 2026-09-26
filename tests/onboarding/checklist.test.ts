import { expect, test } from "bun:test";
import {
  chatAsksSetupQuestions,
  type OnboardingFacts,
  onboardingContext,
  onboardingQuestion,
  remainingOnboardingSteps,
} from "../../src/onboarding/checklist.ts";

const fresh: OnboardingFacts = {
  modelsChosen: false,
  codeFolders: [],
  projects: [],
  workerSkillOffer: ["buildkite"],
  selfImprovementChosen: false,
  setupPage: "unavailable",
};

const done: OnboardingFacts = {
  modelsChosen: true,
  codeFolders: ["/Users/me/code"],
  projects: ["/Users/me/code/api"],
  workerSkillOffer: [],
  selfImprovementChosen: true,
  setupPage: "unavailable",
};

test("setup walks the plain choices before repositories, so the first repository finishes it", () => {
  expect(remainingOnboardingSteps(fresh)).toEqual([
    "models",
    "code-folders",
    "worker-skills",
    "self-improvement",
    "repositories",
  ]);
  expect(remainingOnboardingSteps({ ...fresh, workerSkillOffer: [] })).not.toContain(
    "worker-skills",
  );
});

test("the chat reads only the current step's guidance, and nothing once setup is done", () => {
  const halfway = { ...fresh, modelsChosen: true, codeFolders: ["/Users/me/code"] };
  const context = onboardingContext(halfway) ?? "";
  expect(context).toStartWith(
    "Setup is unfinished. Current step: Tandem asked about plugin skills",
  );
  expect(context).toEndWith("Then: self-improvement, repositories.");
  expect(context).not.toContain("configure-models");
  expect(onboardingContext(done)).toBeUndefined();
});

test("plain-choice steps have fixed wording; open-ended steps have none", () => {
  expect(onboardingQuestion("worker-skills", fresh)?.text).toContain("skills: buildkite.");
  expect(onboardingQuestion("self-improvement", fresh)?.hidden).toContain("self-improvement");
  expect(onboardingQuestion("models", fresh)).toBeUndefined();
  expect(onboardingQuestion("repositories", fresh)).toBeUndefined();
});

test("while Lavish is there, the setup page comes first and the chat keeps its steps as fallback", () => {
  const ready = onboardingContext({ ...fresh, setupPage: "ready" }) ?? "";
  expect(ready).toStartWith("Setup is unfinished. When the user wants to set up, call setup-page");
  expect(ready).toContain("Current step: Choose models");
  const open = onboardingContext({ ...fresh, setupPage: "open" }) ?? "";
  expect(open).toContain("The setup page is open; its answer reaches you by itself.");
  expect(chatAsksSetupQuestions({ ...fresh, setupPage: "ready" })).toBe(false);
  expect(chatAsksSetupQuestions({ ...fresh, setupPage: "open" })).toBe(false);
  expect(chatAsksSetupQuestions({ ...fresh, setupPage: "done" })).toBe(true);
  expect(onboardingContext({ ...done, setupPage: "ready" })).toBeUndefined();
});
