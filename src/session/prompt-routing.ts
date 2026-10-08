import {
  evaluateJev,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
  type JevFetch,
  type JevGateway,
  jevGateway,
} from "../adapters/typesafe.ts";
import { findPullRequestRef } from "../pr-review/pull-request.ts";
import type { DiagnosticEvent } from "../runtime/diagnostics.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import type { TandemService } from "../service/controller.ts";
import type { ApprovalDialog, TandemAction } from "./actions.ts";
import { MAX_CHOICE_REPLY_CHARS, type OpenChoice } from "./choice-reply-route.ts";
import type { SessionEvent, SessionHost } from "./events.ts";
import { mentionsInvestigation } from "./investigate-route.ts";
import { evaluationResult, lookupDecision, lookupInput } from "./prompt-lookup.ts";
import {
  dispatchRoutedAction,
  promptHash,
  recordDiagnostic,
  recordFallback,
  routeConfirmation,
} from "./prompt-replies.ts";
import { routeChoiceReply, routeInvestigate, routePrReview, routePullUp } from "./prompt-routes.ts";
import { mentionsPullUp } from "./pull-up-route.ts";

export const DEFAULT_PROMPT_ROUTING_TIMEOUT_MS = 1_500;
export const PROMPT_ROUTING_CONFIDENCE_THRESHOLD = 0.8;
const MAX_ROUTABLE_PROMPT_CHARS = 16_000;
const TASK_ID_PATTERN =
  /\b(?:task-[A-Za-z0-9][A-Za-z0-9._-]{0,127}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/giu;

type ReadOnlyAction =
  | "list"
  | "presentations"
  | "show"
  | "messages"
  | "inspect"
  | "receipt"
  | "board"
  | "pr-watch";
type RouteTarget = "repository" | "task" | "conversation" | "unresolved";
type RouteEffect = "read-only" | "state-change" | "sensitive" | "unknown";
type RouteScope = "within" | "changes" | "unclear";
type RouteComposition = "single" | "homogeneous-batch" | "mixed";

export type PromptRoutingConfig = Readonly<{
  readonly apiKey?: string;
  readonly gateway?: JevGateway;
  readonly timeoutMs: number;
  readonly fetch?: JevFetch;
}>;

/** A monotonic duration clock, injected so evaluation tooling can produce deterministic durations. */
export type PromptRoutingClock = () => number;

export type PromptRoutingDecision = Readonly<{
  readonly action: ReadOnlyAction;
  readonly target: RouteTarget;
  readonly effect: RouteEffect;
  readonly scope: RouteScope;
  readonly composition: RouteComposition;
  readonly taskId?: string;
  readonly confidence: number;
}>;

export type PromptRoutingEvaluation = Readonly<{
  readonly classifier: "jev" | "disabled";
  readonly reason: string;
  readonly durationMs: number;
  readonly decision?: PromptRoutingDecision;
  /** Bounded Jev usage for this evaluation; present only when a provider request was attempted. */
  readonly usage?: UsageRecord;
}>;

export type UserPrompt = Extract<SessionEvent, { type: "userPrompt" }>;

export type PromptRoutingDependencies = Readonly<{
  readonly config: PromptRoutingConfig;
  /** Read only when a route needs Tandem state. */
  readonly service: () => TandemService;
  /** The project a routed PR review runs under; without it, PR links go to the coordinator. */
  readonly repoPath?: () => string;
  /** Delivers routed replies. */
  readonly host: Pick<SessionHost, "perform">;
  readonly confirm: ApprovalDialog | undefined;
  /** Best effort: a failed write never changes how the prompt is handled. */
  readonly diagnostics: (event: DiagnosticEvent) => Promise<void>;
  readonly evaluate?: (
    input: JevEvaluationInput,
    options: JevEvaluationOptions,
  ) => Promise<JevEvaluationResponse>;
  readonly now?: PromptRoutingClock;
  /**
   * Holds a risky choice waiting for an exact "y" across prompts. Without it, risky replies go to
   * the coordinator, since nothing could ask for the confirmation.
   */
  readonly confirmation?: ChoiceConfirmation;
}>;

/** The one risky choice code asked the person to confirm, until their next message. */
export type ChoiceConfirmation = { pending?: OpenChoice | undefined };

/** Bumped whenever the lookup questions in prompt-lookup.ts change shape or meaning. */
export const PROMPT_ROUTING_QUESTION_SCHEMA_VERSION = 5;

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim();
}

function parseTimeout(source: string | undefined): number {
  if (source === undefined) return DEFAULT_PROMPT_ROUTING_TIMEOUT_MS;
  const value = Number(source);
  return Number.isSafeInteger(value) && value >= 100 && value <= 10_000
    ? value
    : DEFAULT_PROMPT_ROUTING_TIMEOUT_MS;
}

export function promptRoutingConfig(
  source: Readonly<Record<string, string | undefined>>,
): PromptRoutingConfig {
  const apiKey = source.TYPESAFE_API_KEY?.trim();
  const gateway = jevGateway(source);
  return {
    timeoutMs: parseTimeout(source.TANDEM_JEV_TIMEOUT_MS),
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    ...(gateway === undefined ? {} : { gateway }),
  };
}

export function extractPromptTaskId(prompt: string): string | undefined {
  return prompt.match(TASK_ID_PATTERN)?.[0];
}

