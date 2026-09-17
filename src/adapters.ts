import { realpath as defaultRealpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { relative, resolve } from "node:path";
import { quoteShellCommand } from "./commands.ts";
import type {
  AgentRole,
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  ModelSpec,
  PullRequestMetadata,
  ThinkingLevel,
  WorktreeLease,
} from "./contracts.ts";

const SHELL_PROCESS_NAMES: Readonly<Record<string, true>> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
  ksh: true,
  fish: true,
};
const SOCKET_RESPONSE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERRUPT_POLL_MS = 100;
const PRESENTATION_STATUSES: Readonly<Record<string, true>> = {
  feedback: true,
  ended: true,
  waiting: true,
  missing: true,
  unknown: true,
  error: true,
  browser_disconnected: true,
  opened: true,
  ready: true,
  "user-ended": true,
};

export type PresentationPollOptions = Readonly<{
  readonly timeoutMs: number;
  readonly commandTimeoutMs: number;
}>;

const DEFAULT_PRESENTATION_POLL_OPTIONS: PresentationPollOptions = {
  timeoutMs: 1_000,
  commandTimeoutMs: 5_000,
};
const THINKING_LEVELS: Readonly<Record<string, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};
const MERGE_METHODS: Readonly<Record<string, true>> = {
  merge: true,
  squash: true,
  rebase: true,
};
const AGENT_ROLES: Readonly<Record<string, true>> = {
  coordinator: true,
  scout: true,
  implementer: true,
  reviewer: true,
  verifier: true,
  presentation: true,
};
function isAgentRole(value: string): value is AgentRole {
  return AGENT_ROLES[value] === true;
}
function isPresentationStatus(value: string): value is PresentationStatus {
  return PRESENTATION_STATUSES[value] === true;
}
function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS[value] === true;
}

type JsonRecord = Record<string, unknown>;
type GitCommand = readonly [string, ...string[]];
type LeaseMetadata = Readonly<{
  path: string;
  leaseId: string;
  leaseHolder: string;
  leasedAt: string;
}>;
type HerdrPaneIdentity = Readonly<{
  paneId: string;
  tabId: string;
  workspaceId: string;
  foregroundCwd: string | undefined;
}>;
type HerdrWorkspace = Readonly<{ workspaceId: string }>;
export type HerdrSessionStatus = Readonly<{ socketPath: string; running: boolean | undefined }>;
type HerdrWorkspaceMoveResponse = Readonly<{
  type: "workspace_list";
  workspaces: readonly HerdrWorkspace[];
}>;
export type PresentationStatus =
  | "feedback"
  | "ended"
  | "waiting"
  | "missing"
  | "unknown"
  | "error"
  | "browser_disconnected"
  | "opened"
  | "ready"
  | "user-ended";
export type WorktreeAdapterOptions = Readonly<{
  realpath?: (path: string) => Promise<string>;
}>;

export type TreehousePoolStatusInput = Readonly<{
  repo: string;
  root: string;
}>;

export type TreehousePoolStatusRecord = Readonly<{
  name: string;
  path: string;
  status: string;
  flavor: string;
  leaseId: string;
  leaseHolder: string;
  leasedAt: string | null;
  processes: readonly unknown[];
}>;

export type TreehouseDestroyWorktreeInput = Readonly<{
  repo: string;
  root: string;
  path: string;
}>;

export type PoolWorktreeInput = Readonly<{
  repo: string;
  path: string;
}>;

export type PoolWorktreeSafety = Readonly<{
  clean: boolean;
  ignored: boolean;
  unmerged: boolean;
  merged: boolean;
}>;

export type AcquireWorktreeInput = Readonly<{
  repo: string;
  root: string;
  tandemId: string;
  taskName: string;
  baseBranch?: string;
}>;

export type ReleaseWorktreeInput = Readonly<{
  repo: string;
  lease: WorktreeLease;
  childWorkerStopped: boolean;
  discard?: boolean;
  destructiveApproval?: boolean;
}>;

export type ReleaseWorktreeResult = Readonly<{
  released: true;
  lease: WorktreeLease;
}>;

export type HerdrAdapterOptions = Readonly<{
  moveWorkspace?: (request: HerdrWorkspaceMoveRequest) => Promise<unknown>;
  warn?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}>;

export type HerdrWorkspaceMoveRequest = Readonly<{
  socketPath: string;
  workspaceId: string;
  insertIndex: number;
}>;

export type CreateTaskEndpointInput = Readonly<{
  sessionId: string;
  cwd: string;
  taskName: string;
  role: AgentRole;
  generation: number;
  parentWorkspaceId?: string;
  insertIndex?: number;
}>;

export type CreateReviewerEndpointInput = Readonly<{
  sessionId: string;
  cwd: string;
  writer: Endpoint;
  generation: number;
}>;

export type HerdrEndpointResult = Readonly<{
  endpoint: Endpoint;
  warnings: readonly string[];
}>;

export type InspectEndpointInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
}>;

export type HerdrForegroundProcess = Readonly<{
  pid: number;
  name: string;
  argv: readonly string[];
  argv0: string | undefined;
  commandLine: string | undefined;
}>;

export type HerdrProcessInfo = Readonly<{
  paneId: string;
  shellPid: number | undefined;
  foregroundProcessGroupId: number | undefined;
  foregroundProcesses: readonly HerdrForegroundProcess[];
}>;

export type HerdrPaneInspection = Readonly<{
  endpoint: Endpoint;
  pane: HerdrPaneIdentity;
  processInfo: HerdrProcessInfo;
  activeWorker: boolean;
}>;

export type SendCommandInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  command: readonly string[];
}>;

export type HerdrCommandResult = Readonly<{
  endpoint: Endpoint;
  command: readonly string[];
  result: CommandResult;
}>;

export type InterruptEndpointInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}>;

export type InterruptEndpointResult = Readonly<{
  endpoint: Endpoint;
  wasRunning: boolean;
  stopped: true;
}>;

export type CloseEndpointInput = Readonly<{
  endpoint: Endpoint;
  cwd: string;
}>;

export type CloseEndpointResult = Readonly<{
  endpoint: Endpoint;
  closed: true;
}>;

export type OmpModelRecord = Readonly<{
  selector: string;
  id: string;
  provider: string;
  thinking: readonly ThinkingLevel[];
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  cost?: Readonly<{
    input: number;
    output: number;
  }>;
}>;

export type OmpModelListInput = Readonly<{
  cwd: string;
}>;

export type ValidateModelInput = Readonly<{
  cwd: string;
  model: ModelSpec;
}>;

export type OmpArgvInput = Readonly<{
  model: ModelSpec;
  prompt?: string;
}>;

export type GitCheckpointInput = Readonly<{
  repo: string;
  baseRef?: string;
}>;

export type GitCheckpoint = Readonly<{
  head: string;
  base: string;
  diff: string;
  dirty: boolean;
  unmerged: boolean;
}>;

export type PublishPullRequestInput = Readonly<{
  cwd: string;
  repository: string;
  title: string;
  body: string;
  base: string;
  head: string;
}>;

export type MergePullRequestInput = Readonly<{
  cwd: string;
  repository: string;
  number: number;
  expectedHead: string;
  method: "merge" | "squash" | "rebase";
  approved: boolean;
}>;

export type PresentationObservation = Readonly<{
  artifact: string;
  status: PresentationStatus;
  terminal: boolean;
  sessionEnded: boolean;
  sessionUrl?: string;
  raw: string;
  rawFeedback: string;
}>;

export class AdapterError extends Error {
  readonly operation: string;
  override readonly cause: unknown;

  constructor(message: string, operation: string, cause: unknown = undefined) {
    super(message);
    this.name = "AdapterError";
    this.operation = operation;
    this.cause = cause;
  }
}

export class AdapterCommandError extends AdapterError {
  readonly request: CommandRequest;
  readonly result: CommandResult;

  constructor(operation: string, request: CommandRequest, result: CommandResult) {
    super(
      `${operation} exited with code ${result.code}: ${JSON.stringify(request.argv)} in ${JSON.stringify(request.cwd)}${
        result.stderr.length === 0 ? "" : `; ${result.stderr.trim()}`
      }`,
      operation,
    );
    this.name = "AdapterCommandError";
    this.request = request;
    this.result = result;
  }
}

export class AdapterProtocolError extends AdapterError {
  readonly response: string;

  constructor(operation: string, message: string, response: string) {
    super(`${operation} returned malformed data: ${message}`, operation);
    this.name = "AdapterProtocolError";
    this.response = response;
  }
}

export class EndpointOwnershipError extends AdapterError {
  readonly endpoint: Endpoint;
  readonly reason: "missing" | "mismatch";

  constructor(endpoint: Endpoint, message: string, reason: "missing" | "mismatch" = "mismatch") {
    super(
      `endpoint ownership refused for pane ${endpoint.paneId}: ${message}`,
      "herdr endpoint ownership",
    );
    this.name = "EndpointOwnershipError";
    this.endpoint = endpoint;
    this.reason = reason;
  }
}

