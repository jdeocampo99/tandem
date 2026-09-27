import { basename } from "node:path";
import { type BoardView, renderBoard } from "../board/view.ts";
import {
  type AgentRole,
  LEGACY_EVIDENCE_CONTRACT,
  MODEL_ROLE_LABELS,
  MODEL_ROLE_ORDER,
  type SkillOrigin,
  type TaskRecord,
} from "../contracts.ts";
import { type MemoryShowResult, renderMemoryShow } from "../memory/view.ts";
import { CATCH_UP_MAX_CHARS } from "../memory/workstream.ts";
import { PLAYBOOKS } from "../playbooks/catalog.ts";
import { type PrWatchView, renderPrWatchView } from "../pr-watch/view.ts";
import type { RequestUsageReceipt } from "../runtime/usage-receipt.ts";
import {
  REQUEST_RECEIPT_SCHEMA_VERSION,
  renderRequestReceiptTable,
} from "../runtime/usage-receipt.ts";
import { isPinnedEvidence } from "../tasks/acceptance.ts";
import { MAX_TASK_MESSAGE_CHARS } from "../tasks/communication-protocol.ts";
import {
  checkResearchContinuation,
  researchContinuationFor,
} from "../tasks/research-continuation.ts";
import { type BoundedTaskTrace, renderBoundedTaskTrace } from "../tasks/trace.ts";
import type { TandemAction } from "./actions.ts";
import { describeResearchDisposition } from "./research-follow-up.ts";

export const DIGEST_MAX_TASKS = 12;
export const DIGEST_MAX_TEXT = 180;
export const DIGEST_MAX_CHARS = 8_000;
export const ACTION_SUMMARY_MAX_TEXT = 220;
export const ACTION_SUMMARY_MAX_ITEMS = 6;
export const ACTION_RESULT_MAX_CHARS = 4_000;
/** The structured trace retains only this many newest timeline events. */
export const ACTION_TRACE_MAX_EVENTS = 16;
/** A review with many comments runs long; it is still shown in full up to this bound. */
const PR_REVIEW_RESULT_MAX_CHARS = 24_000;
export const ACTION_FULL_RESULT_MAX_CHARS = 12_000;
const TERMINAL_TASK_STAGES: Readonly<Partial<Record<TaskRecord["stage"], true>>> = {
  cancelled: true,
  completed: true,
  merged: true,
};

export function compactText(value: string, limit = DIGEST_MAX_TEXT): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
export function projectName(repoPath: string): string {
  const name = basename(repoPath);
  return name.length === 0 || name === "."
    ? "this project"
    : compactText(name, ACTION_SUMMARY_MAX_TEXT);
}

