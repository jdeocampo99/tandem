import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { activeTaskMessages, MAX_TASK_MESSAGE_CHARS } from "./communication.ts";
import type { AgentRole, RepoPolicy, TaskKind, TaskRecord } from "./contracts.ts";
import type { PrSummary } from "./delivery.ts";
import { COORDINATOR_INSTRUCTIONS } from "./instructions.ts";
import {
  type CreateTaskRequest,
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "./service.ts";

const DEFAULT_TICK_INTERVAL_MS = 2_000;
const DIGEST_MAX_TASKS = 12;
const DIGEST_MAX_TEXT = 180;
const DIGEST_MAX_CHARS = 8_000;
const MAX_NOTIFICATION_BATCH = 8;
const ACTION_SUMMARY_MAX_TEXT = 220;
const ACTION_SUMMARY_MAX_ITEMS = 6;
const ACTION_RESULT_MAX_CHARS = 4_000;
const ACTION_FULL_RESULT_MAX_CHARS = 12_000;
const TERMINAL_TASK_STAGES: Readonly<Partial<Record<TaskRecord["stage"], true>>> = {
  cancelled: true,
  completed: true,
  merged: true,
};
const TANDEM_NOTIFICATION_ENTRY = "tandem-notification";
const TANDEM_COMMAND_ARITY: Readonly<
  Record<string, Readonly<{ readonly min: number; readonly max: number }>>
> = {
  list: { min: 1, max: 1 },
  status: { min: 1, max: 1 },
  presentations: { min: 1, max: 1 },
  onboard: { min: 2, max: 2 },
  setup: { min: 2, max: 2 },
  models: { min: 1, max: 2 },
  create: { min: 6, max: 6 },
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
  merge: { min: 3, max: 3 },
  "pr-merge": { min: 3, max: 3 },
  cleanup: { min: 2, max: 3 },
  steer: { min: 3, max: Number.POSITIVE_INFINITY },
  answer: { min: 4, max: Number.POSITIVE_INFINITY },
  messages: { min: 2, max: 2 },
};
const MODEL_ROLE_ORDER = [
  "coordinator",
  "scout",
  "implementer",
  "reviewer",
  "verifier",
  "presentation",
] as const satisfies readonly AgentRole[];
const MODEL_ROLE_LABELS: Readonly<Record<AgentRole, string>> = {
  coordinator: "Planning",
  scout: "Research",
  implementer: "Coding",
  reviewer: "Code review",
  verifier: "Final checks",
  presentation: "Visual presentation",
};

export type TandemBoundaryEnvironment = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly parentWorkspaceId?: string;
  readonly poolRoot: string;
  readonly repo: string;
}>;

export type TandemEnvironmentDefaults = Readonly<{
  readonly cwd: string;
  readonly sessionId?: string;
}>;

export type TandemEnvironmentSource = Readonly<Record<string, string | undefined>>;

export type TandemExtensionOptions = Readonly<{
  readonly service?: TandemService;
  readonly createService?: (options: TandemServiceOptions) => TandemService;
  readonly environment?: Partial<TandemBoundaryEnvironment>;
  readonly processEnvironment?: TandemEnvironmentSource;
  readonly tickIntervalMs?: number;
}>;

type NotificationRef = Readonly<{
  readonly taskId: string;
  readonly notificationId: string;
  readonly message: string;
  readonly judgmentNeeded: boolean;
}>;

type TandemToolDetails = Readonly<{
  readonly action: TandemAction["action"];
  readonly value?: unknown;
  readonly approved?: boolean;
  readonly detail?: "summary" | "full";
}>;

export type TandemAction =
  | Readonly<{ readonly action: "onboard"; readonly repoPath: string }>
  | Readonly<{ readonly action: "setup"; readonly repoPath: string }>
  | Readonly<{ readonly action: "models"; readonly repoPath: string }>
  | Readonly<{
      readonly action: "configure-models";
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
    }>
  | Readonly<{
      readonly action: "create";
      readonly repoPath: string;
      readonly kind: TaskKind;
      readonly objective: string;
      readonly acceptanceCriteria: readonly string[];
      readonly surfaces: readonly string[];
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
  | Readonly<{ readonly action: "approve"; readonly taskId: string }>
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

function readBoundaryText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  if (value.includes("\0")) throw new TypeError(`${field} must not contain NUL characters`);
  return value.trim();
}