export class EndpointBusyError extends AdapterError {
  readonly endpoint: Endpoint;

  constructor(endpoint: Endpoint) {
    super(
      `endpoint ${endpoint.paneId} still has an active foreground worker; interrupt it before closing`,
      "herdr endpoint close",
    );
    this.name = "EndpointBusyError";
    this.endpoint = endpoint;
  }
}

export class LeaseSafetyError extends AdapterError {
  readonly lease: WorktreeLease;

  constructor(message: string, lease: WorktreeLease, cause: unknown = undefined) {
    super(`${message}; lease preserved at ${lease.path}`, "treehouse lease safety", cause);
    this.name = "LeaseSafetyError";
    this.lease = lease;
  }
}

export class ApprovalRequiredError extends AdapterError {
  constructor(operation: string) {
    super(`${operation} requires explicit caller approval`, operation);
    this.name = "ApprovalRequiredError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(response: string, operation: string): unknown {
  try {
    return JSON.parse(response);
  } catch (error) {
    throw new AdapterProtocolError(
      operation,
      error instanceof Error ? error.message : String(error),
      response,
    );
  }
}

function requiredRecord(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): JsonRecord {
  if (!isRecord(value)) {
    throw new AdapterProtocolError(operation, `${field} must be an object`, response);
  }
  return value;
}

function requiredString(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterProtocolError(operation, `${field} must be a non-empty string`, response);
  }
  return value;
}

function requiredInteger(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AdapterProtocolError(operation, `${field} must be a non-negative integer`, response);
  }
  return value;
}
function optionalString(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a non-empty string when present`,
      response,
    );
  }
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a non-negative integer when present`,
      response,
    );
  }
  return value;
}
function optionalBoolean(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new AdapterProtocolError(operation, `${field} must be a boolean when present`, response);
  }
  return value;
}

