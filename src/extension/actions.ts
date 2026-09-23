import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RepoPolicy, RequestBriefContent, SkillInvocation, TaskKind } from "../contracts.ts";
import type { PrSummary } from "../delivery/evidence.ts";
import type { CreateTaskRequest, TandemService } from "../service/controller.ts";
import { activeTaskMessages } from "../tasks/communication-protocol.ts";
import { taskName } from "../tasks/question.ts";
import { projectName, summarizeModelAssignments } from "./summary.ts";

const TANDEM_COMMAND_ARITY: Readonly<
  Record<string, Readonly<{ readonly min: number; readonly max: number }>>
> = {
  list: { min: 1, max: 1 },
  restart: { min: 2, max: 2 },
  status: { min: 1, max: 1 },
  presentations: { min: 1, max: 1 },
  onboard: { min: 2, max: 2 },
  setup: { min: 2, max: 2 },
  models: { min: 1, max: 2 },
  create: { min: 6, max: 7 },
  approve: { min: 2, max: 2 },
  tick: { min: 1, max: 1 },
  pause: { min: 2, max: Number.POSITIVE_INFINITY },
  resume: { min: 2, max: 2 },
  cancel: { min: 2, max: Number.POSITIVE_INFINITY },
  feedback: { min: 2, max: 2 },
  present: { min: 4, max: 4 },
  describe: { min: 3, max: 3 },
  "pr-describe": { min: 3, max: 3 },
  publish: { min: 6, max: 6 },
  "pr-publish": { min: 6, max: 6 },
  draft: { min: 5, max: 5 },
  "pr-draft": { min: 5, max: 5 },
  merge: { min: 3, max: 3 },
  "pr-merge": { min: 3, max: 3 },
  cleanup: { min: 2, max: 3 },
  messages: { min: 2, max: 2 },
  inspect: { min: 2, max: 2 },
  "recovery-plan": { min: 2, max: 2 },
  "recovery-decide": { min: 2, max: 2 },
  reconcile: { min: 2, max: 2 },
  "brief-show": { min: 2, max: 2 },
  "brief-review": { min: 2, max: 2 },
  "brief-approve": { min: 3, max: 4 },
  "request-receipt": { min: 2, max: 2 },
  "review-existing": { min: 3, max: 3 },
  "validation-retry": { min: 2, max: 2 },
  "evidence-repair": { min: 2, max: 2 },
  "delivery-preflight": { min: 4, max: 4 },
};
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
      readonly kind: TaskKind;
      readonly objective: string;
      readonly acceptanceCriteria: readonly string[];
      readonly surfaces: readonly string[];
      readonly researchTaskIds?: readonly string[] | undefined;
      /** An explicit user-invoked skill to pin to this task, opaque to Tandem. */
      readonly skill?: SkillInvocation | undefined;
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
  | Readonly<{ readonly action: "recovery-plan"; readonly taskId: string }>
  | Readonly<{ readonly action: "recovery-decide"; readonly taskId: string }>
  | Readonly<{ readonly action: "reconcile"; readonly taskId: string }>
  | Readonly<{
      readonly action: "review-existing";
      readonly taskId: string;
      readonly head: string;
    }>
  | Readonly<{ readonly action: "validation-retry"; readonly taskId: string }>
  | Readonly<{ readonly action: "evidence-repair"; readonly taskId: string }>
  | Readonly<{
      readonly action: "delivery-preflight";
      readonly taskId: string;
      readonly repository: string;
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
  | Readonly<{ readonly action: "request-receipt"; readonly requestId: string }>
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
    }>
  | Readonly<{
      readonly action: "present";
      readonly taskId: string;
      readonly objective: string;
      readonly artifacts: readonly string[];
    }>
  | Readonly<{ readonly action: "feedback"; readonly presentationId: string }>
  | Readonly<{ readonly action: "describe"; readonly taskId: string; readonly summary: PrSummary }>
  | Readonly<{
      readonly action: "publish";
      readonly taskId: string;
      readonly repository: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
    }>
  | Readonly<{
      readonly action: "draft";
      readonly taskId: string;
      readonly repository: string;
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
      readonly taskId: string;
      readonly discard?: boolean | undefined;
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
    action.action === "draft" ||
    action.action === "merge" ||
    action.action === "reconcile" ||
    action.action === "recovery-decide" ||
    action.action === "review-existing" ||
    action.action === "validation-retry" ||
    action.action === "evidence-repair"
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
      return { title: `Stop ${name}?`, message: "Its work and reports are kept." };
    case "publish":
      return {
        title: `Open a PR for ${name}?`,
        message: `Into ${action.base}. Nothing is merged.`,
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
    case "recovery-decide":
      return {
        title: `Fix ${name}?`,
        message: "I'll use a fix you've already allowed, or ask you. Nothing gets published.",
      };
    case "reconcile":
      return { title: `Clean up leftovers from ${name}?`, message: "Its work is kept." };
    case "review-existing":
      return { title: `Review ${name} as it stands?`, message: "" };
    case "validation-retry":
      return { title: `Rerun checks for ${name}?`, message: "" };
    case "evidence-repair":
      return { title: `Rebuild the reports for ${name}?`, message: "" };
    case "cleanup":
      return { title: `Delete the worktree for ${name}?`, message: "This discards its changes." };
    default:
      return { title: "Allow this Tandem action?", message: "" };
  }
}

