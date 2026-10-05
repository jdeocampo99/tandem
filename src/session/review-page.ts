import type { ReviewSubmission } from "../pr-review/page.ts";
import type { TandemService } from "../service/controller.ts";
import { type CoordinatorAgentEnd, CoordinatorReplyWait } from "./coordinator-reply.ts";
import type { SessionHost } from "./events.ts";

/** Waits that return with nothing to act on, in a row, before a listener gives up. */
const MAX_IDLE_WAITS = 3;

type ReviewPageService = Pick<
  TandemService,
  "reviewPagesOpen" | "awaitReviewPage" | "reviewSubmit"
>;

/**
 * Listens to each PR review page this coordinator opened, one listener per page, from code rather
 * than the model. A Submit from the page posts the review directly, because the click is the
 * user's approval; the result goes to the chat as an aside and back into the page. Anything else
 * typed in the page goes to the coordinator, and its answer is shown in the page.
 */
export class ReviewPageListeners {
  private readonly listeners = new Map<string, AbortController>();
  private readonly replies = new CoordinatorReplyWait();

  constructor(
    private readonly deps: Readonly<{
      host: Pick<SessionHost, "perform">;
      service: () => ReviewPageService;
      logError?: (message: string, error: unknown) => void;
    }>,
  ) {}

  /** After an action: starts a listener for each open review page that has none. */
  afterAction(): void {
    for (const taskId of this.deps.service().reviewPagesOpen()) this.listen(taskId);
  }

  /** Stops every listener and any coordinator reply wait. */
  stop(): void {
    for (const controller of this.listeners.values()) controller.abort();
    this.listeners.clear();
    this.replies.cancel();
  }

  agentEnd(end: CoordinatorAgentEnd): void {
    this.replies.agentEnd(end);
  }

  private listen(taskId: string): void {
    if (this.listeners.has(taskId)) return;
    const controller = new AbortController();
    this.listeners.set(taskId, controller);
    void this.listenUntilClosed(taskId, controller.signal)
      .catch((error: unknown) => this.deps.logError?.("Tandem review page listener failed", error))
      .finally(() => {
        if (this.listeners.get(taskId) === controller) this.listeners.delete(taskId);
      });
  }

  private async listenUntilClosed(taskId: string, signal: AbortSignal): Promise<void> {
    let reply: string | undefined;
    let idle = 0;
    while (!signal.aborted) {
      const event = await this.deps.service().awaitReviewPage(taskId, signal, reply);
      reply = undefined;
      if (event.kind === "stopped" || event.kind === "closed") return;
      if (event.kind === "failed") {
        await this.say(`The review page stopped: ${event.message}`);
        return;
      }
      if (event.kind === "submission") {
        idle = 0;
        reply = await this.submit(taskId, event.submission);
      } else if (event.kind === "invalid") {
        idle = 0;
        const problems = event.problems.map((problem) => `- ${problem}`).join("\n");
        reply = `Tandem could not read that submission, so nothing was posted:\n${problems}`;
        await this.say(reply);
      } else if (event.kind === "comment") {
        idle = 0;
        const prompt = `From the open review page:\n${event.text}`;
        if (event.ended) {
          await this.deps.host.perform({ type: "promptAsUser", text: prompt, deliverAs: "aside" });
          return;
        }
        const awaiting = this.replies.wait(prompt, signal);
        await this.deps.host.perform({ type: "promptAsUser", text: prompt, deliverAs: "aside" });
        const answer = await awaiting;
        if (answer === undefined) return;
        reply = answer;
      } else {
        idle += 1;
        if (idle >= MAX_IDLE_WAITS) return;
      }
      if (event.ended) return;
    }
  }

  /** Posts the submission and tells the chat what happened; returns the reply for the page. */
  private async submit(taskId: string, submission: ReviewSubmission): Promise<string> {
    let text: string;
    try {
      const result = await this.deps.service().reviewSubmit(taskId, submission);
      text = result.posted
        ? `Posted your review: ${result.url ?? result.message}`
        : `Your review was not posted. ${result.message}`;
    } catch (error) {
      text = `Your review was not posted. ${error instanceof Error ? error.message : String(error)}`;
    }
    await this.say(text);
    return text;
  }

  private async say(text: string): Promise<void> {
    await this.deps.host.perform({
      type: "deliver",
      source: "notification",
      text,
      timing: "aside",
      triggerTurn: false,
    });
  }
}
