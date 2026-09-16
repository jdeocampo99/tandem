import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireWorktree,
  closeEndpoint,
  createReviewerEndpoint,
  createTaskEndpoint,
  EndpointOwnershipError,
  type GitCheckpoint,
  type HerdrEndpointResult,
  type HerdrPaneInspection,
  inspectEndpoint,
  interruptEndpoint,
  LeaseSafetyError,
  listOmpModels,
  type OmpModelRecord,
  readCheckpoint,
  releaseWorktree,
  sendCommand,
  taskWorkspaceLabel,
} from "./adapters.ts";
import { runCommand } from "./commands.ts";
import {
  activeTaskMessages,
  appendTaskMessage,
  formatTaskMessages,
  MAX_TASK_MESSAGE_CHARS,
  readTaskInbox,
  readWorkerReceipt,
  taskInbox,
  taskInboxPath,
  workerReceiptPath,
  writeTaskInbox,
} from "./communication.ts";
import type {
  AgentRole,
  AnswerTaskInput,
  Clock,
  CommandRunner,
  Endpoint,
  Finding,
  IdFactory,
  IsoTimestamp,
  Notification,
  RepoPolicy,
  ReviewLens,
  SteerTaskInput,
  TaskCommunicationView,
  TaskQuestion,
  TaskRecord,
  WorkerReceipt,
} from "./contracts.ts";
import {
  describeTaskPr,
  mergeReviewedTask,
  type PrSummary,
  publishReviewedTask,
} from "./delivery.ts";
import { type AgentBriefReview, buildAgentBrief } from "./instructions.ts";
import {
  parseWorkerJob,
  readWorkerResult,
  type WorkerJob,
  type WorkerResult,
  type WorkerRole,
} from "./jobs.ts";
import { type TaskEvent, type TaskTransitionContext, transitionTask } from "./lifecycle.ts";
import {
  type ModelSettings,
  type OnboardRepoResult,
  onboardRepo,
  parseModelAssignments,
  readModelSettings,
  resolveRepoPolicy,
  writeModelSettings,
} from "./policy.ts";
import { maintainPool, type PoolMaintenanceResult } from "./pool.ts";
import {
  completePresentation,
  type PendingPresentationNotification,
  type PresentationObservation,
  type PresentationRecord,
  preparePresentation,
  presentationNotificationForTransition,
  readPresentationFeedback,
  writePresentationFeedbackEvidence,
} from "./presentation.ts";
import {
  activeReservations,
  activeRuntimeJob,
  type DurableEndpointLaunch,
  type DurableJob,
  type DurableJobConsumption,
  type DurableReservation,
  type DurableStopRequest,
  defaultIdFactory,
  presentationRuntime,
  type RuntimePresentation,
  type RuntimeState,
  type RuntimeTaskState,
  readRuntimeState,
  runtimeFile,
  taskJobsDirectory,
  taskRuntime,
  taskSessionDirectory,
  updateRuntimeState,
  writeJsonAtomically,
  writeRuntimeState,
  writeTextAtomically,
} from "./runtime.ts";
import {
  acquireDarwinFileLock,
  createTaskStore,
  StoreLockTimeoutError,
  type StoreTaskInput,
  type TaskStore,
  transitionStoredTask,
} from "./store.ts";
import {
  readValidationResult,
  type ValidationJob,
  type ValidationResult,
} from "./validation-worker.ts";

export type CreateTaskRequest = Readonly<{
  readonly repoPath: string;
  readonly kind: "scout" | "implementation";
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly surfaces: readonly string[];
}>;
export type ModelOptionsResult = Readonly<{
  readonly modelSettings: ModelSettings;
  readonly availableModels: readonly OmpModelRecord[];
}>;
export type TandemServiceOptions = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly parentWorkspaceId?: string;
  readonly poolRoot?: string;
  readonly workerTimeoutMs?: number;
  readonly run?: CommandRunner;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
}>;

export type TandemService = Readonly<{
  readonly onboard: (repoPath: string, write?: boolean) => Promise<OnboardRepoResult>;
  readonly models: (repoPath: string) => Promise<ModelOptionsResult>;
  readonly configureModels: (
    input: Readonly<{
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
    }>,
  ) => Promise<ModelSettings>;
  readonly create: (input: CreateTaskRequest) => Promise<TaskRecord>;
  readonly list: () => Promise<readonly TaskRecord[]>;
  readonly get: (id: string) => Promise<TaskRecord>;
  readonly approve: (id: string) => Promise<TaskRecord>;
  readonly tick: () => Promise<readonly TaskRecord[]>;
  readonly steer: (input: SteerTaskInput) => Promise<TaskCommunicationView>;
  readonly answer: (input: AnswerTaskInput) => Promise<TaskCommunicationView>;
  readonly messages: (taskId: string) => Promise<TaskCommunicationView>;
  readonly pause: (id: string, reason?: string) => Promise<TaskRecord>;
  readonly resume: (id: string) => Promise<TaskRecord>;
  readonly cancel: (id: string, reason?: string) => Promise<TaskRecord>;
  readonly acknowledge: (id: string, notificationId: string) => Promise<TaskRecord>;
  readonly describePr: (id: string, summary: PrSummary) => Promise<string>;
  readonly publish: (
    id: string,
    input: {
      readonly repository: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
      readonly approved: boolean;
    },
  ) => Promise<TaskRecord>;
  readonly merge: (
    id: string,
    input: { readonly approved: boolean; readonly method?: "merge" | "squash" | "rebase" },
  ) => Promise<TaskRecord>;
  readonly cleanup: (
    id: string,
    input?: { readonly discard?: boolean; readonly destructiveApproval?: boolean },
  ) => Promise<TaskRecord>;
  readonly present: (
    id: string,
    input: { readonly objective: string; readonly artifacts: readonly string[] },
  ) => Promise<PresentationRecord>;
  readonly presentations: () => Promise<readonly PresentationRecord[]>;
  readonly feedback: (presentationId: string, signal?: AbortSignal) => Promise<PresentationRecord>;
  readonly shutdown: () => Promise<void>;
}>;

type ServiceDependencies = Readonly<{
  home: string;
  sessionId: string;
  parentWorkspaceId: string | undefined;
  poolRoot: string;
  workerTimeoutMs: number | undefined;
  run: CommandRunner;
  clock: Clock;
  idFactory: IdFactory;
  store: TaskStore;
  runtimePath: string;
  workerPath: string;
  validationWorkerPath: string;
}>;

type ReservationResult = Readonly<{
  readonly task: TaskRecord;
  readonly runtime: RuntimeTaskState;
  readonly reservation: DurableReservation;
}>;

type PresentationPollState = Readonly<{
  readonly promise: Promise<PresentationRecord>;
  readonly controller: AbortController;
}>;

type CurrentCheckout = Readonly<{
  readonly checkpoint: GitCheckpoint;
  readonly expectedHead: string;
}>;
type ControlAction = "pause" | "cancel";

type HerdrWorkspaceObservation = Readonly<{
  readonly workspaceId: string;
  readonly activeTabId: string;
  readonly label: string;
}>;

type HerdrPaneObservation = Readonly<{
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly foregroundCwd: string | undefined;
}>;
type EndpointLaunchRecovery =
  | Readonly<{ readonly status: "recovered"; readonly endpoint: Endpoint }>
  | Readonly<{ readonly status: "pending"; readonly detail: string }>
  | Readonly<{ readonly status: "ambiguous"; readonly detail: string }>;
type OwnedEndpointProbe = Readonly<{
  readonly status: "active" | "stopped" | "missing" | "rejected";
  readonly detail: string | undefined;
}>;
type TerminalResultProbe =
  | Readonly<{ readonly status: "valid" }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{ readonly status: "invalid"; readonly detail: string }>;

type ResumeResourceCheck = Readonly<{
  readonly failure: string | undefined;
  readonly abandonedJobIds: readonly string[];
  readonly terminalJobIds: readonly string[];
}>;
const DEFAULT_STARTUP_GRACE_MS = 15 * 1000;
const DEFAULT_STALL_WARNING_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_GRACE_MS = 60 * 1000;
const PRESENTATION_LOCK_TIMEOUT_MS = 5_000;
const PRESENTATION_LOCK_POLL_MS = 20;
const MANUAL_SHARED_FEEDBACK_WAIT_MS = 1_000;

const REQUIRED_REVIEW_LENSES: readonly ReviewLens[] = [
  "behavior",
  "design",
  "coverage",
  "verification",
];
const MODEL_ROLES = [
  "coordinator",
  "scout",
  "implementer",
  "reviewer",
  "verifier",
  "presentation",
] as const satisfies readonly AgentRole[];
function isTerminalTask(task: TaskRecord): boolean {
  return task.stage === "cancelled" || task.stage === "completed" || task.stage === "merged";
}
function poolAdmissionKey(
  result: PoolMaintenanceResult,
): "capacity-unknown" | "capacity-insufficient" | undefined {
  if (result.canAllocate) return undefined;
  return result.availableBytes === null ? "capacity-unknown" : "capacity-insufficient";
}

function poolAdmissionNotice(result: PoolMaintenanceResult): string {
  return (
    result.allocationBlocker ??
    (result.availableBytes === null
      ? "pool capacity could not be verified; allocation is blocked until capacity can be checked"
      : "pool has insufficient free space for a new worktree; free space and retry")
  );
}
const POOL_NOTICE_PREFIX = "Pool admission blocked [";

function poolNotificationMessage(
  key: "capacity-unknown" | "capacity-insufficient",
  notice: string,
): string {
  return `${POOL_NOTICE_PREFIX}${key}]: ${notice}`;
}

function isPoolNotification(notification: Notification): boolean {
  return notification.message.startsWith(POOL_NOTICE_PREFIX);
}

function isPoolNotificationForKey(
  notification: Notification,
  key: "capacity-unknown" | "capacity-insufficient",
): boolean {
  return notification.message.startsWith(`${POOL_NOTICE_PREFIX}${key}]:`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text without NUL characters`);
  }
  return value.trim();
}

function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function pathText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty path without NUL characters`);
  }
  if (hasPathControlCharacter(value)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  return value;
}

function singleLine(value: unknown, field: string): string {
  const result = text(value, field);
  if (/[\r\n\u2028\u2029]/u.test(result)) throw new TypeError(`${field} must be single-line`);
  return result;
}

function absoluteDirectory(value: unknown, field: string): string {
  const result = pathText(value, field);
  if (!isAbsolute(result)) throw new TypeError(`${field} must be absolute`);
  return resolve(result);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}
function readTextList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings`);
  const values: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    values.push(text(value[index], `${field}[${index}]`));
  }
  return values;
}

function validateModelAssignments(
  assignments: RepoPolicy["models"],
  availableModels: readonly OmpModelRecord[],
): void {
  for (const role of MODEL_ROLES) {
    const assignment = assignments[role];
    const matches = availableModels.filter((candidate) => candidate.selector === assignment.model);
    if (matches.length !== 1) {
      throw new Error(
        `${role} selector ${JSON.stringify(assignment.model)} matched ${matches.length} available models; no fallback is allowed`,
      );
    }
    const model = matches[0];
    if (model === undefined) {
      throw new Error(
        `${role} selector ${JSON.stringify(assignment.model)} matched no available model`,
      );
    }
    if (!model.thinking.includes(assignment.thinking)) {
      throw new Error(
        `${role} selector ${JSON.stringify(assignment.model)} does not support thinking ${JSON.stringify(assignment.thinking)}`,
      );
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return String(error);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isMissingEndpoint(error: unknown): boolean {
  return error instanceof EndpointOwnershipError && error.reason === "missing";
}

function nowMilliseconds(clock: Clock): number {
  const value = Date.parse(clock());
  return Number.isFinite(value) ? value : Date.now();
}

function isOlderThan(createdAt: IsoTimestamp, clock: Clock, ageMs: number): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  return nowMilliseconds(clock) - created >= ageMs;
}

function replaceRuntimeTask(
  state: RuntimeState,
  taskId: string,
  transform: (task: RuntimeTaskState) => RuntimeTaskState,
): RuntimeState {
  let found = false;
  const tasks = state.tasks.map((task) => {
    if (task.taskId !== taskId) return task;
    found = true;
    return transform(task);
  });
  if (!found) throw new Error(`runtime state has no task ${taskId}`);
  return { ...state, tasks };
}

function replaceRuntimePresentation(
  state: RuntimeState,
  id: string,
  transform: (presentation: RuntimePresentation) => RuntimePresentation,
): RuntimeState {
  let found = false;
  const presentations = state.presentations.map((presentation) => {
    if (presentation.id !== id) return presentation;
    found = true;
    return transform(presentation);
  });
  if (!found) throw new Error(`runtime state has no presentation ${id}`);
  return { ...state, presentations };
}

function presentationPendingNotifications(
  record: Pick<PresentationRecord, "pendingNotification" | "pendingNotificationQueue">,
): readonly PendingPresentationNotification[] {
  const queued = record.pendingNotificationQueue ?? [];
  return record.pendingNotification === undefined
    ? queued
    : [record.pendingNotification, ...queued];
}

function hasPendingPresentationNotification(
  record: Pick<PresentationRecord, "pendingNotification" | "pendingNotificationQueue">,
): boolean {
  return presentationPendingNotifications(record).length > 0;
}

function presentationFeedbackLockPath(recordPath: string): string {
  return join(dirname(recordPath), ".feedback.lock");
}
async function withPresentationLock<Result>(
  recordPath: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  const release = await acquireDarwinFileLock(
    presentationFeedbackLockPath(recordPath),
    PRESENTATION_LOCK_TIMEOUT_MS,
    PRESENTATION_LOCK_POLL_MS,
    signal,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

function samePresentationRecord(left: PresentationRecord, right: PresentationRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendTaskJob(task: RuntimeTaskState, job: DurableJob): RuntimeTaskState {
  if (task.jobs.some((entry) => entry.id === job.id)) {
    throw new Error(`runtime task ${task.taskId} already contains job ${job.id}`);
  }
  if (task.jobs.some(activeRuntimeJob)) {
    throw new Error(`runtime task ${task.taskId} already has an active job`);
  }
  return { ...task, jobs: [...task.jobs, job] };
}

function replaceJob(
  task: RuntimeTaskState,
  jobId: string,
  transform: (job: DurableJob) => DurableJob,
): RuntimeTaskState {
  let found = false;
  const jobs = task.jobs.map((job) => {
    if (job.id !== jobId) return job;
    found = true;
    return transform(job);
  });
  if (!found) throw new Error(`runtime task ${task.taskId} has no job ${jobId}`);
  return { ...task, jobs };
}

function runtimeReservation(
  id: string,
  taskId: string,
  sessionId: string,
  now: IsoTimestamp,
): DurableReservation {
  return {
    schemaVersion: 1,
    id,
    taskId,
    ownerSessionId: sessionId,
    phase: "reserved",
    createdAt: now,
  };
}

function workerRoleForTask(task: TaskRecord): WorkerRole {
  return task.kind === "scout" ? "scout" : "implementer";
}

function roleChannel(role: WorkerRole): "implementation" | "review" {
  return role === "reviewer" || role === "verifier" ? "review" : "implementation";
}

function reportPathFor(jobPath: string): string {
  return join(dirname(jobPath), "report.txt");
}

function jobDirectoryFor(home: string, taskId: string, generation: number, jobId: string): string {
  return join(taskJobsDirectory(home, taskId), String(generation), jobId);
}

function jobPaths(directory: string): Readonly<{ jobPath: string; resultPath: string }> {
  return { jobPath: join(directory, "job.json"), resultPath: join(directory, "result.json") };
}

function currentWriter(runtime: RuntimeTaskState): Endpoint | undefined {
  const writer = runtime.endpoints.find(
    (endpoint) => endpoint.role === "scout" || endpoint.role === "implementer",
  );
  return writer;
}

function currentReviewer(runtime: RuntimeTaskState): Endpoint | undefined {
  return runtime.endpoints.find(
    (endpoint) => endpoint.role === "reviewer" || endpoint.role === "verifier",
  );
}

function reviewFindings(task: TaskRecord): readonly Finding[] {
  const findings: Finding[] = [];
  for (const review of task.reviews) {
    if (review.head !== task.reviewHead || review.generation !== task.generation || review.pass)
      continue;
    findings.push(...review.findings);
  }
  return findings;
}

function buildPrompt(
  task: TaskRecord,
  role: WorkerRole,
  reportPath: string,
  artifacts: readonly string[],
  review: AgentBriefReview | undefined,
  extraInstructions: readonly string[] = [],
): string {
  const guidance = task.policy.guidance[roleChannel(role)].map((entry) => entry.text);
  return buildAgentBrief({
    role,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    instructions: [...guidance, ...extraInstructions],
    reportPath,
    ...(review === undefined ? {} : { review }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
  });
}

function makeDurableJob(
  taskId: string,
  generation: number,
  role: DurableJob["role"],
  kind: DurableJob["kind"],
  cwd: string,
  jobPath: string,
  resultPath: string,
  attempt: number,
  now: IsoTimestamp,
  extras: Readonly<{
    endpoint?: Endpoint;
    head?: string;
    reviewLens?: ReviewLens;
    receiptPath?: string;
    instructionRevision?: number;
  }> = {},
): DurableJob {
  return {
    schemaVersion: 1,
    id: jobPath.split("/").at(-2) ?? jobPath,
    taskId,
    generation,
    role,
    kind,
    cwd,
    jobPath,
    resultPath,
    attempt,
    phase: "reserved",
    launchAttempted: false,
    createdAt: now,
    ...(extras.endpoint === undefined ? {} : { endpoint: extras.endpoint }),
    ...(extras.head === undefined ? {} : { head: extras.head }),
    ...(extras.reviewLens === undefined ? {} : { reviewLens: extras.reviewLens }),
    ...(extras.receiptPath === undefined ? {} : { receiptPath: extras.receiptPath }),
    ...(extras.instructionRevision === undefined
      ? {}
      : { instructionRevision: extras.instructionRevision }),
  };
}

function workerCommand(scriptPath: string, jobPath: string): readonly string[] {
  return ["bun", scriptPath, jobPath];
}

function taskNameFor(task: TaskRecord): string {
  return `tandem-${task.id}`;
}
function endpointLaunchFor(
  reservation: DurableReservation,
  sessionId: string,
  taskName: string,
  cwd: string,
  role: Endpoint["role"],
  generation: number,
  now: IsoTimestamp,
  parentWorkspaceId: string | undefined,
): DurableEndpointLaunch {
  return {
    schemaVersion: 1,
    reservationId: reservation.id,
    sessionId,
    taskName,
    workspaceLabel: taskWorkspaceLabel(taskName),
    cwd,
    role,
    generation,
    createdAt: now,
    ...(parentWorkspaceId === undefined ? {} : { parentWorkspaceId }),
  };
}

function serializedIdentity(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${field} could not be serialized`);
  return serialized;
}

