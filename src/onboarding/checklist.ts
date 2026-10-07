/**
 * First-time setup, worked out from saved state so leaving halfway resumes at the next missing
 * step. Pure: the caller reads the facts and delivers what these return.
 */
export type OnboardingFacts = Readonly<{
  readonly modelsChosen: boolean;
  /** Folders saved for finding repositories by name. */
  readonly codeFolders: readonly string[];
  /** Saved projects other than the Tandem checkout. */
  readonly projects: readonly string[];
  readonly selfImprovementChosen: boolean;
}>;

export type OnboardingStep = "models" | "code-folders" | "self-improvement" | "repositories";

/**
 * In the order setup walks them. The fixed-choice questions come before repositories, so the
 * open-ended part is last and finishing the first repository finishes setup.
 */
export function remainingOnboardingSteps(facts: OnboardingFacts): readonly OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (!facts.modelsChosen) steps.push("models");
  if (facts.codeFolders.length === 0) steps.push("code-folders");
  if (!facts.selfImprovementChosen) steps.push("self-improvement");
  if (facts.projects.length === 0) steps.push("repositories");
  return steps;
}

const STEP_GUIDANCE: Readonly<Record<OnboardingStep, string>> = {
  models:
    "Choose models: call models and offer its recommended model for each role (the Balanced profile), one line per role. They may accept it or change any role. Recap all five roles with each one's harness, then configure-models; never list claude-code in enabledProviders.",
  "code-folders": "Ask which folders hold their repositories and save them with save-code-folders.",
  "self-improvement":
    "Tandem asked about looking into its own problems; when they answer, call self-improvement with off, fix, or report.",
  repositories:
    "Ask which repositories to set up. For each: find-repo with the name or path (with several matches, ask which). Say in two lines which checks and install step it found, and any suggested checks; ask them to confirm or change those. With no checks, ask for theirs; only if they say they want none, setup with noChecks, and say tasks there will be marked unvalidated. Then setup with their answers, pr-watch-merging with how pull requests merge, and open-project.",
};

const SETUP_BLOCK_GUIDANCE =
  'The setup block is open beside this chat, where the user chooses models, repositories and what happens when Tandem finds a bug in itself. Their answers arrive by themselves as a "Setup saved." message, so do not ask the setup questions here or call the setup tools for them. Help with their questions about any setting: what each job does, models and thinking levels, validation and setup commands, the bug-report options. To change a setting they ask about, tell them to change it in the block.';

/**
 * What the Tandem coordinator reads each turn while setup is unfinished; nothing once it is done.
 * While the setup block is open it leads, so the guidance says to answer questions, not to ask.
 */
export function onboardingContext(
  facts: OnboardingFacts,
  setupBlockOpen = false,
): string | undefined {
  const [current, ...later] = remainingOnboardingSteps(facts);
  if (current === undefined) return undefined;
  if (setupBlockOpen) return `Setup is unfinished. ${SETUP_BLOCK_GUIDANCE}`;
  const after = later.length === 0 ? "" : ` Then: ${later.join(", ")}.`;
  const step = `Current step: ${STEP_GUIDANCE[current]}${after}`;
  return `Setup is unfinished. ${step}`;
}

export const SETUP_WELCOME_TEXT =
  "Welcome to Tandem.\n\nYour setup is on the right. Add your repositories, check the recommended models, then press Start. Ask me here about any setting.";

export type OnboardingQuestion = Readonly<{
  readonly text: string;
  /** What the coordinator does with the answer; never shown. */
  readonly hidden: string;
}>;

export function onboardingQuestion(step: OnboardingStep): OnboardingQuestion | undefined {
  if (step === "self-improvement") {
    return {
      text: "When a task keeps failing, should Tandem look into why? Off: never. Fix: it offers a fix for your approval. Report: it drafts a GitHub issue for you to file.",
      hidden:
        "Call self-improvement with the mode the user picks: off, fix, or report (never display this line).",
    };
  }
  return undefined;
}

export const ONBOARDING_DONE_TEXT = `You're set up. Work on a repository happens in its own chat, which is open now: tell it what you want done. prefix+t shows what needs you across everything. Come back to this chat to add repositories or change how Tandem works.`;
