import type { PrReviewState } from "./pr-review/state.ts";

export const MODEL_ROLE_ORDER = [
  "coordinator",
  "scout",
  "implementer",
  "reviewer",
  "presentation",
] as const;

export type AgentRole = (typeof MODEL_ROLE_ORDER)[number];

export const MODEL_ROLE_LABELS: Readonly<Record<AgentRole, string>> = {
  coordinator: "Planning",
  scout: "Research",
  implementer: "Coding",
  reviewer: "Review",
  presentation: "Presentations",
};

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && MODEL_ROLE_ORDER.includes(value as AgentRole);
}

export type TaskKind = "scout" | "implementation" | "pr-review";

/** Kinds the generic create action starts; a PR review starts through its own action. */
export type CreatableTaskKind = Exclude<TaskKind, "pr-review">;

export type TaskStage =
  | "awaiting-approval"
  | "queued"
  | "scouting"
  | "implementing"
  | "validating"
  | "reviewing"
  | "awaiting-fixes"
  | "ready"
  | "paused"
  | "blocked"
  | "cancelled"
  | "completed"
  | "merged";
export type TaskMessage = Readonly<{
  readonly id: string;
  readonly revision: number;
  readonly kind: "instruction" | "answer";
  readonly text: string;
  readonly createdAt: IsoTimestamp;
  readonly supersedes?: readonly string[];
  readonly replyTo?: string;
}>;

export type TaskQuestion = Readonly<{
  readonly id: string;
  readonly text: string;
  readonly recommendation?: string;
}>;

export type TaskCommunication = Readonly<{
  readonly revision: number;
  readonly messages: readonly TaskMessage[];
  readonly question?: TaskQuestion;
}>;

export type TaskInbox = Readonly<{
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly revision: number;
  readonly messages: readonly TaskMessage[];
}>;

export type WorkerReceipt = Readonly<{
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly receivedRevision: number;
  readonly appliedRevision: number;
  readonly heartbeatAt: IsoTimestamp;
  readonly progressAt: IsoTimestamp;
  readonly phase: "starting" | "model" | "tool" | "idle" | "finished";
  readonly tool?: string;
}>;

export type TaskCommunicationView = Readonly<{
  readonly taskId: string;
  readonly stage: TaskStage;
  readonly revision: number;
  readonly messages: readonly (TaskMessage & {
    readonly status: "pending" | "received" | "applied" | "superseded";
  })[];
  readonly question?: TaskQuestion;
  readonly activity?: WorkerReceipt;
  readonly presentationAnswer?: Readonly<{
    readonly presentationId: string;
    readonly questionId: string;
    readonly status: "queued";
  }>;
}>;

export type SteerTaskInput = Readonly<{
  readonly taskId: string;
  readonly text: string;
  readonly supersedes?: readonly string[];
}>;

export type AnswerTaskInput = Readonly<{
  readonly taskId: string;
  readonly questionId: string;
  readonly text: string;
}>;

export type IsoTimestamp = string;

export type InstructionChannel = "implementation" | "validation" | "review";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModelSpec = {
  readonly model: string;
  readonly thinking: ThinkingLevel;
};

export type InstructionChannels = Readonly<Record<InstructionChannel, readonly string[]>>;

export type ValidationCommand = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly surfaces: readonly string[];
  readonly timeoutMs: number;
};

/** A command that prepares a fresh worktree (e.g. installs dependencies) before anything runs in it. */
export type SetupCommand = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
};

/** How much review scrutiny a change is classified for, ordered from least to most. */
export const REVIEW_LEVEL_ORDER = ["light", "standard", "deep"] as const;

export type ReviewLevel = (typeof REVIEW_LEVEL_ORDER)[number];

/**
 * Change kinds that always force at least their own documented level, whatever the rest of the
 * diff shows. A floor is fixed: no classifier input, helper, or policy setting can lower it.
 */
export const SAFETY_FLOOR_ORDER = [
  "permissions-security",
  "data-integrity",
  "shared-contracts-concurrency",
  "dependency-build-infra",
] as const;

export type SafetyFloor = (typeof SAFETY_FLOOR_ORDER)[number];