function taskFingerprint(task: TaskRecord): string {
  return serializedIdentity(task, "task record");
}
function taskWithQuestion(task: TaskRecord, question: TaskQuestion): TaskRecord {
  if (task.communication?.question?.id === question.id) return task;
  const notifications = [...task.notifications];
  const latest = notifications.at(-1);
  if (latest !== undefined) {
    notifications[notifications.length - 1] = { ...latest, kind: "coordinator" };
  }
  return {
    ...task,
    communication: {
      ...(task.communication ?? { revision: 0, messages: [] }),
      question,
    },
    notifications,
  };
}
function instructionOptions(
  revision: number | undefined,
): Readonly<{ readonly instructionRevision?: number }> {
  return revision === undefined ? {} : { instructionRevision: revision };
}
function taskWithQuestionCommit(
  task: TaskRecord,
  question: TaskQuestion,
  now: IsoTimestamp,
): TaskRecord {
  const updated = taskWithQuestion(task, question);
  return updated === task ? task : { ...updated, revision: task.revision + 1, updatedAt: now };
}

function inputEventKey(jobId: string, event: TaskEvent): string {
  return `${jobId}:${serializedIdentity(event, "task event")}`;
}

function hasEvidenceSuffix(
  task: TaskRecord,
  evidence: readonly TaskRecord["validationEvidence"][number][],
): boolean {
  if (evidence.length > task.validationEvidence.length) return false;
  const start = task.validationEvidence.length - evidence.length;
  return JSON.stringify(task.validationEvidence.slice(start)) === JSON.stringify(evidence);
}

function recognizesAppliedEvent(task: TaskRecord, event: TaskEvent): boolean {
  switch (event.type) {
    case "scout-report-complete":
      return (
        task.kind === "scout" &&
        task.stage === "completed" &&
        task.generation === event.generation &&
        task.reportPath === event.reportPath
      );
    case "implementation-complete":
      return (
        task.kind === "implementation" &&
        task.generation === event.generation &&
        task.reviewHead === event.head &&
        task.reportPath === event.reportPath &&
        task.stage !== "implementing"
      );
    case "validation-succeeded":
      return (
        task.kind === "implementation" &&
        task.reviewHead === event.head &&
        task.generation === event.generation &&
        hasEvidenceSuffix(task, event.evidence) &&
        ["reviewing", "awaiting-fixes", "ready", "merged"].includes(task.stage)
      );
    case "validation-failed":
      return (
        task.kind === "implementation" &&
        task.reviewHead === event.head &&
        task.generation === event.generation &&
        hasEvidenceSuffix(task, event.evidence) &&
        ["awaiting-fixes", "implementing", "validating"].includes(task.stage)
      );
    case "record-review":
      return (
        task.kind === "implementation" &&
        task.reviewHead === event.review.head &&
        task.generation === event.review.generation &&
        task.reviews.some((review) => JSON.stringify(review) === JSON.stringify(event.review))
      );
    case "block":
      return task.stage === "blocked" && task.blockReason === event.reason;
    default:
      return false;
  }
}

function taskInputFor(
  request: CreateTaskRequest,
  repoPath: string,
  policy: TaskRecord["policy"],
): StoreTaskInput {
  return {
    repoPath,
    kind: request.kind,
    objective: text(request.objective, "objective"),
    acceptanceCriteria: readTextList(request.acceptanceCriteria, "acceptanceCriteria"),
    surfaces: readTextList(request.surfaces, "surfaces"),
    policy,
  };
}

function assertTaskId(id: unknown): string {
  return singleLine(id, "task id");
}

function assertArtifacts(artifacts: unknown): readonly string[] {
  return readTextList(artifacts, "artifacts");
}

function parseEndpointValue(value: unknown, field: string): Endpoint {
  if (!isRecord(value)) throw new TypeError(`${field} must be an endpoint object`);
  const roles: readonly AgentRole[] = [
    "coordinator",
    "scout",
    "implementer",
    "reviewer",
    "verifier",
    "presentation",
  ];
  const role = value.role;
  if (typeof role !== "string" || !roles.includes(role as AgentRole))
    throw new TypeError(`${field}.role is invalid`);
  const generation = value.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0)
    throw new TypeError(`${field}.generation is invalid`);
  return {
    sessionId: singleLine(value.sessionId, `${field}.sessionId`),
    workspaceId: singleLine(value.workspaceId, `${field}.workspaceId`),
    tabId: singleLine(value.tabId, `${field}.tabId`),
    paneId: singleLine(value.paneId, `${field}.paneId`),
    role: role as AgentRole,
    generation: generation as number,
  };
}
function parsePresentationObservation(value: unknown, source: string): PresentationObservation {
  if (!isRecord(value)) throw new TypeError(`${source} must be an observation object`);
  const statuses: readonly PresentationObservation["status"][] = [
    "feedback",
    "ended",
    "waiting",
    "missing",
    "unknown",
    "error",
    "browser_disconnected",
    "opened",
    "ready",
    "user-ended",
  ];
  const status = value.status;
  if (
    typeof status !== "string" ||
    !statuses.includes(status as PresentationObservation["status"])
  ) {
    throw new TypeError(`${source}.status is invalid`);
  }
  const readRaw = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== "string" || raw.includes("\0"))
      throw new TypeError(`${source}.${field} must be text`);
    return raw;
  };
  const terminal = value.terminal;
  const sessionEnded = value.sessionEnded;
  const sessionUrl =
    value.sessionUrl === undefined
      ? undefined
      : singleLine(value.sessionUrl, `${source}.sessionUrl`);
  if (typeof terminal !== "boolean" || typeof sessionEnded !== "boolean") {
    throw new TypeError(`${source}.terminal and ${source}.sessionEnded must be booleans`);
  }
  return {
    artifact: absoluteDirectory(value.artifact, `${source}.artifact`),
    status: status as PresentationObservation["status"],
    terminal,
    sessionEnded,
    ...(sessionUrl === undefined ? {} : { sessionUrl }),
    raw: readRaw("raw"),
    rawFeedback: readRaw("rawFeedback"),
  };
}

function parsePendingPresentationNotification(
  value: unknown,
  source: string,
): PendingPresentationNotification {
  if (!isRecord(value)) throw new TypeError(`${source} must be an object`);
  const id = singleLine(value.id, `${source}.id`);
  const message = text(value.message, `${source}.message`);
  const kind = value.kind;
  if (kind !== "routine" && kind !== "coordinator") {
    throw new TypeError(`${source}.kind is invalid`);
  }
  return { id, message, kind };
}

function parsePendingPresentationNotificationQueue(
  value: unknown,
  source: string,
): readonly PendingPresentationNotification[] {
  if (!Array.isArray(value)) throw new TypeError(`${source} must be an array`);
  return value.map((entry, index) =>
    parsePendingPresentationNotification(entry, `${source}[${index}]`),
  );
}

function parsePresentationRecord(value: unknown, source: string): PresentationRecord {
  if (!isRecord(value)) throw new TypeError(`${source} must be an object`);
  const statuses: readonly PresentationRecord["status"][] = [
    "queued",
    "running",
    "open",
    "ended",
    "failed",
  ];
  const status = value.status;
  if (typeof status !== "string" || !statuses.includes(status as PresentationRecord["status"])) {
    throw new TypeError(`${source}.status is invalid`);
  }
  const endpoint =
    value.endpoint === undefined
      ? undefined
      : parseEndpointValue(value.endpoint, `${source}.endpoint`);
  const observation =
    value.observation === undefined
      ? undefined
      : parsePresentationObservation(value.observation, `${source}.observation`);
  const sessionUrl =
    value.sessionUrl === undefined
      ? observation?.sessionUrl
      : singleLine(value.sessionUrl, `${source}.sessionUrl`);
  const pendingNotification =
    value.pendingNotification === undefined
      ? undefined
      : parsePendingPresentationNotification(
          value.pendingNotification,
          `${source}.pendingNotification`,
        );
  const pendingNotificationQueue =
    value.pendingNotificationQueue === undefined
      ? undefined
      : parsePendingPresentationNotificationQueue(
          value.pendingNotificationQueue,
          `${source}.pendingNotificationQueue`,
        );
  const error = value.error === undefined ? undefined : text(value.error, `${source}.error`);
  return {
    id: singleLine(value.id, `${source}.id`),
    taskId: singleLine(value.taskId, `${source}.taskId`),
    generation: nonNegativeInteger(value.generation, `${source}.generation`),
    cwd: absoluteDirectory(value.cwd, `${source}.cwd`),
    artifactPath: absoluteDirectory(value.artifactPath, `${source}.artifactPath`),
    jobPath: absoluteDirectory(value.jobPath, `${source}.jobPath`),
    resultPath: absoluteDirectory(value.resultPath, `${source}.resultPath`),
    status: status as PresentationRecord["status"],
    createdAt: singleLine(value.createdAt, `${source}.createdAt`),
    updatedAt: singleLine(value.updatedAt, `${source}.updatedAt`),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(sessionUrl === undefined ? {} : { sessionUrl }),
    ...(observation === undefined ? {} : { observation }),
    ...(pendingNotification === undefined ? {} : { pendingNotification }),
    ...(pendingNotificationQueue === undefined ? {} : { pendingNotificationQueue }),
    ...(error === undefined ? {} : { error }),
  };
}

async function readPresentationRecord(path: string): Promise<PresentationRecord> {
  const contents = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TypeError(`presentation record is invalid JSON: ${describeError(error)}`);
  }
  return parsePresentationRecord(parsed, path);
}

async function inspectStopped(
  run: CommandRunner,
  endpoint: Endpoint,
  cwd: string,
): Promise<boolean> {
  const inspection = await inspectEndpoint(run, { endpoint, cwd });
  return !inspection.activeWorker;
}
function parseHerdrPayload(raw: string, operation: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) throw new Error(`${operation} returned a non-object response`);
  return parsed;
}

async function readHerdrPayload(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
  args: readonly string[],
  operation: string,
): Promise<Record<string, unknown>> {
  const result = await run({
    argv: ["herdr", "--session", singleLine(sessionId, "sessionId"), ...args],
    cwd: absoluteDirectory(cwd, "cwd"),
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim().length === 0 ? result.stdout.trim() : result.stderr.trim();
    throw new Error(`${operation} failed with exit code ${result.code}: ${detail}`);
  }
  return parseHerdrPayload(result.stdout, operation);
}

function herdrResult(payload: Record<string, unknown>, operation: string): Record<string, unknown> {
  const result = payload.result;
  if (!isRecord(result)) throw new Error(`${operation} response.result must be an object`);
  return result;
}

function requiredHerdrText(value: unknown, field: string, operation: string): string {
  try {
    return singleLine(value, field);
  } catch (error) {
    throw new Error(`${operation} ${field} is invalid: ${describeError(error)}`, { cause: error });
  }
}

function parseHerdrWorkspaces(
  payload: Record<string, unknown>,
  operation: string,
): readonly HerdrWorkspaceObservation[] {
  const workspaces = herdrResult(payload, operation).workspaces;
  if (!Array.isArray(workspaces))
    throw new Error(`${operation} response.result.workspaces must be an array`);
  return workspaces.map((value, index) => {
    if (!isRecord(value)) throw new Error(`${operation} workspace ${index} must be an object`);
    return {
      workspaceId: requiredHerdrText(
        value.workspace_id,
        `workspace[${index}].workspace_id`,
        operation,
      ),
      activeTabId: requiredHerdrText(
        value.active_tab_id,
        `workspace[${index}].active_tab_id`,
        operation,
      ),
      label: requiredHerdrText(value.label, `workspace[${index}].label`, operation),
    };
  });
}

function parseHerdrPanes(
  payload: Record<string, unknown>,
  operation: string,
): readonly HerdrPaneObservation[] {
  const panes = herdrResult(payload, operation).panes;
  if (!Array.isArray(panes)) throw new Error(`${operation} response.result.panes must be an array`);
  return panes.map((value, index) => {
    if (!isRecord(value)) throw new Error(`${operation} pane ${index} must be an object`);
    const foregroundCwd =
      value.foreground_cwd === undefined
        ? undefined
        : requiredHerdrText(value.foreground_cwd, `pane[${index}].foreground_cwd`, operation);
    return {
      paneId: requiredHerdrText(value.pane_id, `pane[${index}].pane_id`, operation),
      tabId: requiredHerdrText(value.tab_id, `pane[${index}].tab_id`, operation),
      workspaceId: requiredHerdrText(value.workspace_id, `pane[${index}].workspace_id`, operation),
      cwd: requiredHerdrText(value.cwd, `pane[${index}].cwd`, operation),
      foregroundCwd,
    };
  });
}

async function samePhysicalDirectory(expected: string, actual: string): Promise<boolean> {
  try {
    const [expectedPath, actualPath] = await Promise.all([realpath(expected), realpath(actual)]);
    return expectedPath === actualPath;
  } catch {
    return resolve(expected) === resolve(actual);
  }
}

async function recoverEndpointFromLaunch(
  run: CommandRunner,
  intent: DurableEndpointLaunch,
): Promise<EndpointLaunchRecovery> {
  let workspaces: readonly HerdrWorkspaceObservation[];
  try {
    workspaces = parseHerdrWorkspaces(
      await readHerdrPayload(
        run,
        intent.sessionId,
        intent.cwd,
        ["workspace", "list"],
        "herdr workspace list",
      ),
      "herdr workspace list",
    );
  } catch (error) {
    return {
      status: "pending",
      detail: `workspace recovery is unavailable: ${describeError(error)}`,
    };
  }
  const matches = workspaces.filter((workspace) => workspace.label === intent.workspaceLabel);
  if (matches.length === 0) {
    return {
      status: "pending",
      detail: `no Herdr workspace has label ${JSON.stringify(intent.workspaceLabel)}`,
    };
  }
  if (matches.length !== 1) {
    return {
      status: "ambiguous",
      detail: `Herdr workspace label ${JSON.stringify(intent.workspaceLabel)} matched ${matches.length} workspaces`,
    };
  }
  const workspace = matches[0];
  if (workspace === undefined) {
    return { status: "pending", detail: "Herdr workspace recovery returned no selected workspace" };
  }
  let panes: readonly HerdrPaneObservation[];
  try {
    panes = parseHerdrPanes(
      await readHerdrPayload(
        run,
        intent.sessionId,
        intent.cwd,
        ["pane", "list", "--workspace", workspace.workspaceId],
        "herdr pane list",
      ),
      "herdr pane list",
    );
  } catch (error) {
    return { status: "pending", detail: `pane recovery is unavailable: ${describeError(error)}` };
  }
  const candidates: HerdrPaneObservation[] = [];
  for (const pane of panes) {
    if (pane.workspaceId !== workspace.workspaceId || pane.tabId !== workspace.activeTabId)
      continue;
    if (!(await samePhysicalDirectory(intent.cwd, pane.cwd))) continue;
    if (
      pane.foregroundCwd !== undefined &&
      !(await samePhysicalDirectory(intent.cwd, pane.foregroundCwd))
    ) {
      continue;
    }
    candidates.push(pane);
  }
  if (candidates.length === 0) {
    return {
      status: "pending",
      detail: `workspace ${workspace.workspaceId} has no unique root pane at ${intent.cwd}`,
    };
  }
  if (candidates.length !== 1) {
    return {
      status: "ambiguous",
      detail: `workspace ${workspace.workspaceId} has ${candidates.length} matching root panes`,
    };
  }
  const pane = candidates[0];
  if (pane === undefined)
    return { status: "pending", detail: "Herdr root pane recovery returned no pane" };
  return {
    status: "recovered",
    endpoint: {
      sessionId: intent.sessionId,
      workspaceId: workspace.workspaceId,
      tabId: pane.tabId,
      paneId: pane.paneId,
      role: intent.role,
      generation: intent.generation,
    },
  };
}

function waitForPresentationFeedback(
  pending: Promise<PresentationRecord>,
  readCurrent: () => Promise<PresentationRecord>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<PresentationRecord> {
  const { promise, resolve, reject } = Promise.withResolvers<PresentationRecord>();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    clearTimeout(timeout);
  };
  const finish = (action: () => void): void => {
    cleanup();
    action();
  };
  const resolveCurrent = (): void => {
    void readCurrent().then(resolve, reject);
  };
  const onAbort = (): void => finish(resolveCurrent);
  if (signal?.aborted) {
    resolveCurrent();
    return promise;
  }
  if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs !== undefined) timeout = setTimeout(() => finish(resolveCurrent), timeoutMs);
  void pending.then(
    (updated) => finish(() => resolve(updated)),
    (error: unknown) => finish(() => reject(error)),
  );
  return promise;
}

class TandemController {
  readonly #deps: ServiceDependencies;
  #tickPromise: Promise<readonly TaskRecord[]> | undefined;
  readonly #presentationPolls = new Map<string, PresentationPollState>();
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | undefined;
  constructor(deps: ServiceDependencies) {
    this.#deps = deps;
  }

  api(): TandemService {
    return {
      onboard: (repoPath, write) => this.onboard(repoPath, write),
      models: (repoPath) => this.models(repoPath),
      configureModels: (input) => this.configureModels(input),
      create: (input) => this.create(input),
      list: () => this.list(),
      get: (id) => this.get(id),
      approve: (id) => this.approve(id),
      tick: () => this.tick(),
      steer: (input) => this.steer(input),
      answer: (input) => this.answer(input),
      messages: (taskId) => this.messages(taskId),
      pause: (id, reason) => this.pause(id, reason),
      resume: (id) => this.resume(id),
      cancel: (id, reason) => this.cancel(id, reason),
      acknowledge: (id, notificationId) => this.acknowledge(id, notificationId),
      describePr: (id, summary) => this.describePr(id, summary),
      publish: (id, input) => this.publish(id, input),
      merge: (id, input) => this.merge(id, input),
      cleanup: (id, input) => this.cleanup(id, input),
      present: (id, input) => this.present(id, input),
      presentations: () => this.presentations(),
      feedback: (id, signal) => this.feedback(id, signal),
      shutdown: () => this.shutdown(),
    };
  }

