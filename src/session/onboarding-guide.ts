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
  SETUP_ANSWER_FAILED,
  SETUP_ANSWER_PARTIAL,
  SETUP_ANSWER_PROBLEM,
  SETUP_ANSWER_SAVED,
  SETUP_PAGE_CLOSED,
} from "../onboarding/setup-answer.ts";
import type { SetupApplyResult } from "../onboarding/setup-page.ts";
import { toolReport } from "../onboarding/tools.ts";
import type { TandemService } from "../service/controller.ts";
import { type CoordinatorAgentEnd, CoordinatorReplyWait } from "./coordinator-reply.ts";
import type { SessionHost } from "./events.ts";

/** Waits that return with nothing to act on, in a row, before the listener gives up. */
const MAX_IDLE_WAITS = 3;

type GuideService = Pick<
  TandemService,
  "onboardingFacts" | "checkTools" | "awaitSetupAnswer" | "applySetup"
>;

/**
 * Drives first-time setup in the Tandem coordinator with fixed wording wherever the step allows:
 * the tool report at session start, the plain-choice questions when their step comes up, and the
 * closing message when the last step is saved. The model leads only the open-ended steps, from the
 * current step's guidance in its context. While the setup page is open, code relays its answers and
 * routes each comment through the coordinator before showing the final answer back in Lavish.
 */
export class OnboardingGuide {
  /** Questions already put to the user in this conversation. */
  private readonly asked = new Set<OnboardingStep>();
  /** Whether setup was unfinished when last read; unset until the first read. */
  private unfinished: boolean | undefined;
  /** The setup page listener, while one runs. */
  private listener: AbortController | undefined;
  /** The Lavish question currently awaiting the coordinator's final turn. */
  private readonly replies = new CoordinatorReplyWait();

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

  /** Stops the setup page listener and any coordinator reply wait. */
  stop(): void {
    this.listener?.abort();
    this.listener = undefined;
    this.replies.cancel();
  }

  /** Delivers one completed coordinator turn to the comment that started it, if it matches. */
  agentEnd(end: CoordinatorAgentEnd): void {
    this.replies.agentEnd(end);
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

  /** Setup guidance is read fresh for each model turn, never inferred from an earlier step. */
  async context(): Promise<readonly string[]> {
    const text = onboardingContext(await this.read());
    return text === undefined ? [] : [text];
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
   * One wait at a time on the open page. A valid Save applies directly and reports the actual
   * result without a coordinator turn; a question gets a coordinator turn and its final answer
   * is shown in the page; a read-only folder search replies in Lavish without a model turn.
   */
  private async listenUntilClosed(signal: AbortSignal): Promise<void> {
    let reply: string | undefined;
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
        await this.say(SETUP_PAGE_CLOSED);
        return;
      }
      if (event.kind === "answer") {
        let result: SetupApplyResult;
        try {
          result = await this.deps.service().applySetup(this.deps.repo, event.answerId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failure = `${SETUP_ANSWER_FAILED}\n${message}`;
          await this.say(failure, undefined, "aside");
          reply = failure;
          continue;
        }
        const heading = result.complete ? SETUP_ANSWER_SAVED : SETUP_ANSWER_PARTIAL;
        await this.say(`${heading}\n${result.message}`, undefined, "aside");
        await this.track();
        if (result.complete && !this.unfinished)
          await this.say(ONBOARDING_DONE_TEXT, undefined, "aside");
        return;
      } else if (event.kind === "invalid") {
        idle = 0;
        const problems = event.problems.map((problem) => `- ${problem}`).join("\n");
        await this.say(`${SETUP_ANSWER_PROBLEM}\n${problems}`);
        reply = `${SETUP_ANSWER_PROBLEM}\n\n${problems}`;
      } else if (event.kind === "search") {
        idle = 0;
        reply = event.reply;
      } else if (event.kind === "comment") {
        idle = 0;
        const prompt = `From the open Lavish setup page:\n${event.text}`;
        if (event.ended) {
          await this.deps.host.perform({ type: "promptAsUser", text: prompt, deliverAs: "aside" });
          await this.say(SETUP_PAGE_CLOSED);
          return;
        }
        const awaiting = this.replies.wait(prompt, signal);
        try {
          await this.deps.host.perform({ type: "promptAsUser", text: prompt, deliverAs: "aside" });
        } catch (error) {
          this.stop();
          throw error;
        }
        const answer = await awaiting;
        if (answer === undefined) return;
        reply = answer;
      } else {
        idle += 1;
        if (idle >= MAX_IDLE_WAITS) return;
      }
      if (event.ended) {
        await this.say(SETUP_PAGE_CLOSED);
        return;
      }
    }
  }

  private async say(
    text: string,
    hidden?: string,
    timing: "followUp" | "nextTurn" | "aside" = "nextTurn",
  ): Promise<void> {
    await this.deps.host.perform({
      type: "deliver",
      source: "notification",
      text,
      ...(hidden === undefined ? {} : { hidden: { text: hidden } }),
      timing,
      triggerTurn: false,
    });
  }
}
