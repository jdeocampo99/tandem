import {
  AdapterCommandError,
  AdapterProtocolError,
  ApprovalRequiredError,
  mergePullRequest,
  publishPullRequest,
  readCheckpoint,
} from "./adapters.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  PullRequestMetadata,
  ReviewLens,
  TaskRecord,
  ValidationEvidence,
} from "./contracts.ts";
import { renderPrDescription } from "./instructions.ts";

export type PrSummary = Readonly<{
  readonly tldr: readonly string[];
  readonly what: readonly string[];
  readonly why: readonly string[];
}>;

type RemoteCheck = Readonly<{
  readonly name: string;
  readonly required: boolean;
  readonly passed: boolean;
  readonly state: string;
  readonly conclusion: string;
}>;

type RemotePullRequest = PullRequestMetadata &
  Readonly<{
    readonly branch: string;
    readonly checks: readonly RemoteCheck[];
  }>;

type ReadyTask = Readonly<{
  readonly cwd: string;
  readonly branch: string;
  readonly head: string;
  readonly remote: string;
}>;

const REQUIRED_LENSES: readonly ReviewLens[] = ["behavior", "design", "coverage", "verification"];
const MAX_REMOTE_OUTPUT = 4 * 1024 * 1024;
const MAX_EVIDENCE_OUTPUT = 512;
const PASSING_CHECK_VALUES: Readonly<Record<string, true>> = {
  SUCCESS: true,
  SUCCESSFUL: true,
  PASS: true,
  PASSED: true,
  PASSING: true,
  GREEN: true,
};
const BLOCKING_CHECK_VALUES: Readonly<Record<string, true>> = {
  ERROR: true,
  FAIL: true,
  FAILED: true,
  FAILING: true,
  FAILURE: true,
  PENDING: true,
  QUEUED: true,
  IN_PROGRESS: true,
  EXPECTED: true,
  CANCELLED: true,
  CANCELED: true,
  SKIPPED: true,
  TIMED_OUT: true,
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text without NUL characters`);
  }
  return value.trim();
}

function readSingleLine(value: unknown, field: string): string {
  const text = readText(value, field);
  if (/[\r\n\u2028\u2029]/u.test(text)) {
    throw new TypeError(`${field} must be a single-line value`);
  }
  return text;
}

function readRunner(run: unknown): CommandRunner {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  return run as CommandRunner;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return String(error);
}

async function runChecked(
  run: CommandRunner,
  request: CommandRequest,
  operation: string,
): Promise<CommandResult> {
  const result = await run(request);
  if (
    !isRecord(result) ||
    typeof result.code !== "number" ||
    !Number.isSafeInteger(result.code) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw new AdapterProtocolError(
      operation,
      "command runner returned malformed result",
      String(result),
    );
  }
  if (result.code !== 0) throw new AdapterCommandError(operation, request, result as CommandResult);
  return result as CommandResult;
}

async function readGitText(
  run: CommandRunner,
  cwd: string,
  args: readonly string[],
  operation: string,
): Promise<string> {
  const request: CommandRequest = { argv: ["git", "-C", cwd, ...args], cwd };
  const result = await runChecked(run, request, operation);
  const text = result.stdout.trim();
  if (text.length === 0)
    throw new AdapterProtocolError(operation, "git returned empty stdout", result.stdout);
  return text;
}

async function readCleanCheckpoint(run: CommandRunner, cwd: string): Promise<string> {
  const checkpoint = await readCheckpoint(run, { repo: cwd });
  if (checkpoint.dirty || checkpoint.unmerged) {
    throw new Error("delivery requires a clean task worktree with no unmerged paths");
  }
  return checkpoint.head;
}

function repositoryFromRemote(value: string): string {
  const remote = value.trim().replace(/[\r\n]+/gu, "");
  if (remote.length === 0) {
    throw new AdapterProtocolError("delivery remote identity", "origin URL was empty", value);
  }

  let pathPart: string | undefined;
  try {
    const parsed = new URL(remote);
    if (parsed.hostname.toLowerCase() === "github.com") pathPart = parsed.pathname;
  } catch {
    if (remote.startsWith("git@github.com:")) pathPart = remote.slice("git@github.com:".length);
    if (remote.startsWith("ssh://git@github.com/")) {
      pathPart = remote.slice("ssh://git@github.com/".length);
    }
  }

  if (pathPart === undefined && /^[^\s/]+\/[^\s/]+(?:\.git)?$/u.test(remote)) pathPart = remote;
  if (pathPart === undefined) {
    throw new AdapterProtocolError(
      "delivery remote identity",
      `origin URL ${JSON.stringify(remote)} is not a GitHub repository URL`,
      remote,
    );
  }

  const repository = pathPart.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (!/^[^\s/]+\/[^\s/]+$/u.test(repository)) {
    throw new AdapterProtocolError(
      "delivery remote identity",
      `origin URL ${JSON.stringify(remote)} did not identify owner/repository`,
      remote,
    );
  }
  return repository;
}

function assertRepositoryIdentity(remote: string, expected: string): void {
  const observed = repositoryFromRemote(remote);
  if (observed !== expected) {
    throw new Error(
      `task repository ${JSON.stringify(expected)} does not match origin ${JSON.stringify(observed)}`,
    );
  }
}

function assertEvidence(task: TaskRecord, head: string): readonly ValidationEvidence[] {
  if (!Array.isArray(task.validationEvidence) || task.validationEvidence.length === 0) {
    throw new Error("delivery requires nonempty validation evidence");
  }

  const evidence: ValidationEvidence[] = [];
  for (const candidate of task.validationEvidence) {
    if (!isRecord(candidate)) {
      throw new Error("delivery requires complete validation evidence bound to the reviewed HEAD");
    }
    const name = candidate.name;
    const argv = candidate.argv;
    const exitCode = candidate.exitCode;
    const stdout = candidate.stdout;
    const stderr = candidate.stderr;
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((argument) => typeof argument !== "string" || argument.length === 0) ||
      typeof exitCode !== "number" ||
      !Number.isSafeInteger(exitCode) ||
      typeof stdout !== "string" ||
      typeof stderr !== "string" ||
      candidate.head !== head
    ) {
      throw new Error("delivery requires complete validation evidence bound to the reviewed HEAD");
    }
    if (exitCode !== 0) {
      throw new Error(`delivery requires successful validation; ${name} exited with ${exitCode}`);
    }
    evidence.push(candidate as ValidationEvidence);
  }
  return evidence;
}

function assertCurrentReviews(task: TaskRecord, head: string): void {
  if (!Array.isArray(task.reviews)) throw new Error("delivery requires recorded review lenses");
  const current = task.reviews.filter(
    (review) => review.head === head && review.generation === task.generation,
  );
  if (current.length !== REQUIRED_LENSES.length) {
    throw new Error("delivery requires exactly one current result for each review lens");
  }
  for (const lens of REQUIRED_LENSES) {
    const matching = current.filter((review) => review.lens === lens);
    if (matching.length !== 1 || matching[0]?.pass !== true) {
      throw new Error(`delivery requires a passing current ${lens} review`);
    }
  }
}

function assertTaskShape(
  task: TaskRecord,
): Readonly<{ cwd: string; branch: string; head: string }> {
  if (!isRecord(task)) throw new TypeError("task must be a TaskRecord");
  if (task.stage !== "ready") throw new Error(`task ${String(task.id)} is not ready for delivery`);
  if (task.scopeApproved !== true)
    throw new Error(`task ${String(task.id)} has not received scope approval`);
  if (!isRecord(task.worktree)) throw new Error("delivery requires a task worktree lease");

  const cwd = readSingleLine(task.worktree.path, "task.worktree.path");
  const branch = readSingleLine(task.worktree.branch, "task.worktree.branch");
  const head = readSingleLine(task.reviewHead, "task.reviewHead");
  if (!Number.isSafeInteger(task.generation) || task.generation < 0) {
    throw new Error("delivery requires a non-negative task generation");
  }
  assertEvidence(task, head);
  assertCurrentReviews(task, head);
  return { cwd, branch, head };
}

async function assertReadyCheckout(run: CommandRunner, task: TaskRecord): Promise<ReadyTask> {
  const shape = assertTaskShape(task);
  const actualHead = await readCleanCheckpoint(run, shape.cwd);
  if (actualHead !== shape.head) {
    throw new Error(
      `task worktree HEAD ${JSON.stringify(actualHead)} does not match reviewed HEAD ${JSON.stringify(shape.head)}`,
    );
  }
  const actualBranch = await readGitText(
    run,
    shape.cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "delivery worktree branch",
  );
  if (actualBranch !== shape.branch) {
    throw new Error(
      `task worktree branch ${JSON.stringify(actualBranch)} does not match task branch ${JSON.stringify(shape.branch)}`,
    );
  }
  const remote = await readGitText(
    run,
    shape.cwd,
    ["remote", "get-url", "origin"],
    "delivery remote identity",
  );
  return { cwd: shape.cwd, branch: shape.branch, head: shape.head, remote };
}

async function assertUnchangedCheckout(run: CommandRunner, ready: ReadyTask): Promise<void> {
  const actualHead = await readCleanCheckpoint(run, ready.cwd);
  if (actualHead !== ready.head) {
    throw new Error(`reviewed HEAD changed before delivery: ${JSON.stringify(actualHead)}`);
  }
  const actualBranch = await readGitText(
    run,
    ready.cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "delivery reviewed branch",
  );
  if (actualBranch !== ready.branch) {
    throw new Error(`task branch changed before delivery: ${JSON.stringify(actualBranch)}`);
  }
}

function evidenceOutput(value: string): string {
  const compact = value.replace(/[\r\n]+/gu, "\\n");
  const bounded =
    compact.length <= MAX_EVIDENCE_OUTPUT
      ? compact
      : `${compact.slice(0, MAX_EVIDENCE_OUTPUT - 1)}…`;
  return JSON.stringify(bounded);
}

function evidenceBullet(entry: ValidationEvidence): string {
  const argv = entry.argv.map((argument) => JSON.stringify(argument)).join(" ");
  return `${entry.name}: exit code ${entry.exitCode} at reviewed HEAD ${entry.head}; argv ${argv}; stdout ${evidenceOutput(entry.stdout)}; stderr ${evidenceOutput(entry.stderr)}`;
}

function validateSummary(summary: PrSummary): PrSummary {
  if (!isRecord(summary)) throw new TypeError("summary must be a PrSummary");
  return { tldr: summary.tldr, what: summary.what, why: summary.why };
}

export function describeTaskPr(task: TaskRecord, summary: PrSummary): string {
  const shape = assertTaskShape(task);
  const evidence = assertEvidence(task, shape.head);
  const validatedSummary = validateSummary(summary);
  return renderPrDescription({
    tldr: validatedSummary.tldr,
    what: validatedSummary.what,
    why: validatedSummary.why,
    validation: evidence.map(evidenceBullet),
  });
}

function parseJson(value: string, operation: string): unknown {
  if (value.length > MAX_REMOTE_OUTPUT) {
    throw new AdapterProtocolError(
      operation,
      "response exceeded the capture limit",
      value.slice(0, 1024),
    );
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new AdapterProtocolError(operation, describeError(error), value);
  }
}

function optionalRemoteText(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || /[\r\n\u2028\u2029]/u.test(value)) {
    throw new AdapterProtocolError(
      operation,
      `${field} must be a single-line string when present`,
      response,
    );
  }
  return value;
}

function requiredRemoteText(
  value: unknown,
  field: string,
  operation: string,
  response: string,
): string {
  const text = optionalRemoteText(value, field, operation, response);
  if (text === undefined)
    throw new AdapterProtocolError(operation, `${field} is required`, response);
  return text;
}

function parsePullRequest(
  value: unknown,
  repository: string,
  operation: string,
  response: string,
): PullRequestMetadata {
  if (!isRecord(value))
    throw new AdapterProtocolError(operation, "pull request must be an object", response);
  const number = value.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new AdapterProtocolError(operation, "number must be a positive integer", response);
  }
  const stateText = requiredRemoteText(value.state, "state", operation, response).toLowerCase();
  if (stateText !== "open" && stateText !== "closed" && stateText !== "merged") {
    throw new AdapterProtocolError(
      operation,
      `unsupported pull request state ${stateText}`,
      response,
    );
  }
  const isDraft = value.isDraft;
  if (typeof isDraft !== "boolean") {
    throw new AdapterProtocolError(operation, "isDraft must be boolean", response);
  }
  const head = requiredRemoteText(value.headRefOid, "headRefOid", operation, response);
  const base = requiredRemoteText(value.baseRefName, "baseRefName", operation, response);
  const url = optionalRemoteText(value.url, "url", operation, response);
  const title = optionalRemoteText(value.title, "title", operation, response);
  return {
    repository,
    number,
    state: stateText === "open" && isDraft ? "draft" : stateText,
    head,
    base,
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
  };
}

function parseExistingPullRequests(
  value: unknown,
  repository: string,
  branch: string,
  base: string,
  response: string,
): readonly PullRequestMetadata[] {
  if (!Array.isArray(value)) {
    throw new AdapterProtocolError(
      "delivery pull request observation",
      "response must be an array",
      response,
    );
  }
  const records: PullRequestMetadata[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw new AdapterProtocolError(
        "delivery pull request observation",
        "entry must be an object",
        response,
      );
    }
    const parsed = parsePullRequest(
      candidate,
      repository,
      "delivery pull request observation",
      response,
    );
    const observedBranch = requiredRemoteText(
      candidate.headRefName,
      "headRefName",
      "delivery pull request observation",
      response,
    );
    if (observedBranch !== branch || parsed.base !== base || parsed.repository !== repository) {
      throw new Error(
        "observed pull request identity does not match the task branch, base, or repository",
      );
    }
    records.push(parsed);
  }
  return records;
}

async function observeExistingPullRequest(
  run: CommandRunner,
  cwd: string,
  repository: string,
  branch: string,
  base: string,
): Promise<PullRequestMetadata | undefined> {
  const request: CommandRequest = {
    argv: [
      "gh",
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      branch,
      "--base",
      base,
      "--state",
      "all",
      "--json",
      "number,url,state,isDraft,headRefName,headRefOid,baseRefName,title",
    ],
    cwd,
  };
  const result = await runChecked(run, request, "delivery pull request observation");
  const records = parseExistingPullRequests(
    parseJson(result.stdout, "delivery pull request observation"),
    repository,
    branch,
    base,
    result.stdout,
  );
  if (records.length > 1) {
    throw new Error(`multiple pull requests already exist for ${repository}:${branch}`);
  }
  const existing = records[0];
  if (existing === undefined) return undefined;
  if (existing.state === "closed" || existing.state === "merged") {
    throw new Error(
      `existing pull request #${existing.number} is ${existing.state}; refusing to create a duplicate`,
    );
  }
  return existing;
}