  async onboard(repoPath: string, write = false): Promise<OnboardRepoResult> {
    return onboardRepo({
      repoPath: absoluteDirectory(repoPath, "repoPath"),
      home: this.#deps.home,
      write,
    });
  }
  async models(repoPath: string): Promise<ModelOptionsResult> {
    const root = absoluteDirectory(repoPath, "repoPath");
    const modelSettings = await readModelSettings({
      repoPath: root,
      home: this.#deps.home,
    });
    const availableModels = await listOmpModels(this.#deps.run, { cwd: root });
    return { modelSettings, availableModels };
  }

  async configureModels(
    input: Readonly<{
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
    }>,
  ): Promise<ModelSettings> {
    if (!isRecord(input)) throw new TypeError("configureModels input must be an object");
    const repoPath = absoluteDirectory(input.repoPath, "repoPath");
    const models = parseModelAssignments(input.models);
    const availableModels = await listOmpModels(this.#deps.run, { cwd: repoPath });
    validateModelAssignments(models, availableModels);
    return writeModelSettings({
      repoPath,
      home: this.#deps.home,
      models,
    });
  }

  async create(input: CreateTaskRequest): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("create input must be an object");
    const repoPath = absoluteDirectory(input.repoPath, "repoPath");
    const policy = await resolveRepoPolicy({ repoPath, home: this.#deps.home });
    const checkpoint = await readCheckpoint(this.#deps.run, { repo: repoPath });
    const taskInput = taskInputFor(input, repoPath, policy);
    const id = singleLine(this.#deps.idFactory(), "task id");
    const task = await this.#deps.store.exclusive(async (store) => {
      const created = await store.create({ ...taskInput, id });
      const current = await readRuntimeState(this.#deps.runtimePath);
      const runtimeTask: RuntimeTaskState = {
        schemaVersion: 1,
        taskId: created.id,
        sourceCheckpoint: checkpoint,
        taskName: taskNameFor(created),
        endpoints: [],
        jobs: [],
        ...(created.kind === "implementation"
          ? { sessionDirectory: taskSessionDirectory(this.#deps.home, created.id) }
          : {}),
      };
      if (current.tasks.some((entry) => entry.taskId === created.id)) {
        throw new Error(`runtime state already contains task ${created.id}`);
      }
      await writeRuntimeState(this.#deps.runtimePath, {
        ...current,
        tasks: [...current.tasks, runtimeTask],
      });
      return created;
    });
    return task;
  }

  async list(): Promise<readonly TaskRecord[]> {
    return this.#deps.store.list();
  }

  async get(id: string): Promise<TaskRecord> {
    const taskId = assertTaskId(id);
    const task = await this.#deps.store.read(taskId);
    if (task === undefined) throw new Error(`Task ${taskId} was not found`);
    return task;
  }

  async approve(id: string): Promise<TaskRecord> {
    const task = await this.get(id);
    if (task.kind === "implementation") {
      const runtime = await this.runtimeFor(task.id);
      if (runtime === undefined) throw new Error(`Task ${task.id} has no durable runtime metadata`);
      const current = await readCheckpoint(this.#deps.run, { repo: task.repoPath });
      this.assertSourceUnchanged(runtime.sourceCheckpoint, current);
    }
    return this.transition(task.id, { type: "approve" });
  }

  async tick(): Promise<readonly TaskRecord[]> {
    const existing = this.#tickPromise;
    if (existing !== undefined) return existing;
    const current = this.advance().finally(() => {
      this.#tickPromise = undefined;
    });
    this.#tickPromise = current;
    return current;
  }

  async pause(id: string, reason = "paused by coordinator"): Promise<TaskRecord> {
    return this.controlTask(assertTaskId(id), "pause", text(reason, "reason"));
  }

  async resume(id: string): Promise<TaskRecord> {
    return this.resumeTask(assertTaskId(id));
  }

  async cancel(id: string, reason?: string): Promise<TaskRecord> {
    return this.controlTask(
      assertTaskId(id),
      "cancel",
      reason === undefined ? undefined : text(reason, "reason"),
    );
  }

  async acknowledge(id: string, notificationId: string): Promise<TaskRecord> {
    const task = await this.get(id);
    return this.transition(task.id, {
      type: "acknowledge-notification",
      notificationId: singleLine(notificationId, "notificationId"),
    });
  }
  async steer(input: SteerTaskInput): Promise<TaskCommunicationView> {
    if (!isRecord(input)) throw new TypeError("steer input must be an object");
    const taskId = assertTaskId(input.taskId);
    const before = await this.get(taskId);
    const value = singleLine(input.text, "text");
    const instruction =
      input.supersedes === undefined
        ? { text: value }
        : {
            text: value,
            supersedes: input.supersedes.map((entry, index) =>
              singleLine(entry, `supersedes[${index}]`),
            ),
          };
    const next = await this.redirectToPrimary(taskId, instruction);
    if (next.stage === "implementing" && next.generation !== before.generation) {
      await this.reconcileTask(await this.get(next.id));
    } else if (next.stage === "completed" && next.kind === "scout") {
      const followUp = await this.transition(next.id, { type: "follow-up-research" });
      await this.reconcileTask(followUp);
    }
    return this.messages(taskId);
  }

  async answer(input: AnswerTaskInput): Promise<TaskCommunicationView> {
    if (!isRecord(input)) throw new TypeError("answer input must be an object");
    const taskId = assertTaskId(input.taskId);
    const questionId = singleLine(input.questionId, "questionId");
    const answer = singleLine(input.text, "text");
    const result = await this.appendAnswer(taskId, questionId, answer);
    if (result.resumed) await this.resumeTask(taskId);
    return this.messages(taskId);
  }

  async messages(taskId: string): Promise<TaskCommunicationView> {
    const id = assertTaskId(taskId);
    try {
      await this.repairTaskInbox(id);
    } catch {
      // Canonical communication remains readable even when projection repair is unavailable.
    }
    return this.communicationView(await this.get(id));
  }

  async describePr(id: string, summary: PrSummary): Promise<string> {
    const task = await this.get(id);
    return describeTaskPr(task, summary);
  }

  async publish(
    id: string,
    input: {
      readonly repository: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
      readonly approved: boolean;
    },
  ): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("publish input must be an object");
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(id);
      if (task === undefined) throw new Error(`Task ${id} was not found`);
      const metadata = await publishReviewedTask({
        task,
        summary: input.summary,
        repository: singleLine(input.repository, "repository"),
        title: singleLine(input.title, "title"),
        base: singleLine(input.base, "base"),
        approved: input.approved,
        run: this.#deps.run,
      });
      return store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: this.#deps.clock(),
        pullRequest: metadata,
      }));
    });
  }

