import type { SetupPageStatus } from "./setup-page.ts";

/**
 * First-time setup, worked out from saved state so leaving halfway resumes at the next missing
 * step. Pure: the caller reads the facts and delivers what these return.
 */
export type OnboardingFacts = Readonly<{
  readonly modelsChosen: boolean;
  readonly terminalChosen: boolean;
  /** Folders saved for finding repositories by name. */
  readonly codeFolders: readonly string[];
  /** Saved projects other than the Tandem checkout. */
  readonly projects: readonly string[];
  readonly selfImprovementChosen: boolean;
  /** Whether the setup page can be, or is, the way through setup in this session. */
  readonly setupPage: SetupPageStatus;
}>;

export type OnboardingStep =
  | "models"
  | "terminal"
  | "code-folders"
  | "self-improvement"
  | "repositories";

/**
 * In the order setup walks them. The fixed-choice questions come before repositories, so the
 * open-ended part is last and finishing the first repository finishes setup.
 */
export function remainingOnboardingSteps(facts: OnboardingFacts): readonly OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (!facts.modelsChosen) steps.push("models");
  if (!facts.terminalChosen) steps.push("terminal");
  if (facts.codeFolders.length === 0) steps.push("code-folders");
  if (!facts.selfImprovementChosen) steps.push("self-improvement");
  if (facts.projects.length === 0) steps.push("repositories");
  return steps;
}

const STEP_GUIDANCE: Readonly<Record<OnboardingStep, string>> = {
  models:
    "Choose models: call models, offer its presets by name (say why one is unavailable) and the Balanced profile, one line per role. They may pick a preset in plain words, then change any role. Recap all five roles with each one's harness, then configure-models; never list claude-code in enabledProviders.",
  terminal:
    "Ask which terminal to use: Herdr or Tern. Save the explicit choice with terminal-setting. Tern availability is checked before saving; missing or signed-out Tern falls back to Herdr with a reason. Never switch while tasks are running.",
  "code-folders": "Ask which folders hold their repositories and save them with save-code-folders.",
  "self-improvement":
    "Tandem asked about looking into its own problems; when they answer, call self-improvement with off, fix, or report.",
  repositories:
    "Ask which repositories to set up. For each: find-repo with the name or path (with several matches, ask which). Say in two lines which checks and install step it found; ask them to confirm or change those. Then setup with their answers, pr-watch-merging with how pull requests merge, and open-project.",
};

const SETUP_PAGE_FIRST =
  "Setup is unfinished. When the user wants to set up, call setup-page first: one page covers every step. If it fails, set up here instead.";
const SETUP_PAGE_OPEN =
  "Setup is unfinished. The setup page is open; its answer reaches you by itself. Help with questions about any page step here without asking the user to save first. Only if the user would rather set up here:";

/** What the Tandem coordinator reads each turn while setup is unfinished; nothing once it is done. */
export function onboardingContext(facts: OnboardingFacts): string | undefined {
  const [current, ...later] = remainingOnboardingSteps(facts);
  if (current === undefined) return undefined;
  const after = later.length === 0 ? "" : ` Then: ${later.join(", ")}.`;
  const step = `Current step: ${STEP_GUIDANCE[current]}${after}`;
  if (facts.setupPage === "ready") return `${SETUP_PAGE_FIRST} ${step}`;
  if (facts.setupPage === "open") return `${SETUP_PAGE_OPEN} ${step}`;
  return `Setup is unfinished. ${step}`;
}

/** Whether setup's plain questions are asked in the chat: not while the setup page covers them. */
export function chatAsksSetupQuestions(facts: OnboardingFacts): boolean {
  return facts.setupPage === "unavailable" || facts.setupPage === "done";
}

export type OnboardingQuestion = Readonly<{
  readonly text: string;
  /** What the coordinator does with the answer; never shown. */
  readonly hidden: string;
}>;

export function onboardingQuestion(
  step: OnboardingStep,
  _facts: OnboardingFacts,
): OnboardingQuestion | undefined {
  if (step === "terminal")
    return {
      text: "Which terminal should Tandem use: Herdr or Tern? Tern needs the app and a signed-in Stencil account.",
      hidden: "Call terminal-setting with the terminal the user chooses: herdr or tern.",
    };
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