function optionalNumber(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a non-negative finite number when present`,
      response,
    );
  }
  return value;
}

function optionalModelCost(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): Readonly<{ input: number; output: number }> | undefined {
  if (value === undefined || value === null) return undefined;
  const cost = requiredRecord(value, field, operation, response);
  const input = optionalNumber(cost.input, `${field}.input`, operation, response);
  const output = optionalNumber(cost.output, `${field}.output`, operation, response);
  if (input === undefined || output === undefined) {
    throw new AdapterProtocolError(
      operation,
      `${field} must contain input and output costs`,
      response,
    );
  }
  return { input, output };
}

function requireSuccess(
  runResult: CommandResult,
  request: CommandRequest,
  operation: string,
): CommandResult {
  if (runResult.code !== 0) throw new AdapterCommandError(operation, request, runResult);
  return runResult;
}

async function runChecked(
  run: CommandRunner,
  request: CommandRequest,
  operation: string,
): Promise<CommandResult> {
  const result = await run(request);
  return requireSuccess(result, request, operation);
}

async function readGitText(
  run: CommandRunner,
  cwd: string,
  args: GitCommand,
  operation: string,
): Promise<string> {
  const checkedCwd = checkedPath(cwd, "cwd");
  const request: CommandRequest = {
    argv: ["git", "-C", checkedCwd, ...args],
    cwd: checkedCwd,
  };
  const result = await runChecked(run, request, operation);
  const text = result.stdout.trim();
  if (text.length === 0)
    throw new AdapterProtocolError(operation, "git returned empty stdout", result.stdout);
  return text;
}

function checkedText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  return value;
}

function checkedPath(value: unknown, field: string): string {
  return resolve(checkedText(value, field));
}

function checkedGeneration(value: unknown, field = "generation"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function checkedRole(value: unknown): AgentRole {
  if (typeof value !== "string" || !isAgentRole(value)) {
    throw new TypeError(`role ${JSON.stringify(value)} is unsupported`);
  }
  return value;
}

function checkedSession(value: string): string {
  return checkedText(value, "sessionId");
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"));
}

function readLeaseMetadata(record: JsonRecord, operation: string, response: string): LeaseMetadata {
  return {
    path: requiredString(record.path, "path", operation, response),
    leaseId: requiredString(record.lease_id, "lease_id", operation, response),
    leaseHolder: requiredString(record.lease_holder, "lease_holder", operation, response),
    leasedAt: requiredString(record.leased_at, "leased_at", operation, response),
  };
}

function parseAcquireLeaseMetadata(
  value: unknown,
  operation: string,
  response: string,
): LeaseMetadata {
  const record = requiredRecord(value, "response", operation, response);
  return readLeaseMetadata(record, operation, response);
}

function parseLeaseStatus(
  value: unknown,
  operation: string,
  response: string,
): readonly JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new AdapterProtocolError(operation, "response must be an array", response);
  }
  return value.map((entry, index) =>
    requiredRecord(entry, `response[${index}]`, operation, response),
  );
}

function poolMetadataText(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new AdapterProtocolError(operation, `${field} must be text`, response);
  }
  return value;
}

function parseTreehousePoolRecord(
  value: JsonRecord,
  index: number,
  operation: string,
  response: string,
): TreehousePoolStatusRecord {
  const field = (name: string): string => `response[${index}].${name}`;
  const leasedAt = value.leased_at;
  if (leasedAt !== null && typeof leasedAt !== "string") {
    throw new AdapterProtocolError(
      operation,
      `${field("leased_at")} must be text or null`,
      response,
    );
  }
  if (!Array.isArray(value.processes)) {
    throw new AdapterProtocolError(operation, `${field("processes")} must be an array`, response);
  }
  return {
    name: requiredString(value.name, field("name"), operation, response),
    path: requiredString(value.path, field("path"), operation, response),
    status: requiredString(value.status, field("status"), operation, response),
    flavor: requiredString(value.flavor, field("flavor"), operation, response),
    leaseId: poolMetadataText(value.lease_id, field("lease_id"), operation, response),
    leaseHolder: poolMetadataText(value.lease_holder, field("lease_holder"), operation, response),
    leasedAt,
    processes: value.processes,
  };
}

export async function readTreehousePoolStatus(
  run: CommandRunner,
  input: TreehousePoolStatusInput,
): Promise<readonly TreehousePoolStatusRecord[]> {
  const repo = checkedPath(input.repo, "repo");
  const root = checkedPath(input.root, "root");
  const request: CommandRequest = {
    argv: ["treehouse", "--root", root, "status", "--json"],
    cwd: repo,
  };
  const result = await runChecked(run, request, "treehouse pool status");
  const records = parseLeaseStatus(
    parseJson(result.stdout, "treehouse pool status"),
    "treehouse pool status",
    result.stdout,
  );
  return records.map((record, index) =>
    parseTreehousePoolRecord(record, index, "treehouse pool status", result.stdout),
  );
}

export async function destroyTreehouseWorktree(
  run: CommandRunner,
  input: TreehouseDestroyWorktreeInput,
): Promise<true> {
  const repo = checkedPath(input.repo, "repo");
  const root = checkedPath(input.root, "root");
  const path = checkedPath(input.path, "path");
  const request: CommandRequest = {
    argv: ["treehouse", "--root", root, "destroy", path, "--yes"],
    cwd: repo,
  };
  await runChecked(run, request, "treehouse pool destroy");
  return true;
}

export async function inspectPoolWorktree(
  run: CommandRunner,
  input: PoolWorktreeInput,
  options: WorktreeAdapterOptions = {},
): Promise<PoolWorktreeSafety> {
  const repo = checkedPath(input.repo, "repo");
  const path = checkedPath(input.path, "path");
  const statusRequest: CommandRequest = {
    argv: ["git", "-C", path, "status", "--porcelain=v1", "--ignored", "--untracked-files=all"],
    cwd: path,
  };
  const status = await runChecked(run, statusRequest, "git pool worktree status");
  const statusLines = status.stdout.split(/\r?\n/u).filter((line) => line.length !== 0);
  const ignored = statusLines.some((line) => line.startsWith("!!"));
  const clean = statusLines.length === 0;
  if (!clean) return { clean, ignored, unmerged: false, merged: false };
  const unmergedRequest: CommandRequest = {
    argv: ["git", "-C", path, "diff", "--name-only", "--diff-filter=U"],
    cwd: path,
  };
  const unmergedResult = await runChecked(run, unmergedRequest, "git pool worktree unmerged check");
  const unmerged = unmergedResult.stdout.trim().length !== 0;
  if (unmerged) return { clean, ignored, unmerged, merged: false };

  const worktreeRoot = resolve(
    await readGitText(run, path, ["rev-parse", "--show-toplevel"], "git pool worktree root"),
  );
  const repoRoot = resolve(
    await readGitText(run, repo, ["rev-parse", "--show-toplevel"], "git pool repository root"),
  );
  const resolvePhysicalPath = options.realpath ?? defaultRealpath;
  const [physicalPath, physicalWorktreeRoot, physicalRepoRoot] = await Promise.all([
    resolvePhysicalPath(path),
    resolvePhysicalPath(worktreeRoot),
    resolvePhysicalPath(repoRoot),
  ]);
  if (
    resolve(physicalWorktreeRoot) !== resolve(physicalPath) ||
    resolve(physicalRepoRoot) === resolve(physicalWorktreeRoot)
  ) {
    return { clean, ignored, unmerged, merged: false };
  }
  const worktreeHead = await readGitText(
    run,
    path,
    ["rev-parse", "HEAD"],
    "git pool worktree HEAD",
  );
  const primaryHead = await readGitText(run, repo, ["rev-parse", "HEAD"], "git pool primary HEAD");
  const ancestryRequest: CommandRequest = {
    argv: ["git", "-C", repo, "merge-base", "--is-ancestor", worktreeHead, primaryHead],
    cwd: repo,
  };
  const ancestry = await run(ancestryRequest);
  if (ancestry.code === 1) return { clean, ignored, unmerged, merged: false };
  if (ancestry.code !== 0) {
    throw new AdapterCommandError("git pool worktree ancestry", ancestryRequest, ancestry);
  }
  return { clean, ignored, unmerged, merged: true };
}

function safeTaskBranchName(taskName: string): string {
  const trimmed = checkedText(taskName, "taskName").normalize("NFKC").trim();
  const component = trimmed
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
  if (component.length === 0) throw new TypeError("taskName must contain a branch-safe character");
  return `tandem/${component}`;
}

export function sanitizeTaskBranchName(taskName: string): string {
  return safeTaskBranchName(taskName);
}

function leaseFromMetadata(
  metadata: LeaseMetadata,
  root: string,
  path: string,
  taskName: string,
  baseHead: string,
  branch: string,
): WorktreeLease {
  return {
    root,
    path,
    name: taskName,
    baseHead,
    branch,
    leaseId: metadata.leaseId,
    leaseHolder: metadata.leaseHolder,
    leasedAt: metadata.leasedAt,
  };
}
function validateLease(lease: WorktreeLease): void {
  checkedPath(lease.root, "lease.root");
  checkedPath(lease.path, "lease.path");
  checkedText(lease.name, "lease.name");
  checkedText(lease.baseHead, "lease.baseHead");
  checkedText(lease.branch, "lease.branch");
  checkedText(lease.leaseId, "lease.leaseId");
  checkedText(lease.leaseHolder, "lease.leaseHolder");
  checkedText(lease.leasedAt, "lease.leasedAt");
}
function reportedLeasePath(repo: string, reportedPath: string): string {
  return reportedPath.startsWith("/") ? reportedPath : resolve(repo, reportedPath);
}

async function prepareWorktreeLease(
  run: CommandRunner,
  input: AcquireWorktreeInput,
  options: WorktreeAdapterOptions,
  metadata: LeaseMetadata,
  existingLease: boolean,
): Promise<WorktreeLease> {
  const repo = checkedPath(input.repo, "repo");
  const root = checkedPath(input.root, "root");
  const taskName = checkedText(input.taskName, "taskName");
  const path = reportedLeasePath(repo, metadata.path);
  const branch = safeTaskBranchName(taskName);
  let lease = leaseFromMetadata(metadata, root, path, taskName, "unknown", branch);

  try {
    const repoRoot = resolve(
      await readGitText(run, repo, ["rev-parse", "--show-toplevel"], "git primary root"),
    );
    const worktreeRoot = resolve(
      await readGitText(run, path, ["rev-parse", "--show-toplevel"], "git worktree root"),
    );
    const physicalResolver = options.realpath ?? defaultRealpath;
    const [physicalOwnedRoot, physicalRepoRoot, physicalWorktreeRoot, physicalReportedPath] =
      await Promise.all([
        physicalResolver(root),
        physicalResolver(repoRoot),
        physicalResolver(worktreeRoot),
        physicalResolver(path),
      ]);
    if (physicalRepoRoot === physicalWorktreeRoot || physicalRepoRoot === physicalReportedPath) {
      throw new LeaseSafetyError(
        "treehouse returned the primary repository instead of a distinct worktree",
        lease,
      );
    }
    if (physicalWorktreeRoot !== physicalReportedPath) {
      throw new LeaseSafetyError(
        `Treehouse path ${JSON.stringify(path)} does not resolve to its git worktree root`,
        lease,
      );
    }
    if (!isWithin(physicalOwnedRoot, physicalWorktreeRoot)) {
      throw new LeaseSafetyError(
        `acquired worktree ${JSON.stringify(physicalWorktreeRoot)} is outside owned root ${JSON.stringify(physicalOwnedRoot)}`,
        lease,
      );
    }

    const baseHead = await readGitText(run, repo, ["rev-parse", "HEAD"], "git primary HEAD");
    const baseBranch =
      input.baseBranch === undefined
        ? await readGitText(
            run,
            repo,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            "git base branch",
          )
        : checkedText(input.baseBranch, "baseBranch");
    const branchHead = await readGitText(
      run,
      repo,
      ["rev-parse", `refs/heads/${baseBranch}`],
      "git base branch HEAD",
    );
    if (branchHead !== baseHead) {
      throw new LeaseSafetyError(
        `primary HEAD ${baseHead} does not match base branch ${baseBranch} at ${branchHead}`,
        leaseFromMetadata(metadata, root, path, taskName, baseHead, branch),
      );
    }
    lease = leaseFromMetadata(metadata, root, path, taskName, baseHead, branch);

    const branchResult = await runChecked(
      run,
      { argv: ["git", "-C", path, "branch", "--show-current"], cwd: path },
      "git worktree branch identity",
    );
    const actualBranch = branchResult.stdout.trim();
    if (existingLease && actualBranch === branch) return lease;
    if (actualBranch !== "" && actualBranch !== baseBranch) {
      throw new LeaseSafetyError(
        `acquired worktree branch is ${JSON.stringify(actualBranch)}, expected base ${JSON.stringify(baseBranch)} or task ${JSON.stringify(branch)}`,
        lease,
      );
    }
    const worktreeHead = await readGitText(run, path, ["rev-parse", "HEAD"], "git worktree HEAD");
    if (worktreeHead !== baseHead) {
      throw new LeaseSafetyError(
        `acquired worktree HEAD ${worktreeHead} does not match primary HEAD ${baseHead}`,
        lease,
      );
    }
    const switchRequest: CommandRequest = {
      argv: ["git", "-C", path, "switch", "-c", branch],
      cwd: path,
    };
    await runChecked(run, switchRequest, "git task branch create");
    const switchedBranch = await readGitText(
      run,
      path,
      ["branch", "--show-current"],
      "git task branch verify",
    );
    if (switchedBranch !== branch) {
      throw new LeaseSafetyError(
        `git created branch ${JSON.stringify(switchedBranch)} instead of ${JSON.stringify(branch)}`,
        lease,
      );
    }
    return lease;
  } catch (error) {
    if (error instanceof LeaseSafetyError) throw error;
    throw new LeaseSafetyError("worktree lease validation or branch creation failed", lease, error);
  }
}

function findOwnedLease(
  records: readonly JsonRecord[],
  tandemId: string,
  response: string,
): LeaseMetadata | undefined {
  const matches = records.filter((record) => record.lease_holder === tandemId);
  if (matches.length > 1) {
    throw new AdapterProtocolError(
      "treehouse lease status",
      `multiple leases are held by tandem id ${JSON.stringify(tandemId)}`,
      response,
    );
  }
  const matching = matches[0];
  if (matching === undefined) return undefined;
  return readLeaseMetadata(matching, "treehouse lease status", response);
}

export async function acquireWorktree(
  run: CommandRunner,
  input: AcquireWorktreeInput,
  options: WorktreeAdapterOptions = {},
): Promise<WorktreeLease> {
  const repo = checkedPath(input.repo, "repo");
  const root = checkedPath(input.root, "root");
  const tandemId = checkedText(input.tandemId, "tandemId");
  const taskName = checkedText(input.taskName, "taskName");
  const branch = safeTaskBranchName(taskName);
  const statusRequest: CommandRequest = {
    argv: ["treehouse", "--root", root, "status", "--json"],
    cwd: repo,
  };
  const statusResult = await runChecked(
    run,
    statusRequest,
    "treehouse lease status before acquire",
  );
  const statusRecords = parseLeaseStatus(
    parseJson(statusResult.stdout, "treehouse lease status before acquire"),
    "treehouse lease status before acquire",
    statusResult.stdout,
  );
  const existing = findOwnedLease(statusRecords, tandemId, statusResult.stdout);
  if (existing !== undefined) {
    return prepareWorktreeLease(run, input, options, existing, true);
  }

  const treehouseRequest: CommandRequest = {
    argv: [
      "treehouse",
      "--root",
      root,
      "get",
      "--lease",
      "--lease-holder",
      tandemId,
      "--no-fetch",
      "--json",
    ],
    cwd: repo,
  };
  const treehouseResult = await runChecked(run, treehouseRequest, "treehouse lease acquire");
  const metadata = parseAcquireLeaseMetadata(
    parseJson(treehouseResult.stdout, "treehouse lease acquire"),
    "treehouse lease acquire",
    treehouseResult.stdout,
  );
  const path = reportedLeasePath(repo, metadata.path);
  const acquiredLease = leaseFromMetadata(metadata, root, path, taskName, "unknown", branch);
  if (metadata.leaseHolder !== tandemId) {
    throw new LeaseSafetyError(
      `treehouse returned lease holder ${JSON.stringify(metadata.leaseHolder)} instead of ${JSON.stringify(tandemId)}`,
      acquiredLease,
    );
  }
  return prepareWorktreeLease(run, input, options, metadata, false);
}

function leaseRecordMatches(record: JsonRecord, lease: WorktreeLease): boolean {
  const recordPath = typeof record.path === "string" ? resolve(lease.root, record.path) : undefined;
  const recordId = typeof record.lease_id === "string" ? record.lease_id : undefined;
  return recordPath === lease.path || recordId === lease.leaseId;
}

function verifyLeaseMetadata(value: unknown, lease: WorktreeLease, response: string): void {
  const records = parseLeaseStatus(value, "treehouse lease status", response);
  const matching = records.filter((record) => leaseRecordMatches(record, lease));
  const record = matching[0];
  if (matching.length !== 1 || record === undefined) {
    throw new AdapterProtocolError(
      "treehouse lease status",
      `expected exactly one record matching lease ${JSON.stringify(lease.leaseId)}, found ${matching.length}`,
      response,
    );
  }
  const observed = readLeaseMetadata(record, "treehouse lease status", response);
  if (
    resolve(lease.root, observed.path) !== lease.path ||
    observed.leaseId !== lease.leaseId ||
    observed.leaseHolder !== lease.leaseHolder ||
    observed.leasedAt !== lease.leasedAt
  ) {
    throw new AdapterProtocolError(
      "treehouse lease status",
      "lease metadata changed while the lease was held",
      response,
    );
  }
}
async function verifyReleaseGitSafety(
  run: CommandRunner,
  input: ReleaseWorktreeInput,
): Promise<void> {
  const lease = input.lease;
  const actualBranch = await readGitText(
    run,
    lease.path,
    ["branch", "--show-current"],
    "git release branch identity",
  );
  if (actualBranch !== lease.branch) {
    throw new LeaseSafetyError(
      `worktree branch is ${JSON.stringify(actualBranch)}, expected ${JSON.stringify(lease.branch)}`,
      lease,
    );
  }
  const statusRequest: CommandRequest = {
    argv: ["git", "-C", lease.path, "status", "--porcelain=v1", "--untracked-files=all"],
    cwd: lease.path,
  };
  const status = await runChecked(run, statusRequest, "git release status");
  if (status.stdout.trim().length !== 0) {
    throw new LeaseSafetyError("worktree has dirty or untracked files", lease);
  }
  const unmergedRequest: CommandRequest = {
    argv: ["git", "-C", lease.path, "diff", "--name-only", "--diff-filter=U"],
    cwd: lease.path,
  };
  const unmerged = await runChecked(run, unmergedRequest, "git release unmerged check");
  if (unmerged.stdout.trim().length !== 0) {
    throw new LeaseSafetyError("worktree has unmerged paths", lease);
  }
  const taskHead = await readGitText(
    run,
    lease.path,
    ["rev-parse", "HEAD"],
    "git task release HEAD",
  );
  const primaryHead = await readGitText(
    run,
    input.repo,
    ["rev-parse", "HEAD"],
    "git primary release HEAD",
  );
  const ancestryRequest: CommandRequest = {
    argv: ["git", "-C", input.repo, "merge-base", "--is-ancestor", taskHead, primaryHead],
    cwd: input.repo,
  };
  const ancestry = await run(ancestryRequest);
  if (ancestry.code !== 0) {
    throw new LeaseSafetyError(
      `task HEAD ${taskHead} is not an ancestor of actual primary HEAD ${primaryHead}`,
      lease,
    );
  }
}

export async function releaseWorktree(
  run: CommandRunner,
  input: ReleaseWorktreeInput,
): Promise<ReleaseWorktreeResult> {
  validateLease(input.lease);
  const repo = checkedPath(input.repo, "repo");
  const lease = input.lease;
  if (!input.childWorkerStopped) {
    throw new LeaseSafetyError(
      "a child worker is still active or lacks stopped-agent proof",
      lease,
    );
  }
  const discard = input.discard === true;
  if (discard && input.destructiveApproval !== true) {
    throw new ApprovalRequiredError("destructive worktree discard");
  }

  try {
    const statusRequest: CommandRequest = {
      argv: ["treehouse", "--root", lease.root, "status", "--json"],
      cwd: repo,
    };
    const statusResult = await runChecked(run, statusRequest, "treehouse lease status");
    verifyLeaseMetadata(
      parseJson(statusResult.stdout, "treehouse lease status"),
      lease,
      statusResult.stdout,
    );
    if (!discard) await verifyReleaseGitSafety(run, { ...input, repo });

    const returnArgv = [
      "treehouse",
      "--root",
      lease.root,
      "return",
      lease.path,
      "--if-lease-holder",
      lease.leaseHolder,
      "--if-lease-id",
      lease.leaseId,
    ];
    if (discard) returnArgv.push("--force");
    const returnRequest: CommandRequest = { argv: returnArgv, cwd: repo };
    await runChecked(run, returnRequest, "treehouse lease return");
  } catch (error) {
    if (error instanceof LeaseSafetyError) throw error;
    throw new LeaseSafetyError("treehouse lease release could not be proven safe", lease, error);
  }
  return { released: true, lease };
}

function herdrRequest(sessionId: string, cwd: string, args: readonly string[]): CommandRequest {
  return {
    argv: ["herdr", "--session", checkedSession(sessionId), ...args],
    cwd: checkedPath(cwd, "cwd"),
  };
}
function validateEndpoint(endpoint: Endpoint): void {
  checkedSession(endpoint.sessionId);
  checkedText(endpoint.workspaceId, "endpoint.workspaceId");
  checkedText(endpoint.tabId, "endpoint.tabId");
  checkedText(endpoint.paneId, "endpoint.paneId");
  checkedRole(endpoint.role);
  checkedGeneration(endpoint.generation, "endpoint.generation");
}

function readPaneIdentityFromPayload(
  payload: unknown,
  endpoint: Endpoint,
  operation: string,
  response: string,
): HerdrPaneIdentity {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  const pane = requiredRecord(result.pane, "result.pane", operation, response);
  const paneId = requiredString(pane.pane_id, "result.pane.pane_id", operation, response);
  const tabId = requiredString(pane.tab_id, "result.pane.tab_id", operation, response);
  const workspaceId = requiredString(
    pane.workspace_id,
    "result.pane.workspace_id",
    operation,
    response,
  );
  const foregroundCwd = optionalString(
    pane.foreground_cwd,
    "result.pane.foreground_cwd",
    operation,
    response,
  );
  if (
    paneId !== endpoint.paneId ||
    tabId !== endpoint.tabId ||
    workspaceId !== endpoint.workspaceId
  ) {
    throw new EndpointOwnershipError(
      endpoint,
      `Herdr returned pane=${JSON.stringify(paneId)}, tab=${JSON.stringify(tabId)}, workspace=${JSON.stringify(workspaceId)}`,
    );
  }
  return { paneId, tabId, workspaceId, foregroundCwd };
}

async function readPaneIdentity(
  run: CommandRunner,
  input: InspectEndpointInput,
): Promise<HerdrPaneIdentity> {
  validateEndpoint(input.endpoint);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "get",
    input.endpoint.paneId,
  ]);
  const result = await run(request);
  if (result.code !== 0) {
    if (isMissingPaneResponse(result)) {
      throw new EndpointOwnershipError(
        input.endpoint,
        "pane is no longer present in the recorded session",
        "missing",
      );
    }
    throw new AdapterCommandError("herdr pane get", request, result);
  }
  return readPaneIdentityFromPayload(
    parseJson(result.stdout, "herdr pane get"),
    input.endpoint,
    "herdr pane get",
    result.stdout,
  );
}

function readProcess(
  value: unknown,
  index: number,
  operation: string,
  response: string,
): HerdrForegroundProcess {
  const process = requiredRecord(value, `foreground_processes[${index}]`, operation, response);
  const pid = requiredInteger(
    process.pid,
    `foreground_processes[${index}].pid`,
    operation,
    response,
  );
  if (pid < 1) {
    throw new AdapterProtocolError(
      operation,
      `foreground_processes[${index}].pid must be positive`,
      response,
    );
  }
  const name = requiredString(
    process.name,
    `foreground_processes[${index}].name`,
    operation,
    response,
  );
  const argvValue = process.argv;
  const argv: string[] = [];
  if (argvValue !== undefined) {
    if (!Array.isArray(argvValue)) {
      throw new AdapterProtocolError(
        operation,
        `foreground_processes[${index}].argv must be an array of strings`,
        response,
      );
    }
    for (const entry of argvValue) {
      if (typeof entry !== "string") {
        throw new AdapterProtocolError(
          operation,
          `foreground_processes[${index}].argv must be an array of strings`,
          response,
        );
      }
      argv.push(entry);
    }
  }
  const argv0 = optionalString(
    process.argv0,
    `foreground_processes[${index}].argv0`,
    operation,
    response,
  );
  const commandLine = optionalString(
    process.cmdline ?? process.command,
    `foreground_processes[${index}].cmdline`,
    operation,
    response,
  );
  return { pid, name, argv, argv0, commandLine };
}

function readProcessInfo(
  payload: unknown,
  endpoint: Endpoint,
  operation: string,
  response: string,
): HerdrProcessInfo {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  const processInfo = requiredRecord(
    result.process_info,
    "result.process_info",
    operation,
    response,
  );
  const paneId = requiredString(
    processInfo.pane_id,
    "result.process_info.pane_id",
    operation,
    response,
  );
  if (paneId !== endpoint.paneId) {
    throw new EndpointOwnershipError(
      endpoint,
      `process-info described pane ${JSON.stringify(paneId)} instead of ${JSON.stringify(endpoint.paneId)}`,
    );
  }
  // Herdr omits this optional array when no foreground processes are reported.
  const processes =
    processInfo.foreground_processes === undefined ? [] : processInfo.foreground_processes;
  if (!Array.isArray(processes)) {
    throw new AdapterProtocolError(operation, "foreground_processes must be an array", response);
  }
  const foregroundProcesses = processes.map((entry, index) =>
    readProcess(entry, index, operation, response),
  );
  const shellPid = optionalInteger(
    processInfo.shell_pid,
    "result.process_info.shell_pid",
    operation,
    response,
  );
  const foregroundProcessGroupId = optionalInteger(
    processInfo.foreground_process_group_id,
    "result.process_info.foreground_process_group_id",
    operation,
    response,
  );
  return { paneId, shellPid, foregroundProcessGroupId, foregroundProcesses };
}

function processBasename(value: string): string {
  const withoutPath = value.split("/").at(-1) ?? value;
  return withoutPath.replace(/^-/, "").toLowerCase();
}

function isWorkerProcess(process: HerdrForegroundProcess): boolean {
  const name = processBasename(process.name);
  const argv0 = process.argv0 === undefined ? undefined : processBasename(process.argv0);
  return (
    SHELL_PROCESS_NAMES[name] !== true ||
    (argv0 !== undefined && SHELL_PROCESS_NAMES[argv0] !== true)
  );
}

export async function inspectEndpoint(
  run: CommandRunner,
  input: InspectEndpointInput,
): Promise<HerdrPaneInspection> {
  validateEndpoint(input.endpoint);
  const pane = await readPaneIdentity(run, input);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "process-info",
    "--pane",
    input.endpoint.paneId,
  ]);
  const result = await runChecked(run, request, "herdr pane process-info");
  const processInfo = readProcessInfo(
    parseJson(result.stdout, "herdr pane process-info"),
    input.endpoint,
    "herdr pane process-info",
    result.stdout,
  );
  return {
    endpoint: input.endpoint,
    pane,
    processInfo,
    activeWorker: processInfo.foregroundProcesses.some((process) => isWorkerProcess(process)),
  };
}

function parseWorkspaceList(
  payload: unknown,
  operation: string,
  response: string,
): readonly HerdrWorkspace[] {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  if (!Array.isArray(result.workspaces)) {
    throw new AdapterProtocolError(operation, "result.workspaces must be an array", response);
  }
  return result.workspaces.map((entry, index) => {
    const workspace = requiredRecord(entry, `result.workspaces[${index}]`, operation, response);
    return {
      workspaceId: requiredString(
        workspace.workspace_id,
        `result.workspaces[${index}].workspace_id`,
        operation,
        response,
      ),
    };
  });
}

function parseCreatedEndpoint(
  payload: unknown,
  sessionId: string,
  role: AgentRole,
  generation: number,
  operation: string,
  response: string,
): Endpoint {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  const workspace = requiredRecord(result.workspace, "result.workspace", operation, response);
  const tab = requiredRecord(result.tab, "result.tab", operation, response);
  const rootPane = requiredRecord(result.root_pane, "result.root_pane", operation, response);
  const workspaceId = requiredString(
    workspace.workspace_id,
    "result.workspace.workspace_id",
    operation,
    response,
  );
  const tabId = requiredString(tab.tab_id, "result.tab.tab_id", operation, response);
  const paneId = requiredString(rootPane.pane_id, "result.root_pane.pane_id", operation, response);
  return {
    sessionId: checkedSession(sessionId),
    workspaceId,
    tabId,
    paneId,
    role: checkedRole(role),
    generation: checkedGeneration(generation),
  };
}

function parseSplitEndpoint(
  payload: unknown,
  writer: Endpoint,
  generation: number,
  operation: string,
  response: string,
): Endpoint {
  const root = requiredRecord(payload, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  const pane = requiredRecord(result.pane, "result.pane", operation, response);
  const workspaceId = requiredString(
    pane.workspace_id,
    "result.pane.workspace_id",
    operation,
    response,
  );
  const tabId = requiredString(pane.tab_id, "result.pane.tab_id", operation, response);
  const paneId = requiredString(pane.pane_id, "result.pane.pane_id", operation, response);
  if (workspaceId !== writer.workspaceId) {
    throw new EndpointOwnershipError(
      writer,
      `reviewer split landed in workspace ${JSON.stringify(workspaceId)} instead of ${JSON.stringify(writer.workspaceId)}`,
    );
  }
  if (paneId === writer.paneId) {
    throw new AdapterProtocolError(operation, "reviewer split reused the writer pane id", response);
  }
  return {
    sessionId: writer.sessionId,
    workspaceId,
    tabId,
    paneId,
    role: "reviewer",
    generation: checkedGeneration(generation),
  };
}

function parseHerdrStatus(
  payload: unknown,
  sessionId: string,
  operation: string,
  response: string,
  allowNotRunning = false,
): HerdrSessionStatus {
  const root = requiredRecord(payload, "response", operation, response);
  const server = requiredRecord(root.server, "server", operation, response);
  const socketPath = requiredString(server.socket, "server.socket", operation, response);
  if (!socketPath.startsWith("/")) {
    throw new AdapterProtocolError(
      operation,
      "server.socket must be an absolute Unix socket path",
      response,
    );
  }
  const runningValue = server.running;
  if (runningValue !== undefined && typeof runningValue !== "boolean") {
    throw new AdapterProtocolError(
      operation,
      "server.running must be boolean when present",
      response,
    );
  }
  if (runningValue === false && !allowNotRunning) {
    throw new AdapterProtocolError(
      operation,
      `Herdr session ${sessionId} is not running`,
      response,
    );
  }
  const reportedSession = optionalString(server.session, "server.session", operation, response);
  const reportedSessionId = optionalString(
    server.session_id,
    "server.session_id",
    operation,
    response,
  );
  if (
    (reportedSession !== undefined && reportedSession !== sessionId) ||
    (reportedSessionId !== undefined && reportedSessionId !== sessionId)
  ) {
    throw new AdapterProtocolError(
      operation,
      "status socket belongs to a different session",
      response,
    );
  }
  return { socketPath, running: runningValue };
}

export async function readHerdrStatus(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
  allowNotRunning = false,
): Promise<HerdrSessionStatus> {
  const request = herdrRequest(sessionId, cwd, ["status", "--json"]);
  const result = await runChecked(run, request, "herdr status");
  return parseHerdrStatus(
    parseJson(result.stdout, "herdr status"),
    sessionId,
    "herdr status",
    result.stdout,
    allowNotRunning,
  );
}

function recordWarning(options: HerdrAdapterOptions, warnings: string[], message: string): void {
  warnings.push(message);
  options.warn?.(message);
}

async function moveWorkspaceOverSocket(request: HerdrWorkspaceMoveRequest): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const socket = createConnection({ path: request.socketPath });
  let buffer = "";
  let settled = false;
  const settleSuccess = (value: unknown): void => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(value);
  };
  const settleFailure = (error: unknown): void => {
    if (settled) return;
    settled = true;
    socket.destroy();
    reject(error);
  };
  socket.setTimeout(5_000, () => {
    settleFailure(new Error("timed out waiting for Herdr workspace.move response"));
  });
  socket.on("connect", () => {
    const message = `${JSON.stringify({
      id: "tandem-workspace-move",
      method: "workspace.move",
      params: { workspace_id: request.workspaceId, insert_index: request.insertIndex },
    })}\n`;
    socket.write(message);
  });
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > SOCKET_RESPONSE_LIMIT) {
      settleFailure(new Error("Herdr workspace.move response exceeded capture bound"));
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    try {
      settleSuccess(JSON.parse(line));
    } catch (error) {
      settleFailure(error);
    }
  });
  socket.on("error", (error: Error) => {
    settleFailure(error);
  });
  socket.on("close", () => {
    if (!settled) settleFailure(new Error("Herdr workspace.move socket closed without a response"));
  });
  return promise;
}
function waitMilliseconds(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function parseWorkspaceMoveResponse(
  value: unknown,
  operation: string,
  response: string,
): HerdrWorkspaceMoveResponse {
  const root = requiredRecord(value, "response", operation, response);
  const result = requiredRecord(root.result, "result", operation, response);
  if (result.type !== "workspace_list") {
    throw new AdapterProtocolError(operation, "result.type must be workspace_list", response);
  }
  return { type: "workspace_list", workspaces: parseWorkspaceList(value, operation, response) };
}

async function orderTaskWorkspace(
  run: CommandRunner,
  input: CreateTaskEndpointInput,
  endpoint: Endpoint,
  options: HerdrAdapterOptions,
): Promise<readonly string[]> {
  const warnings: string[] = [];
  if (input.parentWorkspaceId === undefined) return warnings;
  const parentWorkspaceId = checkedText(input.parentWorkspaceId, "parentWorkspaceId");
  if (parentWorkspaceId === endpoint.workspaceId) {
    recordWarning(
      options,
      warnings,
      "refused workspace.move because parent and created workspace ids are identical",
    );
    return warnings;
  }
  if (
    input.insertIndex !== undefined &&
    (!Number.isSafeInteger(input.insertIndex) || input.insertIndex < 0)
  ) {
    recordWarning(
      options,
      warnings,
      "refused workspace.move because insertIndex is not a non-negative integer",
    );
    return warnings;
  }
  let status: HerdrSessionStatus;
  try {
    status = await readHerdrStatus(run, endpoint.sessionId, input.cwd);
  } catch (error) {
    recordWarning(
      options,
      warnings,
      `workspace.move skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return warnings;
  }

  let workspaces: readonly HerdrWorkspace[];
  try {
    const request = herdrRequest(endpoint.sessionId, input.cwd, ["workspace", "list"]);
    const result = await runChecked(run, request, "herdr workspace list");
    workspaces = parseWorkspaceList(
      parseJson(result.stdout, "herdr workspace list"),
      "herdr workspace list",
      result.stdout,
    );
  } catch (error) {
    recordWarning(
      options,
      warnings,
      `workspace.move skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return warnings;
  }

  const parentMatches = workspaces.filter(
    (workspace) => workspace.workspaceId === parentWorkspaceId,
  );
  const createdMatches = workspaces.filter(
    (workspace) => workspace.workspaceId === endpoint.workspaceId,
  );
  if (parentMatches.length !== 1 || createdMatches.length !== 1) {
    recordWarning(
      options,
      warnings,
      `workspace.move skipped because parent (${parentMatches.length}) or created workspace (${createdMatches.length}) identity was ambiguous`,
    );
    return warnings;
  }
  const parentIndex = workspaces.findIndex(
    (workspace) => workspace.workspaceId === parentWorkspaceId,
  );
  const insertIndex = input.insertIndex ?? parentIndex + 1;
  if (insertIndex > workspaces.length) {
    recordWarning(
      options,
      warnings,
      `workspace.move skipped because insertIndex ${insertIndex} is outside the workspace list`,
    );
    return warnings;
  }

  const moveRequest: HerdrWorkspaceMoveRequest = {
    socketPath: status.socketPath,
    workspaceId: endpoint.workspaceId,
    insertIndex,
  };
  try {
    const response = await (options.moveWorkspace ?? moveWorkspaceOverSocket)(moveRequest);
    const responseText = JSON.stringify(response) ?? String(response);
    const parsed = parseWorkspaceMoveResponse(response, "herdr workspace.move", responseText);
    const targetCount = parsed.workspaces.filter(
      (workspace) => workspace.workspaceId === endpoint.workspaceId,
    ).length;
    const parentCount = parsed.workspaces.filter(
      (workspace) => workspace.workspaceId === parentWorkspaceId,
    ).length;
    if (targetCount !== 1 || parentCount !== 1) {
      recordWarning(
        options,
        warnings,
        "workspace.move returned an unverifiable workspace identity; no retry was attempted",
      );
    }
  } catch (error) {
    recordWarning(
      options,
      warnings,
      `workspace.move failed; worker placement was preserved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return warnings;
}

export function taskWorkspaceLabel(taskName: string): string {
  return `└ ${checkedText(taskName, "taskName")}`;
}

export async function createTaskEndpoint(
  run: CommandRunner,
  input: CreateTaskEndpointInput,
  options: HerdrAdapterOptions = {},
): Promise<HerdrEndpointResult> {
  const label = taskWorkspaceLabel(input.taskName);
  const request = herdrRequest(input.sessionId, input.cwd, [
    "workspace",
    "create",
    "--cwd",
    checkedPath(input.cwd, "cwd"),
    "--label",
    label,
    "--no-focus",
  ]);
  const result = await runChecked(run, request, "herdr workspace create");
  const endpoint = parseCreatedEndpoint(
    parseJson(result.stdout, "herdr workspace create"),
    input.sessionId,
    input.role,
    input.generation,
    "herdr workspace create",
    result.stdout,
  );
  const warnings = await orderTaskWorkspace(run, input, endpoint, options);
  return { endpoint, warnings };
}

export async function createReviewerEndpoint(
  run: CommandRunner,
  input: CreateReviewerEndpointInput,
  options: WorktreeAdapterOptions = {},
): Promise<HerdrEndpointResult> {
  validateEndpoint(input.writer);
  if (input.sessionId !== input.writer.sessionId) {
    throw new EndpointOwnershipError(
      input.writer,
      "reviewer session does not match writer session",
    );
  }
  const writerInspection = await inspectEndpoint(run, { endpoint: input.writer, cwd: input.cwd });
  if (writerInspection.activeWorker) throw new EndpointBusyError(input.writer);
  const writerPane = writerInspection.pane;
  if (writerPane.foregroundCwd === undefined) {
    throw new EndpointOwnershipError(input.writer, "writer working directory is unavailable");
  }
  const resolvePhysicalPath = options.realpath ?? defaultRealpath;
  const [writerDirectory, reviewerDirectory] = await Promise.all([
    resolvePhysicalPath(writerPane.foregroundCwd),
    resolvePhysicalPath(checkedPath(input.cwd, "cwd")),
  ]);
  if (writerDirectory !== reviewerDirectory) {
    throw new EndpointOwnershipError(
      input.writer,
      `writer cwd ${JSON.stringify(writerPane.foregroundCwd)} does not match reviewer cwd ${JSON.stringify(input.cwd)}`,
    );
  }
  const request = herdrRequest(input.sessionId, input.cwd, [
    "pane",
    "split",
    input.writer.paneId,
    "--direction",
    "right",
    "--cwd",
    checkedPath(input.cwd, "cwd"),
    "--no-focus",
  ]);
  const result = await runChecked(run, request, "herdr reviewer pane split");
  const endpoint = parseSplitEndpoint(
    parseJson(result.stdout, "herdr reviewer pane split"),
    input.writer,
    input.generation,
    "herdr reviewer pane split",
    result.stdout,
  );
  return { endpoint, warnings: [] };
}

export async function sendCommand(
  run: CommandRunner,
  input: SendCommandInput,
): Promise<HerdrCommandResult> {
  validateEndpoint(input.endpoint);
  if (input.command.length === 0) throw new TypeError("Herdr pane command cannot be empty");
  await inspectEndpoint(run, { endpoint: input.endpoint, cwd: input.cwd });
  const commandText = quoteShellCommand(input.command);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "run",
    input.endpoint.paneId,
    commandText,
  ]);
  const result = await runChecked(run, request, "herdr pane run");
  return { endpoint: input.endpoint, command: input.command, result };
}

