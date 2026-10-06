import type { TaskRecord } from "../contracts.ts";
import { findRunningCoordinator } from "../coordinator/ownership.ts";
import type { CoordinatorRecord } from "../coordinator/record.ts";
import { canonicalPath } from "../coordinator/record.ts";
import { discoverCoordinatorRecords } from "../coordinator/registry.ts";
import { parseReviewSubmission } from "../pr-review/page.ts";
import { type BriefFeedback, briefFeedbackPrompt, type ViewedBrief } from "../requests/feedback.ts";
import type { TerminalView } from "../terminal-backend/contract.ts";
import { CliUsageError, positiveInteger, text } from "./cli-arguments.ts";
import type { CliCommandContext, CliCommandOutcome } from "./cli-commands.ts";
import { jsonObjectFromFile, taskIdFor } from "./cli-input.ts";
import { viewOriginFrom } from "./cli-view-context.ts";

function exactKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new CliUsageError(`input contains unknown field ${key}`);
  }
}

function revision(value: unknown, field: string): number {
  if (typeof value !== "number") throw new CliUsageError(`${field} must be a positive integer`);
  return positiveInteger(String(value), field);
}

function viewedBrief(requestId: string, input: Readonly<Record<string, unknown>>): ViewedBrief {
  return {
    requestId,
    briefRevision: revision(input.briefRevision, "briefRevision"),
    contentDigest: text(input.contentDigest, "contentDigest"),
    agreementDigest: text(input.agreementDigest, "agreementDigest"),
  };
}

function briefFeedback(requestId: string, input: Readonly<Record<string, unknown>>): BriefFeedback {
  exactKeys(input, ["briefRevision", "contentDigest", "agreementDigest", "text", "comments"]);
  if (input.comments !== undefined && !Array.isArray(input.comments)) {
    throw new CliUsageError("comments must be an array");
  }
  const entries: readonly unknown[] = Array.isArray(input.comments) ? input.comments : [];
  if (entries.length > 100) throw new CliUsageError("Brief feedback may have at most 100 comments");
  const comments = entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CliUsageError("Each comment must contain lineId and text");
    }
    const comment = entry as Record<string, unknown>;
    exactKeys(comment, ["lineId", "text"]);
    if (typeof comment.lineId !== "string" || comment.lineId.length === 0)
      throw new CliUsageError("lineId must be a nonempty string");
    return { lineId: comment.lineId, text: text(comment.text, "comment text") };
  });
  const feedback: BriefFeedback = {
    ...viewedBrief(requestId, input),
    comments,
    ...(input.text === undefined ? {} : { text: text(input.text, "text") }),
  };
  if (Buffer.byteLength(JSON.stringify(feedback), "utf8") > 64_000) {
    throw new CliUsageError("Brief feedback may not exceed 64000 bytes");
  }
  return feedback;
}

async function coordinator(
  context: CliCommandContext,
  repoPath: string,
): Promise<CoordinatorRecord> {
  const canonical = await canonicalPath(repoPath, "repoPath");
  const discovery = await discoverCoordinatorRecords({ home: context.environment.home });
  const candidates = discovery.records
    .filter((entry) => entry.placement === "session-directory")
    .map((entry) => entry.record)
    .filter(
      (record) =>
        record.endpoint.sessionId === context.environment.sessionId &&
        (record.repoPath === canonical || record.worktree.path === canonical),
    );
  if (candidates.length > 1) throw new Error("More than one coordinator claims this project");
  const originalRepo = candidates[0]?.repoPath ?? canonical;
  const owned = await findRunningCoordinator(
    context.capabilities.run,
    context.capabilities.terminal,
    {
      home: context.environment.home,
      sessionId: context.environment.sessionId,
      repoPath: originalRepo,
    },
  );
  if (owned === undefined)
    throw new Error("Open this project's coordinator before using this action");
  return owned;
}

async function promptCoordinator(
  context: CliCommandContext,
  owned: CoordinatorRecord,
  message: string,
): Promise<void> {
  // Repeat process/endpoint proof immediately before sending user input. Never fall back to an
  // unverified inherited pane or a title when the recorded coordinator stopped in the meantime.
  const current = await coordinator(context, owned.repoPath);
  if (
    JSON.stringify(current.endpoint) !== JSON.stringify(owned.endpoint) ||
    current.worktree.leaseId !== owned.worktree.leaseId
  ) {
    throw new Error("The coordinator changed before feedback could be delivered; retry the action");
  }
  await context.capabilities.terminal.promptAgent({
    sessionId: current.endpoint.sessionId,
    cwd: current.worktree.path,
    paneId: current.endpoint.paneId,
    text: message,
  });
}