export function boundedOutput(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

export function boundedJson(value: unknown, limit: number): string {
  try {
    return boundedOutput(JSON.stringify(value) ?? String(value), limit);
  } catch (error) {
    return boundedOutput(
      `[unserializable result: ${error instanceof Error ? error.message : String(error)}]`,
      limit,
    );
  }
}

function summarizeTaskCheck(action: "inspect" | "delivery-preflight", value: unknown): string {
  const record = summaryRecord(value);
  if (record === undefined) return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  const taskId = recordText(record, "taskId") ?? "unknown task";
  if (action === "inspect") {
    const endpoints = Array.isArray(record.endpoints) ? record.endpoints.length : 0;
    const jobs = Array.isArray(record.jobs) ? record.jobs.length : 0;
    const stage = recordText(record, "stage") ?? "unknown stage";
    const blocked = record.blocked === true ? "blocked" : "not blocked";
    return boundedOutput(
      `${taskId}: ${blocked}; stage ${stage}; ${endpoints} endpoint(s); ${jobs} job(s); ${recordText(record, "branch") ?? "branch unknown"}`,
      ACTION_RESULT_MAX_CHARS,
    );
  }
  if (record.ready === true) return `${taskId}: ready to publish`;
  const refusals = Array.isArray(record.refusals)
    ? record.refusals.filter((entry): entry is string => typeof entry === "string")
    : [];
  return boundedOutput(
    `${taskId}: not ready to publish${refusals.length === 0 ? "" : `: ${refusals.join("; ")}`}`,
    ACTION_RESULT_MAX_CHARS,
  );
}

export function pendingCount(task: Pick<TaskRecord, "notifications">): number {
  return task.notifications.reduce(
    (count, notification) => count + (notification.acknowledged ? 0 : 1),
    0,
  );
}

function isTerminalTask(task: Pick<TaskRecord, "stage">): boolean {
  return TERMINAL_TASK_STAGES[task.stage] === true;
}

function taskPriority(task: Pick<TaskRecord, "stage" | "notifications" | "blockReason">): number {
  if (pendingCount(task) > 0 || task.blockReason !== undefined) return 0;
  return isTerminalTask(task) ? 2 : 1;
}

export function prioritizeTasks(tasks: readonly TaskRecord[]): readonly TaskRecord[] {
  return [...tasks].sort((left, right) => {
    const priority = taskPriority(left) - taskPriority(right);
    if (priority !== 0) return priority;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function compactList(
  entries: readonly string[],
  itemLimit = ACTION_SUMMARY_MAX_ITEMS,
  entryLimit = 140,
): string {
  const visible = entries.slice(0, itemLimit).map((entry) => compactText(entry, entryLimit));
  const omitted = entries.length - visible.length;
  return `${visible.join("; ")}${omitted > 0 ? `; +${omitted} more` : ""}`;
}

type TaskReview = TaskRecord["reviews"][number];
type TaskFinding = TaskReview["findings"][number];

function findingPriority(severity: TaskFinding["severity"]): number {
  switch (severity) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
  }
}

function currentReviewFindings(task: TaskRecord): readonly TaskFinding[] {
  if (task.reviewHead === undefined) return [];
  const findings: TaskFinding[] = [];
  for (const review of task.reviews) {
    if (review.head !== task.reviewHead || review.generation !== task.generation) continue;
    findings.push(...review.findings);
  }
  return findings.sort((left, right) => {
    const priority = findingPriority(left.severity) - findingPriority(right.severity);
    if (priority !== 0) return priority;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function taskHeads(task: TaskRecord): readonly string[] {
  const heads: string[] = [];
  const add = (head: string | undefined): void => {
    if (head !== undefined && !heads.includes(head)) heads.push(head);
  };
  add(task.reviewHead);
  for (const evidence of task.validationEvidence) add(evidence.head);
  for (const review of task.reviews) add(review.head);
  return heads;
}

const SKILL_SOURCES: Readonly<Record<SkillOrigin, string>> = {
  repository: "from the repository",
  personal: "personal",
  summary: "coordinator summary",
};

function summarizeTask(task: TaskRecord): string {
  const pending = pendingCount(task);
  const findings = currentReviewFindings(task);
  const heads = taskHeads(task);
  const currentReviews =
    task.reviewHead === undefined
      ? []
      : task.reviews.filter(
          (review) => review.head === task.reviewHead && review.generation === task.generation,
        );
  const lines = [
    `${task.id}: ${task.stage}`,
    task.target === undefined
      ? `Repository: ${compactText(task.repoPath, ACTION_SUMMARY_MAX_TEXT)}`
      : `Repository: ${task.target.repo} at ${compactText(task.target.checkout, ACTION_SUMMARY_MAX_TEXT)}; pull requests target ${task.target.branch}`,
    `Objective: ${compactText(task.objective, ACTION_SUMMARY_MAX_TEXT)}`,
    `Scope: ${task.scopeApproved ? "approved" : "awaiting approval"}; attempt ${task.generation}`,
    ...(task.requestId === undefined
      ? []
      : [`Request: ${compactText(task.requestId, ACTION_SUMMARY_MAX_TEXT)}`]),
    `Acceptance criteria (${task.acceptanceCriteria.length}): ${compactList(task.acceptanceCriteria)}`,
    `Surfaces (${task.surfaces.length}): ${compactList(task.surfaces)}`,
    ...(task.skills === undefined
      ? []
      : [
          `Skills: ${task.skills.map((skill) => `${skill.name} (${SKILL_SOURCES[skill.origin]})`).join(", ")}`,
        ]),
    ...(task.playbook === undefined ? [] : [`Type: ${PLAYBOOKS[task.playbook].title}`]),
  ];
  if (heads.length > 0) lines.push(`Commits: ${heads.join(", ")}`);
  if (task.worktree !== undefined) {
    lines.push(
      `Worktree: ${compactText(task.worktree.path, ACTION_SUMMARY_MAX_TEXT)}; branch ${compactText(task.worktree.branch, ACTION_SUMMARY_MAX_TEXT)}`,
    );
  }
  if (task.validationEvidence.length > 0) {
    const successful = task.validationEvidence.filter((entry) => entry.exitCode === 0).length;
    const pinned = task.validationEvidence.filter(isPinnedEvidence);
    const iteration = pinned.filter((entry) => entry.contract === "iteration").length;
    const remote = pinned.filter((entry) => entry.origin === "github").length;
    const legacy = task.validationEvidence.length - pinned.length;
    lines.push(
      `Checks: ${successful}/${task.validationEvidence.length} passing; ${pinned.length - iteration} final, ${iteration} during fixes${legacy === 0 ? "" : `, ${legacy} old-format`}; ${remote} from GitHub; ${compactList(
        task.validationEvidence.map((entry) => entry.name),
        4,
        100,
      )}`,
    );
  }
  if (task.reviewLevel !== undefined) {
    const level = task.reviewLevel;
    const assistance =
      level.assistance === undefined
        ? ""
        : `; suggested ${level.assistance.recommendation} (not applied)`;
    lines.push(
      `Review level: ${level.level}; minimum ${level.floors.length === 0 ? "none" : level.floors.join(", ")}; because ${compactText(level.reason, ACTION_SUMMARY_MAX_TEXT)}${assistance}`,
    );
  }
  if (currentReviews.length > 0) {
    const reviewMode = currentReviews.find((review) => review.mode !== undefined)?.mode;
    lines.push(
      `Reviews: ${currentReviews.map((review) => `${review.lens}=${review.pass ? "pass" : "findings"}`).join(", ")}${reviewMode === undefined ? "" : `; mode ${reviewMode}`}`,
    );
  }
  if (findings.length > 0) {
    lines.push(
      `Review findings (${findings.length}): ${findings
        .slice(0, ACTION_SUMMARY_MAX_ITEMS)
        .map(
          (finding) =>
            `${finding.id}/${finding.severity}/${finding.verdict}: ${compactText(finding.description, 150)}`,
        )
        .join(
          "; ",
        )}${findings.length > ACTION_SUMMARY_MAX_ITEMS ? `; +${findings.length - ACTION_SUMMARY_MAX_ITEMS} more` : ""}`,
    );
  }
  if (task.blockReason !== undefined)
    lines.push(`Blocker: ${compactText(task.blockReason, ACTION_SUMMARY_MAX_TEXT)}`);
  if (pending > 0) {
    const notifications = task.notifications.filter((notification) => !notification.acknowledged);
    lines.push(
      `Unread updates (${pending}): ${compactList(
        notifications.map((notification) => notification.message),
        3,
        150,
      )}`,
    );
  }
  if (task.reportPath !== undefined)
    lines.push(`Report: ${compactText(task.reportPath, ACTION_SUMMARY_MAX_TEXT)}`);
  const continuation = researchContinuationFor(task);
  if (continuation !== undefined) {
    lines.push(`After research: ${describeResearchDisposition(continuation.disposition)}.`);
  }
  if (task.pullRequest !== undefined) {
    lines.push(
      `Pull request: ${task.pullRequest.url ?? `${task.pullRequest.repository}#${task.pullRequest.number}`} (${task.pullRequest.state}); head ${task.pullRequest.head}; base ${task.pullRequest.base}`,
    );
    if (task.pullRequest.state === "draft") {
      lines.push("This is a draft: work in progress, not ready to merge.");
    }
  }
  return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
}

function summarizeTaskList(action: TandemAction["action"], tasks: readonly TaskRecord[]): string {
  const ordered = prioritizeTasks(tasks);
  const lines = [`${action} returned ${tasks.length} task(s).`];
  for (const task of ordered.slice(0, ACTION_SUMMARY_MAX_ITEMS)) {
    const pending = pendingCount(task);
    const blocker =
      task.blockReason === undefined ? "" : `; blocker: ${compactText(task.blockReason, 120)}`;
    const head = task.reviewHead === undefined ? "" : `; head: ${task.reviewHead}`;
    const report =
      task.reportPath === undefined ? "" : `; report: ${compactText(task.reportPath, 120)}`;
    lines.push(
      `- ${task.id}: ${task.stage}; ${compactText(task.objective, ACTION_SUMMARY_MAX_TEXT)}; ${
        task.scopeApproved ? "scope approved" : "scope pending"
      }${pending > 0 ? `; ${pending} unread update(s)` : ""}${blocker}${head}${report}`,
    );
  }
  if (tasks.length > ACTION_SUMMARY_MAX_ITEMS) {
    lines.push(
      `- ${tasks.length - ACTION_SUMMARY_MAX_ITEMS} more task(s) not shown; use show for one.`,
    );
  }
  return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
}

function summaryRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record;
}

function recordText(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function summarizeOnboard(value: unknown, action: "onboard" | "setup"): string {
  const record = summaryRecord(value);
  if (record === undefined) return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  const repoPath = recordText(record, "repoPath") ?? "unknown project";
  const project = projectName(repoPath);
  const existing = record.existingConfig === true;
  const written = record.written === true;
  const unresolved = Array.isArray(record.unresolved)
    ? record.unresolved.filter((entry): entry is string => typeof entry === "string")
    : [];
  const status = existing
    ? `Tandem settings already exist for ${project}; existing settings were kept and not overwritten.`
    : written
      ? `Tandem settings saved for ${project}.`
      : `Tandem settings proposed for ${project}; nothing was saved.`;
  const modelSettings = summaryRecord(record.modelSettings);
  const lines = [status];
  if (modelSettings?.configured === false) {
    if (action === "setup") {
      lines.push(
        written
          ? "No saved model choices were changed; setup saved project settings only."
          : "No saved model choices are configured; setup does not choose models.",
      );
    } else {
      lines.push("No saved model choices yet; no role has a selected, approved, or saved model.");
      lines.push("Pending role choices (every role is unselected until explicit answers):");
      lines.push(...summarizeModelAssignments(undefined, true).map((entry) => `- ${entry}`));
      lines.push(
        "Call models to fetch the OMP catalogue and the proposed Balanced profile, then accept it, inspect and override any role or provider enablement, or choose Not now to pause without configure-models, project setup, or launch.",
      );
    }
  } else if (modelSettings?.configured === true) {
    lines.push(
      action === "setup"
        ? "Saved model choices remain configured; setup did not change them."
        : "Saved model choices are configured for future projects (every role):",
    );
    const current = summarizeModelAssignments(
      modelSettings.models ?? summaryRecord(record.policy)?.models,
      true,
    );
    lines.push(...current.map((entry) => `- ${entry}`));
    if (action === "onboard") {
      lines.push("Choose one: Keep all (read-only), Change roles, or Not now.");
      lines.push(
        "Keep all does not write or force re-selection. Change roles asks explicitly for every role, records keep-current answers for untouched roles, preserves those assignments, and recaps every role before configure-models approval. Not now pauses onboarding without configure-models, project setup, launch, or changing saved choices.",
      );
    }
  }
  lines.push(...projectSetupLines(record, existing || written));
  lines.push("This did not change the app or start any work.");
  if (unresolved.length > 0)
    lines.push(`Readiness still needs attention: ${compactList(unresolved, 3, 150)}`);
  return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
}

function commandNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = summaryRecord(entry)?.name;
    return typeof name === "string" ? [name] : [];
  });
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** What onboarding found for one project, for the user to confirm or change before setup. */
function projectSetupLines(record: Record<string, unknown>, saved: boolean): readonly string[] {
  const lines: string[] = [];
  const checks = commandNames(record.validationCommands);
  const install = commandNames(record.setupCommands);
  const verb = saved ? "runs" : "would run";
  lines.push(
    checks.length === 0
      ? "Checks: none found; ask the user which commands prove a change works."
      : `Checks it ${verb} before calling work done: ${checks.join("; ")}`,
  );
  lines.push(
    install.length === 0
      ? "Install step for fresh copies: none."
      : `Install step for fresh copies: ${install.join("; ")}`,
  );
  if (!saved) {
    lines.push(
      "The user may change either list; pass their lists to setup as validationCommands and setupCommands.",
    );
  }
  if (Array.isArray(record.mcpServers)) {
    const servers = stringList(record.mcpServers);
    lines.push(
      servers.length === 0
        ? "MCP tools: none discovered for this project."
        : `MCP tools OMP loaded for this project: ${servers.join(", ")}`,
    );
  }
  const merging = summaryRecord(record.merging);
  if (merging !== undefined) {
    if (merging.readable === true) {
      const proposal =
        merging.proposal === undefined ? "" : ` Proposal: ${JSON.stringify(merging.proposal)}.`;
      lines.push(
        `Merging: ${recordText(merging, "method") ?? "unknown"} on ${recordText(merging, "branch") ?? "the default branch"}.${proposal} Ask how pull requests should merge and save it with pr-watch-merging after setup.`,
      );
    } else {
      const message = recordText(merging, "message");
      if (message !== undefined) lines.push(`Merging: ${message}`);
    }
  }
  return lines;
}

function summarizeFoundRepos(value: unknown): string {
  const record = summaryRecord(value);
  const name = record === undefined ? "that" : (recordText(record, "name") ?? "that");
  const matches = Array.isArray(record?.matches) ? record.matches : [];
  if (matches.length === 0) {
    return `No checkout named ${name} in the code folders. Ask the user for its folder path, or where they keep code (save-code-folders), then find-repo again.`;
  }
  const lines = matches.flatMap((entry) => {
    const match = summaryRecord(entry);
    const path = match === undefined ? undefined : recordText(match, "path");
    if (match === undefined || path === undefined) return [];
    const repo = recordText(match, "repo");
    const setUp = match.setUp === true ? " (already set up)" : "";
    return [`- ${path}${repo === undefined ? "" : ` (${repo})`}${setUp}`];
  });
  const lead =
    lines.length === 1
      ? `Found ${name}:`
      : `Found ${lines.length} checkouts named ${name}; ask the user which one:`;
  const details = summaryRecord(record?.details);
  const found = details === undefined ? [] : projectSetupLines(details, false);
  return boundedOutput([lead, ...lines, ...found].join("\n"), ACTION_RESULT_MAX_CHARS);
}

function summarizeToolChecks(value: unknown): string {
  if (!Array.isArray(value)) return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  const lines = value.flatMap((entry) => {
    const check = summaryRecord(entry);
    const name = check === undefined ? undefined : recordText(check, "name");
    if (check === undefined || name === undefined) return [];
    const detail = recordText(check, "detail") ?? "";
    if (check.ok === true) return [`✓ ${name}: ${detail}`];
    const fix = recordText(check, "fix");
    const optional = check.optional === true ? " (optional)" : "";
    return [`✗ ${name}${optional}: ${detail}${fix === undefined ? "" : `. Fix: ${fix}`}`];
  });
  return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
}

function recordNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}
function summarizeThinking(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    const thinking = value.join(", ");
    return thinking.length > 0 ? thinking : undefined;
  }
  return undefined;
}

export function summarizeModelAssignments(
  value: unknown,
  includeMissing = false,
): readonly string[] {
  const record = summaryRecord(value);
  if (record === undefined) {
    return includeMissing
      ? MODEL_ROLE_ORDER.map((role) => `${MODEL_ROLE_LABELS[role]} (${role}): not chosen yet`)
      : [];
  }
  const lines: string[] = [];
  for (const role of MODEL_ROLE_ORDER) {
    const spec = summaryRecord(record[role]);
    if (spec === undefined) {
      if (includeMissing) lines.push(`${MODEL_ROLE_LABELS[role]} (${role}): not chosen yet`);
      continue;
    }
    const model = recordText(spec, "model") ?? "model unavailable";
    const thinking = summarizeThinking(spec.thinking);
    lines.push(
      `${MODEL_ROLE_LABELS[role]} (${role}): ${compactText(model, ACTION_SUMMARY_MAX_TEXT)}${
        thinking === undefined ? "" : ` (thinking ${compactText(thinking, 40)})`
      }`,
    );
  }
  return lines;
}

function summarizeModelCatalogueEntry(value: unknown): string {
  const record = summaryRecord(value);
  if (record === undefined) return "- Model details unavailable.";
  const selector = recordText(record, "selector") ?? recordText(record, "id") ?? "unknown model";
  const name = recordText(record, "name");
  const provider = recordText(record, "provider");
  const label = name === undefined || name === selector ? selector : `${name} (${selector})`;
  const details: string[] = [];
  if (provider !== undefined && !selector.startsWith(`${provider}/`))
    details.push(`provider ${compactText(provider, 80)}`);
  const thinking = summarizeThinking(record.thinking);
  if (thinking !== undefined) details.push(`thinking ${compactText(thinking, 40)}`);
  if (record.reasoning === true) details.push("reasoning support");
  else if (record.reasoning === false) details.push("no reasoning support");
  const contextWindow = recordNumber(record, "contextWindow");
  if (contextWindow !== undefined) details.push(`context window ${contextWindow}`);
  const cost = summaryRecord(record.cost);
  if (cost !== undefined) {
    const input = recordNumber(cost, "input");
    const output = recordNumber(cost, "output");
    if (input !== undefined || output !== undefined) {
      details.push(
        `reported cost input ${input === undefined ? "?" : input}, output ${
          output === undefined ? "?" : output
        }`,
      );
    }
  }
  return `- ${compactText(label, ACTION_SUMMARY_MAX_TEXT)}${
    details.length === 0 ? "" : `; ${details.join(", ")}`
  }`;
}

function summarizeProviderState(record: Record<string, unknown>): readonly string[] {
  const discovered = record.discoveredProviders;
  const settings = summaryRecord(record.modelSettings);
  const enabled = settings?.enabledProviders;
  const lines: string[] = [];
  if (Array.isArray(discovered)) {
    lines.push(`Providers found: ${discovered.length === 0 ? "none" : discovered.join(", ")}`);
  }
  if (Array.isArray(enabled)) {
    lines.push(`Providers allowed to spend: ${enabled.length === 0 ? "none" : enabled.join(", ")}`);
  }
  return lines;
}

function summarizeBalancedProposal(value: unknown): readonly string[] {
  const record = summaryRecord(value);
  const status = record === undefined ? undefined : recordText(record, "status");
  if (record === undefined || status === undefined) return [];
  if (status === "resolved") {
    const roles = summaryRecord(record.roles);
    const lines = ["Suggested Balanced setup:"];
    for (const role of MODEL_ROLE_ORDER) {
      const entry = summaryRecord(roles?.[role]);
      const model = entry === undefined ? undefined : summaryRecord(entry.model);
      const selector = model === undefined ? undefined : recordText(model, "model");
      const thinking = model === undefined ? undefined : recordText(model, "thinking");
      lines.push(
        `- ${MODEL_ROLE_LABELS[role]} (${role}): ${selector ?? "selector unavailable"}${
          thinking === undefined ? "" : ` (thinking ${thinking})`
        }`,
      );
    }
    lines.push("Accept it, change any role, or choose Not now.");
    return lines;
  }
  const gaps = Array.isArray(record.gaps) ? record.gaps : [];
  const reasons = gaps
    .map((gap) => summaryRecord(gap))
    .filter((gap): gap is Record<string, unknown> => gap !== undefined)
    .map((gap) => {
      const role = recordText(gap, "role");
      const reason = recordText(gap, "reason");
      if (role === undefined || reason === undefined) return undefined;
      const label = MODEL_ROLE_LABELS[role as AgentRole] as string | undefined;
      return `${label ?? role} (${role}): ${compactText(reason, 160)}`;
    })
    .filter((entry): entry is string => entry !== undefined);
  return ["No suitable model was found for these roles:", ...reasons.map((entry) => `- ${entry}`)];
}

function summarizeModels(value: unknown): string {
  const record = summaryRecord(value);
  if (record === undefined) return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  const settings = summaryRecord(record.modelSettings);
  const available = record.availableModels;
  const lines: string[] = [];
  if (settings?.configured === true) {
    lines.push("Saved model choices are configured for future projects.");
    const current = summarizeModelAssignments(settings.models, true);
    if (current.length > 0) {
      lines.push("Current choices:");
      lines.push(...current.map((entry) => `- ${entry}`));
    }
    lines.push(...summarizeProviderState(record));
  } else if (settings?.configured === false) {
    lines.push("No saved model choices yet.");
    lines.push(...summarizeProviderState(record));
    const balancedLines = summarizeBalancedProposal(record.balancedProfile);
    if (balancedLines.length > 0) {
      lines.push(...balancedLines);
    } else {
      lines.push("Choose a model and thinking level for each role:");
      for (const role of MODEL_ROLE_ORDER)
        lines.push(`- ${MODEL_ROLE_LABELS[role]} (${role}): choose a model and thinking level`);
    }
  } else {
    lines.push("Current model choices are unavailable.");
  }
  if (!Array.isArray(available)) {
    lines.push("The model list could not be loaded, so there is nothing to suggest.");
  } else if (available.length === 0) {
    lines.push("No models are available, so there is nothing to suggest.");
  } else {
    lines.push("Available models (costs are estimates):");
    for (const entry of available.slice(0, ACTION_SUMMARY_MAX_ITEMS)) {
      lines.push(summarizeModelCatalogueEntry(entry));
    }
    if (available.length > ACTION_SUMMARY_MAX_ITEMS) {
      lines.push(`- ${available.length - ACTION_SUMMARY_MAX_ITEMS} more model(s) not shown.`);
    }
  }
  return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
}

function summarizeConfiguredModels(value: unknown): string {
  const record = summaryRecord(value);
  if (record?.configured === true)
    return "Tandem model choices were saved on this computer for future projects. No work was started.";
  if (record?.configured === false)
    return "Tandem model choices were not saved. No work was started.";
  return boundedJson(value, ACTION_RESULT_MAX_CHARS);
}

function summarizePresentations(action: TandemAction["action"], value: unknown): string {
  if (!Array.isArray(value)) return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  const lines = [`${action} returned ${value.length} presentation(s).`];
  for (const entry of value.slice(0, ACTION_SUMMARY_MAX_ITEMS)) {
    const record = summaryRecord(entry);
    if (record === undefined) {
      lines.push(`- ${boundedJson(entry, 240)}`);
      continue;
    }
    const id = recordText(record, "id") ?? "unknown";
    const status = recordText(record, "status") ?? "unknown";
    const artifactPath = recordText(record, "artifactPath");
    lines.push(
      `- ${id}: ${status}${artifactPath === undefined ? "" : `; artifact ${compactText(artifactPath, 180)}`}`,
    );
  }
  if (value.length > ACTION_SUMMARY_MAX_ITEMS)
    lines.push(`- ${value.length - ACTION_SUMMARY_MAX_ITEMS} additional presentation(s) omitted.`);
  return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
}

function communicationStatusLabel(status: unknown): string {
  switch (status) {
    case "pending":
      return "passed along, not yet delivered";
    case "received":
      return "passed along, not yet delivered";
    case "applied":
      return "delivered (the task has it; not done yet)";
    case "superseded":
      return "replaced by a newer message";
    default:
      return typeof status === "string" && status.length > 0 ? status : "status unknown";
  }
}

type CommunicationSummaryMode = "latest" | "overview";

function communicationMessageRevision(message: Record<string, unknown>): number {
  return recordNumber(message, "revision") ?? -1;
}

function latestCommunicationMessage(
  messages: readonly unknown[],
): Record<string, unknown> | undefined {
  let latest: Record<string, unknown> | undefined;
  let latestRevision = -1;
  for (const entry of messages) {
    const message = summaryRecord(entry);
    if (message === undefined) continue;
    const revision = communicationMessageRevision(message);
    if (revision >= latestRevision) {
      latest = message;
      latestRevision = revision;
    }
  }
  return latest;
}

function summarizeCommunicationMessage(
  message: Record<string, unknown>,
  textLimit = ACTION_SUMMARY_MAX_TEXT,
): string {
  const id = recordText(message, "id") ?? "unknown";
  const kind = recordText(message, "kind") ?? "message";
  const status = communicationStatusLabel(message.status);
  const text = recordText(message, "text");
  return `${kind} ${compactText(id, 100)}: ${status}${
    text === undefined ? "" : ` — ${compactText(text, textLimit)}`
  }`;
}

function summarizeCommunicationActivity(activity: Record<string, unknown>): string {
  const phase = recordText(activity, "phase") ?? "unknown";
  const tool = recordText(activity, "tool");
  const heartbeatAt = recordText(activity, "heartbeatAt");
  const progressAt = recordText(activity, "progressAt");
  const timestamps = [
    heartbeatAt === undefined ? undefined : `last seen ${compactText(heartbeatAt, 128)}`,
    progressAt === undefined ? undefined : `last progress ${compactText(progressAt, 128)}`,
  ].filter((entry): entry is string => entry !== undefined);
  return `Last activity: ${compactText(phase, 60)}${
    tool === undefined ? "" : ` (${compactText(tool, 100)})`
  }${timestamps.length === 0 ? "" : `; ${timestamps.join(", ")}`}`;
}

function summarizeCommunication(value: unknown, mode: CommunicationSummaryMode): string {
  const record = summaryRecord(value);
  if (record === undefined) return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  const taskId = recordText(record, "taskId") ?? "unknown task";
  const revision = recordNumber(record, "revision");
  const lines = [
    `Communication for ${compactText(taskId, ACTION_SUMMARY_MAX_TEXT)}${
      revision === undefined ? "" : ` at revision ${revision}`
    }.`,
  ];
  const messages = Array.isArray(record.messages) ? record.messages : [];
  if (mode === "latest") {
    const latest = latestCommunicationMessage(messages);
    lines.push(
      latest === undefined
        ? "No message was recorded."
        : `Latest entry: ${summarizeCommunicationMessage(latest, MAX_TASK_MESSAGE_CHARS)}`,
    );
    return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
  }

  const question = summaryRecord(record.question);
  if (question !== undefined) {
    const questionId = recordText(question, "id") ?? "unknown-question";
    const questionText = recordText(question, "text");
    lines.push(
      questionText === undefined
        ? `Question ${compactText(questionId, 100)}: text unavailable.`
        : `Question ${compactText(questionId, 100)}: ${compactText(questionText, MAX_TASK_MESSAGE_CHARS)}`,
    );
    const recommendation = recordText(question, "recommendation");
    if (recommendation !== undefined)
      lines.push(`Recommendation: ${compactText(recommendation, MAX_TASK_MESSAGE_CHARS)}`);
  }

  const effective = messages
    .map((entry) => summaryRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .filter((entry) => entry.status !== "superseded");
  const latest = latestCommunicationMessage(effective);
  const prioritized = effective
    .filter(
      (entry) => entry === latest || entry.status === "pending" || entry.status === "received",
    )
    .sort(
      (left, right) => communicationMessageRevision(right) - communicationMessageRevision(left),
    );
  if (prioritized.length === 0) {
    lines.push("No messages yet.");
  } else {
    for (const entry of prioritized.slice(0, ACTION_SUMMARY_MAX_ITEMS))
      lines.push(`- ${summarizeCommunicationMessage(entry)}`);
    if (prioritized.length > ACTION_SUMMARY_MAX_ITEMS) {
      lines.push(`- ${prioritized.length - ACTION_SUMMARY_MAX_ITEMS} older message(s) not shown.`);
    }
  }
  const activity = summaryRecord(record.activity);
  if (activity !== undefined) lines.push(summarizeCommunicationActivity(activity));
  return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isTaskFinding(value: unknown): value is TaskFinding {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    typeof record.id === "string" &&
    (record.severity === "P0" ||
      record.severity === "P1" ||
      record.severity === "P2" ||
      record.severity === "P3") &&
    (record.verdict === "confirmed" || record.verdict === "plausible") &&
    typeof record.description === "string"
  );
}

function isTaskReview(value: unknown): value is TaskReview {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    typeof record.lens === "string" &&
    typeof record.head === "string" &&
    typeof record.generation === "number" &&
    typeof record.pass === "boolean" &&
    (record.mode === undefined ||
      record.mode === "review_changed_diff" ||
      record.mode === "review_existing_head") &&
    Array.isArray(record.findings) &&
    record.findings.every(isTaskFinding)
  );
}

function isTaskValidationEvidence(
  value: unknown,
): value is TaskRecord["validationEvidence"][number] {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    typeof record.name === "string" &&
    typeof record.exitCode === "number" &&
    typeof record.head === "string" &&
    (record.contract === LEGACY_EVIDENCE_CONTRACT
      ? record.origin === undefined && record.policyDigest === undefined
      : (record.contract === "iteration" || record.contract === "final") &&
        (record.origin === "local" || record.origin === "github") &&
        typeof record.policyDigest === "string")
  );
}

function isTaskNotification(value: unknown): value is TaskRecord["notifications"][number] {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    typeof record.id === "string" &&
    typeof record.message === "string" &&
    typeof record.acknowledged === "boolean"
  );
}