export async function interruptEndpoint(
  run: CommandRunner,
  input: InterruptEndpointInput,
  options: HerdrAdapterOptions = {},
): Promise<InterruptEndpointResult> {
  validateEndpoint(input.endpoint);
  const timeoutMs = input.timeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_INTERRUPT_POLL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new TypeError("timeoutMs must be finite and non-negative");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("pollIntervalMs must be finite and non-negative");
  }
  const initial = await inspectEndpoint(run, { endpoint: input.endpoint, cwd: input.cwd });
  if (!initial.activeWorker) return { endpoint: input.endpoint, wasRunning: false, stopped: true };

  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "send-keys",
    input.endpoint.paneId,
    "ctrl+c",
  ]);
  await runChecked(run, request, "herdr pane interrupt");

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? waitMilliseconds;
  const deadline = now() + timeoutMs;
  while (true) {
    const inspection = await inspectEndpoint(run, { endpoint: input.endpoint, cwd: input.cwd });
    if (!inspection.activeWorker)
      return { endpoint: input.endpoint, wasRunning: true, stopped: true };
    if (now() >= deadline) {
      throw new EndpointBusyError(input.endpoint);
    }
    await sleep(pollIntervalMs);
  }
}

function isMissingPaneResponse(result: CommandResult): boolean {
  if (result.code === 0) return false;
  try {
    const payload: unknown = JSON.parse(result.stderr);
    return isRecord(payload) && isRecord(payload.error) && payload.error.code === "pane_not_found";
  } catch {
    return false;
  }
}

