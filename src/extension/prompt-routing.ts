import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@oh-my-pi/pi-coding-agent";
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
  type JevQuestions,
  jevUsageRecord,
} from "../adapters/typesafe.ts";
import { findPullRequestRef } from "../pr-review/pull-request.ts";
import { classifyPrReviewPrompt, PR_REVIEW_ROUTE_QUESTION_VERSION } from "../pr-review/route.ts";
import { appendDiagnosticEvent, type DiagnosticValue } from "../runtime/diagnostics.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import type { TandemService } from "../service/controller.ts";
import { executeTandemAction, type TandemAction } from "./actions.ts";
import {
  CHOICE_REPLY_ROUTE_QUESTION_VERSION,
  classifyChoiceReply,
  MAX_CHOICE_REPLY_CHARS,
  type OpenChoice,
  openChoices,
} from "./choice-reply-route.ts";
import {
  classifyPullUpPrompt,
  MAX_PULL_UP_CANDIDATES,
  mentionsPullUp,
  PULL_UP_ROUTE_QUESTION_VERSION,
  type PullUpCandidate,
} from "./pull-up-route.ts";
import { ACTION_RESULT_MAX_CHARS, compactText, summarizeTandemActionValue } from "./summary.ts";

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
  | "pr-watch";
type RouteTarget = "repository" | "task" | "conversation" | "unresolved";
type RouteEffect = "read-only" | "state-change" | "sensitive" | "unknown";
type RouteScope = "within" | "changes" | "unclear";
type RouteComposition = "single" | "homogeneous-batch" | "mixed";

