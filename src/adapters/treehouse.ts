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
  runChecked,
  type WorktreeAdapterOptions,
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
