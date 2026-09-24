import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../adapters/commands.ts";
import { readCheckpoint } from "../adapters/git.ts";
import { closeEndpoint } from "../adapters/herdr.ts";
import type { OmpModelRecord } from "../adapters/omp.ts";
import { listOmpModels } from "../adapters/omp.ts";
import { ApprovalRequiredError } from "../adapters/primitives.ts";
import { releaseWorktree } from "../adapters/treehouse.ts";
import {
  type ModelSettings,
  parseModelAssignments,
  readModelSettings,
  writeModelSettings,
} from "../config/models.ts";
import {
  type BalancedProfileProposal,
  discoveredProviders,
  resolveBalancedProfile,
} from "../config/operating-profile.ts";
import {
  type OnboardRepoResult,
  onboardRepo,
  readCleanupCommands,
  resolveRepoPolicy,
} from "../config/repositories.ts";
import type { CreatableTaskKind, RequestBriefRecord } from "../contracts.ts";
import {
  type AnswerTaskInput,
  type BlockCause,
  type Clock,
  type CommandRunner,
  type IdFactory,
  MAX_RESEARCH_HANDOFF_COUNT,
  MAX_RESEARCH_HANDOFF_EXCERPT_BYTES,
  MAX_RESEARCH_HANDOFF_TOTAL_BYTES,
  type PullRequestMetadata,
  type RepoPolicy,
  type ResearchContinuation,
  type ResearchHandoff,
  type SkillInvocation,
  type SteerTaskInput,
  type TaskCommunicationView,
  type TaskRecord,
} from "../contracts.ts";
import { withCoordinatorLaunchLock } from "../coordinator/lock.ts";
import { describeTaskPr, draftProgressDigest, type PrSummary } from "../delivery/evidence.ts";
import { type DeliveryPreflightResult, deliveryPreflight } from "../delivery/preflight.ts";
import {
  type DraftPublication,
  mergeReviewedTask,
  publishReviewedTask,
  publishTaskDraft,
  refreshTaskDraft,
} from "../delivery/pull-requests.ts";
import { maintainPool } from "../pool/maintenance.ts";
import {
  isPoolNotification,
  isPoolNotificationForKey,
  type PoolMaintenanceResult,
  poolAdmissionKey,
  poolAdmissionNotice,
  poolNotificationMessage,
} from "../pool/policy.ts";
import type { ReviewVerdict } from "../pr-review/post.ts";
import {
  createPrReviewWorkflow,
  defaultProjectRoots,
  type PostPrReviewResult,
  type PrReviewEdits,
  type PrReviewWorkflow,
  type ShowPrReviewResult,
  type StartPrReviewInput,
  type StartPrReviewResult,
} from "../pr-review/service.ts";
import type { PrReviewState } from "../pr-review/state.ts";
import { removeReviewWorktree } from "../pr-review/worktree.ts";
import { PresentationFeedbackWorkflow } from "../presentations/feedback.ts";
import { type PresentationRecord, readPresentationRecord } from "../presentations/records.ts";
import { preparePresentation } from "../presentations/session.ts";
import { PresentationRuntimeWorkflow } from "../presentations/workflow.ts";
import {
  CentralRecoveryWorkflow,
  RESTART_QUESTION_ID_PREFIX,
  reportBlock,
  VALIDATION_RETRY_QUESTION_ID_PREFIX,
} from "../recovery/central.ts";
import { createRequestBriefStore, type RequestBriefStore } from "../requests/store.ts";
import {
  type ApproveRequestBriefInput,
  type DraftRequestBriefInput,
  type RequestBriefView,
  RequestBriefWorkflow,
} from "../requests/workflow.ts";
import {
  activeReservations,
  activeRuntimeJob,
  presentationRuntime,
  taskRuntime,
  unreleasedReservation,
} from "../runtime/activity.ts";
import { withStateLock } from "../runtime/database.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import {
  defaultIdFactory,
  readRuntimeState,
  runtimeFile,
  taskJobsDirectory,
  taskSessionDirectory,
  updateRuntimeState,
  writeJsonAtomically,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type {
  DurableJob,
  DurableReservation,
  RuntimePresentation,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import type { RequestUsageEvent } from "../runtime/usage.ts";
import {
  type JobTokenTally,
  requestIntakeEvent,
  requestTerminalEvent,
  settledWorkEvents,
} from "../runtime/usage-events.ts";
import {
  createRequestUsageLedger,
  type RequestUsageLedger,
  readCoordinatorUsage,
} from "../runtime/usage-ledger.ts";
import { coordinatorShare, type RequestUsageReceipt } from "../runtime/usage-receipt.ts";
import { TaskControlWorkflow } from "../tasks/control.ts";
import { KEEP_FIXING_QUESTION_ID_PREFIX, keepFixingGrant } from "../tasks/findings.ts";
import { inspectTask, type TaskInspection } from "../tasks/inspection.ts";
import type { TaskEvent, TaskTransitionContext } from "../tasks/lifecycle.ts";
import { transitionTask } from "../tasks/lifecycle.ts";
import {
  DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS,
  type ResearchContinuationClassifier,
  researchContinuationClassifier,
} from "../tasks/research-continuation-classifier.ts";
import {
  type ReviewAssistanceRuntime,
  reviewAssistanceConfig,
  reviewAssistanceRuntime,
} from "../tasks/review-assistance.ts";
import {
  createTaskStore,
  type TaskStore,
  type TaskStoreTransaction,
  transitionStoredTask,
} from "../tasks/store.ts";
import type { ModelCatalogueSnapshot } from "../workers/execution-routing.ts";
import { readWorkerTokenTally } from "../workers/terminal.ts";
import { prepareWorkerTerminal, workerJobForEndpoint } from "../workers/terminal-control.ts";
import { type OperationClaim, WorkerWorkflow } from "../workers/workflow.ts";
import {
  absoluteDirectory,
  currentWriter,
  describeError,
  durableOperation,
  isMissing,
  isMissingEndpoint,
  isRecord,
  isTerminalTask,
  makeDurableJob,
  positiveInteger,
  readTextList,
  replaceRuntimeTask,
  reportPathFor,
  serializedIdentity,
  singleLine,
  taskInputFor,
  taskNameFor,
  text,
  validateModelAssignments,
  workerRoleForTask,
} from "./records.ts";
import {
  releaseTerminalTaskResources,
  runCleanupCommands,
  type TerminalTaskCleanupOptions,
} from "./scout-cleanup.ts";
import { mapTaskSource, SourceInboxWorkflow, taskSourcePath } from "./source.ts";

export type CreateTaskRequest = Readonly<{
  readonly repoPath: string;
  readonly kind: CreatableTaskKind;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  /** Hands-on checks a person makes before merging; they become the PR's checklist. */
  readonly manualVerification?: readonly string[];
  readonly surfaces: readonly string[];
  /** The request brief this task is created under; dispatch stays blocked while it is superseded. */
  readonly requestId?: string;
  readonly researchTaskIds?: readonly string[];
  /** Explicitly selected post-research disposition; scouts otherwise take the safe default. */
  readonly researchContinuation?: ResearchContinuation;
  /** An explicit user-invoked skill to pin to this task, opaque to Tandem. */
  readonly skill?: SkillInvocation;
}>;
/** The internal create request behind `reviewPr`; the generic create action never takes it. */
type PrReviewTaskRequest = Omit<CreateTaskRequest, "kind"> &
  Readonly<{ readonly kind: "pr-review"; readonly prReview: PrReviewState }>;
export type ModelOptionsResult = Readonly<{
  readonly modelSettings: ModelSettings;
  readonly availableModels: readonly OmpModelRecord[];
  /** Providers the OMP catalogue discovered; discovery alone never authorizes spending. */
  readonly discoveredProviders: readonly string[];
  /** The Balanced profile resolved from `modelSettings.enabledProviders` against this catalogue. */
  readonly balancedProfile: BalancedProfileProposal;
}>;
export type SourceRefreshResult = Readonly<{
  readonly head: string;
  readonly previousHead: string;
  readonly changed: boolean;
  readonly localOnly: boolean;
}>;
export type TandemServiceOptions = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly parentWorkspaceId?: string;
  /** The Herdr pane the coordinator runs in; request review panes split beside it when known. */
  readonly coordinatorPaneId?: string;
  readonly poolRoot?: string;
  readonly sourceWorkspace?: Readonly<{
    readonly repoPath: string;
    readonly path: string;
  }>;
  /** Callback runs under coordinator launch-lock then task-store serialization; it must not reacquire the launch lock. */
  readonly refreshSource?: () => Promise<SourceRefreshResult>;
  readonly workerTimeoutMs?: number;
  readonly run?: CommandRunner;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
  /** Chooses a new scout's post-research disposition; defaults to deterministic cues alone. */
  readonly classifyResearchContinuation?: ResearchContinuationClassifier;
  /** The Jev transport, cache, and diagnostics sink review-level assistance is allowed to use. */
  readonly reviewAssistance?: ReviewAssistanceRuntime;
  /** Folders a PR review crawls for the repository's checkout; see `defaultProjectRoots`. */
  readonly projectRoots?: readonly string[];
}>;
export type TandemService = Readonly<{
  readonly onboard: (
    repoPath: string,
    write?: boolean,
    coordinatorMcpServers?: readonly string[],
  ) => Promise<OnboardRepoResult>;
  readonly models: (repoPath: string) => Promise<ModelOptionsResult>;
  readonly configureModels: (
    input: Readonly<{
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
      /** Omit to preserve the previously saved provider enablement. */
      readonly enabledProviders?: readonly string[] | undefined;
    }>,
  ) => Promise<ModelSettings>;
  readonly create: (input: CreateTaskRequest) => Promise<TaskRecord>;
  readonly refreshSource?: () => Promise<SourceRefreshResult | undefined>;
  readonly list: () => Promise<readonly TaskRecord[]>;
  readonly get: (id: string) => Promise<TaskRecord>;
  readonly inspect: (id: string) => Promise<TaskInspection>;
  readonly deliveryPreflight: (
    id: string,
    input: { readonly base: string },
  ) => Promise<DeliveryPreflightResult>;
  readonly approve: (id: string) => Promise<TaskRecord>;
  readonly draftRequestBrief: (input: DraftRequestBriefInput) => Promise<RequestBriefView>;
  readonly reviewRequestBrief: (requestId: string) => Promise<RequestBriefView>;
  readonly approveRequestBrief: (intent: ApproveRequestBriefInput) => Promise<RequestBriefView>;
  /** The one request whose brief is awaiting approval; fails closed when that is not unambiguous. */
  readonly pendingBriefApprovalId: () => Promise<string>;
  readonly requestBrief: (requestId: string) => Promise<RequestBriefView>;
  /** Without an id, the receipt is for the request in progress. */
  readonly requestReceipt: (requestId?: string) => Promise<RequestUsageReceipt>;
  readonly tick: () => Promise<readonly TaskRecord[]>;
  readonly acknowledge: (id: string, notificationId: string) => Promise<TaskRecord>;
  readonly steer: (input: SteerTaskInput) => Promise<TaskCommunicationView>;
  readonly answer: (input: AnswerTaskInput) => Promise<TaskCommunicationView>;
  readonly messages: (taskId: string) => Promise<TaskCommunicationView>;
  readonly pause: (id: string, reason?: string) => Promise<TaskRecord>;
  readonly resume: (id: string) => Promise<TaskRecord>;
  readonly restart: (id: string) => Promise<TaskRecord>;
  readonly cancel: (
    id: string,
    reason?: string,
    input?: { readonly discard?: boolean },
  ) => Promise<TaskRecord>;
  readonly describePr: (id: string, summary: PrSummary) => Promise<string>;
  readonly publish: (
    id: string,
    input: {
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
      readonly approved: boolean;
    },
  ) => Promise<TaskRecord>;
  readonly publishNow: (
    id: string,
    input: {
      readonly repository: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
      readonly approved: boolean;
    },
  ) => Promise<TaskRecord>;
  readonly publishDraft: (
    id: string,
    input: {
      readonly title: string;
      readonly base: string;
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
  /** Shows a presentation again because the user asked, even one they ended in the browser. */
  readonly openPresentation: (presentationId: string) => Promise<PresentationRecord>;
  /** Briefs for the coordinator's repository, newest first. */
  readonly requestBriefs: () => Promise<readonly RequestBriefRecord[]>;
  readonly reviewPr: (input: StartPrReviewInput) => Promise<StartPrReviewResult>;
  readonly reviewShow: (
    id: string,
    input?: { readonly page?: boolean },
  ) => Promise<ShowPrReviewResult>;
  readonly reviewNotes: (id: string) => Promise<Readonly<{ taskId: string; feedback: string }>>;
  readonly reviewEdit: (id: string, edits: PrReviewEdits) => Promise<ShowPrReviewResult>;
  readonly reviewPost: (
    id: string,
    input: { readonly verdict: ReviewVerdict; readonly approved: boolean },
  ) => Promise<PostPrReviewResult>;
  readonly reviewAgain: (id: string) => Promise<TaskRecord>;
  readonly reviewClose: (id: string) => Promise<TaskRecord>;
  readonly shutdown: () => Promise<void>;
}>;

type ServiceDependencies = Readonly<{
  home: string;
  sessionId: string;
  parentWorkspaceId: string | undefined;
  coordinatorPaneId: string | undefined;
  poolRoot: string;
  sourceWorkspace:
    | Readonly<{
        repoPath: string;
        path: string;
      }>
    | undefined;
  refreshSource: (() => Promise<SourceRefreshResult>) | undefined;
  workerTimeoutMs: number | undefined;
  run: CommandRunner;
  clock: Clock;
  idFactory: IdFactory;
  classifyResearchContinuation: ResearchContinuationClassifier;
  store: TaskStore;
  requestStore: RequestBriefStore;
  usageLedger: RequestUsageLedger;
  runtimePath: string;
  workerPath: string;
  validationWorkerPath: string;
  reviewAssistance: ReviewAssistanceRuntime;
  projectRoots: readonly string[];
}>;

function assertTaskId(id: unknown): string {
  return singleLine(id, "task id");
}

function assertArtifacts(artifacts: unknown): readonly string[] {
  return readTextList(artifacts, "artifacts");
}

function operationClaim(operation: RuntimeTaskState["operation"]): OperationClaim | undefined {
  return operation === undefined
    ? undefined
    : {
        id: operation.id,
        claimOwner: operation.claimOwner,
        fencingRevision: operation.fencingRevision,
      };
}

function pathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !relativePath.startsWith(sep)
  );
}

