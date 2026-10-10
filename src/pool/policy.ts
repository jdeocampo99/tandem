import { isAbsolute, relative, resolve } from "node:path";
import type { PoolWorktreeSafety, TreehousePoolStatusRecord } from "../adapters/treehouse.ts";
import type { Notification } from "../contracts.ts";

const DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export type AvailableSpaceReader = (path: string) => Promise<number | null>;
export type RealpathReader = (path: string) => Promise<string>;

export type AbsolutePathReference = Readonly<{
  absolutePath: string;
  physicalPath: string | undefined;
  physicalError: string | undefined;
}>;

export type StatusEntry = Readonly<{
  record: TreehousePoolStatusRecord;
  absolutePath: string;
  physicalPath: string | undefined;
  physicalError: string | undefined;
}>;

export type PoolCandidate = Readonly<{
  entry: StatusEntry;
}>;

export type PhysicalRoot = Readonly<{
  path: string | undefined;
  exact: boolean;
  error: string | undefined;
}>;

export type CapacityObservation = Readonly<{
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
export function poolAdmissionKey(
  result: PoolMaintenanceResult,
): "capacity-unknown" | "capacity-insufficient" | undefined {
  if (result.canAllocate) return undefined;
  return result.availableBytes === null ? "capacity-unknown" : "capacity-insufficient";
}

export function poolAdmissionNotice(result: PoolMaintenanceResult): string {
  return (
    result.allocationBlocker ??
    (result.availableBytes === null
      ? "pool capacity could not be verified; allocation is blocked until capacity can be checked"
      : "pool has insufficient free space for a new worktree; free space and retry")
  );
}
const POOL_NOTICE_PREFIX = "Pool admission blocked [";

export function poolNotificationMessage(
  key: "capacity-unknown" | "capacity-insufficient",
  notice: string,
): string {
  return `${POOL_NOTICE_PREFIX}${key}]: ${notice}`;
}

export function isPoolNotification(notification: Notification): boolean {
  return notification.message.startsWith(POOL_NOTICE_PREFIX);
}

export function isPoolNotificationForKey(
  notification: Notification,
  key: "capacity-unknown" | "capacity-insufficient",
): boolean {
  return notification.message.startsWith(`${POOL_NOTICE_PREFIX}${key}]:`);
}

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

export function checkedAbsolutePath(repo: string, value: unknown, field: string): string {
  const text = checkedText(value, field);
  return isAbsolute(text) ? resolve(text) : resolve(repo, text);
}
function checkedNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

export function validateInput(input: PoolMaintenanceInput): Readonly<{
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

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"));
}

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function uniqueSorted(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort(comparePaths);
}

export function duplicateValues(values: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

export function readAvailableValue(value: number | null, path: string): CapacityObservation {
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

export function matchingReferences(
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

export function metadataReason(
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

export function safetyReason(safety: PoolWorktreeSafety): string | undefined {
  if (safety.ignored) return "copy contains ignored files that may be unique data";
  if (!safety.clean) return "copy has dirty or untracked content";
  if (safety.unmerged) return "copy has unmerged paths";
  if (!safety.merged) return "copy is not a clean merged worktree";
  return undefined;
}

export function allocationBlocker(availableBytes: number | null, minimumFreeBytes: number): string {
  if (availableBytes === null) {
    return "pool filesystem free space is unknown; cannot safely allocate a new worktree; verify the destination filesystem and retry";
  }
  return `pool filesystem has insufficient free space for a new worktree: ${availableBytes} bytes available, ${minimumFreeBytes} bytes required; free disk space and retry`;
}
