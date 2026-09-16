import { realpath as defaultRealpath, statfs as defaultStatfs } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  destroyTreehouseWorktree,
  inspectPoolWorktree,
  type PoolWorktreeSafety,
  readTreehousePoolStatus,
  type TreehousePoolStatusRecord,
} from "./adapters.ts";
import type { CommandRunner } from "./contracts.ts";

const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;

type AvailableSpaceReader = (path: string) => Promise<number | null>;
type RealpathReader = (path: string) => Promise<string>;

type AbsolutePathReference = Readonly<{
  absolutePath: string;
  physicalPath: string | undefined;
  physicalError: string | undefined;
}>;

type StatusEntry = Readonly<{
  record: TreehousePoolStatusRecord;
  absolutePath: string;
  physicalPath: string | undefined;
  physicalError: string | undefined;
}>;

type PoolCandidate = Readonly<{
  entry: StatusEntry;
}>;

type PhysicalRoot = Readonly<{
  path: string | undefined;
  exact: boolean;
  error: string | undefined;
}>;

type CapacityObservation = Readonly<{
  availableBytes: number | null;
  warning: string | undefined;
}>;

export type PoolMaintenanceInput = Readonly<{
  repo: string;
  root: string;
  managedPaths: readonly string[];
  protectedPaths: readonly string[];
  retainIdle: number;
  minimumFreeBytes?: number;
}>;

export type PoolMaintenanceResult = Readonly<{
  canAllocate: boolean;
  availableBytes: number | null;
  removedPaths: readonly string[];
  retainedPaths: readonly string[];
  warnings: readonly string[];
  allocationBlocker?: string;
}>;

export type PoolMaintenanceOptions = Readonly<{
  realpath?: RealpathReader;
  availableBytes?: AvailableSpaceReader;
}>;

function checkedText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  return value;
}

function checkedAbsolutePath(repo: string, value: unknown, field: string): string {
  const text = checkedText(value, field);
  return isAbsolute(text) ? resolve(text) : resolve(repo, text);
}

function checkedNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function validateInput(input: PoolMaintenanceInput): Readonly<{
  repo: string;
  root: string;
  managedPaths: readonly string[];
  protectedPaths: readonly string[];
  retainIdle: number;
  minimumFreeBytes: number;
}> {
  if (typeof input !== "object" || input === null)
    throw new TypeError("pool maintenance input is required");
  const repo = resolve(checkedText(input.repo, "repo"));
  const root = checkedAbsolutePath(repo, input.root, "root");
  if (!Array.isArray(input.managedPaths)) throw new TypeError("managedPaths must be an array");
  if (!Array.isArray(input.protectedPaths)) throw new TypeError("protectedPaths must be an array");
  const managedPaths = input.managedPaths.map((path, index) =>
    checkedAbsolutePath(repo, path, `managedPaths[${index}]`),
  );
  const protectedPaths = input.protectedPaths.map((path, index) =>
    checkedAbsolutePath(repo, path, `protectedPaths[${index}]`),
  );
  const retainIdle = checkedNonNegativeInteger(input.retainIdle, "retainIdle");
  const minimumFreeBytes =
    input.minimumFreeBytes === undefined
      ? DEFAULT_MINIMUM_FREE_BYTES
      : checkedNonNegativeInteger(input.minimumFreeBytes, "minimumFreeBytes");
  return { repo, root, managedPaths, protectedPaths, retainIdle, minimumFreeBytes };
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"));
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort(comparePaths);
}

