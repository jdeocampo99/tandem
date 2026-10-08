import type { TaskRecord } from "../contracts.ts";
import { classifyPrReviewPrompt, PR_REVIEW_ROUTE_QUESTION_VERSION } from "../pr-review/route.ts";
import type { TandemService } from "../service/controller.ts";
import type { TandemAction } from "./actions.ts";
import {
  CHOICE_REPLY_ROUTE_QUESTION_VERSION,
  classifyChoiceReply,
  MAX_CHOICE_REPLY_CHARS,
  type OpenChoice,
  openChoices,
} from "./choice-reply-route.ts";
import {
  classifyInvestigatePrompt,
  INVESTIGATE_ROUTE_QUESTION_VERSION,
  investigateCandidates,
  mentionsInvestigation,
} from "./investigate-route.ts";
import {
  deliverReply,
  dispatchRoutedAction,
  promptHash,
  recordDiagnostic,
  recordFallback,
  recordRouteEvaluation,
} from "./prompt-replies.ts";
import type { PromptRoutingDependencies } from "./prompt-routing.ts";
import {
  classifyPullUpPrompt,
  MAX_PULL_UP_CANDIDATES,
  mentionsPullUp,
  PULL_UP_ROUTE_QUESTION_VERSION,
  type PullUpCandidate,
} from "./pull-up-route.ts";
/**
 * A prompt with a PR link either starts a review directly, when Jev is confident it asks for one,
 * or goes to the coordinator. It never falls through to the read-only lookup routes.
 */
export async function routePrReview(
  prompt: string,
  deps: PromptRoutingDependencies,
): Promise<boolean> {
  const evaluation = await classifyPrReviewPrompt(prompt, deps.config, deps.evaluate, deps.now);
  await recordRouteEvaluation(prompt, deps, evaluation, {
    questionVersion: PR_REVIEW_ROUTE_QUESTION_VERSION,
    ...(evaluation.route === undefined ? {} : { lens: evaluation.route.lens.kind }),
  });
  const route = evaluation.route;
  if (route === undefined || deps.repoPath === undefined) {
    return recordFallback(prompt, deps, route === undefined ? evaluation.reason : "no-project");
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
    return recordFallback(prompt, deps, "pull-up-candidates-unavailable");
  }
  const evaluation = await classifyPullUpPrompt(
    prompt,
    candidates,
    deps.config,
    deps.evaluate,
    deps.now,
  );
  await recordRouteEvaluation(prompt, deps, evaluation, {
    questionVersion: PULL_UP_ROUTE_QUESTION_VERSION,
    candidates: candidates.length,
  });
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
    return recordFallback(prompt, deps, "open-choices-unavailable");
  }
  if (choices.length === 0) return false;
  const evaluation = await classifyChoiceReply(
    prompt,
    choices,
    deps.config,
    deps.evaluate,
    deps.now,
  );
  await recordRouteEvaluation(prompt, deps, evaluation, {
    questionVersion: CHOICE_REPLY_ROUTE_QUESTION_VERSION,
    candidates: choices.length,
  });
  const choice = evaluation.choice;
  if (choice === undefined) return false;
  if (choice.confirm === undefined) {
    await dispatchRoutedAction(prompt, choice.action, deps);
    return true;
  }
  if (deps.confirmation === undefined) {
    return recordFallback(prompt, deps, "confirmation-unavailable");
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
    return recordFallback(prompt, deps, "investigate-candidates-unavailable");
  }
  const evaluation = await classifyInvestigatePrompt(
    prompt,
    candidates,
    deps.config,
    deps.evaluate,
    deps.now,
  );
  await recordRouteEvaluation(prompt, deps, evaluation, {
    questionVersion: INVESTIGATE_ROUTE_QUESTION_VERSION,
    candidates: candidates.length,
  });
  if (evaluation.taskId === undefined) return false;
  await dispatchRoutedAction(
    prompt,
    { action: "investigate", taskId: evaluation.taskId, question: prompt },
    deps,
    { details: { taskId: evaluation.taskId } },
  );
  return true;
}

export async function routeCandidatePrompt(
  prompt: string,
  deps: PromptRoutingDependencies,
): Promise<boolean> {
  if (
    deps.config.apiKey !== undefined &&
    prompt.length <= MAX_CHOICE_REPLY_CHARS &&
    (await routeChoiceReply(prompt, deps))
  ) {
    return true;
  }
  if (
    deps.config.apiKey !== undefined &&
    mentionsPullUp(prompt) &&
    (await routePullUp(prompt, deps))
  ) {
    return true;
  }
  if (
    deps.config.apiKey !== undefined &&
    mentionsInvestigation(prompt) &&
    (await routeInvestigate(prompt, deps))
  ) {
    return true;
  }
  return false;
}