async function verifyPaneClosed(run: CommandRunner, input: CloseEndpointInput): Promise<void> {
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "get",
    input.endpoint.paneId,
  ]);
  const result = await run(request);
  if (result.code === 0) {
    readPaneIdentityFromPayload(
      parseJson(result.stdout, "herdr pane close verification"),
      input.endpoint,
      "herdr pane close verification",
      result.stdout,
    );
    throw new AdapterError(
      "Herdr pane close returned success but the exact pane remains present",
      "herdr pane close",
    );
  }
  if (!isMissingPaneResponse(result)) {
    throw new AdapterCommandError("herdr pane close verification", request, result);
  }
}

export async function closeEndpoint(
  run: CommandRunner,
  input: CloseEndpointInput,
): Promise<CloseEndpointResult> {
  let inspection: HerdrPaneInspection;
  try {
    inspection = await inspectEndpoint(run, { endpoint: input.endpoint, cwd: input.cwd });
  } catch (error) {
    if (
      (error instanceof EndpointOwnershipError && error.reason === "missing") ||
      (error instanceof AdapterCommandError && isMissingPaneResponse(error.result))
    ) {
      return { endpoint: input.endpoint, closed: true };
    }
    throw error;
  }
  if (inspection.activeWorker) throw new EndpointBusyError(input.endpoint);
  const request = herdrRequest(input.endpoint.sessionId, input.cwd, [
    "pane",
    "close",
    input.endpoint.paneId,
  ]);
  await runChecked(run, request, "herdr pane close");
  await verifyPaneClosed(run, input);
  return { endpoint: input.endpoint, closed: true };
}

