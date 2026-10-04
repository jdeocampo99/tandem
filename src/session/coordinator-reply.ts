export type CoordinatorMessage = Readonly<{
  role: string;
  content: string | readonly Readonly<{ type: string; text?: string }>[];
  synthetic?: boolean;
  superseded?: boolean;
}>;

export type CoordinatorAgentEnd = Readonly<{
  messages: () => readonly CoordinatorMessage[];
  willContinue: boolean;
}>;

const COORDINATOR_REPLY_UNAVAILABLE =
  "The coordinator did not return a final answer. Ask again here.";

type Pending = Readonly<{
  prompt: string;
  resolve: (reply: string | undefined) => void;
  cleanup: () => void;
}>;

function messageText(message: CoordinatorMessage): string | undefined {
  const text =
    typeof message.content === "string"
      ? message.content.trim()
      : message.content
          .filter((block) => block.type === "text" && block.text !== undefined)
          .map((block) => block.text ?? "")
          .join("\n")
          .trim();
  return text.length === 0 ? undefined : text;
}

/** The coordinator's last answer after the user prompt `prompt`, if that prompt is in the run. */
function coordinatorAnswer(
  messages: readonly CoordinatorMessage[],
  prompt: string,
): Readonly<{ matched: boolean; text?: string }> {
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && !message.synthetic && messageText(message) === prompt) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return { matched: false };

  let answer: string | undefined;
  for (let index = promptIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "user" && !message.synthetic) break;
    if (message?.role === "assistant" && !message.superseded) {
      const text = messageText(message);
      if (text !== undefined) answer = text;
    }
  }
  return answer === undefined ? { matched: true } : { matched: true, text: answer };
}

/**
 * Waits for the coordinator's final answer to one prompt a page sent on the user's behalf, so the
 * answer can be shown back in that page. One wait at a time.
 */
export class CoordinatorReplyWait {
  private pending: Pending | undefined;

  /** Resolves with the answer, or `undefined` when `signal` aborts or the wait is cancelled. */
  wait(prompt: string, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    let pending: Pending;
    const onAbort = () => {
      if (this.pending === pending) this.pending = undefined;
      pending.cleanup();
      resolve(undefined);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    pending = { prompt, resolve, cleanup };
    this.pending = pending;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    return promise;
  }

  /** Delivers one completed coordinator run to the waiting prompt, if it answered that prompt. */
  agentEnd(end: CoordinatorAgentEnd): void {
    const pending = this.pending;
    if (end.willContinue || pending === undefined) return;
    const answer = coordinatorAnswer(end.messages(), pending.prompt);
    if (!answer.matched) return;
    this.pending = undefined;
    pending.cleanup();
    pending.resolve(answer.text ?? COORDINATOR_REPLY_UNAVAILABLE);
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup();
    pending?.resolve(undefined);
  }
}
