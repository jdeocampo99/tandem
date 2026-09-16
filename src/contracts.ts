export type AgentRole =
  | "coordinator"
  | "scout"
  | "implementer"
  | "reviewer"
  | "verifier"
  | "presentation";

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

export type RepoPolicy = {
  readonly version: 1;
  readonly models: Readonly<Record<AgentRole, ModelSpec>>;
  readonly instructions: InstructionChannels;
  readonly instructionFiles: InstructionChannels;
  readonly validationCommands: readonly ValidationCommand[];
  readonly maxWorkers: number;
  readonly maxFixRounds: number;
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

export type Finding = {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly verdict: FindingVerdict;
  readonly file?: string;
  readonly line?: number;
  readonly description: string;
};

export type ReviewResult = {
  readonly lens: ReviewLens;
  readonly head: string;
  readonly generation: number;
  readonly pass: boolean;
  readonly findings: readonly Finding[];
  readonly summary: string;
};

export type ValidationEvidence = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly head: string;
};

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

export type TaskRecord = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly repoPath: string;
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
  readonly validationEvidence: readonly ValidationEvidence[];
  readonly reviews: readonly ReviewResult[];
  readonly reportPath?: string;
  readonly blockReason?: string;
  readonly notifications: readonly Notification[];
  readonly communication?: TaskCommunication;
  readonly pullRequest?: PullRequestMetadata;
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