export async function commentOnBrief(
  context: CliCommandContext,
  requestChanges: boolean,
): Promise<CliCommandOutcome> {
  const requestId = text(context.invocation.positionals[0], "requestId");
  const input = await jsonObjectFromFile(
    context.capabilities.statPath,
    context.invocation.options.input,
    context.invocation.command,
  );
  const feedback = briefFeedback(requestId, input);
  const service = context.service();
  const brief = await service.requestBrief(requestId);
  await requireBriefProject(context, brief.record.repoPath);
  const prompt = briefFeedbackPrompt(brief.record, feedback, requestChanges);
  const owned = await coordinator(context, brief.record.repoPath);
  await promptCoordinator(context, owned, prompt);
  let view = brief;
  const warnings: string[] = [];
  if (requestChanges) {
    try {
      view = await service.closeRequestBriefReview(requestId, feedback.briefRevision);
    } catch (error) {
      warnings.push(
        `Feedback was delivered, but the review pane could not be retired: ${error instanceof Error ? error.message : String(error)}. Do not resubmit this feedback.`,
      );
    }
  }
  return {
    value: {
      delivered: true,
      requestId,
      briefRevision: feedback.briefRevision,
      reviewPane: view.record.reviewPane,
      warnings,
    },
  };
}

async function requireBriefProject(
  context: CliCommandContext,
  briefRepoPath: string,
): Promise<void> {
  const [briefRepo, selectedRepo] = await Promise.all([
    canonicalPath(briefRepoPath, "brief repoPath"),
    canonicalPath(context.environment.repo, "selected repoPath"),
  ]);
  if (briefRepo !== selectedRepo) {
    throw new CliUsageError("This brief does not belong to the selected Tandem project");
  }
}

export async function approveViewedBrief(context: CliCommandContext): Promise<CliCommandOutcome> {
  const requestId = text(context.invocation.positionals[0], "requestId");
  const input = await jsonObjectFromFile(
    context.capabilities.statPath,
    context.invocation.options.input,
    context.invocation.command,
  );
  exactKeys(input, ["briefRevision", "contentDigest", "agreementDigest"]);
  const intent = viewedBrief(requestId, input);
  const service = context.service();
  const before = await service.requestBrief(requestId);
  await requireBriefProject(context, before.record.repoPath);
  const owned = await coordinator(context, before.record.repoPath);
  // The durable compare-and-swap checks all seen fields. The action itself is the user's click.
  const view = await service.approveRequestBrief(intent);
  const warnings: string[] = [];
  try {
    await promptCoordinator(
      context,
      owned,
      `From the open review page:\nThe user approved brief ${requestId}, revision ${intent.briefRevision}. Approval is already recorded for the displayed content and agreement. Continue the conversation under that approval.`,
    );
  } catch (error) {
    warnings.push(
      `Approval was recorded, but the coordinator could not be notified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { value: { ...view, warnings }, approved: true };
}

function requireOwnPr(task: TaskRecord): void {
  if (
    task.kind !== "implementation" ||
    task.pullRequest === undefined ||
    !["draft", "open"].includes(task.pullRequest.state)
  ) {
    throw new CliUsageError(
      "This action requires an implementation task with an open Tandem pull request",
    );
  }
}

export async function commentOnPr(context: CliCommandContext): Promise<CliCommandOutcome> {
  const taskId = taskIdFor(context.invocation);
  const invocation = context.invocation;
  let message: string;
  if (invocation.options.input === undefined) message = text(invocation.options.text, "text");
  else {
    if (invocation.options.text !== undefined)
      throw new CliUsageError("Provide --text or --input, not both");
    const input = await jsonObjectFromFile(
      context.capabilities.statPath,
      invocation.options.input,
      invocation.command,
    );
    exactKeys(input, ["text", "comments"]);
    if (input.comments !== undefined && !Array.isArray(input.comments))
      throw new CliUsageError("comments must be an array");
    const entries: readonly unknown[] = Array.isArray(input.comments) ? input.comments : [];
    const notes = entries.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        throw new CliUsageError("Each comment must contain file, line, and text");
      const comment = entry as Record<string, unknown>;
      exactKeys(comment, ["file", "line", "text"]);
      return `${text(comment.file, "file")}:${revision(comment.line, "line")}: ${text(comment.text, "comment text")}`;
    });
    if (input.text !== undefined) notes.push(text(input.text, "text"));
    message = text(notes.join(" ").replace(/\s+/gu, " "), "PR feedback");
  }
  const service = context.service();
  const before = await service.get(taskId);
  requireOwnPr(before);
  if (before.stage === "completed") {
    throw new CliUsageError(
      "This task's worker has finished. Open the coordinator to arrange follow-up work; the PR comment was not sent.",
    );
  }
  const direction = await service.steer({ taskId, text: `PR fix request: ${message}` });
  if (
    direction.stage === "blocked" ||
    (before.stage === "ready" && direction.stage !== "implementing")
  ) {
    const current = await service.get(taskId);
    throw new Error(
      `PR feedback was saved, but the worker could not start fixing: ${current.blockReason ?? current.blockCause?.summary ?? `task is ${current.stage}`}`,
    );
  }
  return { value: direction };
}

async function taskForPrNumber(context: CliCommandContext, number: number): Promise<TaskRecord> {
  const repo = await canonicalPath(context.environment.repo, "repoPath");
  const tasks = await context.service().list();
  const scoped = await Promise.all(
    tasks.map(async (task) => ({
      task,
      repo: await canonicalPath(task.repoPath, "task repoPath"),
    })),
  );
  const matches = scoped
    .filter(
      (entry) =>
        entry.repo === repo &&
        (entry.task.pullRequest?.number === number || entry.task.prReview?.ref.number === number),
    )
    .map((entry) => entry.task);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new CliUsageError(
      matches.length === 0
        ? `No Tandem task has pull request #${number} in this project`
        : `More than one task has pull request #${number}; open it by task id`,
    );
  }
  return matches[0];
}