  async merge(
    id: string,
    input: { readonly approved: boolean; readonly method?: "merge" | "squash" | "rebase" },
  ): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("merge input must be an object");
    const task = await this.get(id);
    const method = input.method ?? "merge";
    const metadata = await mergeReviewedTask({
      task,
      approved: input.approved,
      method,
      run: this.#deps.run,
    });
    return this.transition(task.id, {
      type: "merge",
      pullRequest: metadata,
      approved: input.approved,
      verified: metadata.state === "merged" && metadata.head === task.reviewHead,
    });
  }

  async cleanup(
    id: string,
    input: { readonly discard?: boolean; readonly destructiveApproval?: boolean } = {},
  ): Promise<TaskRecord> {
    const task = await this.get(id);
    const runtime = await this.runtimeFor(task.id);
    if (runtime === undefined) throw new Error(`Task ${task.id} has no durable runtime metadata`);
    const discard = input.discard === true;
    if (discard && input.destructiveApproval !== true) {
      throw new Error("destructive cleanup requires explicit destructiveApproval=true");
    }
    if (runtime.endpointLaunch !== undefined) {
      throw new Error(`cannot clean task ${task.id} while endpoint startup is unresolved`);
    }
    if (runtime.jobs.some(activeRuntimeJob)) {
      throw new Error(`cannot clean task ${task.id} while a worker launch is in progress`);
    }
    for (const endpoint of runtime.endpoints) {
      try {
        const stopped = await inspectStopped(
          this.#deps.run,
          endpoint,
          runtime.worktree?.path ?? task.repoPath,
        );
        if (!stopped) {
          throw new Error(`cannot clean task ${task.id} while pane ${endpoint.paneId} is running`);
        }
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
      }
    }
    for (const endpoint of runtime.endpoints) {
      try {
        await closeEndpoint(this.#deps.run, {
          endpoint,
          cwd: runtime.worktree?.path ?? task.repoPath,
        });
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
      }
    }
    if (runtime.worktree !== undefined) {
      await releaseWorktree(this.#deps.run, {
        repo: task.repoPath,
        lease: runtime.worktree,
        childWorkerStopped: true,
        ...(discard ? { discard: true, destructiveApproval: true } : {}),
      });
    }
    await this.removeRuntimeResources(task.id);
    return task;
  }

  async present(
    id: string,
    input: { readonly objective: string; readonly artifacts: readonly string[] },
  ): Promise<PresentationRecord> {
    if (!isRecord(input)) throw new TypeError("presentation input must be an object");
    const task = await this.get(id);
    const presentationId = singleLine(this.#deps.idFactory(), "presentation id");
    const prepared = await preparePresentation({
      task,
      id: presentationId,
      directory: join(this.#deps.home, "presentations", presentationId),
      objective: text(input.objective, "objective"),
      artifacts: assertArtifacts(input.artifacts),
      now: this.#deps.clock(),
      ...(this.#deps.workerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#deps.workerTimeoutMs }),
      run: this.#deps.run,
    });
    const recordPath = join(dirname(prepared.record.jobPath), "record.json");
    await writeJsonAtomically(recordPath, prepared.record);
    const durableJob: DurableJob = makeDurableJob(
      task.id,
      prepared.record.generation,
      "presentation",
      "worker",
      prepared.record.cwd,
      prepared.record.jobPath,
      prepared.record.resultPath,
      1,
      this.#deps.clock(),
    );
    await this.#deps.store.exclusive(async () => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      if (presentationRuntime(state, prepared.record.id) !== undefined) {
        throw new Error(`presentation ${prepared.record.id} already exists`);
      }
      const next: RuntimePresentation = {
        schemaVersion: 1,
        id: prepared.record.id,
        taskId: task.id,
        recordPath,
        job: durableJob,
      };
      await writeRuntimeState(this.#deps.runtimePath, {
        ...state,
        presentations: [...state.presentations, next],
      });
    });
    await this.startPresentation(prepared.record.id);
    return this.readPresentation(prepared.record.id);
  }

  async presentations(): Promise<readonly PresentationRecord[]> {
    const state = await this.readState();
    const records: PresentationRecord[] = [];
    for (const entry of state.presentations)
      records.push(await readPresentationRecord(entry.recordPath));
    return records;
  }

  private withPresentationNotification(
    previous: PresentationRecord,
    next: PresentationRecord,
    options: Readonly<{
      readonly notificationId?: string;
      readonly feedbackEvidencePath?: string;
    }> = {},
  ): PresentationRecord {
    const details = presentationNotificationForTransition(
      previous,
      next,
      options.feedbackEvidencePath,
    );
    if (details === undefined) return next;
    const pending: PendingPresentationNotification = {
      id: singleLine(
        options.notificationId ?? this.#deps.idFactory(),
        "presentation notification id",
      ),
      ...details,
    };
    if (next.pendingNotification !== undefined) {
      return {
        ...next,
        pendingNotificationQueue: [...(next.pendingNotificationQueue ?? []), pending],
      };
    }
    if ((next.pendingNotificationQueue?.length ?? 0) > 0) {
      return {
        ...next,
        pendingNotificationQueue: [...(next.pendingNotificationQueue ?? []), pending],
      };
    }
    return { ...next, pendingNotification: pending };
  }

  private async flushPresentationNotification(
    runtime: Pick<RuntimePresentation, "recordPath">,
    signal?: AbortSignal,
  ): Promise<PresentationRecord> {
    while (true) {
      let record: PresentationRecord;
      try {
        record = await withPresentationLock(runtime.recordPath, signal, () =>
          this.#deps.store.exclusive(async (store) => {
            const current = await readPresentationRecord(runtime.recordPath);
            const pending = presentationPendingNotifications(current)[0];
            if (pending === undefined) return current;
            const task = await store.read(current.taskId);
            if (task === undefined) throw new Error(`task ${current.taskId} is missing`);
            const existing = task.notifications.find((entry) => entry.id === pending.id);
            if (existing === undefined) {
              await store.update(current.taskId, task.revision, (updated) => ({
                ...updated,
                revision: updated.revision + 1,
                updatedAt: this.#deps.clock(),
                notifications: [
                  ...updated.notifications,
                  {
                    id: pending.id,
                    message: pending.message,
                    acknowledged: false,
                    kind: pending.kind,
                  },
                ],
              }));
            } else if (existing.message !== pending.message || existing.kind !== pending.kind) {
              throw new Error(
                `presentation notification ${pending.id} conflicts with task history`,
              );
            }
            const remaining = presentationPendingNotifications(current).slice(1);
            const {
              pendingNotification: _pending,
              pendingNotificationQueue: _queue,
              ...withoutPending
            } = current;
            const [nextPending, ...queued] = remaining;
            const cleared =
              nextPending === undefined
                ? withoutPending
                : {
                    ...withoutPending,
                    pendingNotification: nextPending,
                    ...(queued.length === 0 ? {} : { pendingNotificationQueue: queued }),
                  };
            await writeJsonAtomically(runtime.recordPath, cleared);
            return cleared;
          }),
        );
      } catch (error) {
        if (error instanceof StoreLockTimeoutError || signal?.aborted) {
          return readPresentationRecord(runtime.recordPath);
        }
        throw error;
      }
      if (!hasPendingPresentationNotification(record) || signal?.aborted) return record;
    }
  }

  private async pollPresentationFeedback(
    runtime: Pick<RuntimePresentation, "recordPath">,
    expected: PresentationRecord,
    signal: AbortSignal,
    continuous: boolean,
    allowBrowserDisconnected: boolean,
  ): Promise<PresentationRecord> {
    const before = await this.flushPresentationNotification(runtime, signal);
    if (hasPendingPresentationNotification(before) || this.#shuttingDown || signal.aborted)
      return before;
    let release: () => Promise<void>;
    try {
      release = await acquireDarwinFileLock(
        presentationFeedbackLockPath(runtime.recordPath),
        PRESENTATION_LOCK_TIMEOUT_MS,
        PRESENTATION_LOCK_POLL_MS,
        signal,
      );
    } catch (error) {
      if (error instanceof StoreLockTimeoutError || signal.aborted) {
        return readPresentationRecord(runtime.recordPath);
      }
      throw error;
    }
    try {
      const previous = await readPresentationRecord(runtime.recordPath);
      const canPoll =
        !this.#shuttingDown &&
        !signal.aborted &&
        samePresentationRecord(expected, previous) &&
        !hasPendingPresentationNotification(previous) &&
        previous.status === "open" &&
        (allowBrowserDisconnected || previous.observation?.status !== "browser_disconnected");
      if (canPoll) {
        const observed = await readPresentationFeedback({
          record: previous,
          clock: this.#deps.clock,
          run: this.#deps.run,
          signal,
          continuous,
        });
        if (observed !== previous) {
          const observation = observed.observation;
          const options =
            observation?.status === "feedback"
              ? (() => {
                  const notificationId = singleLine(
                    this.#deps.idFactory(),
                    "presentation notification id",
                  );
                  return writePresentationFeedbackEvidence({
                    record: previous,
                    eventId: notificationId,
                    observedAt: observed.updatedAt,
                    observation,
                  }).then((feedbackEvidencePath) => ({
                    notificationId,
                    feedbackEvidencePath,
                  }));
                })()
              : Promise.resolve({});
          const notificationOptions = await options;
          const updated = this.withPresentationNotification(
            previous,
            observed,
            notificationOptions,
          );
          await writeJsonAtomically(runtime.recordPath, updated);
        }
      }
    } finally {
      await release();
    }
    return this.flushPresentationNotification(runtime, signal);
  }

  private beginPresentationFeedback(
    runtime: Pick<RuntimePresentation, "id" | "recordPath">,
    record: PresentationRecord,
    signal?: AbortSignal,
    continuous = false,
    allowBrowserDisconnected = false,
  ): Promise<PresentationRecord> {
    const existing = this.#presentationPolls.get(runtime.id);
    if (existing !== undefined) {
      return continuous
        ? existing.promise
        : waitForPresentationFeedback(
            existing.promise,
            () => readPresentationRecord(runtime.recordPath),
            signal,
            MANUAL_SHARED_FEEDBACK_WAIT_MS,
          );
    }
    if (this.#shuttingDown) return Promise.resolve(record);
    const controller = new AbortController();
    const onAbort = signal === undefined ? undefined : (): void => controller.abort(signal.reason);
    if (signal !== undefined && onAbort !== undefined) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const poll = this.pollPresentationFeedback(
      runtime,
      record,
      controller.signal,
      continuous,
      allowBrowserDisconnected,
    ).finally(() => {
      if (this.#presentationPolls.get(runtime.id)?.promise === poll) {
        this.#presentationPolls.delete(runtime.id);
      }
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    });
    this.#presentationPolls.set(runtime.id, { promise: poll, controller });
    void poll.catch(() => undefined);
    return poll;
  }

  private startPresentationFeedback(
    runtime: Pick<RuntimePresentation, "id" | "recordPath">,
    record: PresentationRecord,
  ): void {
    if (this.#shuttingDown) return;
    if (
      !hasPendingPresentationNotification(record) &&
      (record.status !== "open" || record.observation?.status === "browser_disconnected")
    )
      return;
    void this.beginPresentationFeedback(runtime, record, undefined, true, false).catch((error) => {
      if (this.#shuttingDown) return;
      void this.failPresentation(
        runtime.id,
        `presentation feedback poll failed: ${describeError(error)}`,
      ).catch(() => undefined);
    });
  }

  async feedback(presentationId: string, signal?: AbortSignal): Promise<PresentationRecord> {
    const id = singleLine(presentationId, "presentationId");
    const state = await this.readState();
    const runtime = presentationRuntime(state, id);
    if (runtime === undefined) throw new Error(`Presentation ${id} was not found`);
    const record = await readPresentationRecord(runtime.recordPath);
    return this.beginPresentationFeedback(runtime, record, signal, false, true);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    const tick = this.#tickPromise;
    this.#shuttingDown = true;
    const polls = [...this.#presentationPolls.values()];
    for (const poll of polls) poll.controller.abort(new Error("Tandem service is shutting down"));
    const inFlight = [...(tick === undefined ? [] : [tick]), ...polls.map((poll) => poll.promise)];
    const shutdown = Promise.allSettled(inFlight).then(() => undefined);
    this.#shutdownPromise = shutdown;
    await shutdown;
  }

  private async advance(): Promise<readonly TaskRecord[]> {
    const tasks = await this.#deps.store.list();
    for (const task of tasks) {
      try {
        await this.reconcileTask(task);
      } catch (error) {
        await this.blockTask(task.id, `scheduler failure: ${describeError(error)}`);
      }
      try {
        const current = await this.get(task.id);
        if (isTerminalTask(current)) await this.cleanupTerminalTask(current);
      } catch (error) {
        await this.setRuntimeError(task.id, `terminal cleanup failed: ${describeError(error)}`);
      }
    }
    const state = await this.readState();
    for (const presentation of state.presentations) {
      try {
        await this.reconcilePresentation(presentation);
      } catch (error) {
        await this.failPresentation(
          presentation.id,
          describeError(error),
          true,
          presentation.job.id,
        );
      }
    }
    return this.#deps.store.list();
  }

  private async reconcileTask(task: TaskRecord): Promise<void> {
    try {
      await this.repairTaskInbox(task.id);
    } catch {
      // Canonical task state remains authoritative when projection repair is unavailable.
    }
    const loadedRuntime = await this.runtimeFor(task.id);
    if (loadedRuntime === undefined) {
      await this.blockTask(task.id, "durable runtime metadata is missing; no worker was launched");
      return;
    }
    let runtime = loadedRuntime;
    if (runtime.endpointLaunch !== undefined && currentWriter(runtime) === undefined) {
      const recovered = await this.reconcileEndpointLaunch(task, runtime);
      if (recovered === undefined) return;
      runtime = recovered;
    }
    if (runtime.stopRequest !== undefined) {
      await this.reconcileStopRequest(task, runtime);
      return;
    }
    const active = runtime.jobs.find(activeRuntimeJob);
    if (active !== undefined) {
      await this.reconcileJob(task, runtime, active);
      return;
    }
    const reservation = runtime.reservation;
    if (reservation !== undefined && reservation.phase !== "released") {
      const writer = currentWriter(runtime);
      if (
        reservation.ownerSessionId === this.#deps.sessionId &&
        runtime.worktree !== undefined &&
        writer !== undefined
      ) {
        if (task.stage === "queued") {
          await this.startQueuedTask(task, { task, runtime, reservation });
          return;
        }
        if (task.stage === "scouting" || task.stage === "implementing") {
          await this.launchAgent(task, runtime, writer, workerRoleForTask(task));
          return;
        }
      }
      if (isOlderThan(reservation.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
        await this.blockTask(
          task.id,
          "an owned scheduler reservation has no recoverable job intent",
        );
      }
      return;
    }
    switch (task.stage) {
      case "queued":
        await this.startQueuedTask(task);
        return;
      case "awaiting-fixes":
        await this.beginFixes(task);
        return;
      case "validating":
        await this.startValidation(task);
        return;
      case "reviewing":
        await this.advanceReview(task);
        return;
      case "scouting":
      case "implementing": {
        if (runtime.endpointLaunch !== undefined) return;
        if (runtime.worktree === undefined) {
          await this.blockTask(
            task.id,
            `task is ${task.stage} but its durable worktree is missing`,
          );
          return;
        }
        const writer = currentWriter(runtime);
        if (writer === undefined) {
          await this.blockTask(task.id, `task is ${task.stage} but its worker endpoint is missing`);
          return;
        }
        const admission = await this.reserveTask(task.id, workerRoleForTask(task));
        if (admission === undefined) return;
        const admittedWriter = currentWriter(admission.runtime);
        if (admission.runtime.worktree === undefined || admittedWriter === undefined) {
          await this.releaseUnlaunchedTaskReservation(task.id, admission.reservation.id);
          await this.blockTask(
            task.id,
            `task is ${task.stage} but its worker resources are missing`,
          );
          return;
        }
        await this.launchAgent(
          admission.task,
          admission.runtime,
          admittedWriter,
          workerRoleForTask(admission.task),
        );
        return;
      }
      default:
        return;
    }
  }

  private async reconcileJob(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
  ): Promise<void> {
    const endpoint = job.endpoint;
    if (endpoint === undefined) {
      if (isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
        await this.failJob(task, job, "worker job has no durable endpoint identity");
      }
      return;
    }
    let inspection: HerdrPaneInspection;
    try {
      inspection = await inspectEndpoint(this.#deps.run, {
        endpoint,
        cwd: job.cwd,
      });
    } catch (error) {
      if (error instanceof EndpointOwnershipError && error.reason === "missing") {
        await this.reconcileMissingEndpoint(task, job);
        return;
      }
      throw error;
    }
    if (inspection.activeWorker) {
      await this.observeWorkerProgress(task, job);
      if (job.phase !== "running")
        await this.updateJob(job.taskId, job.id, (current) => ({ ...current, phase: "running" }));
      return;
    }
    if (job.kind === "worker") {
      let result: WorkerResult;
      try {
        result = await readWorkerResult(job.resultPath, {
          id: job.id,
          taskId: job.taskId,
          generation: job.generation,
          ...(job.role === "validation" ? {} : { role: job.role }),
        });
      } catch (error) {
        if (isMissing(error)) {
          if (!isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) return;
          await this.failJob(
            task,
            job,
            `worker stopped without a durable result: ${describeError(error)}`,
          );
          return;
        }
        await this.failJob(task, job, `worker result rejected: ${describeError(error)}`);
        return;
      }
      await this.consumeWorkerResult(task, runtime, job, result);
      return;
    }
    let result: ValidationResult;
    try {
      if (job.head === undefined) throw new Error("validation job is missing expected HEAD");
      result = await readValidationResult(job.resultPath, {
        id: job.id,
        taskId: job.taskId,
        generation: job.generation,
        head: job.head,
      });
    } catch (error) {
      if (isMissing(error)) {
        if (!isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) return;
        await this.failJob(
          task,
          job,
          `validation stopped without durable evidence: ${describeError(error)}`,
        );
        return;
      }
      await this.failJob(task, job, `validation result rejected: ${describeError(error)}`);
      return;
    }
    await this.consumeValidationResult(task, runtime, job, result);
  }

  private async reconcileMissingEndpoint(task: TaskRecord, job: DurableJob): Promise<void> {
    if (!isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) return;
    const resultExists = await this.resultExists(job.resultPath);
    if (resultExists) {
      await this.failJob(
        task,
        job,
        "owned endpoint disappeared; durable result cannot be trusted without stopped-pane proof",
      );
      return;
    }
    if (job.endpoint !== undefined) await this.removeEndpoint(task.id, job.endpoint.paneId);
    await this.failJob(task, job, "owned endpoint disappeared before a durable result was written");
  }
  private async observeWorkerProgress(task: TaskRecord, job: DurableJob): Promise<void> {
    if (job.receiptPath === undefined) return;
    const receipt = await readWorkerReceipt(job.receiptPath, {
      jobId: job.id,
      taskId: task.id,
      generation: job.generation,
    }).catch(() => undefined);
    const now = this.#deps.clock();
    const nowMs = nowMilliseconds(this.#deps.clock);
    const createdMs = Date.parse(job.createdAt);
    const heartbeatMs = receipt === undefined ? Number.NaN : Date.parse(receipt.heartbeatAt);
    const progressMs = receipt === undefined ? Number.NaN : Date.parse(receipt.progressAt);
    const startupElapsed =
      Number.isFinite(createdMs) && nowMs - createdMs >= DEFAULT_HEARTBEAT_GRACE_MS;
    const heartbeatStale =
      receipt === undefined
        ? startupElapsed
        : !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs >= DEFAULT_HEARTBEAT_GRACE_MS;
    const progressStale =
      receipt === undefined
        ? startupElapsed
        : !Number.isFinite(progressMs) || nowMs - progressMs >= DEFAULT_STALL_WARNING_MS;
    if (
      job.progressWarningAt !== undefined &&
      receipt !== undefined &&
      Date.parse(receipt.progressAt) > Date.parse(job.progressWarningAt)
    ) {
      await this.updateJob(job.taskId, job.id, (current) => {
        const { progressWarningAt: _progressWarningAt, ...withoutWarning } = current;
        return withoutWarning;
      });
      return;
    }
    if (!heartbeatStale && !progressStale) return;
    if (job.progressWarningAt !== undefined) return;
    await this.updateJob(job.taskId, job.id, (current) => ({
      ...current,
      progressWarningAt: now,
    }));
    await this.updateTask(task.id, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      notifications: [
        ...current.notifications,
        {
          id: singleLine(this.#deps.idFactory(), "progress warning id"),
          message: `Worker ${job.role} has not reported meaningful progress; inspect its activity before taking action`,
          acknowledged: false,
          kind: "coordinator",
        },
      ],
    }));
  }

  private async assertInstructionCurrent(
    task: TaskRecord,
    job: DurableJob,
    resultRevision: number | undefined,
  ): Promise<void> {
    const canonicalRevision = task.communication?.revision ?? 0;
    if (canonicalRevision === 0 && job.receiptPath === undefined) return;
    if (resultRevision === undefined) {
      throw new Error("worker result omitted canonical instruction revision");
    }
    if (resultRevision !== canonicalRevision) {
      throw new Error(
        `worker applied instruction revision ${resultRevision}, canonical revision is ${canonicalRevision}`,
      );
    }
    if (job.receiptPath === undefined) throw new Error("worker has no communication receipt path");
    const receipt = await readWorkerReceipt(job.receiptPath, {
      jobId: job.id,
      taskId: job.taskId,
      generation: job.generation,
    });
    if (receipt === undefined || receipt.appliedRevision < canonicalRevision) {
      throw new Error(
        "matching worker receipt does not prove the canonical instruction was applied",
      );
    }
  }

  private async consumeWorkerResult(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    result: WorkerResult,
  ): Promise<void> {
    if (
      (job.role === "reviewer" || job.role === "verifier") &&
      (job.instructionRevision ?? 0) !== (task.communication?.revision ?? 0)
    ) {
      await this.failJob(
        task,
        job,
        "review result was launched for an older instruction revision",
        false,
      );
      return;
    }
    try {
      await this.assertInstructionCurrent(task, job, result.instructionRevision);
    } catch (error) {
      await this.failJob(task, job, `stale worker instruction: ${describeError(error)}`, false);
      return;
    }
    if (result.status === "failed" || result.status === "needs-decision") {
      const question =
        result.status === "needs-decision"
          ? {
              id: job.id,
              text: (
                (result.question?.text ?? result.text).trim() ||
                `Worker ${job.role} needs a decision`
              ).slice(0, MAX_TASK_MESSAGE_CHARS),
              ...(result.question?.recommendation === undefined
                ? {}
                : {
                    recommendation: result.question.recommendation.slice(0, MAX_TASK_MESSAGE_CHARS),
                  }),
            }
          : undefined;
      const reason =
        question === undefined
          ? (result.error ?? `worker ${result.status} for ${job.role}`)
          : [
              question.text,
              ...(question.recommendation === undefined
                ? []
                : [`Recommendation: ${question.recommendation}`]),
            ].join(" ");
      await this.consumeJob(
        task.id,
        job.id,
        { type: "block", reason },
        {
          ...(question === undefined ? {} : { question }),
          ...instructionOptions(result.instructionRevision),
        },
      );
      return;
    }
    if (job.role === "scout") {
      let checkout: CurrentCheckout;
      try {
        checkout = await this.readWorkerCheckout(runtime, job);
      } catch (error) {
        await this.consumeJob(
          task.id,
          job.id,
          {
            type: "block",
            reason: `scout checkout could not be verified: ${describeError(error)}; worktree is preserved`,
          },
          instructionOptions(result.instructionRevision),
        );
        return;
      }
      if (
        checkout.checkpoint.dirty ||
        checkout.checkpoint.unmerged ||
        checkout.checkpoint.head !== runtime.worktree?.baseHead
      ) {
        await this.consumeJob(
          task.id,
          job.id,
          {
            type: "block",
            reason:
              "scout stopped with a changed, dirty, or unmerged checkout; worktree is preserved",
          },
          instructionOptions(result.instructionRevision),
        );
        return;
      }
      const reportPath = reportPathFor(job.jobPath);
      await writeTextAtomically(reportPath, result.text);
      await this.consumeJob(
        task.id,
        job.id,
        {
          type: "scout-report-complete",
          reportPath,
          generation: job.generation,
        },
        instructionOptions(result.instructionRevision),
      );
      return;
    }
    if (job.role === "implementer") {
      const checkout = await this.readWorkerCheckout(runtime, job);
      if (
        checkout.checkpoint.dirty ||
        checkout.checkpoint.unmerged ||
        checkout.checkpoint.head === runtime.worktree?.baseHead
      ) {
        await this.consumeJob(
          task.id,
          job.id,
          {
            type: "block",
            reason:
              "implementer stopped without a new clean committed checkpoint; worktree is preserved",
          },
          instructionOptions(result.instructionRevision),
        );
        return;
      }
      const reportPath = reportPathFor(job.jobPath);
      await writeTextAtomically(reportPath, result.text);
      await this.consumeJob(
        task.id,
        job.id,
        {
          type: "implementation-complete",
          head: checkout.checkpoint.head,
          generation: job.generation,
          reportPath,
        },
        instructionOptions(result.instructionRevision),
      );
      return;
    }
    const review = result.review;
    if (review === undefined || job.head === undefined || job.reviewLens === undefined) {
      await this.failJob(task, job, "review worker completed without complete review identity");
      return;
    }
    const checkout = await this.readWorkerCheckout(runtime, job);
    if (
      checkout.checkpoint.dirty ||
      checkout.checkpoint.unmerged ||
      checkout.checkpoint.head !== job.head ||
      review.head !== job.head ||
      review.generation !== job.generation ||
      review.lens !== job.reviewLens
    ) {
      await this.consumeJob(
        task.id,
        job.id,
        {
          type: "block",
          reason: `stale or dirty review evidence for ${job.reviewLens} at ${job.head}; review was not accepted`,
        },
        instructionOptions(result.instructionRevision),
      );
      return;
    }
    await this.consumeJob(
      task.id,
      job.id,
      { type: "record-review", review },
      instructionOptions(result.instructionRevision),
    );
    await this.closeReviewerAfterResult(task.id, job.endpoint);
  }

  private async consumeValidationResult(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    job: DurableJob,
    result: ValidationResult,
  ): Promise<void> {
    const canonicalRevision = task.communication?.revision ?? 0;
    if (canonicalRevision !== 0 && job.instructionRevision !== canonicalRevision) {
      await this.failJob(
        task,
        job,
        `stale validation instruction revision ${String(job.instructionRevision)}; canonical is ${canonicalRevision}`,
        false,
      );
      return;
    }
    const expectedHead = job.head;
    if (expectedHead === undefined) {
      await this.failJob(task, job, "validation job has no expected HEAD");
      return;
    }
    const checkout = await this.readWorkerCheckout(runtime, job);
    if (
      checkout.checkpoint.dirty ||
      checkout.checkpoint.unmerged ||
      checkout.checkpoint.head !== expectedHead
    ) {
      await this.consumeJob(
        task.id,
        job.id,
        {
          type: "validation-failed",
          head: expectedHead,
          generation: job.generation,
          evidence: [
            ...result.evidence,
            {
              name: "validation-head-check",
              argv: ["git", "rev-parse", "HEAD"],
              exitCode: 1,
              stdout: checkout.checkpoint.head,
              stderr: "worktree changed while validation was running",
              head: expectedHead,
            },
          ],
        },
        instructionOptions(job.instructionRevision),
      );
      return;
    }
    const event: TaskEvent =
      result.status === "completed"
        ? {
            type: "validation-succeeded",
            head: expectedHead,
            generation: job.generation,
            evidence: result.evidence,
          }
        : {
            type: "validation-failed",
            head: expectedHead,
            generation: job.generation,
            evidence: result.evidence,
          };
    await this.consumeJob(task.id, job.id, event, {
      ...instructionOptions(job.instructionRevision),
    });
  }

  private async closeReviewerAfterResult(
    taskId: string,
    endpoint: Endpoint | undefined,
  ): Promise<void> {
    if (endpoint === undefined) return;
    const runtime = await this.runtimeFor(taskId);
    const task = await this.get(taskId);
    if (runtime === undefined) return;
    try {
      await closeEndpoint(this.#deps.run, {
        endpoint,
        cwd: runtime.worktree?.path ?? task.repoPath,
      });
    } catch (error) {
      if (!isMissingEndpoint(error)) {
        await this.setRuntimeError(
          taskId,
          `reviewer pane ${endpoint.paneId} could not close: ${describeError(error)}`,
        );
        return;
      }
    }
    await this.updateTask(taskId, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      endpoints: (current.endpoints ?? []).filter(
        (candidate) => candidate.paneId !== endpoint.paneId,
      ),
    }));
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        endpoints: current.endpoints.filter((candidate) => candidate.paneId !== endpoint.paneId),
      })),
    );
  }

  private async failJob(
    task: TaskRecord,
    job: DurableJob,
    reason: string,
    block = true,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, task.id, (current) => {
        const failed = replaceJob(current, job.id, (entry) => ({
          ...entry,
          phase: "failed",
          error: reason,
        }));
        return failed.reservation === undefined || failed.jobs.some(activeRuntimeJob)
          ? failed
          : {
              ...failed,
              reservation: {
                ...failed.reservation,
                releasedAt: this.#deps.clock(),
              },
            };
      }),
    );
    if (block) await this.blockTask(task.id, reason);
  }

  private async consumeJob(
    taskId: string,
    jobId: string,
    event: TaskEvent,
    options: Readonly<{ question?: TaskQuestion; instructionRevision?: number }> = {},
  ): Promise<TaskRecord> {
    return this.#deps.store.exclusive(async (store) => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const job = runtime.jobs.find((entry) => entry.id === jobId);
      if (job === undefined) throw new Error(`runtime job ${jobId} is missing`);
      const task = await store.read(taskId);
      if (task === undefined) throw new Error(`task ${taskId} is missing`);
      try {
        if (
          job.kind === "worker" &&
          (job.role === "reviewer" || job.role === "verifier") &&
          (job.instructionRevision ?? 0) !== (task.communication?.revision ?? 0)
        ) {
          throw new Error("review result was launched for an older instruction revision");
        }
        if (job.kind === "validation") {
          const canonicalRevision = task.communication?.revision ?? 0;
          if (canonicalRevision !== 0 && job.instructionRevision !== canonicalRevision) {
            throw new Error(
              `validation instruction revision ${String(job.instructionRevision)} does not match canonical revision ${canonicalRevision}`,
            );
          }
        } else {
          await this.assertInstructionCurrent(task, job, options.instructionRevision);
        }
      } catch (error) {
        if (job.kind !== "worker") throw error;
        const staleReason = `stale worker instruction: ${describeError(error)}`;
        const retired = replaceRuntimeTask(state, taskId, (current) => {
          const failed = replaceJob(current, jobId, (entry) => ({
            ...entry,
            phase: "failed",
            error: staleReason,
          }));
          return failed.reservation === undefined || failed.jobs.some(activeRuntimeJob)
            ? failed
            : {
                ...failed,
                reservation: {
                  ...failed.reservation,
                  phase: "released",
                  releasedAt: this.#deps.clock(),
                },
              };
        });
        await writeRuntimeState(this.#deps.runtimePath, retired);
        return task;
      }
      if (job.phase === "consumed") return task;
      const inputKey = inputEventKey(job.id, event);
      const existing = job.consumption;
      let nextTask = task;
      let consumption: DurableJobConsumption;

      if (existing !== undefined) {
        if (existing.inputEventKey !== inputKey) {
          throw new Error(`durable result ${job.id} was prepared for a different lifecycle event`);
        }
        const currentFingerprint = taskFingerprint(task);
        if (
          task.revision === existing.afterRevision &&
          currentFingerprint === existing.taskFingerprint
        ) {
          consumption = existing;
        } else if (
          task.revision === existing.beforeRevision &&
          currentFingerprint === existing.beforeFingerprint
        ) {
          const context: TaskTransitionContext = {
            now: existing.now,
            notificationId: existing.notificationId,
          };
          let effectiveEvent = event;
          try {
            nextTask = transitionTask(task, event, context);
          } catch (error) {
            effectiveEvent = {
              type: "block",
              reason: `durable result could not be applied: ${describeError(error)}`,
            };
            nextTask = transitionTask(task, effectiveEvent, context);
          }
          nextTask =
            options.question === undefined
              ? nextTask
              : taskWithQuestion(nextTask, options.question);
          if (
            inputEventKey(job.id, effectiveEvent) !== existing.appliedEventKey ||
            nextTask.revision !== existing.afterRevision ||
            taskFingerprint(nextTask) !== existing.taskFingerprint
          ) {
            throw new Error(
              `durable result ${job.id} no longer matches its prepared lifecycle transition`,
            );
          }
          consumption = existing;
        } else if (
          task.stage === "paused" ||
          task.stage === "blocked" ||
          task.stage === "cancelled" ||
          task.stage === "completed" ||
          task.stage === "merged"
        ) {
          consumption = existing;
        } else {
          throw new Error(`durable result ${job.id} has an unexpected task revision or state`);
        }
      } else if (recognizesAppliedEvent(task, event)) {
        nextTask =
          options.question === undefined
            ? task
            : taskWithQuestionCommit(task, options.question, this.#deps.clock());
        consumption = {
          schemaVersion: 1,
          inputEventKey: inputKey,
          appliedEventKey: inputKey,
          beforeRevision: task.revision,
          afterRevision: nextTask.revision,
          beforeFingerprint: taskFingerprint(task),
          taskFingerprint: taskFingerprint(nextTask),
          now: this.#deps.clock(),
          notificationId: singleLine(this.#deps.idFactory(), "notification id"),
        };
      } else {
        const context = this.context();
        let effectiveEvent = event;
        if (
          task.stage === "cancelled" ||
          task.stage === "completed" ||
          task.stage === "merged" ||
          task.stage === "paused" ||
          task.stage === "blocked"
        ) {
          nextTask = task;
        } else {
          try {
            nextTask = transitionTask(task, event, context);
          } catch (error) {
            effectiveEvent = {
              type: "block",
              reason: `durable result could not be applied: ${describeError(error)}`,
            };
            nextTask = transitionTask(task, effectiveEvent, context);
          }
        }
        if (options.question !== undefined) {
          nextTask =
            nextTask.revision === task.revision
              ? taskWithQuestionCommit(nextTask, options.question, context.now)
              : taskWithQuestion(nextTask, options.question);
        }
        consumption = {
          schemaVersion: 1,
          inputEventKey: inputKey,
          appliedEventKey: inputEventKey(job.id, effectiveEvent),
          beforeRevision: task.revision,
          afterRevision: nextTask.revision,
          beforeFingerprint: taskFingerprint(task),
          taskFingerprint: taskFingerprint(nextTask),
          now: context.now,
          notificationId: context.notificationId,
        };
      }

      if (existing === undefined) {
        const pendingRuntime = replaceRuntimeTask(state, taskId, (current) =>
          replaceJob(current, jobId, (entry) => ({ ...entry, consumption })),
        );
        await writeRuntimeState(this.#deps.runtimePath, pendingRuntime);
      }
      if (nextTask !== task) {
        await store.update(task.id, task.revision, () => nextTask);
      }
      const nextRuntime = replaceRuntimeTask(state, taskId, (current) => {
        const consumed = replaceJob(current, jobId, (entry) => ({
          ...entry,
          ...(options.instructionRevision === undefined
            ? {}
            : { instructionRevision: options.instructionRevision }),
          phase: "consumed",
          consumedAt: this.#deps.clock(),
          consumption,
        }));
        if (consumed.reservation !== undefined && !consumed.jobs.some(activeRuntimeJob)) {
          return {
            ...consumed,
            reservation: {
              ...consumed.reservation,
              phase: "released",
              releasedAt: this.#deps.clock(),
            },
          };
        }
        return consumed;
      });
      await writeRuntimeState(this.#deps.runtimePath, nextRuntime);
      await this.publishTaskInbox(nextTask);
      return nextTask;
    });
  }

  private async recordPoolResult(taskId: string, result: PoolMaintenanceResult): Promise<void> {
    const admissionKey = poolAdmissionKey(result);
    const admissionNotice = admissionKey === undefined ? undefined : poolAdmissionNotice(result);
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined) return;
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      const previousKey = runtime?.poolAdmissionKey;
      const nextRuntime =
        runtime === undefined
          ? state
          : replaceRuntimeTask(state, taskId, (current) => {
              if (admissionKey === undefined) {
                const {
                  poolAdmissionKey: _poolAdmissionKey,
                  poolNotice: _poolNotice,
                  ...withoutPoolNotice
                } = current;
                if (current.lastError === current.poolNotice) {
                  const { lastError: _lastError, ...withoutError } = withoutPoolNotice;
                  return withoutError;
                }
                return withoutPoolNotice;
              }
              const notice = poolAdmissionNotice(result);
              return {
                ...current,
                poolAdmissionKey: admissionKey,
                poolNotice: notice,
                lastError: notice,
              };
            });
      const notificationMessage =
        admissionKey === undefined || admissionNotice === undefined
          ? undefined
          : poolNotificationMessage(admissionKey, admissionNotice);
      const hasNotification =
        admissionKey !== undefined &&
        task.notifications.some((entry) => isPoolNotificationForKey(entry, admissionKey));
      const shouldNotify =
        task.stage === "queued" &&
        notificationMessage !== undefined &&
        previousKey !== admissionKey &&
        !hasNotification;
      const recoveredNotifications =
        admissionKey === undefined
          ? task.notifications.filter((entry) => !isPoolNotification(entry))
          : task.notifications;
      const taskWithNotification: TaskRecord =
        shouldNotify && notificationMessage !== undefined
          ? {
              ...task,
              revision: task.revision + 1,
              updatedAt: this.#deps.clock(),
              notifications: [
                ...task.notifications,
                {
                  id: singleLine(this.#deps.idFactory(), "pool notification id"),
                  message: notificationMessage,
                  acknowledged: false,
                },
              ],
            }
          : recoveredNotifications.length === task.notifications.length
            ? task
            : {
                ...task,
                revision: task.revision + 1,
                updatedAt: this.#deps.clock(),
                notifications: recoveredNotifications,
              };
      if (taskWithNotification !== task) {
        await store.update(task.id, task.revision, () => taskWithNotification);
      }
      if (runtime !== undefined) await writeRuntimeState(this.#deps.runtimePath, nextRuntime);
    });
  }

  private async maintainPoolForAllocation(task: TaskRecord): Promise<boolean> {
    const [state, tasks] = await Promise.all([this.readState(), this.#deps.store.list()]);
    const managedPaths = tasks.flatMap((entry) =>
      entry.worktree === undefined ? [] : [entry.worktree.path],
    );
    const protectedPaths = state.tasks.flatMap((entry) =>
      entry.worktree === undefined ? [] : [entry.worktree.path],
    );
    let result: PoolMaintenanceResult;
    try {
      result = await maintainPool(this.#deps.run, {
        repo: task.repoPath,
        root: this.#deps.poolRoot,
        managedPaths,
        protectedPaths,
        retainIdle: Math.max(0, task.policy.config.maxWorkers - activeReservations(state)),
      });
    } catch (error) {
      await this.recordPoolResult(task.id, {
        canAllocate: false,
        availableBytes: null,
        removedPaths: [],
        retainedPaths: managedPaths,
        warnings: [],
        allocationBlocker: `pool maintenance failed: ${describeError(error)}`,
      });
      return false;
    }
    await this.recordPoolResult(task.id, result);
    return result.canAllocate;
  }

  private async cleanupTerminalTask(task: TaskRecord): Promise<void> {
    const runtime = await this.runtimeFor(task.id);
    if (runtime === undefined || runtime.terminalCleanupRevision === task.revision) return;
    if (runtime.endpointLaunch !== undefined || runtime.jobs.some(activeRuntimeJob)) return;
    const cwd = runtime.worktree?.path ?? task.repoPath;
    for (const endpoint of runtime.endpoints) {
      try {
        const inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        if (inspection.activeWorker) {
          await this.setRuntimeError(
            task.id,
            `terminal cleanup deferred while pane ${endpoint.paneId} is active`,
          );
          return;
        }
        await closeEndpoint(this.#deps.run, { endpoint, cwd });
      } catch (error) {
        if (!isMissingEndpoint(error)) {
          await this.setRuntimeError(
            task.id,
            `terminal cleanup could not close pane ${endpoint.paneId}: ${describeError(error)}`,
          );
          return;
        }
      }
      await this.removeEndpoint(task.id, endpoint.paneId);
    }
    if (runtime.worktree !== undefined) {
      try {
        await releaseWorktree(this.#deps.run, {
          repo: task.repoPath,
          lease: runtime.worktree,
          childWorkerStopped: true,
        });
      } catch (error) {
        await this.setRuntimeError(
          task.id,
          `terminal cleanup retained worktree: ${describeError(error)}`,
        );
        return;
      }
    }
    await this.removeRuntimeResources(task.id, task.revision);
  }

  private async startQueuedTask(task: TaskRecord, reserved?: ReservationResult): Promise<void> {
    const role = workerRoleForTask(task);
    const reservation = reserved ?? (await this.reserveTask(task.id, role));
    if (reservation === undefined) return;
    const runtime = reservation.runtime;
    if (runtime.worktree === undefined && !(await this.maintainPoolForAllocation(task))) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      return;
    }
    let lease = runtime.worktree;
    if (lease === undefined) {
      try {
        const source = await readCheckpoint(this.#deps.run, { repo: task.repoPath });
        this.assertSourceUnchanged(runtime.sourceCheckpoint, source);
        lease = await acquireWorktree(this.#deps.run, {
          repo: task.repoPath,
          root: this.#deps.poolRoot,
          tandemId: `${this.#deps.sessionId}:${task.id}`,
          taskName: runtime.taskName,
        });
        if (lease.baseHead !== runtime.sourceCheckpoint.head) {
          throw new LeaseSafetyError(
            `acquired worktree base ${lease.baseHead} does not match pinned source ${runtime.sourceCheckpoint.head}`,
            lease,
          );
        }
        await this.saveWorktree(task.id, lease);
      } catch (error) {
        if (error instanceof LeaseSafetyError) await this.saveWorktree(task.id, error.lease);
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
        await this.blockTask(task.id, `worktree allocation failed: ${describeError(error)}`);
        return;
      }
    }
    if (lease === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, "worktree allocation returned no lease");
      return;
    }
    const endpoint = currentWriter({ ...runtime, worktree: lease });
    if (endpoint === undefined) {
      try {
        await this.setReservationPhase(task.id, "endpoint");
        const claimed = await this.saveEndpointLaunch(
          task.id,
          endpointLaunchFor(
            reservation.reservation,
            this.#deps.sessionId,
            runtime.taskName,
            lease.path,
            role,
            task.generation,
            this.#deps.clock(),
            this.#deps.parentWorkspaceId,
          ),
        );
        if (!claimed) return;
      } catch (error) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
        await this.blockTask(
          task.id,
          `worker launch intent could not be persisted: ${describeError(error)}`,
        );
        return;
      }
      let created: HerdrEndpointResult;
      try {
        created = await createTaskEndpoint(this.#deps.run, {
          sessionId: this.#deps.sessionId,
          cwd: lease.path,
          taskName: runtime.taskName,
          role,
          generation: task.generation,
          ...(this.#deps.parentWorkspaceId === undefined
            ? {}
            : { parentWorkspaceId: this.#deps.parentWorkspaceId }),
        });
      } catch (error) {
        await this.blockTask(task.id, `worker pane allocation failed: ${describeError(error)}`);
        return;
      }
      try {
        await this.saveEndpoint(task.id, created.endpoint);
      } catch (error) {
        await this.blockTask(
          task.id,
          `worker pane identity could not be persisted: ${describeError(error)}`,
        );
        return;
      }
      try {
        const current = await this.get(task.id);
        if (current.stage === "queued") {
          await this.transition(task.id, {
            type: "start",
            worktree: lease,
            endpoints: [created.endpoint],
          });
        }
      } catch (error) {
        const current = await this.get(task.id);
        if (current.stage === "queued") {
          await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
          await this.blockTask(
            task.id,
            `task start transition failed after pane allocation: ${describeError(error)}`,
          );
          return;
        }
      }
    } else if ((await this.get(task.id)).stage === "queued") {
      try {
        await this.transition(task.id, { type: "start", worktree: lease, endpoints: [endpoint] });
      } catch (error) {
        const current = await this.get(task.id);
        if (current.stage === "queued") {
          await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
          await this.blockTask(
            task.id,
            `task start transition failed with recovered pane: ${describeError(error)}`,
          );
          return;
        }
      }
    }
    const currentTask = await this.get(task.id);
    const expectedStage = role === "scout" ? "scouting" : "implementing";
    if (currentTask.stage !== expectedStage) {
      if (["paused", "blocked", "cancelled", "completed", "merged"].includes(currentTask.stage)) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      }
      return;
    }
    const currentRuntime = await this.runtimeFor(task.id);
    if (currentRuntime === undefined || currentRuntime.worktree === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, "runtime lost its acquired worktree before worker launch");
      return;
    }
    const writer = currentWriter(currentRuntime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, "runtime lost its worker endpoint before launch");
      return;
    }
    await this.launchAgent(currentTask, currentRuntime, writer, role);
  }

  private async beginFixes(task: TaskRecord): Promise<void> {
    if (task.reviewHead === undefined) {
      await this.blockTask(task.id, "fix stage has no reviewed HEAD");
      return;
    }
    const reservation = await this.reserveTask(task.id, "implementer");
    if (reservation === undefined) return;
    const contextPath = join(
      taskJobsDirectory(this.#deps.home, task.id),
      `fix-context-${task.generation + 1}.json`,
    );
    try {
      await writeJsonAtomically(contextPath, {
        taskId: task.id,
        head: task.reviewHead,
        generation: task.generation,
        validationEvidence: task.validationEvidence,
        findings: reviewFindings(task),
      });
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, `fix context could not be persisted: ${describeError(error)}`);
      return;
    }
    try {
      await this.updateTask(task.id, (current) => {
        if (current.reviewHead === undefined) throw new Error("fix stage has no reviewed HEAD");
        const next = transitionTask(
          current,
          { type: "begin-fixes", head: current.reviewHead, generation: current.generation },
          this.context(),
        );
        return {
          ...next,
          endpoints: (next.endpoints ?? []).map((endpoint) => ({
            ...endpoint,
            generation: next.generation,
          })),
        };
      });
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, `fix round could not begin: ${describeError(error)}`);
      return;
    }
    try {
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
        replaceRuntimeTask(state, task.id, (current) => ({
          ...current,
          fixContextPath: contextPath,
          endpoints: current.endpoints.map((endpoint) => ({
            ...endpoint,
            generation: task.generation + 1,
          })),
        })),
      );
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(
        task.id,
        `fix runtime metadata could not be persisted: ${describeError(error)}`,
      );
      return;
    }
    const nextTask = await this.get(task.id);
    const nextRuntime = await this.runtimeFor(task.id);
    if (nextRuntime === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, "fix round lost its durable runtime metadata before launch");
      return;
    }
    const writer = currentWriter(nextRuntime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, "fix round has no owned implementer pane");
      return;
    }
    await this.launchAgent(nextTask, nextRuntime, writer, "implementer");
  }

  private async startValidation(task: TaskRecord): Promise<void> {
    if (task.reviewHead === undefined || task.worktree === undefined) {
      await this.blockTask(task.id, "validation requires a task worktree and reviewed HEAD");
      return;
    }
    const reservation = await this.reserveTask(task.id, "validation");
    if (reservation === undefined) return;
    const runtime = reservation.runtime;
    if (runtime.worktree === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, "validation runtime lost its worktree");
      return;
    }
    let checkout: CurrentCheckout;
    try {
      checkout = await this.readWorkerCheckout(runtime, {
        cwd: runtime.worktree.path,
        head: task.reviewHead,
      });
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(
        task.id,
        `validation checkout could not be verified: ${describeError(error)}`,
      );
      return;
    }
    if (
      checkout.checkpoint.head !== task.reviewHead ||
      checkout.checkpoint.dirty ||
      checkout.checkpoint.unmerged
    ) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(
        task.id,
        "validation refused because the task worktree is stale or dirty",
      );
      return;
    }
    const writer = currentWriter(runtime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, "validation has no owned implementer pane");
      return;
    }
    let durableJob: DurableJob;
    try {
      const jobId = singleLine(this.#deps.idFactory(), "validation job id");
      const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
      const paths = jobPaths(directory);
      const spec: ValidationJob = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        repoPath: runtime.worktree.path,
        head: task.reviewHead,
        surfaces: task.surfaces,
        commands: task.policy.config.validationCommands,
        resultPath: paths.resultPath,
      };
      await writeJsonAtomically(paths.jobPath, spec);
      durableJob = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        role: "validation",
        kind: "validation",
        cwd: runtime.worktree.path,
        jobPath: paths.jobPath,
        resultPath: paths.resultPath,
        attempt: 1,
        phase: "reserved",
        launchAttempted: false,
        createdAt: this.#deps.clock(),
        endpoint: writer,
        head: task.reviewHead,
        ...(task.communication === undefined
          ? {}
          : { instructionRevision: task.communication.revision }),
      };
      await this.appendJob(task.id, durableJob);
    } catch (error) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(
        task.id,
        `validation job could not be persisted: ${describeError(error)}`,
      );
      return;
    }
    await this.launchJob(
      task.id,
      durableJob.id,
      writer,
      runtime.worktree.path,
      workerCommand(this.#deps.validationWorkerPath, durableJob.jobPath),
    );
  }

  private async advanceReview(task: TaskRecord): Promise<void> {
    if (task.reviewHead === undefined || task.worktree === undefined) {
      await this.blockTask(task.id, "review requires a task worktree and reviewed HEAD");
      return;
    }
    const runtime = await this.runtimeFor(task.id);
    if (runtime === undefined) {
      await this.blockTask(task.id, "review has no durable runtime metadata");
      return;
    }
    const staleReviewer = currentReviewer(runtime);
    if (staleReviewer !== undefined) {
      try {
        const stopped = await inspectStopped(this.#deps.run, staleReviewer, task.worktree.path);
        if (!stopped) return;
        await closeEndpoint(this.#deps.run, { endpoint: staleReviewer, cwd: task.worktree.path });
        await this.removeEndpoint(task.id, staleReviewer.paneId);
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
        await this.removeEndpoint(task.id, staleReviewer.paneId);
      }
      return;
    }
    const currentCheckout = await readCheckpoint(this.#deps.run, {
      repo: task.worktree.path,
      baseRef: task.worktree.baseHead,
    });
    if (
      currentCheckout.head !== task.reviewHead ||
      currentCheckout.dirty ||
      currentCheckout.unmerged
    ) {
      await this.blockTask(task.id, "review refused because the worktree is stale or dirty");
      return;
    }
    const nextLens = REQUIRED_REVIEW_LENSES.find(
      (lens) =>
        !task.reviews.some(
          (review) =>
            review.lens === lens &&
            review.head === task.reviewHead &&
            review.generation === task.generation,
        ),
    );
    if (nextLens === undefined) {
      await this.transition(task.id, {
        type: "finish-review",
        head: task.reviewHead,
        generation: task.generation,
      });
      return;
    }
    const role: WorkerRole = nextLens === "verification" ? "verifier" : "reviewer";
    const reservation = await this.reserveTask(task.id, role);
    if (reservation === undefined) return;
    const reservedRuntime = reservation.runtime;
    const writer = currentWriter(reservedRuntime);
    if (writer === undefined) {
      await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      await this.blockTask(task.id, "review has no writer endpoint");
      return;
    }
    let endpointResult: HerdrEndpointResult;
    try {
      endpointResult = await createReviewerEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: task.worktree.path,
        writer,
        generation: task.generation,
      });
    } catch (error) {
      await this.blockTask(task.id, `review pane allocation failed: ${describeError(error)}`);
      return;
    }
    const endpoint: Endpoint = { ...endpointResult.endpoint, role };
    try {
      await this.saveEndpoint(task.id, endpoint);
      const jobId = singleLine(this.#deps.idFactory(), "review job id");
      const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
      const paths = jobPaths(directory);
      const diffPath = join(directory, "diff.patch");
      const evidencePath = join(directory, "validation-evidence.json");
      await writeTextAtomically(diffPath, currentCheckout.diff);
      await writeJsonAtomically(evidencePath, task.validationEvidence);
      const reportPath = reportPathFor(paths.jobPath);
      const instructionRevision = task.communication?.revision ?? 0;
      const communication = {
        inboxPath: taskInboxPath(this.#deps.home, task.id),
        receiptPath: workerReceiptPath(paths.jobPath),
        initialRevision: instructionRevision,
      };
      const prompt = buildPrompt(
        task,
        role,
        reportPath,
        [diffPath, evidencePath, ...(task.reportPath === undefined ? [] : [task.reportPath])],
        { head: task.reviewHead, generation: task.generation, pass: nextLens },
        [
          `Review only the selected ${nextLens} lens. The immutable diff is at ${diffPath}.`,
          `Validation evidence is at ${evidencePath}; treat it as runner-produced evidence only.`,
          ...(instructionRevision === 0
            ? []
            : [
                formatTaskMessages(
                  task.id,
                  instructionRevision,
                  activeTaskMessages(task.communication),
                ),
              ]),
        ],
      );
      const spec: WorkerJob = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        role,
        cwd: task.worktree.path,
        model: task.policy.config.models[role],
        prompt,
        resultPath: paths.resultPath,
        communication,
        review: { head: task.reviewHead, lens: nextLens },
        ...(this.#deps.workerTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.#deps.workerTimeoutMs }),
      };
      await writeJsonAtomically(paths.jobPath, spec);
      const durableJob: DurableJob = makeDurableJob(
        task.id,
        task.generation,
        role,
        "worker",
        task.worktree.path,
        paths.jobPath,
        paths.resultPath,
        1,
        this.#deps.clock(),
        {
          endpoint,
          head: task.reviewHead,
          reviewLens: nextLens,
          receiptPath: communication.receiptPath,
          instructionRevision,
        },
      );
      await this.appendJob(task.id, durableJob);
      await this.launchJob(
        task.id,
        durableJob.id,
        endpoint,
        task.worktree.path,
        workerCommand(this.#deps.workerPath, paths.jobPath),
      );
    } catch (error) {
      const currentRuntime = await this.runtimeFor(task.id);
      if (currentRuntime?.endpoints.some((candidate) => candidate.paneId === endpoint.paneId)) {
        await this.releaseUnlaunchedTaskReservation(task.id, reservation.reservation.id);
      }
      await this.blockTask(task.id, `review job could not be prepared: ${describeError(error)}`);
    }
  }

  private async launchAgent(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    endpoint: Endpoint,
    role: WorkerRole,
  ): Promise<void> {
    const jobId = singleLine(this.#deps.idFactory(), "worker job id");
    const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
    const paths = jobPaths(directory);
    const reportPath = reportPathFor(paths.jobPath);
    const fixArtifacts = runtime.fixContextPath === undefined ? [] : [runtime.fixContextPath];
    const extra =
      role === "implementer" && runtime.fixContextPath !== undefined
        ? [
            `This is a bounded fix round. Read findings and validation evidence from ${runtime.fixContextPath}.`,
            "Preserve the original task scope and repair only evidence-backed findings.",
          ]
        : [];
    const sessionDirectory = role === "implementer" ? runtime.sessionDirectory : undefined;
    if (sessionDirectory !== undefined)
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    const instructionRevision = task.communication?.revision ?? 0;
    const communication = {
      inboxPath: taskInboxPath(this.#deps.home, task.id),
      receiptPath: workerReceiptPath(paths.jobPath),
      initialRevision: instructionRevision,
    };
    const prompt = buildPrompt(
      task,
      role,
      reportPath,
      fixArtifacts,
      undefined,
      instructionRevision === 0
        ? extra
        : [
            ...extra,
            formatTaskMessages(
              task.id,
              instructionRevision,
              activeTaskMessages(task.communication),
            ),
          ],
    );
    const spec: WorkerJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      role,
      cwd: task.worktree?.path ?? task.repoPath,
      model: task.policy.config.models[role],
      prompt,
      resultPath: paths.resultPath,
      communication,
      ...(this.#deps.workerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#deps.workerTimeoutMs }),
      ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    };
    await writeJsonAtomically(paths.jobPath, spec);
    parseWorkerJob(spec);
    const durableJob: DurableJob = makeDurableJob(
      task.id,
      task.generation,
      role,
      "worker",
      spec.cwd,
      paths.jobPath,
      paths.resultPath,
      1,
      this.#deps.clock(),
      {
        endpoint,
        receiptPath: communication.receiptPath,
        instructionRevision,
      },
    );
    try {
      await this.appendJob(task.id, durableJob);
    } catch (error) {
      const currentRuntime = await this.runtimeFor(task.id);
      if (currentRuntime?.jobs.some(activeRuntimeJob)) return;
      throw error;
    }
    await this.launchJob(
      task.id,
      durableJob.id,
      endpoint,
      spec.cwd,
      workerCommand(this.#deps.workerPath, paths.jobPath),
    );
  }

  private async launchJob(
    taskId: string,
    jobId: string,
    endpoint: Endpoint,
    cwd: string,
    command: readonly string[],
  ): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const task = await store.read(taskId);
      if (task === undefined) throw new Error(`task ${taskId} is missing`);
      const job = runtime.jobs.find((entry) => entry.id === jobId);
      if (job === undefined) throw new Error(`runtime job ${jobId} is missing`);
      if (job.phase !== "reserved" || job.launchAttempted) return;

      const activeTask =
        task.stage !== "paused" &&
        task.stage !== "blocked" &&
        task.stage !== "cancelled" &&
        task.stage !== "completed" &&
        task.stage !== "merged";
      if (!activeTask || runtime.stopRequest !== undefined) {
        const released = replaceRuntimeTask(state, taskId, (current) => {
          const failed = replaceJob(current, jobId, (entry) => ({
            ...entry,
            phase: "failed",
            error: "worker launch was refused by a durable stop request",
          }));
          return failed.reservation === undefined
            ? failed
            : {
                ...failed,
                reservation: {
                  ...failed.reservation,
                  phase: "released",
                  releasedAt: this.#deps.clock(),
                },
              };
        });
        await writeRuntimeState(this.#deps.runtimePath, released);
        return;
      }

      const launching = replaceRuntimeTask(state, taskId, (current) =>
        replaceJob(current, jobId, (entry) => ({
          ...entry,
          phase: "launching",
          launchAttempted: true,
        })),
      );
      await writeRuntimeState(this.#deps.runtimePath, launching);
      try {
        await sendCommand(this.#deps.run, { endpoint, cwd, command });
        await this.proveWorkerStartup(job, endpoint, cwd);
      } catch (error) {
        const reason = `worker launch could not be proven after launch intent: ${describeError(error)}`;
        const failed = replaceRuntimeTask(launching, taskId, (current) =>
          replaceJob(current, jobId, (entry) => ({ ...entry, phase: "failed", error: reason })),
        );
        await writeRuntimeState(this.#deps.runtimePath, failed);
        if (activeTask) {
          const blocked = transitionTask(task, { type: "block", reason }, this.context());
          await store.update(task.id, task.revision, () => blocked);
        }
        return;
      }
      const running = replaceRuntimeTask(launching, taskId, (current) =>
        replaceJob(current, jobId, (entry) => ({
          ...entry,
          phase: "running",
          launchedAt: this.#deps.clock(),
        })),
      );
      await writeRuntimeState(this.#deps.runtimePath, running);
    });
  }

  private async proveWorkerStartup(
    job: DurableJob,
    endpoint: Endpoint,
    cwd: string,
  ): Promise<void> {
    const deadline = Date.now() + DEFAULT_STARTUP_GRACE_MS;
    while (true) {
      const inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
      if (inspection.activeWorker || (await this.resultExists(job.resultPath))) return;
      if (Date.now() >= deadline) {
        throw new Error(`worker did not become active within ${DEFAULT_STARTUP_GRACE_MS}ms`);
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 50);
      });
    }
  }

  private async launchPresentationJob(
    presentationId: string,
    jobId: string,
    endpoint: Endpoint,
    cwd: string,
    command: readonly string[],
  ): Promise<void> {
    const state = await this.readState();
    const initialRuntime = presentationRuntime(state, presentationId);
    if (initialRuntime === undefined) throw new Error(`presentation ${presentationId} is missing`);
    let failedRuntime: Pick<RuntimePresentation, "recordPath"> | undefined;
    await withPresentationLock(initialRuntime.recordPath, undefined, () =>
      this.#deps.store.exclusive(async () => {
        const currentState = await readRuntimeState(this.#deps.runtimePath);
        const runtime = presentationRuntime(currentState, presentationId);
        if (runtime === undefined) throw new Error(`presentation ${presentationId} is missing`);
        if (
          runtime.job.id !== jobId ||
          runtime.job.phase !== "reserved" ||
          runtime.job.launchAttempted
        )
          return;
        const launching = replaceRuntimePresentation(currentState, presentationId, (entry) => ({
          ...entry,
          job: { ...entry.job, phase: "launching", launchAttempted: true },
        }));
        await writeRuntimeState(this.#deps.runtimePath, launching);
        try {
          await sendCommand(this.#deps.run, { endpoint, cwd, command });
        } catch (error) {
          const reason = `presentation launch failed after launch intent: ${describeError(error)}`;
          const failed = replaceRuntimePresentation(launching, presentationId, (entry) => ({
            ...entry,
            lastError: reason,
            job: { ...entry.job, phase: "failed", error: reason },
          }));
          await writeRuntimeState(this.#deps.runtimePath, failed);
          const record = await readPresentationRecord(runtime.recordPath);
          const failedRecord: PresentationRecord = {
            ...record,
            status: "failed",
            error: reason,
            updatedAt: this.#deps.clock(),
          };
          await writeJsonAtomically(
            runtime.recordPath,
            this.withPresentationNotification(record, failedRecord),
          );
          failedRuntime = { recordPath: runtime.recordPath };
          return;
        }
        const running = replaceRuntimePresentation(launching, presentationId, (entry) => ({
          ...entry,
          job: { ...entry.job, phase: "running", launchedAt: this.#deps.clock() },
        }));
        await writeRuntimeState(this.#deps.runtimePath, running);
      }),
    );
    if (failedRuntime !== undefined) await this.flushPresentationNotification(failedRuntime);
  }
  private async markPresentationRunning(id: string): Promise<RuntimePresentation | undefined> {
    const state = await this.readState();
    const initialRuntime = presentationRuntime(state, id);
    if (initialRuntime === undefined) return undefined;
    return withPresentationLock(initialRuntime.recordPath, undefined, async () => {
      const currentState = await this.readState();
      const runtime = presentationRuntime(currentState, id);
      if (runtime === undefined) return undefined;
      const endpoint = runtime.endpoint ?? runtime.job.endpoint;
      if (endpoint === undefined) return runtime;
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.status !== "queued") return runtime;
      await writeJsonAtomically(runtime.recordPath, {
        ...record,
        status: "running",
        endpoint,
        updatedAt: this.#deps.clock(),
      });
      return runtime;
    });
  }

  private async startPresentation(id: string): Promise<void> {
    let state = await this.readState();
    let runtime = presentationRuntime(state, id);
    if (runtime === undefined) throw new Error(`presentation ${id} is missing`);
    if (runtime.endpointLaunch !== undefined && runtime.endpoint === undefined) {
      const recovered = await this.reconcilePresentationEndpointLaunch(runtime);
      if (recovered === undefined) return;
      state = await this.readState();
      runtime = presentationRuntime(state, id);
      if (runtime === undefined) throw new Error(`presentation ${id} is missing`);
    }
    if (runtime.endpoint !== undefined) {
      const running = await this.markPresentationRunning(id);
      if (running === undefined) return;
      const endpoint = running.endpoint ?? running.job.endpoint;
      if (endpoint === undefined) return;
      await this.launchPresentationJob(
        id,
        running.job.id,
        endpoint,
        running.job.cwd,
        workerCommand(this.#deps.workerPath, running.job.jobPath),
      );
      return;
    }
    const capacity = await this.reservePresentation(id);
    if (!capacity) return;
    state = await this.readState();
    runtime = presentationRuntime(state, id);
    if (runtime === undefined || runtime.reservation === undefined) {
      throw new Error(`presentation ${id} lost its durable reservation`);
    }
    const taskName = `presentation-${id}`;
    const endpointLaunch = endpointLaunchFor(
      runtime.reservation,
      this.#deps.sessionId,
      taskName,
      runtime.job.cwd,
      "presentation",
      runtime.job.generation,
      this.#deps.clock(),
      this.#deps.parentWorkspaceId,
    );
    try {
      const claimed = await this.savePresentationEndpointLaunch(id, endpointLaunch);
      if (!claimed) return;
    } catch (error) {
      await this.releaseUnlaunchedPresentationReservation(id, runtime.reservation.id);
      await this.failPresentation(
        id,
        `presentation launch intent could not be persisted: ${describeError(error)}`,
      );
      return;
    }
    let endpointResult: HerdrEndpointResult;
    try {
      endpointResult = await createTaskEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: runtime.job.cwd,
        taskName,
        role: "presentation",
        generation: runtime.job.generation,
        ...(this.#deps.parentWorkspaceId === undefined
          ? {}
          : { parentWorkspaceId: this.#deps.parentWorkspaceId }),
      });
    } catch (error) {
      await this.failPresentation(
        id,
        `presentation pane allocation failed: ${describeError(error)}`,
        false,
      );
      return;
    }
    const endpoint = endpointResult.endpoint;
    try {
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
        replaceRuntimePresentation(current, id, (entry) => ({
          ...entry,
          endpoint,
          job: { ...entry.job, endpoint },
        })),
      );
    } catch (error) {
      await this.failPresentation(
        id,
        `presentation pane identity could not be persisted: ${describeError(error)}`,
        false,
      );
      return;
    }
    const running = await this.markPresentationRunning(id);
    if (running === undefined) return;
    const runningEndpoint = running.endpoint ?? running.job.endpoint;
    if (runningEndpoint === undefined) return;
    await this.launchPresentationJob(
      id,
      running.job.id,
      runningEndpoint,
      running.job.cwd,
      workerCommand(this.#deps.workerPath, running.job.jobPath),
    );
  }

  private async reconcilePresentation(runtime: RuntimePresentation): Promise<void> {
    let currentRuntime = runtime;
    if (currentRuntime.endpointLaunch !== undefined && currentRuntime.endpoint === undefined) {
      const recovered = await this.reconcilePresentationEndpointLaunch(currentRuntime);
      if (recovered === undefined) return;
      currentRuntime = recovered;
    }
    const state = await this.readState();
    const freshRuntime = presentationRuntime(state, currentRuntime.id);
    if (freshRuntime === undefined) return;
    const record = await readPresentationRecord(freshRuntime.recordPath);
    const job = freshRuntime.job;
    const endpoint = freshRuntime.endpoint ?? job.endpoint;
    if (job.phase === "reserved" && endpoint !== undefined) {
      await this.startPresentation(freshRuntime.id);
      return;
    }
    if (record.status === "queued" && job.phase === "reserved") {
      await this.startPresentation(freshRuntime.id);
      return;
    }
    if (!activeRuntimeJob(job)) {
      this.startPresentationFeedback(freshRuntime, record);
      return;
    }
    if (endpoint === undefined) {
      if (isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
        await this.failPresentation(
          freshRuntime.id,
          "presentation has no endpoint identity",
          true,
          job.id,
        );
      }
      return;
    }
    await this.consumePresentationResult(freshRuntime);
  }

  private async consumePresentationResult(runtimeHint: RuntimePresentation): Promise<void> {
    let failureReason: string | undefined;
    let followUp:
      | Readonly<{
          readonly runtime: RuntimePresentation;
          readonly record: PresentationRecord;
        }>
      | undefined;
    try {
      await withPresentationLock(runtimeHint.recordPath, undefined, async () => {
        const state = await this.readState();
        const runtime = presentationRuntime(state, runtimeHint.id);
        if (runtime === undefined) return;
        const record = await readPresentationRecord(runtime.recordPath);
        const job = runtime.job;
        if (!activeRuntimeJob(job)) {
          followUp = { runtime, record };
          return;
        }
        const endpoint = runtime.endpoint ?? job.endpoint;
        if (endpoint === undefined) {
          if (isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
            failureReason = "presentation has no endpoint identity";
          }
          return;
        }
        let inspection: HerdrPaneInspection;
        try {
          inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd: job.cwd });
        } catch (error) {
          if (error instanceof EndpointOwnershipError) {
            failureReason = "presentation endpoint disappeared before result consumption";
            return;
          }
          throw error;
        }
        if (inspection.activeWorker) return;
        let result: WorkerResult;
        try {
          result = await readWorkerResult(job.resultPath, {
            id: job.id,
            taskId: job.taskId,
            generation: job.generation,
            role: "presentation",
          });
        } catch (error) {
          if (
            isMissing(error) &&
            !isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)
          )
            return;
          failureReason = `presentation result rejected: ${describeError(error)}`;
          return;
        }
        let completed: PresentationRecord;
        try {
          completed = await completePresentation({
            record,
            result,
            now: this.#deps.clock(),
            run: this.#deps.run,
          });
        } catch (error) {
          failureReason = `presentation artifact was rejected: ${describeError(error)}`;
          return;
        }
        const completedWithNotification = this.withPresentationNotification(record, completed);
        await writeJsonAtomically(runtime.recordPath, completedWithNotification);
        let consumed = false;
        await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
          replaceRuntimePresentation(current, runtime.id, (entry) => {
            if (entry.job.id !== job.id || !activeRuntimeJob(entry.job)) return entry;
            consumed = true;
            return {
              ...entry,
              job: { ...entry.job, phase: "consumed", consumedAt: this.#deps.clock() },
              ...(entry.reservation === undefined
                ? {}
                : {
                    reservation: {
                      ...entry.reservation,
                      phase: "released",
                      releasedAt: this.#deps.clock(),
                    },
                  }),
            };
          }),
        );
        if (!consumed) {
          const latestState = await this.readState();
          const latestRuntime = presentationRuntime(latestState, runtime.id);
          if (latestRuntime !== undefined) {
            followUp = {
              runtime: latestRuntime,
              record: await readPresentationRecord(latestRuntime.recordPath),
            };
          }
          return;
        }
        try {
          await closeEndpoint(this.#deps.run, { endpoint, cwd: job.cwd });
        } catch (error) {
          if (!(error instanceof EndpointOwnershipError && error.reason === "missing")) {
            await this.setPresentationError(runtime.id, describeError(error));
          }
        }
        followUp = { runtime, record: completedWithNotification };
      });
    } catch (error) {
      if (failureReason === undefined) {
        failureReason = `presentation reconciliation failed: ${describeError(error)}`;
      }
    }
    if (failureReason !== undefined) {
      await this.failPresentation(runtimeHint.id, failureReason, true, runtimeHint.job.id);
      return;
    }
    if (followUp === undefined) return;
    let delivered = followUp.record;
    try {
      delivered = await this.flushPresentationNotification(followUp.runtime);
    } catch {
      delivered = await readPresentationRecord(followUp.runtime.recordPath);
    }
    this.startPresentationFeedback(followUp.runtime, delivered);
  }

  private async failPresentation(
    id: string,
    reason: string,
    releaseReservation = true,
    expectedJobId?: string,
  ): Promise<void> {
    const state = await this.readState();
    const initialRuntime = presentationRuntime(state, id);
    if (initialRuntime === undefined) return;
    let shouldFlush = false;
    await withPresentationLock(initialRuntime.recordPath, undefined, async () => {
      const currentState = await this.readState();
      const runtime = presentationRuntime(currentState, id);
      if (runtime === undefined) return;
      if (
        expectedJobId !== undefined &&
        (runtime.job.id !== expectedJobId || !activeRuntimeJob(runtime.job))
      )
        return;
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.status === "ended") return;
      if (!releaseReservation && runtime.endpointLaunch !== undefined) {
        await this.setPresentationError(id, reason);
        return;
      }
      const failed: PresentationRecord = {
        ...record,
        status: "failed",
        error: reason,
        updatedAt: this.#deps.clock(),
      };
      const failedWithNotification = this.withPresentationNotification(record, failed);
      await writeJsonAtomically(runtime.recordPath, failedWithNotification);
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
        replaceRuntimePresentation(current, id, (entry) => ({
          ...entry,
          lastError: reason,
          job: { ...entry.job, phase: "failed", error: reason },
          ...(entry.reservation === undefined
            ? {}
            : {
                reservation: {
                  ...entry.reservation,
                  phase: "released",
                  releasedAt: this.#deps.clock(),
                },
              }),
        })),
      );
      shouldFlush = hasPendingPresentationNotification(failedWithNotification);
    });
    if (shouldFlush) await this.flushPresentationNotification(initialRuntime);
  }

  private async reserveTask(
    taskId: string,
    role: WorkerRole | "validation",
  ): Promise<ReservationResult | undefined> {
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined) throw new Error(`task ${taskId} is missing`);
      const stageAllowed =
        role === "validation"
          ? task.stage === "validating"
          : role === "scout"
            ? task.stage === "queued" || task.stage === "scouting"
            : role === "reviewer" || role === "verifier"
              ? task.stage === "reviewing"
              : task.stage === "queued" ||
                task.stage === "implementing" ||
                task.stage === "awaiting-fixes";
      if (!stageAllowed) return undefined;
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      if (runtime.stopRequest !== undefined) return undefined;
      if (runtime.reservation !== undefined && runtime.reservation.phase !== "released")
        return undefined;
      if (runtime.jobs.some(activeRuntimeJob)) return undefined;
      if (activeReservations(state) >= task.policy.config.maxWorkers) return undefined;
      const reservation = runtimeReservation(
        singleLine(this.#deps.idFactory(), "reservation id"),
        taskId,
        this.#deps.sessionId,
        this.#deps.clock(),
      );
      const nextRuntime = { ...runtime, reservation };
      await writeRuntimeState(
        this.#deps.runtimePath,
        replaceRuntimeTask(state, taskId, () => nextRuntime),
      );
      return { task, runtime: nextRuntime, reservation };
    });
  }

  private async reservePresentation(id: string): Promise<boolean> {
    return this.#deps.store.exclusive(async (store) => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = presentationRuntime(state, id);
      if (runtime === undefined) throw new Error(`presentation ${id} is missing`);
      if (runtime.reservation !== undefined && runtime.reservation.phase !== "released")
        return false;
      const task = await store.read(runtime.taskId);
      if (task === undefined) throw new Error(`task ${runtime.taskId} is missing`);
      if (activeReservations(state) >= task.policy.config.maxWorkers) return false;
      const reservation = runtimeReservation(
        singleLine(this.#deps.idFactory(), "presentation reservation id"),
        runtime.taskId,
        this.#deps.sessionId,
        this.#deps.clock(),
      );
      await writeRuntimeState(
        this.#deps.runtimePath,
        replaceRuntimePresentation(state, id, (current) => ({ ...current, reservation })),
      );
      return true;
    });
  }

  private async appendJob(taskId: string, job: DurableJob): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        if (current.jobs.some(activeRuntimeJob)) {
          throw new Error(`runtime task ${taskId} already has an active job`);
        }
        return appendTaskJob(current, job);
      }),
    );
  }

  private async updateJob(
    taskId: string,
    jobId: string,
    transform: (job: DurableJob) => DurableJob,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => replaceJob(current, jobId, transform)),
    );
  }

  private async saveWorktree(
    taskId: string,
    worktree: NonNullable<RuntimeTaskState["worktree"]>,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        worktree,
        ...(current.reservation === undefined
          ? {}
          : { reservation: { ...current.reservation, phase: "worktree" } }),
      })),
    );
  }

  private async saveEndpoint(taskId: string, endpoint: Endpoint): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        const { endpointLaunch: _endpointLaunch, ...withoutLaunch } = current;
        return {
          ...withoutLaunch,
          endpoints: [
            ...current.endpoints.filter((candidate) => candidate.paneId !== endpoint.paneId),
            endpoint,
          ],
          ...(current.reservation === undefined
            ? {}
            : { reservation: { ...current.reservation, phase: "endpoint" } }),
        };
      }),
    );
  }
  private async saveEndpointLaunch(
    taskId: string,
    launch: DurableEndpointLaunch,
  ): Promise<boolean> {
    let claimed = false;
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        if (current.reservation?.id !== launch.reservationId) {
          throw new Error(`runtime task ${taskId} has no matching endpoint reservation`);
        }
        if (current.endpointLaunch !== undefined || currentWriter(current) !== undefined)
          return current;
        claimed = true;
        return { ...current, endpointLaunch: launch };
      }),
    );
    return claimed;
  }
  private async savePresentationEndpointLaunch(
    presentationId: string,
    launch: DurableEndpointLaunch,
  ): Promise<boolean> {
    let claimed = false;
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimePresentation(state, presentationId, (current) => {
        if (current.reservation?.id !== launch.reservationId) {
          throw new Error(`presentation ${presentationId} has no matching endpoint reservation`);
        }
        if (
          current.endpointLaunch !== undefined ||
          current.endpoint !== undefined ||
          current.job.endpoint !== undefined
        ) {
          return current;
        }
        claimed = true;
        return { ...current, endpointLaunch: launch };
      }),
    );
    return claimed;
  }

  private async releaseUnlaunchedTaskReservation(
    taskId: string,
    reservationId: string,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        if (
          current.reservation?.id !== reservationId ||
          current.reservation.phase === "released" ||
          current.endpointLaunch !== undefined ||
          current.endpoints.length > 0 ||
          current.jobs.some(activeRuntimeJob)
        ) {
          return current;
        }
        return {
          ...current,
          reservation: {
            ...current.reservation,
            phase: "released",
            releasedAt: this.#deps.clock(),
          },
        };
      }),
    );
  }

  private async releaseUnlaunchedPresentationReservation(
    presentationId: string,
    reservationId: string,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimePresentation(state, presentationId, (current) => {
        if (
          current.reservation?.id !== reservationId ||
          current.reservation.phase === "released" ||
          current.endpointLaunch !== undefined ||
          activeRuntimeJob(current.job)
        ) {
          return current;
        }
        return {
          ...current,
          reservation: {
            ...current.reservation,
            phase: "released",
            releasedAt: this.#deps.clock(),
          },
        };
      }),
    );
  }

  private async reconcileEndpointLaunch(
    task: TaskRecord,
    runtime: RuntimeTaskState,
  ): Promise<RuntimeTaskState | undefined> {
    const launch = runtime.endpointLaunch;
    if (launch === undefined) return runtime;
    if (runtime.reservation?.ownerSessionId !== this.#deps.sessionId) {
      await this.setRuntimeError(
        task.id,
        "endpoint launch is owned by another session; recovery was not attempted",
      );
      return undefined;
    }
    const recovery = await recoverEndpointFromLaunch(this.#deps.run, launch);
    if (recovery.status !== "recovered") {
      const reason =
        recovery.status === "ambiguous"
          ? `endpoint recovery is ambiguous: ${recovery.detail}`
          : `endpoint recovery is pending: ${recovery.detail}`;
      await this.setRuntimeError(task.id, reason);
      if (
        recovery.status === "ambiguous" ||
        isOlderThan(launch.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)
      ) {
        await this.blockTask(task.id, reason);
      }
      return undefined;
    }
    try {
      await this.saveEndpoint(task.id, recovery.endpoint);
    } catch (error) {
      const reason = `recovered endpoint identity could not be persisted: ${describeError(error)}`;
      await this.setRuntimeError(task.id, reason);
      return undefined;
    }
    return this.runtimeFor(task.id);
  }

  private async reconcilePresentationEndpointLaunch(
    runtime: RuntimePresentation,
  ): Promise<RuntimePresentation | undefined> {
    const launch = runtime.endpointLaunch;
    if (launch === undefined) return runtime;
    if (runtime.reservation?.ownerSessionId !== this.#deps.sessionId) {
      await this.setPresentationError(
        runtime.id,
        "endpoint launch is owned by another session; recovery was not attempted",
      );
      return undefined;
    }
    const recovery = await recoverEndpointFromLaunch(this.#deps.run, launch);
    if (recovery.status !== "recovered") {
      const reason =
        recovery.status === "ambiguous"
          ? `presentation endpoint recovery is ambiguous: ${recovery.detail}`
          : `presentation endpoint recovery is pending: ${recovery.detail}`;
      await this.setPresentationError(runtime.id, reason);
      return undefined;
    }
    try {
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
        replaceRuntimePresentation(state, runtime.id, (current) => {
          const { endpointLaunch: _endpointLaunch, ...withoutLaunch } = current;
          return {
            ...withoutLaunch,
            endpoint: recovery.endpoint,
            job: { ...current.job, endpoint: recovery.endpoint },
          };
        }),
      );
    } catch (error) {
      await this.setPresentationError(
        runtime.id,
        `recovered presentation endpoint identity could not be persisted: ${describeError(error)}`,
      );
      return undefined;
    }
    const state = await this.readState();
    return presentationRuntime(state, runtime.id);
  }

  private async removeEndpoint(taskId: string, paneId: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        endpoints: current.endpoints.filter((endpoint) => endpoint.paneId !== paneId),
      })),
    );
    await this.updateTask(taskId, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      endpoints: (current.endpoints ?? []).filter((endpoint) => endpoint.paneId !== paneId),
    }));
  }

  private async setReservationPhase(
    taskId: string,
    phase: DurableReservation["phase"],
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        ...(current.reservation === undefined
          ? {}
          : { reservation: { ...current.reservation, phase } }),
      })),
    );
  }

  private async setRuntimeError(taskId: string, error: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) =>
        current.lastError === error ? current : { ...current, lastError: error },
      ),
    );
  }
  private async setPresentationError(id: string, error: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimePresentation(state, id, (current) =>
        current.lastError === error ? current : { ...current, lastError: error },
      ),
    );
  }

  private async controlTask(
    taskId: string,
    action: ControlAction,
    reason: string | undefined,
  ): Promise<TaskRecord> {
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined) throw new Error(`task ${taskId} is missing`);
      const terminal =
        task.stage === "cancelled" || task.stage === "completed" || task.stage === "merged";
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (terminal) {
        if (runtime !== undefined) {
          const resources = await this.inspectOwnedResources(task, runtime);
          if (resources.failure !== undefined) {
            throw new Error(`cannot confirm task ${taskId} is stopped: ${resources.failure}`);
          }
          if (resources.abandonedJobIds.length > 0 || resources.terminalJobIds.length > 0) {
            throw new Error(
              `cannot confirm task ${taskId} is stopped: a durable worker job remains`,
            );
          }
        }
        return task;
      }
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);

      const event: TaskEvent =
        action === "pause"
          ? { type: "pause", reason: reason ?? "paused by coordinator" }
          : { type: "cancel", ...(reason === undefined ? {} : { reason }) };
      const planned = transitionTask(task, event, this.context());
      const stopRequest: DurableStopRequest = {
        schemaVersion: 1,
        action,
        generation: task.generation,
        requestedAt: this.#deps.clock(),
      };
      const requested = replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        stopRequest,
        lastError: `${action} requested`,
      }));
      await writeRuntimeState(this.#deps.runtimePath, requested);

      const cwd = runtime.worktree?.path ?? task.repoPath;
      let stopFailure: string | undefined;
      for (const endpoint of runtime.endpoints) {
        try {
          await interruptEndpoint(this.#deps.run, { endpoint, cwd });
          const inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
          if (inspection.activeWorker) {
            stopFailure = `pane ${endpoint.paneId} still has an active worker`;
          }
        } catch (error) {
          stopFailure = `pane ${endpoint.paneId} could not be proven stopped: ${describeError(error)}`;
        }
      }
      if (runtime.jobs.some(activeRuntimeJob) && runtime.endpoints.length === 0) {
        stopFailure = "a durable worker job has no endpoint identity";
      }
      if (stopFailure !== undefined) {
        const blockedReason = `could not safely ${action} task ${taskId}: ${stopFailure}`;
        const failedState = replaceRuntimeTask(requested, taskId, (current) => ({
          ...current,
          lastError: blockedReason,
        }));
        await writeRuntimeState(this.#deps.runtimePath, failedState);
        const blocked =
          task.stage === "paused" || task.stage === "blocked"
            ? task
            : transitionTask(task, { type: "block", reason: blockedReason }, this.context());
        if (blocked !== task) await store.update(task.id, task.revision, () => blocked);
        return blocked;
      }
      await store.update(task.id, task.revision, () => planned);
      return planned;
    });
  }

  private async resumeTask(taskId: string): Promise<TaskRecord> {
    const outcome = await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined) throw new Error(`task ${taskId} is missing`);
      if (task.stage !== "paused" && task.stage !== "blocked") {
        return { task, resumed: false };
      }
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const resources = await this.inspectOwnedResources(task, runtime);
      if (resources.failure !== undefined) {
        const message = `cannot resume task ${taskId} until owned workers are stopped: ${resources.failure}`;
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(state, taskId, (current) => ({ ...current, lastError: message })),
        );
        throw new Error(message);
      }
      const abandonedJobIds = new Set(resources.abandonedJobIds);
      const resumed = transitionTask(task, { type: "resume" }, this.context());
      const clearStopRequest = replaceRuntimeTask(state, taskId, (current) => {
        const { stopRequest: _stopRequest, lastError: _lastError, ...withoutControl } = current;
        const jobs: readonly DurableJob[] =
          abandonedJobIds.size === 0
            ? current.jobs
            : current.jobs.map(
                (job): DurableJob =>
                  abandonedJobIds.has(job.id)
                    ? {
                        ...job,
                        phase: "failed",
                        error:
                          "worker stopped before writing a terminal result; continuation will be dispatched",
                      }
                    : job,
              );
        const reservation = withoutControl.reservation;
        if (
          abandonedJobIds.size === 0 ||
          jobs.some(activeRuntimeJob) ||
          reservation === undefined ||
          reservation.phase === "released"
        ) {
          return { ...withoutControl, jobs };
        }
        return {
          ...withoutControl,
          jobs,
          reservation: {
            ...reservation,
            phase: "released",
            releasedAt: this.#deps.clock(),
          },
        };
      });
      await writeRuntimeState(this.#deps.runtimePath, clearStopRequest);
      await store.update(task.id, task.revision, () => resumed);
      return { task: resumed, resumed: true };
    });
    if (!outcome.resumed) return outcome.task;
    const current = await this.get(taskId);
    const runtime = await this.runtimeFor(taskId);
    const shouldContinue =
      runtime !== undefined &&
      (runtime.jobs.some(activeRuntimeJob) ||
        ((current.stage === "scouting" || current.stage === "implementing") &&
          runtime.worktree !== undefined &&
          currentWriter(runtime) !== undefined));
    if (shouldContinue) await this.reconcileTask(current);
    return this.get(taskId);
  }

  private async probeOwnedEndpoint(endpoint: Endpoint, cwd: string): Promise<OwnedEndpointProbe> {
    try {
      const inspection: HerdrPaneInspection = await inspectEndpoint(this.#deps.run, {
        endpoint,
        cwd,
      });
      return inspection.activeWorker
        ? { status: "active", detail: `pane ${endpoint.paneId} still has an active worker` }
        : { status: "stopped", detail: undefined };
    } catch (error) {
      if (error instanceof EndpointOwnershipError && error.reason === "missing") {
        return { status: "missing", detail: `pane ${endpoint.paneId} is no longer present` };
      }
      return { status: "rejected", detail: describeError(error) };
    }
  }

  private async probeTerminalResult(job: DurableJob): Promise<TerminalResultProbe> {
    try {
      if (job.kind === "validation") {
        if (job.role !== "validation" || job.head === undefined) {
          return { status: "invalid", detail: "validation job has no complete identity" };
        }
        await readValidationResult(job.resultPath, {
          id: job.id,
          taskId: job.taskId,
          generation: job.generation,
          head: job.head,
        });
      } else {
        if (job.role === "validation") {
          return { status: "invalid", detail: "worker job has validation role" };
        }
        await readWorkerResult(job.resultPath, {
          id: job.id,
          taskId: job.taskId,
          generation: job.generation,
          role: job.role,
        });
      }
      return { status: "valid" };
    } catch (error) {
      if (isMissing(error)) return { status: "missing" };
      return { status: "invalid", detail: describeError(error) };
    }
  }

  private async inspectOwnedResources(
    task: TaskRecord,
    runtime: RuntimeTaskState,
  ): Promise<ResumeResourceCheck> {
    const empty = (failure: string | undefined): ResumeResourceCheck => ({
      failure,
      abandonedJobIds: [],
      terminalJobIds: [],
    });
    if (runtime.endpointLaunch !== undefined) {
      return empty("an endpoint launch identity is unresolved");
    }
    const cwd = runtime.worktree?.path ?? task.repoPath;
    const activeJobs = runtime.jobs.filter(activeRuntimeJob);
    const dependentPanes = new Set(
      activeJobs.flatMap((job) => (job.endpoint === undefined ? [] : [job.endpoint.paneId])),
    );
    const probes = new Map<string, OwnedEndpointProbe>();
    const probe = async (endpoint: Endpoint): Promise<OwnedEndpointProbe> => {
      const known = probes.get(endpoint.paneId);
      if (known !== undefined) return known;
      const result = await this.probeOwnedEndpoint(endpoint, cwd);
      probes.set(endpoint.paneId, result);
      return result;
    };
    for (const endpoint of runtime.endpoints) {
      const result = await probe(endpoint);
      if (result.status === "active") return empty(result.detail);
      if (result.status === "rejected")
        return empty(`pane ${endpoint.paneId} could not be proven owned: ${result.detail}`);
      if (result.status === "missing" && dependentPanes.has(endpoint.paneId)) {
        return empty(`pane ${endpoint.paneId} is missing while an active job depends on it`);
      }
    }
    const abandonedJobIds: string[] = [];
    const terminalJobIds: string[] = [];
    for (const job of activeJobs) {
      if (job.generation !== task.generation) {
        return empty(
          `durable job ${job.id} belongs to generation ${job.generation}, not ${task.generation}`,
        );
      }
      const endpoint = job.endpoint;
      if (endpoint === undefined) return empty(`durable job ${job.id} has no endpoint identity`);
      const result = await probe(endpoint);
      if (result.status === "active") return empty(result.detail);
      if (result.status === "missing") {
        return empty(`pane ${endpoint.paneId} is missing while durable job ${job.id} is active`);
      }
      if (result.status === "rejected") {
        return empty(`pane ${endpoint.paneId} could not be proven owned: ${result.detail}`);
      }
      const terminal = await this.probeTerminalResult(job);
      if (terminal.status === "valid") {
        terminalJobIds.push(job.id);
      } else if (terminal.status === "missing") {
        abandonedJobIds.push(job.id);
      } else {
        return empty(`durable job ${job.id} has an invalid terminal result: ${terminal.detail}`);
      }
    }
    return { failure: undefined, abandonedJobIds, terminalJobIds };
  }
  private async reconcileStopRequest(task: TaskRecord, runtime: RuntimeTaskState): Promise<void> {
    const cwd = runtime.worktree?.path ?? task.repoPath;

    for (const endpoint of runtime.endpoints) {
      try {
        let inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        if (inspection.activeWorker) {
          await interruptEndpoint(this.#deps.run, { endpoint, cwd });
          inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        }
        if (inspection.activeWorker) {
          await this.setRuntimeError(
            task.id,
            `stop request remains pending because pane ${endpoint.paneId} is still active`,
          );
          return;
        }
      } catch (error) {
        await this.setRuntimeError(
          task.id,
          `stop request could not stop pane ${endpoint.paneId}: ${describeError(error)}`,
        );
        return;
      }
    }
    const active = runtime.jobs.find(activeRuntimeJob);
    if (active !== undefined) {
      await this.reconcileJob(task, runtime, active);
      return;
    }
    if (
      task.stage === "paused" ||
      task.stage === "blocked" ||
      task.stage === "cancelled" ||
      task.stage === "completed" ||
      task.stage === "merged"
    ) {
      return;
    }
    const event: TaskEvent =
      runtime.stopRequest?.action === "pause"
        ? { type: "pause", reason: "pause request recovered after restart" }
        : { type: "cancel", reason: "cancel request recovered after restart" };
    try {
      await this.transition(task.id, event);
    } catch (error) {
      await this.setRuntimeError(
        task.id,
        `stop request could not complete: ${describeError(error)}`,
      );
    }
  }
  private async redirectToPrimary(
    taskId: string,
    instruction?: Readonly<{ text: string; supersedes?: readonly string[] }>,
  ): Promise<TaskRecord> {
    return this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined) throw new Error(`task ${taskId} is missing`);
      if (task.stage === "cancelled" || task.stage === "merged") {
        throw new Error(`Task ${taskId} cannot be steered while it is ${task.stage}`);
      }
      const communication =
        instruction === undefined
          ? task.communication
          : appendTaskMessage(task.communication, {
              id: singleLine(this.#deps.idFactory(), "message id"),
              kind: "instruction",
              text: instruction.text,
              createdAt: this.#deps.clock(),
              ...(instruction.supersedes === undefined
                ? {}
                : { supersedes: instruction.supersedes }),
            });
      const withInstruction = (candidate: TaskRecord): TaskRecord =>
        instruction === undefined || communication === undefined
          ? candidate
          : { ...candidate, communication };
      const targetStages = ["validating", "reviewing", "ready", "awaiting-fixes"];
      if (!targetStages.includes(task.stage)) {
        if (instruction === undefined) return task;
        const updated = await store.update(task.id, task.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          updatedAt: this.#deps.clock(),
          ...(communication === undefined ? {} : { communication }),
        }));
        await this.publishTaskInbox(updated);
        return updated;
      }
      if (task.reviewHead === undefined) {
        const blocked = withInstruction(
          transitionTask(
            task,
            { type: "block", reason: "cannot redirect task without reviewed HEAD" },
            this.context(),
          ),
        );
        await store.update(task.id, task.revision, () => blocked);
        await this.publishTaskInbox(blocked);
        return blocked;
      }
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
      const cwd = runtime.worktree?.path ?? task.repoPath;
      const requested = replaceRuntimeTask(state, taskId, (current) => ({
        ...current,
        stopRequest: {
          schemaVersion: 1,
          action: "pause",
          generation: task.generation,
          requestedAt: this.#deps.clock(),
        },
        lastError: "new instruction requires evidence invalidation",
      }));
      await writeRuntimeState(this.#deps.runtimePath, requested);
      let stopFailure: string | undefined;
      for (const endpoint of runtime.endpoints) {
        try {
          let inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
          if (inspection.activeWorker) {
            await interruptEndpoint(this.#deps.run, { endpoint, cwd });
            inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
          }
          if (inspection.activeWorker) {
            stopFailure = `pane ${endpoint.paneId} still has an active worker`;
            break;
          }
        } catch (error) {
          stopFailure = `pane ${endpoint.paneId} could not be proven stopped: ${describeError(error)}`;
          break;
        }
      }
      if (stopFailure !== undefined) {
        const reason = `could not safely redirect task ${taskId}: ${stopFailure}`;
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(requested, taskId, (current) => ({ ...current, lastError: reason })),
        );
        const blocked = withInstruction(
          transitionTask(task, { type: "block", reason }, this.context()),
        );
        await store.update(task.id, task.revision, () => blocked);
        await this.publishTaskInbox(blocked);
        return blocked;
      }
      const reviewers = runtime.endpoints.filter(
        (endpoint) => endpoint.role === "reviewer" || endpoint.role === "verifier",
      );
      for (const endpoint of reviewers) {
        try {
          await closeEndpoint(this.#deps.run, { endpoint, cwd });
        } catch (error) {
          if (!isMissingEndpoint(error)) {
            const reason = `reviewer pane ${endpoint.paneId} could not close: ${describeError(error)}`;
            const blocked = withInstruction(
              transitionTask(task, { type: "block", reason }, this.context()),
            );
            await store.update(task.id, task.revision, () => blocked);
            await this.publishTaskInbox(blocked);
            return blocked;
          }
        }
      }
      const redirected = withInstruction(
        transitionTask(
          task,
          { type: "invalidate-evidence", head: task.reviewHead, generation: task.generation },
          this.context(),
        ),
      );
      const endpoints = (redirected.endpoints ?? [])
        .filter((endpoint) => endpoint.role === "scout" || endpoint.role === "implementer")
        .map((endpoint) => ({ ...endpoint, generation: redirected.generation }));
      const nextTask = { ...redirected, endpoints };
      await store.update(task.id, task.revision, () => nextTask);
      const nextRuntime = replaceRuntimeTask(requested, taskId, (current) => {
        const jobs = current.jobs.map((job) =>
          activeRuntimeJob(job)
            ? {
                ...job,
                phase: "failed" as const,
                error: "job invalidated by newer user instruction",
              }
            : job,
        );
        const reservation = current.reservation;
        const {
          stopRequest: _stopRequest,
          fixContextPath: _fixContextPath,
          ...withoutTransient
        } = current;
        return {
          ...withoutTransient,
          endpoints: current.endpoints
            .filter((endpoint) => endpoint.role === "scout" || endpoint.role === "implementer")
            .map((endpoint) => ({ ...endpoint, generation: redirected.generation })),
          jobs,
          ...(reservation === undefined
            ? {}
            : {
                reservation: {
                  ...reservation,
                  phase: "released" as const,
                  releasedAt: this.#deps.clock(),
                },
              }),
        };
      });
      await writeRuntimeState(this.#deps.runtimePath, nextRuntime);
      await this.publishTaskInbox(nextTask);
      return nextTask;
    });
  }

  private async readWorkerCheckout(
    runtime: RuntimeTaskState,
    job: Pick<DurableJob, "cwd" | "head">,
  ): Promise<CurrentCheckout> {
    const expectedHead = job.head ?? runtime.worktree?.baseHead;
    if (expectedHead === undefined) throw new Error("worker checkout has no expected HEAD");
    const checkpoint =
      runtime.worktree?.baseHead === undefined
        ? await readCheckpoint(this.#deps.run, { repo: job.cwd })
        : await readCheckpoint(this.#deps.run, {
            repo: job.cwd,
            baseRef: runtime.worktree.baseHead,
          });
    return { checkpoint, expectedHead };
  }

  private assertSourceUnchanged(pinned: GitCheckpoint, current: GitCheckpoint): void {
    if (
      pinned.head !== current.head ||
      pinned.dirty !== current.dirty ||
      pinned.unmerged !== current.unmerged ||
      current.dirty ||
      current.unmerged
    ) {
      throw new Error(
        `source checkpoint changed from ${pinned.head} to ${current.head} or is dirty`,
      );
    }
  }

  private async appendAnswer(
    taskId: string,
    questionId: string,
    textValue: string,
  ): Promise<{ readonly task: TaskRecord; readonly resumed: boolean }> {
    let result: { readonly task: TaskRecord; readonly resumed: boolean } | undefined;
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined) throw new Error(`task ${taskId} is missing`);
      if (task.stage === "cancelled" || task.stage === "merged") {
        throw new Error(`Task ${taskId} cannot be answered while it is ${task.stage}`);
      }
      if (task.communication?.question?.id !== questionId) {
        throw new Error(`question ${questionId} is no longer current for task ${taskId}`);
      }
      const communication = appendTaskMessage(task.communication, {
        id: singleLine(this.#deps.idFactory(), "answer id"),
        kind: "answer",
        text: textValue,
        createdAt: this.#deps.clock(),
        replyTo: questionId,
      });
      const answered = await store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: this.#deps.clock(),
        communication,
      }));
      await this.publishTaskInbox(answered);
      result = {
        task: answered,
        resumed:
          answered.stage === "blocked" &&
          answered.previousStage !== undefined &&
          answered.previousStage !== "paused" &&
          answered.previousStage !== "blocked",
      };
    });
    if (result === undefined) throw new Error(`answer for task ${taskId} was not saved`);
    return result;
  }

  private async publishTaskInbox(task: TaskRecord): Promise<void> {
    if (task.communication === undefined) return;
    try {
      await writeTaskInbox(
        taskInboxPath(this.#deps.home, task.id),
        taskInbox(task.id, task.communication),
      );
    } catch {
      // Canonical communication is already durable; the next messages read repairs this projection.
    }
  }

  private async repairTaskInbox(taskId: string): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || task.communication === undefined) return;
      const path = taskInboxPath(this.#deps.home, task.id);
      const expected = taskInbox(task.id, task.communication);
      try {
        const current = await readTaskInbox(path);
        if (JSON.stringify(current) !== JSON.stringify(expected))
          await writeTaskInbox(path, expected);
      } catch {
        await writeTaskInbox(path, expected);
      }
    });
  }

  private async communicationView(task: TaskRecord): Promise<TaskCommunicationView> {
    const communication = task.communication;
    const allMessages = communication?.messages ?? [];
    const superseded = new Set<string>();
    for (const message of allMessages) {
      for (const id of message.supersedes ?? []) superseded.add(id);
    }
    const runtime = await this.runtimeFor(task.id);
    const primaryRole: WorkerRole = task.kind === "scout" ? "scout" : "implementer";
    let activity: WorkerReceipt | undefined;
    if (runtime !== undefined) {
      const jobs = [...runtime.jobs]
        .filter(
          (job) =>
            job.kind === "worker" &&
            job.role === primaryRole &&
            job.generation === task.generation &&
            job.receiptPath !== undefined,
        )
        .reverse();
      for (const job of jobs) {
        const receipt = await readWorkerReceipt(job.receiptPath as string, {
          jobId: job.id,
          taskId: task.id,
          generation: job.generation,
        }).catch(() => undefined);
        if (receipt !== undefined) {
          activity = receipt;
          break;
        }
      }
    }
    const messages = allMessages.map((message) => ({
      ...message,
      status: superseded.has(message.id)
        ? ("superseded" as const)
        : activity === undefined
          ? ("pending" as const)
          : activity.appliedRevision >= message.revision
            ? ("applied" as const)
            : activity.receivedRevision >= message.revision
              ? ("received" as const)
              : ("pending" as const),
    }));
    return {
      taskId: task.id,
      stage: task.stage,
      revision: communication?.revision ?? 0,
      messages,
      ...(communication?.question === undefined ? {} : { question: communication.question }),
      ...(activity === undefined ? {} : { activity }),
    };
  }

  private async transition(taskId: string, event: TaskEvent): Promise<TaskRecord> {
    const task = await this.get(taskId);
    const context = this.context();
    return transitionStoredTask(this.#deps.store, taskId, task.revision, event, context);
  }

  private context(): TaskTransitionContext {
    return {
      now: this.#deps.clock(),
      notificationId: singleLine(this.#deps.idFactory(), "notification id"),
    };
  }

  private async updateTask(
    taskId: string,
    transform: (task: TaskRecord) => TaskRecord,
  ): Promise<TaskRecord> {
    const current = await this.get(taskId);
    return this.#deps.store.update(taskId, current.revision, transform);
  }

  private async blockTask(taskId: string, reason: string): Promise<TaskRecord> {
    const task = await this.get(taskId);
    if (["cancelled", "completed", "merged", "paused", "blocked"].includes(task.stage)) return task;
    return this.transition(taskId, { type: "block", reason: text(reason, "block reason") });
  }

  private async runtimeFor(taskId: string): Promise<RuntimeTaskState | undefined> {
    const state = await this.readState();
    return taskRuntime(state, taskId);
  }

  private async readState(): Promise<RuntimeState> {
    return this.#deps.store.exclusive(() => readRuntimeState(this.#deps.runtimePath));
  }

  private async resultExists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  private async removeRuntimeResources(taskId: string, terminalRevision?: number): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) => {
        const {
          endpointLaunch: _endpointLaunch,
          stopRequest: _stopRequest,
          lastError: _lastError,
          poolAdmissionKey: _poolAdmissionKey,
          poolNotice: _poolNotice,
          worktree: _worktree,
          ...withoutTransientState
        } = current;
        return {
          ...withoutTransientState,
          ...(current.reservation === undefined
            ? {}
            : {
                reservation: {
                  ...current.reservation,
                  phase: "released",
                  releasedAt: this.#deps.clock(),
                },
              }),
          endpoints: [],
          ...(terminalRevision === undefined ? {} : { terminalCleanupRevision: terminalRevision }),
        };
      }),
    );
  }

  private async readPresentation(id: string): Promise<PresentationRecord> {
    const state = await this.readState();
    const runtime = presentationRuntime(state, id);
    if (runtime === undefined) throw new Error(`presentation ${id} is missing`);
    return readPresentationRecord(runtime.recordPath);
  }
}

