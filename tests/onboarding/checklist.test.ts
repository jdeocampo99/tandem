import { expect, test } from "bun:test";
import {
  type OnboardingFacts,
  onboardingStatus,
  remainingOnboardingSteps,
} from "../../src/onboarding/checklist.ts";

const fresh: OnboardingFacts = {
  modelsChosen: false,
  codeFolders: [],
  projects: [],
  workerSkillsSettled: false,
  selfImprovementChosen: false,
};

test("a fresh home has every setup step left, in the order the chat walks them", () => {
  expect(remainingOnboardingSteps(fresh)).toEqual([
    "models",
    "code-folders",
    "repositories",
    "worker-skills",
    "self-improvement",
  ]);
  expect(onboardingStatus(fresh)).toContain("1. choose models");
});

test("setup resumes at the first step saved state does not cover", () => {
  const halfway = { ...fresh, modelsChosen: true, codeFolders: ["/Users/me/code"] };
  expect(remainingOnboardingSteps(halfway)[0]).toBe("repositories");
  const status = onboardingStatus(halfway);
  expect(status).toContain("1. set up at least one repository");
  expect(status).not.toContain("choose models");
});

test("setup is done once every step is covered", () => {
  const done: OnboardingFacts = {
    modelsChosen: true,
    codeFolders: ["/Users/me/code"],
    projects: ["/Users/me/code/api"],
    workerSkillsSettled: true,
    selfImprovementChosen: true,
  };
  expect(remainingOnboardingSteps(done)).toEqual([]);
  expect(onboardingStatus(done)).toStartWith("Onboarding is done (repositories: 1 set up)");
});
