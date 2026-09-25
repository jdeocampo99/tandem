import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { MergingChoice } from "../config/repositories.ts";
import type { CreatableTaskKind, RepoPolicy, RequestBriefContent } from "../contracts.ts";
import type { PrSummary } from "../delivery/evidence.ts";
import type { PinnablePlaybookId } from "../playbooks/catalog.ts";
import type { ReviewVerdict } from "../pr-review/post.ts";
import type { ReviewLens } from "../pr-review/review.ts";
import type { CommentEdit } from "../pr-review/service.ts";
import type { CreateTaskRequest, PullRequestInput, TandemService } from "../service/controller.ts";
import { activeTaskMessages } from "../tasks/communication-protocol.ts";
import { taskName } from "../tasks/question.ts";
import { projectName, summarizeModelAssignments } from "./summary.ts";

export type TandemAction =
  | Readonly<{ readonly action: "restart"; readonly taskId: string }>
  | Readonly<{ readonly action: "setup"; readonly repoPath: string }>
  | Readonly<{ readonly action: "models"; readonly repoPath: string }>
  | Readonly<{ readonly action: "onboard"; readonly repoPath: string }>
  | Readonly<{
      readonly action: "configure-models";
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
      readonly enabledProviders?: readonly string[] | undefined;
    }>
  | Readonly<{
      readonly action: "create";
      readonly repoPath: string;
      readonly requestId?: string | undefined;
      readonly kind: CreatableTaskKind;
      readonly objective: string;
      readonly acceptanceCriteria: readonly string[];
      readonly manualVerification?: readonly string[] | undefined;
      readonly surfaces: readonly string[];
      readonly researchTaskIds?: readonly string[] | undefined;
      /** Names of skills the user asked this work to use. */
      readonly skills?: readonly string[] | undefined;
      readonly playbook?: PinnablePlaybookId | undefined;
      readonly targetRepo?: string | undefined;
      readonly targetCheckout?: string | undefined;
      readonly targetClone?: boolean | undefined;
      readonly validationCommands?: readonly string[] | undefined;
    }>
  | Readonly<{ readonly action: "list" }>
  | Readonly<{ readonly action: "presentations" }>
  | Readonly<{
      readonly action: "show";
      readonly taskId: string;
      readonly detail?: "summary" | "full" | undefined;
    }>
  | Readonly<{
      readonly action: "steer";
      readonly taskId: string;
      readonly text: string;
      readonly supersedes?: readonly string[] | undefined;
    }>
  | Readonly<{
      readonly action: "answer";
      readonly taskId: string;
      readonly questionId: string;
      readonly text: string;
    }>
  | Readonly<{ readonly action: "messages"; readonly taskId: string }>
  | Readonly<{ readonly action: "inspect"; readonly taskId: string }>
  | Readonly<{
      readonly action: "delivery-preflight";
      readonly taskId: string;
      readonly base: string;
    }>
  | Readonly<{ readonly action: "approve"; readonly taskId: string }>
  | Readonly<{
      readonly action: "brief-draft";
      readonly repoPath: string;
      readonly requestId?: string | undefined;
      readonly content: RequestBriefContent;
      readonly reviewPane: boolean;
    }>
  | Readonly<{ readonly action: "brief-review"; readonly requestId: string }>
  | Readonly<{ readonly action: "brief-show"; readonly requestId: string }>
  | Readonly<{ readonly action: "request-receipt"; readonly requestId?: string | undefined }>
  | Readonly<{
      readonly action: "brief-approve";
      /** Omitted resolves to the one request whose brief is awaiting approval. */
      readonly requestId?: string | undefined;
      readonly briefRevision: number;
      readonly contentDigest: string;
    }>
  | Readonly<{ readonly action: "tick" }>
  | Readonly<{
      readonly action: "pause";
      readonly taskId: string;
      readonly reason?: string | undefined;
    }>
  | Readonly<{ readonly action: "resume"; readonly taskId: string }>
  | Readonly<{
      readonly action: "cancel";
      readonly taskId: string;
      readonly reason?: string | undefined;
      readonly discard?: boolean | undefined;
    }>
  | Readonly<{
      readonly action: "present";
      readonly taskId: string;
      readonly objective: string;
      readonly artifacts: readonly string[];
    }>
  | Readonly<{ readonly action: "feedback"; readonly presentationId: string }>
  | Readonly<{ readonly action: "presentation-open"; readonly presentationId: string }>
  | Readonly<{ readonly action: "describe"; readonly taskId: string; readonly summary: PrSummary }>
  | Readonly<{
      readonly action: "publish";
      readonly taskId: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
    }>
  | Readonly<{
      readonly action: "publish-now";
      readonly taskId: string;
      readonly repository: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
    }>
  | Readonly<{
      readonly action: "draft";
      readonly taskId: string;
      readonly title: string;
      readonly base: string;
    }>
  | Readonly<{
      readonly action: "merge";
      readonly taskId: string;
      readonly method: "merge" | "squash" | "rebase";
    }>
  | Readonly<{
      readonly action: "cleanup";
      readonly taskIds: readonly string[];
      readonly discard?: boolean | undefined;
    }>
  | Readonly<{
      readonly action: "review-pr";
      readonly pullRequest: string;
      readonly repoPath: string;
      readonly lens?: "full" | "intent" | "focus" | undefined;
      /** The user's own words for a focus review, such as "the migration". */
      readonly focus?: string | undefined;
      readonly checkout?: string | undefined;
      readonly clone?: boolean | undefined;
    }>
  | Readonly<{
      readonly action: "review-show";
      readonly taskId: string;
      readonly page?: boolean | undefined;
    }>
  | Readonly<{ readonly action: "review-notes"; readonly taskId: string }>
  | Readonly<{
      readonly action: "review-edit";
      readonly taskId: string;
      readonly comments?: readonly CommentEdit[] | undefined;
      readonly summaryComment?: string | undefined;
    }>
  | Readonly<{
      readonly action: "review-post";
      readonly taskId: string;
      readonly verdict: ReviewVerdict;
    }>
  | Readonly<{ readonly action: "review-again"; readonly taskId: string }>
  | Readonly<{ readonly action: "review-close"; readonly taskId: string }>
  | Readonly<{ readonly action: "pr-watch" }>
  | Readonly<{
      readonly action: "pr-watch-merging";
      /** The Tandem project whose settings get the answer. */
      readonly repoPath: string;
      readonly mergeWith: "auto-merge" | "queue-label" | "off";
      readonly queueLabel?: string | undefined;
      readonly blockedLabel?: string | undefined;
    }>
  | Readonly<{
      readonly action: "pr-watch-start" | "pr-watch-stop" | "pr-watch-fix";
      /** A GitHub PR URL, `owner/repo#123`, or `#123` in `repoPath`. */
      readonly pullRequest: string;
      readonly repoPath?: string | undefined;
    }>;