function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function readBoundaryPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty path`);
  }
  if (value.includes("\0")) throw new TypeError(`${field} must not contain NUL characters`);
  if (hasPathControlCharacter(value)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  return value;
}

function optionalBoundaryText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readBoundaryText(value, field);
}

function processEnvironmentSnapshot(
  source: TandemEnvironmentSource | undefined,
): TandemEnvironmentSource {
  if (source !== undefined) return source;
  const values: Record<string, string | undefined> = {};
  for (const key of [
    "TANDEM_HOME",
    "TANDEM_SESSION",
    "TANDEM_PARENT_WORKSPACE",
    "TANDEM_POOL_ROOT",
    "TANDEM_REPO",
    "HERDR_ENV",
    "HERDR_SESSION",
    "HERDR_SESSION_NAME",
    "HERDR_WORKSPACE_ID",
  ]) {
    values[key] = process.env[key];
  }
  return values;
}

/** Resolve Tandem's process-boundary environment without leaking it into domain code. */
export function resolveTandemEnvironment(
  source: TandemEnvironmentSource,
  defaults: TandemEnvironmentDefaults,
  overrides: Partial<TandemBoundaryEnvironment> = {},
): TandemBoundaryEnvironment {
  const cwd = readBoundaryPath(defaults.cwd, "cwd");
  const home = readBoundaryPath(
    overrides.home ?? source.TANDEM_HOME ?? join(homedir(), ".tandem"),
    "TANDEM_HOME",
  );
  const sessionId = readBoundaryText(
    overrides.sessionId ??
      source.TANDEM_SESSION ??
      source.HERDR_SESSION ??
      source.HERDR_SESSION_NAME ??
      defaults.sessionId ??
      "tandem",
    "TANDEM_SESSION",
  );
  const parentWorkspaceId = optionalBoundaryText(
    overrides.parentWorkspaceId ?? source.TANDEM_PARENT_WORKSPACE ?? source.HERDR_WORKSPACE_ID,
    "TANDEM_PARENT_WORKSPACE",
  );
  const poolRoot = readBoundaryPath(
    overrides.poolRoot ?? source.TANDEM_POOL_ROOT ?? join(home, "pool"),
    "TANDEM_POOL_ROOT",
  );
  const repo = readBoundaryPath(overrides.repo ?? source.TANDEM_REPO ?? cwd, "TANDEM_REPO");
  return {
    home,
    sessionId,
    ...(parentWorkspaceId === undefined ? {} : { parentWorkspaceId }),
    poolRoot,
    repo,
  };
}

function compactText(value: string, limit = DIGEST_MAX_TEXT): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
function projectName(repoPath: string): string {
  const name = basename(repoPath);
  return name.length === 0 || name === "."
    ? "this project"
    : compactText(name, ACTION_SUMMARY_MAX_TEXT);
}

function boundedOutput(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function boundedJson(value: unknown, limit: number): string {
  try {
    return boundedOutput(JSON.stringify(value) ?? String(value), limit);
  } catch (error) {
    return boundedOutput(
      `[unserializable result: ${error instanceof Error ? error.message : String(error)}]`,
      limit,
    );
  }
}

function pendingCount(task: Pick<TaskRecord, "notifications">): number {
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

function prioritizeTasks(tasks: readonly TaskRecord[]): readonly TaskRecord[] {
  return [...tasks].sort((left, right) => {
    const priority = taskPriority(left) - taskPriority(right);
    if (priority !== 0) return priority;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function compactList(
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
    `Repository: ${compactText(task.repoPath, ACTION_SUMMARY_MAX_TEXT)}`,
    `Objective: ${compactText(task.objective, ACTION_SUMMARY_MAX_TEXT)}`,
    `Scope: ${task.scopeApproved ? "approved" : "awaiting approval"}; generation ${task.generation}; revision ${task.revision}`,
    `Acceptance criteria (${task.acceptanceCriteria.length}): ${compactList(task.acceptanceCriteria)}`,
    `Surfaces (${task.surfaces.length}): ${compactList(task.surfaces)}`,
  ];
  if (heads.length > 0) lines.push(`Immutable heads: ${heads.join(", ")}`);
  if (task.worktree !== undefined) {
    lines.push(
      `Worktree: ${compactText(task.worktree.path, ACTION_SUMMARY_MAX_TEXT)}; branch ${compactText(task.worktree.branch, ACTION_SUMMARY_MAX_TEXT)}`,
    );
  }
  if (task.validationEvidence.length > 0) {
    const successful = task.validationEvidence.filter((entry) => entry.exitCode === 0).length;
    lines.push(
      `Validation evidence: ${successful}/${task.validationEvidence.length} passing; commands ${compactList(
        task.validationEvidence.map((entry) => entry.name),
        4,
        100,
      )}`,
    );
  }
  if (currentReviews.length > 0) {
    lines.push(
      `Reviews: ${currentReviews.map((review) => `${review.lens}=${review.pass ? "pass" : "findings"}`).join(", ")}`,
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
      `Pending notifications (${pending}): ${compactList(
        notifications.map((notification) => notification.message),
        3,
        150,
      )}`,
    );
  }
  if (task.reportPath !== undefined)
    lines.push(`Report evidence: ${compactText(task.reportPath, ACTION_SUMMARY_MAX_TEXT)}`);
  if (task.pullRequest !== undefined) {
    lines.push(
      `Pull request: ${task.pullRequest.repository}#${task.pullRequest.number} ${task.pullRequest.state}; head ${task.pullRequest.head}; base ${task.pullRequest.base}`,
    );
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
      }${pending > 0 ? `; ${pending} pending notification(s)` : ""}${blocker}${head}${report}`,
    );
  }
  if (tasks.length > ACTION_SUMMARY_MAX_ITEMS) {
    lines.push(
      `- ${tasks.length - ACTION_SUMMARY_MAX_ITEMS} additional task(s) remain in the authoritative store; use show for a task.`,
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

function summarizeOnboard(value: unknown): string {
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
    lines.push("No saved model choices yet; choose models before project setup.");
  } else if (modelSettings?.configured === true) {
    lines.push("Saved model choices will be reused for this project.");
  }
  lines.push("This did not change the app or start any work.");
  if (unresolved.length > 0)
    lines.push(`Readiness still needs attention: ${compactList(unresolved, 3, 150)}`);
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

function summarizeModelAssignments(value: unknown): readonly string[] {
  const record = summaryRecord(value);
  if (record === undefined) return [];
  const lines: string[] = [];
  for (const role of MODEL_ROLE_ORDER) {
    const spec = summaryRecord(record[role]);
    if (spec === undefined) continue;
    const model = recordText(spec, "model") ?? "model unavailable";
    const thinking = summarizeThinking(spec.thinking);
    lines.push(
      `${MODEL_ROLE_LABELS[role]}: ${compactText(model, ACTION_SUMMARY_MAX_TEXT)}${
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

function summarizeModels(value: unknown): string {
  const record = summaryRecord(value);
  if (record === undefined) return boundedJson(value, ACTION_RESULT_MAX_CHARS);
  const settings = summaryRecord(record.modelSettings);
  const available = record.availableModels;
  const lines: string[] = [];
  if (settings?.configured === true) {
    lines.push("Saved model choices will be reused for future projects.");
    const current = summarizeModelAssignments(settings.models);
    if (current.length > 0) {
      lines.push("Current choices:");
      lines.push(...current.map((entry) => `- ${entry}`));
    }
  } else if (settings?.configured === false) {
    lines.push("No saved model choices yet; choose models before project setup.");
  } else {
    lines.push("Current model choices are unavailable.");
  }
  if (!Array.isArray(available)) {
    lines.push("The available model list is unavailable; no recommendation can be made.");
  } else if (available.length === 0) {
    lines.push("No OMP models are available; no recommendation can be made.");
  } else {
    lines.push("Available OMP models (reported costs are informational, not billing guarantees):");
    for (const entry of available.slice(0, ACTION_SUMMARY_MAX_ITEMS)) {
      lines.push(summarizeModelCatalogueEntry(entry));
    }
    if (available.length > ACTION_SUMMARY_MAX_ITEMS) {
      lines.push(
        `- ${available.length - ACTION_SUMMARY_MAX_ITEMS} additional model(s) omitted; use the full result for details.`,
      );
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
      return "queued for the child";
    case "received":
      return "received by the bridge (queued for the child)";
    case "applied":
      return "delivered to the child (context receipt; not completion)";
    case "superseded":
      return "superseded";
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
    heartbeatAt === undefined ? undefined : `heartbeat ${compactText(heartbeatAt, 128)}`,
    progressAt === undefined ? undefined : `progress ${compactText(progressAt, 128)}`,
  ].filter((entry): entry is string => entry !== undefined);
  return `Last observed activity: ${compactText(phase, 60)}${
    tool === undefined ? "" : ` (${compactText(tool, 100)})`
  }${
    timestamps.length === 0 ? "; timestamps unavailable" : `; ${timestamps.join(", ")}`
  }; liveness metadata only.`;
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
        ? "No direction was recorded."
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
    lines.push("No current or pending directions are recorded.");
  } else {
    for (const entry of prioritized.slice(0, ACTION_SUMMARY_MAX_ITEMS))
      lines.push(`- ${summarizeCommunicationMessage(entry)}`);
    if (prioritized.length > ACTION_SUMMARY_MAX_ITEMS) {
      lines.push(
        `- ${prioritized.length - ACTION_SUMMARY_MAX_ITEMS} older current/pending entry(s) omitted; use JSON/details for the full record.`,
      );
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
    typeof record.head === "string"
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
    (record.blockReason === undefined || typeof record.blockReason === "string") &&
    (record.pullRequest === undefined || isTaskPullRequest(record.pullRequest))
  );
}

function isTaskArray(value: unknown): value is readonly TaskRecord[] {
  return Array.isArray(value) && value.every(isTaskRecord);
}

/** Return bounded model-facing text while preserving the full structured value for UI/details. */
export function summarizeTandemActionValue(action: TandemAction["action"], value: unknown): string {
  if (action === "list" || action === "tick") {
    return isTaskArray(value)
      ? summarizeTaskList(action, value)
      : boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }
  if (action === "onboard" || action === "setup") return summarizeOnboard(value);
  if (action === "models") return summarizeModels(value);
  if (action === "configure-models") return summarizeConfiguredModels(value);
  if (action === "steer" || action === "answer") return summarizeCommunication(value, "latest");
  if (action === "messages") return summarizeCommunication(value, "overview");
  if (
    action === "create" ||
    action === "show" ||
    action === "approve" ||
    action === "pause" ||
    action === "resume" ||
    action === "cancel" ||
    action === "cleanup" ||
    action === "publish" ||
    action === "merge"
  ) {
    return isTaskRecord(value) ? summarizeTask(value) : boundedJson(value, ACTION_RESULT_MAX_CHARS);
  }
  if (action === "presentations" || action === "present" || action === "feedback") {
    return summarizePresentations(action, value);
  }
  if (typeof value === "string")
    return boundedOutput(compactText(value, ACTION_RESULT_MAX_CHARS), ACTION_RESULT_MAX_CHARS);
  return boundedJson(value, ACTION_RESULT_MAX_CHARS);
}

/** Build the small durable state block that survives OMP context compaction. */
export function buildDurableDigest(tasks: readonly TaskRecord[]): string {
  const lines = ["Tandem durable state (authoritative store; do not infer from chat):"];
  if (tasks.length === 0) {
    lines.push("- No tasks are currently recorded.");
    return boundedOutput(lines.join("\n"), DIGEST_MAX_CHARS);
  }
  lines.push(`- ${tasks.length} task(s) recorded.`);
  const ordered = prioritizeTasks(tasks);
  for (const task of ordered.slice(0, DIGEST_MAX_TASKS)) {
    const pending = pendingCount(task);
    const notificationSuffix = pending > 0 ? `; ${pending} pending notification(s)` : "";
    const heads = taskHeads(task);
    const headSuffix = heads.length === 0 ? "" : `; heads: ${compactList(heads, 4, 100)}`;
    const blockerSuffix =
      task.blockReason === undefined ? "" : `; blocker: ${compactText(task.blockReason)}`;
    const reportSuffix =
      task.reportPath === undefined ? "" : `; report: ${compactText(task.reportPath, 140)}`;
    lines.push(
      `- ${task.id}: ${task.stage}; ${compactText(task.objective)}${notificationSuffix}${blockerSuffix}${headSuffix}${reportSuffix}`,
    );
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
  if (tasks.length > DIGEST_MAX_TASKS)
    lines.push(`- ${tasks.length - DIGEST_MAX_TASKS} additional task(s) omitted from this digest.`);
  return boundedOutput(lines.join("\n"), DIGEST_MAX_CHARS);
}

export const COORDINATOR_TOOL_GUIDANCE = [
  "Use the tandem tool for durable state and actions; call it with {request: {action: ...}} and do not claim a task transition from prose.",
  "Tool text is a bounded action summary; full structured state remains in tool details and durable reports. Use show and report paths when deeper evidence is needed.",
  "Research/scout work is automatic after task creation; implementation still needs explicit scope approval.",
  "Within already approved scope, forward a clear user direction with steer without adding a redundant generic approval step; do not use it to widen scope or change pinned policy.",
  "Keep steering messages as concise deltas, batch independent pending directions in order, and explicitly supersede obsolete directions. Query messages only when the user asks or before a dependent decision, not in a repeated model-driven polling loop.",
  "Steer returns a queued receipt; let the child apply it at the next native safe boundary. Mechanical/UI receipt, heartbeat, and progress updates do not wake a model and do not require follow-up turns.",
  "If messages exposes a blocker, relay its Question and Recommendation, ask the user for a decision, then send answer with the current questionId. Query for the answer receipt only when the user asks or before a dependent decision; never claim the work is finished from enqueue or context receipt.",
  "Use present only for a useful visual artifact. The controller routes the brief and never authors HTML.",
  "Routine scheduler notifications, receipts, progress, and heartbeats are shown in the UI/durable log without a model turn; actionable blockers, judgment-needed reports, and PR-ready delivery notices may wake the coordinator.",
  "An undefined worker timeout has no default total-runtime kill; explicit positive limits, validation timeouts, and cancellation remain in force.",
  "Approval-bearing actions are human-confirmed at runtime and fail closed without interactive UI; safe cleanup does not require approval, while discard does.",
  "On first onboarding, inspect modelSettings.configured. If no choices are saved, call models, recommend one model for each job with a short reason, ask whether to use, adjust, or decline, then call configure-models only after approval and set up the project separately. Reuse saved choices on later projects; use models and configure-models for explicit updates.",
].join("\n");

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
    action.action === "cancel" ||
    action.action === "publish" ||
    action.action === "merge"
  );
}

function taskApprovalDetails(task: TaskRecord, includeDirections = false): string {
  const checkpoint =
    task.reviewHead ??
    task.worktree?.baseHead ??
    "service-pinned source checkpoint (exact hash is not materialized on this task record)";
  const worktree =
    task.worktree === undefined
      ? undefined
      : `worktree ${compactText(task.worktree.path, ACTION_SUMMARY_MAX_TEXT)}; branch ${compactText(task.worktree.branch, ACTION_SUMMARY_MAX_TEXT)}`;
  const pullRequest =
    task.pullRequest === undefined
      ? undefined
      : `pull request ${compactText(task.pullRequest.repository, 140)}#${task.pullRequest.number} ${task.pullRequest.state}; head ${compactText(task.pullRequest.head, 140)}; base ${compactText(task.pullRequest.base, 140)}`;
  const communicationDetails =
    includeDirections && task.communication !== undefined
      ? (() => {
          const entries = activeTaskMessages(task.communication);
          return `Communication revision ${task.communication.revision}; active deltas: ${
            entries.length === 0
              ? "none"
              : entries
                  .map(
                    (message) =>
                      `${message.kind} ${compactText(message.id, 100)}: ${compactText(message.text, MAX_TASK_MESSAGE_CHARS)}`,
                  )
                  .join("; ")
          }`;
        })()
      : undefined;
  return [
    `Repository: ${compactText(task.repoPath, ACTION_SUMMARY_MAX_TEXT)}`,
    `Scope: ${compactText(task.objective, ACTION_SUMMARY_MAX_TEXT)}`,
    `Acceptance criteria (${task.acceptanceCriteria.length}): ${compactList(task.acceptanceCriteria, 4, 110)}`,
    `Checkpoint: ${compactText(checkpoint, 160)}`,
    worktree === undefined ? undefined : `Worktree: ${worktree}`,
    pullRequest === undefined ? undefined : `Pull request: ${pullRequest}`,
    communicationDetails,
  ]
    .filter((entry): entry is string => entry !== undefined)
    .join("; ");
}

async function approvalPrompt(
  action: TandemAction,
  service: TandemService,
): Promise<Readonly<{ readonly title: string; readonly message: string }>> {
  if (action.action === "configure-models") {
    const choices = summarizeModelAssignments(action.models);
    const choiceDetails =
      choices.length === 0
        ? "No model choices were provided."
        : choices.map((entry) => `- ${entry}`).join("\n");
    return {
      title: "Save Tandem model choices?",
      message: `Proposed choices by job:\n${choiceDetails}\n\nThese choices will be saved on this computer and reused across projects for future work. They replace any saved choices. Saving them does not change the project or start work.`,
    };
  }
  if (action.action === "setup") {
    const onboarded = await service.onboard(action.repoPath, false);
    const project = projectName(onboarded.repoPath);
    return {
      title: `Save Tandem settings for ${project}?`,
      message:
        "Tandem will save these settings on this computer, outside the project. This does not change the app or start work.",
    };
  }
  if (!("taskId" in action))
    return { title: "Confirm Tandem action", message: "Allow this Tandem action?" };
  const task = await service.get(action.taskId);
  const details = taskApprovalDetails(task, action.action === "approve");
  switch (action.action) {
    case "approve":
      return {
        title: "Approve Tandem scope?",
        message: `Dispatch implementation for task ${action.taskId}: ${details}?`,
      };
    case "cancel":
      return {
        title: "Cancel Tandem task?",
        message: `Stop owned work for task ${action.taskId} and preserve reports: ${details}?`,
      };
    case "publish":
      return {
        title: "Publish reviewed pull request?",
        message: `Publish ${action.repository} (${action.title}, base ${action.base}) for task ${action.taskId}: ${details}?`,
      };
    case "merge":
      return {
        title: "Merge reviewed pull request?",
        message: `Merge task ${action.taskId} using ${action.method}: ${details}?`,
      };
    case "cleanup":
      return {
        title: "Discard Tandem task worktree?",
        message: `Discard owned worktree for task ${action.taskId}: ${details}?`,
      };
    default:
      return { title: "Confirm Tandem action", message: "Allow this Tandem action?" };
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
  };
}

/** Execute one validated extension action against the exact service contract. */
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
    case "onboard":
      return textResult(await service.onboard(action.repoPath, false), action.action);
    case "setup":
      return textResult(await service.onboard(action.repoPath, true), action.action, true);
    case "models":
      return textResult(await service.models(action.repoPath), action.action);
    case "configure-models":
      return textResult(
        await service.configureModels({ repoPath: action.repoPath, models: action.models }),
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

function renderActionResult(result: TandemActionResult): string {
  if (result.detail === "full") return boundedJson(result.value, ACTION_FULL_RESULT_MAX_CHARS);
  return summarizeTandemActionValue(result.action, result.value);
}

function toolResult(result: TandemActionResult): {
  content: { type: "text"; text: string }[];
  details: TandemToolDetails;
} {
  return {
    content: [{ type: "text", text: renderActionResult(result) }],
    details: {
      action: result.action,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.approved === undefined ? {} : { approved: result.approved }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    },
  };
}

function toolError(
  action: TandemAction["action"],
  error: unknown,
): {
  content: { type: "text"; text: string }[];
  details: TandemToolDetails;
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: `Tandem ${action} failed: ${compactText(message, ACTION_RESULT_MAX_CHARS)}`,
      },
    ],
    details: { action },
    isError: true,
  };
}

