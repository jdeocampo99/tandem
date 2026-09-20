import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@oh-my-pi/pi-coding-agent";
import {
  evaluateJev,
  JEV_MODEL,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationOptions,
  type JevEvaluationResponse,
  type JevFetch,
  type JevQuestions,
} from "../adapters/typesafe.ts";
import { appendDiagnosticEvent, type DiagnosticValue } from "../runtime/diagnostics.ts";
import type { TandemService } from "../service/controller.ts";
import { executeTandemAction, type TandemAction } from "./actions.ts";
import { ACTION_RESULT_MAX_CHARS, compactText, summarizeTandemActionValue } from "./summary.ts";

export const DEFAULT_PROMPT_ROUTING_TIMEOUT_MS = 1_500;
export const PROMPT_ROUTING_CONFIDENCE_THRESHOLD = 0.8;
const MAX_ROUTABLE_PROMPT_CHARS = 16_000;
const TASK_ID_PATTERN =
  /\b(?:task-[A-Za-z0-9][A-Za-z0-9._-]{0,127}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/giu;

type ReadOnlyAction = "list" | "presentations" | "show" | "messages" | "inspect" | "recovery-plan";
type RouteTarget = "repository" | "task" | "conversation" | "unresolved";
type RouteEffect = "read-only" | "state-change" | "sensitive" | "unknown";
type RouteScope = "within" | "changes" | "unclear";
type RouteComposition = "single" | "homogeneous-batch" | "mixed";

export type PromptRoutingConfig = Readonly<{
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly fetch?: JevFetch;
}>;

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
}>;

