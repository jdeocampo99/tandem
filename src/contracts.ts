export const MODEL_ROLE_ORDER = [
  "coordinator",
  "scout",
  "implementer",
  "reviewer",
  "verifier",
  "presentation",
] as const;

export type AgentRole = (typeof MODEL_ROLE_ORDER)[number];

export const MODEL_ROLE_LABELS: Readonly<Record<AgentRole, string>> = {
  coordinator: "Planning",
  scout: "Research",
  implementer: "Coding",
  reviewer: "Review",
  verifier: "Final checks",
  presentation: "Presentations",
};

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && MODEL_ROLE_ORDER.includes(value as AgentRole);
}

export type TaskKind = "scout" | "implementation";

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

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "auto";

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
  readonly reducedRouting: boolean;
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

export type Endpoint = {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly role: AgentRole;
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
export type ReviewLens = "behavior" | "design" | "coverage" | "verification";
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

/** One finding identity carried across review rounds, with the change supporting its status. */
export type FindingLedgerEntry = {
  readonly id: string;
  readonly lens: ReviewLens;
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
  readonly lens: ReviewLens;
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

export type NotificationKind = "routine" | "coordinator";

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

export const RESEARCH_CONTINUATION_SELECTORS = ["explicit", "deterministic", "jev"] as const;

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
 * What one brief revision says. The first seven fields carry the agreement itself; `openQuestions`
 * and `researchLinks` are annotations the coordinator keeps current without reopening approval.
 */
export type RequestBriefContent = Readonly<{
  readonly goal: string;
  readonly scope: readonly string[];
  readonly constraints: readonly string[];
  readonly nonGoals: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly recommendedApproach: string;
  readonly keyDecisions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly researchLinks: readonly string[];
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

/** Whether a recorded relation is honored, or held aside because it no longer makes sense. */
export type RequestRelationStatus = "active" | "quarantined";

/**
 * One approved task admitted to a request, pinned to the brief revision and agreement that admitted
 * it. A member whose pinning no longer matches the approved brief is quarantined, never re-pinned.
 */
export type RequestMember = Readonly<{
  readonly taskId: string;
  readonly briefRevision: number;
  readonly agreementDigest: string;
  readonly surfaces: readonly string[];
  readonly admittedAt: IsoTimestamp;
  readonly status: RequestRelationStatus;
  readonly quarantineReason?: string;
}>;

/** One member's durable wait on another member of the same request. */
export type RequestDependency = Readonly<{
  readonly taskId: string;
  readonly dependsOn: string;
  readonly reason: string;
  readonly briefRevision: number;
  readonly recordedAt: IsoTimestamp;
  readonly status: RequestRelationStatus;
  readonly quarantineReason?: string;
}>;

/** The user decision that settles one conflict; the coordinator never records this by itself. */
export type RequestConflictDecision = Readonly<{
  readonly instruction: string;
  readonly decidedAt: IsoTimestamp;
}>;

/**
 * Two or more members whose outputs contradict within the approved design. A conflict blocks the
 * request until a decision settles it, and is never resolved by retrying the work that produced it.
 */
export type RequestConflict = Readonly<{
  readonly id: string;
  readonly taskIds: readonly string[];
  readonly reason: string;
  readonly briefRevision: number;
  readonly recordedAt: IsoTimestamp;
  readonly status: RequestRelationStatus;
  readonly quarantineReason?: string;
  readonly decision?: RequestConflictDecision;
}>;

/** One member output the integration commit contains, pinned to the head that was reviewed. */
export type RequestIntegratedMember = Readonly<{
  readonly taskId: string;
  readonly branch: string;
  readonly head: string;
}>;

/**
 * The single delivery commit the approved member outputs were merged into, together with the
 * evidence recorded against that commit. Every merge was clean, so the integrated commit contains
 * no content beyond the member commits its members had reviewed.
 */
export type RequestIntegration = Readonly<{
  readonly worktree: WorktreeLease;
  readonly baseHead: string;
  readonly head: string;
  readonly members: readonly RequestIntegratedMember[];
  readonly policyDigest: string;
  readonly ownerSessionId: string;
  readonly integratedAt: IsoTimestamp;
  readonly evidence: readonly PinnedValidationEvidence[];
  readonly reviews: readonly ReviewResult[];
}>;

/** The one pull request a request delivers through, bound to the integrated commit it publishes. */
export type RequestPublication = Readonly<{
  readonly pullRequest: PullRequestMetadata;
  readonly integratedHead: string;
  readonly draft: boolean;
  readonly publishedAt: IsoTimestamp;
}>;

/**
 * Whole-request coordination and delivery for one request identity. It shares the identity owned by
 * the request brief rather than minting another, and SQLite holds it as the sole authority.
 */
export type RequestDeliveryRecord = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly repoPath: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly members: readonly RequestMember[];
  readonly dependencies: readonly RequestDependency[];
  readonly conflicts: readonly RequestConflict[];
  readonly integration?: RequestIntegration;
  readonly publication?: RequestPublication;
  /** Splitting delivery across several pull requests, recorded only from an explicit approval. */
  readonly splitApproved?: boolean;
  readonly notifications: readonly Notification[];
};

export type TaskRecord = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly repoPath: string;
  /** The request brief this task was created under, when one governs it. */
  readonly requestId?: string;
  readonly kind: TaskKind;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
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
  readonly reviewHead?: string;
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
  readonly notifications: readonly Notification[];
  readonly communication?: TaskCommunication;
  readonly pullRequest?: PullRequestMetadata;
  readonly cleanup?: TaskCleanupState;
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
