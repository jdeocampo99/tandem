import { createHash } from "node:crypto";
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
  jevGateway,
  jevUsageRecord,
} from "../adapters/typesafe.ts";
import type { TaskRecord } from "../contracts.ts";
import { findPullRequestRef } from "../pr-review/pull-request.ts";
import { classifyPrReviewPrompt, PR_REVIEW_ROUTE_QUESTION_VERSION } from "../pr-review/route.ts";
import type { DiagnosticEvent, DiagnosticValue } from "../runtime/diagnostics.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import type { TandemService } from "../service/controller.ts";
import { type ApprovalDialog, executeTandemAction, type TandemAction } from "./actions.ts";
import {
  CHOICE_REPLY_ROUTE_QUESTION_VERSION,
  classifyChoiceReply,
  MAX_CHOICE_REPLY_CHARS,
  type OpenChoice,
  openChoices,
} from "./choice-reply-route.ts";
import type { SessionEvent, SessionHost } from "./events.ts";
import {
  classifyInvestigatePrompt,
  INVESTIGATE_ROUTE_QUESTION_VERSION,
  investigateCandidates,
  mentionsInvestigation,
} from "./investigate-route.ts";
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

/** Bumped whenever the shape or meaning of {@link ROUTING_QUESTIONS} changes. */
export const PROMPT_ROUTING_QUESTION_SCHEMA_VERSION = 4;

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
      board:
        'The user asks how Tandem or their work is going overall, like "how\'s it going?": what needs them, what is running, and their pull requests at a glance.',
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
        "The lookup concerns the current repository, its task collection, the user's watched pull requests, or Tandem's work overall.",
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
        "The lookup stays within the current Tandem repository, its tasks, the user's watched pull requests, and Tandem's own work across projects.",
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
    choice === "board" ||
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
      supportedLookups: [
        "list",
        "presentations",
        "show",
        "messages",
        "inspect",
        "board",
        "pr-watch",
      ],
    },
    questions: ROUTING_QUESTIONS,
  };
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
    actionAnswer.choice === "board" ||
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
  // The PR watch view reads GitHub first, so the answer is current; the board only reads saved state.
  if (
    decision.action === "list" ||
    decision.action === "presentations" ||
    decision.action === "board" ||
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
  event: string,
  details: Record<string, DiagnosticValue>,
  usage?: UsageRecord,
): Promise<void> {
  try {
    await deps.diagnostics({ event, details, ...(usage === undefined ? {} : { usage }) });
  } catch {
    // Diagnostics are best effort and must never alter prompt handling.
  }
}

async function deliverReply(
  deps: PromptRoutingDependencies,
  text: string,
  details: Record<string, DiagnosticValue>,
): Promise<void> {
  await deps.host.perform({
    type: "deliver",
    source: "prompt-route",
    text,
    details,
    timing: "nextTurn",
    triggerTurn: false,
  });
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
  // A confirmation lasts one message: anything but an exact "y" or "n" routes as a new prompt.
  const pending = deps.confirmation?.pending;
  if (deps.confirmation !== undefined && pending !== undefined) {
    deps.confirmation.pending = undefined;
    if (prompt === "y") {
      await dispatchRoutedAction(prompt, pending.action, deps, { confirmedInConversation: true });
      return { handled: true };
    }
    if (prompt === "n") {
      await deliverReply(deps, "Okay, I didn't do that.", {
        promptHash: promptHash(prompt),
        action: pending.action.action,
        declined: true,
      });
      await recordDiagnostic(deps, "prompt-route-declined", {
        promptHash: promptHash(prompt),
        action: pending.action.action,
      });
      return { handled: true };
    }
  }
  if (prompt.startsWith("/")) {
    await recordDiagnostic(deps, "prompt-route-bypassed", {
      promptHash: promptHash(prompt),
      reason: "known-command",
    });
    return { handled: false };
  }
  if (event.attachments > 0) {
    await recordDiagnostic(deps, "prompt-route-bypassed", {
      promptHash: promptHash(prompt),
      reason: "attachments-present",
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
  // A prompt that is not a confident pull-up still gets the ordinary lookup routes below.
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
    routeDetails(prompt, evaluation),
    evaluation.usage,
  );
  const decision = evaluation.decision;
  if (decision === undefined) {
    await recordDiagnostic(deps, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: evaluation.reason,
    });
    return false;
  }
  const action = actionForPromptDecision(decision);
  if (action === undefined) {
    await recordDiagnostic(deps, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "unsafe-action-shape",
    });
    return false;
  }
  await dispatchRoutedAction(prompt, action, deps, {
    details: decision.taskId === undefined ? {} : { taskId: decision.taskId },
  });
  return true;
}

/**
 * Runs one routed action and shows its result, or its failure, as the turn's reply. Every route
 * that skips the coordinator ends here, so they all display and record outcomes the same way.
 */
