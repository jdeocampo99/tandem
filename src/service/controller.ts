import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../adapters/commands.ts";
import { type GitCheckpoint, readCheckpoint } from "../adapters/git.ts";
import { closeEndpoint, inspectEndpoint, showNotification } from "../adapters/herdr.ts";
import type { OmpModelRecord } from "../adapters/omp.ts";
import { listOmpMcpServers, listOmpModels } from "../adapters/omp.ts";
import { ApprovalRequiredError } from "../adapters/primitives.ts";
import { releaseWorktree } from "../adapters/treehouse.ts";
import { readBoard } from "../board/read.ts";
import { type BoardRow, type BoardView, needsYouNotice } from "../board/view.ts";
import {
  type HomeSettings,
  readHomeSettings,
  type SelfImprovementMode,
  saveProjectRoots,
  saveSelfImprovement,
} from "../config/home-settings.ts";
import {
  type JevSetting,
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
import { parsePolicyOverride } from "../config/policy.ts";
import {
  type MergingChoice,
  type MergingSettingsFile,
  type OnboardRepoResult,
  onboardRepo,
  readCleanupCommands,
  resolveRepoPolicy,
  saveMergingChoice,
} from "../config/repositories.ts";
import { findSkills } from "../config/skills.ts";
import type {
  AnswerTaskInput,
  BlockCause,
  Clock,
  CommandRunner,
  CreatableTaskKind,
  IdFactory,
  IsoTimestamp,
  PullRequestMetadata,
  RepoPolicy,
  RequestBriefRecord,
  ResearchContinuation,
  SteerTaskInput,
  TaskCommunicationView,
  TaskRecord,
  TaskTarget,
} from "../contracts.ts";
import { MAX_RESEARCH_DECISION_TEXT_BYTES } from "../contracts.ts";
import { withCoordinatorLaunchLock } from "../coordinator/lock.ts";
import { openProject } from "../coordinator/open-project.ts";
import { describeTaskPr, type PrSummary } from "../delivery/evidence.ts";
import { type DeliveryPreflightResult, deliveryPreflight } from "../delivery/preflight.ts";
import {
  mergeReviewedTask,
  publishReviewedTask,
  publishTaskDraft,
} from "../delivery/pull-requests.ts";
import { type MemoryWriteInput, ProjectMemory } from "../memory/service.ts";
import type { MemoryShowResult } from "../memory/view.ts";
import type { OnboardingFacts } from "../onboarding/checklist.ts";
import {
  type SetupApplyResult,
  type SetupPageEvent,
  type SetupPageOpened,
  SetupPageWorkflow,
} from "../onboarding/setup-page.ts";
import { checkTools, type ToolCheck } from "../onboarding/tools.ts";
import {
  PINNABLE_PLAYBOOK_IDS,
  type PinnablePlaybookId,
  type PlaybookId,
} from "../playbooks/catalog.ts";
import type { PlaybookClassifier } from "../playbooks/classify.ts";
import { maintainPool } from "../pool/maintenance.ts";
import type { PoolMaintenanceResult } from "../pool/policy.ts";
import type { ReviewVerdict } from "../pr-review/post.ts";
import {
  createPrReviewWorkflow,
  type PostPrReviewResult,
  type PrReviewEdits,
  type PrReviewWorkflow,
  type ShowPrReviewResult,
  type StartPrReviewInput,
  type StartPrReviewResult,
} from "../pr-review/service.ts";
import type { PrReviewState } from "../pr-review/state.ts";
import { removeReviewWorktree } from "../pr-review/worktree.ts";
import type { PrObservation } from "../pr-watch/decide.ts";
import { checkProjectMerging, type MergingCheck } from "../pr-watch/merging-check.ts";
import { type PrWatchNotice, withPrWatches } from "../pr-watch/store.ts";
import type { PrWatchView } from "../pr-watch/view.ts";
import {
  conflictFixObjective,
  type NamedPullRequest,
  PrWatcher,
  resolvePullRequest,
} from "../pr-watch/watcher.ts";
import { PresentationFeedbackWorkflow } from "../presentations/feedback.ts";
import { type PresentationRecord, readPresentationRecord } from "../presentations/records.ts";
import { preparePresentation } from "../presentations/session.ts";
import { PresentationRuntimeWorkflow, presentationAgentFor } from "../presentations/workflow.ts";
import {
  CentralRecoveryWorkflow,
  RESTART_QUESTION_ID_PREFIX,
  reportBlock,
  VALIDATION_RETRY_QUESTION_ID_PREFIX,
} from "../recovery/central.ts";
import { buildReportView, buildTaskReport, reportScopeLabel } from "../report/build.ts";
import type { ReportTask, ReportView } from "../report/model.ts";
import {
  checkoutQuestion,
  expandHome,
  findCheckout,
  findCheckoutsByName,
  type NamedCheckout,
  pinDefaultBranch,
  projectRoots,
  repoName,
} from "../repos/locate.ts";
import { briefSkipsReview } from "../requests/brief.ts";
import { createRequestBriefStore, type RequestBriefStore } from "../requests/store.ts";
import {
  type ApproveRequestBriefInput,
  type DraftRequestBriefInput,
  type RequestBriefView,
  RequestBriefWorkflow,
} from "../requests/workflow.ts";
import {
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
  taskSessionDirectory,
  updateRuntimeState,
  writeJsonAtomically,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type {
  DurableReservation,
  RuntimePresentation,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import { requestIntakeEvent } from "../runtime/usage-events.ts";
import {
  createRequestUsageLedger,
  type RequestUsageLedger,
  readTaskUsage,
} from "../runtime/usage-ledger.ts";
import type { RequestUsageReadout, RequestUsageReceipt } from "../runtime/usage-receipt.ts";
import { type IssueDraftChecker, issueDraftChecker } from "../self-improvement/issue-draft.ts";
import {
  type InvestigateInput,
  type InvestigationQuestion,
  type IssueInput,
  type IssueReview,
  SelfImprovement,
} from "../self-improvement/service.ts";
import { buildResearchContinuationBrief } from "../session/research-follow-up.ts";
import { TaskControlWorkflow } from "../tasks/control.ts";
import { KEEP_FIXING_QUESTION_ID_PREFIX, keepFixingGrant } from "../tasks/findings.ts";
import { inspectTask, type TaskInspection } from "../tasks/inspection.ts";
import type { TaskEvent, TaskTransitionContext } from "../tasks/lifecycle.ts";
import { isActiveTask, transitionTask } from "../tasks/lifecycle.ts";
import { decideRequiredStages, pullRequestPublished } from "../tasks/required-stages.ts";
import {
  DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS,
  type ResearchContinuationClassifier,
  researchContinuationClassifier,
} from "../tasks/research-continuation-classifier.ts";
import {
  answerPendingDecision,
  finishResearchInterview,
  openPendingDecision,
  pendingResearchDecision,
  researchInterviewFor,
} from "../tasks/research-interview.ts";
import {
  type ReviewAssistanceRuntime,
  reviewAssistanceConfig,
  reviewAssistanceRuntime,
} from "../tasks/review-assistance.ts";
import { createTaskStore, type TaskStore, transitionStoredTask } from "../tasks/store.ts";
import { readTimeline } from "../tasks/timeline-store.ts";
import {
  summarizeRollups,
  type TaskTrace,
  type TraceSummary,
  taskCost,
  taskRollup,
} from "../tasks/trace.ts";
import { readRegisteredProjects } from "../terminal/projects.ts";
import { assertSourceUnchanged } from "../workers/checkout.ts";
import type { ModelCatalogueSnapshot } from "../workers/execution-routing.ts";
import { claimOf, ownsOperation } from "../workers/operation-claim.ts";
import {
  liveWorkerTerminal,
  requestWorkerResearchFollowUp,
  type WorkerTerminalJob,
  waitForWorkerResearchFollowUp,
} from "../workers/terminal.ts";
import { prepareWorkerTerminal, workerJobForEndpoint } from "../workers/terminal-control.ts";
import { WorkerWorkflow } from "../workers/workflow.ts";
import { DraftRefreshWorkflow } from "./draft-refresh.ts";
import { runtimeWithPoolAdmission, taskWithPoolAdmission } from "./pool-admission.ts";
import {
  alreadyStopped,
  type HeldTaskStep,
  heldTaskStep,
  type LiveTaskStep,
  liveTaskStep,
} from "./reconcile-step.ts";
import {
  absoluteDirectory,
  currentWriter,
  describeError,
  errorClassName,
  isMissing,
  isMissingEndpoint,
  isRecord,
  isTerminalTask,
  positiveInteger,
  readTextList,
  replaceRuntimeTask,
  reportPathFor,
  singleLine,
  taskInputFor,
  taskNameFor,
  text,
  validateModelAssignments,
  workerRoleForTask,
} from "./records.ts";
import { RequestAccountingWorkflow } from "./request-accounting.ts";
import { resolveResearchHandoffs } from "./research-handoffs.ts";
import { createResearchFollowUpFiles, readResearchFollowUpAnswer } from "./research-session.ts";
import {
  decideScoutWorktreeRelease,
  observeScoutCheckout,
  releaseTerminalTaskResources,
  runCleanupCommands,
  type TaskCleanupOutcome,
  type TerminalTaskCleanupOptions,
} from "./scout-cleanup.ts";
import { mapTaskSource, SourceInboxWorkflow, taskCheckoutPath, taskSourcePath } from "./source.ts";
import { pruneTranscripts, transcriptsToPrune } from "./transcript-pruning.ts";

// ponytail: a fixed count of ready idle worktree copies per repository, removed first under disk
// pressure. Size it from recent task starts if copies are too often missing or left unused.
const WARM_IDLE_COPIES = 3;

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
  /** Names of skills the user asked this work to use; Tandem looks each one up and pins it. */
  readonly skills?: readonly string[];
  /** The job playbook the user chose for implementation work; Jev picks one when absent. */
  readonly playbook?: PinnablePlaybookId;
  /** Another repository to work in, as GitHub `owner/repo`; absent works in this project. */
  readonly targetRepo?: string;
  /** Where the user said the target repository is checked out. */
  readonly targetCheckout?: string;
  /** The user said to clone the target repository. */
  readonly targetClone?: boolean;
  /** How to check work in a target repository with no saved validation commands, from the brief. */
  readonly validationCommands?: readonly string[];
  /** The workstream this work belongs to, such as "billing"; its catch-up lists the task's PR. */
  readonly workstream?: string;
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
  /** Picks a new implementation task's playbook; defaults to the general playbook. */
  readonly classifyPlaybook?: PlaybookClassifier;
  /** The Jev transport, cache, and diagnostics sink review-level assistance is allowed to use. */
  readonly reviewAssistance?: ReviewAssistanceRuntime;
  /** Folders crawled for another repository's checkout; unset reads `projectRoots` on each use. */
  readonly projectRoots?: readonly string[];
  /** The home folder whose skill folders hold the user's personal skills; defaults to the OS home. */
  readonly personalSkillsHome?: string;
  /** The Jev check of a report-mode issue draft; without one, every draft is flagged. */
  readonly checkIssueDraft?: IssueDraftChecker;
}>;
/** A checkout onboarding found by name, and whether it already has saved Tandem settings. */
export type FoundRepo = NamedCheckout & Readonly<{ readonly setUp: boolean }>;

/** The user's edits to a project's discovered commands, saved by setup in their place. */
export type SetupCommandEdits = Readonly<{
  readonly validationCommands?: readonly string[] | undefined;
  readonly setupCommands?: readonly string[] | undefined;
}>;

export type TandemService = Readonly<{
  readonly onboard: (
    repoPath: string,
    write?: boolean,
    commands?: SetupCommandEdits,
  ) => Promise<OnboardRepoResult>;
  /** Setup-only onboarding that may inspect/save a selected foreign checkout directly. */
  readonly setupOnboard: (
    repoPath: string,
    write?: boolean,
    commands?: SetupCommandEdits,
  ) => Promise<OnboardRepoResult>;
  readonly mcpServers: (repoPath: string) => Promise<readonly string[]>;
  /** Checkouts the user could mean by a name or path, and whether each is already set up. */
  readonly findRepo: (name: string) => Promise<readonly FoundRepo[]>;
  /** Saves the folders the user keeps code in, for finding repositories by name. */
  readonly saveProjectRoots: (roots: readonly string[]) => Promise<HomeSettings>;
  /** Saves the self-improvement mode the user chose during onboarding. */
  readonly saveSelfImprovement: (mode: SelfImprovementMode) => Promise<HomeSettings>;
  /** Checks the tools onboarding depends on, without changing anything. */
  readonly checkTools: () => Promise<readonly ToolCheck[]>;
  /** What first-time setup still needs, for the Tandem coordinator at `repoPath`. */
  readonly onboardingFacts: (repoPath: string) => Promise<OnboardingFacts>;
  /** Builds the setup page for the Tandem coordinator at `repoPath` and opens it in Lavish. */
  readonly openSetupPage: (repoPath: string) => Promise<SetupPageOpened>;
  /**
   * Waits for the open setup page's next feedback, showing `reply` in the browser first. A valid
   * answer is stored for `applySetup`; an invalid one comes back with its problems.
   */
  readonly awaitSetupAnswer: (
    repoPath: string,
    signal: AbortSignal,
    reply?: string,
  ) => Promise<SetupPageEvent>;
  /** Saves a validated setup answer and reports its complete or partial result. */
  readonly applySetup: (repoPath: string, answerId: string) => Promise<SetupApplyResult>;
  readonly models: (repoPath: string) => Promise<ModelOptionsResult>;
  /** Opens a saved project's coordinator in this Herdr session; refuses one not yet set up. */
  readonly openProject: (
    repoPath: string,
  ) => Promise<Readonly<{ readonly repoPath: string; readonly focused: boolean }>>;
  readonly configureModels: (
    input: Readonly<{
      readonly repoPath: string;
      readonly models: RepoPolicy["models"];
      /** Omit to preserve the previously saved provider enablement. */
      readonly enabledProviders?: readonly string[] | undefined;
      /** Omit to preserve the previously saved Jev setting. */
      readonly jev?: JevSetting | undefined;
    }>,
  ) => Promise<ModelSettings>;
  readonly create: (input: CreateTaskRequest) => Promise<TaskRecord>;
  readonly refreshSource?: () => Promise<SourceRefreshResult | undefined>;
  readonly list: () => Promise<readonly TaskRecord[]>;
  readonly get: (id: string) => Promise<TaskRecord>;
  readonly inspect: (id: string) => Promise<TaskInspection>;
  /** One task's timeline and rollup. */
  readonly trace: (id: string) => Promise<TaskTrace>;
  /** The rollups across every task in scope. */
  readonly traceSummary: () => Promise<TraceSummary>;
  /** Where each task in scope spent its time, for `tandem report`; `since` bounds task creation. */
  readonly report: (options?: Readonly<{ readonly since?: IsoTimestamp }>) => Promise<ReportView>;
  readonly deliveryPreflight: (
    id: string,
    input: { readonly base: string },
  ) => Promise<DeliveryPreflightResult>;
  readonly approve: (id: string) => Promise<TaskRecord>;
  readonly draftRequestBrief: (input: DraftRequestBriefInput) => Promise<RequestBriefView>;
  readonly reviewRequestBrief: (requestId: string) => Promise<RequestBriefView>;
  readonly approveRequestBrief: (intent: ApproveRequestBriefInput) => Promise<RequestBriefView>;
  /** Drops a request whose brief was never approved, so it stops awaiting approval. */
  readonly abandonRequestBrief: (requestId: string) => Promise<RequestBriefView>;
  /** The one request whose brief is awaiting approval; fails closed when that is not unambiguous. */
  readonly pendingBriefApprovalId: () => Promise<string>;
  readonly requestBrief: (requestId: string) => Promise<RequestBriefView>;
  /** Without an id, the receipt is for the request in progress. */
  readonly requestReceipt: (requestId?: string) => Promise<RequestUsageReceipt>;
  readonly tick: () => Promise<readonly TaskRecord[]>;
  readonly acknowledge: (id: string, notificationId: string) => Promise<TaskRecord>;
  readonly steer: (input: SteerTaskInput) => Promise<TaskCommunicationView>;
  readonly researchFollowUp: (
    input: Readonly<{ readonly taskId: string; readonly question: string }>,
  ) => Promise<string>;
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
  /** The board across every onboarded project, from saved state only; it never reads GitHub. */
  readonly board: () => Promise<BoardView>;
  /** Tells the user through a Herdr notification that these rows just arrived in "Needs you". */
  readonly notifyNeedsYou: (repoPath: string, rows: readonly BoardRow[]) => Promise<void>;
  /** The PR watch view, after reading GitHub unless another Tandem is reading it right now. */
  readonly prWatch: () => Promise<PrWatchView>;
  /** Watches a pull request: a link, `owner/repo#N`, or `#N` in `repoPath` (default: this project). */
  readonly prWatchStart: (input: PullRequestInput) => Promise<PrWatchView>;
  readonly prWatchStop: (input: PullRequestInput) => Promise<PrWatchView>;
  /** Notifications about watched pull requests that no Tandem has shown yet. */
  readonly prWatchNotices: () => Promise<readonly PrWatchNotice[]>;
  /**
   * The user said yes to fixing a pull request's conflicts: starts an approved task that merges
   * its base into its branch and pushes, never force-pushing.
   */
  readonly prWatchFix: (input: PullRequestInput) => Promise<TaskRecord>;
  /** One line per workstream in the project with what is due; empty when there are none. */
  readonly memoryList: (repoPath: string) => Promise<readonly string[]>;
  /** One workstream's catch-up, or that it has no notes yet. */
  readonly memoryShow: (repoPath: string, workstream: string) => Promise<MemoryShowResult>;
  /** Replaces sections of a workstream's notes; refused when the file would pass its size cap. */
  readonly memoryWrite: (input: MemoryWriteInput) => Promise<string>;
  /** Archives a finished workstream, keeping its notes. */
  readonly memoryDone: (repoPath: string, workstream: string) => Promise<string>;
  /** Read-only: how this project's pull requests would merge, for onboarding and PR watch. */
  readonly mergingCheck: (repoPath: string) => Promise<MergingCheck>;
  /** Saves the user's answer about merging into the project's settings (see pr-watch.md). */
  readonly saveMerging: (
    input: Readonly<{ readonly repoPath: string; readonly choice: MergingChoice }>,
  ) => Promise<MergingSettingsFile>;
  /** Whether this machine looks into Tandem's own problems, and what it does with the answer. */
  readonly selfImprovementMode: () => Promise<SelfImprovementMode>;
  /** Questions about open tasks that newly broke a trigger rule; each task is asked about once. */
  readonly investigationQuestions: () => Promise<readonly InvestigationQuestion[]>;
  /** Starts research in the Tandem repository into why a task went the way it did. */
  readonly investigate: (input: InvestigateInput) => Promise<TaskRecord>;
  /** A report-mode issue scrubbed of the task's work content, with its Jev check. */
  readonly reviewIssue: (input: IssueInput) => Promise<IssueReview>;
  /** Files the scrubbed issue on the Tandem repository; only after the user approved it. */
  readonly fileIssue: (input: IssueInput) => Promise<Readonly<{ url: string }>>;
  readonly shutdown: () => Promise<void>;
}>;

export type PullRequestInput = Readonly<{
  readonly pullRequest: string;
  readonly repoPath?: string | undefined;
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
  classifyPlaybook: PlaybookClassifier;
  store: TaskStore;
  requestStore: RequestBriefStore;
  usageLedger: RequestUsageLedger;
  runtimePath: string;
  workerPath: string;
  validationWorkerPath: string;
  reviewAssistance: ReviewAssistanceRuntime;
  projectRoots: () => Promise<readonly string[]>;
  personalSkillsHome: string;
  checkIssueDraft: IssueDraftChecker;
}>;

/** Why a task resumed after its question was answered, as its timeline records it. */
const QUESTION_ANSWERED = "Its question was answered.";

function assertTaskId(id: unknown): string {
  return singleLine(id, "task id");
}

function assertArtifacts(artifacts: unknown): readonly string[] {
  return readTextList(artifacts, "artifacts");
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

function newRuntimeTask(
  task: TaskRecord,
  origin: Readonly<{
    readonly checkpoint: GitCheckpoint;
    readonly sourceRepoPath: string | undefined;
    readonly home: string;
  }>,
): RuntimeTaskState {
  return {
    schemaVersion: 1,
    taskId: task.id,
    sourceCheckpoint: origin.checkpoint,
    ...(origin.sourceRepoPath === undefined ? {} : { sourceRepoPath: origin.sourceRepoPath }),
    taskName: taskNameFor(task),
    endpoints: [],
    jobs: [],
    ...(["scout", "implementation", "pr-review"].includes(task.kind)
      ? { sessionDirectory: taskSessionDirectory(origin.home, task.id) }
      : {}),
  };
}

/** A task advanced while a remote publication was in flight; the published result is retained. */
class TaskRevisionConflictError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} changed while publishing; remote publication is retained`);
    this.name = "TaskRevisionConflictError";
  }
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
  readonly #accounting: RequestAccountingWorkflow;
  readonly #prReviews: PrReviewWorkflow;
  readonly #drafts: DraftRefreshWorkflow;
  readonly #prWatch: PrWatcher;
  readonly #memory: ProjectMemory;
  readonly #selfImprovement: SelfImprovement;
  readonly #setupPage: SetupPageWorkflow;
  #tickPromise: Promise<readonly TaskRecord[]> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #sourceRefreshPromise: Promise<SourceRefreshResult> | undefined;
  #sourceRefreshError: string | undefined;
  #sourceReadyHead: string | undefined;
  #sourceReady = true;
  constructor(deps: ServiceDependencies) {
    this.#deps = deps;
    this.#drafts = new DraftRefreshWorkflow({
      home: deps.home,
      clock: deps.clock,
      run: deps.run,
      recordPullRequest: (taskId, expectedRevision, metadata) =>
        this.recordPullRequest(taskId, expectedRevision, metadata),
    });
    this.#selfImprovement = new SelfImprovement({
      home: deps.home,
      run: deps.run,
      clock: deps.clock,
      checkDraft: deps.checkIssueDraft,
      getTask: (taskId) => this.get(taskId),
      traceTask: (taskId) => this.trace(taskId),
      createTask: (input) => this.create(input),
    });
    this.#setupPage = new SetupPageWorkflow({
      home: deps.home,
      homeFolder: homedir(),
      run: deps.run,
      clock: deps.clock,
      idFactory: deps.idFactory,
      models: (repoPath) => this.models(repoPath),
      roots: () => deps.projectRoots(),
      homeSettings: () => readHomeSettings(deps.home),
      registeredProjects: () => readRegisteredProjects(deps.home),
      inspectRepo: async (path) => {
        const onboarded = await this.setupOnboard(path, false);
        return {
          validationCommands: onboarded.validationCommands.map((command) => command.name),
          scripts: onboarded.discovery.scripts,
          setupCommands: onboarded.setupCommands.map((command) => command.name),
          ...(onboarded.discovery.lockfile === undefined
            ? {}
            : { lockfile: onboarded.discovery.lockfile }),
        };
      },
      saveModels: (input) => this.configureModels(input),
      saveSelfImprovement: (mode) => saveSelfImprovement(deps.home, mode),
      saveCodeFolders: (folders) => saveProjectRoots(deps.home, folders),
      setupRepo: (path, repo) =>
        this.setupOnboard(path, true, {
          validationCommands: repo.validationCommands,
          setupCommands: repo.setupCommands,
        }),
      openProject: (path) => this.openProject(path),
    });
    this.#prWatch = new PrWatcher({
      home: deps.home,
      run: deps.run,
      clock: deps.clock,
      listTasks: () => deps.store.list(),
      steerTask: (taskId, text) => this.steerForPrWatch(taskId, text),
      recordMerged: (taskId, head) => this.recordMergedOnGitHub(taskId, head),
    });
    this.#memory = new ProjectMemory({
      home: deps.home,
      clock: deps.clock,
      projectPath: async (repoPath) =>
        (await mapTaskSource(deps.run, repoPath, deps.sourceWorkspace)).repoPath,
      listTasks: () => deps.store.list(),
      listWatches: () => withPrWatches(deps.home, (transaction) => transaction.watches),
    });
    this.#accounting = new RequestAccountingWorkflow({
      home: deps.home,
      clock: deps.clock,
      idFactory: deps.idFactory,
      requestStore: deps.requestStore,
      usage: deps.usageLedger,
      sourceRepoPath: deps.sourceWorkspace?.repoPath,
      listTasks: () => deps.store.list(),
      openRequestForNewWork: (repoPath, tasks) =>
        this.#requests.openRequestForNewWork(repoPath, tasks),
      readState: () => this.readState(),
      updateTask: (taskId, transform) => this.updateTask(taskId, transform),
    });
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
      run: deps.run,
      clock: deps.clock,
      store: deps.store,
      runtimePath: deps.runtimePath,
      readState: () => this.readState(),
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
      cleanupNonAdoptedResearchHandoff: (task) =>
        this.cleanupTerminalTask(task, { approvedResearchHandoff: true }),
      reviewAssistance: deps.reviewAssistance,
      recordRequestUsage: (events) => this.#accounting.record(events),
      readRequestUsage: (requestId) => deps.usageLedger.read(requestId),
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
      briefSkipsReview: (requestId) => this.briefSkipsReview(requestId),
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
      onboard: (repoPath, write, commands) => this.onboard(repoPath, write, commands),
      setupOnboard: (repoPath, write, commands) => this.setupOnboard(repoPath, write, commands),
      mcpServers: (repoPath) => listOmpMcpServers(repoPath),
      findRepo: (name) => this.findRepo(name),
      saveProjectRoots: (roots) =>
        saveProjectRoots(
          this.#deps.home,
          readTextList(roots, "projectRoots").map((root) => expandHome(root)),
        ),
      saveSelfImprovement: (mode) => saveSelfImprovement(this.#deps.home, mode),
      checkTools: () =>
        checkTools(this.#deps.run, { cwd: this.#deps.home, sessionId: this.#deps.sessionId }),
      onboardingFacts: (repoPath) => this.onboardingFacts(repoPath),
      openSetupPage: (repoPath) => this.#setupPage.open(repoPath),
      awaitSetupAnswer: (repoPath, signal, reply) =>
        this.#setupPage.listen(repoPath, signal, reply),
      applySetup: (repoPath, answerId) => this.#setupPage.apply(repoPath, answerId),
      inspect: (id) => this.inspect(id),
      trace: (id) => this.trace(id),
      traceSummary: () => this.traceSummary(),
      report: (options) => this.report(options),
      deliveryPreflight: (id, input) => this.deliveryPreflight(id, input.base),
      models: (repoPath) => this.models(repoPath),
      openProject: (repoPath) => this.openProject(repoPath),
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
      approveRequestBrief: (intent) => this.approveRequestBrief(intent),
      abandonRequestBrief: (requestId) => this.#requests.abandon(requestId),
      pendingBriefApprovalId: () => this.#requests.pendingApprovalId(),
      requestBrief: (requestId) => this.#requests.read(requestId),
      requestReceipt: (requestId) => this.#accounting.receipt(requestId),
      tick: () => this.tick(),
      acknowledge: (id, notificationId) => this.acknowledge(id, notificationId),
      steer: (input) => this.steer(input),
      researchFollowUp: (input) => this.researchFollowUp(input),
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
      requestBriefs: () => this.#accounting.briefs(),
      reviewPr: (input) => this.#prReviews.start(input),
      reviewShow: (id, input) => this.#prReviews.show(assertTaskId(id), input),
      reviewNotes: (id) => this.#prReviews.notes(assertTaskId(id)),
      reviewEdit: (id, edits) => this.#prReviews.edit(assertTaskId(id), edits),
      reviewPost: (id, input) =>
        this.#prReviews.post(assertTaskId(id), input.verdict, input.approved),
      reviewAgain: (id) => this.#prReviews.again(assertTaskId(id)),
      reviewClose: (id) => this.#prReviews.close(assertTaskId(id)),
      board: () => readBoard(this.#deps.home, this.#deps.clock),
      notifyNeedsYou: (repoPath, rows) => this.notifyNeedsYou(repoPath, rows),
      prWatch: () => this.#prWatch.view(),
      prWatchStart: async (input) => this.#prWatch.start(await this.namedPullRequest(input)),
      prWatchStop: async (input) => this.#prWatch.stop((await this.namedPullRequest(input)).ref),
      prWatchNotices: () => this.#prWatch.takeNotices(),
      prWatchFix: async (input) => {
        const named = await this.namedPullRequest(input);
        return this.#prWatch.fixConflicts(named.ref, (pr, files) =>
          this.startConflictFix(named, pr, files),
        );
      },
      memoryList: (repoPath) => this.#memory.lines(repoPath),
      memoryShow: (repoPath, workstream) => this.#memory.show(repoPath, workstream),
      memoryWrite: (input) => this.#memory.write(input),
      memoryDone: (repoPath, workstream) => this.#memory.done(repoPath, workstream),
      mergingCheck: (repoPath) =>
        checkProjectMerging(
          this.#deps.run,
          absoluteDirectory(repoPath, "repoPath"),
          this.#deps.home,
        ),
      saveMerging: (input) =>
        saveMergingChoice({
          repoPath: input.repoPath,
          home: this.#deps.home,
          choice: input.choice,
        }),
      selfImprovementMode: () => this.#selfImprovement.mode(),
      investigationQuestions: async () => this.#selfImprovement.takeQuestions(await this.list()),
      investigate: (input) => this.#selfImprovement.investigate(input),
      reviewIssue: (input) => this.#selfImprovement.reviewIssue(input),
      fileIssue: (input) => this.#selfImprovement.fileIssue(input),
      shutdown: () => this.shutdown(),
    };
  }

  async setupOnboard(
    repoPath: string,
    write = false,
    commands: SetupCommandEdits = {},
  ): Promise<OnboardRepoResult> {
    let targetRepoPath = repoPath;
    let checkoutPath: string | undefined;
    const sourceWorkspace = this.#deps.sourceWorkspace;
    if (sourceWorkspace !== undefined) {
      const [requestedRoot, originalRoot, cleanRoot] = await Promise.all([
        realpath(repoPath),
        realpath(sourceWorkspace.repoPath),
        realpath(sourceWorkspace.path),
      ]);
      if (requestedRoot === originalRoot || requestedRoot === cleanRoot) {
        const source = await mapTaskSource(this.#deps.run, repoPath, sourceWorkspace);
        targetRepoPath = source.repoPath;
        checkoutPath = source.sourceRepoPath;
      }
    }
    return onboardRepo({
      repoPath: targetRepoPath,
      home: this.#deps.home,
      write,
      ...(commands.validationCommands === undefined
        ? {}
        : { validationCommands: readTextList(commands.validationCommands, "validationCommands") }),
      ...(commands.setupCommands === undefined
        ? {}
        : { setupCommands: readTextList(commands.setupCommands, "setupCommands") }),
      ...(checkoutPath === undefined ? {} : { checkoutPath }),
    });
  }

  async onboard(
    repoPath: string,
    write = false,
    commands: SetupCommandEdits = {},
  ): Promise<OnboardRepoResult> {
    const source = await mapTaskSource(this.#deps.run, repoPath, this.#deps.sourceWorkspace);
    return onboardRepo({
      repoPath: source.repoPath,
      home: this.#deps.home,
      write,
      ...(commands.validationCommands === undefined
        ? {}
        : { validationCommands: readTextList(commands.validationCommands, "validationCommands") }),
      ...(commands.setupCommands === undefined
        ? {}
        : { setupCommands: readTextList(commands.setupCommands, "setupCommands") }),
      ...(source.sourceRepoPath === undefined ? {} : { checkoutPath: source.sourceRepoPath }),
    });
  }
  private async findRepo(name: string): Promise<readonly FoundRepo[]> {
    const found = await findCheckoutsByName(name, await this.#deps.projectRoots(), this.#deps.run);
    const saved = new Set(await readRegisteredProjects(this.#deps.home));
    return found.map((checkout) => ({ ...checkout, setUp: saved.has(checkout.path) }));
  }

  private async onboardingFacts(repoPath: string): Promise<OnboardingFacts> {
    const [models, settings, registered, tandem, setupPage] = await Promise.all([
      readModelSettings({ repoPath, home: this.#deps.home }),
      readHomeSettings(this.#deps.home),
      readRegisteredProjects(this.#deps.home),
      realpath(repoPath),
      this.#setupPage.status(),
    ]);
    return {
      modelsChosen: models.configured,
      codeFolders: settings.projectRoots,
      projects: registered.filter((project) => project !== tandem),
      selfImprovementChosen: settings.selfImprovementChosen,
      setupPage,
    };
  }

  async openProject(
    repoPath: string,
  ): Promise<Readonly<{ readonly repoPath: string; readonly focused: boolean }>> {
    const onboarded = await this.setupOnboard(repoPath, false);
    if (!onboarded.existingConfig) {
      throw new Error(`${onboarded.repoPath} has no saved Tandem settings yet; save them first`);
    }
    if (!onboarded.modelSettings.configured) {
      throw new Error("no model choices are saved yet; save them first");
    }
    const { focused } = await openProject(this.#deps.run, {
      repoPath: onboarded.repoPath,
      home: this.#deps.home,
      sessionId: this.#deps.sessionId,
      poolRoot: this.#deps.poolRoot,
    });
    return { repoPath: onboarded.repoPath, focused };
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
      readonly jev?: JevSetting | undefined;
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
      ...(input.jev === undefined ? {} : { jev: input.jev }),
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

  /** Pinned once at creation, outside the store lock, so restarts and fix rounds reuse it. */
  private async playbookFor(
    input: CreateTaskRequest | PrReviewTaskRequest,
    brief: RequestBriefRecord | undefined,
  ): Promise<PlaybookId | undefined> {
    if (input.kind !== "implementation") return undefined;
    if (input.playbook !== undefined) {
      if (!(PINNABLE_PLAYBOOK_IDS as readonly string[]).includes(input.playbook)) {
        throw new TypeError(`playbook must be one of ${PINNABLE_PLAYBOOK_IDS.join(", ")}`);
      }
      return input.playbook;
    }
    return this.#deps.classifyPlaybook(
      brief === undefined ? input.objective : brief.draft.content.goal,
    );
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
    const playbook = await this.playbookFor(input, brief);
    const pinned = input.kind === "pr-review" ? undefined : await this.pinTarget(input);
    return this.#deps.store.exclusive(async (store) => {
      const source = await mapTaskSource(
        this.#deps.run,
        input.repoPath,
        this.#deps.sourceWorkspace,
      );
      const policy =
        pinned === undefined
          ? await resolveRepoPolicy({
              repoPath: source.repoPath,
              home: this.#deps.home,
              ...(source.sourceRepoPath === undefined
                ? {}
                : { checkoutPath: source.sourceRepoPath }),
            })
          : pinned.policy;
      // Only skills explicitly named for this task are pinned into its record.
      const skillNames = input.skills === undefined ? [] : readTextList(input.skills, "skills");
      const skills =
        skillNames.length === 0
          ? []
          : await findSkills(skillNames, {
              repositoryCheckout: pinned?.target.checkout ?? source.checkoutPath,
              personalHome: this.#deps.personalSkillsHome,
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
      const checkpoint =
        pinned?.checkpoint ?? (await readCheckpoint(this.#deps.run, { repo: source.checkoutPath }));
      const runtime = await readRuntimeState(this.#deps.runtimePath);
      const researchHandoffs =
        researchTaskIds === undefined
          ? undefined
          : await resolveResearchHandoffs(researchTaskIds, {
              home: this.#deps.home,
              projectRepoPath: source.repoPath,
              runtime,
              store,
            });
      const taskInput = taskInputFor(
        {
          ...input,
          ...(requestId === undefined ? {} : { requestId }),
          ...(researchHandoffs === undefined ? {} : { researchHandoffs }),
          ...(classifiedContinuation === undefined
            ? {}
            : { researchContinuation: classifiedContinuation }),
          ...(pinned === undefined ? {} : { target: pinned.target }),
          ...(playbook === undefined ? {} : { playbook }),
          ...(input.kind === "implementation"
            ? {
                requiredStages: decideRequiredStages({
                  briefSkipsReview: brief !== undefined && briefSkipsReview(brief),
                  pullRequestPublished: false,
                }),
              }
            : {}),
          skills,
        },
        source.repoPath,
        policy,
      );
      const id = singleLine(this.#deps.idFactory(), "task id");
      if (pinned === undefined) this.assertSourceUnchangedSinceRefresh(checkpoint.head);
      const created = await store.create({ ...taskInput, id });
      const current = await readRuntimeState(this.#deps.runtimePath);
      const runtimeTask = newRuntimeTask(created, {
        checkpoint,
        sourceRepoPath: pinned?.target.checkout ?? source.sourceRepoPath,
        home: this.#deps.home,
      });
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

  /** New work must start from the head the last successful refresh saw; a drift needs a refresh. */
  private assertSourceUnchangedSinceRefresh(head: string): void {
    if (this.#deps.refreshSource === undefined) return;
    if (this.#sourceReadyHead !== undefined && head === this.#sourceReadyHead) return;
    this.#sourceReady = false;
    throw new Error(
      `coordinator source changed after refresh (expected ${this.#sourceReadyHead ?? "a successful refresh"}, observed ${head}); refresh before creating new work`,
    );
  }

  /**
   * Finds the other repository a create names and pins its default branch. When it is not in
   * exactly one place, the error is the question to ask; the answer comes back as
   * `targetCheckout` or `targetClone`.
   */
  private async pinTarget(
    input: CreateTaskRequest,
  ): Promise<
    | Readonly<{ target: TaskTarget; checkpoint: GitCheckpoint; policy: TaskRecord["policy"] }>
    | undefined
  > {
    if (input.targetRepo === undefined) {
      if (
        input.targetCheckout !== undefined ||
        input.targetClone !== undefined ||
        input.validationCommands !== undefined
      ) {
        throw new Error("targetCheckout, targetClone, and validationCommands need targetRepo");
      }
      return undefined;
    }
    const repo = repoName(input.targetRepo);
    const location = await findCheckout(
      repo,
      { checkout: input.targetCheckout, clone: input.targetClone },
      {
        home: this.#deps.home,
        run: this.#deps.run,
        clock: this.#deps.clock,
        roots: await this.#deps.projectRoots(),
      },
    );
    if (location.kind !== "found") {
      throw new Error(
        `${checkoutQuestion(repo, location, input.targetCheckout)} Ask the user this, then create again with targetCheckout set to their path, or targetClone true if they say to clone it.`,
      );
    }
    if ((await realpath(location.path)) === (await realpath(input.repoPath))) {
      throw new Error(`${repo} is this project; create the task without targetRepo`);
    }
    const { branch, head } = await pinDefaultBranch(this.#deps.run, location.path, location.remote);
    const target = { repo, checkout: location.path, branch };
    return {
      target,
      checkpoint: { head, base: head, diff: "", dirty: false, unmerged: false },
      policy: await this.targetPolicy(input, target),
    };
  }

  /**
   * The target repository's own saved policy and guidance. Implementation there needs validation
   * commands; when none are saved, the user's answer from the brief supplies them.
   */
  private async targetPolicy(
    input: CreateTaskRequest,
    target: TaskTarget,
  ): Promise<TaskRecord["policy"]> {
    const saved = await resolveRepoPolicy({ repoPath: target.checkout, home: this.#deps.home });
    const config =
      input.validationCommands === undefined
        ? saved.config
        : parsePolicyOverride({ validationCommands: input.validationCommands }, saved.config);
    if (input.kind === "implementation" && config.validationCommands.length === 0) {
      throw new Error(
        `${target.repo} has no saved validation commands. Ask the user how to check work there (for example "bun test"), add their answer to the brief's automated checks, and create again with it as validationCommands.`,
      );
    }
    return { ...saved, config };
  }

  async list(): Promise<readonly TaskRecord[]> {
    return this.#source.scopedTasks();
  }

  /** Outside Herdr there is no coordinator pane, and nowhere to notify. */
  async notifyNeedsYou(repoPath: string, rows: readonly BoardRow[]): Promise<void> {
    if (this.#deps.coordinatorPaneId === undefined || rows.length === 0) return;
    await showNotification(
      this.#deps.run,
      this.#deps.sessionId,
      absoluteDirectory(repoPath, "repoPath"),
      needsYouNotice(rows),
    );
  }

  async get(id: string): Promise<TaskRecord> {
    const taskId = assertTaskId(id);
    const task = await this.#deps.store.read(taskId);
    if (task === undefined || !(await this.#source.taskInScope(task))) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task;
  }

  async researchFollowUp(
    input: Readonly<{ readonly taskId: string; readonly question: string }>,
  ): Promise<string> {
    if (!isRecord(input)) throw new TypeError("research follow-up input must be an object");
    const taskId = assertTaskId(input.taskId);
    const question = text(input.question, "question");
    if (Buffer.byteLength(question, "utf8") > MAX_RESEARCH_DECISION_TEXT_BYTES) {
      throw new Error(
        `research follow-up question exceeds ${MAX_RESEARCH_DECISION_TEXT_BYTES} bytes`,
      );
    }
    const requested = await this.get(taskId);
    if (
      requested.kind !== "scout" ||
      requested.stage !== "completed" ||
      requested.reportPath === undefined
    ) {
      throw new Error(`Task ${taskId} is not a completed research session`);
    }
    const createdAt = this.#deps.clock();
    const generatedId = singleLine(this.#deps.idFactory(), "decision id");
    const reserved = await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (
        current?.kind !== "scout" ||
        current.stage !== "completed" ||
        current.reportPath === undefined
      ) {
        throw new Error(`Task ${taskId} is no longer an available completed research session`);
      }
      const interview = researchInterviewFor(current);
      if (current.communication?.question !== undefined) {
        throw new Error(`Task ${taskId} has an unanswered coordinator question`);
      }
      if (interview === undefined || interview.status !== "open") {
        throw new Error(`Task ${taskId} research interview is not open`);
      }
      const nextInterview = openPendingDecision(interview, {
        id: generatedId,
        question,
        createdAt,
      });
      const decision = nextInterview.decisions.find(
        (entry) => entry.question === question && entry.status !== "withdrawn",
      );
      if (decision === undefined)
        throw new Error("research follow-up decision could not be recorded");
      if (nextInterview === interview) return { task: current, decision };
      const updated = await store.update(current.id, current.revision, (latest) => ({
        ...latest,
        revision: latest.revision + 1,
        updatedAt: createdAt,
        researchInterview: nextInterview,
      }));
      return { task: updated, decision };
    });
    if (reserved.decision.status === "answered") {
      if (reserved.decision.answer === undefined) {
        throw new Error(`answered research decision ${reserved.decision.id} has no durable answer`);
      }
      return reserved.decision.answer;
    }

    const state = await readRuntimeState(this.#deps.runtimePath);
    if (state === undefined)
      throw new Error("research runtime state is unavailable; the session was retained");
    const runtime = taskRuntime(state, taskId);
    if (runtime === undefined)
      throw new Error("research runtime ownership is unavailable; the session was retained");
    const handoffs = await resolveResearchHandoffs([taskId], {
      home: this.#deps.home,
      projectRepoPath: reserved.task.repoPath,
      runtime: state,
      store: this.#deps.store,
    });
    const handoff = handoffs[0];
    if (handoff === undefined)
      throw new Error("research report provenance could not be established");
    const durableJob = runtime.jobs.find(
      (job) =>
        job.kind === "worker" &&
        job.role === "scout" &&
        job.phase === "consumed" &&
        job.taskId === taskId &&
        job.generation === reserved.task.generation &&
        resolve(reportPathFor(job.jobPath)) === resolve(handoff.reportPath),
    );
    const lease = runtime.worktree;
    if (
      durableJob === undefined ||
      lease === undefined ||
      lease.leaseHolder !== `${this.#deps.sessionId}:${taskId}` ||
      lease.baseHead !== runtime.sourceCheckpoint.head ||
      resolve(durableJob.cwd) !== resolve(lease.path)
    ) {
      throw new Error(
        "research job and workspace lease ownership could not be proven; resources were retained",
      );
    }
    const terminalJob: WorkerTerminalJob = {
      id: durableJob.id,
      taskId,
      generation: durableJob.generation,
      role: "scout",
      cwd: durableJob.cwd,
      jobPath: durableJob.jobPath,
    };
    const files = await createResearchFollowUpFiles({
      home: this.#deps.home,
      taskId,
      jobPath: durableJob.jobPath,
      decisionId: reserved.decision.id,
      brief: buildResearchContinuationBrief({
        question,
        reportPath: handoff.reportPath,
        reportDigest: handoff.reportDigest,
        excerpt: handoff.excerpt,
      }),
    });
    const existingAnswer = await readResearchFollowUpAnswer(files.resultPath, reserved.decision.id);
    if (existingAnswer !== undefined) {
      await this.recordResearchFollowUpAnswer(taskId, reserved.decision.id, existingAnswer);
      return existingAnswer;
    }
    if (
      runtime.endpointLaunch !== undefined ||
      runtime.jobs.some(activeRuntimeJob) ||
      unreleasedReservation(runtime.reservation)
    ) {
      throw new Error(
        "research session still has an unresolved job or reservation; resources were retained",
      );
    }
    const checkout = await observeScoutCheckout(this.#deps.run, lease.path);
    const ownership = decideScoutWorktreeRelease({ lease, checkout });
    if (ownership.kind !== "release") {
      throw new Error(
        `research workspace is ${ownership.kind}: ${ownership.reason}; resources were retained`,
      );
    }
    const endpoint = runtime.endpoints.find(
      (entry) =>
        durableJob.endpoint !== undefined &&
        entry.sessionId === durableJob.endpoint.sessionId &&
        entry.workspaceId === durableJob.endpoint.workspaceId &&
        entry.tabId === durableJob.endpoint.tabId &&
        entry.paneId === durableJob.endpoint.paneId,
    );
    if (
      endpoint === undefined ||
      workerJobForEndpoint(runtime.jobs, endpoint)?.id !== durableJob.id
    ) {
      throw new Error(
        "research session pane ownership could not be proven; resources were retained",
      );
    }
    const inspection = await inspectEndpoint(this.#deps.run, {
      endpoint,
      cwd: durableJob.cwd,
    });
    const terminal = await liveWorkerTerminal(inspection, terminalJob);
    const idle =
      terminal?.phase === "idle" &&
      (terminal.commandId === undefined || terminal.commandId === reserved.decision.id);
    const activeSameTurn =
      terminal?.phase === "busy" && terminal.commandId === reserved.decision.id;
    if (terminal?.completed !== true || (!idle && !activeSameTurn)) {
      throw new Error(
        "research session is not idle for this follow-up; its pane and workspace were retained",
      );
    }
    const dispatch = await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      const interview = current?.kind === "scout" ? researchInterviewFor(current) : undefined;
      const decision = interview?.decisions.find((entry) => entry.id === reserved.decision.id);
      if (decision?.status === "answered") {
        if (decision.answer === undefined) {
          throw new Error(`answered research decision ${decision.id} has no durable answer`);
        }
        return { kind: "answered" as const, answer: decision.answer };
      }
      if (
        current?.stage !== "completed" ||
        interview?.status !== "open" ||
        decision?.status !== "pending"
      ) {
        throw new Error(
          "research follow-up decision is no longer pending; resources were retained",
        );
      }
      await requestWorkerResearchFollowUp(terminalJob, reserved.decision.id, {
        decisionId: reserved.decision.id,
        briefPath: files.briefPath,
        resultPath: files.resultPath,
      });
      return { kind: "dispatched" as const };
    });
    if (dispatch.kind === "answered") return dispatch.answer;
    await waitForWorkerResearchFollowUp(terminalJob, reserved.decision.id);
    const answer = await readResearchFollowUpAnswer(files.resultPath, reserved.decision.id);
    if (answer === undefined) {
      throw new Error(
        "research session settled without an answer; its pending decision and resources were retained",
      );
    }
    await this.recordResearchFollowUpAnswer(taskId, reserved.decision.id, answer);
    return answer;
  }

  private async recordResearchFollowUpAnswer(
    taskId: string,
    decisionId: string,
    answer: string,
  ): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task?.kind !== "scout") throw new Error(`Research task ${taskId} is unavailable`);
      const interview = researchInterviewFor(task);
      if (interview === undefined)
        throw new Error(`Research task ${taskId} has no interview state`);
      const resolvedAt = this.#deps.clock();
      const nextInterview = answerPendingDecision(interview, {
        id: decisionId,
        answer,
        resolvedAt,
      });
      if (nextInterview === interview) return;
      await store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: resolvedAt,
        researchInterview: nextInterview,
      }));
    });
  }

  async approve(id: string): Promise<TaskRecord> {
    const task = await this.get(id);
    const dispatch = await this.#requests.dispatchDecisionForTask(task);
    if (dispatch !== undefined && !dispatch.allowed) {
      throw new Error(`Task ${task.id} cannot be dispatched: ${dispatch.reason}`);
    }
    if (task.kind === "implementation" && task.target === undefined) {
      const runtime = await this.runtimeFor(task.id);
      if (runtime === undefined) throw new Error(`Task ${task.id} has no durable runtime metadata`);
      const current = await readCheckpoint(this.#deps.run, {
        repo: taskSourcePath(task, runtime),
      });
      assertSourceUnchanged(runtime.sourceCheckpoint, current);
    }
    if (task.kind !== "implementation" || (task.researchHandoffs?.length ?? 0) === 0) {
      return this.transition(task.id, { type: "approve" });
    }
    const context = this.context();
    const approved = await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) throw new Error(`Task ${task.id} was not found`);
      const nextTask = transitionTask(current, { type: "approve" }, context);
      for (const handoff of current.researchHandoffs ?? []) {
        const scout = await store.read(handoff.scoutTaskId);
        // A stopped or missing scout has no session left to hand off; implementation leases fresh.
        if (scout?.kind !== "scout" || scout.stage !== "completed") continue;
        const interview = researchInterviewFor(scout);
        if (interview?.status !== "open") continue;
        if (
          pendingResearchDecision(interview) !== undefined ||
          scout.communication?.question !== undefined
        ) {
          throw new Error(`Research task ${scout.id} still has an unanswered decision`);
        }
        const approvedInterview = finishResearchInterview(interview, "approved", context.now);
        await store.update(scout.id, scout.revision, (latest) => ({
          ...latest,
          revision: latest.revision + 1,
          updatedAt: context.now,
          researchInterview: approvedInterview,
          cleanup: {
            schemaVersion: 1,
            status: "retained",
            reason: "research approved for implementation handoff",
            observedAt: context.now,
          },
        }));
      }
      return store.update(current.id, current.revision, () => nextTask);
    });
    await this.#accounting.recordTerminalTransition(approved);
    return approved;
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

  async trace(id: string): Promise<TaskTrace> {
    const task = await this.get(assertTaskId(id));
    if (!(await this.#source.taskInScope(task))) {
      throw new Error(`task ${task.id} is outside the repository scope`);
    }
    return this.traceOf(task);
  }

  async traceSummary(): Promise<TraceSummary> {
    const traces = await Promise.all((await this.list()).map((task) => this.traceOf(task)));
    return summarizeRollups(traces.map((trace) => trace.rollup));
  }

  async report(options: Readonly<{ readonly since?: IsoTimestamp }> = {}): Promise<ReportView> {
    const { since } = options;
    const sinceMs = since === undefined ? undefined : Date.parse(since);
    if (sinceMs !== undefined && !Number.isFinite(sinceMs)) {
      throw new Error(`report since must be an ISO timestamp; received ${JSON.stringify(since)}`);
    }
    const tasks = (await this.list()).filter(
      (task) => sinceMs === undefined || Date.parse(task.createdAt) >= sinceMs,
    );
    const now = this.#deps.clock();
    const usageByRequest = new Map<string, RequestUsageReadout>();
    const reports: ReportTask[] = [];
    let unreadableEvents = 0;
    for (const task of tasks) {
      const timeline = await readTimeline(this.#deps.home, task.id);
      unreadableEvents += timeline.unreadableEvents;
      // Tasks sharing a request share one readout; a task no request governs reads its own scope.
      let usage = task.requestId === undefined ? undefined : usageByRequest.get(task.requestId);
      if (usage === undefined) {
        usage = await readTaskUsage(this.#deps.usageLedger, task);
        if (task.requestId !== undefined) usageByRequest.set(task.requestId, usage);
      }
      reports.push(buildTaskReport({ task, timeline, usage, now }));
    }
    return buildReportView({
      tasks: reports,
      generatedAt: now,
      ...(since === undefined ? {} : { since }),
      scopeLabel: reportScopeLabel(
        await this.#source.repositoryScope(),
        tasks.map((task) => task.repoPath),
      ),
      unreadableEvents,
    });
  }

  private async traceOf(task: TaskRecord): Promise<TaskTrace> {
    const timeline = await readTimeline(this.#deps.home, task.id);
    const cost = taskCost(await readTaskUsage(this.#deps.usageLedger, task), task.id);
    return {
      ...timeline,
      rollup: taskRollup(task.id, timeline.events, this.#deps.clock(), cost),
    };
  }

  async deliveryPreflight(id: string, base: string): Promise<DeliveryPreflightResult> {
    return deliveryPreflight(this.#deps, await this.get(assertTaskId(id)), base);
  }

  async resume(id: string): Promise<TaskRecord> {
    return this.#control.resumeTask(assertTaskId(id), "The user resumed it.");
  }
  async restart(id: string): Promise<TaskRecord> {
    const taskId = assertTaskId(id);
    const task = await this.get(taskId);
    return this.#control.restartTask(task.id);
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
      await this.answerTaskQuestion(taskId, questionId, answer);
      return this.messages(taskId);
    }
    const result = await this.#source.appendAnswer(taskId, questionId, answer);
    if (result.resumed) await this.#control.resumeTask(taskId, QUESTION_ANSWERED);
    return this.messages(taskId);
  }

  /** Answers the question the task itself is waiting on. */
  private async answerTaskQuestion(
    taskId: string,
    questionId: string,
    answer: string,
  ): Promise<void> {
    // A recovery question's answer is a recovery decision, never a worker instruction: it must
    // never bump task.communication.revision, so neither path here goes through appendAnswer.
    if (questionId.startsWith(RESTART_QUESTION_ID_PREFIX)) {
      await this.#recoveryCentral.answerRestartQuestion(taskId, questionId, answer);
      return;
    }
    if (questionId.startsWith(VALIDATION_RETRY_QUESTION_ID_PREFIX)) {
      await this.#recoveryCentral.answerValidationRetryQuestion(taskId, questionId, answer);
      return;
    }
    if (questionId.startsWith(KEEP_FIXING_QUESTION_ID_PREFIX)) {
      await this.answerKeepFixing(taskId, questionId, answer);
      return;
    }
    const result = await this.#source.appendAnswer(taskId, questionId, answer);
    if (!result.resumed) return;
    const resumed = await this.#control.resumeTask(taskId, QUESTION_ANSWERED);
    if (["validating", "reviewing", "awaiting-fixes"].includes(resumed.stage)) {
      await this.reconcileTask(resumed);
    }
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
    const resumed = await this.#control.resumeTask(taskId, "The user chose to keep fixing.");
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
    this.#drafts.published(prepared.task);
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
    const discard = input.discard === true;
    if (discard && input.destructiveApproval !== true) {
      throw new Error("destructive cleanup requires explicit destructiveApproval=true");
    }
    if (task.kind === "scout") {
      if (discard) throw new Error("scout research cleanup never discards an unproven worktree");
      const stopped = await this.#deps.store.exclusive(async (store) => {
        const current = await store.read(task.id);
        if (current?.kind !== "scout") throw new Error(`Research task ${task.id} is unavailable`);
        const interview = researchInterviewFor(current);
        if (interview?.status === "approved") {
          throw new Error(
            `Research task ${task.id} was approved for implementation and cannot be stopped`,
          );
        }
        const terminalScout = current.stage === "completed" || current.stage === "cancelled";
        const closedInterview =
          terminalScout && interview?.status === "open"
            ? finishResearchInterview(interview, "stopped", this.#deps.clock())
            : undefined;
        const quarantined = current.cleanup?.status === "quarantined";
        const needsCleanupRecord =
          terminalScout &&
          !quarantined &&
          (current.cleanup === undefined || current.cleanup.status === "retained");
        if (closedInterview === undefined && !needsCleanupRecord) return current;
        const stoppedAt = this.#deps.clock();
        const stopped = await store.update(current.id, current.revision, (latest) => ({
          ...latest,
          revision: latest.revision + 1,
          updatedAt: stoppedAt,
          ...(closedInterview === undefined ? {} : { researchInterview: closedInterview }),
          cleanup:
            current.cleanup?.status === "quarantined"
              ? current.cleanup
              : {
                  schemaVersion: 1,
                  status: "pending",
                  reason: "research stop is awaiting terminal and workspace cleanup proof",
                  observedAt: stoppedAt,
                },
        }));
        return stopped;
      });
      if (stopped.cleanup?.status === "quarantined") return stopped;
      await this.closeSettledPresentationPanes(task.id);
      const outcome = await this.cleanupTerminalTask(stopped);
      if (outcome.status === "deferred") {
        await this.#deps.store.exclusive(async (store) => {
          const current = await store.read(stopped.id);
          const cleanup = current?.kind === "scout" ? current.cleanup : undefined;
          if (current === undefined || cleanup?.status !== "pending") return;
          const observedAt = this.#deps.clock();
          await store.update(current.id, current.revision, (latest) => ({
            ...latest,
            revision: latest.revision + 1,
            updatedAt: observedAt,
            cleanup: { ...cleanup, reason: outcome.reason, observedAt },
          }));
        });
      }
      return (await this.#deps.store.read(task.id)) ?? stopped;
    }
    const runtime = await this.runtimeFor(task.id);
    if (runtime === undefined) throw new Error(`Task ${task.id} has no durable runtime metadata`);
    if (runtime.endpointLaunch !== undefined) {
      throw new Error(`cannot clean task ${task.id} while endpoint startup is unresolved`);
    }
    if (runtime.jobs.some(activeRuntimeJob)) {
      throw new Error(`cannot clean task ${task.id} while a worker launch is in progress`);
    }
    await this.closeTaskPanes(task, runtime, discard);
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
      taskCheckoutPath(task),
      runtime.worktree?.path,
    );
    if (cleanupFailure !== undefined) await this.setRuntimeError(task.id, cleanupFailure);
    if (runtime.worktree !== undefined) {
      await releaseWorktree(this.#deps.run, {
        repo: taskCheckoutPath(task),
        lease: runtime.worktree,
        childWorkerStopped: true,
        ...(discard ? { discard: true, destructiveApproval: true } : {}),
      });
    }
    await this.removeRuntimeResources(task.id);
    return task;
  }

  /** Asks each worker to exit, then closes its pane and any settled presentation pane. */
  private async closeTaskPanes(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    discard: boolean,
  ): Promise<void> {
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
    for (const endpoint of runtime.endpoints) {
      try {
        await closeEndpoint(this.#deps.run, { endpoint, cwd, force: discard });
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
      }
    }
    await this.closeSettledPresentationPanes(task.id);
  }

  private async closeSettledPresentationPanes(taskId: string): Promise<void> {
    // ponytail: only the retired presentation worker had its own pane. A finished one holds
    // nothing its artifact file doesn't, so it closes even with its process still running.
    for (const presentation of (await this.readState()).presentations) {
      if (
        presentation.taskId !== taskId ||
        presentation.endpoint === undefined ||
        presentation.job === undefined ||
        activeRuntimeJob(presentation.job)
      ) {
        continue;
      }
      try {
        await closeEndpoint(this.#deps.run, {
          endpoint: presentation.endpoint,
          cwd: presentation.job.cwd,
          force: true,
        });
      } catch (error) {
        if (!isMissingEndpoint(error)) throw error;
      }
    }
  }

  /**
   * Asks the research task's own agent to draw a visual in its pane. Tandem opens it in Lavish when
   * the agent's turn ends, and the user's comments there go back to the same agent.
   */
  async present(
    id: string,
    input: { readonly objective: string; readonly artifacts: readonly string[] },
  ): Promise<PresentationRecord> {
    if (!isRecord(input)) throw new TypeError("presentation input must be an object");
    const task = await this.get(id);
    if (task.kind !== "scout") {
      throw new Error(
        `Task ${task.id} is not research. Visuals come from a research task's agent; start research on the question and ask it for the visual.`,
      );
    }
    if (task.stage !== "scouting" && task.stage !== "completed") {
      throw new Error(`Task ${task.id} is ${task.stage}, so its research agent can't draw now.`);
    }
    const agent = presentationAgentFor(await this.readState(), task.id);
    if (agent === undefined) {
      throw new Error(
        `Task ${task.id}'s research agent has closed, so it can't draw. Start research on the question and ask that task for the visual.`,
      );
    }
    const presentationId = singleLine(this.#deps.idFactory(), "presentation id");
    const record = await preparePresentation({
      task,
      id: presentationId,
      requestId: singleLine(this.#deps.idFactory(), "presentation request id"),
      directory: join(this.#deps.home, "presentations", presentationId),
      objective: text(input.objective, "objective"),
      artifacts: assertArtifacts(input.artifacts),
      agent,
      now: this.#deps.clock(),
      ...(this.#deps.workerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#deps.workerTimeoutMs }),
      run: this.#deps.run,
    });
    const recordPath = join(record.cwd, "record.json");
    await writeJsonAtomically(recordPath, record);
    const runtime: RuntimePresentation = {
      schemaVersion: 1,
      id: record.id,
      taskId: task.id,
      recordPath,
    };
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) => {
      if (presentationRuntime(state, record.id) !== undefined) {
        throw new Error(`presentation ${record.id} already exists`);
      }
      return { ...state, presentations: [...state.presentations, runtime] };
    });
    await this.#presentationRuntime.reconcilePresentation(runtime);
    return this.readPresentation(record.id);
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
    const prWatch = this.#prWatch.settle();
    const inFlight = [...(tick === undefined ? [] : [tick]), presentation, prWatch];
    const shutdown = Promise.allSettled(inFlight).then(() => undefined);
    this.#shutdownPromise = shutdown;
    await shutdown;
  }

  private async advance(): Promise<readonly TaskRecord[]> {
    await this.backfillRequiredStages(await this.#source.scopedTasks());
    const tasks = await this.#source.scopedTasks();
    for (const task of tasks) await this.reconcileOrBlock(task);
    await this.reconcilePresentations(new Set(tasks.map((task) => task.id)));
    const settled = await this.#source.scopedTasks();
    let draftRecorded = false;
    for (const task of settled) {
      if (
        (await this.#drafts.openWhenReady(task)) ||
        (await this.#drafts.pushWhenReady(task)) ||
        (await this.#drafts.refresh(task))
      ) {
        draftRecorded = true;
      }
    }
    const current = draftRecorded ? await this.#source.scopedTasks() : settled;
    await this.#accounting.recordSettledTasks(current);
    await this.pruneFinishedTranscripts(current);
    // Not awaited: reading GitHub takes seconds and must not hold up task work.
    void this.#prWatch.tick().catch((error: unknown) => this.recordPrWatchFailure(error));
    return current;
  }

  /** Pruning never holds up task work; a failure is recorded and the next tick retries. */
  private async pruneFinishedTranscripts(tasks: readonly TaskRecord[]): Promise<void> {
    try {
      await pruneTranscripts(this.#deps.home, transcriptsToPrune(tasks, this.#deps.clock()));
    } catch (error) {
      await appendDiagnosticEvent(
        this.#deps.home,
        { event: "transcript-prune-failed", details: { errorClass: errorClassName(error) } },
        this.#deps.clock,
      );
    }
  }

  /** PR watch never holds up task work; a failed check is recorded and the next one retries. */
  private async recordPrWatchFailure(error: unknown): Promise<void> {
    await appendDiagnosticEvent(
      this.#deps.home,
      { event: "pr-watch-failed", details: { errorClass: errorClassName(error) } },
      this.#deps.clock,
    );
  }

  /**
   * PR watch steers a task only from the coordinator whose project the task belongs to, which
   * also runs its workers; anywhere else it answers false and a later check tries again.
   */
  private async steerForPrWatch(taskId: string, text: string): Promise<boolean> {
    if (this.#deps.sourceWorkspace === undefined) return false;
    const task = await this.#deps.store.read(taskId);
    if (task === undefined || !(await this.#source.taskInScope(task))) return false;
    await this.steer({ taskId, text });
    return true;
  }

  /** A ready task in this project whose pull request PR watch saw merge becomes merged. */
  private async recordMergedOnGitHub(taskId: string, head: string | undefined): Promise<void> {
    const task = await this.#deps.store.read(taskId);
    if (task === undefined || !(await this.#source.taskInScope(task))) return;
    if (task.stage !== "ready" || task.pullRequest === undefined) return;
    await this.transition(task.id, {
      type: "merged-on-github",
      pullRequest: { ...task.pullRequest, state: "merged", head: head ?? task.pullRequest.head },
    });
  }

  /**
   * An implementation task that adopts the pull request, so it pushes to that branch and returns
   * straight to ready like any follow-up on an open pull request. It runs in the project when that
   * is the pull request's repository, otherwise in the pull request's repository as a target.
   */
  private async startConflictFix(
    named: NamedPullRequest,
    pr: PrObservation,
    files: readonly string[],
  ): Promise<TaskRecord> {
    const project = named.repoPath ?? this.#deps.sourceWorkspace?.repoPath;
    if (project === undefined) throw new Error("fixing conflicts needs a Tandem project to run in");
    const created = await this.create({
      repoPath: project,
      kind: "implementation",
      objective: conflictFixObjective(pr, files),
      acceptanceCriteria: [
        `${pr.url} has no merge conflicts with ${pr.base}.`,
        "The branch changes only by merging the base and resolving its conflicts.",
      ],
      surfaces: ["pull request branch"],
      ...(named.repoPath === undefined ? { targetRepo: named.ref.repo } : {}),
    });
    const adopted = await this.recordPullRequest(created.id, created.revision, {
      repository: named.ref.repo,
      number: named.ref.number,
      state: "open",
      head: pr.head,
      base: pr.base,
      url: pr.url,
      title: pr.title,
    });
    return this.approve(adopted.id);
  }

  private namedPullRequest(input: PullRequestInput): Promise<NamedPullRequest> {
    if (!isRecord(input)) throw new TypeError("pull request input must be an object");
    return resolvePullRequest(
      this.#deps.run,
      singleLine(input.pullRequest, "pullRequest"),
      input.repoPath ?? this.#deps.sourceWorkspace?.repoPath,
    );
  }

  /**
   * Reconciles one task; a failure blocks it only while the operation claim seen beforehand still
   * holds. Without that snapshot, ownership is uncertain and the task is left alone.
   */
  private async reconcileOrBlock(task: TaskRecord): Promise<void> {
    let capturedRuntime: RuntimeTaskState | undefined;
    let captureSucceeded = false;
    try {
      capturedRuntime = await this.runtimeFor(task.id);
      captureSucceeded = true;
    } catch {
      // Handled below: no block without a snapshot.
    }
    try {
      await this.reconcileTask(task);
    } catch (error) {
      if (!captureSucceeded) return;
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

  private async reconcilePresentations(scopedTaskIds: ReadonlySet<string>): Promise<void> {
    const state = await this.readState();
    for (const presentation of state.presentations) {
      if (!scopedTaskIds.has(presentation.taskId)) continue;
      try {
        await this.#presentationRuntime.reconcilePresentation(presentation);
      } catch (error) {
        await this.#presentationRuntime.failPresentation(presentation.id, describeError(error));
      }
    }
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
    const claim = claimOf(capturedRuntime?.operation);
    const { reservation } = options;
    await this.blockUnchangedTask(
      capturedTask,
      { reason, cause: options.cause },
      {
        matches: (current) =>
          ownsOperation(current?.operation, claim) &&
          (reservation === undefined || sameReservationIdentity(current?.reservation, reservation)),
        ...(options.runtimeError === true
          ? { update: (current) => ({ ...current, lastError: reason }) }
          : {}),
      },
    );
  }

  private async quarantineLegacyReservation(
    capturedTask: TaskRecord,
    reservation: DurableReservation,
    cause: BlockCause,
  ): Promise<void> {
    const reason = cause.detail;
    await this.blockUnchangedTask(
      capturedTask,
      { reason, cause },
      {
        matches: (current) =>
          current?.operation === undefined &&
          sameReservationIdentity(current?.reservation, reservation),
        update: (current) => ({
          ...current,
          lastError: reason,
          legacyQuarantine: {
            schemaVersion: 1,
            reservationId: reservation.id,
            reason,
            observedAt: this.#deps.clock(),
          },
        }),
      },
    );
  }

  /**
   * Blocks a task only while its record and runtime are still what the scheduler decided from, so
   * a decision made on a stale snapshot never overrides newer work. `reason` is kept raw in
   * `lastError` by `update`; the block itself prefers the cause's user-facing summary.
   */
  private async blockUnchangedTask(
    capturedTask: TaskRecord,
    block: Readonly<{ reason: string; cause: BlockCause | undefined }>,
    runtime: Readonly<{
      matches: (current: RuntimeTaskState | undefined) => boolean;
      update?: (current: RuntimeTaskState) => RuntimeTaskState;
    }>,
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
        if (!runtime.matches(currentRuntime)) return;
        if (runtime.update !== undefined && currentRuntime !== undefined) {
          await writeRuntimeState(
            this.#deps.runtimePath,
            replaceRuntimeTask(state, capturedTask.id, runtime.update),
          );
        }
        if (alreadyStopped(currentTask)) return;
        const { cause } = block;
        await store.update(currentTask.id, currentTask.revision, (task) =>
          transitionTask(
            task,
            {
              type: "block",
              reason: text(cause?.summary ?? block.reason, "block reason"),
              ...(cause === undefined ? {} : { cause }),
            },
            this.context(),
          ),
        );
      });
    });
  }

  /** Whether the request's approved brief says its work needs no code review. */
  private async briefSkipsReview(requestId: string): Promise<boolean> {
    const brief = await this.#deps.requestStore.read(requestId);
    return brief !== undefined && briefSkipsReview(brief);
  }

  /**
   * Approving a brief can change whether its work is reviewed, so the tasks already created under
   * it record their required stages again.
   */
  private async approveRequestBrief(intent: ApproveRequestBriefInput): Promise<RequestBriefView> {
    const view = await this.#requests.approve(intent);
    const governed = (await this.#source.scopedTasks()).filter(
      (task) =>
        task.requestId === view.record.id && task.kind === "implementation" && isActiveTask(task),
    );
    await this.recordRequiredStages(governed, briefSkipsReview(view.record));
    return view;
  }

  /** Records required stages on active implementation tasks saved before they existed. */
  private async backfillRequiredStages(tasks: readonly TaskRecord[]): Promise<void> {
    for (const task of tasks) {
      if (task.kind !== "implementation" || task.requiredStages !== undefined) continue;
      if (!isActiveTask(task)) continue;
      const skips = task.requestId !== undefined && (await this.briefSkipsReview(task.requestId));
      await this.recordRequiredStages([task], skips);
    }
  }

  private async recordRequiredStages(
    tasks: readonly TaskRecord[],
    briefSkips: boolean,
  ): Promise<void> {
    for (const task of tasks) {
      const requiredStages = decideRequiredStages({
        briefSkipsReview: briefSkips,
        pullRequestPublished: pullRequestPublished(task),
      });
      const recorded = task.requiredStages;
      if (
        recorded?.validation === requiredStages.validation &&
        recorded.review === requiredStages.review
      ) {
        continue;
      }
      await this.updateTask(task.id, (current) => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: this.#deps.clock(),
        requiredStages,
      }));
    }
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
    await this.#accounting.record([requestIntakeEvent(view.record)]);
    return view;
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
    const held = heldTaskStep(task, loadedRuntime);
    if (held !== undefined) {
      await this.runHeldTaskStep(task, loadedRuntime, held);
      return;
    }
    const runtime = await this.settleOwnership(task, loadedRuntime);
    if (runtime === undefined) return;
    await this.runLiveTaskStep(task, runtime, liveTaskStep(task, runtime));
  }

  private async runHeldTaskStep(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    step: HeldTaskStep,
  ): Promise<void> {
    switch (step.kind) {
      case "settle-stop-request":
        // Settling clears the stop request, so its discard approval was read first. A crash in
        // between loses it and keeps the worktree, which is the safe side.
        await this.#control.reconcileStopRequest(task, runtime);
        await this.cleanupSettledTask(task.id, { discard: step.discard });
        return;
      case "release-terminal-resources":
        await this.cleanupTerminalTask(task);
        return;
      case "recover-blocked":
        await this.#recoveryCentral.recoverBlockedTask(task);
        return;
      case "wait":
        return;
    }
  }

  /**
   * Takes over an operation another coordinator claimed and resolves an unfinished endpoint
   * launch. Undefined means the launch could not be resolved this pass.
   */
  private async settleOwnership(
    task: TaskRecord,
    loaded: RuntimeTaskState,
  ): Promise<RuntimeTaskState | undefined> {
    let runtime = loaded;
    if (
      runtime.operation !== undefined &&
      runtime.operation.claimOwner !== this.#worker.claimOwner
    ) {
      const claimed = await this.#worker.claimOperation(task.id);
      if (claimed !== undefined) runtime = claimed;
    }
    if (runtime.endpointLaunch !== undefined && currentWriter(runtime) === undefined) {
      return this.#control.reconcileEndpointLaunch(task, runtime);
    }
    return runtime;
  }

  private async runLiveTaskStep(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    step: LiveTaskStep,
  ): Promise<void> {
    switch (step.kind) {
      case "reconcile-job":
        await this.#worker.reconcileJob(task, runtime, step.job);
        await this.cleanupSettledTask(task.id);
        return;
      case "quarantine-legacy-reservation":
        await this.quarantineLegacyReservation(task, step.reservation, step.cause);
        return;
      case "block-claimed":
        await this.blockTaskIfReconcileClaim(task, runtime, step.cause.detail, {
          runtimeError: true,
          reservation: step.reservation,
          cause: step.cause,
        });
        return;
      case "reconcile-operation":
        await this.#worker.reconcileOperation(task, runtime);
        return;
      case "start-queued":
        await this.#worker.startQueuedTask(task);
        return;
      case "begin-fixes":
        // beginFixes admits the fix round and transitions the task to `implementing` before it ever
        // touches a pane; if the carried-forward pane turns out to be gone, it leaves the task there
        // unblocked rather than blocking, so the `implementing` step's central recovery picks it up
        // on the next tick (see src/recovery/central.ts).
        await this.#worker.beginFixes(task);
        return;
      case "validate": {
        // A validation job that died for an infrastructure reason settles without blocking (see
        // WorkerWorkflow.reconcileJob's validation branches), leaving the task at `validating` with
        // no active job/reservation and a terminal failed job behind it. Central recovery owns the
        // stop/save/re-entry decision for that shape; it reports `skipped` for a fresh entry (no
        // dead job) so the normal startValidation path runs unchanged.
        const recovered = await this.#recoveryCentral.recoverStuckWorker(task);
        if (recovered.action === "skipped") await this.#worker.startValidation(task);
        return;
      }
      case "advance-review": {
        // A resumed reviewing task can carry a quarantined (proven-unowned) reviewer/verifier job
        // left over from before it was blocked. Central recovery owns the stop/save/re-entry
        // decision for that case, exactly as it does for implementing/scouting; "skipped" means
        // nothing needs recovery, so review advances normally.
        const recovered = await this.#recoveryCentral.recoverStuckWorker(task);
        if (recovered.action === "skipped") await this.#worker.advanceReview(task);
        return;
      }
      case "block":
        await reportBlock(
          (id, reason, cause) => this.blockTask(id, reason, cause),
          task.id,
          step.cause,
        );
        return;
      case "recover-stuck-writer":
        await this.#recoveryCentral.recoverStuckWorker(task);
        return;
      case "launch-writer":
        await this.launchWriter(task);
        return;
      case "wait":
        return;
    }
  }

  private async launchWriter(task: TaskRecord): Promise<void> {
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
  }

  private async recordPoolResult(taskId: string, result: PoolMaintenanceResult): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const task = await store.read(taskId);
      if (task === undefined || !(await this.#source.taskInScope(task))) return;
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = taskRuntime(state, taskId);
      const change = taskWithPoolAdmission(task, runtime, result, {
        clock: this.#deps.clock,
        notificationId: () => singleLine(this.#deps.idFactory(), "pool notification id"),
      });
      if (change.task !== task) {
        await store.update(task.id, task.revision, () => change.task, change.note);
      }
      if (runtime !== undefined) {
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(state, taskId, (current) => runtimeWithPoolAdmission(current, result)),
        );
      }
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
        retainIdle: WARM_IDLE_COPIES,
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
  ): Promise<TaskCleanupOutcome> {
    return releaseTerminalTaskResources(
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
    await this.#accounting.recordTerminalTransition(next);
    return next;
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
    if (alreadyStopped(task)) return task;
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
  private async removeRuntimeResources(taskId: string): Promise<void> {
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
  const classifyPlaybook = options.classifyPlaybook ?? (async () => "general" as const);
  if (typeof classifyPlaybook !== "function") {
    throw new TypeError("classifyPlaybook must be a function");
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
    classifyPlaybook,
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
    projectRoots:
      options.projectRoots === undefined
        ? () => projectRoots(home, process.env)
        : async () => options.projectRoots ?? [],
    personalSkillsHome: options.personalSkillsHome ?? homedir(),
    checkIssueDraft:
      options.checkIssueDraft ??
      issueDraftChecker({ timeoutMs: DEFAULT_RESEARCH_CONTINUATION_TIMEOUT_MS }),
  };
}

export function createTandemService(options: TandemServiceOptions): TandemService {
  return new TandemController(serviceDependencies(options)).api();
}