export type PromptRoutingDependencies = Readonly<{
  readonly config: PromptRoutingConfig;
  readonly getService: (ctx: ExtensionContext) => TandemService;
  readonly getHome: (ctx: ExtensionContext) => string;
  readonly sendMessage: ExtensionAPI["sendMessage"];
  readonly evaluate?: (
    input: JevEvaluationInput,
    options: JevEvaluationOptions,
  ) => Promise<JevEvaluationResponse>;
}>;

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
      inspect: "The user asks to inspect one task's runtime or recovery state.",
      "recovery-plan": "The user asks for a dry-run recovery plan for one task.",
      none: "The request is not exactly one supported read-only lookup.",
    },
  },
  target: {
    type: "choice",
    instructions: "Identify what the lookup is about.",
    criteria: {
      repository: "The lookup concerns the current repository or its task collection.",
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
      within: "The lookup stays within the current Tandem repository and task scope.",
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
  const probability = answer.probabilities[answer.choice];
  if (
    probability === undefined ||
    !Number.isFinite(probability) ||
    !Number.isFinite(answer.confidence)
  ) {
    return undefined;
  }
  return {
    choice: answer.choice,
    confidence: Math.min(answer.confidence, probability),
  };
}

function knownAction(choice: string): choice is ReadOnlyAction | "none" {
  return (
    choice === "list" ||
    choice === "presentations" ||
    choice === "show" ||
    choice === "messages" ||
    choice === "inspect" ||
    choice === "recovery-plan" ||
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
  decision?: PromptRoutingDecision,
): PromptRoutingEvaluation {
  return {
    classifier,
    reason,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ...(decision === undefined ? {} : { decision }),
  };
}

export async function classifyPrompt(
  prompt: string,
  config: PromptRoutingConfig,
  evaluate: PromptRoutingDependencies["evaluate"] = evaluateJev,
): Promise<PromptRoutingEvaluation> {
  const startedAt = performance.now();
  const normalized = normalizePrompt(prompt);
  if (normalized.length === 0) return evaluationResult("disabled", "empty-prompt", startedAt);
  if (normalized.length > MAX_ROUTABLE_PROMPT_CHARS) {
    return evaluationResult("disabled", "prompt-too-long", startedAt);
  }
  if (config.apiKey === undefined) {
    return evaluationResult("disabled", "jev-not-configured", startedAt);
  }

  const taskId = extractPromptTaskId(normalized);
  const input: JevEvaluationInput = {
    model: JEV_MODEL,
    state: {
      prompt: normalized,
      explicitTaskId: taskId ?? null,
      supportedLookups: ["list", "presentations", "show", "messages", "inspect", "recovery-plan"],
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
    const reason = error instanceof JevEvaluationError ? `jev-${error.code}` : "jev-error";
    return evaluationResult("jev", reason, startedAt);
  }

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
    return evaluationResult("jev", "incomplete-classification", startedAt);
  }
  if (
    !knownAction(actionAnswer.choice) ||
    !knownTarget(targetAnswer.choice) ||
    !knownEffect(effectAnswer.choice) ||
    !knownScope(scopeAnswer.choice) ||
    !knownComposition(compositionAnswer.choice)
  ) {
    return evaluationResult("jev", "invalid-classification", startedAt);
  }

  const confidence = Math.min(
    actionAnswer.confidence,
    targetAnswer.confidence,
    effectAnswer.confidence,
    scopeAnswer.confidence,
    compositionAnswer.confidence,
  );
  if (confidence < PROMPT_ROUTING_CONFIDENCE_THRESHOLD) {
    return evaluationResult("jev", "low-confidence", startedAt);
  }
  const targetMatchesAction =
    actionAnswer.choice === "list" || actionAnswer.choice === "presentations"
      ? targetAnswer.choice === "repository"
      : targetAnswer.choice === "task";
  if (!targetMatchesAction) {
    return evaluationResult("jev", "classification-mismatch", startedAt);
  }
  if (
    actionAnswer.choice === "none" ||
    targetAnswer.choice === "conversation" ||
    targetAnswer.choice === "unresolved" ||
    effectAnswer.choice !== "read-only" ||
    scopeAnswer.choice !== "within" ||
    compositionAnswer.choice !== "single"
  ) {
    return evaluationResult("jev", "normal-coordinator", startedAt);
  }
  if (
    actionAnswer.choice !== "list" &&
    actionAnswer.choice !== "presentations" &&
    taskId === undefined
  ) {
    return evaluationResult("jev", "missing-explicit-task-id", startedAt);
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
  return evaluationResult("jev", "direct-read-only", startedAt, decision);
}

export function actionForPromptDecision(
  decision: PromptRoutingDecision,
): Extract<TandemAction, { readonly action: ReadOnlyAction }> | undefined {
  if (decision.action === "list" || decision.action === "presentations") {
    return { action: decision.action };
  }
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
): Promise<void> {
  try {
    await appendDiagnosticEvent(deps.getHome(ctx), { event, details });
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

  const evaluation = await classifyPrompt(prompt, deps.config, deps.evaluate);
  await recordDiagnostic(deps, ctx, "prompt-route-evaluated", routeDetails(prompt, evaluation));
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

  try {
    const result = await executeTandemAction(action, deps.getService(ctx), ctx);
    sendDisplayedMessage(deps, summarizeTandemActionValue(result.action, result.value), {
      promptHash: promptHash(prompt),
      action: action.action,
      ...(decision.taskId === undefined ? {} : { taskId: decision.taskId }),
    });
    await recordDiagnostic(deps, ctx, "prompt-route-dispatched", {
      promptHash: promptHash(prompt),
      action: action.action,
      ...(decision.taskId === undefined ? {} : { taskId: decision.taskId }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = `Tandem ${action.action} failed: ${compactText(message, ACTION_RESULT_MAX_CHARS)}`;
    sendDisplayedMessage(deps, output, {
      promptHash: promptHash(prompt),
      action: action.action,
      error: "action-failed",
    });
    await recordDiagnostic(deps, ctx, "prompt-route-failed", {
      promptHash: promptHash(prompt),
      action: action.action,
      error: "action-failed",
    });
  }
  return { handled: true };
}