function isTaskWorktree(value: unknown): value is NonNullable<TaskRecord["worktree"]> {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    typeof record.path === "string" &&
    typeof record.branch === "string" &&
    typeof record.baseHead === "string"
  );
}

function isTaskPullRequest(value: unknown): value is NonNullable<TaskRecord["pullRequest"]> {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    typeof record.repository === "string" &&
    typeof record.number === "number" &&
    typeof record.state === "string" &&
    typeof record.head === "string" &&
    typeof record.base === "string"
  );
}

function isTaskRecord(value: unknown): value is TaskRecord {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    typeof record.revision === "number" &&
    typeof record.repoPath === "string" &&
    (record.kind === "scout" || record.kind === "implementation") &&
    typeof record.objective === "string" &&
    isStringArray(record.acceptanceCriteria) &&
    isStringArray(record.surfaces) &&
    typeof record.stage === "string" &&
    typeof record.scopeApproved === "boolean" &&
    typeof record.policy === "object" &&
    record.policy !== null &&
    typeof record.generation === "number" &&
    typeof record.reviewRound === "number" &&
    Array.isArray(record.validationEvidence) &&
    record.validationEvidence.every(isTaskValidationEvidence) &&
    Array.isArray(record.reviews) &&
    record.reviews.every(isTaskReview) &&
    Array.isArray(record.notifications) &&
    record.notifications.every(isTaskNotification) &&
    (record.reviewHead === undefined || typeof record.reviewHead === "string") &&
    (record.worktree === undefined || isTaskWorktree(record.worktree)) &&
    (record.reportPath === undefined || typeof record.reportPath === "string") &&
    (record.researchHandoffs === undefined || Array.isArray(record.researchHandoffs)) &&
    (record.researchContinuation === undefined ||
      checkResearchContinuation(record.researchContinuation).valid) &&
    (record.blockReason === undefined || typeof record.blockReason === "string") &&
    (record.pullRequest === undefined || isTaskPullRequest(record.pullRequest))
  );
}