/**
 * A depth recommendation a helper offered for the same change. In shadow mode it is recorded
 * beside the deterministic level for later comparison and never becomes the level that is used.
 */
export type ReviewLevelAssistance = {
  readonly mode: "shadow";
  readonly recommendation: ReviewLevel | "unavailable";
  readonly reason: string;
  readonly requestIdentity: string;
  readonly resultIdentity: string;
};

/** The durable classification of a task's change, with the reason and floors that produced it. */
export type ReviewLevelRecord = {
  readonly level: ReviewLevel;
  readonly reason: string;
  readonly floors: readonly SafetyFloor[];
  readonly assistance?: ReviewLevelAssistance;
};

/**
 * Repository settings that decide whether a review level may change what actually runs. Every
 * field defaults to the value that reproduces the review behavior Tandem had before levels
 * existed, so a repository only opts in deliberately.
 */
export type ReviewLevelPolicy = {
  readonly deepScrutiny: boolean;
  readonly jevAssistance: "off" | "shadow";
  readonly sourceTransmission: boolean;
};

export type RepoPolicy = {
  readonly version: 1;
  readonly models: Readonly<Record<AgentRole, ModelSpec>>;
  readonly instructions: InstructionChannels;
  readonly instructionFiles: InstructionChannels;
  readonly validationCommands: readonly ValidationCommand[];
  readonly setupCommands: readonly SetupCommand[];
  readonly maxWorkers: number;
  readonly maxFixRounds: number;
  readonly reviewLevels: ReviewLevelPolicy;
};

export type GuidanceProvenance = {
  readonly channel: InstructionChannel;
  readonly source: string;
};

export type ResolvedGuidance = {
  readonly text: string;
  readonly provenance: GuidanceProvenance;
};

export type ResolvedPolicy = {
  readonly config: RepoPolicy;
  readonly guidance: Readonly<Record<InstructionChannel, readonly ResolvedGuidance[]>>;
};

/**
 * ponytail: legacy panes, jobs, and operations may still carry role "verifier" from before the
 * verifier role was removed; only for decode allow-lists and `Endpoint.role`, never for new work.
 */
export const LEGACY_ENDPOINT_ROLES = [...MODEL_ROLE_ORDER, "verifier"] as const;

export type Endpoint = {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly role: (typeof LEGACY_ENDPOINT_ROLES)[number];
  readonly generation: number;
};

export type WorktreeLease = {
  readonly root: string;
  readonly path: string;
  readonly name: string;
  readonly baseHead: string;
  readonly branch: string;
  readonly leaseId: string;
  readonly leaseHolder: string;
  readonly leasedAt: IsoTimestamp;
};

export type FindingSeverity = "P0" | "P1" | "P2" | "P3";

export type FindingVerdict = "confirmed" | "plausible";
/** One reviewer session per round covers behavior, design, and coverage together. */
export type ReviewLens = "review";

/**
 * ponytail: legacy stored reviews and findings may still carry these pre-merge lens names; only
 * for decode allow-lists, since a review under one no longer counts toward the current requirement.
 */
export const LEGACY_REVIEW_LENSES = ["behavior", "design", "coverage", "verification"] as const;

/** A lens value a stored review, finding, or durable job may carry: current or legacy. */
export type StoredReviewLens = ReviewLens | (typeof LEGACY_REVIEW_LENSES)[number];

/** Every lens value old stored reviews may carry, forward and legacy; decode allow-lists only. */
export const ALL_REVIEW_LENSES: readonly StoredReviewLens[] = ["review", ...LEGACY_REVIEW_LENSES];
export type ReviewMode = "review_changed_diff" | "review_existing_head";

export type Finding = {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly verdict: FindingVerdict;
  readonly file?: string;
  readonly line?: number;
  readonly description: string;
};

/** Where a finding status was established: the reviewed code and the fix round that observed it. */
export type FindingObservation = {
  readonly head: string;
  readonly generation: number;
  readonly reviewRound: number;
};

/**
 * What a finding identity is currently known to be. `addressed` means a later review of the same
 * lens stopped reporting it, `regressed` means an addressed identity came back, and `disputed`
 * means two reviews of the same identity recorded contradicting verdicts.
 */
