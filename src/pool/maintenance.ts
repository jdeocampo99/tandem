import { realpath as defaultRealpath, statfs as defaultStatfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  destroyTreehouseWorktree,
  inspectPoolWorktree,
  readTreehousePoolStatus,
  type TreehousePoolStatusRecord,
} from "../adapters/treehouse.ts";
import type { CommandRunner } from "../contracts.ts";
import {
  type AbsolutePathReference,
  type AvailableSpaceReader,
  allocationBlocker,
  type CapacityObservation,
  checkedAbsolutePath,
  comparePaths,
  duplicateValues,
  matchingReferences,
  metadataReason,
  type PhysicalRoot,
  type PoolCandidate,
  type PoolMaintenanceInput,
  type PoolMaintenanceOptions,
  type PoolMaintenanceResult,
  type RealpathReader,
  readAvailableValue,
  type StatusEntry,
  safetyReason,
  uniqueSorted,
  validateInput,
} from "./policy.ts";

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
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