export type PromptRoutingConfig = Readonly<{
  readonly apiKey?: string;
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

export type PromptRoutingDependencies = Readonly<{
  readonly config: PromptRoutingConfig;
  readonly getService: (ctx: ExtensionContext) => TandemService;
  readonly getHome: (ctx: ExtensionContext) => string;
  /** The project a routed PR review runs under; without it, PR links go to the coordinator. */
  readonly getRepo?: (ctx: ExtensionContext) => string;
  readonly sendMessage: ExtensionAPI["sendMessage"];
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

/** Bumped whenever the shape or meaning of {@link ROUTING_QUESTIONS} changes. */
export const PROMPT_ROUTING_QUESTION_SCHEMA_VERSION = 3;

const ROUTING_QUESTIONS: JevQuestions = {
  action: {
    type: "choice",
    instructions:
      "Identify the single requested Tandem lookup. Do not invent arguments and do not choose a mutation or communication action.",
    criteria: {
      list: "The user asks for the current list or status of Tandem tasks.",
      presentations: "The user asks for current presentations or presentation status.",
      show: "The user asks to show one task or its durable record.",
      messages: "The user asks to read one task's durable messages or communication history.",
      inspect: "The user asks to inspect one task's runtime state.",
      receipt:
        "The user asks how much time, how many tokens, or how much money the current request has used so far.",
      "pr-watch":
        "The user asks how their pull requests are doing: CI, review, merge status, or whether one merged.",
      none: "The request is not exactly one supported read-only lookup.",
    },
  },
  target: {
    type: "choice",
    instructions: "Identify what the lookup is about.",
    criteria: {
      repository:
        "The lookup concerns the current repository, its task collection, or the user's watched pull requests.",
      task: "The lookup concerns one explicitly identified Tandem task.",
      conversation:
        "The request concerns the chat or a general answer rather than durable Tandem state.",
      unresolved: "The target cannot be identified safely.",
    },
  },
  effect: {
    type: "choice",
    instructions: "Identify whether fulfilling the request only reads durable state.",
    criteria: {
      "read-only": "The request only reads existing state and makes no changes.",
      "state-change":
        "The request could create, control, acknowledge, steer, answer, or otherwise change state.",
      sensitive:
        "The request involves approval, credentials, publication, merging, deletion, or another sensitive action.",
      unknown: "The effect cannot be identified safely.",
    },
  },
  scope: {
    type: "choice",
    instructions: "Identify whether the lookup stays within the current Tandem repository scope.",
    criteria: {
      within:
        "The lookup stays within the current Tandem repository, its tasks, and the user's watched pull requests.",
      changes: "The request asks to modify files, repositories, or external state.",
      unclear: "The scope is unclear or potentially outside the current repository.",
    },
  },
  composition: {
    type: "choice",
    instructions: "Identify whether this is one lookup or a mixed request.",
    criteria: {
      single: "The request asks for one supported lookup.",
      "homogeneous-batch": "The request asks for several lookups of one supported kind.",
      mixed: "The request combines different operations or includes unrelated work.",
    },
  },
};

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim();
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
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
  return {
    timeoutMs: parseTimeout(source.TANDEM_JEV_TIMEOUT_MS),
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
  };
}

export function extractPromptTaskId(prompt: string): string | undefined {
  return prompt.match(TASK_ID_PATTERN)?.[0];
}

function choiceAnswer(
  response: JevEvaluationResponse,
  id: string,
): Readonly<{ choice: string; confidence: number }> | undefined {
  const answer = response.answers[id];
  if (answer === undefined || answer.type !== "choice") return undefined;
  const confidence = choiceConfidence(answer);
  if (confidence === undefined) return undefined;
  return { choice: answer.choice, confidence };
}

function knownAction(choice: string): choice is ReadOnlyAction | "none" {
  return (
    choice === "list" ||
    choice === "presentations" ||
    choice === "show" ||
    choice === "messages" ||
    choice === "inspect" ||
    choice === "receipt" ||
    choice === "pr-watch" ||
    choice === "none"
  );
}

function knownTarget(choice: string): choice is RouteTarget {
  return (
    choice === "repository" ||
    choice === "task" ||
    choice === "conversation" ||
    choice === "unresolved"
  );
}

function knownEffect(choice: string): choice is RouteEffect {
  return (
    choice === "read-only" ||
    choice === "state-change" ||
    choice === "sensitive" ||
    choice === "unknown"
  );
}

function knownScope(choice: string): choice is RouteScope {
  return choice === "within" || choice === "changes" || choice === "unclear";
}

function knownComposition(choice: string): choice is RouteComposition {
  return choice === "single" || choice === "homogeneous-batch" || choice === "mixed";
}

function evaluationResult(
  classifier: PromptRoutingEvaluation["classifier"],
  reason: string,
  startedAt: number,
  now: PromptRoutingClock,
  outcome?: JevAttemptOutcome,
  decision?: PromptRoutingDecision,
): PromptRoutingEvaluation {
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  return {
    classifier,
    reason,
    durationMs,
    ...(outcome === undefined ? {} : { usage: jevUsageRecord({ outcome, durationMs, reason }) }),
    ...(decision === undefined ? {} : { decision }),
  };
}

export async function classifyPrompt(
  prompt: string,
  config: PromptRoutingConfig,
  evaluate: PromptRoutingDependencies["evaluate"] = evaluateJev,
  now: PromptRoutingClock = () => performance.now(),
): Promise<PromptRoutingEvaluation> {
  const startedAt = now();
  const normalized = normalizePrompt(prompt);
  if (normalized.length === 0) return evaluationResult("disabled", "empty-prompt", startedAt, now);
  if (normalized.length > MAX_ROUTABLE_PROMPT_CHARS) {
    return evaluationResult("disabled", "prompt-too-long", startedAt, now);
  }
  if (config.apiKey === undefined) {
    return evaluationResult("disabled", "jev-not-configured", startedAt, now);
  }

  const taskId = extractPromptTaskId(normalized);
  const input: JevEvaluationInput = {
    model: JEV_MODEL,
    state: {
      prompt: normalized,
      explicitTaskId: taskId ?? null,
      supportedLookups: ["list", "presentations", "show", "messages", "inspect", "pr-watch"],
    },
    questions: ROUTING_QUESTIONS,
  };
  const options: JevEvaluationOptions = {
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  };

  let response: JevEvaluationResponse;
  try {
    response = await evaluate(input, options);
  } catch (error) {
    const code = error instanceof JevEvaluationError ? error.code : "unavailable";
    const reason = error instanceof JevEvaluationError ? `jev-${error.code}` : "jev-error";
    return evaluationResult("jev", reason, startedAt, now, { kind: "failed", code });
  }
  const outcome: JevAttemptOutcome = { kind: "answered", usage: response.usage };

  const answers = [
    choiceAnswer(response, "action"),
    choiceAnswer(response, "target"),
    choiceAnswer(response, "effect"),
    choiceAnswer(response, "scope"),
    choiceAnswer(response, "composition"),
  ] as const;
  const [actionAnswer, targetAnswer, effectAnswer, scopeAnswer, compositionAnswer] = answers;
  if (
    actionAnswer === undefined ||
    targetAnswer === undefined ||
    effectAnswer === undefined ||
    scopeAnswer === undefined ||
    compositionAnswer === undefined
  ) {
    return evaluationResult("jev", "incomplete-classification", startedAt, now, outcome);
  }
  if (
    !knownAction(actionAnswer.choice) ||
    !knownTarget(targetAnswer.choice) ||
    !knownEffect(effectAnswer.choice) ||
    !knownScope(scopeAnswer.choice) ||
    !knownComposition(compositionAnswer.choice)
  ) {
    return evaluationResult("jev", "invalid-classification", startedAt, now, outcome);
  }

  const confidence = Math.min(
    actionAnswer.confidence,
    targetAnswer.confidence,
    effectAnswer.confidence,
    scopeAnswer.confidence,
    compositionAnswer.confidence,
  );
  if (confidence < PROMPT_ROUTING_CONFIDENCE_THRESHOLD) {
    return evaluationResult("jev", "low-confidence", startedAt, now, outcome);
  }
  const repositoryWide =
    actionAnswer.choice === "list" ||
    actionAnswer.choice === "presentations" ||
    actionAnswer.choice === "receipt" ||
    actionAnswer.choice === "pr-watch";
  const targetMatchesAction = repositoryWide
    ? targetAnswer.choice === "repository"
    : targetAnswer.choice === "task";
  if (!targetMatchesAction) {
    return evaluationResult("jev", "classification-mismatch", startedAt, now, outcome);
  }
  if (
    actionAnswer.choice === "none" ||
    targetAnswer.choice === "conversation" ||
    targetAnswer.choice === "unresolved" ||
    effectAnswer.choice !== "read-only" ||
    scopeAnswer.choice !== "within" ||
    compositionAnswer.choice !== "single"
  ) {
    return evaluationResult("jev", "normal-coordinator", startedAt, now, outcome);
  }
  if (!repositoryWide && taskId === undefined) {
    return evaluationResult("jev", "missing-explicit-task-id", startedAt, now, outcome);
  }
  const decision: PromptRoutingDecision = {
    action: actionAnswer.choice,
    target: targetAnswer.choice,
    effect: effectAnswer.choice,
    scope: scopeAnswer.choice,
    composition: compositionAnswer.choice,
    ...(taskId === undefined ? {} : { taskId }),
    confidence,
  };
  return evaluationResult("jev", "direct-read-only", startedAt, now, outcome, decision);
}

export function actionForPromptDecision(
  decision: PromptRoutingDecision,
): Extract<TandemAction, { readonly action: ReadOnlyAction | "request-receipt" }> | undefined {
  // The PR watch view reads GitHub first, so the answer is current.
  if (
    decision.action === "list" ||
    decision.action === "presentations" ||
    decision.action === "pr-watch"
  ) {
    return { action: decision.action };
  }
  // The receipt for the request in progress, measured up to now.
  if (decision.action === "receipt") return { action: "request-receipt" };
  if (decision.taskId === undefined) return undefined;
  return { action: decision.action, taskId: decision.taskId } as Extract<
    TandemAction,
    { readonly action: ReadOnlyAction }
  >;
}

function routeDetails(
  prompt: string,
  evaluation: PromptRoutingEvaluation,
): Record<string, DiagnosticValue> {
  const details: Record<string, DiagnosticValue> = {
    promptHash: promptHash(prompt),
    classifier: evaluation.classifier,
    reason: evaluation.reason,
    durationMs: evaluation.durationMs,
  };
  if (evaluation.decision !== undefined) {
    details.action = evaluation.decision.action;
    details.target = evaluation.decision.target;
    details.effect = evaluation.decision.effect;
    details.scope = evaluation.decision.scope;
    details.composition = evaluation.decision.composition;
    details.confidence = evaluation.decision.confidence;
    if (evaluation.decision.taskId !== undefined) details.taskId = evaluation.decision.taskId;
  }
  return details;
}

async function recordDiagnostic(
  deps: PromptRoutingDependencies,
  ctx: ExtensionContext,
  event: string,
  details: Record<string, DiagnosticValue>,
  usage?: UsageRecord,
): Promise<void> {
  try {
    await appendDiagnosticEvent(deps.getHome(ctx), {
      event,
      details,
      ...(usage === undefined ? {} : { usage }),
    });
  } catch {
    // Diagnostics are best effort and must never alter prompt handling.
  }
}

function sendDisplayedMessage(
  deps: PromptRoutingDependencies,
  content: string,
  details: Record<string, DiagnosticValue>,
): void {
  deps.sendMessage(
    {
      customType: "tandem-prompt-route",
      content,
      display: true,
      attribution: "agent",
      details,
    },
    { deliverAs: "nextTurn" },
  );
}

export async function handlePromptInput(
  event: InputEvent,
  ctx: ExtensionContext,
  deps: PromptRoutingDependencies,
): Promise<InputEventResult | undefined> {
  if (event.source !== "interactive") return undefined;
  const prompt = normalizePrompt(event.text);
  if (prompt.length === 0) return undefined;
  // A confirmation lasts one message: anything but an exact "y" or "n" routes as a new prompt.
  const pending = deps.confirmation?.pending;
  if (deps.confirmation !== undefined && pending !== undefined) {
    deps.confirmation.pending = undefined;
    if (prompt === "y") {
      await dispatchRoutedAction(prompt, pending.action, ctx, deps, {
        confirmedInConversation: true,
      });
      return { handled: true };
    }
    if (prompt === "n") {
      sendDisplayedMessage(deps, "Okay, I didn't do that.", {
        promptHash: promptHash(prompt),
        action: pending.action.action,
        declined: true,
      });
      await recordDiagnostic(deps, ctx, "prompt-route-declined", {
        promptHash: promptHash(prompt),
        action: pending.action.action,
      });
      return { handled: true };
    }
  }
  if (prompt.startsWith("/")) {
    await recordDiagnostic(deps, ctx, "prompt-route-bypassed", {
      promptHash: promptHash(prompt),
      reason: "known-command",
    });
    return undefined;
  }
  if ((event.images?.length ?? 0) > 0) {
    await recordDiagnostic(deps, ctx, "prompt-route-bypassed", {
      promptHash: promptHash(prompt),
      reason: "attachments-present",
    });
    return undefined;
  }

  if (findPullRequestRef(prompt) !== undefined) return routePrReview(prompt, ctx, deps);
  if (
    deps.config.apiKey !== undefined &&
    prompt.length <= MAX_CHOICE_REPLY_CHARS &&
    (await routeChoiceReply(prompt, ctx, deps)) !== undefined
  ) {
    return { handled: true };
  }
  // A prompt that is not a confident pull-up still gets the ordinary lookup routes below.
  if (
    deps.config.apiKey !== undefined &&
    mentionsPullUp(prompt) &&
    (await routePullUp(prompt, ctx, deps)) !== undefined
  ) {
    return { handled: true };
  }

  const evaluation = await classifyPrompt(prompt, deps.config, deps.evaluate, deps.now);
  await recordDiagnostic(
    deps,
    ctx,
    "prompt-route-evaluated",
    routeDetails(prompt, evaluation),
    evaluation.usage,
  );
  const decision = evaluation.decision;
  if (decision === undefined) {
    await recordDiagnostic(deps, ctx, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: evaluation.reason,
    });
    return undefined;
  }
  const action = actionForPromptDecision(decision);
  if (action === undefined) {
    await recordDiagnostic(deps, ctx, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "unsafe-action-shape",
    });
    return undefined;
  }

  await dispatchRoutedAction(prompt, action, ctx, deps, {
    details: decision.taskId === undefined ? {} : { taskId: decision.taskId },
  });
  return { handled: true };
}

