import { realpath as defaultRealpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { CommandRequest, CommandRunner, WorktreeLease } from "../contracts.ts";
import {
  AdapterCommandError,
  AdapterProtocolError,
  ApprovalRequiredError,
  checkedPath,
  checkedText,
  type JsonRecord,
  LeaseSafetyError,
  parseJson,
  readGitText,
  requiredRecord,
  requiredString,
  requireSuccess,
  runChecked,
  type WorktreeAdapterOptions,
  WorktreeInUseError,
} from "./primitives.ts";

type LeaseMetadata = Readonly<{
  path: string;
  leaseId: string;
  leaseHolder: string;
  leasedAt: string;
}>;
function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"));
}

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
  sourceHead: string;
  /**
   * Take over the scout lease `tandemId` already holds instead of leasing a new worktree. The
   * scout checkout must still be clean on `branch` at `head`; it then moves to the task branch at
   * `sourceHead`. Treehouse cannot relabel a lease, so the scout's holder stays on it.
   */
  adopt?: Readonly<{ branch: string; head: string }>;
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
function checkedSourceHead(value: string): string {
  const sourceHead = checkedText(value, "sourceHead");
  if (!/^[0-9a-f]{40}$/u.test(sourceHead)) {
    throw new TypeError("sourceHead must be a full 40-character commit SHA");
  }
  return sourceHead;
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
  const sourceHead = checkedSourceHead(input.sourceHead);
  const path = reportedLeasePath(repo, metadata.path);
  const branch = safeTaskBranchName(taskName);
  let lease = leaseFromMetadata(metadata, root, path, taskName, sourceHead, branch);

  try {
    // Four independent reads of the primary checkout and the worktree, issued together.
    const [primaryRoot, reportedRoot, primaryCommonDir, worktreeCommonDir] = await Promise.all([
      readGitText(run, repo, ["rev-parse", "--show-toplevel"], "git primary root"),
      readGitText(run, path, ["rev-parse", "--show-toplevel"], "git worktree root"),
      readGitText(run, repo, ["rev-parse", "--git-common-dir"], "git primary common dir"),
      readGitText(run, path, ["rev-parse", "--git-common-dir"], "git worktree common dir"),
    ]);
    const repoRoot = resolve(primaryRoot);
    const worktreeRoot = resolve(reportedRoot);
    const physicalResolver = options.realpath ?? defaultRealpath;
    const [
      physicalOwnedRoot,
      physicalRepoRoot,
      physicalWorktreeRoot,
      physicalReportedPath,
      physicalRepoCommon,
      physicalWorktreeCommon,
    ] = await Promise.all([
      physicalResolver(root),
      physicalResolver(repoRoot),
      physicalResolver(worktreeRoot),
      physicalResolver(path),
      physicalResolver(resolve(repoRoot, primaryCommonDir)),
      physicalResolver(resolve(worktreeRoot, worktreeCommonDir)),
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
    if (physicalRepoCommon !== physicalWorktreeCommon) {
      throw new LeaseSafetyError(
        "acquired worktree does not share the primary repository's Git common directory",
        lease,
      );
    }

    // Four independent reads, issued together; each result is judged below in the order the
    // reads would otherwise have run, so the first problem found is the one reported.
    const sourceRequest: CommandRequest = {
      argv: ["git", "-C", repo, "cat-file", "-e", `${sourceHead}^{commit}`],
      cwd: repo,
    };
    const branchRequest: CommandRequest = {
      argv: ["git", "-C", path, "branch", "--show-current"],
      cwd: path,
    };
    const statusRequest: CommandRequest = {
      argv: ["git", "-C", path, "status", "--porcelain=v1", "--untracked-files=all"],
      cwd: path,
    };
    const unmergedRequest: CommandRequest = {
      argv: ["git", "-C", path, "diff", "--name-only", "--diff-filter=U"],
      cwd: path,
    };
    const [sourceResult, branchResult, statusResult, unmergedResult] = await Promise.all([
      run(sourceRequest),
      run(branchRequest),
      run(statusRequest),
      run(unmergedRequest),
    ]);
    requireSuccess(sourceResult, sourceRequest, "git source HEAD validation");
    const baseHead = sourceHead;
    lease = leaseFromMetadata(metadata, root, path, taskName, baseHead, branch);

    requireSuccess(branchResult, branchRequest, "git worktree branch identity");
    const actualBranch = branchResult.stdout.trim();
    const reusesTaskBranch = actualBranch === branch && existingLease;
    const adopting =
      existingLease && input.adopt !== undefined && actualBranch === input.adopt.branch;
    if (!reusesTaskBranch && actualBranch !== "" && !adopting) {
      throw new LeaseSafetyError(
        `acquired worktree branch is ${JSON.stringify(actualBranch)}, expected detached checkout or task ${JSON.stringify(branch)}`,
        lease,
      );
    }
    const subject = reusesTaskBranch ? "existing task worktree" : "task worktree";
    requireSuccess(statusResult, statusRequest, `git ${subject} status`);
    requireSuccess(unmergedResult, unmergedRequest, `git ${subject} unmerged check`);
    if (statusResult.stdout.trim() !== "" || unmergedResult.stdout.trim() !== "") {
      throw new LeaseSafetyError(
        reusesTaskBranch
          ? "existing task worktree is dirty or has unmerged paths"
          : "acquired worktree is dirty or has unmerged paths",
        lease,
      );
    }
    if (reusesTaskBranch) return lease;
    if (adopting && input.adopt !== undefined) {
      const scoutHead = await readGitText(run, path, ["rev-parse", "HEAD"], "git scout HEAD");
      if (scoutHead !== input.adopt.head) {
        throw new LeaseSafetyError(
          `scout worktree HEAD ${scoutHead} is not its source commit ${input.adopt.head}`,
          lease,
        );
      }
    }
    await createTaskBranch(run, path, branch, sourceHead, lease);
    if (adopting && input.adopt !== undefined) {
      // ponytail: best effort; `-d` refuses a scout branch holding commits, which then stays put.
      await run({ argv: ["git", "-C", path, "branch", "-d", input.adopt.branch], cwd: path });
    }
    const switchedBranch = await readGitText(
      run,
      path,
      ["branch", "--show-current"],
      "git task branch verify",
    );
    const switchedHead = await readGitText(
      run,
      path,
      ["rev-parse", "HEAD"],
      "git task HEAD verify",
    );
    if (switchedBranch !== branch || switchedHead !== sourceHead) {
      throw new LeaseSafetyError(
        `git created ${JSON.stringify(switchedBranch)} at ${JSON.stringify(switchedHead)} instead of ${JSON.stringify(branch)} at ${JSON.stringify(sourceHead)}`,
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

/**
 * Creates the task branch at the pinned source. Coordinator branch names are derived from the
 * repository and session, so a recreated Tandem home asks for a branch an earlier home left
 * behind. That branch is moved to the source only when it holds no commits beyond it; git itself
 * still refuses when another worktree has it checked out.
 */
async function createTaskBranch(
  run: CommandRunner,
  path: string,
  branch: string,
  sourceHead: string,
  lease: WorktreeLease,
): Promise<void> {
  const create = (flag: "-c" | "-C"): CommandRequest => ({
    argv: ["git", "-C", path, "switch", "--no-overwrite-ignore", flag, branch, sourceHead],
    cwd: path,
  });
  const request = create("-c");
  const created = await run(request);
  if (created.code === 0) return;
  const leftover = await run({
    argv: ["git", "-C", path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd: path,
  });
  if (leftover.code !== 0) {
    requireSuccess(created, request, "git task branch create");
    return;
  }
  const contained = await run({
    argv: ["git", "-C", path, "merge-base", "--is-ancestor", leftover.stdout.trim(), sourceHead],
    cwd: path,
  });
  if (contained.code !== 0) {
    throw new LeaseSafetyError(
      `branch ${JSON.stringify(branch)} already exists with commits that are not in ${sourceHead}; rename or delete it to continue`,
      lease,
    );
  }
  await runChecked(run, create("-C"), "git task branch reuse");
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
  const sourceHead = checkedSourceHead(input.sourceHead);
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
  if (input.adopt !== undefined) {
    throw new AdapterProtocolError(
      "treehouse lease adopt",
      `no lease is held by ${JSON.stringify(tandemId)} to adopt`,
      statusResult.stdout,
    );
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
  const acquiredLease = leaseFromMetadata(metadata, root, path, taskName, sourceHead, branch);
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

/** Returns the lease's one status record after proving its identity is unchanged. */
function verifyLeaseMetadata(value: unknown, lease: WorktreeLease, response: string): JsonRecord {
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
  return record;
}

/**
 * Names each process Treehouse reports running inside a worktree, such as "pid 42 herdr".
 * `treehouse return` terminates them, so any one of them means the worktree is still in use.
 */
function worktreeProcessNames(processes: unknown): readonly string[] {
  if (!Array.isArray(processes)) return [];
  return processes.map((process: unknown) => {
    if (typeof process !== "object" || process === null) return "an unnamed process";
    const { pid, name } = process as { pid?: unknown; name?: unknown };
    return (
      [typeof pid === "number" ? `pid ${pid}` : "", typeof name === "string" ? name : ""]
        .filter((part) => part !== "")
        .join(" ") || "an unnamed process"
    );
  });
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
    const record = verifyLeaseMetadata(
      parseJson(statusResult.stdout, "treehouse lease status"),
      lease,
      statusResult.stdout,
    );
    // Returning ends every process inside; one may be the Herdr server all panes depend on.
    const processes = worktreeProcessNames(record.processes);
    if (processes.length > 0) throw new WorktreeInUseError(processes, lease);
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
    const detail = error instanceof Error ? error.message : String(error);
    throw new LeaseSafetyError(
      `treehouse lease release could not be proven safe: ${detail}`,
      lease,
      error,
    );
  }
  return { released: true, lease };
}