function taskNeedsCoordinatorJudgment(task: Pick<TaskRecord, "kind" | "stage">): boolean {
  if (task.stage === "blocked") return true;
  return task.kind === "scout" && task.stage === "completed";
}

function allPendingNotifications(tasks: readonly TaskRecord[]): readonly NotificationRef[] {
  const result: NotificationRef[] = [];
  for (const task of prioritizeTasks(tasks)) {
    const pending = task.notifications.filter((notification) => !notification.acknowledged);
    let latestLegacyId: string | undefined;
    for (let index = task.notifications.length - 1; index >= 0; index -= 1) {
      const notification = task.notifications[index];
      if (notification !== undefined && notification.kind === undefined) {
        latestLegacyId = notification.id;
        break;
      }
    }
    for (const notification of pending) {
      const judgmentNeeded =
        notification.kind === "coordinator" ||
        (notification.kind === undefined &&
          taskNeedsCoordinatorJudgment(task) &&
          notification.id === latestLegacyId);
      result.push({
        taskId: task.id,
        notificationId: notification.id,
        message: notification.message,
        judgmentNeeded,
      });
    }
  }
  return result;
}

type NotificationMessageSink = Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
type NotificationUi = Readonly<{ readonly ui: Pick<ExtensionContext["ui"], "notify"> }>;

