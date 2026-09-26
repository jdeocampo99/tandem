/**
 * What first-time setup still needs, worked out from saved state on every turn, so leaving halfway
 * resumes at the next missing step. Pure: the caller reads the facts.
 */
export type OnboardingFacts = Readonly<{
  readonly modelsChosen: boolean;
  /** Folders saved for finding repositories by name. */
  readonly codeFolders: readonly string[];
  /** Saved projects other than the Tandem checkout. */
  readonly projects: readonly string[];
  /** Whether the user answered the plugin-skills offer, or there was nothing to offer. */
  readonly workerSkillsSettled: boolean;
  readonly selfImprovementChosen: boolean;
}>;

export type OnboardingStep =
  | "models"
  | "code-folders"
  | "repositories"
  | "worker-skills"
  | "self-improvement";

/** In the order the Tandem coordinator walks through them. */
export function remainingOnboardingSteps(facts: OnboardingFacts): readonly OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (!facts.modelsChosen) steps.push("models");
  if (facts.codeFolders.length === 0) steps.push("code-folders");
  if (facts.projects.length === 0) steps.push("repositories");
  if (!facts.workerSkillsSettled) steps.push("worker-skills");
  if (!facts.selfImprovementChosen) steps.push("self-improvement");
  return steps;
}

const STEP_TEXT: Readonly<Record<OnboardingStep, string>> = {
  models: "choose models (models, then configure-models)",
  "code-folders": "ask where they keep code (save-code-folders)",
  repositories: "set up at least one repository",
  "worker-skills": "offer their plugin skills to every task (worker-skills)",
  "self-improvement": "ask whether Tandem may look into its own problems (self-improvement)",
};

/** The line the Tandem coordinator reads each turn about where setup stands. */
export function onboardingStatus(facts: OnboardingFacts): string {
  const remaining = remainingOnboardingSteps(facts);
  const projects = facts.projects.length === 0 ? "none yet" : `${facts.projects.length} set up`;
  if (remaining.length === 0) {
    return `Onboarding is done (repositories: ${projects}). Offer to set up more repositories only when the user asks.`;
  }
  const steps = remaining.map((step, index) => `${index + 1}. ${STEP_TEXT[step]}`).join("\n");
  return `Onboarding is not finished (repositories: ${projects}). Still to do, in this order:\n${steps}\nWhen the user starts onboarding or comes back to it, continue from the first step. Do not repeat finished steps.`;
}