async function confirmAction(
  action: TandemAction,
  service: TandemService,
  ctx: ExtensionContext,
): Promise<boolean> {
  if (!requiresHumanApproval(action)) return true;
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
    acceptanceCriteria: action.acceptanceCriteria,
    surfaces: action.surfaces,
    ...(action.researchTaskIds === undefined ? {} : { researchTaskIds: action.researchTaskIds }),
    ...(action.skill === undefined ? {} : { skill: action.skill }),
  };
}

export async function executeTandemAction(
  action: TandemAction,
  service: TandemService,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<TandemActionResult> {
  const approved = await confirmAction(action, service, ctx);
  if (!approved)
    return textResult(
      "Action refused: interactive human approval is required.",
      action.action,
      false,
    );

  switch (action.action) {
    case "restart":
      return textResult(await service.restart(action.taskId), action.action);
    case "onboard":
      return textResult(await service.onboard(action.repoPath, false), action.action);
    case "setup":
      return textResult(await service.onboard(action.repoPath, true), action.action, true);
    case "models":
      return textResult(await service.models(action.repoPath), action.action);
    case "configure-models":
      return textResult(
        await service.configureModels({
          repoPath: action.repoPath,
          models: action.models,
          ...(action.enabledProviders === undefined
            ? {}
            : { enabledProviders: action.enabledProviders }),
        }),
        action.action,
        true,
      );
    case "create":
      return textResult(await service.create(serviceCreateInput(action)), action.action);
    case "list":
      return textResult(await service.list(), action.action);
    case "presentations":
      return textResult(await service.presentations(), action.action);
    case "show":
      return textResult(await service.get(action.taskId), action.action, undefined, action.detail);
    case "steer":
      return textResult(
        await service.steer({
          taskId: action.taskId,
          text: action.text,
          ...(action.supersedes === undefined ? {} : { supersedes: action.supersedes }),
        }),
        action.action,
      );
    case "inspect":
      return textResult(await service.inspect(action.taskId), action.action);
    case "recovery-plan":
      return textResult(await service.recoveryPlan(action.taskId), action.action);
    case "recovery-decide":
      return textResult(await service.recoveryDecide(action.taskId), action.action, true);
    case "reconcile":
      return textResult(
        await service.reconcile(action.taskId, { approved: true }),
        action.action,
        true,
      );
    case "review-existing":
      return textResult(
        await service.reviewExisting(action.taskId, { head: action.head, approved: true }),
        action.action,
        true,
      );
    case "validation-retry":
      return textResult(
        await service.validationRetry(action.taskId, { approved: true }),
        action.action,
        true,
      );
    case "evidence-repair":
      return textResult(
        await service.repairEvidence(action.taskId, { approved: true }),
        action.action,
        true,
      );
    case "delivery-preflight":
      return textResult(
        await service.deliveryPreflight(action.taskId, {
          repository: action.repository,
          base: action.base,
        }),
        action.action,
      );
    case "answer":
      return textResult(
        await service.answer({
          taskId: action.taskId,
          questionId: action.questionId,
          text: action.text,
        }),
        action.action,
      );
    case "messages":
      return textResult(await service.messages(action.taskId), action.action);
    case "approve":
      return textResult(await service.approve(action.taskId), action.action, true);
    case "brief-draft":
      return textResult(
        await service.draftRequestBrief({
          repoPath: action.repoPath,
          content: action.content,
          reviewPane: action.reviewPane,
          ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
        }),
        action.action,
      );
    case "brief-review":
      return textResult(await service.reviewRequestBrief(action.requestId), action.action);
    case "brief-show":
      return textResult(await service.requestBrief(action.requestId), action.action);
    case "request-receipt":
      return textResult(await service.requestReceipt(action.requestId), action.action);
    case "brief-approve":
      return textResult(
        await service.approveRequestBrief({
          ...(action.requestId === undefined ? {} : { requestId: action.requestId }),
          briefRevision: action.briefRevision,
          contentDigest: action.contentDigest,
        }),
        action.action,
        true,
      );
    case "tick":
      return textResult(await service.tick(), action.action);
    case "pause":
      return textResult(await service.pause(action.taskId, action.reason), action.action);
    case "resume":
      return textResult(await service.resume(action.taskId), action.action);
    case "cancel":
      return textResult(await service.cancel(action.taskId, action.reason), action.action, true);
    case "present":
      return textResult(
        await service.present(action.taskId, {
          objective: action.objective,
          artifacts: action.artifacts,
        }),
        action.action,
      );
    case "feedback":
      return textResult(await service.feedback(action.presentationId, signal), action.action);
    case "describe":
      return textResult(await service.describePr(action.taskId, action.summary), action.action);
    case "publish":
      return textResult(
        await service.publish(action.taskId, {
          repository: action.repository,
          title: action.title,
          base: action.base,
          summary: action.summary,
          approved: true,
        }),
        action.action,
        true,
      );
    case "draft":
      return textResult(
        await service.publishDraft(action.taskId, {
          repository: action.repository,
          title: action.title,
          base: action.base,
          approved: true,
        }),
        action.action,
        true,
      );
    case "merge":
      return textResult(
        await service.merge(action.taskId, { approved: true, method: action.method }),
        action.action,
        true,
      );
    case "cleanup": {
      const input = action.discard === true ? { discard: true, destructiveApproval: true } : {};
      return textResult(
        await service.cleanup(action.taskId, input),
        action.action,
        action.discard === true ? true : undefined,
      );
    }
  }
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

function ensureCommandArity(command: string, words: readonly string[]): void {
  const arity = TANDEM_COMMAND_ARITY[command];
  if (arity === undefined) return;
  if (words.length < arity.min || words.length > arity.max) {
    const maximum = Number.isFinite(arity.max) ? ` at most ${arity.max}` : "";
    throw new TypeError(
      `tandem ${command} expects${maximum} argument(s); received ${words.length - 1}`,
    );
  }
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

/** Parse the human-facing `/tandem ...` command without shell execution. */
export function parseTandemCommand(input: string): TandemAction {
  const words = parseShellWords(input);
  const command = words[0] ?? "list";
  ensureCommandArity(command, words);
  const value = (index: number, field: string): string => requireCommandValue(words, index, field);
  switch (command) {
    case "restart":
      return { action: "restart", taskId: value(1, "restart") };
    case "list":
    case "status":
      return { action: "list" };
    case "onboard":
      return { action: "onboard", repoPath: value(1, "onboard") };
    case "setup":
      return { action: "setup", repoPath: value(1, "setup") };
    case "models":
      return { action: "models", repoPath: words[1] ?? "." };
    case "create": {
      const kind = value(2, "create kind");
      if (kind !== "scout" && kind !== "implementation")
        throw new TypeError(`unsupported task kind ${kind}`);
      const acceptanceCriteria = value(4, "create acceptance criteria")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const surfaces = value(5, "create surfaces")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (acceptanceCriteria.length === 0)
        throw new TypeError("create requires at least one acceptance criterion");
      if (surfaces.length === 0) throw new TypeError("create requires at least one surface");
      const researchTaskIds =
        words[6] === undefined
          ? undefined
          : words[6]
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0);
      return {
        action: "create",
        repoPath: value(1, "create"),
        kind,
        objective: value(3, "create objective"),
        acceptanceCriteria,
        surfaces,
        ...(researchTaskIds === undefined ? {} : { researchTaskIds }),
      };
    }
    case "show":
      if (words[2] !== undefined && words[2] !== "--full")
        throw new TypeError("show accepts only --full as its optional flag");
      return {
        action: "show",
        taskId: value(1, "show"),
        ...(words[2] === "--full" ? { detail: "full" as const } : {}),
      };
    case "steer":
      return {
        action: "steer",
        taskId: value(1, "steer"),
        text: words.slice(2).join(" "),
      };
    case "answer":
      return {
        action: "answer",
        taskId: value(1, "answer"),
        questionId: value(2, "answer questionId"),
        text: words.slice(3).join(" "),
      };
    case "messages":
      return { action: "messages", taskId: value(1, "messages") };
    case "inspect":
      return { action: "inspect", taskId: value(1, "inspect") };
    case "recovery-plan":
      return { action: "recovery-plan", taskId: value(1, "recovery-plan") };
    case "recovery-decide":
      return { action: "recovery-decide", taskId: value(1, "recovery-decide") };
    case "reconcile":
      return { action: "reconcile", taskId: value(1, "reconcile") };
    case "review-existing":
      return {
        action: "review-existing",
        taskId: value(1, "review-existing"),
        head: value(2, "review-existing head"),
      };
    case "validation-retry":
      return { action: "validation-retry", taskId: value(1, "validation-retry") };
    case "evidence-repair":
      return { action: "evidence-repair", taskId: value(1, "evidence-repair") };
    case "delivery-preflight":
      return {
        action: "delivery-preflight",
        taskId: value(1, "delivery-preflight"),
        repository: value(2, "delivery-preflight repository"),
        base: value(3, "delivery-preflight base"),
      };
    case "approve":
      return { action: "approve", taskId: value(1, "approve") };
    case "brief-show":
      return { action: "brief-show", requestId: value(1, "brief-show") };
    case "request-receipt":
      return { action: "request-receipt", requestId: value(1, "request-receipt") };
    case "brief-review":
      return { action: "brief-review", requestId: value(1, "brief-review") };
    case "brief-approve": {
      // Three words (revision, digest) resolves to the one request awaiting approval; four words
      // (requestId, revision, digest) names it explicitly.
      if (words.length === 3) {
        const briefRevision = Number(value(1, "brief-approve revision"));
        if (!Number.isSafeInteger(briefRevision) || briefRevision < 1) {
          throw new TypeError("brief-approve revision must be a positive integer");
        }
        return {
          action: "brief-approve",
          briefRevision,
          contentDigest: value(2, "brief-approve content digest"),
        };
      }
      const briefRevision = Number(value(2, "brief-approve revision"));
      if (!Number.isSafeInteger(briefRevision) || briefRevision < 1) {
        throw new TypeError("brief-approve revision must be a positive integer");
      }
      return {
        action: "brief-approve",
        requestId: value(1, "brief-approve"),
        briefRevision,
        contentDigest: value(3, "brief-approve content digest"),
      };
    }
    case "tick":
      return { action: "tick" };
    case "pause":
      return {
        action: "pause",
        taskId: value(1, "pause"),
        ...(words[2] === undefined ? {} : { reason: words.slice(2).join(" ") }),
      };
    case "resume":
      return { action: "resume", taskId: value(1, "resume") };
    case "cancel":
      return {
        action: "cancel",
        taskId: value(1, "cancel"),
        ...(words[2] === undefined ? {} : { reason: words.slice(2).join(" ") }),
      };
    case "presentations":
      return { action: "presentations" };
    case "feedback":
      return { action: "feedback", presentationId: value(1, "feedback") };
    case "present":
      return {
        action: "present",
        taskId: value(1, "present"),
        objective: value(2, "present objective"),
        artifacts: value(3, "present artifacts")
          .split(",")
          .map((artifact) => artifact.trim())
          .filter((artifact) => artifact.length > 0),
      };
    case "describe":
    case "pr-describe":
      return {
        action: "describe",
        taskId: value(1, "describe"),
        summary: parseSummaryJson(value(2, "describe summary")),
      };
    case "publish":
    case "pr-publish":
      return {
        action: "publish",
        taskId: value(1, "publish"),
        repository: value(2, "publish repository"),
        title: value(3, "publish title"),
        base: value(4, "publish base"),
        summary: parseSummaryJson(value(5, "publish summary")),
      };
    case "draft":
    case "pr-draft":
      return {
        action: "draft",
        taskId: value(1, "draft"),
        repository: value(2, "draft repository"),
        title: value(3, "draft title"),
        base: value(4, "draft base"),
      };
    case "merge":
    case "pr-merge": {
      const method = value(2, "merge method");
      if (method !== "merge" && method !== "squash" && method !== "rebase")
        throw new TypeError(`unsupported merge method ${method}`);
      return { action: "merge", taskId: value(1, "merge"), method };
    }
    case "cleanup":
      if (words[2] !== undefined && words[2] !== "--discard")
        throw new TypeError("cleanup accepts only --discard as its optional flag");
      return {
        action: "cleanup",
        taskId: value(1, "cleanup"),
        ...(words[2] === "--discard" ? { discard: true } : {}),
      };
    default:
      throw new TypeError(`unknown Tandem command ${command}`);
  }
}