export type FindingStatus = "addressed" | "unresolved" | "regressed" | "disputed";

/**
 * Fix rounds added on top of the pinned `maxFixRounds`, recorded beside the policy rather than in
 * it: `user` when the person answered "Keep fixing?" with yes, `no-commit` when a fix round ended
 * without a new commit and so did not spend the budget. `generation` is the task generation the
 * grant was recorded at.
 */
export type FixRoundGrant = {
  readonly generation: number;
  readonly rounds: number;
  readonly reason: "user" | "no-commit";
};

/** One finding identity carried across review rounds, with the change supporting its status. */
export type FindingLedgerEntry = {
  readonly id: string;
  readonly lens: StoredReviewLens;
  readonly severity: FindingSeverity;
  readonly verdict: FindingVerdict;
  readonly description: string;
  readonly file?: string;
  readonly line?: number;
  readonly status: FindingStatus;
  readonly raisedAt: FindingObservation;
  readonly statusAt: FindingObservation;
};

export type ReviewResult = {
  readonly lens: StoredReviewLens;
  readonly head: string;
  readonly generation: number;
  readonly pass: boolean;
  readonly findings: readonly Finding[];
  readonly summary: string;
  readonly mode?: ReviewMode;
};

/** Names the two validation contracts: targeted fix-time checks and the complete final gate. */
export type ValidationContractName = "iteration" | "final";

/** Keeps runner-owned local checks distinguishable from GitHub or other remote checks. */
export type CheckOrigin = "local" | "github";

/** The delivered code and policy a contract result is pinned to. */
export type ContractIdentity = {
  readonly head: string;
  readonly generation: number;
  readonly policyDigest: string;
};

/** What an authorized fix round targets, recorded when the round is admitted. */
export type IterationScope = {
  readonly head: string;
  readonly generation: number;
  readonly policyDigest: string;
  readonly reproduces: readonly string[];
  readonly surfaces: readonly string[];
  readonly findingIds: readonly string[];
};

/** Marks evidence written before validation contracts existed, so it can never prove acceptance. */
export const LEGACY_EVIDENCE_CONTRACT = "legacy";

type RecordedCheck = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly head: string;
};

/** A check recorded under a named contract and pinned to one code and policy identity. */
export type PinnedValidationEvidence = RecordedCheck & {
  readonly contract: ValidationContractName;
  readonly origin: CheckOrigin;
  readonly policyDigest: string;
};

/**
 * A check recovered from a durable record written before contracts existed. It carries no contract,
 * origin, or policy identity, so it stays readable as history and never satisfies either contract.
 */
export type LegacyValidationEvidence = RecordedCheck & {
  readonly contract: typeof LEGACY_EVIDENCE_CONTRACT;
};

export type ValidationEvidence = PinnedValidationEvidence | LegacyValidationEvidence;

/**
 * `routine` is shown to the person without waking the coordinator; `coordinator` wakes it for a
 * judgment; `receipt` marks a delivered request whose usage table is shown directly, without a turn.
 */
export type NotificationKind = "routine" | "coordinator" | "receipt";

export type Notification = {
  readonly id: string;
  readonly message: string;
  readonly acknowledged: boolean;
  readonly kind?: NotificationKind;
};

export type PullRequestMetadata = {
  readonly repository: string;
  readonly number: number;
  readonly url?: string;
  readonly title?: string;
  readonly state: "draft" | "open" | "closed" | "merged";
  readonly head: string;
  readonly base: string;
};

export const MAX_RESEARCH_HANDOFF_COUNT = 4;
export const MAX_RESEARCH_HANDOFF_EXCERPT_BYTES = 4 * 1024;
export const MAX_RESEARCH_HANDOFF_TOTAL_BYTES =
  MAX_RESEARCH_HANDOFF_COUNT * MAX_RESEARCH_HANDOFF_EXCERPT_BYTES;

export type ResearchHandoff = {
  readonly scoutTaskId: string;
  readonly scoutRepoPath: string;
  readonly scoutSourceHead: string;
  readonly scoutSourceBase: string;
  readonly reportPath: string;
  readonly reportDigest: string;
  readonly excerpt: string;
};