export async function openView(context: CliCommandContext): Promise<CliCommandOutcome> {
  const kind = text(context.invocation.positionals[0], "view kind");
  const id = text(context.invocation.positionals[1], "view id");
  const service = context.service();
  let view: TerminalView;
  let repoPath: string;
  if (kind === "brief") {
    repoPath = (await service.requestBrief(id)).record.repoPath;
    await requireBriefProject(context, repoPath);
    view = { kind, requestId: id };
  } else if (kind === "task" || kind === "pr") {
    const task =
      kind === "pr" && /^\d+$/u.test(id)
        ? await taskForPrNumber(context, positiveInteger(id, "PR number"))
        : await service.get(id);
    if (kind === "pr" && task.pullRequest === undefined && task.kind !== "pr-review") {
      throw new CliUsageError("The task has no pull request to open");
    }
    repoPath = task.repoPath;
    view = { kind, taskId: task.id };
  } else throw new CliUsageError("open requires task, brief, or pr and its durable id");
  const owned = await coordinator(context, repoPath);
  const origin = viewOriginFrom(context.invocation);
  const result = await context.capabilities.terminal.openView({
    coordinator: owned.endpoint,
    cwd: owned.worktree.path,
    home: context.environment.home,
    view,
    ...(origin === undefined ? {} : { origin }),
  });
  if (result.fallback === "brief-review" && view.kind === "brief") {
    const brief = await service.reviewRequestBrief(view.requestId);
    if (brief.record.reviewPane?.status !== "open") {
      throw new Error(
        brief.record.reviewPane?.reason ?? "The request brief review pane could not be opened",
      );
    }
    return {
      value: {
        opened: brief.record.reviewPane?.status === "open",
        warnings: result.warnings,
        brief,
      },
    };
  }
  if (!result.opened) {
    throw new Error(result.warnings.join("; ") || `The terminal could not open the ${kind} view`);
  }
  return { value: result };
}

/** Reuses the same pinned-head, no-double-post submission used by the PR review page. */
export async function submitReview(context: CliCommandContext): Promise<CliCommandOutcome> {
  const taskId = taskIdFor(context.invocation);
  const input = await jsonObjectFromFile(
    context.capabilities.statPath,
    context.invocation.options.input,
    context.invocation.command,
  );
  const { reviewHead, reviewGeneration, ...submission } = input;
  if (typeof reviewHead !== "string" || reviewHead.length === 0 || reviewHead.trim() !== reviewHead)
    throw new CliUsageError("review-submit requires reviewHead copied from the displayed review");
  if (
    typeof reviewGeneration !== "number" ||
    !Number.isSafeInteger(reviewGeneration) ||
    reviewGeneration < 0
  ) {
    throw new CliUsageError(
      "review-submit requires a nonnegative integer reviewGeneration copied from the displayed review",
    );
  }
  const parsed = parseReviewSubmission(JSON.stringify(submission));
  if (!parsed.ok) throw new CliUsageError(parsed.problems.join("; "));
  return {
    value: await context.service().reviewSubmit(taskId, parsed.submission, {
      head: reviewHead,
      generation: reviewGeneration,
    }),
    approved: true,
  };
}