export async function classifyPrompt(
  prompt: string,
  config: PromptRoutingConfig,
  evaluate: PromptRoutingDependencies["evaluate"] = evaluateJev,
  now: PromptRoutingClock = () => performance.now(),
): Promise<PromptRoutingEvaluation> {
  const startedAt = now();
  const normalized = normalizePrompt(prompt);
  if (normalized.length === 0)
    return evaluationResult({ classifier: "disabled", reason: "empty-prompt" }, startedAt, now);
  if (normalized.length > MAX_ROUTABLE_PROMPT_CHARS)
    return evaluationResult({ classifier: "disabled", reason: "prompt-too-long" }, startedAt, now);
  if (config.apiKey === undefined)
    return evaluationResult(
      { classifier: "disabled", reason: "jev-not-configured" },
      startedAt,
      now,
    );
  const taskId = extractPromptTaskId(normalized);
  const input = lookupInput(normalized, taskId);
  const options: JevEvaluationOptions = {
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    ...(config.gateway === undefined ? {} : { gateway: config.gateway }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  };
  let response: JevEvaluationResponse;
  try {
    response = await evaluate(input, options);
  } catch (error) {
    const code = error instanceof JevEvaluationError ? error.code : "unavailable";
    const reason = error instanceof JevEvaluationError ? `jev-${error.code}` : "jev-error";
    return evaluationResult(
      { classifier: "jev", reason, outcome: { kind: "failed", code } },
      startedAt,
      now,
    );
  }
  const result = {
    classifier: "jev" as const,
    outcome: { kind: "answered" as const, usage: response.usage },
    ...lookupDecision(response, taskId, PROMPT_ROUTING_CONFIDENCE_THRESHOLD),
  };
  return evaluationResult(result, startedAt, now);
}

export function actionForPromptDecision(
  decision: PromptRoutingDecision,
): Extract<TandemAction, { readonly action: ReadOnlyAction | "request-receipt" }> | undefined {
  // The PR watch view reads GitHub first, so the answer is current; the board only reads saved state.
  if (
    decision.action === "list" ||
    decision.action === "presentations" ||
    decision.action === "board" ||
    decision.action === "pr-watch"
  ) {
    return { action: decision.action };
  }
  if (decision.action === "receipt") return { action: "request-receipt" };
  if (decision.taskId === undefined) return undefined;
  return { action: decision.action, taskId: decision.taskId };
}

/**
 * Answers an interactive prompt in code when it is a lookup, a PR review, a pull-up, an
 * investigation, or a reply to a fixed-choice question, delivering the reply through the host.
 * `handled: false` leaves the prompt to the coordinator.
 */
export async function routeUserPrompt(
  event: UserPrompt,
  deps: PromptRoutingDependencies,
): Promise<Readonly<{ handled: boolean }>> {
  if (!event.interactive) return { handled: false };
  const prompt = normalizePrompt(event.text);
  if (prompt.length === 0) return { handled: false };
  if (await routeConfirmation(prompt, deps)) return { handled: true };
  const bypass = prompt.startsWith("/") ? "known-command" : undefined;
  const reason = bypass ?? (event.attachments > 0 ? "attachments-present" : undefined);
  if (reason !== undefined) {
    await recordDiagnostic(deps, "prompt-route-bypassed", {
      promptHash: promptHash(prompt),
      reason,
    });
    return { handled: false };
  }

  if (findPullRequestRef(prompt) !== undefined) {
    return { handled: await routePrReview(prompt, deps) };
  }
  if (
    deps.config.apiKey !== undefined &&
    prompt.length <= MAX_CHOICE_REPLY_CHARS &&
    (await routeChoiceReply(prompt, deps))
  ) {
    return { handled: true };
  }
  if (
    deps.config.apiKey !== undefined &&
    mentionsPullUp(prompt) &&
    (await routePullUp(prompt, deps))
  ) {
    return { handled: true };
  }
  if (
    deps.config.apiKey !== undefined &&
    mentionsInvestigation(prompt) &&
    (await routeInvestigate(prompt, deps))
  ) {
    return { handled: true };
  }
  return { handled: await routeLookup(prompt, deps) };
}

/** Runs the one read-only lookup Jev names with confidence; false, with nothing run, otherwise. */
async function routeLookup(prompt: string, deps: PromptRoutingDependencies): Promise<boolean> {
  const evaluation = await classifyPrompt(prompt, deps.config, deps.evaluate, deps.now);
  await recordDiagnostic(
    deps,
    "prompt-route-evaluated",
    {
      promptHash: promptHash(prompt),
      classifier: evaluation.classifier,
      reason: evaluation.reason,
      durationMs: evaluation.durationMs,
      ...(evaluation.decision === undefined
        ? {}
        : {
            action: evaluation.decision.action,
            target: evaluation.decision.target,
            effect: evaluation.decision.effect,
            scope: evaluation.decision.scope,
            composition: evaluation.decision.composition,
            confidence: evaluation.decision.confidence,
            ...(evaluation.decision.taskId === undefined
              ? {}
              : { taskId: evaluation.decision.taskId }),
          }),
    },
    evaluation.usage,
  );
  const decision = evaluation.decision;
  if (decision === undefined) {
    return recordFallback(prompt, deps, evaluation.reason);
  }
  const action = actionForPromptDecision(decision);
  if (action === undefined) {
    return recordFallback(prompt, deps, "unsafe-action-shape");
  }
  await dispatchRoutedAction(prompt, action, deps, {
    details: decision.taskId === undefined ? {} : { taskId: decision.taskId },
  });
  return true;
}