function serviceDependencies(options: TandemServiceOptions): ServiceDependencies {
  if (!isRecord(options)) throw new TypeError("TandemServiceOptions must be an object");
  const home = absoluteDirectory(options.home, "home");
  const sessionId = singleLine(options.sessionId, "sessionId");
  const poolRoot =
    options.poolRoot === undefined
      ? join(home, "pool")
      : absoluteDirectory(options.poolRoot, "poolRoot");
  const workerTimeoutMs =
    options.workerTimeoutMs === undefined
      ? undefined
      : positiveInteger(options.workerTimeoutMs, "workerTimeoutMs");
  const run = options.run ?? runCommand;
  if (typeof run !== "function") throw new TypeError("run must be a command runner");
  const clock = options.clock ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? defaultIdFactory();
  if (typeof clock !== "function" || typeof idFactory !== "function")
    throw new TypeError("clock and idFactory must be functions");
  return {
    home,
    sessionId,
    parentWorkspaceId:
      options.parentWorkspaceId === undefined
        ? undefined
        : singleLine(options.parentWorkspaceId, "parentWorkspaceId"),
    poolRoot,
    workerTimeoutMs,
    run,
    clock,
    idFactory,
    store: createTaskStore({ directory: join(home, "tasks"), clock, idFactory }),
    runtimePath: runtimeFile(home),
    workerPath: fileURLToPath(new URL("./worker.ts", import.meta.url)),
    validationWorkerPath: fileURLToPath(new URL("./validation-worker.ts", import.meta.url)),
  };
}

export function createTandemService(options: TandemServiceOptions): TandemService {
  return new TandemController(serviceDependencies(options)).api();
}