function isMemoryShowResult(value: unknown): value is MemoryShowResult {
  const record = summaryRecord(value);
  return (
    (record?.kind === "notes" && summaryRecord(record.view) !== undefined) ||
    (record?.kind === "none" && typeof record.name === "string")
  );
}

function isPrWatchView(value: unknown): value is PrWatchView {
  const record = summaryRecord(value);
  return record !== undefined && typeof record.now === "string" && Array.isArray(record.rows);
}

function isBoardView(value: unknown): value is BoardView {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    typeof record.now === "string" &&
    Array.isArray(record.needsYou) &&
    Array.isArray(record.running) &&
    Array.isArray(record.pullRequests)
  );
}

function isTaskArray(value: unknown): value is readonly TaskRecord[] {
  return Array.isArray(value) && value.every(isTaskRecord);
}

/** Return bounded model-facing text while preserving the full structured value for UI/details. */
/**
 * Renders the durable request agreement without becoming a second authority: every line restates
 * what SQLite holds, including the digest an approval must carry to be accepted.
 */
function summarizeRequestBrief(value: unknown): string {
  const view = summaryRecord(value);
  const record = view === undefined ? undefined : summaryRecord(view.record);
  const draft = record === undefined ? undefined : summaryRecord(record.draft);
  if (view === undefined || record === undefined || draft === undefined) {
    return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }
  const pane = summaryRecord(record.reviewPane);
  const paused = Array.isArray(view.pausedTaskIds)
    ? view.pausedTaskIds.filter(isNonEmptyEntry)
    : [];
  const lines = [
    `${recordText(record, "id") ?? "unknown request"}: brief revision ${recordNumber(draft, "revision") ?? 0}; approval ${recordText(view, "approvalState") ?? "unknown"}`,
    `Change: ${recordText(draft, "changeKind") ?? "unknown"}; content digest ${recordText(draft, "contentDigest") ?? "unknown"}`,
    `Review pane: ${
      pane === undefined
        ? "none opened for this request"
        : `${recordText(pane, "status") ?? "unknown"} at revision ${recordNumber(pane, "renderedRevision") ?? 0}${
            recordText(pane, "reason") === undefined
              ? ""
              : `; ${compactText(recordText(pane, "reason") ?? "", ACTION_SUMMARY_MAX_TEXT)}`
          }`
    }`,
  ];
  const abandonedAt = recordText(record, "abandonedAt");
  if (abandonedAt !== undefined)
    lines.push(`Abandoned on ${abandonedAt}; it no longer awaits approval`);
  if (paused.length > 0) {
    lines.push(
      `Paused until reapproved (${paused.length}): ${compactList(paused, ACTION_SUMMARY_MAX_ITEMS, 100)}`,
    );
  }
  return boundedOutput(lines.join("\n"), ACTION_RESULT_MAX_CHARS);
}