function parseThinkingLevels(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): readonly ThinkingLevel[] {
  const values: readonly unknown[] =
    typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (values.length === 0 || values.some((entry) => typeof entry !== "string")) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a thinking level or non-empty level array`,
      response,
    );
  }
  const levels: ThinkingLevel[] = [];
  for (const entry of values) {
    if (typeof entry !== "string" || !isThinkingLevel(entry)) {
      throw new AdapterProtocolError(
        operation,
        `${field} contains unsupported level ${JSON.stringify(entry)}`,
        response,
      );
    }
    levels.push(entry);
  }
  return levels;
}

function parseModelRecord(
  value: unknown,
  index: number,
  operation: string,
  response: string,
): OmpModelRecord {
  const record = requiredRecord(value, `models[${index}]`, operation, response);
  const selector = requiredString(
    record.selector,
    `models[${index}].selector`,
    operation,
    response,
  );
  const id = requiredString(record.id, `models[${index}].id`, operation, response);
  const provider = requiredString(
    record.provider,
    `models[${index}].provider`,
    operation,
    response,
  );
  const thinking = parseThinkingLevels(
    record.thinking,
    `models[${index}].thinking`,
    operation,
    response,
  );
  const name = optionalString(record.name, `models[${index}].name`, operation, response);
  const reasoning = optionalBoolean(
    record.reasoning,
    `models[${index}].reasoning`,
    operation,
    response,
  );
  const contextWindow = optionalInteger(
    record.contextWindow,
    `models[${index}].contextWindow`,
    operation,
    response,
  );
  const cost = optionalModelCost(record.cost, `models[${index}].cost`, operation, response);
  return {
    selector,
    id,
    provider,
    thinking,
    ...(name === undefined ? {} : { name }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function parseModelListing(response: string): readonly OmpModelRecord[] {
  const operation = "omp model listing";
  const parsed = parseJson(response, operation);
  const root = requiredRecord(parsed, "response", operation, response);
  if (!Array.isArray(root.models)) {
    throw new AdapterProtocolError(operation, "models must be an array", response);
  }
  return root.models.map((entry, index) => parseModelRecord(entry, index, operation, response));
}

type OmpModelListingResult = Readonly<{
  readonly models: readonly OmpModelRecord[];
  readonly response: string;
}>;

async function readOmpModelListing(
  run: CommandRunner,
  input: OmpModelListInput,
): Promise<OmpModelListingResult> {
  const request: CommandRequest = {
    argv: ["omp", "models", "--json"],
    cwd: checkedPath(input.cwd, "cwd"),
  };
  const result = await runChecked(run, request, "omp model listing");
  return {
    models: parseModelListing(result.stdout),
    response: result.stdout,
  };
}

export async function listOmpModels(
  run: CommandRunner,
  input: OmpModelListInput,
): Promise<readonly OmpModelRecord[]> {
  return (await readOmpModelListing(run, input)).models;
}

export async function validateModel(
  run: CommandRunner,
  input: ValidateModelInput,
): Promise<OmpModelRecord> {
  const model = input.model;
  checkedText(model.model, "model.model");
  if (!isThinkingLevel(model.thinking)) {
    throw new TypeError(`unsupported model thinking level ${model.thinking}`);
  }
  const listing = await readOmpModelListing(run, { cwd: input.cwd });
  const matches = listing.models.filter((candidate) => candidate.selector === model.model);
  if (matches.length !== 1) {
    throw new AdapterProtocolError(
      "omp model listing",
      `selector ${JSON.stringify(model.model)} matched ${matches.length} models; no fallback is allowed`,
      listing.response,
    );
  }
  const observed = matches[0];
  if (observed === undefined) {
    throw new AdapterProtocolError(
      "omp model listing",
      `selector ${JSON.stringify(model.model)} matched no model`,
      listing.response,
    );
  }
  if (!observed.thinking.includes(model.thinking)) {
    throw new AdapterProtocolError(
      "omp model listing",
      `selector ${JSON.stringify(model.model)} does not support thinking ${JSON.stringify(model.thinking)}`,
      listing.response,
    );
  }
  return observed;
}

export function buildOmpArgv(input: OmpArgvInput): readonly string[] {
  checkedText(input.model.model, "model.model");
  if (!isThinkingLevel(input.model.thinking)) {
    throw new TypeError(`unsupported model thinking level ${input.model.thinking}`);
  }
  const argv = [
    "omp",
    "--model",
    input.model.model,
    "--thinking",
    input.model.thinking,
    "--no-prewalk",
    "--no-extensions",
    "--no-title",
  ];
  if (input.prompt !== undefined) argv.push(input.prompt);
  return argv;
}

export async function readCheckpoint(
  run: CommandRunner,
  input: GitCheckpointInput,
): Promise<GitCheckpoint> {
  const repo = checkedPath(input.repo, "repo");
  const baseRef = input.baseRef === undefined ? "HEAD" : checkedText(input.baseRef, "baseRef");
  const head = await readGitText(run, repo, ["rev-parse", "HEAD"], "git checkpoint HEAD");
  const base = await readGitText(run, repo, ["rev-parse", baseRef], "git checkpoint base");
  const diffRequest: CommandRequest = {
    argv: ["git", "-C", repo, "diff", "--no-ext-diff", "--binary", baseRef],
    cwd: repo,
  };
  const diff = (await runChecked(run, diffRequest, "git checkpoint diff")).stdout;
  const statusRequest: CommandRequest = {
    argv: ["git", "-C", repo, "status", "--porcelain=v1", "--untracked-files=all"],
    cwd: repo,
  };
  const status = (await runChecked(run, statusRequest, "git checkpoint status")).stdout;
  const unmergedRequest: CommandRequest = {
    argv: ["git", "-C", repo, "diff", "--name-only", "--diff-filter=U"],
    cwd: repo,
  };
  const unmerged = (await runChecked(run, unmergedRequest, "git checkpoint unmerged")).stdout;
  return {
    head,
    base,
    diff,
    dirty: status.trim().length !== 0,
    unmerged: unmerged.trim().length !== 0,
  };
}

function parsePullRequestMetadata(
  value: unknown,
  repository: string,
  operation: string,
  response: string,
): PullRequestMetadata {
  const root = requiredRecord(value, "response", operation, response);
  const number = requiredInteger(root.number, "number", operation, response);
  if (number < 1) throw new AdapterProtocolError(operation, "number must be positive", response);
  const rawState = requiredString(root.state, "state", operation, response).toLowerCase();
  if (rawState !== "open" && rawState !== "closed" && rawState !== "merged") {
    throw new AdapterProtocolError(
      operation,
      `unsupported pull request state ${JSON.stringify(rawState)}`,
      response,
    );
  }
  const head = requiredString(root.headRefOid, "headRefOid", operation, response);
  if (typeof root.isDraft !== "boolean") {
    throw new AdapterProtocolError(operation, "isDraft must be boolean", response);
  }
  const base = requiredString(root.baseRefName, "baseRefName", operation, response);
  const url = optionalString(root.url, "url", operation, response);
  const title = optionalString(root.title, "title", operation, response);
  return {
    repository,
    number,
    state: rawState === "open" && root.isDraft ? "draft" : rawState,
    head,
    base,
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
  };
}

async function readPullRequest(
  run: CommandRunner,
  cwd: string,
  repository: string,
  selector: string,
  operation: string,
): Promise<PullRequestMetadata> {
  const request: CommandRequest = {
    argv: [
      "gh",
      "pr",
      "view",
      selector,
      "--repo",
      repository,
      "--json",
      "number,url,state,isDraft,headRefOid,baseRefName,title",
    ],
    cwd,
  };
  const result = await runChecked(run, request, operation);
  return parsePullRequestMetadata(
    parseJson(result.stdout, operation),
    repository,
    operation,
    result.stdout,
  );
}

function extractPullRequestSelector(output: string): string | undefined {
  return output
    .split(/\s+/u)
    .find((candidate) => candidate.startsWith("https://") || candidate.startsWith("http://"));
}

export async function publishPullRequest(
  run: CommandRunner,
  input: PublishPullRequestInput,
): Promise<PullRequestMetadata> {
  const cwd = checkedPath(input.cwd, "cwd");
  const repository = checkedText(input.repository, "repository");
  const title = checkedText(input.title, "title");
  const body = checkedText(input.body, "body");
  const base = checkedText(input.base, "base");
  const head = checkedText(input.head, "head");
  const request: CommandRequest = {
    argv: [
      "gh",
      "pr",
      "create",
      "--repo",
      repository,
      "--title",
      title,
      "--body",
      body,
      "--base",
      base,
      "--head",
      head,
    ],
    cwd,
  };
  const result = await runChecked(run, request, "github pull request publish");
  const selector = extractPullRequestSelector(result.stdout);
  if (selector === undefined) {
    throw new AdapterProtocolError(
      "github pull request publish",
      "gh pr create omitted a pull request URL",
      result.stdout,
    );
  }
  return readPullRequest(run, cwd, repository, selector, "github pull request observe");
}

export async function mergePullRequest(
  run: CommandRunner,
  input: MergePullRequestInput,
): Promise<PullRequestMetadata> {
  const cwd = checkedPath(input.cwd, "cwd");
  const repository = checkedText(input.repository, "repository");
  const expectedHead = checkedText(input.expectedHead, "expectedHead");
  if (!Number.isSafeInteger(input.number) || input.number < 1) {
    throw new TypeError("pull request number must be a positive integer");
  }
  if (!input.approved) throw new ApprovalRequiredError("pull request merge");
  if (MERGE_METHODS[input.method] !== true)
    throw new TypeError("pull request merge method is unsupported");
  const selector = String(input.number);
  const observed = await readPullRequest(
    run,
    cwd,
    repository,
    selector,
    "github pull request merge precondition",
  );
  if (observed.head !== expectedHead) {
    throw new AdapterProtocolError(
      "github pull request merge",
      `observed pull request head ${JSON.stringify(observed.head)} does not match expected head ${JSON.stringify(expectedHead)}`,
      JSON.stringify(observed),
    );
  }
  const methodFlag = `--${input.method}`;
  const request: CommandRequest = {
    argv: [
      "gh",
      "pr",
      "merge",
      selector,
      "--repo",
      repository,
      methodFlag,
      "--match-head-commit",
      expectedHead,
    ],
    cwd,
  };
  await runChecked(run, request, "github pull request merge");
  const merged = await readPullRequest(
    run,
    cwd,
    repository,
    selector,
    "github pull request merge observation",
  );
  if (merged.state !== "merged" || merged.head !== expectedHead) {
    throw new AdapterProtocolError(
      "github pull request merge observation",
      `pull request did not report merged state with expected head ${JSON.stringify(expectedHead)}`,
      JSON.stringify(merged),
    );
  }
  return merged;
}

function sessionUrl(value: string): string | undefined {
  const candidate = value.trim().replace(/^(['"])(.*)\1$/u, "$2");
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function extractSessionFields(
  raw: string,
): Readonly<{ status: PresentationStatus; sessionEnded: boolean; sessionUrl?: string }> {
  const lines = raw.split(/\r?\n/u);
  const sessionStart = lines.indexOf("session:");
  if (sessionStart >= 0) {
    let status: PresentationStatus | undefined;
    let sessionEnded = false;
    let sessionUrlValue: string | undefined;
    for (let index = sessionStart + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || (line.length !== 0 && !/^\s/u.test(line))) break;
      const statusMatch = line.match(/^\s+status:\s*([A-Za-z_-]+)\s*$/u);
      const statusText = statusMatch?.[1];
      if (statusText !== undefined) {
        const candidate = statusText.toLowerCase();
        if (!isPresentationStatus(candidate)) {
          throw new AdapterProtocolError(
            "lavish presentation",
            `unknown session status ${candidate}`,
            raw,
          );
        }
        status = candidate;
      }
      const endedMatch = line.match(/^\s+session_ended:\s*(true|false)\s*$/iu);
      const endedText = endedMatch?.[1];
      if (endedText !== undefined) sessionEnded = endedText.toLowerCase() === "true";
      const urlMatch = line.match(
        /^\s+(?:url|session_url|sessionUrl|browser_url|browserUrl|editor_url|editorUrl):\s*(\S+)\s*$/u,
      );
      const urlText = urlMatch?.[1];
      if (sessionUrlValue === undefined && urlText !== undefined) {
        sessionUrlValue = sessionUrl(urlText);
      }
    }
    if (status === undefined) {
      throw new AdapterProtocolError("lavish presentation", "session block omitted status", raw);
    }
    return {
      status,
      sessionEnded,
      ...(sessionUrlValue === undefined ? {} : { sessionUrl: sessionUrlValue }),
    };
  }
  const firstLine = lines[0] ?? "";
  if (firstLine.startsWith("error:")) {
    const message = firstLine.slice("error:".length).trim();
    const codeLine = lines.find((line, index) => index > 0 && /^code:\s*[A-Z_]+\s*$/u.test(line));
    const code = codeLine === undefined ? "" : codeLine.slice("code:".length).trim();
    if (code === "NOT_FOUND" || message.startsWith("No active Lavish Editor session")) {
      return { status: "missing", sessionEnded: false };
    }
    return { status: "error", sessionEnded: false };
  }
  throw new AdapterProtocolError(
    "lavish presentation",
    "response omitted a textual session or error envelope",
    raw,
  );
}

function extractRawFeedback(raw: string): string {
  const lines = raw.split(/\r?\n/u);
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || !/^(feedback|prompts)\[\d+\]\{[^}]*\}:\s*$/u.test(line)) {
      index += 1;
      continue;
    }
    const block = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined || (next.length !== 0 && !/^\s/u.test(next))) break;
      block.push(next);
      index += 1;
    }
    blocks.push(block.join("\n"));
  }
  return blocks.join("\n");
}

function parsePresentationObservation(artifact: string, raw: string): PresentationObservation {
  const fields = extractSessionFields(raw);
  const terminal = fields.status === "ended" || fields.status === "missing" || fields.sessionEnded;
  return {
    artifact,
    status: fields.status,
    terminal,
    sessionEnded: fields.sessionEnded,
    ...(fields.sessionUrl === undefined ? {} : { sessionUrl: fields.sessionUrl }),
    raw,
    rawFeedback: extractRawFeedback(raw),
  };
}

async function runPresentation(
  run: CommandRunner,
  artifact: string,
  argv: readonly string[],
  cwd: string,
  operation: string,
  options: Readonly<{ readonly commandTimeoutMs?: number }> = {},
): Promise<PresentationObservation> {
  const checkedArtifact = checkedPath(artifact, "artifact");
  const request: CommandRequest = {
    argv,
    cwd: checkedPath(cwd, "cwd"),
    ...(options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs }),
  };
  const result = await run(request);
  const raw = result.stdout.length === 0 ? result.stderr : result.stdout;
  if (raw.length === 0) throw new AdapterCommandError(operation, request, result);
  const observation = parsePresentationObservation(checkedArtifact, raw);
  if (result.code !== 0 && observation.status !== "error" && observation.status !== "missing") {
    throw new AdapterCommandError(operation, request, result);
  }
  return observation;
}

export async function openPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
): Promise<PresentationObservation> {
  return runPresentation(
    run,
    artifact,
    ["lavish-axi", checkedPath(artifact, "artifact")],
    cwd,
    "lavish presentation open",
  );
}

export async function pollPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
  options: PresentationPollOptions = DEFAULT_PRESENTATION_POLL_OPTIONS,
): Promise<PresentationObservation> {
  const { timeoutMs, commandTimeoutMs } = options;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(commandTimeoutMs) ||
    commandTimeoutMs <= timeoutMs
  ) {
    throw new TypeError(
      "presentation poll timeout must be a positive integer below its command timeout",
    );
  }
  return runPresentation(
    run,
    artifact,
    ["lavish-axi", "poll", checkedPath(artifact, "artifact"), "--timeout-ms", String(timeoutMs)],
    cwd,
    "lavish presentation poll",
    { commandTimeoutMs },
  );
}
export async function listenPresentation(
  run: CommandRunner,
  artifact: string,
  cwd: string,
): Promise<PresentationObservation> {
  return runPresentation(
    run,
    artifact,
    ["lavish-axi", "poll", checkedPath(artifact, "artifact")],
    cwd,
    "lavish presentation listen",
  );
}