async function dispatchRoutedAction(
  prompt: string,
  action: TandemAction,
  deps: PromptRoutingDependencies,
  options: Readonly<{
    readonly details?: Record<string, DiagnosticValue>;
    readonly confirmedInConversation?: boolean;
  }> = {},
): Promise<void> {
  const shared = { promptHash: promptHash(prompt), action: action.action };
  try {
    const result = await executeTandemAction(action, deps.service(), {
      confirm: deps.confirm,
      confirmedInConversation: options.confirmedInConversation ?? false,
    });
    await deliverReply(deps, summarizeTandemActionValue(result.action, result.value), {
      ...shared,
      ...options.details,
    });
    await recordDiagnostic(deps, "prompt-route-dispatched", { ...shared, ...options.details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = `Tandem ${action.action} failed: ${compactText(message, ACTION_RESULT_MAX_CHARS)}`;
    await deliverReply(deps, output, { ...shared, error: "action-failed" });
    await recordDiagnostic(deps, "prompt-route-failed", { ...shared, error: "action-failed" });
  }
}

/**
 * A prompt with a PR link either starts a review directly, when Jev is confident it asks for one,
 * or goes to the coordinator. It never falls through to the read-only lookup routes.
 */
async function routePrReview(prompt: string, deps: PromptRoutingDependencies): Promise<boolean> {
  const evaluation = await classifyPrReviewPrompt(prompt, deps.config, deps.evaluate, deps.now);
  await recordDiagnostic(
    deps,
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
  if (route === undefined || deps.repoPath === undefined) {
    await recordDiagnostic(deps, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: route === undefined ? evaluation.reason : "no-project",
    });
    return false;
  }
  const action: TandemAction = {
    action: "review-pr",
    pullRequest: route.pullRequest,
    repoPath: deps.repoPath(),
    lens: route.lens.kind,
    ...(route.lens.kind === "focus" ? { focus: route.lens.focus } : {}),
  };
  await dispatchRoutedAction(prompt, action, deps);
  return true;
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
 * confidence. Returns false, with nothing opened, when the prompt should route on.
 */
async function routePullUp(prompt: string, deps: PromptRoutingDependencies): Promise<boolean> {
  let candidates: readonly PullUpCandidate[];
  try {
    candidates = await pullUpCandidates(deps.service());
  } catch {
    await recordDiagnostic(deps, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "pull-up-candidates-unavailable",
    });
    return false;
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
  if (target === undefined) return false;
  const action: TandemAction =
    target.kind === "brief"
      ? { action: "brief-review", requestId: target.id }
      : { action: "presentation-open", presentationId: target.id };
  await dispatchRoutedAction(prompt, action, deps);
  return true;
}

/**
 * Answers the fixed-choice question a short reply picks, when Jev names exactly one with
 * confidence. A low-risk choice runs now; a risky one is only asked back as a y/n question.
 * Returns false, with nothing done, when the prompt should route on.
 */
async function routeChoiceReply(prompt: string, deps: PromptRoutingDependencies): Promise<boolean> {
  let choices: readonly OpenChoice[];
  try {
    choices = await openChoices(deps.service());
  } catch {
    await recordDiagnostic(deps, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "open-choices-unavailable",
    });
    return false;
  }
  if (choices.length === 0) return false;
  const evaluation = await classifyChoiceReply(
    prompt,
    choices,
    deps.config,
    deps.evaluate,
    deps.now,
  );
  await recordDiagnostic(
    deps,
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
  if (choice === undefined) return false;
  if (choice.confirm === undefined) {
    await dispatchRoutedAction(prompt, choice.action, deps);
    return true;
  }
  if (deps.confirmation === undefined) {
    await recordDiagnostic(deps, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "confirmation-unavailable",
    });
    return false;
  }
  deps.confirmation.pending = choice;
  await deliverReply(deps, choice.confirm, {
    promptHash: promptHash(prompt),
    action: choice.action.action,
    awaitingConfirmation: true,
  });
  await recordDiagnostic(deps, "prompt-route-confirm-asked", {
    promptHash: promptHash(prompt),
    action: choice.action.action,
  });
  return true;
}

/**
 * Starts an investigation when self-improvement is on and Jev names the one task a "why did that
 * take so long?" prompt asks about. Returns false, with nothing started, when the prompt should
 * route on.
 */
async function routeInvestigate(prompt: string, deps: PromptRoutingDependencies): Promise<boolean> {
  let candidates: readonly TaskRecord[];
  try {
    const service = deps.service();
    if ((await service.selfImprovementMode()) === "off") return false;
    candidates = investigateCandidates(await service.list());
  } catch {
    await recordDiagnostic(deps, "prompt-route-fallback", {
      promptHash: promptHash(prompt),
      reason: "investigate-candidates-unavailable",
    });
    return false;
  }
  const evaluation = await classifyInvestigatePrompt(
    prompt,
    candidates,
    deps.config,
    deps.evaluate,
    deps.now,
  );
  await recordDiagnostic(
    deps,
    "prompt-route-evaluated",
    {
      promptHash: promptHash(prompt),
      classifier: "jev",
      reason: evaluation.reason,
      durationMs: evaluation.durationMs,
      questionVersion: INVESTIGATE_ROUTE_QUESTION_VERSION,
      candidates: candidates.length,
    },
    evaluation.usage,
  );
  if (evaluation.taskId === undefined) return false;
  await dispatchRoutedAction(
    prompt,
    { action: "investigate", taskId: evaluation.taskId, question: prompt },
    deps,
    { details: { taskId: evaluation.taskId } },
  );
  return true;
}