function duplicateValues(values: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

function readAvailableValue(value: number | null, path: string): CapacityObservation {
  if (value === null) {
    return {
      availableBytes: null,
      warning: `available space for ${JSON.stringify(path)} is unknown`,
    };
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return {
      availableBytes: null,
      warning: `available space for ${JSON.stringify(path)} was invalid`,
    };
  }
  return { availableBytes: value, warning: undefined };
}

async function readStatfsAvailableBytes(path: string): Promise<number | null> {
  const stats = await defaultStatfs(path, { bigint: true });
  const available = stats.bavail * stats.bsize;
  const maximumSafeBytes = BigInt(Number.MAX_SAFE_INTEGER);
  return available >= 0n && available <= maximumSafeBytes ? Number(available) : null;
}

async function readAvailableSpace(
  root: string,
  reader: AvailableSpaceReader,
): Promise<CapacityObservation> {
  let path = root;
  while (true) {
    try {
      return readAvailableValue(await reader(path), path);
    } catch (error) {
      if (!isMissingPath(error)) {
        return {
          availableBytes: null,
          warning: `could not determine available space for ${JSON.stringify(path)}: ${describeFailure(error)}`,
        };
      }
      const parent = dirname(path);
      if (parent === path) {
        return {
          availableBytes: null,
          warning: "could not determine available space on the pool filesystem",
        };
      }
      path = parent;
    }
  }
}

async function resolvePhysicalPath(
  path: string,
  realpath: RealpathReader,
): Promise<Readonly<{ path: string | undefined; error: string | undefined }>> {
  try {
    return { path: resolve(await realpath(path)), error: undefined };
  } catch (error) {
    return { path: undefined, error: describeFailure(error) };
  }
}

async function resolvePhysicalRoot(root: string, realpath: RealpathReader): Promise<PhysicalRoot> {
  let path = root;
  while (true) {
    try {
      return { path: resolve(await realpath(path)), exact: path === root, error: undefined };
    } catch (error) {
      if (!isMissingPath(error)) {
        return { path: undefined, exact: false, error: describeFailure(error) };
      }
      const parent = dirname(path);
      if (parent === path) {
        return { path: undefined, exact: false, error: "no existing ancestor" };
      }
      path = parent;
    }
  }
}

async function resolveReferences(
  paths: readonly string[],
  realpath: RealpathReader,
): Promise<readonly AbsolutePathReference[]> {
  return Promise.all(
    paths.map(async (absolutePath) => {
      const physical = await resolvePhysicalPath(absolutePath, realpath);
      return {
        absolutePath,
        physicalPath: physical.path,
        physicalError: physical.error,
      };
    }),
  );
}

async function resolveStatusEntries(
  repo: string,
  records: readonly TreehousePoolStatusRecord[],
  realpath: RealpathReader,
): Promise<StatusEntry[]> {
  return Promise.all(
    records.map(async (record) => {
      const absolutePath = checkedAbsolutePath(repo, record.path, "treehouse status path");
      const physical = await resolvePhysicalPath(absolutePath, realpath);
      return {
        record,
        absolutePath,
        physicalPath: physical.path,
        physicalError: physical.error,
      };
    }),
  );
}

function matchingReferences(
  entry: StatusEntry,
  references: readonly AbsolutePathReference[],
): readonly AbsolutePathReference[] {
  return references.filter(
    (reference) =>
      reference.absolutePath === entry.absolutePath ||
      (entry.physicalPath !== undefined && reference.physicalPath === entry.physicalPath),
  );
}

function matchesProtectedPath(
  entry: StatusEntry,
  references: readonly AbsolutePathReference[],
): boolean {
  return references.some(
    (reference) =>
      reference.absolutePath === entry.absolutePath ||
      (entry.physicalPath !== undefined && reference.physicalPath === entry.physicalPath),
  );
}

function metadataReason(
  entry: StatusEntry,
  matching: readonly AbsolutePathReference[],
  protectedPaths: readonly AbsolutePathReference[],
  physicalRoot: PhysicalRoot,
  duplicateManaged: ReadonlySet<string>,
  duplicateStatus: ReadonlySet<string>,
  duplicateNames: ReadonlySet<string>,
): string | undefined {
  const record = entry.record;
  if (matching.length === 0) return "path is not explicitly managed";
  if (matching.length !== 1) return "managed path metadata is ambiguous";
  const reference = matching[0];
  if (reference === undefined) return "managed path metadata is ambiguous";
  if (reference.physicalPath === undefined) return "managed path physical identity is unavailable";
  if (entry.physicalPath !== reference.physicalPath) {
    return "managed path and Treehouse path physical identities differ";
  }
  if (duplicateManaged.has(reference.absolutePath)) return "managed path is listed more than once";
  if (duplicateManaged.has(reference.physicalPath)) {
    return "managed paths resolve to the same physical copy";
  }
  const statusKey = entry.physicalPath ?? entry.absolutePath;
  if (duplicateStatus.has(statusKey)) return "Treehouse returned duplicate path metadata";
  if (duplicateNames.has(record.name)) return "Treehouse returned duplicate copy names";
  if (protectedPaths.some((protectedPath) => protectedPath.physicalPath === undefined)) {
    return "protected path physical identity is unavailable";
  }
  if (matchesProtectedPath(entry, protectedPaths)) return "path is protected by active ownership";
  if (physicalRoot.path === undefined) return "managed root physical identity is unavailable";
  if (!physicalRoot.exact)
    return "managed root does not exist; pruning is disabled until it exists";
  if (entry.physicalPath === undefined) {
    return `physical path could not be resolved: ${entry.physicalError ?? "unknown error"}`;
  }
  if (!isContained(physicalRoot.path, entry.physicalPath)) {
    return `physical path escapes managed root ${JSON.stringify(physicalRoot.path)}`;
  }
  if (entry.physicalPath === physicalRoot.path) return "managed root itself is not a worktree copy";
  if (record.status !== "available") return `Treehouse status is ${JSON.stringify(record.status)}`;
  if (record.flavor !== "git") return `Treehouse flavor is ${JSON.stringify(record.flavor)}`;
  if (record.leaseId !== "" || record.leaseHolder !== "" || record.leasedAt !== null) {
    return "copy has lease metadata";
  }
  if (record.processes.length !== 0) return "copy has active process metadata";
  return undefined;
}

function safetyReason(safety: PoolWorktreeSafety): string | undefined {
  if (safety.ignored) return "copy contains ignored files that may be unique data";
  if (!safety.clean) return "copy has dirty or untracked content";
  if (safety.unmerged) return "copy has unmerged paths";
  if (!safety.merged) return "copy is not a clean merged worktree";
  return undefined;
}

function allocationBlocker(availableBytes: number | null, minimumFreeBytes: number): string {
  if (availableBytes === null) {
    return "pool filesystem free space is unknown; cannot safely allocate a new worktree; verify the destination filesystem and retry";
  }
  return `pool filesystem has insufficient free space for a new worktree: ${availableBytes} bytes available, ${minimumFreeBytes} bytes required; free disk space and retry`;
}

async function inspectCandidate(
  run: CommandRunner,
  repo: string,
  realpath: RealpathReader,
  candidate: PoolCandidate,
): Promise<Readonly<{ safe: boolean; reason: string | undefined }>> {
  try {
    const safety = await inspectPoolWorktree(
      run,
      { repo, path: candidate.entry.absolutePath },
      { realpath },
    );
    const reason = safetyReason(safety);
    return { safe: reason === undefined, reason };
  } catch (error) {
    return {
      safe: false,
      reason: `worktree safety could not be verified: ${describeFailure(error)}`,
    };
  }
}

async function destroyCandidate(
  run: CommandRunner,
  repo: string,
  root: string,
  candidate: PoolCandidate,
): Promise<Readonly<{ destroyed: boolean; warning: string | undefined }>> {
  try {
    await destroyTreehouseWorktree(run, {
      repo,
      root,
      path: candidate.entry.absolutePath,
    });
    return { destroyed: true, warning: undefined };
  } catch (error) {
    return {
      destroyed: false,
      warning: `native destroy retained ${JSON.stringify(candidate.entry.absolutePath)}: ${describeFailure(error)}`,
    };
  }
}

export async function maintainPool(
  run: CommandRunner,
  input: PoolMaintenanceInput,
  options: PoolMaintenanceOptions = {},
): Promise<PoolMaintenanceResult> {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  const validated = validateInput(input);
  const realpath = options.realpath ?? defaultRealpath;
  const availableReader = options.availableBytes ?? readStatfsAvailableBytes;
  if (typeof realpath !== "function") throw new TypeError("realpath must be a function");
  if (typeof availableReader !== "function")
    throw new TypeError("availableBytes must be a function");

  const warnings: string[] = [];
  let records: readonly TreehousePoolStatusRecord[] = [];
  try {
    records = await readTreehousePoolStatus(run, { repo: validated.repo, root: validated.root });
  } catch (error) {
    warnings.push(`pool status unavailable: ${describeFailure(error)}`);
  }

  const [physicalRoot, capacity] = await Promise.all([
    resolvePhysicalRoot(validated.root, realpath),
    readAvailableSpace(validated.root, availableReader),
  ]);
  if (physicalRoot.error !== undefined) {
    warnings.push(`managed root physical identity unavailable: ${physicalRoot.error}`);
  } else if (!physicalRoot.exact) {
    warnings.push("managed root does not exist; pool pruning is disabled until it exists");
  }
  if (capacity.warning !== undefined) warnings.push(capacity.warning);

  const managedReferences = await resolveReferences(validated.managedPaths, realpath);
  const protectedReferences = await resolveReferences(validated.protectedPaths, realpath);
  const entries = (await resolveStatusEntries(validated.repo, records, realpath)).sort(
    (left, right) => comparePaths(left.absolutePath, right.absolutePath),
  );
  const managedDuplicatePaths = duplicateValues(
    managedReferences.map((reference) => reference.absolutePath),
  );
  const managedDuplicatePhysical = duplicateValues(
    managedReferences.flatMap((reference) =>
      reference.physicalPath === undefined ? [] : [reference.physicalPath],
    ),
  );
  const statusDuplicatePaths = duplicateValues(entries.map((entry) => entry.absolutePath));
  const statusDuplicatePhysical = duplicateValues(
    entries.flatMap((entry) => (entry.physicalPath === undefined ? [] : [entry.physicalPath])),
  );
  const duplicateStatus = new Set([...statusDuplicatePaths, ...statusDuplicatePhysical]);
  const duplicateNames = duplicateValues(entries.map((entry) => entry.record.name));
  const duplicateManaged = new Set([...managedDuplicatePaths, ...managedDuplicatePhysical]);

  const safeCandidates: PoolCandidate[] = [];
  for (const entry of entries) {
    const matching = matchingReferences(entry, managedReferences);
    const reason = metadataReason(
      entry,
      matching,
      protectedReferences,
      physicalRoot,
      duplicateManaged,
      duplicateStatus,
      duplicateNames,
    );
    if (reason !== undefined) {
      if (matching.length !== 0)
        warnings.push(`retained ${JSON.stringify(entry.absolutePath)}: ${reason}`);
      continue;
    }
    const inspected = await inspectCandidate(run, validated.repo, realpath, { entry });
    if (!inspected.safe) {
      warnings.push(
        `retained ${JSON.stringify(entry.absolutePath)}: ${inspected.reason ?? "safety proof failed"}`,
      );
      continue;
    }
    safeCandidates.push({ entry });
  }

  const normalCandidates = safeCandidates.slice(validated.retainIdle);
  const warmCandidates = safeCandidates.slice(0, validated.retainIdle);
  let currentAvailable = capacity.availableBytes;
  const removedPaths: string[] = [];
  const removalQueue = [...normalCandidates, ...warmCandidates];
  for (let index = 0; index < removalQueue.length; index += 1) {
    const candidate = removalQueue[index];
    if (candidate === undefined) continue;
    const isWarmCandidate = index >= normalCandidates.length;
    if (
      isWarmCandidate &&
      (currentAvailable === null || currentAvailable >= validated.minimumFreeBytes)
    ) {
      break;
    }
    const destroyed = await destroyCandidate(run, validated.repo, validated.root, candidate);
    if (destroyed.warning !== undefined) warnings.push(destroyed.warning);
    if (!destroyed.destroyed) continue;
    removedPaths.push(candidate.entry.absolutePath);
    const refreshed = await readAvailableSpace(validated.root, availableReader);
    currentAvailable = refreshed.availableBytes;
    if (refreshed.warning !== undefined)
      warnings.push(`pool capacity recheck: ${refreshed.warning}`);
    if (currentAvailable === null && isWarmCandidate) break;
  }

  const removed = new Set(removedPaths);
  const retainedPaths = uniqueSorted(
    entries.map((entry) => entry.absolutePath).filter((path) => !removed.has(path)),
  );
  const canAllocate = currentAvailable !== null && currentAvailable >= validated.minimumFreeBytes;
  return {
    canAllocate,
    availableBytes: currentAvailable,
    removedPaths: uniqueSorted(removedPaths),
    retainedPaths,
    warnings,
    ...(canAllocate
      ? {}
      : { allocationBlocker: allocationBlocker(currentAvailable, validated.minimumFreeBytes) }),
  };
}