function boundedUtf8Prefix(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let end = Math.min(value.length, limit);
  while (end > 0) {
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (
      Buffer.byteLength(value.slice(0, end), "utf8") <= limit &&
      (lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff)
    ) {
      break;
    }
    end -= 1;
  }
  return value.slice(0, end);
}

async function readBoundedResearchReport(
  path: string,
): Promise<
  Readonly<{ readonly hasContent: boolean; readonly digest: string; readonly excerpt: string }>
> {
  const digest = createHash("sha256");
  let excerpt = "";
  let hasContent = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length === 0) continue;
    hasContent = true;
    digest.update(text);
    if (Buffer.byteLength(excerpt, "utf8") < MAX_RESEARCH_HANDOFF_EXCERPT_BYTES) {
      excerpt = boundedUtf8Prefix(`${excerpt}${text}`, MAX_RESEARCH_HANDOFF_EXCERPT_BYTES);
    }
  }
  return { hasContent, digest: digest.digest("hex"), excerpt };
}

async function resolveResearchHandoffs(
  ids: readonly string[] | undefined,
  implementationRepoPath: string,
  home: string,
  runtime: RuntimeState,
  store: Pick<TaskStoreTransaction, "read">,
): Promise<readonly ResearchHandoff[] | undefined> {
  if (ids === undefined) return undefined;
  if (ids.length > MAX_RESEARCH_HANDOFF_COUNT) {
    throw new Error(`at most ${MAX_RESEARCH_HANDOFF_COUNT} research task references are allowed`);
  }
  const projectRoot = await realpath(implementationRepoPath);
  const handoffs: ResearchHandoff[] = [];
  for (const rawId of ids) {
    const scoutTaskId = singleLine(rawId, "researchTaskIds entry");
    if (handoffs.some((entry) => entry.scoutTaskId === scoutTaskId)) {
      throw new Error(`duplicate research task reference ${scoutTaskId}`);
    }
    const scout = await store.read(scoutTaskId);
    if (scout === undefined || scout.kind !== "scout" || scout.stage !== "completed") {
      throw new Error(`research task ${scoutTaskId} is not a completed scout`);
    }
    if (scout.reportPath === undefined) {
      throw new Error(`research task ${scoutTaskId} has no completed report`);
    }
    if ((await realpath(scout.repoPath)) !== projectRoot) {
      throw new Error(`research task ${scoutTaskId} belongs to a different project`);
    }
    const runtimeTask = runtime.tasks.find((entry) => entry.taskId === scout.id);
    if (
      runtimeTask === undefined ||
      runtimeTask.sourceCheckpoint.head.length === 0 ||
      runtimeTask.sourceCheckpoint.base.length === 0 ||
      runtimeTask.sourceCheckpoint.dirty ||
      runtimeTask.sourceCheckpoint.unmerged
    ) {
      throw new Error(`research task ${scoutTaskId} has invalid or stale source provenance`);
    }
    const reportPath = resolve(scout.reportPath);
    const reportRoot = await realpath(taskJobsDirectory(home, scout.id)).catch(() => undefined);
    const physicalReport = await realpath(reportPath).catch(() => undefined);
    if (
      !isAbsolute(scout.reportPath) ||
      reportRoot === undefined ||
      physicalReport === undefined ||
      basename(physicalReport) !== "report.txt" ||
      !pathWithin(reportRoot, physicalReport)
    ) {
      throw new Error(`research task ${scoutTaskId} has an unsafe or missing report`);
    }
    const metadata = await lstat(physicalReport);
    if (!metadata.isFile()) throw new Error(`research task ${scoutTaskId} report is not a file`);
    const scoutJob = runtimeTask.jobs.find(
      (job) =>
        job.role === "scout" &&
        job.phase === "consumed" &&
        job.generation === scout.generation &&
        resolve(reportPathFor(job.jobPath)) === reportPath,
    );
    if (scoutJob === undefined) {
      throw new Error(`research task ${scoutTaskId} report provenance is stale`);
    }
    const report = await readBoundedResearchReport(physicalReport);
    if (!report.hasContent) throw new Error(`research task ${scoutTaskId} report is empty`);
    handoffs.push({
      scoutTaskId,
      scoutRepoPath: projectRoot,
      scoutSourceHead: runtimeTask.sourceCheckpoint.head,
      scoutSourceBase: runtimeTask.sourceCheckpoint.base,
      reportPath: physicalReport,
      reportDigest: report.digest,
      excerpt: report.excerpt,
    });
  }
  const totalBytes = handoffs.reduce(
    (total, handoff) => total + Buffer.byteLength(handoff.excerpt, "utf8"),
    0,
  );
  if (totalBytes > MAX_RESEARCH_HANDOFF_TOTAL_BYTES) {
    throw new Error(`research handoff exceeds ${MAX_RESEARCH_HANDOFF_TOTAL_BYTES} UTF-8 bytes`);
  }
  return handoffs;
}
function sameOperationClaim(
  operation: RuntimeTaskState["operation"],
  claim: OperationClaim | undefined,
): boolean {
  return claim === undefined
    ? operation === undefined
    : operation?.id === claim.id &&
        operation.claimOwner === claim.claimOwner &&
        operation.fencingRevision === claim.fencingRevision;
}

function sameReservationIdentity(
  left: RuntimeTaskState["reservation"],
  right: DurableReservation | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.id === right.id &&
    left.operationId === right.operationId &&
    left.ownerSessionId === right.ownerSessionId &&
    left.phase === right.phase &&
    left.createdAt === right.createdAt &&
    left.releasedAt === right.releasedAt
  );
}

