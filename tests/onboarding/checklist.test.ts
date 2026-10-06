import { expect, test } from "bun:test";
import {
  type OnboardingFacts,
  onboardingContext,
  onboardingQuestion,
  remainingOnboardingSteps,
} from "../../src/onboarding/checklist.ts";

const fresh: OnboardingFacts = {
  modelsChosen: false,
  terminalChosen: true,
  codeFolders: [],
  projects: [],
  selfImprovementChosen: false,
};

const done: OnboardingFacts = {
  modelsChosen: true,
  terminalChosen: true,
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
    terminalChosen: true,
    codeFolders: ["/Users/me/code"],
  };
  const context = onboardingContext(halfway) ?? "";
  expect(context).toContain("self-improvement");
  expect(context).toEndWith("Then: repositories.");
  expect(context).not.toContain("configure-models");
  expect(onboardingContext(done)).toBeUndefined();
});

test("plain-choice steps have fixed wording; open-ended steps have none", () => {
  expect(onboardingQuestion("self-improvement", fresh)?.hidden).toContain("self-improvement");
  expect(onboardingQuestion("models", fresh)).toBeUndefined();
  expect(onboardingQuestion("repositories", fresh)).toBeUndefined();
});

test("a saved model setup still asks for an explicit terminal choice", () => {
  const facts = { ...done, terminalChosen: false, tern: { status: "ready" as const } };
  expect(remainingOnboardingSteps(facts)).toEqual(["terminal"]);
  expect(onboardingContext(facts)).toContain("terminal-setting");
  expect(onboardingQuestion("terminal", facts)?.text).toContain("Herdr or Tern");
});

for (const tern of [
  { status: "missing" },
  { status: "signedOut" },
  { status: "unknown", reason: "Tern could not start." },
] as const) {
  test(`${tern.status} Tern is never offered in chat setup`, () => {
    const facts = { ...done, terminalChosen: false, tern };
    const question = onboardingQuestion("terminal", facts);
    expect(question?.text).toContain("Using Herdr.");
    expect(question?.text).not.toContain("Herdr or Tern");
    expect(question?.hidden).toContain("with herdr");
    expect(onboardingContext(facts)).toContain(question?.text ?? "missing");
  });
}