export const MAX_SKILL_NAME_CHARS = 100;
export const MAX_SKILL_CONTEXT_BYTES = 4 * 1024;

/**
 * An explicit, user-invoked skill pinned to a task. Tandem records its identity and carries its
 * bounded context to the intended child worker without interpreting the skill's domain semantics.
 */
export type SkillInvocation = {
  readonly name: string;
  readonly context: string;
};

export const RESEARCH_CONTINUATION_DISPOSITIONS = [
  "report-only",
  "ask-intent",
  "implementation-interview",
] as const;

/** What a completed scout should lead to; routing metadata only, never permission. */
export type ResearchContinuationDisposition = (typeof RESEARCH_CONTINUATION_DISPOSITIONS)[number];

export const RESEARCH_CONTINUATION_SELECTORS = [
  "explicit",
  "deterministic",
  "jev",
  "fallback",
] as const;

export type ResearchContinuationSelector = (typeof RESEARCH_CONTINUATION_SELECTORS)[number];

export const RESEARCH_CONTINUATION_SCHEMA_VERSION = 1;

/** Scout records created or loaded without a disposition use this conservative value. */
export const DEFAULT_RESEARCH_CONTINUATION_DISPOSITION: ResearchContinuationDisposition =
  "ask-intent";

export const MAX_CLASSIFIER_VERSION_CHARS = 100;

export type ResearchContinuation = {
  readonly schemaVersion: typeof RESEARCH_CONTINUATION_SCHEMA_VERSION;
  readonly disposition: ResearchContinuationDisposition;
  readonly selectedBy: ResearchContinuationSelector;
  readonly classifierVersion?: string;
  /** Why an unusable classifier outcome fell back; carried only when `selectedBy` is `fallback`. */
  readonly fallbackReason?: string;
};

/**
 * How far automatic release of a terminal task's child pane and worktree got, and why it stopped
 * there. `released` and `retained` are settled outcomes, `pending` is retried by reconciliation,
 * and `quarantined` waits for a human because ownership could not be proven.
 */
export type TaskCleanupStatus = "released" | "retained" | "pending" | "quarantined";

/** The durable note a cleanup attempt leaves on the task it inspected. */
export type TaskCleanupState = {
  readonly schemaVersion: 1;
  readonly status: TaskCleanupStatus;
  readonly reason: string;
  readonly observedAt: IsoTimestamp;
};

/** Marks a durable request identity so it can never be confused with a task identity. */
export const REQUEST_ID_PREFIX = "req-";

export function isSafeRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(REQUEST_ID_PREFIX) &&
    value.length > REQUEST_ID_PREFIX.length &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

export const MAX_REQUEST_BRIEF_ENTRIES = 24;
export const MAX_REQUEST_BRIEF_BYTES = 32 * 1024;

/**
 * What one brief revision says. The first eight fields carry the agreement itself; `openQuestions`
 * and `researchLinks` are annotations the coordinator keeps current without reopening approval.
 * `acceptanceCriteria` are the automated checks a validation command or code review can prove;
 * `manualVerification` are hands-on checks a person makes before merging.
 */
export type RequestBriefContent = Readonly<{
  readonly goal: string;
  readonly scope: readonly string[];
  readonly constraints: readonly string[];
  readonly nonGoals: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly manualVerification: readonly string[];
  readonly recommendedApproach: string;
  readonly keyDecisions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly researchLinks: readonly string[];
  /** The user decided while planning that this work needs no code review. Absent when not. */
  readonly skipReview?: boolean | undefined;
}>;

/** Whether a revision changed what was agreed or only annotated it. */
export type RequestBriefChangeKind = "agreement" | "annotation";

/** One immutable draft revision, digested so later content can be detected as different. */
export type RequestBriefRevision = Readonly<{
  readonly revision: number;
  readonly content: RequestBriefContent;
  readonly contentDigest: string;
  readonly agreementDigest: string;
  readonly changeKind: RequestBriefChangeKind;
  readonly recordedAt: IsoTimestamp;
}>;

/**
 * An approval bound to one exact request and draft revision. `agreementDigest` is what makes the
 * approval non-current when the agreement changes; `contentDigest` proves which bytes were shown.
 */