/** A task advanced while a remote publication was in flight; the published result is retained. */
class TaskRevisionConflictError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} changed while publishing; remote publication is retained`);
    this.name = "TaskRevisionConflictError";
  }
}

/** Bounded, privacy-safe failure label: a class name, never message text or command payloads. */
function errorClassName(error: unknown): string {
  if (error instanceof Error) return error.name.slice(0, 64);
  return typeof error;
}

function samePullRequest(left: PullRequestMetadata, right: PullRequestMetadata): boolean {
  return (
    left.repository === right.repository &&
    left.number === right.number &&
    left.state === right.state &&
    left.head === right.head &&
    left.base === right.base
  );
}

class TandemController {
  readonly #deps: ServiceDependencies;
  readonly #source: SourceInboxWorkflow;
  readonly #presentationFeedback: PresentationFeedbackWorkflow;
  readonly #presentationRuntime: PresentationRuntimeWorkflow;
  readonly #worker: WorkerWorkflow;
  readonly #control: TaskControlWorkflow;
  readonly #recoveryCentral: CentralRecoveryWorkflow;
  readonly #requests: RequestBriefWorkflow;
  readonly #usage: RequestUsageLedger;
  readonly #prReviews: PrReviewWorkflow;
  /** Durable-state digest of the draft body last published per task, to avoid redundant refreshes. */
  readonly #draftDigests = new Map<string, string>();
  #tickPromise: Promise<readonly TaskRecord[]> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #sourceRefreshPromise: Promise<SourceRefreshResult> | undefined;
  #sourceRefreshError: string | undefined;
  #sourceReadyHead: string | undefined;
  #sourceReady = true;
  constructor(deps: ServiceDependencies) {
    this.#deps = deps;
    this.#usage = deps.usageLedger;
    this.#prReviews = createPrReviewWorkflow({
      home: deps.home,
      run: deps.run,
      clock: deps.clock,
      projectRoots: deps.projectRoots,
      listTasks: () => deps.store.list(),
      getTask: (id) => this.get(id),
      createTask: (input) =>
        this.create({
          repoPath: input.repoPath,
          kind: "pr-review",
          objective: input.objective,
          acceptanceCriteria: [],
          surfaces: [],
          prReview: input.prReview,
        }).then(async (task) => {
          await this.reconcileTask(task);
          return task;
        }),
      updatePrReview: (task, next) =>
        deps.store.update(task.id, task.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          updatedAt: deps.clock(),
          prReview: next,
        })),
      runAgain: async (task) => {
        const followUp = await this.transition(task.id, { type: "follow-up-research" });
        await this.reconcileTask(followUp);
      },
      settle: (taskId) => this.cleanupSettledTask(taskId),
    });
    this.#sourceReady = deps.refreshSource === undefined;
    this.#source = new SourceInboxWorkflow({
      home: deps.home,
      sourceWorkspace: deps.sourceWorkspace,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      store: deps.store,
      runtimePath: deps.runtimePath,
    });
    this.#presentationFeedback = new PresentationFeedbackWorkflow({
      store: deps.store,
      runtimePath: deps.runtimePath,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      readTask: (taskId) => this.get(taskId),
      taskInScope: (task) => this.#source.taskInScope(task),
    });
    this.#presentationRuntime = new PresentationRuntimeWorkflow({
      sessionId: deps.sessionId,
      parentWorkspaceId: deps.parentWorkspaceId,
      workerPath: deps.workerPath,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      store: deps.store,
      runtimePath: deps.runtimePath,
      readState: () => this.readState(),
      readTask: (taskId) => this.get(taskId),
      taskInScope: (task) => this.#source.taskInScope(task),
      feedback: this.#presentationFeedback,
    });
    this.#worker = new WorkerWorkflow({
      home: deps.home,
      sessionId: deps.sessionId,
      parentWorkspaceId: deps.parentWorkspaceId,
      poolRoot: deps.poolRoot,
      workerTimeoutMs: deps.workerTimeoutMs,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      store: deps.store,
      runtimePath: deps.runtimePath,
      workerPath: deps.workerPath,
      validationWorkerPath: deps.validationWorkerPath,
      getTask: (taskId) => this.get(taskId),
      taskInScope: (task) => this.#source.taskInScope(task),
      runtimeFor: (taskId) => this.runtimeFor(taskId),
      readState: () => this.readState(),
      resultExists: (path) => this.resultExists(path),
      updateTask: (taskId, transform) => this.updateTask(taskId, transform),
      transition: (taskId, event) => this.transition(taskId, event),
      context: () => this.context(),
      blockTask: (taskId, reason, cause) => this.blockTask(taskId, reason, cause),
      publishTaskInbox: (task) => this.#source.publishTaskInbox(task),
      removeEndpoint: (taskId, paneId) => this.removeEndpoint(taskId, paneId),
      setRuntimeError: (taskId, error) => this.setRuntimeError(taskId, error),
      maintainPoolForAllocation: (task) => this.maintainPoolForAllocation(task),
      reviewAssistance: deps.reviewAssistance,
      recordRequestUsage: (events) => this.recordAccounting(events),
      readRequestUsage: (requestId) => this.#usage.read(requestId),
      readModelCatalogue: (cwd) => this.readModelCatalogue(cwd),
    });
    this.#control = new TaskControlWorkflow({
      home: deps.home,
      store: deps.store,
      runtimePath: deps.runtimePath,
      sessionId: deps.sessionId,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      getTask: (taskId) => this.get(taskId),
      taskInScope: (task) => this.#source.taskInScope(task),
      runtimeFor: (taskId) => this.runtimeFor(taskId),
      reconcileTask: (task) => this.reconcileTask(task),
      reconcileJob: (task, runtime, job) => this.#worker.reconcileJob(task, runtime, job),
      context: () => this.context(),
      transition: (taskId, event) => this.transition(taskId, event),
      blockTask: (taskId, reason, cause) => this.blockTask(taskId, reason, cause),
      publishTaskInbox: (task) => this.#source.publishTaskInbox(task),
      setRuntimeError: (taskId, error) => this.setRuntimeError(taskId, error),
      saveEndpoint: (taskId, endpoint, claim) => this.#worker.saveEndpoint(taskId, endpoint, claim),
    });
    this.#requests = new RequestBriefWorkflow({
      home: deps.home,
      sessionId: deps.sessionId,
      parentWorkspaceId: deps.parentWorkspaceId,
      coordinatorPaneId: deps.coordinatorPaneId,
      run: deps.run,
      clock: deps.clock,
      store: deps.requestStore,
      listTasks: () => this.list(),
      pauseTask: async (taskId, reason) => {
        await this.pause(taskId, reason);
      },
    });
    this.#recoveryCentral = new CentralRecoveryWorkflow({
      home: deps.home,
      sessionId: deps.sessionId,
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      store: deps.store,
      runtimePath: deps.runtimePath,
      getTask: (taskId) => this.get(taskId),
      relaunchWorker: (task, extraInstructions) =>
        this.#worker.relaunchWorker(task, extraInstructions),
      revalidate: async (task) => {
        // startValidation never throws for an expected precondition failure (a stale/dirty
        // worktree, a missing worktree, a lost writer pane, ...); it blocks the task directly and
        // resolves normally. Re-read the task afterward so a self-block is reported as `started:
        // false` instead of central recovery believing re-entry succeeded.
        try {
          const refused = await this.#worker.startValidation(task);
          if (refused !== undefined) {
            return { started: false, reason: refused.summary, refusal: refused.refusal };
          }
        } catch (error) {
          return { started: false, reason: describeError(error) };
        }
        const current = await this.get(task.id);
        if (current.stage === "blocked") {
          return {
            started: false,
            reason: current.blockReason ?? "validation could not be restarted",
          };
        }
        return { started: true };
      },
      blockTask: (taskId, reason, cause) =>
        this.blockTask(taskId, reason, cause).then(() => undefined),
      removeEndpoint: (taskId, paneId) => this.removeEndpoint(taskId, paneId),
      relaunchReviewer: (task) => this.#worker.advanceReview(task),
    });
  }

  api(): TandemService {
    return {
      onboard: (repoPath, write, coordinatorMcpServers) =>
        this.onboard(repoPath, write, coordinatorMcpServers),
      inspect: (id) => this.inspect(id),
      deliveryPreflight: (id, input) => this.deliveryPreflight(id, input.base),
      models: (repoPath) => this.models(repoPath),
      configureModels: (input) => this.configureModels(input),
      create: (input) => this.create(input),
      ...(this.#deps.refreshSource === undefined
        ? {}
        : { refreshSource: () => this.refreshSource() }),
      list: () => this.list(),
      get: (id) => this.get(id),
      approve: (id) => this.approve(id),
      draftRequestBrief: (input) => this.draftRequestBrief(input),
      reviewRequestBrief: (requestId) => this.#requests.review(requestId),
      approveRequestBrief: (intent) => this.#requests.approve(intent),
      pendingBriefApprovalId: () => this.#requests.pendingApprovalId(),
      requestBrief: (requestId) => this.#requests.read(requestId),
      requestReceipt: (requestId) => this.requestReceipt(requestId),
      tick: () => this.tick(),
      acknowledge: (id, notificationId) => this.acknowledge(id, notificationId),
      steer: (input) => this.steer(input),
      answer: (input) => this.answer(input),
      messages: (taskId) => this.messages(taskId),
      pause: (id, reason) => this.pause(id, reason),
      resume: (id) => this.resume(id),
      restart: (id) => this.restart(id),
      cancel: (id, reason, input) => this.cancel(id, reason, input),
      describePr: (id, summary) => this.describePr(id, summary),
      publish: (id, input) => this.publish(id, input),
      publishNow: (id, input) => this.publishNow(id, input),
      publishDraft: (id, input) => this.publishDraft(id, input),
      merge: (id, input) => this.merge(id, input),
      cleanup: (id, input) => this.cleanup(id, input),
      present: (id, input) => this.present(id, input),
      presentations: () => this.presentations(),
      feedback: (id, signal) => this.feedback(id, signal),
      openPresentation: (id) => this.#presentationFeedback.open(id),
      requestBriefs: () => this.requestBriefs(),
      reviewPr: (input) => this.#prReviews.start(input),
      reviewShow: (id, input) => this.#prReviews.show(assertTaskId(id), input),
      reviewNotes: (id) => this.#prReviews.notes(assertTaskId(id)),
      reviewEdit: (id, edits) => this.#prReviews.edit(assertTaskId(id), edits),
      reviewPost: (id, input) =>
        this.#prReviews.post(assertTaskId(id), input.verdict, input.approved),
      reviewAgain: (id) => this.#prReviews.again(assertTaskId(id)),
      reviewClose: (id) => this.#prReviews.close(assertTaskId(id)),
      shutdown: () => this.shutdown(),
    };
  }

  async onboard(
    repoPath: string,
    write = false,
    coordinatorMcpServers?: readonly string[],
  ): Promise<OnboardRepoResult> {
    const source = await mapTaskSource(this.#deps.run, repoPath, this.#deps.sourceWorkspace);
    return onboardRepo({
      repoPath: source.repoPath,
      home: this.#deps.home,
      write,
      ...(coordinatorMcpServers === undefined ? {} : { coordinatorMcpServers }),
      ...(source.sourceRepoPath === undefined ? {} : { checkoutPath: source.sourceRepoPath }),
    });
  }
  /**
   * Catalogue tier evidence for one checkout, read fresh at an execution boundary. A catalogue it
   * cannot read is reported as unavailable rather than as an empty catalogue, because an empty one
   * would read as "nothing is enabled and nothing is included".
   */
  private async readModelCatalogue(cwd: string): Promise<ModelCatalogueSnapshot> {
    try {
      const settings = await readModelSettings({ repoPath: cwd, home: this.#deps.home });
      return {
        status: "read",
        models: await listOmpModels(this.#deps.run, { cwd }),
        enabledProviders: settings.enabledProviders,
        readAt: this.#deps.clock(),
      };
    } catch {
      return { status: "unavailable", reason: "catalogue-unreadable" };
    }
  }

  async models(repoPath: string): Promise<ModelOptionsResult> {
    const source = await mapTaskSource(this.#deps.run, repoPath, this.#deps.sourceWorkspace);
    const modelSettings = await readModelSettings({
      repoPath: source.repoPath,
      home: this.#deps.home,
    });
    const availableModels = await listOmpModels(this.#deps.run, { cwd: source.checkoutPath });
    return {
      modelSettings,
      availableModels,
      discoveredProviders: discoveredProviders(availableModels),
      balancedProfile: resolveBalancedProfile({
        catalogue: availableModels,
        enabledProviders: new Set(modelSettings.enabledProviders),
      }),
    };
  }

  async refreshSource(): Promise<SourceRefreshResult | undefined> {
    const refresh = this.#deps.refreshSource;
    if (refresh === undefined) return undefined;
    const existing = this.#sourceRefreshPromise;
    if (existing !== undefined) return existing;
    const currentTick = this.#tickPromise;
    const promise = (async (): Promise<SourceRefreshResult> => {
      if (currentTick !== undefined) await currentTick;
      try {
        const result = await withCoordinatorLaunchLock(this.#deps.home, this.#deps.sessionId, () =>
          this.#deps.store.serialized(() => refresh()),
        );
        this.#sourceRefreshError = undefined;
        this.#sourceReadyHead = result.head;
        this.#sourceReady = true;
        return result;
      } catch (error) {
        this.#sourceReady = false;
        this.#sourceRefreshError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    })();
    this.#sourceRefreshPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#sourceRefreshPromise === promise) this.#sourceRefreshPromise = undefined;
    }
  }
  private async ensureSourceReady(): Promise<void> {
    const refresh = this.#sourceRefreshPromise;
    if (refresh !== undefined) await refresh.catch(() => undefined);
    if (!this.#sourceReady) {
      throw new Error(
        `coordinator source is not ready${this.#sourceRefreshError === undefined ? "" : `: ${this.#sourceRefreshError}`}`,
      );
    }
  }

  async configureModels(
    input: Readonly<{
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
      readonly enabledProviders?: readonly string[] | undefined;
    }>,
  ): Promise<ModelSettings> {
    if (!isRecord(input)) throw new TypeError("configureModels input must be an object");
    const source = await mapTaskSource(this.#deps.run, input.repoPath, this.#deps.sourceWorkspace);
    const models = parseModelAssignments(input.models);
    const availableModels = await listOmpModels(this.#deps.run, { cwd: source.checkoutPath });
    validateModelAssignments(models, availableModels);

    return writeModelSettings({
      repoPath: source.repoPath,
      home: this.#deps.home,
      models,
      ...(input.enabledProviders === undefined ? {} : { enabledProviders: input.enabledProviders }),
    });
  }
  /**
   * Classified outside the store lock so a bounded classifier call never delays other work. A scout
   * under a request is classified from the brief's goal and scope, which record what the user wants
   * from the whole request; the scout objective is coordinator-written and carries the scout's own
   * read-only guardrails ("do not implement"), which would otherwise read as the user's intent.
   * Constraints and non-goals stay out for the same reason.
   */
  private async continuationFor(
    input: CreateTaskRequest | PrReviewTaskRequest,
    brief: RequestBriefRecord | undefined,
  ): Promise<ResearchContinuation | undefined> {
    if (input.kind !== "scout" || input.researchContinuation !== undefined) return undefined;
    const objective =
      brief === undefined
        ? typeof input.objective === "string"
          ? input.objective
          : ""
        : [brief.draft.content.goal, ...brief.draft.content.scope].join("\n");
    const classified = await this.#deps.classifyResearchContinuation({
      objective,
      taskKind: input.kind,
    });
    return classified.continuation;
  }

  async create(input: CreateTaskRequest | PrReviewTaskRequest): Promise<TaskRecord> {
    await this.ensureSourceReady();
    if (!isRecord(input)) throw new TypeError("create input must be an object");
    // Implementation work the coordinator did not attribute joins the repository's one open
    // approved request, so its time and tokens land on that request's receipt.
    const requestId =
      input.requestId ??
      (input.kind === "implementation"
        ? await this.#requests.openRequestForNewWork(input.repoPath, await this.#deps.store.list())
        : undefined);
    const brief =
      requestId === undefined ? undefined : await this.#requests.requireRequest(requestId);
    const classifiedContinuation = await this.continuationFor(input, brief);
    return this.#deps.store.exclusive(async (store) => {
      const source = await mapTaskSource(
        this.#deps.run,
        input.repoPath,
        this.#deps.sourceWorkspace,
      );
      const policy = await resolveRepoPolicy({
        repoPath: source.repoPath,
        home: this.#deps.home,
        ...(source.sourceRepoPath === undefined ? {} : { checkoutPath: source.sourceRepoPath }),
      });
      const researchTaskIds =
        input.researchTaskIds === undefined
          ? undefined
          : readTextList(input.researchTaskIds, "researchTaskIds");
      if (researchTaskIds !== undefined && input.kind !== "implementation") {
        throw new Error("research task references are only valid for implementation tasks");
      }
      if (input.researchContinuation !== undefined && input.kind !== "scout") {
        throw new Error("a research continuation disposition is only valid for scout tasks");
      }
      const checkpoint = await readCheckpoint(this.#deps.run, { repo: source.checkoutPath });
      const runtime = await readRuntimeState(this.#deps.runtimePath);
      const researchHandoffs = await resolveResearchHandoffs(
        researchTaskIds,
        source.repoPath,
        this.#deps.home,
        runtime,
        store,
      );
      const taskInput = taskInputFor(
        {
          ...input,
          ...(requestId === undefined ? {} : { requestId }),
          ...(researchHandoffs === undefined ? {} : { researchHandoffs }),
          ...(classifiedContinuation === undefined
            ? {}
            : { researchContinuation: classifiedContinuation }),
        },
        source.repoPath,
        policy,
      );
      const id = singleLine(this.#deps.idFactory(), "task id");
      if (
        this.#deps.refreshSource !== undefined &&
        (this.#sourceReadyHead === undefined || checkpoint.head !== this.#sourceReadyHead)
      ) {
        this.#sourceReady = false;
        throw new Error(
          `coordinator source changed after refresh (expected ${this.#sourceReadyHead ?? "a successful refresh"}, observed ${checkpoint.head}); refresh before creating new work`,
        );
      }
      const created = await store.create({ ...taskInput, id });
      const current = await readRuntimeState(this.#deps.runtimePath);
      const runtimeTask: RuntimeTaskState = {
        schemaVersion: 1,
        taskId: created.id,
        sourceCheckpoint: checkpoint,
        ...(source.sourceRepoPath === undefined ? {} : { sourceRepoPath: source.sourceRepoPath }),
        taskName: taskNameFor(created),
        endpoints: [],
        jobs: [],
        ...(["scout", "implementation", "pr-review"].includes(created.kind)
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
  }

  async list(): Promise<readonly TaskRecord[]> {
    return this.#source.scopedTasks();
  }

  async get(id: string): Promise<TaskRecord> {
    const taskId = assertTaskId(id);
    const task = await this.#deps.store.read(taskId);
    if (task === undefined || !(await this.#source.taskInScope(task))) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task;
  }

  async approve(id: string): Promise<TaskRecord> {
    const task = await this.get(id);
    const dispatch = await this.#requests.dispatchDecisionForTask(task);
    if (dispatch !== undefined && !dispatch.allowed) {
      throw new Error(`Task ${task.id} cannot be dispatched: ${dispatch.reason}`);
    }
    if (task.kind === "implementation") {
      const runtime = await this.runtimeFor(task.id);
      if (runtime === undefined) throw new Error(`Task ${task.id} has no durable runtime metadata`);
      const current = await readCheckpoint(this.#deps.run, {
        repo: taskSourcePath(task, runtime),
      });
      this.#worker.assertSourceUnchanged(runtime.sourceCheckpoint, current);
    }
    return this.transition(task.id, { type: "approve" });
  }

  async tick(): Promise<readonly TaskRecord[]> {
    const sourceRefresh = this.#sourceRefreshPromise;
    if (sourceRefresh !== undefined) await sourceRefresh.catch(() => undefined);
    const existing = this.#tickPromise;
    if (existing !== undefined) return existing;
    const current = this.advance().finally(() => {
      this.#tickPromise = undefined;
    });
    this.#tickPromise = current;
    return current;
  }

  async pause(id: string, reason = "paused by coordinator"): Promise<TaskRecord> {
    return this.#control.controlTask(assertTaskId(id), "pause", text(reason, "reason"));
  }

  async inspect(id: string): Promise<TaskInspection> {
    const task = await this.get(assertTaskId(id));
    if (!(await this.#source.taskInScope(task))) {
      throw new Error(`task ${task.id} is outside the repository scope`);
    }
    return inspectTask(this.#deps, task);
  }

  async deliveryPreflight(id: string, base: string): Promise<DeliveryPreflightResult> {
    return deliveryPreflight(this.#deps, await this.get(assertTaskId(id)), base);
  }

  async resume(id: string): Promise<TaskRecord> {
    return this.#control.resumeTask(assertTaskId(id));
  }
  async restart(id: string): Promise<TaskRecord> {
    const taskId = assertTaskId(id);
    const task = await this.get(taskId);
    const state = await this.readState();
    for (const presentation of state.presentations) {
      if (presentation.taskId !== task.id) continue;
      const record = await readPresentationRecord(presentation.recordPath);
      if (record.question !== undefined) {
        throw new Error(
          `Task ${taskId} has an unanswered presentation question ${JSON.stringify(record.question.id)}; answer it before restarting managed work`,
        );
      }
    }
    return this.#control.restartTask(taskId);
  }

  /** With discard, the cleanup that follows the cancel deletes the worktree and its changes. */
  async cancel(
    id: string,
    reason?: string,
    input: { readonly discard?: boolean } = {},
  ): Promise<TaskRecord> {
    const taskId = assertTaskId(id);
    const discard = input.discard === true;
    const alreadyCancelled = discard && (await this.get(taskId)).stage === "cancelled";
    const task = await this.#control.controlTask(
      taskId,
      "cancel",
      reason === undefined ? undefined : text(reason, "reason"),
      discard,
    );
    // An earlier cancel already ran its cleanup and kept the worktree, so discard it directly.
    if (alreadyCancelled) {
      await this.cleanup(taskId, { discard: true, destructiveApproval: true });
    }
    return task;
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
    const next = await this.#control.redirectToPrimary(taskId, instruction);
    if (next.stage === "implementing" && next.generation !== before.generation) {
      await this.reconcileTask(await this.get(next.id));
    } else if (next.stage === "completed" && next.kind === "scout") {
      const followUp = await this.transition(next.id, { type: "follow-up-research" });
      await this.reconcileTask(followUp);
    } else if (next.stage === "completed" && next.kind === "pr-review") {
      await this.#prReviews.ask(next.id);
    }
    return this.messages(taskId);
  }

  async answer(input: AnswerTaskInput): Promise<TaskCommunicationView> {
    if (!isRecord(input)) throw new TypeError("answer input must be an object");
    const taskId = assertTaskId(input.taskId);
    const questionId = singleLine(input.questionId, "questionId");
    const answer = singleLine(input.text, "text");
    const task = await this.get(taskId);
    if (task.communication?.question?.id === questionId) {
      // A recovery question's answer is a recovery decision, never a worker instruction: it must
      // never bump task.communication.revision, so neither path here goes through appendAnswer.
      if (questionId.startsWith(RESTART_QUESTION_ID_PREFIX)) {
        await this.#recoveryCentral.answerRestartQuestion(taskId, questionId, answer);
        return this.messages(taskId);
      }
      if (questionId.startsWith(VALIDATION_RETRY_QUESTION_ID_PREFIX)) {
        await this.#recoveryCentral.answerValidationRetryQuestion(taskId, questionId, answer);
        return this.messages(taskId);
      }
      if (questionId.startsWith(KEEP_FIXING_QUESTION_ID_PREFIX)) {
        await this.answerKeepFixing(taskId, questionId, answer);
        return this.messages(taskId);
      }
      const result = await this.#source.appendAnswer(taskId, questionId, answer);
      if (result.resumed) {
        const resumed = await this.#control.resumeTask(taskId);
        if (["validating", "reviewing", "awaiting-fixes"].includes(resumed.stage)) {
          await this.reconcileTask(resumed);
        }
      }
      return this.messages(taskId);
    }
    const state = await this.readState();
    for (const presentation of state.presentations) {
      if (presentation.taskId !== task.id) continue;
      const record = await readPresentationRecord(presentation.recordPath);
      if (record.status !== "blocked" || record.question?.id !== questionId) continue;
      await this.#presentationRuntime.answer(presentation.id, questionId, answer);
      const view = await this.messages(taskId);
      return {
        ...view,
        presentationAnswer: {
          presentationId: presentation.id,
          questionId,
          status: "queued",
        },
      };
    }
    const result = await this.#source.appendAnswer(taskId, questionId, answer);
    if (result.resumed) await this.#control.resumeTask(taskId);
    return this.messages(taskId);
  }

  /**
   * Answers "Keep fixing?". Only an exact "yes" or "no" is accepted. "yes" records a fix-round
   * grant on this same task and resumes its fix loop in the same worktree; "no" clears the question
   * and leaves the task blocked. Neither is a worker instruction, so the inbox revision is untouched.
   */
  private async answerKeepFixing(taskId: string, questionId: string, text: string): Promise<void> {
    const choice = text.trim().toLowerCase();
    if (choice !== "yes" && choice !== "no") {
      throw new Error(
        `"Keep fixing?" only accepts "yes" or "no"; received ${JSON.stringify(text.trim())}. The question is still open.`,
      );
    }
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current?.communication?.question?.id !== questionId) return;
      const { question: _question, ...communication } = current.communication;
      await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: this.#deps.clock(),
        communication,
        ...(choice === "yes"
          ? { fixRoundGrants: [...(entry.fixRoundGrants ?? []), keepFixingGrant(entry)] }
          : {}),
      }));
    });
    if (choice === "no") return;
    const resumed = await this.#control.resumeTask(taskId);
    if (resumed.stage === "awaiting-fixes") await this.reconcileTask(resumed);
  }

  async messages(taskId: string): Promise<TaskCommunicationView> {
    const id = assertTaskId(taskId);
    await this.get(id);
    try {
      await this.#source.repairTaskInbox(id);
    } catch {
      // Canonical communication remains readable even when projection repair is unavailable.
    }
    return this.#source.communicationView(await this.get(id));
  }

  async describePr(id: string, summary: PrSummary): Promise<string> {
    const task = await this.get(id);
    return describeTaskPr(task, summary);
  }

  async publish(
    id: string,
    input: {
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
      readonly approved: boolean;
    },
  ): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("publish input must be an object");
    const published = await this.publishedTask(id);
    if (published !== undefined) return published;
    if (input.approved) {
      const preflight = await this.deliveryPreflight(id, input.base);
      if (!preflight.ready) {
        throw new Error(`not published: ${preflight.refusals.join("; ")}`);
      }
    }
    const prepared = await this.#deps.store.serialized(async (store) => {
      const task = await store.read(id);
      if (task === undefined || !(await this.#source.taskInScope(task))) {
        throw new Error(`Task ${id} was not found`);
      }
      const metadata = await publishReviewedTask({
        task,
        summary: input.summary,
        title: singleLine(input.title, "title"),
        base: singleLine(input.base, "base"),
        approved: input.approved,
        run: this.#deps.run,
      });
      return { task, metadata };
    });
    const { task, metadata } = prepared;
    return this.recordPullRequest(id, task.revision, metadata);
  }

  /** A task that already has a finished pull request; publishing it again just returns it. */
  private async publishedTask(id: string): Promise<TaskRecord | undefined> {
    const task = await this.get(id);
    return task.pullRequest !== undefined && task.pullRequest.state !== "draft" ? task : undefined;
  }

  /**
   * The user's explicit "publish now": stops any running validator or reviewer, moves the task to
   * `ready` without finishing review, records the skip, and opens the pull request. It is only for
   * an explicit user request, never the coordinator's own call. Merging stays a separate approval.
   */
  async publishNow(
    id: string,
    input: {
      readonly repository: string;
      readonly title: string;
      readonly base: string;
      readonly summary: PrSummary;
      readonly approved: boolean;
    },
  ): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("publish-now input must be an object");
    if (!input.approved) throw new ApprovalRequiredError("publish now");
    const published = await this.publishedTask(id);
    if (published !== undefined) return published;
    if ((await this.get(id)).stage === "cancelled") {
      throw new Error(`Task ${id} was cancelled, so it can't be published`);
    }
    await this.#control.skipReview(assertTaskId(id));
    return this.publish(id, input);
  }

  /**
   * Create or update the task's draft pull request before final acceptance. It requires explicit
   * publishing approval, stays visibly unfinished, and neither merges, deploys, nor accepts.
   */
  async publishDraft(
    id: string,
    input: {
      readonly title: string;
      readonly base: string;
      readonly approved: boolean;
    },
  ): Promise<TaskRecord> {
    if (!isRecord(input)) throw new TypeError("draft publish input must be an object");
    const prepared = await this.#deps.store.serialized(async (store) => {
      const task = await store.read(id);
      if (task === undefined || !(await this.#source.taskInScope(task))) {
        throw new Error(`Task ${id} was not found`);
      }
      const publication = await publishTaskDraft({
        task,
        title: singleLine(input.title, "title"),
        base: singleLine(input.base, "base"),
        approved: input.approved,
        run: this.#deps.run,
      });
      return { task, publication };
    });
    const updated = await this.recordPullRequest(
      id,
      prepared.task.revision,
      prepared.publication.pullRequest,
    );
    this.#draftDigests.set(id, draftProgressDigest(prepared.task));
    return updated;
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
    const cwd = taskSourcePath(task, runtime);
    for (const endpoint of runtime.endpoints) {
      try {
        const job = workerJobForEndpoint(runtime.jobs, endpoint);
        await prepareWorkerTerminal(this.#deps.run, {
          endpoint,
          cwd,
          ...(job === undefined ? {} : { job }),
        });
      } catch (error) {
        // A discard closes the pane below even when its worker won't exit on request.
        if (!isMissingEndpoint(error) && !discard) throw error;
      }
    }
    // A finished or failed mockup's pane holds nothing its artifact file doesn't, so it closes even
    // with its process still running; a running mockup is left alone.
    const presentationPanes = (await this.readState()).presentations.flatMap((presentation) =>
      presentation.taskId === task.id &&
      presentation.endpoint !== undefined &&
      !activeRuntimeJob(presentation.job)
        ? [{ endpoint: presentation.endpoint, cwd: presentation.job.cwd, force: true }]
        : [],
    );
    for (const pane of [
      ...runtime.endpoints.map((endpoint) => ({ endpoint, cwd, force: discard })),
      ...presentationPanes,
    ]) {
      try {
        await closeEndpoint(this.#deps.run, pane);
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
      }
    }
    if (task.prReview !== undefined) {
      if (runtime.worktree !== undefined) {
        await removeReviewWorktree(
          this.#deps.run,
          { checkout: runtime.worktree.root, path: runtime.worktree.path },
          task.prReview.ref,
        );
      }
      await this.removeRuntimeResources(task.id);
      return task;
    }
    const cleanupFailure = await runCleanupCommands(
      {
        run: this.#deps.run,
        cleanupCommands: (repoPath) => readCleanupCommands({ repoPath, home: this.#deps.home }),
      },
      task.repoPath,
      runtime.worktree?.path,
    );
    if (cleanupFailure !== undefined) await this.setRuntimeError(task.id, cleanupFailure);
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
      const taskRuntimeState = taskRuntime(state, task.id);
      if (taskRuntimeState === undefined) {
        throw new Error(`runtime task ${task.id} is missing`);
      }
      const operationId = singleLine(this.#deps.idFactory(), "presentation operation id");
      const operation = durableOperation(
        operationId,
        task.id,
        "presentation",
        "presentation",
        prepared.record.generation,
        task.reviewHead ?? taskRuntimeState.sourceCheckpoint.head,
        createHash("sha256").update(serializedIdentity(task.policy, "task policy")).digest("hex"),
        task.communication?.revision ?? 0,
        durableJob.id,
        this.#worker.claimOwner,
        this.#deps.clock(),
      );
      const linkedJob = { ...durableJob, operationId: operation.id };
      const workerSpec = JSON.parse(await readFile(prepared.record.jobPath, "utf8")) as Record<
        string,
        unknown
      >;
      await writeJsonAtomically(prepared.record.jobPath, {
        ...workerSpec,
        execution: {
          schemaVersion: 1,
          home: this.#deps.home,
          operationId: operation.id,
          fencingRevision: operation.fencingRevision,
          claimOwner: operation.claimOwner,
        },
      });
      const next: RuntimePresentation = {
        schemaVersion: 1,
        id: prepared.record.id,
        taskId: task.id,
        recordPath,
        operation,
        job: linkedJob,
      };
      await writeRuntimeState(this.#deps.runtimePath, {
        ...state,
        presentations: [...state.presentations, next],
      });
    });
    await this.#presentationRuntime.startPresentation(prepared.record.id);
    return this.readPresentation(prepared.record.id);
  }

  async presentations(): Promise<readonly PresentationRecord[]> {
    const state = await this.readState();
    const taskIds = new Set((await this.#source.scopedTasks()).map((task) => task.id));
    const records: PresentationRecord[] = [];
    for (const entry of state.presentations) {
      if (!taskIds.has(entry.taskId)) continue;
      records.push(await readPresentationRecord(entry.recordPath));
    }
    return records;
  }

  async feedback(presentationId: string, signal?: AbortSignal): Promise<PresentationRecord> {
    return this.#presentationFeedback.feedback(presentationId, signal);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    const tick = this.#tickPromise;
    const presentation = this.#presentationFeedback.shutdown();
    const inFlight = [...(tick === undefined ? [] : [tick]), presentation];
    const shutdown = Promise.allSettled(inFlight).then(() => undefined);
    this.#shutdownPromise = shutdown;
    await shutdown;
  }

  private async advance(): Promise<readonly TaskRecord[]> {
    const tasks = await this.#source.scopedTasks();
    for (const task of tasks) {
      let capturedRuntime: RuntimeTaskState | undefined;
      let captureSucceeded = false;
      try {
        capturedRuntime = await this.runtimeFor(task.id);
        captureSucceeded = true;
      } catch {
        // An unavailable pre-reconcile snapshot is an ownership uncertainty.
      }
      try {
        await this.reconcileTask(task);
      } catch (error) {
        if (captureSucceeded) {
          const reason = `scheduler failure: ${describeError(error)}`;
          await this.blockTaskIfReconcileClaim(task, capturedRuntime, reason, {
            cause: {
              group: "lost-resource",
              kind: "transition-failed",
              summary: "Something went wrong inside Tandem, so this task couldn't move forward.",
              detail: reason,
            },
          });
        }
      }
    }
    const state = await this.readState();
    const scopedTaskIds = new Set(tasks.map((task) => task.id));
    for (const presentation of state.presentations) {
      if (!scopedTaskIds.has(presentation.taskId)) continue;
      try {
        await this.#presentationRuntime.reconcilePresentation(presentation);
      } catch (error) {
        await this.#presentationRuntime.failPresentation(
          presentation.id,
          describeError(error),
          {
            jobId: presentation.job.id,
            operationId: presentation.operation?.id,
            fencingRevision: presentation.operation?.fencingRevision,
            claimOwner: presentation.operation?.claimOwner,
          },
          true,
        );
      }
    }
    const settled = await this.#source.scopedTasks();
    await this.recordRequestAccounting(settled);
    let draftRecorded = false;
    for (const task of settled) {
      if (await this.refreshDraftPullRequest(task)) draftRecorded = true;
    }
    return draftRecorded ? this.#source.scopedTasks() : settled;
  }

  private async blockTaskIfReconcileClaim(
    capturedTask: TaskRecord,
    capturedRuntime: RuntimeTaskState | undefined,
    reason: string,
    options: Readonly<{
      readonly runtimeError?: boolean;
      readonly reservation?: DurableReservation;
      readonly cause?: BlockCause;
    }> = {},
  ): Promise<void> {
    const claim = operationClaim(capturedRuntime?.operation);
    await withStateLock(this.#deps.home, async () => {
      await this.#deps.store.exclusive(async (store) => {
        const currentTask = await store.read(capturedTask.id);
        if (
          currentTask === undefined ||
          currentTask.revision !== capturedTask.revision ||
          currentTask.generation !== capturedTask.generation
        ) {
          return;
        }
        const state = await readRuntimeState(this.#deps.runtimePath);
        const currentRuntime = taskRuntime(state, capturedTask.id);
        if (
          !sameOperationClaim(currentRuntime?.operation, claim) ||
          (options.reservation !== undefined &&
            !sameReservationIdentity(currentRuntime?.reservation, options.reservation))
        ) {
          return;
        }
        if (options.runtimeError === true && currentRuntime !== undefined) {
          await writeRuntimeState(
            this.#deps.runtimePath,
            replaceRuntimeTask(state, capturedTask.id, (current) => ({
              ...current,
              lastError: reason,
            })),
          );
        }
        if (
          currentTask.stage === "cancelled" ||
          currentTask.stage === "completed" ||
          currentTask.stage === "merged" ||
          currentTask.stage === "paused" ||
          currentTask.stage === "blocked"
        ) {
          return;
        }
        await store.update(currentTask.id, currentTask.revision, (task) =>
          transitionTask(
            task,
            {
              type: "block",
              // `reason` (kept in `lastError` above) stays the raw diagnostic text; the block
              // itself prefers the cause's user-facing summary when one was recorded.
              reason: text(options.cause?.summary ?? reason, "block reason"),
              ...(options.cause === undefined ? {} : { cause: options.cause }),
            },
            this.context(),
          ),
        );
      });
    });
  }
  private async quarantineLegacyReservation(
    capturedTask: TaskRecord,
    reservation: DurableReservation,
    reason: string,
    cause?: BlockCause,
  ): Promise<void> {
    await withStateLock(this.#deps.home, async () => {
      await this.#deps.store.exclusive(async (store) => {
        const currentTask = await store.read(capturedTask.id);
        if (
          currentTask === undefined ||
          currentTask.revision !== capturedTask.revision ||
          currentTask.generation !== capturedTask.generation
        ) {
          return;
        }
        const state = await readRuntimeState(this.#deps.runtimePath);
        const currentRuntime = taskRuntime(state, capturedTask.id);
        if (
          currentRuntime?.operation !== undefined ||
          !sameReservationIdentity(currentRuntime?.reservation, reservation)
        ) {
          return;
        }
        const nextRuntime = replaceRuntimeTask(state, capturedTask.id, (current) => ({
          ...current,
          lastError: reason,
          legacyQuarantine: {
            schemaVersion: 1,
            reservationId: reservation.id,
            reason,
            observedAt: this.#deps.clock(),
          },
        }));
        await writeRuntimeState(this.#deps.runtimePath, nextRuntime);
        if (
          currentTask.stage === "cancelled" ||
          currentTask.stage === "completed" ||
          currentTask.stage === "merged" ||
          currentTask.stage === "paused" ||
          currentTask.stage === "blocked"
        ) {
          return;
        }
        await store.update(currentTask.id, currentTask.revision, (task) =>
          transitionTask(
            task,
            {
              type: "block",
              // `reason` (kept as `lastError` above) stays the raw diagnostic text; the block
              // itself prefers the cause's user-facing summary when one was recorded.
              reason: text(cause?.summary ?? reason, "block reason"),
              ...(cause === undefined ? {} : { cause }),
            },
            this.context(),
          ),
        );
      });
    });
  }

  private async recordPullRequest(
    taskId: string,
    expectedRevision: number,
    metadata: PullRequestMetadata,
  ): Promise<TaskRecord> {
    return this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || !(await this.#source.taskInScope(current))) {
        throw new Error(`Task ${taskId} was not found`);
      }
      if (current.revision !== expectedRevision) {
        throw new TaskRevisionConflictError(taskId);
      }
      return store.update(current.id, current.revision, (candidate) => ({
        ...candidate,
        revision: candidate.revision + 1,
        updatedAt: this.#deps.clock(),
        pullRequest: metadata,
      }));
    });
  }

  /**
   * Opens the request and records its intake, so the receipt's wall clock starts at the moment
   * the agreement became durable rather than at the first worker launch.
   */
  private async draftRequestBrief(input: DraftRequestBriefInput): Promise<RequestBriefView> {
    const view = await this.#requests.draft(input);
    await this.recordAccounting([requestIntakeEvent(view.record)]);
    return view;
  }

  /**
   * Brings the ledger level with durable state: the intake of every governing request, one span
   * per settled operation, and the terminal fact of every delivered or cancelled task. Each event
   * identity is derived from the records themselves, so repeating this pass after a restart, a
   * reconciliation, or a compaction records nothing new.
   */
  private async recordRequestAccounting(tasks: readonly TaskRecord[]): Promise<void> {
    const governed = tasks.filter((task) => task.requestId !== undefined);
    if (governed.length === 0) return;
    const state = await this.readState();
    try {
      await this.recordAccounting(await this.requestAccountingEvents(governed, state));
    } catch (error) {
      await this.diagnoseAccountingFailure(error);
    }
  }

  private async requestAccountingEvents(
    tasks: readonly TaskRecord[],
    state: RuntimeState,
  ): Promise<readonly RequestUsageEvent[]> {
    const events: RequestUsageEvent[] = [];
    const openedRequests = new Set<string>();
    for (const task of tasks) {
      const requestId = task.requestId;
      if (requestId === undefined) continue;
      if (!openedRequests.has(requestId)) {
        openedRequests.add(requestId);
        const brief = await this.#deps.requestStore.read(requestId);
        if (brief !== undefined) events.push(requestIntakeEvent(brief));
      }
      // Research usually runs before its brief exists, so it is credited to the request through
      // the implementation that cites it rather than by joining the request's membership.
      const researchTaskIds = (task.researchHandoffs ?? []).map((handoff) => handoff.scoutTaskId);
      for (const taskId of [task.id, ...researchTaskIds]) {
        const runtime = state.tasks.find((entry) => entry.taskId === taskId);
        if (runtime === undefined) continue;
        const presentations = state.presentations.filter(
          (presentation) => presentation.taskId === taskId,
        );
        events.push(
          ...settledWorkEvents({
            requestId,
            runtime,
            presentations,
            tallies: await jobTokenTallies([
              ...runtime.jobs,
              ...presentations.map((presentation) => presentation.job),
            ]),
          }),
        );
      }
      const terminal = requestTerminalEvent(requestId, task);
      if (terminal !== undefined) events.push(terminal);
    }
    return events;
  }

  /**
   * Appends accounting facts. Accounting observes work; it never authorizes, pauses, retries, or
   * blocks it, so a ledger failure is reported and the caller carries on unchanged.
   */
  private async recordAccounting(events: readonly RequestUsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    let added: readonly RequestUsageEvent[];
    try {
      added = (await this.#usage.record(events)).added;
    } catch (error) {
      await this.diagnoseAccountingFailure(error, events.length);
      return;
    }
    for (const event of added) {
      if (event.kind === "terminal" && event.outcome === "delivered") {
        await this.notifyReceiptReady(event);
      }
    }
  }

  /**
   * The request's receipt, with its goal and the coordinator's shared usage over the request's
   * window. An open request is measured up to now, so it can be checked partway through.
   */
  private async requestReceipt(requestId?: string): Promise<RequestUsageReceipt> {
    const id = requestId ?? (await this.requestInProgress());
    const receipt = await this.#usage.receipt(id);
    const brief = await this.#deps.requestStore.read(id);
    const from = receipt.timing.intakeAt;
    if (brief === undefined || from === "unavailable") return receipt;
    const open = receipt.timing.terminalAt === "unavailable";
    const to = open ? this.#deps.clock() : receipt.timing.terminalAt;
    const repoPath = await realpath(brief.repoPath).catch(() => brief.repoPath);
    return {
      ...receipt,
      goal: brief.draft.content.goal,
      ...(open ? { asOf: to } : {}),
      coordinator: coordinatorShare(
        await readCoordinatorUsage(this.#deps.home),
        repoPath,
        from,
        to,
      ),
    };
  }

  /** Briefs for the coordinator's repository (all of them without one), newest first. */
  private async requestBriefs(): Promise<readonly RequestBriefRecord[]> {
    const repoPath = this.#deps.sourceWorkspace?.repoPath;
    const canonical = (path: string): Promise<string> => realpath(path).catch(() => path);
    const here = repoPath === undefined ? undefined : await canonical(repoPath);
    const records = [];
    for (const record of await this.#deps.requestStore.list()) {
      if (here === undefined || (await canonical(record.repoPath)) === here) records.push(record);
    }
    return records.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * The request a person means by "this request": the one open approved request in the
   * coordinator's repository, or else the one whose brief changed most recently.
   */
  private async requestInProgress(): Promise<string> {
    const repoPath = this.#deps.sourceWorkspace?.repoPath;
    if (repoPath !== undefined) {
      const here = await realpath(repoPath).catch(() => repoPath);
      const open = await this.#requests.openRequestForNewWork(here, await this.#deps.store.list());
      if (open !== undefined) return open;
    }
    const latest = (await this.requestBriefs())[0];
    if (latest === undefined) throw new Error("There is no request to show a receipt for yet");
    return latest.id;
  }

  /**
   * Wakes the coordinator once, when a request's delivery is first recorded, to show the person
   * where the request's time and tokens went. The ledger records each delivery once, so a replay
   * never repeats this.
   */
  private async notifyReceiptReady(event: RequestUsageEvent): Promise<void> {
    const taskId = event.identity.taskId;
    if (taskId === undefined) return;
    await this.updateTask(taskId, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      notifications: [
        ...current.notifications,
        {
          id: singleLine(this.#deps.idFactory(), "receipt notification id"),
          message:
            "The request is delivered. Show where its time and tokens went: call request-receipt for this task's request and show its table exactly as returned.",
          acknowledged: false,
          kind: "coordinator",
        },
      ],
    }));
  }

  private async diagnoseAccountingFailure(error: unknown, events?: number): Promise<void> {
    try {
      await appendDiagnosticEvent(
        this.#deps.home,
        {
          event: "request-accounting-failed",
          details: {
            errorClass: errorClassName(error),
            ...(events === undefined ? {} : { events }),
          },
        },
        this.#deps.clock,
      );
    } catch {
      // Observability must not make request accounting fail either.
    }
  }

  /**
   * Record a draft-refresh failure so a stale draft is observable, without letting observability
   * change workflow behavior. Details stay bounded: task id, pull request number, which step
   * failed, and the error class name. No message text, stdout, stderr, or command payload.
   */
  private async recordDraftRefreshFailure(input: {
    readonly taskId: string;
    readonly step: "digest" | "remote-refresh" | "record";
    readonly pullRequestNumber?: number;
    readonly error: unknown;
  }): Promise<void> {
    await appendDiagnosticEvent(
      this.#deps.home,
      {
        event: "draft-refresh-failed",
        taskId: input.taskId,
        details: {
          step: input.step,
          errorClass: errorClassName(input.error),
          ...(input.pullRequestNumber === undefined
            ? {}
            : { pullRequest: input.pullRequestNumber }),
        },
      },
      this.#deps.clock,
    );
  }

  /**
   * Keep an already approved draft showing current durable task state. It never creates a pull
   * request, never asks for a new approval, and never blocks durable work when the remote is
   * unavailable; the next durable change retries. Answers whether the task record changed.
   */
  private async refreshDraftPullRequest(task: TaskRecord): Promise<boolean> {
    const recorded = task.pullRequest;
    if (recorded === undefined || recorded.state !== "draft") {
      this.#draftDigests.delete(task.id);
      return false;
    }
    let digest: string;
    try {
      digest = draftProgressDigest(task);
    } catch (error) {
      await this.recordDraftRefreshFailure({
        taskId: task.id,
        step: "digest",
        pullRequestNumber: recorded.number,
        error,
      });
      return false;
    }
    if (this.#draftDigests.get(task.id) === digest) return false;
    // Consume this durable state before attempting it, so one failure is one bounded attempt and
    // one diagnostic rather than a per-tick retry loop against an unavailable remote.
    this.#draftDigests.set(task.id, digest);

    let publication: DraftPublication | undefined;
    try {
      publication = await refreshTaskDraft({ task, run: this.#deps.run });
    } catch (error) {
      await this.recordDraftRefreshFailure({
        taskId: task.id,
        step: "remote-refresh",
        pullRequestNumber: recorded.number,
        error,
      });
      return false;
    }
    if (publication === undefined || samePullRequest(publication.pullRequest, recorded)) {
      return false;
    }
    try {
      await this.recordPullRequest(task.id, task.revision, publication.pullRequest);
      return true;
    } catch (error) {
      await this.recordDraftRefreshFailure({
        taskId: task.id,
        step: "record",
        pullRequestNumber: publication.pullRequest.number,
        error,
      });
      return false;
    }
  }

  private async reconcileTask(task: TaskRecord): Promise<void> {
    try {
      await this.#source.repairTaskInbox(task.id);
    } catch {
      // Canonical task state remains authoritative when projection repair is unavailable.
    }
    const loadedRuntime = await this.runtimeFor(task.id);
    if (loadedRuntime === undefined) {
      await reportBlock((id, reason, cause) => this.blockTask(id, reason, cause), task.id, {
        group: "safety-stop",
        kind: "runtime-metadata-missing",
        summary: "Tandem lost its saved record for this task, so it couldn't start a worker.",
        detail: "durable runtime metadata is missing; no worker was launched",
      });
      return;
    }
    let runtime = loadedRuntime;
    if (runtime.stopRequest !== undefined) {
      // Settling clears the stop request, so read the cancel's discard approval first. A crash in
      // between loses it and keeps the worktree, which is the safe side.
      const discard = runtime.stopRequest.discard === true;
      await this.#control.reconcileStopRequest(task, runtime);
      await this.cleanupSettledTask(task.id, { discard });
      return;
    }
    if (isTerminalTask(task)) {
      await this.cleanupTerminalTask(task);
      return;
    }
    if (task.stage === "paused") return;
    if (task.stage === "blocked") {
      // A blocked task whose cause is recoverable (a worker/pane vanishing, not a person's decision)
      // reaches central recovery here without anyone asking; anything not eligible is left exactly
      // as blocked as it already was.
      await this.#recoveryCentral.recoverBlockedTask(task);
      return;
    }
    if (
      runtime.operation !== undefined &&
      runtime.operation.claimOwner !== this.#worker.claimOwner
    ) {
      const claimed = await this.#worker.claimOperation(task.id);
      if (claimed !== undefined) runtime = claimed;
    }
    if (runtime.endpointLaunch !== undefined && currentWriter(runtime) === undefined) {
      const recovered = await this.#control.reconcileEndpointLaunch(task, runtime);
      if (recovered === undefined) return;
      runtime = recovered;
    }
    const active = runtime.jobs.find(activeRuntimeJob);
    if (active !== undefined) {
      await this.#worker.reconcileJob(task, runtime, active);
      await this.cleanupSettledTask(task.id);
      return;
    }
    if (unreleasedReservation(runtime.reservation)) {
      const reconciledRuntime = runtime;
      const reservation = runtime.reservation;
      if (runtime.operation === undefined) {
        const reason =
          "legacy reservation has no durable operation; quarantined without clearing reservation or checkpoint";
        await this.quarantineLegacyReservation(task, reservation, reason, {
          group: "safety-stop",
          kind: "quarantined-unknown-outcome",
          summary:
            "Tandem's records for this task are incomplete, so it paused the task without touching your work.",
          detail: reason,
        });
        return;
      }
      if (reservation.operationId !== runtime.operation.id) {
        const reason =
          "reservation and operation identities do not match; quarantined without launch";
        await this.blockTaskIfReconcileClaim(task, runtime, reason, {
          runtimeError: true,
          reservation,
          cause: {
            group: "safety-stop",
            kind: "identity-mismatch",
            summary:
              "Tandem's records for this task don't match each other, so it didn't start anything.",
            detail: reason,
          },
        });
        return;
      }
      if (reconciledRuntime.operation !== undefined) {
        await this.#worker.reconcileOperation(task, reconciledRuntime);
        return;
      }
      return;
    }
    switch (task.stage) {
      case "queued": {
        await this.#worker.startQueuedTask(task);
        return;
      }
      case "awaiting-fixes":
        // beginFixes admits the fix round and transitions the task to `implementing` before it ever
        // touches a pane; if the carried-forward pane turns out to be gone, it leaves the task there
        // unblocked rather than blocking, so the `implementing` branch below's central recovery
        // picks it up on the next tick (see src/recovery/central.ts).
        await this.#worker.beginFixes(task);
        return;
      case "validating": {
        // A validation job that died for an infrastructure reason settles without blocking (see
        // WorkerWorkflow.reconcileJob's validation branches), leaving the task at `validating` with
        // no active job/reservation and a terminal failed job behind it. Central recovery owns the
        // stop/save/re-entry decision for that shape; it reports `skipped` for a fresh entry (no
        // dead job) so the normal startValidation path runs unchanged.
        const recovered = await this.#recoveryCentral.recoverStuckWorker(task);
        if (recovered.action !== "skipped") return;
        await this.#worker.startValidation(task);
        return;
      }
      case "reviewing": {
        // A resumed reviewing task can carry a quarantined (proven-unowned) reviewer/verifier job
        // left over from before it was blocked. Central recovery owns the stop/save/re-entry
        // decision for that case, exactly as it does for implementing/scouting; "skipped" means
        // nothing needs recovery, so review advances normally.
        const recovered = await this.#recoveryCentral.recoverStuckWorker(task);
        if (recovered.action !== "skipped") return;
        await this.#worker.advanceReview(task);
        return;
      }
      case "scouting":
      case "implementing": {
        if (runtime.endpointLaunch !== undefined) return;
        if (runtime.worktree === undefined) {
          await reportBlock((id, reason, cause) => this.blockTask(id, reason, cause), task.id, {
            group: "lost-resource",
            kind: "resource-lost",
            summary: "The task's working copy is missing.",
            detail: `task is ${task.stage} but its durable worktree is missing`,
          });
          return;
        }
        const writer = currentWriter(runtime);
        if (writer === undefined) {
          // No owned pane is recorded and no job or reservation is active: the prior worker is
          // either already proven dead or needs the stop ladder run against a stale record. Central
          // recovery owns the stop/save/re-entry decision here; it blocks or asks itself when it
          // cannot proceed automatically.
          await this.#recoveryCentral.recoverStuckWorker(task);
          return;
        }
        const admission = await this.#worker.reserveTask(task.id, workerRoleForTask(task));
        if ("refusal" in admission) return;
        const admittedWriter = currentWriter(admission.runtime);
        if (admission.runtime.worktree === undefined || admittedWriter === undefined) {
          await this.#worker.releaseUnlaunchedTaskReservation(task.id, admission.reservation.id);
          await reportBlock((id, reason, cause) => this.blockTask(id, reason, cause), task.id, {
            group: "lost-resource",
            kind: "resource-lost",
            summary: "The worker's terminal and files are gone.",
            detail: `task is ${task.stage} but its worker resources are missing`,
          });
          return;
        }
        await this.#worker.launchAgent(
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

  private async recordPoolResult(taskId: string, result: PoolMaintenanceResult): Promise<void> {
    const admissionKey = poolAdmissionKey(result);
    const admissionNotice = admissionKey === undefined ? undefined : poolAdmissionNotice(result);
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#source.taskInScope(task))) return;
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
    const sourceRepoPath = taskRuntime(state, task.id)?.sourceRepoPath ?? task.repoPath;
    const managedPaths = tasks.flatMap((entry) =>
      entry.worktree === undefined ? [] : [entry.worktree.path],
    );
    const protectedPaths = state.tasks.flatMap((entry) =>
      entry.worktree === undefined ? [] : [entry.worktree.path],
    );
    let result: PoolMaintenanceResult;
    try {
      result = await maintainPool(this.#deps.run, {
        repo: sourceRepoPath,
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

  private async cleanupTerminalTask(
    task: TaskRecord,
    options: TerminalTaskCleanupOptions = {},
  ): Promise<void> {
    await releaseTerminalTaskResources(
      {
        home: this.#deps.home,
        store: this.#deps.store,
        runtimePath: this.#deps.runtimePath,
        run: this.#deps.run,
        clock: this.#deps.clock,
        cleanupCommands: (repoPath) => readCleanupCommands({ repoPath, home: this.#deps.home }),
      },
      task,
      options,
    );
  }

  /**
   * Releases a task's child resources in the same pass that settled it, so a completed scout does
   * not hold its pane and worktree until a later coordinator turn.
   */
  private async cleanupSettledTask(
    taskId: string,
    options: TerminalTaskCleanupOptions = {},
  ): Promise<void> {
    const current = await this.#deps.store.read(taskId);
    if (current === undefined || !isTerminalTask(current)) return;
    await this.cleanupTerminalTask(current, options);
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

  private async setRuntimeError(taskId: string, error: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (current) =>
        current.lastError === error ? current : { ...current, lastError: error },
      ),
    );
  }

  private async transition(taskId: string, event: TaskEvent): Promise<TaskRecord> {
    const task = await this.get(taskId);
    const context = this.context();
    const next = await transitionStoredTask(
      this.#deps.store,
      taskId,
      task.revision,
      event,
      context,
    );
    await this.recordTerminalDelivery(next);
    return next;
  }

  /**
   * Pins the request's delivery, cancellation, or failure moment at the transition that caused it,
   * so a later cleanup or reconciliation pass that touches the task cannot move the recorded time.
   */
  private async recordTerminalDelivery(task: TaskRecord): Promise<void> {
    const requestId = task.requestId;
    if (requestId === undefined) return;
    const terminal = requestTerminalEvent(requestId, task);
    if (terminal !== undefined) await this.recordAccounting([terminal]);
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

  private async blockTask(taskId: string, reason: string, cause?: BlockCause): Promise<TaskRecord> {
    const task = await this.get(taskId);
    if (["cancelled", "completed", "merged", "paused", "blocked"].includes(task.stage)) return task;
    return this.transition(taskId, {
      type: "block",
      reason: text(reason, "block reason"),
      ...(cause === undefined ? {} : { cause }),
    });
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

  private async runtimeFor(taskId: string): Promise<RuntimeTaskState | undefined> {
    const state = await this.readState();
    return taskRuntime(state, taskId);
  }

  private async readState(): Promise<RuntimeState> {
    return this.#deps.store.exclusive(() => readRuntimeState(this.#deps.runtimePath));
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
  const sourceWorkspace =
    options.sourceWorkspace === undefined
      ? undefined
      : (() => {
          if (!isRecord(options.sourceWorkspace)) {
            throw new TypeError("sourceWorkspace must be an object");
          }
          const repoPath = absoluteDirectory(
            options.sourceWorkspace.repoPath,
            "sourceWorkspace.repoPath",
          );
          const path = absoluteDirectory(options.sourceWorkspace.path, "sourceWorkspace.path");
          if (repoPath === path) {
            throw new TypeError("sourceWorkspace must identify a distinct clean checkout");
          }
          return { repoPath, path };
        })();
  const refreshSource = options.refreshSource === undefined ? undefined : options.refreshSource;
  if (refreshSource !== undefined && typeof refreshSource !== "function") {
    throw new TypeError("refreshSource must be a function");
  }
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
  const classifyResearchContinuation =
    options.classifyResearchContinuation ??
    researchContinuationClassifier({ timeoutMs: DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS });
  if (typeof classifyResearchContinuation !== "function") {
    throw new TypeError("classifyResearchContinuation must be a function");
  }
  return {
    home,
    sessionId,
    parentWorkspaceId:
      options.parentWorkspaceId === undefined
        ? undefined
        : singleLine(options.parentWorkspaceId, "parentWorkspaceId"),
    coordinatorPaneId:
      options.coordinatorPaneId === undefined
        ? undefined
        : singleLine(options.coordinatorPaneId, "coordinatorPaneId"),
    poolRoot,
    sourceWorkspace,
    refreshSource,
    workerTimeoutMs,
    run,
    clock,
    idFactory,
    classifyResearchContinuation,
    store: createTaskStore({ directory: join(home, "tasks"), clock, idFactory }),
    requestStore: createRequestBriefStore({ home, clock, idFactory }),
    usageLedger: createRequestUsageLedger({ home, clock }),
    runtimePath: runtimeFile(home),
    workerPath: fileURLToPath(new URL("../worker.ts", import.meta.url)),
    validationWorkerPath: fileURLToPath(new URL("../validation-worker.ts", import.meta.url)),
    reviewAssistance:
      options.reviewAssistance ??
      reviewAssistanceRuntime({
        ...reviewAssistanceConfig(process.env),
        recordDiagnostic: async (event, details) => {
          try {
            await appendDiagnosticEvent(home, { event, details });
          } catch {
            // Assistance diagnostics are best effort and never change review behavior.
          }
        },
      }),
    projectRoots: options.projectRoots ?? defaultProjectRoots(process.env),
  };
}

/** The token tallies the given jobs' workers recorded, keyed by job id. */
async function jobTokenTallies(
  jobs: readonly DurableJob[],
): Promise<ReadonlyMap<string, JobTokenTally>> {
  const tallies = new Map<string, JobTokenTally>();
  for (const job of jobs) {
    const tally = await readWorkerTokenTally(job.jobPath);
    if (tally === undefined) continue;
    tallies.set(job.id, {
      inputTokens: tally.inputTokens + tally.cacheReadTokens + tally.cacheWriteTokens,
      outputTokens: tally.outputTokens,
      costUsd: tally.costUsd,
    });
  }
  return tallies;
}

export function createTandemService(options: TandemServiceOptions): TandemService {
  return new TandemController(serviceDependencies(options)).api();
}