function assertPublishedMetadata(
  metadata: PullRequestMetadata,
  repository: string,
  base: string,
  head: string,
): PullRequestMetadata {
  if (
    metadata.repository !== repository ||
    metadata.base !== base ||
    metadata.head !== head ||
    (metadata.state !== "open" && metadata.state !== "draft")
  ) {
    throw new Error(
      "published pull request metadata does not match the reviewed repository, base, or HEAD",
    );
  }
  return metadata;
}

async function pushExactBranch(
  run: CommandRunner,
  cwd: string,
  branch: string,
  reviewedHead: string,
): Promise<void> {
  const request: CommandRequest = {
    argv: ["git", "-C", cwd, "push", "origin", `${reviewedHead}:refs/heads/${branch}`],
    cwd,
  };
  await runChecked(run, request, "delivery branch push");
}

export async function publishReviewedTask(input: {
  readonly task: TaskRecord;
  readonly summary: PrSummary;
  readonly repository: string;
  readonly title: string;
  readonly base: string;
  readonly approved: boolean;
  readonly run: CommandRunner;
}): Promise<PullRequestMetadata> {
  if (!input.approved) throw new ApprovalRequiredError("pull request publish");
  const run = readRunner(input.run);
  const repository = readSingleLine(input.repository, "repository");
  const title = readSingleLine(input.title, "title");
  const base = readSingleLine(input.base, "base");
  if (!/^[^\s/]+\/[^\s/]+$/u.test(repository)) {
    throw new TypeError("repository must be an owner/repository name");
  }

  const ready = await assertReadyCheckout(run, input.task);
  assertRepositoryIdentity(ready.remote, repository);
  const body = describeTaskPr(input.task, input.summary);
  const existing = await observeExistingPullRequest(run, ready.cwd, repository, ready.branch, base);
  if (existing !== undefined && existing.head === ready.head) return existing;

  if (existing !== undefined) {
    await pushExactBranch(run, ready.cwd, ready.branch, ready.head);
    const refreshed = await observeExistingPullRequest(
      run,
      ready.cwd,
      repository,
      ready.branch,
      base,
    );
    if (refreshed === undefined || refreshed.head !== ready.head) {
      throw new Error("existing pull request did not advance to the reviewed HEAD after push");
    }
    return refreshed;
  }

  await pushExactBranch(run, ready.cwd, ready.branch, ready.head);
  const raced = await observeExistingPullRequest(run, ready.cwd, repository, ready.branch, base);
  if (raced !== undefined) {
    if (raced.head !== ready.head) {
      throw new Error("a concurrent pull request does not point to the reviewed HEAD");
    }
    return raced;
  }

  const created = await publishPullRequest(run, {
    cwd: ready.cwd,
    repository,
    title,
    body,
    base,
    head: ready.branch,
  });
  return assertPublishedMetadata(created, repository, base, ready.head);
}