/**
 * Runs one routed action and shows its result, or its failure, as the turn's reply. Every route
 * that skips the coordinator ends here, so they all display and record outcomes the same way.
 */
async function dispatchRoutedAction(
  prompt: string,
  action: TandemAction,
  ctx: ExtensionContext,
  deps: PromptRoutingDependencies,
  options: Readonly<{
    readonly details?: Record<string, DiagnosticValue>;
    readonly confirmedInConversation?: boolean;
  }> = {},
): Promise<void> {
  const shared = { promptHash: promptHash(prompt), action: action.action };
  try {
    const result = await executeTandemAction(action, deps.getService(ctx), ctx, {
      confirmedInConversation: options.confirmedInConversation ?? false,
    });
    sendDisplayedMessage(deps, summarizeTandemActionValue(result.action, result.value), {
      ...shared,
      ...options.details,
    });
    await recordDiagnostic(deps, ctx, "prompt-route-dispatched", { ...shared, ...options.details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = `Tandem ${action.action} failed: ${compactText(message, ACTION_RESULT_MAX_CHARS)}`;
    sendDisplayedMessage(deps, output, { ...shared, error: "action-failed" });
    await recordDiagnostic(deps, ctx, "prompt-route-failed", { ...shared, error: "action-failed" });
  }
}

/**
 * A prompt with a PR link either starts a review directly, when Jev is confident it asks for one,
 * or goes to the coordinator. It never falls through to the read-only lookup routes.
 */
async function routePrReview(
  prompt: string,
  ctx: ExtensionContext,
  deps: PromptRoutingDependencies,
): Promise<InputEventResult | undefined> {
  const evaluation = await classifyPrReviewPrompt(prompt, deps.config, deps.evaluate, deps.now);
  await recordDiagnostic(
    deps,
    ctx,
    "prompt-route-evaluated",
    {
      promptHash: promptHash(prompt),
      classifier: "jev",
      reason: evaluation.reason,
      durationMs: evaluation.durationMs,
      questionVersion: PR_REVIEW_ROUTE_QUESTION_VERSION,
      ...(evaluation.route === undefined ? {} : { lens: evaluation.route.lens.kind }),
    },
    evaluation.usage,
  );
  const route = evaluation.route;
  if (route === undefined || deps.getRepo === undefined) {
    await recordDiagnostic(deps, ctx, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: route === undefined ? evaluation.reason : "no-project",
    });
    return undefined;
  }
  const action: TandemAction = {
    action: "review-pr",
    pullRequest: route.pullRequest,
    repoPath: deps.getRepo(ctx),
    lens: route.lens.kind,
    ...(route.lens.kind === "focus" ? { focus: route.lens.focus } : {}),
  };
  await dispatchRoutedAction(prompt, action, ctx, deps);
  return { handled: true };
}

/** Briefs and presentations a person could ask to see, newest first. */
async function pullUpCandidates(service: TandemService): Promise<readonly PullUpCandidate[]> {
  const briefs = (await service.requestBriefs()).slice(0, MAX_PULL_UP_CANDIDATES).map(
    (record): PullUpCandidate => ({
      kind: "brief",
      id: record.id,
      about: record.draft.content.goal,
    }),
  );
  const shown = (await service.presentations())
    .filter(
      (record) =>
        record.status === "open" ||
        record.status === "ended" ||
        (record.status === "failed" && record.observation !== undefined),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_PULL_UP_CANDIDATES);
  const presentations: PullUpCandidate[] = [];
  for (const record of shown) {
    const about = record.objective ?? (await service.get(record.taskId)).objective;
    presentations.push({ kind: "presentation", id: record.id, about });
  }
  return [...presentations, ...briefs];
}

/**
 * Opens the brief or presentation a prompt asks to see, when Jev names exactly one with
 * confidence. Returns undefined, with nothing opened, when the prompt should route on.
 */
async function routePullUp(
  prompt: string,
  ctx: ExtensionContext,
  deps: PromptRoutingDependencies,
): Promise<true | undefined> {
  const service = deps.getService(ctx);
  let candidates: readonly PullUpCandidate[];
  try {
    candidates = await pullUpCandidates(service);
  } catch {
    await recordDiagnostic(deps, ctx, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "pull-up-candidates-unavailable",
    });
    return undefined;
  }
  const evaluation = await classifyPullUpPrompt(
    prompt,
    candidates,
    deps.config,
    deps.evaluate,
    deps.now,
  );
  await recordDiagnostic(
    deps,
    ctx,
    "prompt-route-evaluated",
    {
      promptHash: promptHash(prompt),
      classifier: "jev",
      reason: evaluation.reason,
      durationMs: evaluation.durationMs,
      questionVersion: PULL_UP_ROUTE_QUESTION_VERSION,
      candidates: candidates.length,
    },
    evaluation.usage,
  );
  const target = evaluation.target;
  if (target === undefined) return undefined;
  const action: TandemAction =
    target.kind === "brief"
      ? { action: "brief-review", requestId: target.id }
      : { action: "presentation-open", presentationId: target.id };
  await dispatchRoutedAction(prompt, action, ctx, deps);
  return true;
}