export type RequestBriefApproval = Readonly<{
  readonly requestId: string;
  readonly briefRevision: number;
  readonly contentDigest: string;
  readonly agreementDigest: string;
  readonly approvedAt: IsoTimestamp;
}>;

/**
 * Where the coordinator-owned temporary review pane stands. `retained` and `quarantined` mean
 * Tandem deliberately left a pane alone: `retained` is a transient refusal such as a busy pane,
 * `quarantined` is ownership Tandem could not prove and will not act on without a human.
 */
export type RequestReviewPaneStatus = "open" | "closed" | "retained" | "quarantined";

/** The durable note describing the one pane this request owns. */
export type RequestReviewPane = Readonly<{
  readonly status: RequestReviewPaneStatus;
  readonly endpoint: Endpoint;
  readonly renderedRevision: number;
  readonly renderedPath: string;
  readonly observedAt: IsoTimestamp;
  readonly reason?: string;
}>;

/**
 * The durable request-level agreement: one stable identity, a monotonic draft revision, and the
 * approval bound to it. SQLite holds this record; rendered Markdown is only a view of it.
 */
export type RequestBriefRecord = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly repoPath: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly draft: RequestBriefRevision;
  readonly history: readonly RequestBriefRevision[];
  readonly approval?: RequestBriefApproval;
  readonly reviewPane?: RequestReviewPane;
};

/**
 * The four top-level groups every block cause falls under, in order of how automatically Tandem may
 * ever act on them. `lost-resource` and `unusable-result` are the shapes central recovery can one day
 * resolve on its own; `user-decision` always needs a human choice; `safety-stop` is never automatic.
 */
export const BLOCK_CAUSE_GROUPS = [
  "lost-resource",
  "unusable-result",
  "user-decision",
  "safety-stop",
] as const;

export type BlockCauseGroup = (typeof BLOCK_CAUSE_GROUPS)[number];

/**
 * The closed set of specific block causes. Deliberately small and shared across call sites — a new
 * wording at an existing site should reuse an existing kind rather than mint another; add a kind only
 * for a genuinely new shape of blocker. `BLOCK_CAUSE_GROUP_BY_KIND` is the single place that ties a
 * kind back to its group, so the two can never drift apart.
 */
export const BLOCK_CAUSE_KINDS = [
  // lost-resource: auto-recoverable later, nothing about the task's own work is in question.
  "allocation-failed",
  "resource-lost",
  "persistence-failed",
  "transition-failed",
  "checkout-unverifiable",
  // unusable-result: the work that ran left nothing Tandem can build on or trust.
  "no-clean-checkpoint",
  "stale-review-state",
  "review-lens-failed",
  "worker-failed",
  // user-decision: durable state is fine, but only a person can choose how to proceed.
  "fix-rounds-exhausted",
  "validation-config-refused",
  "prerequisite-not-met",
  "explicit-block",
  // safety-stop: never resolved automatically, whatever the evidence later shows.
  "ownership-unprovable",
  "runtime-metadata-missing",
  "identity-mismatch",
  "quarantined-unknown-outcome",
] as const;

export type BlockCauseKind = (typeof BLOCK_CAUSE_KINDS)[number];

/** The one authority for which group a kind belongs to; nothing else re-derives this mapping. */
export const BLOCK_CAUSE_GROUP_BY_KIND: Readonly<Record<BlockCauseKind, BlockCauseGroup>> = {
  "allocation-failed": "lost-resource",
  "resource-lost": "lost-resource",
  "persistence-failed": "lost-resource",
  "transition-failed": "lost-resource",
  "checkout-unverifiable": "lost-resource",
  "no-clean-checkpoint": "unusable-result",
  "stale-review-state": "unusable-result",
  "review-lens-failed": "unusable-result",
  "worker-failed": "unusable-result",
  "fix-rounds-exhausted": "user-decision",
  "validation-config-refused": "user-decision",
  "prerequisite-not-met": "user-decision",
  "explicit-block": "user-decision",
  "ownership-unprovable": "safety-stop",
  "runtime-metadata-missing": "safety-stop",
  "identity-mismatch": "safety-stop",
  "quarantined-unknown-outcome": "safety-stop",
};