function parseRemoteCheck(value: unknown, index: number, response: string): RemoteCheck {
  if (!isRecord(value)) {
    throw new AdapterProtocolError(
      "delivery CI observation",
      `check ${index} must be an object`,
      response,
    );
  }
  const name = requiredRemoteText(
    value.name ?? value.context,
    `checks[${index}].name`,
    "delivery CI observation",
    response,
  );
  const requiredValue = value.isRequired ?? value.required;
  if (requiredValue !== undefined && typeof requiredValue !== "boolean") {
    throw new AdapterProtocolError(
      "delivery CI observation",
      `checks[${index}].isRequired must be boolean`,
      response,
    );
  }
  const required = requiredValue === undefined ? true : requiredValue;
  const state = typeof value.state === "string" ? value.state.toUpperCase() : "";
  const status = typeof value.status === "string" ? value.status.toUpperCase() : "";
  const conclusion = typeof value.conclusion === "string" ? value.conclusion.toUpperCase() : "";
  const bucket = typeof value.bucket === "string" ? value.bucket.toUpperCase() : "";
  const passedIndicator =
    PASSING_CHECK_VALUES[state] === true ||
    PASSING_CHECK_VALUES[status] === true ||
    PASSING_CHECK_VALUES[conclusion] === true ||
    PASSING_CHECK_VALUES[bucket] === true;
  const blockedIndicator =
    BLOCKING_CHECK_VALUES[state] === true ||
    BLOCKING_CHECK_VALUES[status] === true ||
    BLOCKING_CHECK_VALUES[conclusion] === true ||
    BLOCKING_CHECK_VALUES[bucket] === true;
  return {
    name,
    required,
    passed: passedIndicator && !blockedIndicator,
    state: state || status,
    conclusion: conclusion || bucket,
  };
}

