import {
  ONBOARDING_DONE_TEXT,
  type OnboardingFacts,
  type OnboardingStep,
  onboardingContext,
  onboardingQuestion,
  remainingOnboardingSteps,
} from "../onboarding/checklist.ts";
import { toolReport } from "../onboarding/tools.ts";
import type { TandemService } from "../service/controller.ts";
import type { SessionHost } from "./events.ts";

type GuideService = Pick<TandemService, "onboardingFacts" | "checkTools">;

/**
 * Drives first-time setup in the Tandem coordinator with fixed wording wherever the step allows:
 * the tool report at session start, the plain-choice questions when their step comes up, and the
 * closing message when the last step is saved. The model leads only the open-ended steps, from the
 * current step's guidance in its context.
 */
export class OnboardingGuide {
  /** Questions already put to the user in this conversation. */
  private readonly asked = new Set<OnboardingStep>();
  /** Whether setup was unfinished when last read; unset until the first read. */
  private unfinished: boolean | undefined;

  constructor(
    private readonly deps: Readonly<{
      host: Pick<SessionHost, "perform">;
      service: () => GuideService;
      repo: string;
    }>,
  ) {}

  /** Reports missing tools once per launch while setup is unfinished, then asks what is due. */
  async sessionStart(): Promise<void> {
    const facts = await this.track();
    if (!this.unfinished) return;
    const report = toolReport(await this.deps.service().checkTools());
    if (report !== undefined) await this.say(report);
    await this.askCurrent(facts);
  }

  /** After an action: asks the next plain-choice question, or closes setup once nothing is left. */
  async afterAction(): Promise<void> {
    const wasUnfinished = this.unfinished;
    if (wasUnfinished === false) return;
    const facts = await this.track();
    if (this.unfinished) {
      await this.askCurrent(facts);
    } else if (wasUnfinished === true) {
      await this.say(ONBOARDING_DONE_TEXT);
    }
  }

  private read(): Promise<OnboardingFacts> {
    return this.deps.service().onboardingFacts(this.deps.repo);
  }

  /** Reads the facts and remembers whether setup was unfinished, to notice it finishing. */
  private async track(): Promise<OnboardingFacts> {
    const facts = await this.read();
    this.unfinished = remainingOnboardingSteps(facts).length > 0;
    return facts;
  }

  private async askCurrent(facts: OnboardingFacts): Promise<void> {
    const [current] = remainingOnboardingSteps(facts);
    if (current === undefined || this.asked.has(current)) return;
    const question = onboardingQuestion(current);
    if (question === undefined) return;
    this.asked.add(current);
    await this.say(question.text, question.hidden);
  }

  /** Setup guidance is read fresh for each model turn, never inferred from an earlier step. */
  async context(): Promise<readonly string[]> {
    const text = onboardingContext(await this.read());
    return text === undefined ? [] : [text];
  }

  private async say(text: string, hidden?: string): Promise<void> {
    await this.deps.host.perform({
      type: "deliver",
      source: "notification",
      text,
      ...(hidden === undefined ? {} : { hidden: { text: hidden } }),
      timing: "nextTurn",
      triggerTurn: false,
    });
  }
}
