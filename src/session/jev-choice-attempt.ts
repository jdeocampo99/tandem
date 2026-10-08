import {
  choiceConfidence,
  evaluateJev,
  JEV_MODEL,
  type JevAttemptOutcome,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
  type JevFetch,
  type JevGateway,
  type JevQuestions,
  jevUsageRecord,
} from "../adapters/typesafe.ts";
import type { UsageRecord } from "../runtime/usage.ts";

export type JevChoiceConfig = Readonly<{
  apiKey?: string;
  gateway?: JevGateway;
  timeoutMs: number;
  fetch?: JevFetch;
}>;

export type JevChoiceEvaluator = (
  input: JevEvaluationInput,
  options: JevEvaluationOptions,
) => Promise<JevEvaluationResponse>;

type ChoiceReading =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "uncertain" }>
  | Readonly<{ kind: "confident"; choice: string }>;

type AttemptReceipt = Readonly<{ durationMs: number; usage?: UsageRecord }>;

/** One route's call and receipt, including time spent in its local screening and decisions. */
export class JevChoiceAttempt {
  private readonly startedAt: number;
  private outcome?: JevAttemptOutcome;
  private answers: Partial<JevEvaluationResponse["answers"]> = {};

  constructor(
    private readonly config: JevChoiceConfig,
    private readonly evaluator: JevChoiceEvaluator = evaluateJev,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = this.now();
  }

  async run(message: string, createQuestions: () => JevQuestions): Promise<string | undefined> {
    if (this.config.apiKey === undefined) return "jev-not-configured";
    let response: JevEvaluationResponse;
    try {
      response = await this.evaluator(
        { model: JEV_MODEL, state: { message }, questions: createQuestions() },
        {
          apiKey: this.config.apiKey,
          timeoutMs: this.config.timeoutMs,
          ...(this.config.fetch === undefined ? {} : { fetch: this.config.fetch }),
          ...(this.config.gateway === undefined ? {} : { gateway: this.config.gateway }),
        },
      );
    } catch (error) {
      const code = error instanceof JevEvaluationError ? error.code : "unavailable";
      this.outcome = { kind: "failed", code };
      return `jev-${code}`;
    }
    this.outcome = { kind: "answered", usage: response.usage };
    this.answers = response.answers;
    return undefined;
  }

  read(questionId: string, threshold: number): ChoiceReading {
    const answer = this.answers[questionId];
    if (answer === undefined || answer.type !== "choice") return { kind: "missing" };
    const confidence = choiceConfidence(answer);
    return confidence !== undefined && confidence >= threshold
      ? { kind: "confident", choice: answer.choice }
      : { kind: "uncertain" };
  }

  finish(reason: string): Readonly<{ reason: string }> & AttemptReceipt;
  finish<Match extends object>(
    reason: string,
    match: Match,
  ): Readonly<{ reason: string }> & AttemptReceipt & Match;
  finish(reason: string, match: object = {}): Readonly<{ reason: string }> & AttemptReceipt {
    const durationMs = Math.max(0, Math.round(this.now() - this.startedAt));
    return {
      reason,
      durationMs,
      ...match,
      ...(this.outcome === undefined
        ? {}
        : {
            usage: jevUsageRecord({ outcome: this.outcome, durationMs, reason }),
          }),
    };
  }
}
