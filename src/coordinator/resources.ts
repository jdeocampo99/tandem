import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readTreehousePoolStatus, releaseWorktree } from "../adapters/treehouse.ts";
import type { CommandRunner, Endpoint, WorktreeLease } from "../contracts.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import { ensurePrivateDirectoryTree } from "./lock.ts";
import {
  type CoordinatorRecord,
  canonicalHome,
  isMissing,
  isRecord,
  parseEndpoint,
  parseWorktree,
  sessionText,
  text,
} from "./record.ts";
import { removeCoordinatorRecord } from "./registry.ts";
import { type CoordinatorWorkspaceRetirement, retireCoordinatorWorkspace } from "./workspace.ts";

/** Directory under the Tandem home holding coordinator resources Tandem refused to release. */
export const COORDINATOR_QUARANTINE_DIRECTORY = "coordinator-quarantine";
const QUARANTINE_SUFFIX = ".json";
const QUARANTINE_SCHEMA_VERSION = 1 as const;

/**
 * Where a quarantine came from: replacing a previous coordinator, rolling a new one back, or
 * refusing a repository claim whose ownership could not be proved.
 */
export type CoordinatorQuarantineStage = "replacement" | "rollback" | "exclusivity";

/** A durable note that one exact coordinator lease was left in place and why. */
export type CoordinatorQuarantineRecord = Readonly<{
  readonly schemaVersion: 1;
  readonly quarantineId: string;
  readonly quarantinedAt: string;
  readonly stage: CoordinatorQuarantineStage;
  readonly repoPath: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly lease: WorktreeLease;
  readonly endpoint?: Endpoint;
}>;

/** What a replacement or rollback actually did with the coordinator resources it inspected. */
export type CoordinatorResourceOutcome = Readonly<{
  readonly outcome:
    | "allocated"
    | "reused"
    | "released"
    | "already-absent"
    | "retained"
    | "quarantined";
  readonly reason: string;
  /** Where the durable quarantine note was written, for a quarantined outcome. */
  readonly quarantinePath?: string;
}>;

/** The previous coordinator checkout as it was observed, without interpreting it. */
export type CoordinatorCheckoutObservation =
  | Readonly<{
      readonly status: "observed";
      readonly head: string;
      readonly branch: string;
      readonly dirty: boolean;
      readonly unmerged: boolean;
    }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{ readonly status: "unreadable"; readonly detail: string }>;

/** Everything the replacement decision is allowed to look at. */
export type CoordinatorReplacementObservation = Readonly<{
  readonly previous: CoordinatorRecord | undefined;
  readonly paneRetirement: CoordinatorWorkspaceRetirement | undefined;
  readonly checkout: CoordinatorCheckoutObservation | undefined;
  readonly requestedSourceHead: string;
  readonly replacementLeaseHolder: string;
}>;

/** What to do with the previous coordinator's lease before a replacement is allocated. */
export type CoordinatorReplacementDecision =
  | Readonly<{ readonly kind: "allocate"; readonly reason: string }>
  | Readonly<{ readonly kind: "reuse"; readonly reason: string; readonly lease: WorktreeLease }>
  | Readonly<{ readonly kind: "release"; readonly reason: string; readonly lease: WorktreeLease }>
  | Readonly<{ readonly kind: "retain"; readonly reason: string; readonly lease: WorktreeLease }>
  | Readonly<{
      readonly kind: "quarantine";
      readonly reason: string;
      readonly lease: WorktreeLease;
    }>;

/**
 * What may happen to one coordinator lease when nothing will take its place. It is the
 * replacement decision without the `allocate` and `reuse` answers, both of which only make sense
 * to a caller that is about to allocate a coordinator of its own.
 */
export type CoordinatorLeaseSettlement = Extract<
  CoordinatorReplacementDecision,
  Readonly<{ readonly kind: "release" | "retain" | "quarantine" }>
>;

/** Everything the lease settlement is allowed to look at. */
export type CoordinatorLeaseSettlementObservation = Readonly<{
  readonly previous: CoordinatorRecord;
  readonly paneRetirement: CoordinatorWorkspaceRetirement | undefined;
  readonly checkout: CoordinatorCheckoutObservation | undefined;
}>;

export type CoordinatorReplacementInput = Readonly<{
  readonly run: CommandRunner;
  readonly home: string;
  readonly sessionId: string;
  readonly repoPath: string;
  readonly decision: CoordinatorReplacementDecision;
  readonly clock: () => string;
  readonly newId: () => string;
}>;