function parseRemotePullRequest(
  value: unknown,
  expected: PullRequestMetadata,
  expectedBranch: string,
  response: string,
): RemotePullRequest {
  if (!isRecord(value)) {
    throw new AdapterProtocolError(
      "delivery pull request precondition",
      "response must be an object",
      response,
    );
  }
  const metadata = parsePullRequest(
    value,
    expected.repository,
    "delivery pull request precondition",
    response,
  );
  const branch = requiredRemoteText(
    value.headRefName,
    "headRefName",
    "delivery pull request precondition",
    response,
  );
  if (
    metadata.number !== expected.number ||
    metadata.repository !== expected.repository ||
    metadata.head !== expected.head ||
    metadata.base !== expected.base ||
    branch !== expectedBranch
  ) {
    throw new Error("remote pull request identity no longer matches the reviewed task");
  }
  if (metadata.state !== "open" || value.isDraft !== false) {
    throw new Error(`pull request #${metadata.number} is not an open, non-draft pull request`);
  }
  const rawChecks = value.statusCheckRollup ?? value.checks;
  if (!Array.isArray(rawChecks)) {
    throw new AdapterProtocolError(
      "delivery CI observation",
      "statusCheckRollup must be a nonempty array",
      response,
    );
  }
  const checks = rawChecks.map((check, index) => parseRemoteCheck(check, index, response));
  return { ...metadata, branch, checks };
}

