import {
  chatAsksSetupQuestions,
  ONBOARDING_DONE_TEXT,
  type OnboardingFacts,
  type OnboardingStep,
  onboardingContext,
  onboardingQuestion,
  remainingOnboardingSteps,
} from "../onboarding/checklist.ts";
import {
  SETUP_ANSWER_NEXT,
  SETUP_ANSWER_PROBLEM,
  SETUP_ANSWER_RECEIVED,
  SETUP_PAGE_CLOSED,
  SETUP_PAGE_REPLY_OTHER,
  SETUP_PAGE_REPLY_RECEIVED,
} from "../onboarding/setup-answer.ts";
import { toolReport } from "../onboarding/tools.ts";
import type { TandemService } from "../service/controller.ts";
import type { SessionHost } from "./events.ts";

type GuideService = Pick<TandemService, "onboardingFacts" | "checkTools" | "awaitSetupAnswer">;

/** Waits that return with nothing to act on, in a row, before the listener gives up. */
const MAX_IDLE_WAITS = 3;

/**
 * Drives first-time setup in the Tandem coordinator with fixed wording wherever the step allows:
 * the tool report at session start, the plain-choice questions when their step comes up, and the
 * closing message when the last step is saved. The model leads only the open-ended steps, from
 * the current step's guidance in its context. While the setup page is open, code listens for its
 * answer and hands the model one fixed message naming the one action that saves it.
 */
export class OnboardingGuide {
  /** Questions already put to the user in this conversation. */
  private readonly asked = new Set<OnboardingStep>();
  /** Whether setup was unfinished when last read; unset until the first read. */
  private unfinished: boolean | undefined;
  /** The setup page listener, while one runs. */
  private listener: AbortController | undefined;

  constructor(
    private readonly deps: Readonly<{
      host: Pick<SessionHost, "perform">;
      service: () => GuideService;
      repo: string;
      logError?: (message: string, error: unknown) => void;
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

  /**
   * After an action: starts listening once the setup page is open, asks the next plain-choice
   * question, or closes setup once nothing is left.
   */
  async afterAction(): Promise<void> {
    const wasUnfinished = this.unfinished;
    if (wasUnfinished === false) return;
    const facts = await this.track();
    if (facts.setupPage === "open") this.listen();
    if (this.unfinished) {
      await this.askCurrent(facts);
    } else if (wasUnfinished === true) {
      await this.say(ONBOARDING_DONE_TEXT);
    }
  }

  /** The current step's guidance for the model, or nothing once setup is done. */
  async context(): Promise<readonly string[]> {
    const text = onboardingContext(await this.read());
    return text === undefined ? [] : [text];
  }

  /** Stops the setup page listener, if one runs. */
  stop(): void {
    this.listener?.abort();
    this.listener = undefined;
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
    if (!chatAsksSetupQuestions(facts)) return;
    const [current] = remainingOnboardingSteps(facts);
    if (current === undefined || this.asked.has(current)) return;
    const question = onboardingQuestion(current, facts);
    if (question === undefined) return;
    this.asked.add(current);
    await this.say(question.text, question.hidden);
  }

  private listen(): void {
    if (this.listener !== undefined) return;
    const controller = new AbortController();
    this.listener = controller;
    void this.listenUntilClosed(controller.signal)
      .catch((error: unknown) => this.deps.logError?.("Tandem setup page listener failed", error))
      .finally(() => {
        if (this.listener === controller) this.listener = undefined;
      });
  }

  /**
   * One wait at a time on the open page. A valid answer reaches the chat as fixed text with a
   * hidden line naming `apply-setup`, and triggers the model's turn; an invalid one is reported in
   * the chat and the browser, and the page stays open for another try.
   */
  private async listenUntilClosed(signal: AbortSignal): Promise<void> {
    let reply: string | undefined;
    let answered = false;
    let idle = 0;
    while (!signal.aborted) {
      const event = await this.deps.service().awaitSetupAnswer(this.deps.repo, signal, reply);
      reply = undefined;
      if (event.kind === "stopped") return;
      if (event.kind === "failed") {
        await this.say(`The setup page stopped: ${event.message} Keep setting up here.`);
        return;
      }
      if (event.kind === "closed") {
        if (!answered) await this.say(SETUP_PAGE_CLOSED);
        return;
      }
      if (event.kind === "answer") {
        answered = true;
        idle = 0;
        await this.deps.host.perform({
          type: "deliver",
          source: "notification",
          text: [SETUP_ANSWER_RECEIVED, ...event.recap, SETUP_ANSWER_NEXT].join("\n"),
          hidden: {
            text: `Call apply-setup with repoPath ${JSON.stringify(this.deps.repo)} and answerId ${JSON.stringify(event.answerId)} now; its approval shows the user everything (never display this line).`,
          },
          timing: "followUp",
          triggerTurn: true,
        });
        reply = SETUP_PAGE_REPLY_RECEIVED;
      } else if (event.kind === "invalid") {
        idle = 0;
        const problems = event.problems.map((problem) => `- ${problem}`).join("\n");
        await this.say(`${SETUP_ANSWER_PROBLEM}\n${problems}`);
        reply = `${SETUP_ANSWER_PROBLEM}\n\n${problems}`;
      } else if (event.comment) {
        reply = SETUP_PAGE_REPLY_OTHER;
      } else {
        idle += 1;
        if (idle >= MAX_IDLE_WAITS) return;
      }
      if (event.ended) {
        if (!answered) await this.say(SETUP_PAGE_CLOSED);
        return;
      }
    }
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