export type CoordinatorAllocationRollbackInput = Readonly<{
  readonly run: CommandRunner;
  readonly home: string;
  readonly sessionId: string;
  readonly repoPath: string;
  readonly lease: WorktreeLease;
  /** The replacement pane this launch created, when it got far enough to create one. */
  readonly endpoint?: Endpoint;
  readonly failure: string;
  readonly clock: () => string;
  readonly newId: () => string;
}>;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quarantineFileName(quarantineId: string): string {
  const id = text(quarantineId, "quarantineId");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) {
    throw new TypeError("quarantineId must be a filename-safe identifier");
  }
  return `${id}${QUARANTINE_SUFFIX}`;
}

export function coordinatorQuarantineDirectory(home: string): string {
  return join(home, COORDINATOR_QUARANTINE_DIRECTORY);
}

/** Writes one quarantine note privately and atomically, returning its path. */
export async function writeCoordinatorQuarantineRecord(
  homeInput: string,
  record: CoordinatorQuarantineRecord,
): Promise<string> {
  const home = await canonicalHome(homeInput);
  const directory = coordinatorQuarantineDirectory(home);
  await ensurePrivateDirectoryTree(directory, "coordinator quarantine directory");
  const path = join(directory, quarantineFileName(record.quarantineId));
  await writeJsonAtomically(path, record);
  return path;
}

function parseQuarantineRecord(value: unknown, source: string): CoordinatorQuarantineRecord {
  if (!isRecord(value)) throw new TypeError(`${source} must contain an object`);
  if (value.schemaVersion !== QUARANTINE_SCHEMA_VERSION) {
    throw new TypeError(`${source}.schemaVersion must be ${QUARANTINE_SCHEMA_VERSION}`);
  }
  const stage = value.stage;
  if (stage !== "replacement" && stage !== "rollback" && stage !== "exclusivity") {
    throw new TypeError(`${source}.stage must be "replacement", "rollback", or "exclusivity"`);
  }
  const endpoint =
    value.endpoint === undefined ? undefined : parseEndpoint(value.endpoint, `${source}.endpoint`);
  return {
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    quarantineId: text(value.quarantineId, `${source}.quarantineId`),
    quarantinedAt: text(value.quarantinedAt, `${source}.quarantinedAt`),
    stage,
    repoPath: text(value.repoPath, `${source}.repoPath`),
    sessionId: sessionText(value.sessionId),
    reason: text(value.reason, `${source}.reason`),
    lease: parseWorktree(value.lease, `${source}.lease`),
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

/** Lists every durable coordinator quarantine note in one Tandem home, oldest name first. */
export async function listCoordinatorQuarantineRecords(
  homeInput: string,
): Promise<readonly CoordinatorQuarantineRecord[]> {
  const home = await canonicalHome(homeInput);
  const directory = coordinatorQuarantineDirectory(home);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records: CoordinatorQuarantineRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(QUARANTINE_SUFFIX)) continue;
    const path = join(directory, entry.name);
    const contents = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new TypeError(`${path} is not valid JSON: ${describeFailure(error)}`);
    }
    records.push(parseQuarantineRecord(parsed, path));
  }
  return records;
}