function notificationContent(notifications: readonly NotificationRef[]): string {
  return notifications
    .map(
      (notification) =>
        `[${notification.taskId}] ${compactText(notification.message, ACTION_SUMMARY_MAX_TEXT)}`,
    )
    .join("\n");
}

/** Deliver pending notifications without turning routine scheduler work into model input. */
export async function deliverPendingNotifications(
  pi: NotificationMessageSink,
  service: Pick<TandemService, "acknowledge">,
  tasks: readonly TaskRecord[],
  delivered: Set<string>,
  ctx: NotificationUi,
): Promise<void> {
  const pending = allPendingNotifications(tasks).filter(
    (notification) => !delivered.has(`${notification.taskId}:${notification.notificationId}`),
  );
  if (pending.length === 0) return;
  const batch = pending.slice(0, MAX_NOTIFICATION_BATCH);
  const actionable = batch.filter((notification) => notification.judgmentNeeded);
  const routine = batch.filter((notification) => !notification.judgmentNeeded);
  for (const notification of batch)
    delivered.add(`${notification.taskId}:${notification.notificationId}`);
  try {
    if (routine.length > 0) {
      const content = notificationContent(routine);
      ctx.ui.notify(content, "info");
      pi.appendEntry(TANDEM_NOTIFICATION_ENTRY, { notifications: routine, content });
    }
    if (actionable.length > 0) {
      const content = notificationContent(actionable);
      pi.sendMessage(
        {
          customType: TANDEM_NOTIFICATION_ENTRY,
          content,
          display: true,
          details: { notifications: actionable },
          attribution: "agent",
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
    for (const notification of batch) {
      await service.acknowledge(notification.taskId, notification.notificationId);
    }
  } catch (error) {
    for (const notification of batch)
      delivered.delete(`${notification.taskId}:${notification.notificationId}`);
    throw error;
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
      return {
        action: "create",
        repoPath: value(1, "create"),
        kind,
        objective: value(3, "create objective"),
        acceptanceCriteria,
        surfaces,
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
    case "approve":
      return { action: "approve", taskId: value(1, "approve") };
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

function serviceForContext(options: TandemExtensionOptions, ctx: ExtensionContext): TandemService {
  if (options.service !== undefined) return options.service;
  const environment = resolveTandemEnvironment(
    processEnvironmentSnapshot(options.processEnvironment),
    { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
    {
      ...(options.environment?.home === undefined ? {} : { home: options.environment.home }),
      ...(options.environment?.sessionId === undefined
        ? {}
        : { sessionId: options.environment.sessionId }),
      ...(options.environment?.parentWorkspaceId === undefined
        ? {}
        : { parentWorkspaceId: options.environment.parentWorkspaceId }),
      ...(options.environment?.poolRoot === undefined
        ? {}
        : { poolRoot: options.environment.poolRoot }),
      ...(options.environment?.repo === undefined ? {} : { repo: options.environment.repo }),
    },
  );
  const createService = options.createService ?? createTandemService;
  return createService({
    home: environment.home,
    sessionId: environment.sessionId,
    ...(environment.parentWorkspaceId === undefined
      ? {}
      : { parentWorkspaceId: environment.parentWorkspaceId }),
    poolRoot: environment.poolRoot,
  });
}

async function refreshDigest(service: TandemService): Promise<string> {
  return buildDurableDigest(await service.list());
}

function logExtensionError(pi: ExtensionAPI, error: unknown): void {
  pi.logger.error("Tandem extension operation failed", {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Create the OMP extension factory; all mutable runtime state is per loaded extension instance. */
export function createTandemExtension(options: TandemExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    const z = pi.zod;
    let service: TandemService | undefined;
    let tickTimer: Timer | undefined;
    let tickInFlight: Promise<void> | undefined;
    let shuttingDown = false;
    const deliveredNotifications = new Set<string>();
    const getService = (ctx: ExtensionContext): TandemService => {
      if (service === undefined) service = serviceForContext(options, ctx);
      return service;
    };
    const reconcile = async (ctx: ExtensionContext, runTick: boolean): Promise<void> => {
      if (shuttingDown) return;
      if (tickInFlight !== undefined) return tickInFlight;
      tickInFlight = (async (): Promise<void> => {
        const current = getService(ctx);
        const tasks = runTick ? await current.tick() : await current.list();
        await deliverPendingNotifications(pi, current, tasks, deliveredNotifications, ctx);
      })().finally(() => {
        tickInFlight = undefined;
      });
      return tickInFlight;
    };

    const modelSpecSchema = z
      .object({
        model: z.string(),
        thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]),
      })
      .strict();
    const modelAssignmentsSchema = z
      .object({
        coordinator: modelSpecSchema,
        scout: modelSpecSchema,
        implementer: modelSpecSchema,
        reviewer: modelSpecSchema,
        verifier: modelSpecSchema,
        presentation: modelSpecSchema,
      })
      .strict();
    const actionSchema = z.union([
      z.object({ action: z.literal("onboard"), repoPath: z.string() }).strict(),
      z.object({ action: z.literal("setup"), repoPath: z.string() }).strict(),
      z.object({ action: z.literal("models"), repoPath: z.string() }).strict(),
      z
        .object({
          action: z.literal("configure-models"),
          repoPath: z.string(),
          models: modelAssignmentsSchema,
        })
        .strict(),
      z
        .object({
          action: z.literal("create"),
          repoPath: z.string(),
          kind: z.enum(["scout", "implementation"]),
          objective: z.string(),
          acceptanceCriteria: z.array(z.string()),
          surfaces: z.array(z.string()),
        })
        .strict(),
      z.object({ action: z.literal("list") }).strict(),
      z.object({ action: z.literal("presentations") }).strict(),
      z
        .object({
          action: z.literal("show"),
          taskId: z.string(),
          detail: z.enum(["summary", "full"]).optional(),
        })
        .strict(),
      z
        .object({
          action: z.literal("steer"),
          taskId: z.string(),
          text: z.string(),
          supersedes: z.array(z.string()).optional(),
        })
        .strict(),
      z
        .object({
          action: z.literal("answer"),
          taskId: z.string(),
          questionId: z.string(),
          text: z.string(),
        })
        .strict(),
      z.object({ action: z.literal("messages"), taskId: z.string() }).strict(),
      z.object({ action: z.literal("approve"), taskId: z.string() }).strict(),
      z.object({ action: z.literal("tick") }).strict(),
      z
        .object({ action: z.literal("pause"), taskId: z.string(), reason: z.string().optional() })
        .strict(),
      z.object({ action: z.literal("resume"), taskId: z.string() }).strict(),
      z
        .object({ action: z.literal("cancel"), taskId: z.string(), reason: z.string().optional() })
        .strict(),
      z
        .object({
          action: z.literal("present"),
          taskId: z.string(),
          objective: z.string(),
          artifacts: z.array(z.string()),
        })
        .strict(),
      z
        .object({
          action: z.literal("describe"),
          taskId: z.string(),
          summary: z
            .object({
              tldr: z.array(z.string()),
              what: z.array(z.string()),
              why: z.array(z.string()),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          action: z.literal("publish"),
          taskId: z.string(),
          repository: z.string(),
          title: z.string(),
          base: z.string(),
          summary: z
            .object({
              tldr: z.array(z.string()),
              what: z.array(z.string()),
              why: z.array(z.string()),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          action: z.literal("merge"),
          taskId: z.string(),
          method: z.enum(["merge", "squash", "rebase"]),
        })
        .strict(),
      z
        .object({
          action: z.literal("cleanup"),
          taskId: z.string(),
          discard: z.boolean().optional(),
        })
        .strict(),
    ]);
    const requestSchema = z.object({ request: actionSchema }).strict();

    pi.registerTool({
      name: "tandem",
      label: "Tandem",
      description:
        "Inspect and control durable Tandem state with {request:{action:...}}, including bounded steer/answer/messages communication. Approval-bearing actions always require human confirmation; communication receipts never claim implementation completion.",
      parameters: requestSchema,
      strict: true,
      approval: "write",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const request = params.request;
        try {
          const result = await executeTandemAction(request, getService(ctx), ctx, signal);
          if (request.action === "tick") {
            await reconcile(ctx, false);
          } else {
            const current = getService(ctx);
            const tasks = await current.list();
            await deliverPendingNotifications(pi, current, tasks, deliveredNotifications, ctx);
          }
          return toolResult(result);
        } catch (error) {
          return toolError(request.action, error);
        }
      },
    });

    pi.registerCommand("tandem", {
      description:
        "Inspect or control Tandem: list, presentations, show, messages, models, onboard, setup, create, approve, steer, answer, tick, pause, resume, cancel, present, feedback, describe, publish, merge, cleanup.",
      handler: async (args, ctx) => {
        try {
          const parsedAction = parseTandemCommand(args);
          const action =
            parsedAction.action === "models" && parsedAction.repoPath === "."
              ? { ...parsedAction, repoPath: ctx.cwd }
              : parsedAction;
          const result = await executeTandemAction(action, getService(ctx), ctx);
          const current = getService(ctx);
          await deliverPendingNotifications(
            pi,
            current,
            await current.list(),
            deliveredNotifications,
            ctx,
          );
          ctx.ui.notify(renderActionResult(result), "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Tandem command failed: ${message}`, "error");
        }
      },
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const digest = await refreshDigest(getService(ctx));
      return {
        systemPrompt: [
          ...event.systemPrompt,
          COORDINATOR_INSTRUCTIONS,
          COORDINATOR_TOOL_GUIDANCE,
          digest,
        ],
      };
    });

    pi.on("session_start", async (_event, ctx) => {
      if (shuttingDown) return;
      if (tickTimer === undefined) {
        const interval = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
        if (!Number.isFinite(interval) || interval <= 0)
          throw new TypeError("tickIntervalMs must be a positive finite number");
        tickTimer = ctx.setInterval(() => {
          void reconcile(ctx, true).catch((error) => logExtensionError(pi, error));
        }, interval);
      }
      await reconcile(ctx, true);
    });

    pi.on("session.compacting", async (_event, ctx) => {
      const digest = await refreshDigest(getService(ctx));
      return {
        context: [COORDINATOR_INSTRUCTIONS, COORDINATOR_TOOL_GUIDANCE, digest],
        preserveData: { tandemDigest: digest },
      };
    });

    pi.on("session_compact", async (_event, ctx) => {
      await reconcile(ctx, true);
      const digest = await refreshDigest(getService(ctx));
      pi.appendEntry("tandem-digest", { digest });
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const inFlight = tickInFlight;
      shuttingDown = true;
      if (tickTimer !== undefined) ctx.clearTimer(tickTimer);
      tickTimer = undefined;
      try {
        if (service !== undefined) await service.shutdown();
      } finally {
        if (inFlight !== undefined) await inFlight;
      }
    });
  };
}

const defaultExtension = createTandemExtension();
export default defaultExtension;