function isRequestUsageReceipt(value: unknown): value is RequestUsageReceipt {
  const record = summaryRecord(value);
  return (
    record !== undefined &&
    record.schemaVersion === REQUEST_RECEIPT_SCHEMA_VERSION &&
    typeof record.requestId === "string"
  );
}

/**
 * The receipt as its per-stage table. Elapsed time comes only from the recorded intake and
 * terminal facts, so concurrent workers are reported as overlap rather than added to the wall clock.
 */
function summarizeRequestReceipt(value: unknown): string {
  if (!isRequestUsageReceipt(value)) return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  return boundedOutput(renderRequestReceiptTable(value), ACTION_RESULT_MAX_CHARS);
}

function isNonEmptyEntry(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * PR review results carry text meant for the user: a one-line message, the review itself, or raw
 * page notes. The review is shown whole, since it is the point of the action.
 */
function summarizePrReview(result: unknown): string {
  const value = summaryRecord(result);
  if (value === undefined) return boundedJson(result, ACTION_RESULT_MAX_CHARS);
  const parts: string[] = [];
  if (typeof value.taskId === "string") parts.push(`Task ${value.taskId}.`);
  if (typeof value.message === "string") parts.push(value.message);
  if (typeof value.nextStep === "string") parts.push(value.nextStep);
  if (typeof value.pageUrl === "string") parts.push(`Review page: ${value.pageUrl}`);
  if (typeof value.text === "string") parts.push("", value.text);
  if (typeof value.feedback === "string") {
    parts.push(value.feedback.trim().length === 0 ? "No notes on the page yet." : value.feedback);
  }
  return boundedOutput(parts.join("\n"), PR_REVIEW_RESULT_MAX_CHARS);
}

function isBoundedTaskTrace(value: unknown): value is BoundedTaskTrace {
  const record = summaryRecord(value);
  const rollup = record === undefined ? undefined : summaryRecord(record.rollup);
  if (
    record === undefined ||
    rollup === undefined ||
    !Array.isArray(record.events) ||
    record.events.length > ACTION_TRACE_MAX_EVENTS
  ) {
    return false;
  }
  const events: readonly unknown[] = record.events;
  const unreadableEvents = recordNumber(record, "unreadableEvents");
  const omittedEvents = recordNumber(record, "omittedEvents");
  const cost = rollup.cost === undefined ? undefined : summaryRecord(rollup.cost);
  const validCost =
    rollup.cost === undefined ||
    (cost !== undefined &&
      cost.currency === "USD" &&
      recordNumber(cost, "amountMicros") !== undefined &&
      recordNumber(cost, "actualSamples") !== undefined &&
      recordNumber(cost, "estimatedSamples") !== undefined &&
      recordNumber(cost, "unavailableSamples") !== undefined);
  return (
    typeof rollup.taskId === "string" &&
    recordNumber(rollup, "fixRounds") !== undefined &&
    recordNumber(rollup, "blockedMs") !== undefined &&
    (rollup.firstPassReview === undefined || typeof rollup.firstPassReview === "boolean") &&
    validCost &&
    unreadableEvents !== undefined &&
    Number.isSafeInteger(unreadableEvents) &&
    unreadableEvents >= 0 &&
    omittedEvents !== undefined &&
    Number.isSafeInteger(omittedEvents) &&
    omittedEvents >= 0 &&
    events.every((event: unknown) => {
      const storedEvent = summaryRecord(event);
      return (
        storedEvent !== undefined &&
        recordNumber(storedEvent, "seq") !== undefined &&
        recordText(storedEvent, "at") !== undefined &&
        recordText(storedEvent, "type") !== undefined
      );
    })
  );
}

export function summarizeTandemActionValue(action: TandemAction["action"], value: unknown): string {
  if (action === "list" || action === "tick") {
    return isTaskArray(value)
      ? summarizeTaskList(action, value)
      : boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }
  if (action === "trace") {
    return isBoundedTaskTrace(value)
      ? renderBoundedTaskTrace(value, ACTION_RESULT_MAX_CHARS)
      : boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }

  if (action === "onboard" || action === "setup") return summarizeOnboard(value, action);
  if (action === "find-repo") return summarizeFoundRepos(value);
  if (action === "check-tools") return summarizeToolChecks(value);
  if (action === "setup-page" && typeof value === "string") {
    return boundedOutput(value, ACTION_RESULT_MAX_CHARS);
  }
  if (action === "save-code-folders" || action === "self-improvement") {
    return "Saved.";
  }
  if (action === "models") return summarizeModels(value);
  if (action === "configure-models") return summarizeConfiguredModels(value);
  if (action === "steer" || action === "answer") {
    return summarizeCommunication(value, "latest");
  }
  if (action === "messages") return summarizeCommunication(value, "overview");
  if (action === "inspect" || action === "delivery-preflight") {
    return summarizeTaskCheck(action, value);
  }
  if (
    action === "create" ||
    action === "investigate" ||
    action === "pr-watch-fix" ||
    action === "show" ||
    action === "approve" ||
    action === "pause" ||
    action === "resume" ||
    action === "cancel" ||
    action === "publish" ||
    action === "publish-now" ||
    action === "draft" ||
    action === "merge"
  ) {
    return isTaskRecord(value) ? summarizeTask(value) : boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }
  if (
    action === "brief-draft" ||
    action === "brief-review" ||
    action === "brief-show" ||
    action === "brief-abandon" ||
    action === "brief-approve"
  ) {
    return summarizeRequestBrief(value);
  }
  if (action === "request-receipt") return summarizeRequestReceipt(value);
  if (
    action === "review-pr" ||
    action === "review-show" ||
    action === "review-edit" ||
    action === "review-post" ||
    action === "review-notes"
  ) {
    return summarizePrReview(value);
  }
  if (action === "review-again" || action === "review-close") {
    return isTaskRecord(value) ? summarizeTask(value) : boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }
  if (
    action === "presentations" ||
    action === "present" ||
    action === "feedback" ||
    action === "presentation-open"
  ) {
    return summarizePresentations(action, value);
  }
  if (action === "board") {
    return isBoardView(value)
      ? boundedOutput(renderBoard(value), ACTION_RESULT_MAX_CHARS)
      : boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }
  if (action === "pr-watch" || action === "pr-watch-start" || action === "pr-watch-stop") {
    return isPrWatchView(value)
      ? boundedOutput(renderPrWatchView(value), ACTION_RESULT_MAX_CHARS)
      : boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }
  if (action === "memory-show" && isMemoryShowResult(value)) return renderMemoryShow(value);
  // Workstream notes are Markdown whose line breaks carry meaning, so they are never collapsed.
  if (action.startsWith("memory-") && typeof value === "string") {
    return boundedOutput(value, CATCH_UP_MAX_CHARS);
  }
  if (typeof value === "string")
    return boundedOutput(compactText(value, ACTION_RESULT_MAX_CHARS), ACTION_RESULT_MAX_CHARS);
  return boundedJson(value, ACTION_RESULT_MAX_CHARS);
}

/** Build the small durable state block that survives OMP context compaction. */
/** A finished task with nothing unread, no blocker, and no open question: history, not work. */
function isQuietFinishedTask(task: TaskRecord): boolean {
  return (
    isTerminalTask(task) &&
    pendingCount(task) === 0 &&
    task.blockReason === undefined &&
    task.communication?.question === undefined
  );
}

/**
 * The task state injected into every coordinator turn. Commit hashes are left out (the coordinator
 * never shows them), and finished tasks with nothing new collapse to one line of ids and objectives,
 * enough to cite earlier research; show and list carry the rest.
 */
export function buildDurableDigest(tasks: readonly TaskRecord[]): string {
  const lines = ["Tandem work right now:"];
  if (tasks.length === 0) {
    lines.push("- No tasks.");
    return boundedOutput(lines.join("\n"), DIGEST_MAX_CHARS);
  }
  lines.push(`- ${tasks.length} task(s).`);
  const ordered = prioritizeTasks(tasks);
  const active = ordered.filter((task) => !isQuietFinishedTask(task));
  const quiet = ordered.filter(isQuietFinishedTask);
  for (const task of active.slice(0, DIGEST_MAX_TASKS)) {
    const pending = pendingCount(task);
    const notificationSuffix = pending > 0 ? `; ${pending} unread update(s)` : "";
    const blockerSuffix =
      task.blockReason === undefined ? "" : `; blocker: ${compactText(task.blockReason)}`;
    const reportSuffix =
      task.reportPath === undefined ? "" : `; report: ${compactText(task.reportPath, 140)}`;
    const continuation = researchContinuationFor(task);
    const continuationSuffix =
      continuation === undefined ? "" : `; after research: ${continuation.disposition}`;
    lines.push(
      `- ${task.id}: ${task.stage}; ${compactText(task.objective)}${notificationSuffix}${blockerSuffix}${reportSuffix}${continuationSuffix}`,
    );
    const question = task.communication?.question;
    if (question !== undefined) {
      lines.push(
        `  question ${compactText(question.id, 100)}: ${compactText(question.text, MAX_TASK_MESSAGE_CHARS)}`,
      );
      if (question.recommendation !== undefined)
        lines.push(
          `  recommendation: ${compactText(question.recommendation, MAX_TASK_MESSAGE_CHARS)}`,
        );
    }
    if (!isTerminalTask(task)) {
      lines.push(
        `  acceptance (${task.acceptanceCriteria.length}): ${compactList(task.acceptanceCriteria, 3, 110)}`,
      );
      const findings = currentReviewFindings(task);
      if (findings.length > 0) {
        lines.push(
          `  findings (${findings.length}): ${findings
            .slice(0, 2)
            .map(
              (finding) =>
                `${finding.id}/${finding.severity}: ${compactText(finding.description, 120)}`,
            )
            .join("; ")}`,
        );
      }
    }
  }
  if (active.length > DIGEST_MAX_TASKS)
    lines.push(`- ${active.length - DIGEST_MAX_TASKS} more task(s) not shown.`);
  if (quiet.length > 0) {
    const named = quiet.map((task) => `${task.id} (${compactText(task.objective, 60)})`);
    lines.push(
      `- Finished, nothing new (${quiet.length}): ${compactList(named, DIGEST_MAX_TASKS, 180)}`,
    );
  }
  return boundedOutput(lines.join("\n"), DIGEST_MAX_CHARS);
}