export function isBlockCauseKind(value: unknown): value is BlockCauseKind {
  return typeof value === "string" && (BLOCK_CAUSE_KINDS as readonly string[]).includes(value);
}

/**
 * Why a task is blocked, typed rather than free text. `summary` is the plain-English one-liner a
 * person reads: what happened, no task/job/pane ids in it. `detail` is internal free text — the raw
 * error, the exact site's wording — kept for diagnosis but never shown as the summary. `jobId`/
 * `paneId` identify the specific resource behind the block when the site has one, so recovery can key
 * a question or decision off the exact incident instead of hashing wording that might later change.
 */
export type BlockCause = Readonly<{
  readonly group: BlockCauseGroup;
  readonly kind: BlockCauseKind;
  readonly detail: string;
  readonly summary: string;
  readonly jobId?: string;
  readonly paneId?: string;
}>;

/** Builds a `BlockCause`, filling `group` from `kind` so the two can never disagree. */
export function blockCause(
  kind: BlockCauseKind,
  fields: Readonly<{
    readonly summary: string;
    readonly detail: string;
    readonly jobId?: string;
    readonly paneId?: string;
  }>,
): BlockCause {
  return {
    group: BLOCK_CAUSE_GROUP_BY_KIND[kind],
    kind,
    summary: fields.summary,
    detail: fields.detail,
    ...(fields.jobId === undefined ? {} : { jobId: fields.jobId }),
    ...(fields.paneId === undefined ? {} : { paneId: fields.paneId }),
  };
}

export type TaskRecord = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly repoPath: string;
  /** The request brief this task was created under, when one governs it. */
  readonly requestId?: string;
  readonly kind: TaskKind;
  readonly objective: string;
  /** Automated checks: what validation or code review can prove. */
  readonly acceptanceCriteria: readonly string[];
  /** Hands-on checks a person makes before merging; reviewers never judge these. Absent when none. */
  readonly manualVerification?: readonly string[];
  readonly surfaces: readonly string[];
  readonly stage: TaskStage;
  readonly previousStage?: TaskStage;
  readonly scopeApproved: boolean;
  readonly policy: ResolvedPolicy;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly worktree?: WorktreeLease;
  readonly endpoints?: readonly Endpoint[];
  readonly generation: number;
  readonly reviewRound: number;
  readonly fixRoundGrants?: readonly FixRoundGrant[];
  readonly reviewHead?: string;
  /** The HEAD the user published without finishing review ("publish now"). Absent otherwise. */
  readonly reviewSkippedHead?: string;
  readonly iterationScope?: IterationScope;
  readonly reviewLevel?: ReviewLevelRecord;
  readonly reportPath?: string;
  readonly validationEvidence: readonly ValidationEvidence[];
  readonly reviews: readonly ReviewResult[];
  readonly findingLedger?: readonly FindingLedgerEntry[];
  readonly researchHandoffs?: readonly ResearchHandoff[];
  readonly researchContinuation?: ResearchContinuation;
  readonly skill?: SkillInvocation;
  readonly blockReason?: string;
  /** Typed cause behind `blockReason`, when the site that blocked the task recorded one. Old records
   *  and sites not yet migrated to a typed cause carry `blockReason` alone. */
  readonly blockCause?: BlockCause;
  readonly notifications: readonly Notification[];
  readonly communication?: TaskCommunication;
  readonly pullRequest?: PullRequestMetadata;
  readonly cleanup?: TaskCleanupState;
  /** The pull request a `pr-review` task reviews; present on exactly those tasks. */
  readonly prReview?: PrReviewState;
  /** The other repository this task works in; absent when it works in the coordinator's own. */
  readonly target?: TaskTarget;
};

/**
 * Another repository a coordinator's task works in. `repoPath` stays the coordinator's project, so
 * ownership and scope are unchanged; git work happens in `checkout`.
 */
export type TaskTarget = {
  /** GitHub `owner/repo`. */
  readonly repo: string;
  /** The user's checkout of it, where task worktrees come from. */
  readonly checkout: string;
  /** The default branch the source commit was pinned from; pull requests target it. */
  readonly branch: string;
};

export type CommandRequest = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
};

export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

export type Clock = () => IsoTimestamp;

export type IdFactory = () => string;