/**
 * Answers the fixed-choice question a short reply picks, when Jev names exactly one with
 * confidence. A low-risk choice runs now; a risky one is only asked back as a y/n question.
 * Returns undefined, with nothing done, when the prompt should route on.
 */
async function routeChoiceReply(
  prompt: string,
  ctx: ExtensionContext,
  deps: PromptRoutingDependencies,
): Promise<true | undefined> {
  let choices: readonly OpenChoice[];
  try {
    choices = await openChoices(deps.getService(ctx));
  } catch {
    await recordDiagnostic(deps, ctx, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "open-choices-unavailable",
    });
    return undefined;
  }
  if (choices.length === 0) return undefined;
  const evaluation = await classifyChoiceReply(
    prompt,
    choices,
    deps.config,
    deps.evaluate,
    deps.now,
  );
  await recordDiagnostic(
    deps,
    ctx,
    "prompt-route-evaluated",
    {
      promptHash: promptHash(prompt),
      classifier: "jev",
      reason: evaluation.reason,
      durationMs: evaluation.durationMs,
      questionVersion: CHOICE_REPLY_ROUTE_QUESTION_VERSION,
      candidates: choices.length,
    },
    evaluation.usage,
  );
  const choice = evaluation.choice;
  if (choice === undefined) return undefined;
  if (choice.confirm === undefined) {
    await dispatchRoutedAction(prompt, choice.action, ctx, deps);
    return true;
  }
  if (deps.confirmation === undefined) {
    await recordDiagnostic(deps, ctx, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "confirmation-unavailable",
    });
    return undefined;
  }
  deps.confirmation.pending = choice;
  sendDisplayedMessage(deps, choice.confirm, {
    promptHash: promptHash(prompt),
    action: choice.action.action,
    awaitingConfirmation: true,
  });
  await recordDiagnostic(deps, ctx, "prompt-route-confirm-asked", {
    promptHash: promptHash(prompt),
    action: choice.action.action,
  });
  return true;
}