async function observePullRequestForMerge(
  run: CommandRunner,
  cwd: string,
  pullRequest: PullRequestMetadata,
  branch: string,
): Promise<RemotePullRequest> {
  const request: CommandRequest = {
    argv: [
      "gh",
      "pr",
      "view",
      String(pullRequest.number),
      "--repo",
      pullRequest.repository,
      "--json",
      "number,url,state,isDraft,headRefName,headRefOid,baseRefName,title,statusCheckRollup",
    ],
    cwd,
  };
  const result = await runChecked(run, request, "delivery pull request precondition");
  return parseRemotePullRequest(
    parseJson(result.stdout, "delivery pull request precondition"),
    pullRequest,
    branch,
    result.stdout,
  );
}

function assertRequiredChecks(checks: readonly RemoteCheck[]): void {
  const required = checks.filter((check) => check.required);
  if (required.length === 0) throw new Error("merge requires nonempty required CI evidence");
  const failed = required.filter((check) => !check.passed);
  if (failed.length !== 0) {
    const descriptions = failed.map(
      (check) => `${check.name} (${check.state || check.conclusion || "unknown"})`,
    );
    throw new Error(`required CI is not successful: ${descriptions.join(", ")}`);
  }
}

export async function mergeReviewedTask(input: {
  readonly task: TaskRecord;
  readonly approved: boolean;
  readonly method: "merge" | "squash" | "rebase";
  readonly run: CommandRunner;
}): Promise<PullRequestMetadata> {
  if (!input.approved) throw new ApprovalRequiredError("pull request merge");
  const run = readRunner(input.run);
  if (input.method !== "merge" && input.method !== "squash" && input.method !== "rebase") {
    throw new TypeError("pull request merge method is unsupported");
  }
  const pullRequest = input.task.pullRequest;
  if (pullRequest === undefined) throw new Error("merge requires an observed pull request");

  const ready = await assertReadyCheckout(run, input.task);
  assertRepositoryIdentity(ready.remote, pullRequest.repository);
  if (pullRequest.head !== ready.head) {
    throw new Error("pull request head does not match the reviewed task HEAD");
  }
  if (pullRequest.base.length === 0) throw new Error("pull request base must be non-empty");

  const observed = await observePullRequestForMerge(run, ready.cwd, pullRequest, ready.branch);
  assertRequiredChecks(observed.checks);
  await assertUnchangedCheckout(run, ready);
  const merged = await mergePullRequest(run, {
    cwd: ready.cwd,
    repository: pullRequest.repository,
    number: pullRequest.number,
    expectedHead: ready.head,
    method: input.method,
    approved: true,
  });
  if (
    merged.repository !== pullRequest.repository ||
    merged.base !== pullRequest.base ||
    merged.head !== ready.head ||
    merged.state !== "merged"
  ) {
    throw new Error("merged pull request metadata does not match the reviewed task identity");
  }
  return merged;
}