export type TandemActionResult = Readonly<{
  readonly action: TandemAction["action"];
  readonly value?: unknown;
  readonly approved?: boolean;
  readonly detail?: "summary" | "full";
}>;

function textResult(
  value: unknown,
  action: TandemAction["action"],
  approved?: boolean,
  detail?: "summary" | "full",
): TandemActionResult {
  return {
    action,
    value,
    ...(approved === undefined ? {} : { approved }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function requiresHumanApproval(action: TandemAction): boolean {
  if (action.action === "cleanup") return action.discard === true;
  return (
    action.action === "setup" ||
    action.action === "configure-models" ||
    action.action === "approve" ||
    action.action === "brief-approve" ||
    action.action === "cancel" ||
    action.action === "publish" ||
    action.action === "publish-now" ||
    action.action === "draft" ||
    action.action === "merge" ||
    action.action === "review-post" ||
    action.action === "pr-watch-fix" ||
    action.action === "pr-watch-merging"
  );
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function approvalPrompt(
  action: TandemAction,
  service: TandemService,
): Promise<Readonly<{ readonly title: string; readonly message: string }>> {
  if (action.action === "configure-models") {
    const choices = summarizeModelAssignments(action.models);
    const providers =
      action.enabledProviders === undefined
        ? ""
        : `\nCan spend on: ${action.enabledProviders.length === 0 ? "none" : action.enabledProviders.join(", ")}.`;
    return {
      title: "Save these model choices?",
      message: `${choices.map((entry) => `- ${entry}`).join("\n")}${providers}`,
    };
  }
  if (action.action === "setup") {
    const onboarded = await service.onboard(action.repoPath, false);
    return {
      title: `Save Tandem settings for ${projectName(onboarded.repoPath)}?`,
      message: "Saved outside the project.",
    };
  }
  if (action.action === "brief-approve") {
    const requestId = action.requestId ?? (await service.pendingBriefApprovalId());
    const view = await service.requestBrief(requestId);
    return {
      title: "Approve this brief?",
      message: taskName(view.record.draft.content.goal),
    };
  }
  if (action.action === "cleanup") {
    const names = await Promise.all(
      action.taskIds.map(async (taskId) => taskName((await service.get(taskId)).objective)),
    );
    const [only] = names;
    return names.length === 1 && only !== undefined
      ? { title: `Delete the worktree for ${only}?`, message: "This discards its changes." }
      : {
          title: `Delete the worktrees for ${names.length} tasks?`,
          message: `${names.map((name) => `- ${name}`).join("\n")}\nThis discards their changes.`,
        };
  }
  if (action.action === "pr-watch-merging") {
    const how =
      action.mergeWith === "off"
        ? "PR watch keeps retrying CI but never merges here."
        : action.mergeWith === "auto-merge"
          ? "PR watch turns on GitHub auto-merge for published pull requests."
          : `PR watch adds the ${action.queueLabel ?? ""} label to published pull requests.`;
    return { title: `Save how ${projectName(action.repoPath)} merges?`, message: how };
  }
  if (action.action === "pr-watch-fix") {
    return {
      title: `Fix the merge conflicts on ${action.pullRequest}?`,
      message: "Starts a task that merges the base into its branch and pushes. Never force-pushes.",
    };
  }
  if (!("taskId" in action)) return { title: "Allow this Tandem action?", message: "" };
  const task = await service.get(action.taskId);
  const name = taskName(task.objective);
  switch (action.action) {
    case "approve": {
      // Directions given after the plan go to the worker too, so the approval names them.
      const directions =
        task.communication === undefined ? 0 : activeTaskMessages(task.communication).length;
      return {
        title: `Start building ${name}?`,
        message:
          directions === 0
            ? ""
            : `Includes ${directions} direction${directions === 1 ? "" : "s"} you gave after the plan.`,
      };
    }
    case "cancel":
      return action.discard === true
        ? {
            title: `Stop ${name} and delete its worktree?`,
            message: "This discards its changes. Reports are kept.",
          }
        : { title: `Stop ${name}?`, message: "Its work and reports are kept." };
    case "publish":
      return {
        title: `Open a PR for ${name}?`,
        message: `Into ${action.base}. PR watch merges it once its checks pass.`,
      };
    case "publish-now":
      return {
        title: `Skip review and open a PR for ${name}?`,
        message: `Into ${action.base}. Open findings are listed in the PR. PR watch merges it once its checks pass.`,
      };
    case "draft":
      return {
        title: `Open a draft PR for ${name}?`,
        message: "Shows progress only. Nothing is merged.",
      };
    case "merge":
      return {
        title:
          task.pullRequest === undefined
            ? `Merge ${name}?`
            : `Merge PR #${task.pullRequest.number}?`,
        message: `${capitalize(action.method)}, once checks pass.`,
      };
    case "review-post": {
      const round = task.prReview?.rounds.at(-1);
      const count = round?.review.comments.length ?? 0;
      const target =
        task.prReview === undefined
          ? name
          : `${task.prReview.ref.repo}#${task.prReview.ref.number}`;
      return {
        title: `Post your review on ${target}?`,
        message: `${VERDICT_LABELS[action.verdict]}, with ${count} inline comment${count === 1 ? "" : "s"}. It goes up under your GitHub name.`,
      };
    }
    default:
      return { title: "Allow this Tandem action?", message: "" };
  }
}

async function confirmAction(
  action: TandemAction,
  service: TandemService,
  ctx: ExtensionContext,
  confirmedInConversation: boolean,
): Promise<boolean> {
  if (!requiresHumanApproval(action) || confirmedInConversation) return true;
  if (!ctx.hasUI || ctx.mode !== "tui") return false;
  const prompt = await approvalPrompt(action, service);
  return ctx.ui.confirm(prompt.title, prompt.message);
}

function serviceCreateInput(
  action: Extract<TandemAction, { readonly action: "create" }>,
): CreateTaskRequest {
  return {
    repoPath: action.repoPath,
    kind: action.kind,
    objective: action.objective,
    ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
    acceptanceCriteria: action.acceptanceCriteria,
    ...(action.manualVerification === undefined
      ? {}
      : { manualVerification: action.manualVerification }),
    surfaces: action.surfaces,
    ...(action.researchTaskIds === undefined ? {} : { researchTaskIds: action.researchTaskIds }),
    ...(action.skills === undefined ? {} : { skills: action.skills }),
    ...(action.playbook === undefined ? {} : { playbook: action.playbook }),
    ...(action.targetRepo === undefined ? {} : { targetRepo: action.targetRepo }),
    ...(action.targetCheckout === undefined ? {} : { targetCheckout: action.targetCheckout }),
    ...(action.targetClone === undefined ? {} : { targetClone: action.targetClone }),
    ...(action.validationCommands === undefined
      ? {}
      : { validationCommands: action.validationCommands }),
  };
}

type TandemActionName = TandemAction["action"];
type TandemActionsByName = { [Action in TandemAction as Action["action"]]: Action };
type TandemActionHandlers = {
  readonly [Name in TandemActionName]: (
    action: TandemActionsByName[Name],
    service: TandemService,
    signal: AbortSignal | undefined,
  ) => Promise<TandemActionResult>;
};

const TANDEM_ACTION_HANDLERS: TandemActionHandlers = {
  restart: async (action, service) =>
    textResult(await service.restart(action.taskId), action.action),
  onboard: async (action, service) =>
    textResult(await service.onboard(action.repoPath, false), action.action),
  setup: async (action, service) =>
    textResult(await service.onboard(action.repoPath, true), action.action, true),
  models: async (action, service) =>
    textResult(await service.models(action.repoPath), action.action),
  "configure-models": async (action, service) =>
    textResult(
      await service.configureModels({
        repoPath: action.repoPath,
        models: action.models,
        ...(action.enabledProviders === undefined
          ? {}
          : { enabledProviders: action.enabledProviders }),
      }),
      action.action,
      true,
    ),
  create: async (action, service) =>
    textResult(await service.create(serviceCreateInput(action)), action.action),
  list: async (action, service) => textResult(await service.list(), action.action),
  presentations: async (action, service) =>
    textResult(await service.presentations(), action.action),
  show: async (action, service) =>
    textResult(await service.get(action.taskId), action.action, undefined, action.detail),
  steer: async (action, service) =>
    textResult(
      await service.steer({
        taskId: action.taskId,
        text: action.text,
        ...(action.supersedes === undefined ? {} : { supersedes: action.supersedes }),
      }),
      action.action,
    ),
  inspect: async (action, service) =>
    textResult(await service.inspect(action.taskId), action.action),
  "delivery-preflight": async (action, service) =>
    textResult(
      await service.deliveryPreflight(action.taskId, { base: action.base }),
      action.action,
    ),
  answer: async (action, service) =>
    textResult(
      await service.answer({
        taskId: action.taskId,
        questionId: action.questionId,
        text: action.text,
      }),
      action.action,
    ),
  messages: async (action, service) =>
    textResult(await service.messages(action.taskId), action.action),
  approve: async (action, service) =>
    textResult(await service.approve(action.taskId), action.action, true),
  "brief-draft": async (action, service) =>
    textResult(
      await service.draftRequestBrief({
        repoPath: action.repoPath,
        content: action.content,
        reviewPane: action.reviewPane,
        ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
      }),
      action.action,
    ),
  "brief-review": async (action, service) =>
    textResult(await service.reviewRequestBrief(action.requestId), action.action),
  "brief-show": async (action, service) =>
    textResult(await service.requestBrief(action.requestId), action.action),
  "request-receipt": async (action, service) =>
    textResult(await service.requestReceipt(action.requestId), action.action),
  "brief-approve": async (action, service) =>
    textResult(
      await service.approveRequestBrief({
        ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
        briefRevision: action.briefRevision,
        contentDigest: action.contentDigest,
      }),
      action.action,
      true,
    ),
  tick: async (action, service) => textResult(await service.tick(), action.action),
  pause: async (action, service) =>
    textResult(await service.pause(action.taskId, action.reason), action.action),
  resume: async (action, service) => textResult(await service.resume(action.taskId), action.action),
  cancel: async (action, service) =>
    textResult(
      await service.cancel(action.taskId, action.reason, { discard: action.discard === true }),
      action.action,
      true,
    ),
  present: async (action, service) =>
    textResult(
      await service.present(action.taskId, {
        objective: action.objective,
        artifacts: action.artifacts,
      }),
      action.action,
    ),
  feedback: async (action, service, signal) =>
    textResult(await service.feedback(action.presentationId, signal), action.action),
  "presentation-open": async (action, service) =>
    textResult(await service.openPresentation(action.presentationId), action.action),
  describe: async (action, service) =>
    textResult(await service.describePr(action.taskId, action.summary), action.action),
  publish: async (action, service) =>
    textResult(
      await service.publish(action.taskId, {
        title: action.title,
        base: action.base,
        summary: action.summary,
        approved: true,
      }),
      action.action,
      true,
    ),
  "publish-now": async (action, service) =>
    textResult(
      await service.publishNow(action.taskId, {
        repository: action.repository,
        title: action.title,
        base: action.base,
        summary: action.summary,
        approved: true,
      }),
      action.action,
      true,
    ),
  draft: async (action, service) =>
    textResult(
      await service.publishDraft(action.taskId, {
        title: action.title,
        base: action.base,
        approved: true,
      }),
      action.action,
      true,
    ),
  merge: async (action, service) =>
    textResult(
      await service.merge(action.taskId, { approved: true, method: action.method }),
      action.action,
      true,
    ),
  cleanup: async (action, service) => {
    const input = action.discard === true ? { discard: true, destructiveApproval: true } : {};
    // One approval covers the batch; a task that can't be cleaned doesn't stop the rest.
    const lines: string[] = [];
    for (const taskId of action.taskIds) {
      try {
        const task = await service.cleanup(taskId, input);
        lines.push(`- ${taskName(task.objective)} (${taskId}): cleaned up`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        lines.push(`- ${taskId}: not cleaned up: ${reason}`);
      }
    }
    return textResult(lines.join("\n"), action.action, action.discard === true ? true : undefined);
  },
  "review-pr": async (action, service) =>
    textResult(
      await service.reviewPr({
        pullRequest: action.pullRequest,
        repoPath: action.repoPath,
        ...(action.lens === undefined ? {} : { lens: reviewLens(action.lens, action.focus) }),
        ...(action.checkout === undefined ? {} : { checkout: action.checkout }),
        ...(action.clone === undefined ? {} : { clone: action.clone }),
      }),
      action.action,
    ),
  "review-show": async (action, service) =>
    textResult(
      await service.reviewShow(
        action.taskId,
        action.page === undefined ? {} : { page: action.page },
      ),
      action.action,
    ),
  "review-notes": async (action, service) =>
    textResult(await service.reviewNotes(action.taskId), action.action),
  "review-edit": async (action, service) =>
    textResult(
      await service.reviewEdit(action.taskId, {
        ...(action.comments === undefined ? {} : { comments: action.comments }),
        ...(action.summaryComment === undefined ? {} : { summaryComment: action.summaryComment }),
      }),
      action.action,
    ),
  "review-post": async (action, service) =>
    textResult(
      await service.reviewPost(action.taskId, { verdict: action.verdict, approved: true }),
      action.action,
      true,
    ),
  "review-again": async (action, service) =>
    textResult(await service.reviewAgain(action.taskId), action.action),
  "review-close": async (action, service) =>
    textResult(await service.reviewClose(action.taskId), action.action),
  "pr-watch": async (action, service) => textResult(await service.prWatch(), action.action),
  "pr-watch-start": async (action, service) =>
    textResult(await service.prWatchStart(pullRequestInput(action)), action.action),
  "pr-watch-stop": async (action, service) =>
    textResult(await service.prWatchStop(pullRequestInput(action)), action.action),
  "pr-watch-merging": async (action, service) =>
    textResult(
      await service.saveMerging({ repoPath: action.repoPath, choice: mergingChoice(action) }),
      action.action,
      true,
    ),
  "pr-watch-fix": async (action, service) =>
    textResult(await service.prWatchFix(pullRequestInput(action)), action.action, true),
};

function mergingChoice(
  action: Extract<TandemAction, { readonly action: "pr-watch-merging" }>,
): MergingChoice {
  if (action.mergeWith !== "queue-label") return { mergeWith: action.mergeWith };
  if (action.queueLabel === undefined) throw new TypeError("queue-label needs queueLabel");
  return {
    mergeWith: "queue-label",
    queueLabel: action.queueLabel,
    ...(action.blockedLabel === undefined ? {} : { blockedLabel: action.blockedLabel }),
  };
}

function pullRequestInput(
  action: Extract<
    TandemAction,
    { readonly action: "pr-watch-start" | "pr-watch-stop" | "pr-watch-fix" }
  >,
): PullRequestInput {
  return {
    pullRequest: action.pullRequest,
    ...(action.repoPath === undefined ? {} : { repoPath: action.repoPath }),
  };
}

function runTandemAction<Name extends TandemActionName>(
  name: Name,
  action: TandemActionsByName[Name],
  service: TandemService,
  signal: AbortSignal | undefined,
): Promise<TandemActionResult> {
  return TANDEM_ACTION_HANDLERS[name](action, service, signal);
}

/**
 * `confirmedInConversation` is set only when the person already typed an exact "y" to a code-written
 * confirmation of this same action, which stands in for the approval dialog.
 */
export async function executeTandemAction(
  action: TandemAction,
  service: TandemService,
  ctx: ExtensionContext,
  options: Readonly<{
    readonly signal?: AbortSignal | undefined;
    readonly confirmedInConversation?: boolean;
  }> = {},
): Promise<TandemActionResult> {
  const { signal, confirmedInConversation = false } = options;
  const approved = await confirmAction(action, service, ctx, confirmedInConversation);
  if (!approved)
    return textResult(
      "Action refused: interactive human approval is required.",
      action.action,
      false,
    );
  return runTandemAction(action.action, action, service, signal);
}

const VERDICT_LABELS: Readonly<Record<ReviewVerdict, string>> = {
  comment: "Comment only",
  approve: "Approve",
  "request-changes": "Request changes",
};

/** A focus lens without the user's words falls back to a full review rather than guessing. */
export function reviewLens(
  kind: "full" | "intent" | "focus",
  focus: string | undefined,
): ReviewLens {
  if (kind === "focus" && focus !== undefined && focus.trim().length > 0) {
    return { kind: "focus", focus: focus.trim() };
  }
  return kind === "intent" ? { kind: "intent" } : { kind: "full" };
}

function parseShellWords(input: string): readonly string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of input.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
    } else current += character;
  }
  if (escaped || quote !== undefined) throw new TypeError("unterminated Tandem command quote");
  if (current.length > 0) words.push(current);
  return words;
}

function requireCommandValue(words: readonly string[], index: number, field: string): string {
  const value = words[index];
  if (value === undefined || value.length === 0)
    throw new TypeError(`tandem ${field} requires a value`);
  return value;
}

function parseSummaryJson(value: string): PrSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(
      `summary must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("summary must be an object");
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "tldr" && key !== "what" && key !== "why")
      throw new TypeError(`summary contains unknown key ${JSON.stringify(key)}`);
  }
  const readList = (field: string): readonly string[] => {
    const candidate = record[field];
    if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== "string"))
      throw new TypeError(`summary.${field} must be an array of strings`);
    return candidate;
  };
  return { tldr: readList("tldr"), what: readList("what"), why: readList("why") };
}

type CommandArity = Readonly<{ readonly min: number; readonly max: number }>;
type CommandValue = (index: number, field: string) => string;
type TandemCommandParser = Readonly<{
  /** Word count bounds including the command itself; commands without one check their own words. */
  readonly arity?: CommandArity;
  readonly parse: (words: readonly string[], value: CommandValue) => TandemAction;
}>;

function ensureCommandArity(command: string, words: readonly string[], arity: CommandArity): void {
  if (words.length < arity.min || words.length > arity.max) {
    const maximum = Number.isFinite(arity.max) ? ` at most ${arity.max}` : "";
    throw new TypeError(
      `tandem ${command} expects${maximum} argument(s); received ${words.length - 1}`,
    );
  }
}

function commaList(value: string): readonly string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function briefRevisionNumber(value: string): number {
  const briefRevision = Number(value);
  if (!Number.isSafeInteger(briefRevision) || briefRevision < 1) {
    throw new TypeError("brief-approve revision must be a positive integer");
  }
  return briefRevision;
}

const listParser: TandemCommandParser = {
  arity: { min: 1, max: 1 },
  parse: () => ({ action: "list" }),
};

const describeParser: TandemCommandParser = {
  arity: { min: 3, max: 3 },
  parse: (_words, value) => ({
    action: "describe",
    taskId: value(1, "describe"),
    summary: parseSummaryJson(value(2, "describe summary")),
  }),
};

const publishParser: TandemCommandParser = {
  arity: { min: 5, max: 5 },
  parse: (_words, value) => ({
    action: "publish",
    taskId: value(1, "publish"),
    title: value(2, "publish title"),
    base: value(3, "publish base"),
    summary: parseSummaryJson(value(4, "publish summary")),
  }),
};

const draftParser: TandemCommandParser = {
  arity: { min: 4, max: 4 },
  parse: (_words, value) => ({
    action: "draft",
    taskId: value(1, "draft"),
    title: value(2, "draft title"),
    base: value(3, "draft base"),
  }),
};

const mergeParser: TandemCommandParser = {
  arity: { min: 3, max: 3 },
  parse: (_words, value) => {
    const method = value(2, "merge method");
    if (method !== "merge" && method !== "squash" && method !== "rebase")
      throw new TypeError(`unsupported merge method ${method}`);
    return { action: "merge", taskId: value(1, "merge"), method };
  },
};

/** `/tandem watch` shows the view, `watch PR` watches it, and `watch --stop PR` stops. */
const watchParser: TandemCommandParser = {
  arity: { min: 1, max: 3 },
  parse: (words, value) => {
    if (words.length === 1) return { action: "pr-watch" };
    const stop = words[1] === "--stop";
    if (words.length !== (stop ? 3 : 2)) {
      throw new TypeError("watch takes a pull request, or --stop and a pull request");
    }
    return {
      action: stop ? "pr-watch-stop" : "pr-watch-start",
      pullRequest: value(stop ? 2 : 1, "watch pull request"),
    };
  },
};

const TANDEM_COMMAND_PARSERS: Readonly<Record<string, TandemCommandParser>> = {
  restart: {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "restart", taskId: value(1, "restart") }),
  },
  list: listParser,
  status: listParser,
  onboard: {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "onboard", repoPath: value(1, "onboard") }),
  },
  setup: {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "setup", repoPath: value(1, "setup") }),
  },
  models: {
    arity: { min: 1, max: 2 },
    parse: (words) => ({ action: "models", repoPath: words[1] ?? "." }),
  },
  create: {
    arity: { min: 6, max: 7 },
    parse: (words, value) => {
      const kind = value(2, "create kind");
      if (kind !== "scout" && kind !== "implementation")
        throw new TypeError(`unsupported task kind ${kind}`);
      const acceptanceCriteria = commaList(value(4, "create acceptance criteria"));
      const surfaces = commaList(value(5, "create surfaces"));
      if (acceptanceCriteria.length === 0)
        throw new TypeError("create requires at least one acceptance criterion");
      if (surfaces.length === 0) throw new TypeError("create requires at least one surface");
      const researchTaskIds = words[6] === undefined ? undefined : commaList(words[6]);
      return {
        action: "create",
        repoPath: value(1, "create"),
        kind,
        objective: value(3, "create objective"),
        acceptanceCriteria,
        surfaces,
        ...(researchTaskIds === undefined ? {} : { researchTaskIds }),
      };
    },
  },
  show: {
    parse: (words, value) => {
      if (words[2] !== undefined && words[2] !== "--full")
        throw new TypeError("show accepts only --full as its optional flag");
      return {
        action: "show",
        taskId: value(1, "show"),
        ...(words[2] === "--full" ? { detail: "full" as const } : {}),
      };
    },
  },
  steer: {
    parse: (words, value) => ({
      action: "steer",
      taskId: value(1, "steer"),
      text: words.slice(2).join(" "),
    }),
  },
  answer: {
    parse: (words, value) => ({
      action: "answer",
      taskId: value(1, "answer"),
      questionId: value(2, "answer questionId"),
      text: words.slice(3).join(" "),
    }),
  },
  messages: {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "messages", taskId: value(1, "messages") }),
  },
  inspect: {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "inspect", taskId: value(1, "inspect") }),
  },
  "delivery-preflight": {
    arity: { min: 3, max: 3 },
    parse: (_words, value) => ({
      action: "delivery-preflight",
      taskId: value(1, "delivery-preflight"),
      base: value(2, "delivery-preflight base"),
    }),
  },
  approve: {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "approve", taskId: value(1, "approve") }),
  },
  "brief-show": {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "brief-show", requestId: value(1, "brief-show") }),
  },
  "request-receipt": {
    arity: { min: 1, max: 2 },
    // Without an id, the receipt is for the request in progress.
    parse: (words, value) =>
      words.length > 1
        ? { action: "request-receipt", requestId: value(1, "request-receipt") }
        : { action: "request-receipt" },
  },
  "brief-review": {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "brief-review", requestId: value(1, "brief-review") }),
  },
  "brief-approve": {
    arity: { min: 3, max: 4 },
    // Three words (revision, digest) resolves to the one request awaiting approval; four words
    // (requestId, revision, digest) names it explicitly.
    parse: (words, value) => {
      if (words.length === 3) {
        return {
          action: "brief-approve",
          briefRevision: briefRevisionNumber(value(1, "brief-approve revision")),
          contentDigest: value(2, "brief-approve content digest"),
        };
      }
      const briefRevision = briefRevisionNumber(value(2, "brief-approve revision"));
      return {
        action: "brief-approve",
        requestId: value(1, "brief-approve"),
        briefRevision,
        contentDigest: value(3, "brief-approve content digest"),
      };
    },
  },
  tick: { arity: { min: 1, max: 1 }, parse: () => ({ action: "tick" }) },
  pause: {
    arity: { min: 2, max: Number.POSITIVE_INFINITY },
    parse: (words, value) => ({
      action: "pause",
      taskId: value(1, "pause"),
      ...(words[2] === undefined ? {} : { reason: words.slice(2).join(" ") }),
    }),
  },
  resume: {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "resume", taskId: value(1, "resume") }),
  },
  cancel: {
    arity: { min: 2, max: Number.POSITIVE_INFINITY },
    parse: (words, value) => ({
      action: "cancel",
      taskId: value(1, "cancel"),
      ...(words[2] === undefined ? {} : { reason: words.slice(2).join(" ") }),
    }),
  },
  presentations: { arity: { min: 1, max: 1 }, parse: () => ({ action: "presentations" }) },
  feedback: {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({ action: "feedback", presentationId: value(1, "feedback") }),
  },
  "presentation-open": {
    arity: { min: 2, max: 2 },
    parse: (_words, value) => ({
      action: "presentation-open",
      presentationId: value(1, "presentation-open"),
    }),
  },
  present: {
    arity: { min: 4, max: 4 },
    parse: (_words, value) => ({
      action: "present",
      taskId: value(1, "present"),
      objective: value(2, "present objective"),
      artifacts: commaList(value(3, "present artifacts")),
    }),
  },
  describe: describeParser,
  "pr-describe": describeParser,
  publish: publishParser,
  "pr-publish": publishParser,
  draft: draftParser,
  "pr-draft": draftParser,
  merge: mergeParser,
  "pr-merge": mergeParser,
  watch: watchParser,
  cleanup: {
    arity: { min: 2, max: Number.POSITIVE_INFINITY },
    parse: (words) => {
      const discard = words.at(-1) === "--discard";
      const taskIds = words.slice(1, discard ? -1 : undefined);
      if (taskIds.length === 0 || taskIds.some((taskId) => taskId.startsWith("--")))
        throw new TypeError("cleanup takes task ids and only --discard as its optional flag");
      return { action: "cleanup", taskIds, ...(discard ? { discard: true } : {}) };
    },
  },
};

/** Parse the human-facing `/tandem ...` command without shell execution. */
export function parseTandemCommand(input: string): TandemAction {
  const words = parseShellWords(input);
  const command = words[0] ?? "list";
  const parser = Object.hasOwn(TANDEM_COMMAND_PARSERS, command)
    ? TANDEM_COMMAND_PARSERS[command]
    : undefined;
  if (parser === undefined) throw new TypeError(`unknown Tandem command ${command}`);
  if (parser.arity !== undefined) ensureCommandArity(command, words, parser.arity);
  return parser.parse(words, (index, field) => requireCommandValue(words, index, field));
}