async function gitOutput(
  run: CommandRunner,
  worktreePath: string,
  args: readonly string[],
  operation: string,
): Promise<string> {
  const result = await run({ argv: ["git", "-C", worktreePath, ...args], cwd: worktreePath });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${operation} failed with exit code ${result.code}${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout;
}

/** Reads the previous coordinator checkout without judging or changing it. */
export async function observeCoordinatorCheckout(
  run: CommandRunner,
  worktreePath: string,
): Promise<CoordinatorCheckoutObservation> {
  try {
    const details = await lstat(worktreePath);
    if (!details.isDirectory()) {
      return { status: "unreadable", detail: "recorded lease path is not a directory" };
    }
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    return { status: "unreadable", detail: describeFailure(error) };
  }
  try {
    const head = (
      await gitOutput(run, worktreePath, ["rev-parse", "HEAD"], "git worktree HEAD")
    ).trim();
    const branch = (
      await gitOutput(run, worktreePath, ["branch", "--show-current"], "git worktree branch")
    ).trim();
    const status = await gitOutput(
      run,
      worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "git worktree status",
    );
    const unmerged = await gitOutput(
      run,
      worktreePath,
      ["diff", "--name-only", "--diff-filter=U"],
      "git worktree unmerged check",
    );
    if (head.length === 0) {
      return { status: "unreadable", detail: "git reported no HEAD commit" };
    }
    return {
      status: "observed",
      head,
      branch,
      dirty: status.trim().length !== 0,
      unmerged: unmerged.trim().length !== 0,
    };
  } catch (error) {
    return { status: "unreadable", detail: describeFailure(error) };
  }
}

/**
 * The commits the previous checkout may legitimately sit on: its recorded lease base, plus the
 * target of a durable source-refresh intent recorded against that same exact lease.
 */
function settledHeads(previous: CoordinatorRecord): readonly string[] {
  const base = previous.worktree.baseHead;
  const pending = previous.pendingSourceRefresh;
  return pending !== undefined &&
    pending.leaseId === previous.worktree.leaseId &&
    pending.leaseHolder === previous.worktree.leaseHolder &&
    pending.fromHead === base
    ? [base, pending.toHead]
    : [base];
}

/**
 * Judges one coordinator checkout on its own, before any pane is considered.
 *
 * A release answer means only that the checkout still carries exactly what Tandem put there, or
 * is gone entirely. Anything a user could still want is retained, and anything Tandem cannot
 * explain is quarantined rather than guessed at.
 */
export function judgeCoordinatorCheckout(
  previous: CoordinatorRecord,
  checkout: CoordinatorCheckoutObservation | undefined,
): CoordinatorLeaseSettlement {
  const lease = previous.worktree;
  if (checkout === undefined) {
    return { kind: "quarantine", reason: "previous coordinator checkout was never read", lease };
  }
  if (checkout.status === "unreadable") {
    return {
      kind: "quarantine",
      reason: `previous coordinator checkout could not be read: ${checkout.detail}`,
      lease,
    };
  }
  if (checkout.status === "missing") {
    return { kind: "release", reason: "previous coordinator checkout is no longer present", lease };
  }
  if (checkout.dirty) {
    return {
      kind: "retain",
      reason: "previous coordinator worktree has uncommitted changes",
      lease,
    };
  }
  if (checkout.unmerged) {
    return { kind: "retain", reason: "previous coordinator worktree has unmerged paths", lease };
  }
  if (checkout.branch !== lease.branch) {
    return {
      kind: "quarantine",
      reason: `previous coordinator worktree is on branch ${JSON.stringify(checkout.branch)} instead of its recorded lease branch ${JSON.stringify(lease.branch)}`,
      lease,
    };
  }
  const settled = settledHeads(previous);
  if (!settled.includes(checkout.head)) {
    return {
      kind: "quarantine",
      reason: `previous coordinator worktree HEAD ${checkout.head} is none of its recorded lease commits ${settled.join(", ")}`,
      lease,
    };
  }
  return {
    kind: "release",
    reason: `previous coordinator lease is clean at ${checkout.head} and still on a recorded lease commit`,
    lease,
  };
}

/**
 * Decides what may happen to one coordinator's worktree lease when nothing will take its place.
 *
 * Releasing requires a pane Tandem proved stopped and then closed, plus a checkout that still
 * carries exactly the pinned commit Tandem put there. Reconciliation uses this answer directly; a
 * replacement launch refines the release answer through `decideCoordinatorReplacement`, which may
 * keep a matching lease instead of returning it.
 */
export function decideCoordinatorLeaseSettlement(
  observation: CoordinatorLeaseSettlementObservation,
): CoordinatorLeaseSettlement {
  const lease = observation.previous.worktree;
  const retirement = observation.paneRetirement;
  if (retirement === undefined) {
    return { kind: "quarantine", reason: "previous coordinator pane was never inspected", lease };
  }
  if (retirement.outcome === "quarantined") {
    return {
      kind: "quarantine",
      reason: `previous coordinator pane was quarantined: ${retirement.reason ?? "no reason reported"}`,
      lease,
    };
  }
  if (retirement.outcome === "retained") {
    return {
      kind: "retain",
      reason: `previous coordinator workspace was retained: ${retirement.reason ?? "no reason reported"}`,
      lease,
    };
  }
  return judgeCoordinatorCheckout(observation.previous, observation.checkout);
}

/**
 * Decides what a replacement launch may do with the previous coordinator's worktree lease.
 *
 * Everything a settlement refuses is refused here too. The one thing a replacement may do that
 * reconciliation may not is keep a clean lease that is already pinned to the commit this launch
 * wants and already held under this launch's own identity.
 */
export function decideCoordinatorReplacement(
  observation: CoordinatorReplacementObservation,
): CoordinatorReplacementDecision {
  const previous = observation.previous;
  if (previous === undefined) {
    return { kind: "allocate", reason: "no previous coordinator record" };
  }
  const settlement = decideCoordinatorLeaseSettlement({
    previous,
    paneRetirement: observation.paneRetirement,
    checkout: observation.checkout,
  });
  const checkout = observation.checkout;
  if (settlement.kind !== "release" || checkout?.status !== "observed") return settlement;
  const lease = previous.worktree;
  if (
    checkout.head === observation.requestedSourceHead &&
    lease.leaseHolder === observation.replacementLeaseHolder
  ) {
    return {
      kind: "reuse",
      reason: `previous coordinator lease is clean and already pinned to ${observation.requestedSourceHead}`,
      lease,
    };
  }
  return {
    kind: "release",
    reason: `previous coordinator lease is clean at ${checkout.head} and the replacement needs ${observation.requestedSourceHead}`,
    lease,
  };
}

/** Whether the exact recorded lease is still held, before anything tries to return it. */
type CoordinatorLeasePresence = "held" | "absent";

async function readCoordinatorLeasePresence(
  run: CommandRunner,
  repoPath: string,
  lease: WorktreeLease,
): Promise<CoordinatorLeasePresence> {
  const records = await readTreehousePoolStatus(run, { repo: repoPath, root: lease.root });
  const matching = records.filter((record) => record.leaseId === lease.leaseId);
  const held = matching[0];
  if (matching.length === 0 || held === undefined) return "absent";
  if (matching.length > 1) {
    throw new Error(
      `Treehouse reports ${matching.length} worktrees for coordinator lease ${JSON.stringify(lease.leaseId)}`,
    );
  }
  if (held.leaseHolder !== lease.leaseHolder || resolve(lease.root, held.path) !== lease.path) {
    throw new Error(
      `Treehouse lease ${JSON.stringify(lease.leaseId)} is now held by ${JSON.stringify(held.leaseHolder)} at ${JSON.stringify(held.path)}, not by the recorded coordinator`,
    );
  }
  return "held";
}

/**
 * Returns one exact coordinator lease, matched by lease id, holder, and path rather than by
 * label or pool position.
 *
 * The caller must already have proven the checkout clean and still on its pinned commit. That
 * proof is what a coordinator lease needs: unlike a task lease it never carries work of its own,
 * and its pinned source commit is not expected to be an ancestor of whatever the user happens to
 * have checked out, so the task-shaped ancestry check in `releaseWorktree` is bypassed with the
 * force flag instead of being weakened for every caller.
 */
export async function releaseCoordinatorLease(
  run: CommandRunner,
  input: Readonly<{ readonly repoPath: string; readonly lease: WorktreeLease }>,
): Promise<"released" | "already-absent"> {
  if ((await readCoordinatorLeasePresence(run, input.repoPath, input.lease)) === "absent") {
    return "already-absent";
  }
  await releaseWorktree(run, {
    repo: input.repoPath,
    lease: input.lease,
    childWorkerStopped: true,
    discard: true,
    destructiveApproval: true,
  });
  return "released";
}

/**
 * Writes the durable note that says one exact coordinator lease was left in place, and why.
 * Callers use it instead of releasing or closing anything when ownership cannot be proved.
 */
export async function quarantineCoordinatorLease(
  input: Readonly<{
    readonly home: string;
    readonly sessionId: string;
    readonly repoPath: string;
    readonly stage: CoordinatorQuarantineStage;
    readonly reason: string;
    readonly lease: WorktreeLease;
    readonly endpoint?: Endpoint;
    readonly clock: () => string;
    readonly newId: () => string;
  }>,
): Promise<CoordinatorResourceOutcome> {
  const quarantinePath = await writeCoordinatorQuarantineRecord(input.home, {
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    quarantineId: input.newId(),
    quarantinedAt: input.clock(),
    stage: input.stage,
    repoPath: input.repoPath,
    sessionId: input.sessionId,
    reason: input.reason,
    lease: input.lease,
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
  });
  return { outcome: "quarantined", reason: input.reason, quarantinePath };
}

/**
 * Carries out a replacement decision: releases the previous lease and drops its record, or
 * leaves both alone and writes a durable quarantine note naming what was left behind.
 *
 * A release that cannot be completed does not fail the launch. It becomes a quarantine note, so
 * the lease keeps a durable owner that reconciliation can act on later instead of the user being
 * locked out of their coordinator.
 */
export async function applyCoordinatorReplacement(
  input: CoordinatorReplacementInput,
): Promise<CoordinatorResourceOutcome> {
  const decision = input.decision;
  if (decision.kind === "allocate") return { outcome: "allocated", reason: decision.reason };
  if (decision.kind === "reuse") return { outcome: "reused", reason: decision.reason };
  if (decision.kind === "retain") return { outcome: "retained", reason: decision.reason };
  if (decision.kind === "quarantine") {
    return quarantineCoordinatorLease({
      home: input.home,
      sessionId: input.sessionId,
      repoPath: input.repoPath,
      clock: input.clock,
      newId: input.newId,
      stage: "replacement",
      reason: decision.reason,
      lease: decision.lease,
    });
  }
  try {
    const released = await releaseCoordinatorLease(input.run, {
      repoPath: input.repoPath,
      lease: decision.lease,
    });
    await removeCoordinatorRecord(input.home, input.sessionId, input.repoPath);
    return {
      outcome: released === "released" ? "released" : "already-absent",
      reason: decision.reason,
    };
  } catch (error) {
    return quarantineCoordinatorLease({
      home: input.home,
      sessionId: input.sessionId,
      repoPath: input.repoPath,
      clock: input.clock,
      newId: input.newId,
      stage: "replacement",
      lease: decision.lease,
      reason: `previous coordinator lease could not be released: ${describeFailure(error)}`,
    });
  }
}

/**
 * Undoes the resources a failed launch acquired after its lease: the replacement pane it created,
 * then the lease itself. Whatever cannot be proven safe to undo becomes a durable quarantine note
 * instead, so a half-started coordinator never leaves an untracked lease behind.
 */
export async function rollbackCoordinatorAllocation(
  input: CoordinatorAllocationRollbackInput,
): Promise<CoordinatorResourceOutcome> {
  const quarantine = (reason: string): Promise<CoordinatorResourceOutcome> =>
    quarantineCoordinatorLease({
      home: input.home,
      sessionId: input.sessionId,
      repoPath: input.repoPath,
      clock: input.clock,
      newId: input.newId,
      stage: "rollback",
      lease: input.lease,
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      reason: `${input.failure}; ${reason}`,
    });

  if (input.endpoint !== undefined) {
    let retirement: CoordinatorWorkspaceRetirement;
    try {
      retirement = await retireCoordinatorWorkspace(input.run, {
        repoPath: input.repoPath,
        endpoint: input.endpoint,
        worktree: input.lease,
      });
    } catch (error) {
      return quarantine(`its new pane could not be retired: ${describeFailure(error)}`);
    }
    if (retirement.outcome !== "closed" && retirement.outcome !== "already-clear") {
      return quarantine(
        `its new pane was ${retirement.outcome}: ${retirement.reason ?? "no reason reported"}`,
      );
    }
  }

  const checkout = await observeCoordinatorCheckout(input.run, input.lease.path);
  if (checkout.status === "unreadable") {
    return quarantine(`its new checkout could not be read: ${checkout.detail}`);
  }
  if (checkout.status === "observed") {
    if (checkout.dirty) return quarantine("its new checkout has uncommitted changes");
    if (checkout.unmerged) return quarantine("its new checkout has unmerged paths");
    if (checkout.branch !== input.lease.branch) {
      return quarantine(
        `its new checkout is on branch ${JSON.stringify(checkout.branch)} instead of ${JSON.stringify(input.lease.branch)}`,
      );
    }
    if (checkout.head !== input.lease.baseHead) {
      return quarantine(
        `its new checkout HEAD ${checkout.head} is not the acquired lease commit ${input.lease.baseHead}`,
      );
    }
  }

  try {
    const released = await releaseCoordinatorLease(input.run, {
      repoPath: input.repoPath,
      lease: input.lease,
    });
    return {
      outcome: released === "released" ? "released" : "already-absent",
      reason: `${input.failure}; the newly acquired coordinator lease was rolled back`,
    };
  } catch (error) {
    return quarantine(`its new lease could not be released: ${describeFailure(error)}`);
  }
}
