import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readTreehousePoolStatus, type TreehousePoolStatusRecord } from "../adapters/treehouse.ts";
import type { Clock, CommandRunner, WorktreeLease } from "../contracts.ts";
import { taskRuntime } from "../runtime/activity.ts";
import { databasePath } from "../runtime/database.ts";
import { defaultIdFactory, readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import { isTerminalTask } from "../service/records.ts";
import {
  decideScoutCleanupEligibility,
  finishPendingImplementationCleanup,
  finishPendingScoutCleanup,
  type TaskCleanupOutcome,
} from "../service/scout-cleanup.ts";
import { taskCheckoutPath } from "../service/source.ts";
import {
  containerRefs,
  observeWorktreeContainment,
  otherTaskWork,
  type SupersededProof,
  type WorktreeContainment,
} from "../service/superseded.ts";

import { createTaskStore } from "../tasks/store.ts";
import { withCoordinatorLaunchLock, withCoordinatorRepositoryLock } from "./lock.ts";
import { findRunningCoordinator } from "./ownership.ts";
import {
  COORDINATOR_LEASE_HOLDER_PREFIX,
  canonicalHome,
  canonicalPath,
  isMissing,
} from "./record.ts";
import {
  type DiscoveredCoordinatorRecord,
  discoverCoordinatorRecords,
  type UnreadableCoordinatorRecord,
} from "./registry.ts";
import {
  applyCoordinatorReplacement,
  type CoordinatorCheckoutObservation,
  type CoordinatorQuarantineRecord,
  coordinatorQuarantineDirectory,
  decideCoordinatorLeaseSettlement,
  judgeCoordinatorCheckout,
  listCoordinatorQuarantineRecords,
  observeCoordinatorCheckout,
  quarantineCoordinatorLease,
  readCoordinatorLeasePresence,
  releaseCoordinatorLease,
  retireCoordinatorQuarantineNote,
} from "./resources.ts";
import { retireCoordinatorWorkspace } from "./workspace.ts";

/** Version of the machine-readable reconciliation report; bumped when its shape changes. */
export const RECONCILE_REPORT_SCHEMA_VERSION = 2 as const;

/** The kinds of resource reconciliation knows how to classify. */
export type ReconcileResourceKind =
  | "coordinator"
  | "worktree-lease"
  | "scout-task"
  | "implementation-task"
  | "unreadable-record"
  | "quarantine-note";

/**
 * What the plan says should happen to one resource: release it through its owner, keep it and say
 * why, or leave it exactly where it is and record that Tandem could not explain it.
 */
export type ReconcileAction = "clean" | "retain" | "quarantine";

/**
 * Where one resource ended up, once the plan was applied or reported as a dry run. `freeable` is a
 * task worktree that can be returned only with its own explicit approval.
 */
export type ReconcileOutcome = "cleaned" | "retained" | "quarantined" | "failed" | "freeable";

/** One stored coordinator record as the scan observed it, without changing anything. */
export type ObservedCoordinator = Readonly<{
  readonly found: DiscoveredCoordinatorRecord;
  readonly liveness: CoordinatorLiveness;
  /** Read only for a record no live coordinator answers for, so live panes stay undisturbed. */
  readonly checkout: CoordinatorCheckoutObservation | undefined;
}>;

/** Whether a stored record still proves a coordinator is running under it. */
export type CoordinatorLiveness =
  | Readonly<{ readonly status: "live" }>
  | Readonly<{ readonly status: "stopped" }>
  | Readonly<{ readonly status: "ambiguous"; readonly detail: string }>;

/** One Treehouse lease in a pool, with the checkout behind it when Tandem may judge it. */
export type ObservedPoolLease = Readonly<{
  readonly repoPath: string;
  readonly poolRoot: string;
  readonly leaseId: string;
  readonly leaseHolder: string;
  readonly leasedAt: string | null;
  readonly name: string;
  readonly path: string;
  /** Read only for a coordinator lease no record accounts for; other holders are never inspected. */
  readonly checkout: CoordinatorCheckoutObservation | undefined;
}>;

/** One terminal implementation task whose earlier cleanup did not finish releasing its resources. */
export type ObservedPendingImplementation = Readonly<{
  readonly taskId: string;
  readonly repoPath: string;
  readonly reason: string;
  /** For a cancelled or completed task holding a worktree: what returning it would lose. */
  readonly containment?: WorktreeContainment;
}>;

/** One terminal scout whose child resources an earlier coordinator did not finish releasing. */
export type ObservedPendingScout = Readonly<{
  readonly taskId: string;
  readonly repoPath: string;
  readonly reason: string;
}>;

/** Something the read-only scan itself could not complete, reported rather than assumed empty. */
export type ReconcileScanFailure = Readonly<{
  readonly subject: string;
  readonly reason: string;
}>;

/** Everything the plan is allowed to look at, gathered without changing a single resource. */
export type ReconcileObservation = Readonly<{
  readonly home: string;
  readonly coordinators: readonly ObservedCoordinator[];
  readonly leases: readonly ObservedPoolLease[];
  readonly scouts: readonly ObservedPendingScout[];
  readonly implementationTasks?: readonly ObservedPendingImplementation[];
  readonly unreadable: readonly UnreadableCoordinatorRecord[];
  readonly quarantines: readonly CoordinatorQuarantineRecord[];
  /** Notes whose lease Treehouse no longer holds, so nothing is left for them to protect. */
  readonly settledQuarantineIds: readonly string[];
  readonly failures: readonly ReconcileScanFailure[];
}>;

/** One planned resource, carrying exactly what its owner needs to act on it. */
export type ReconcilePlanItem =
  | Readonly<{
      readonly kind: "coordinator";
      readonly action: ReconcileAction;
      readonly reason: string;
      readonly found: DiscoveredCoordinatorRecord;
      /** Whether a durable quarantine note already names this lease. */
      readonly noted: boolean;
    }>
  | Readonly<{
      readonly kind: "worktree-lease";
      readonly action: ReconcileAction;
      readonly reason: string;
      readonly repoPath: string;
      readonly observed: ObservedPoolLease;
      /** The exact identity a release must name, present only when the lease may be released. */
      readonly lease: WorktreeLease | undefined;
    }>
  | Readonly<{
      readonly kind: "implementation-task";
      readonly action: "clean";
      readonly reason: string;
      readonly taskId: string;
      readonly repoPath: string;
      /** Approved: return the worktree because this proof shows its commits are elsewhere. */
      readonly free?: SupersededProof;
      /** Why ordinary cleanup will leave this task's worktree in place. */
      readonly worktreeStays?: string;
    }>
  | Readonly<{
      readonly kind: "superseded-task";
      readonly action: "offer";
      readonly reason: string;
      readonly taskId: string;
      readonly repoPath: string;
      readonly proof: SupersededProof;
    }>
  | Readonly<{
      readonly kind: "scout-task";
      readonly action: "clean";
      readonly reason: string;
      readonly taskId: string;
      readonly repoPath: string;
    }>
  | Readonly<{
      readonly kind: "unreadable-record";
      readonly action: "quarantine";
      readonly reason: string;
      readonly path: string;
    }>
  | Readonly<{
      readonly kind: "quarantine-note";
      readonly action: "quarantine" | "clean";
      readonly reason: string;
      readonly path: string;
      readonly repoPath: string;
      readonly sessionId: string;
      readonly record: CoordinatorQuarantineRecord;
    }>;

export type ReconcilePlan = Readonly<{
  readonly schemaVersion: typeof RECONCILE_REPORT_SCHEMA_VERSION;
  readonly items: readonly ReconcilePlanItem[];
}>;

/** One line of the report: what the resource was, where it lives, and why it ended up there. */
export type ReconcileReportEntry = Readonly<{
  readonly kind: ReconcileResourceKind;
  readonly id: string;
  readonly reason: string;
  readonly repoPath?: string;
  readonly sessionId?: string;
  readonly path?: string;
  /** The other task or pull request that already carries a freeable task's commits. */
  readonly containedIn?: string;
  /** Why ordinary cleanup leaves this task's worktree in place. */
  readonly worktreeStays?: string;
}>;

/** The stable, versioned shape `tandem fix --json` prints for automation. */
export type ReconcileReport = Readonly<{
  readonly schemaVersion: typeof RECONCILE_REPORT_SCHEMA_VERSION;
  readonly mode: "dry-run" | "applied";
  readonly home: string;
  readonly cleaned: readonly ReconcileReportEntry[];
  readonly retained: readonly ReconcileReportEntry[];
  readonly quarantined: readonly ReconcileReportEntry[];
  readonly failed: readonly ReconcileReportEntry[];
  /** Worktrees whose commits other work already carries, returned only on separate approval. */
  readonly freeable: readonly ReconcileReportEntry[];
}>;

export type ReconcileScanInput = Readonly<{
  readonly run: CommandRunner;
  readonly home: string;
  /** The pool every repository without a coordinator record of its own would use. */
  readonly poolRoot: string;
  /** Repositories saved under the Tandem home, so empty pools are still inspected. */
  readonly repoPaths: readonly string[];
  readonly clock: Clock;
  /** Include blocked implementation tasks only for an explicit discard plan. */
  readonly discard?: boolean;
}>;

export type ReconcileApplyInput = Readonly<{
  readonly run: CommandRunner;
  readonly home: string;
  readonly plan: ReconcilePlan;
  readonly clock: Clock;
  readonly newId: () => string;
  /** Explicitly force-return cancelled implementation worktrees after identity checks. */
  readonly discard: boolean;
}>;

export type ReconcileInput = Readonly<{
  readonly run: CommandRunner;
  readonly home: string;
  readonly poolRoot: string;
  readonly repoPaths: readonly string[];
  /** Dry run unless the caller explicitly asked to apply the plan. */
  readonly apply: boolean;
  /** With apply, force-return only cancelled implementation task worktrees. */
  readonly discard?: boolean;
  /** With apply, return worktrees whose commits other work already carries; branches are kept. */
  readonly freeSuperseded?: boolean;
  readonly clock?: Clock;
  readonly newId?: () => string;
}>;

/** What one applied plan item actually did, which can differ from what the plan predicted. */
export type ReconcileResult = Readonly<{
  readonly item: ReconcilePlanItem;
  readonly outcome: ReconcileOutcome;
  readonly reason: string;
}>;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function observeCoordinatorLiveness(
  run: CommandRunner,
  home: string,
  found: DiscoveredCoordinatorRecord,
): Promise<CoordinatorLiveness> {
  try {
    const running = await findRunningCoordinator(run, {
      home,
      sessionId: found.sessionId,
      repoPath: found.record.repoPath,
    });
    return running === undefined ? { status: "stopped" } : { status: "live" };
  } catch (error) {
    return { status: "ambiguous", detail: describeFailure(error) };
  }
}

type CoordinatorScan = Readonly<{
  readonly coordinators: readonly ObservedCoordinator[];
  readonly unreadable: readonly UnreadableCoordinatorRecord[];
}>;

/**
 * Reads every stored coordinator record across sessions and asks Herdr whether each one still
 * answers. A record placed under a session directory it does not name is never probed: Tandem
 * cannot say whose coordinator that is, and probing would only aim commands at a stranger.
 */
async function observeCoordinators(
  input: ReconcileScanInput,
  home: string,
): Promise<CoordinatorScan> {
  const discovery = await discoverCoordinatorRecords({ home });
  const coordinators: ObservedCoordinator[] = [];
  for (const found of discovery.records) {
    if (found.placement === "foreign-directory") {
      coordinators.push({
        found,
        liveness: {
          status: "ambiguous",
          detail: "the record sits under a session directory it does not name",
        },
        checkout: undefined,
      });
      continue;
    }
    const liveness = await observeCoordinatorLiveness(input.run, home, found);
    coordinators.push({
      found,
      liveness,
      checkout:
        liveness.status === "stopped"
          ? await observeCoordinatorCheckout(input.run, found.record.worktree.path)
          : undefined,
    });
  }
  return { coordinators, unreadable: discovery.unreadable };
}

type PoolLocation = Readonly<{ readonly repoPath: string; readonly poolRoot: string }>;

async function poolLocations(
  input: ReconcileScanInput,
  coordinators: readonly ObservedCoordinator[],
): Promise<readonly PoolLocation[]> {
  const locations = new Map<string, PoolLocation>();
  const remember = (location: PoolLocation): void => {
    locations.set(JSON.stringify([location.repoPath, location.poolRoot]), location);
  };
  for (const repoPath of input.repoPaths) {
    remember({ repoPath: await canonicalPath(repoPath, "repoPath"), poolRoot: input.poolRoot });
  }
  for (const observed of coordinators) {
    remember({
      repoPath: observed.found.record.repoPath,
      poolRoot: observed.found.record.worktree.root,
    });
  }
  return [...locations.values()];
}

type PoolScan = Readonly<{
  readonly leases: readonly ObservedPoolLease[];
  readonly failures: readonly ReconcileScanFailure[];
}>;

/**
 * Lists the leases each pool still holds. Only a coordinator lease no stored record accounts for
 * has its checkout read: every other lease belongs to a task, whose own cleanup owner decides it.
 */
async function observePoolLeases(
  input: ReconcileScanInput,
  coordinators: readonly ObservedCoordinator[],
): Promise<PoolScan> {
  const recorded = new Set(coordinators.map((observed) => observed.found.record.worktree.leaseId));
  const leases: ObservedPoolLease[] = [];
  const failures: ReconcileScanFailure[] = [];
  for (const location of await poolLocations(input, coordinators)) {
    if (!(await directoryExists(location.poolRoot))) continue;
    let records: readonly TreehousePoolStatusRecord[];
    try {
      records = await readTreehousePoolStatus(input.run, {
        repo: location.repoPath,
        root: location.poolRoot,
      });
    } catch (error) {
      failures.push({
        subject: location.poolRoot,
        reason: `the Treehouse pool for ${location.repoPath} could not be read: ${describeFailure(error)}`,
      });
      continue;
    }
    for (const record of records) {
      if (recorded.has(record.leaseId)) continue;
      const path = resolve(location.poolRoot, record.path);
      const orphanedCoordinator = record.leaseHolder.startsWith(COORDINATOR_LEASE_HOLDER_PREFIX);
      leases.push({
        repoPath: location.repoPath,
        poolRoot: location.poolRoot,
        leaseId: record.leaseId,
        leaseHolder: record.leaseHolder,
        leasedAt: record.leasedAt,
        name: record.name,
        path,
        checkout: orphanedCoordinator
          ? await observeCoordinatorCheckout(input.run, path)
          : undefined,
      });
    }
  }
  return { leases, failures };
}

/**
 * Lists the terminal scouts whose cleanup is still unsettled, using the same durable eligibility
 * owner the cleanup itself uses, so the plan never promises work that owner would refuse.
 */
async function observePendingScouts(
  home: string,
  clock: Clock,
): Promise<readonly ObservedPendingScout[]> {
  if (!(await fileExists(databasePath(home)))) return [];
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock,
    idFactory: defaultIdFactory(),
  });
  const tasks = await store.list();
  const state = await readRuntimeState(runtimeFile(home));
  const pending: ObservedPendingScout[] = [];
  for (const task of tasks) {
    if (decideScoutCleanupEligibility(task).kind !== "eligible") continue;
    if (task.cleanup?.status === "quarantined") continue;
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || runtime.terminalCleanupRevision === task.revision) continue;
    pending.push({
      taskId: task.id,
      repoPath: task.repoPath,
      reason: `the ${task.stage} scout still holds child resources its coordinator did not release`,
    });
  }
  return pending;
}

/**
 * Lists terminal implementation tasks whose earlier cleanup did not settle. The task cleanup owner
 * rechecks the task and runtime under the state lock before touching any pane or lease.
 */
async function observePendingImplementations(
  run: CommandRunner,
  home: string,
  clock: Clock,
  discard: boolean,
): Promise<readonly ObservedPendingImplementation[]> {
  if (!(await fileExists(databasePath(home)))) return [];
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock,
    idFactory: defaultIdFactory(),
  });
  const tasks = await store.list();
  const state = await readRuntimeState(runtimeFile(home));
  const pending: ObservedPendingImplementation[] = [];
  const others = otherTaskWork(tasks, state);
  for (const task of tasks) {
    const explicitlyDiscardedBlocked =
      discard && task.kind === "implementation" && task.stage === "blocked";
    if (task.kind !== "implementation" || (!isTerminalTask(task) && !explicitlyDiscardedBlocked))
      continue;
    if (task.cleanup?.status === "quarantined") continue;
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || runtime.terminalCleanupRevision === task.revision) continue;
    const lease = runtime.worktree;
    const containment =
      lease !== undefined && (task.stage === "cancelled" || task.stage === "completed")
        ? await observeWorktreeContainment(
            run,
            taskCheckoutPath(task),
            lease,
            containerRefs(task, lease.branch, others),
          )
        : undefined;
    pending.push({
      taskId: task.id,
      repoPath: task.repoPath,
      reason: `the ${task.stage} implementation task still holds child resources its coordinator did not release`,
      ...(containment === undefined ? {} : { containment }),
    });
  }
  return pending;
}

/** Gathers every Tandem resource under one home without running a single mutating command. */
export async function scanTandemResources(
  input: ReconcileScanInput,
): Promise<ReconcileObservation> {
  const home = await canonicalHome(input.home);
  const { coordinators, unreadable } = await observeCoordinators(input, home);
  const { leases, failures } = await observePoolLeases(input, coordinators);
  const quarantines = await listCoordinatorQuarantineRecords(home);
  return {
    home,
    coordinators,
    leases,
    scouts: await observePendingScouts(home, input.clock),
    implementationTasks: await observePendingImplementations(
      input.run,
      home,
      input.clock,
      input.discard === true,
    ),
    unreadable,
    quarantines,
    settledQuarantineIds: await observeSettledQuarantines(input.run, quarantines, coordinators),
    failures,
  };
}

/**
 * Lists notes whose lease is provably gone and that no stored coordinator record still names.
 * A note whose lease cannot be read is kept.
 */
async function observeSettledQuarantines(
  run: CommandRunner,
  quarantines: readonly CoordinatorQuarantineRecord[],
  coordinators: readonly ObservedCoordinator[],
): Promise<readonly string[]> {
  const recorded = new Set(coordinators.map((observed) => observed.found.record.worktree.leaseId));
  const settled: string[] = [];
  // ponytail: one Treehouse status read per note; group by pool if notes number in the hundreds.
  for (const record of quarantines) {
    if (recorded.has(record.lease.leaseId)) continue;
    try {
      if ((await readCoordinatorLeasePresence(run, record.repoPath, record.lease)) === "absent") {
        settled.push(record.quarantineId);
      }
    } catch {
      // Unreadable or reassigned: keep the note so the lease stays accounted for.
    }
  }
  return settled;
}

function alreadyNoted(
  quarantines: readonly CoordinatorQuarantineRecord[],
  leaseId: string,
): boolean {
  return quarantines.some((record) => record.lease.leaseId === leaseId);
}

function planCoordinator(
  observed: ObservedCoordinator,
  quarantines: readonly CoordinatorQuarantineRecord[],
): ReconcilePlanItem {
  const { found, liveness } = observed;
  const noted = alreadyNoted(quarantines, found.record.worktree.leaseId);
  const item = (action: ReconcileAction, reason: string): ReconcilePlanItem => ({
    kind: "coordinator",
    action,
    reason,
    found,
    noted,
  });
  if (found.placement === "foreign-directory") {
    return item(
      "quarantine",
      `the record sits under a session directory it does not belong to; it names Herdr session ${JSON.stringify(found.sessionId)}`,
    );
  }
  if (liveness.status === "ambiguous") {
    return item(
      "quarantine",
      `the recorded coordinator could not be proved running or stopped: ${liveness.detail}`,
    );
  }
  if (liveness.status === "live") {
    return item(
      "retain",
      `a coordinator is running in Herdr session ${JSON.stringify(found.sessionId)} (pane ${JSON.stringify(found.record.endpoint.paneId)})`,
    );
  }
  const settlement = judgeCoordinatorCheckout(found.record, observed.checkout);
  if (settlement.kind !== "release") {
    return item(settlement.kind === "retain" ? "retain" : "quarantine", settlement.reason);
  }
  const checkout = observed.checkout;
  return item(
    "clean",
    `the coordinator recorded in Herdr session ${JSON.stringify(found.sessionId)} is stopped and its checkout ${
      checkout?.status === "observed" ? `is clean at ${checkout.head}` : "is no longer present"
    }; its pane can be closed and its lease released`,
  );
}

/**
 * Rebuilds the exact lease identity an orphaned coordinator worktree is held under, so a release
 * can name lease id, holder, and path rather than a pool position. A lease whose own metadata or
 * checkout is incomplete produces no identity at all, and is therefore never released.
 */
function orphanedCoordinatorLease(observed: ObservedPoolLease): WorktreeLease | undefined {
  const checkout = observed.checkout;
  const leasedAt = observed.leasedAt;
  if (checkout?.status !== "observed" || leasedAt === null) return undefined;
  if (checkout.branch.length === 0) return undefined;
  return {
    root: observed.poolRoot,
    path: observed.path,
    name: observed.name,
    baseHead: checkout.head,
    branch: checkout.branch,
    leaseId: observed.leaseId,
    leaseHolder: observed.leaseHolder,
    leasedAt,
  };
}

function planPoolLease(observed: ObservedPoolLease): ReconcilePlanItem {
  const lease = orphanedCoordinatorLease(observed);
  const item = (action: ReconcileAction, reason: string): ReconcilePlanItem => ({
    kind: "worktree-lease",
    action,
    reason,
    repoPath: observed.repoPath,
    observed,
    lease,
  });
  const checkout = observed.checkout;
  if (checkout === undefined) {
    return item(
      "retain",
      `the lease is held by ${JSON.stringify(observed.leaseHolder)}, which is not a Tandem coordinator`,
    );
  }
  if (checkout.status === "unreadable") {
    return item(
      "quarantine",
      `the orphaned coordinator checkout could not be read: ${checkout.detail}`,
    );
  }
  if (checkout.status === "missing") {
    return item("quarantine", "the orphaned coordinator lease points at a checkout that is gone");
  }
  if (checkout.dirty) {
    return item("retain", "the orphaned coordinator worktree has uncommitted changes");
  }
  if (checkout.unmerged) {
    return item("retain", "the orphaned coordinator worktree has unmerged paths");
  }
  if (lease === undefined) {
    return item("quarantine", "the orphaned coordinator lease does not expose a complete identity");
  }
  return item(
    "clean",
    `no coordinator record names this lease and its checkout is clean at ${checkout.head}`,
  );
}

/**
 * Turns one scan into the whole plan, before anything is touched.
 *
 * A `clean` item is a prediction, not a promise: applying it re-reads the resource and hands the
 * decision to its owner, which may still retain or quarantine what changed in between.
 */
export function planTandemReconciliation(
  observation: ReconcileObservation,
  options: Readonly<{ readonly freeSuperseded?: boolean }> = {},
): ReconcilePlan {
  const items: ReconcilePlanItem[] = [];
  for (const observed of observation.coordinators) {
    items.push(planCoordinator(observed, observation.quarantines));
  }
  for (const observed of observation.leases) items.push(planPoolLease(observed));
  for (const scout of observation.scouts) {
    items.push({
      kind: "scout-task",
      action: "clean",
      reason: scout.reason,
      taskId: scout.taskId,
      repoPath: scout.repoPath,
    });
  }
  for (const task of observation.implementationTasks ?? []) {
    const containment = task.containment;
    if (containment?.kind === "superseded" && options.freeSuperseded !== true) {
      items.push({
        kind: "superseded-task",
        action: "offer",
        reason: `its worktree is clean and every commit is already in ${containment.proof.label}`,
        taskId: task.taskId,
        repoPath: task.repoPath,
        proof: containment.proof,
      });
      continue;
    }
    items.push({
      kind: "implementation-task",
      action: "clean",
      reason: task.reason,
      taskId: task.taskId,
      repoPath: task.repoPath,
      ...(containment?.kind === "superseded" ? { free: containment.proof } : {}),
      ...(containment?.kind === "kept" ? { worktreeStays: containment.reason } : {}),
    });
  }

  for (const entry of observation.unreadable) {
    items.push({
      kind: "unreadable-record",
      action: "quarantine",
      reason: `the stored coordinator record could not be read and is left in place: ${entry.reason}`,
      path: entry.path,
    });
  }
  for (const record of observation.quarantines) {
    const settled = observation.settledQuarantineIds.includes(record.quarantineId);
    items.push({
      kind: "quarantine-note",
      action: settled ? "clean" : "quarantine",
      reason: settled
        ? `the lease this note kept track of has since been returned, so the note can be removed`
        : `${record.stage} quarantine from ${record.quarantinedAt}: ${record.reason}`,
      record,
      path: join(coordinatorQuarantineDirectory(observation.home), `${record.quarantineId}.json`),
      repoPath: record.repoPath,
      sessionId: record.sessionId,
    });
  }
  return { schemaVersion: RECONCILE_REPORT_SCHEMA_VERSION, items };
}

async function applyQuarantineNoteItem(
  input: ReconcileApplyInput,
  item: QuarantineNoteItem,
): Promise<ReconcileResult> {
  const outcome = await retireCoordinatorQuarantineNote(input.run, input.home, item.record);
  return outcome === "retired"
    ? { item, outcome: "cleaned", reason: item.reason }
    : { item, outcome: "quarantined", reason: "the lease this note tracks is held again" };
}

type CoordinatorItem = Extract<ReconcilePlanItem, Readonly<{ readonly kind: "coordinator" }>>;
type LeaseItem = Extract<ReconcilePlanItem, Readonly<{ readonly kind: "worktree-lease" }>>;
type ImplementationTaskItem = Extract<
  ReconcilePlanItem,
  Readonly<{ readonly kind: "implementation-task" }>
>;
type ScoutItem = Extract<ReconcilePlanItem, Readonly<{ readonly kind: "scout-task" }>>;
type QuarantineNoteItem = Extract<
  ReconcilePlanItem,
  Readonly<{ readonly kind: "quarantine-note" }>
>;
type RepositoryItem = CoordinatorItem | LeaseItem | QuarantineNoteItem;

/**
 * Settles one stopped coordinator through the owners a replacement launch uses: the workspace
 * retirement proves the pane closed, the settlement decides the lease, and the replacement
 * applier releases it and drops the record, or writes a durable quarantine note instead.
 */
async function applyCoordinatorItem(
  input: ReconcileApplyInput,
  item: CoordinatorItem,
): Promise<ReconcileResult> {
  const record = item.found.record;
  if (item.action === "retain") return { item, outcome: "retained", reason: item.reason };
  if (item.action === "quarantine") {
    if (item.noted) return { item, outcome: "quarantined", reason: item.reason };
    const outcome = await quarantineCoordinatorLease({
      home: input.home,
      sessionId: item.found.sessionId,
      repoPath: record.repoPath,
      stage: "exclusivity",
      reason: item.reason,
      lease: record.worktree,
      endpoint: record.endpoint,
      clock: input.clock,
      newId: input.newId,
    });
    return { item, outcome: "quarantined", reason: outcome.reason };
  }
  const settled = await withCoordinatorLaunchLock(input.home, item.found.sessionId, async () => {
    const paneRetirement = await retireCoordinatorWorkspace(input.run, record);
    return applyCoordinatorReplacement({
      run: input.run,
      home: input.home,
      sessionId: item.found.sessionId,
      repoPath: record.repoPath,
      clock: input.clock,
      newId: input.newId,
      decision: decideCoordinatorLeaseSettlement({
        previous: record,
        paneRetirement,
        checkout: await observeCoordinatorCheckout(input.run, record.worktree.path),
      }),
    });
  });
  if (settled.outcome === "retained") return { item, outcome: "retained", reason: settled.reason };
  if (settled.outcome === "quarantined") {
    return { item, outcome: "quarantined", reason: settled.reason };
  }
  return { item, outcome: "cleaned", reason: settled.reason };
}

/**
 * Returns one orphaned coordinator lease by its exact identity, or leaves it in place.
 *
 * A quarantined lease gets no durable note: its Treehouse metadata says nothing about the commit
 * or branch behind it, and a note that invented those would be worse than the report line that
 * names the lease and says why Tandem refused to touch it.
 */
async function applyLeaseItem(
  input: ReconcileApplyInput,
  item: LeaseItem,
): Promise<ReconcileResult> {
  const lease = item.lease;
  if (item.action === "retain") return { item, outcome: "retained", reason: item.reason };
  if (item.action === "quarantine" || lease === undefined) {
    return { item, outcome: "quarantined", reason: item.reason };
  }
  const released = await releaseCoordinatorLease(input.run, { repoPath: item.repoPath, lease });
  return {
    item,
    outcome: "cleaned",
    reason:
      released === "released" ? item.reason : "the orphaned coordinator lease was already gone",
  };
}

function taskCleanupResult(
  item: ScoutItem | ImplementationTaskItem,
  outcome: TaskCleanupOutcome | undefined,
): ReconcileResult {
  const label = item.kind === "scout-task" ? "scout" : "implementation task";
  if (outcome === undefined) {
    return { item, outcome: "retained", reason: `the ${label} settled before cleanup reached it` };
  }
  if (outcome.status === "released") return { item, outcome: "cleaned", reason: outcome.reason };
  if (outcome.status === "quarantined") {
    return { item, outcome: "quarantined", reason: outcome.reason };
  }
  return { item, outcome: "retained", reason: outcome.reason };
}

/** Finishes every unsettled scout through the one durable owner that may release their resources. */
async function applyScoutItems(
  input: ReconcileApplyInput,
  items: readonly ScoutItem[],
  results: Map<ReconcilePlanItem, ReconcileResult>,
): Promise<void> {
  let settled: readonly TaskCleanupOutcome[];
  try {
    settled = await finishPendingScoutCleanup({
      home: input.home,
      run: input.run,
      clock: input.clock,
    });
  } catch (error) {
    const reason = describeFailure(error);
    for (const item of items) results.set(item, { item, outcome: "failed", reason });
    return;
  }
  const outcomes = new Map(settled.map((outcome) => [outcome.taskId, outcome]));
  for (const item of items) results.set(item, taskCleanupResult(item, outcomes.get(item.taskId)));
}

/** Finishes every unsettled implementation task through the durable task cleanup owner. */
async function applyImplementationItems(
  input: ReconcileApplyInput,
  items: readonly ImplementationTaskItem[],
  results: Map<ReconcilePlanItem, ReconcileResult>,
): Promise<void> {
  let settled: readonly TaskCleanupOutcome[];
  try {
    const free = new Map<string, SupersededProof>();
    for (const item of items) if (item.free !== undefined) free.set(item.taskId, item.free);
    settled = await finishPendingImplementationCleanup({
      home: input.home,
      run: input.run,
      clock: input.clock,
      discard: input.discard,
      taskIds: new Set(items.map((item) => item.taskId)),
      free,
    });
  } catch (error) {
    const reason = describeFailure(error);
    for (const item of items) results.set(item, { item, outcome: "failed", reason });
    return;
  }
  const outcomes = new Map(settled.map((outcome) => [outcome.taskId, outcome]));
  for (const item of items) results.set(item, taskCleanupResult(item, outcomes.get(item.taskId)));
}

type ReconcileWork = Readonly<{
  readonly repositories: ReadonlyMap<string, readonly RepositoryItem[]>;
  readonly scouts: readonly ScoutItem[];
  readonly implementationTasks: readonly ImplementationTaskItem[];
  readonly reported: readonly ReconcilePlanItem[];
}>;

/** Sorts plan items by the owner that must carry them out, keeping each repository's together. */
function reconcileWork(plan: ReconcilePlan): ReconcileWork {
  const repositories = new Map<string, RepositoryItem[]>();
  const scouts: ScoutItem[] = [];
  const implementationTasks: ImplementationTaskItem[] = [];
  const reported: ReconcilePlanItem[] = [];
  for (const item of plan.items) {
    if (item.kind === "scout-task") {
      scouts.push(item);
      continue;
    }
    if (item.kind === "implementation-task") {
      implementationTasks.push(item);
      continue;
    }
    if (
      item.kind !== "coordinator" &&
      item.kind !== "worktree-lease" &&
      !(item.kind === "quarantine-note" && item.action === "clean")
    ) {
      reported.push(item);
      continue;
    }
    const repoPath = item.kind === "coordinator" ? item.found.record.repoPath : item.repoPath;
    const group = repositories.get(repoPath);
    if (group === undefined) repositories.set(repoPath, [item]);
    else group.push(item);
  }
  return { repositories, scouts, implementationTasks, reported };
}

/**
 * Carries out one plan.
 *
 * Coordinator and lease work is grouped per repository and held under that repository's shared
 * lock, so a launch in another session cannot allocate underneath the reconcile. Task cleanup runs
 * through its durable owner, which revalidates state and lease identity before every release.
 * Unreadable records are only ever reported. A quarantine note is deleted only after its lease is
 * re-read under the repository lock and found returned.
 */
export async function applyTandemReconciliation(
  input: ReconcileApplyInput,
): Promise<readonly ReconcileResult[]> {
  const results = new Map<ReconcilePlanItem, ReconcileResult>();
  const work = reconcileWork(input.plan);
  for (const item of work.reported) {
    const outcome = item.kind === "superseded-task" ? "freeable" : "quarantined";
    results.set(item, { item, outcome, reason: item.reason });
  }
  for (const [repoPath, items] of work.repositories) {
    await withCoordinatorRepositoryLock(input.home, repoPath, async () => {
      for (const item of items) {
        try {
          results.set(
            item,
            item.kind === "coordinator"
              ? await applyCoordinatorItem(input, item)
              : item.kind === "quarantine-note"
                ? await applyQuarantineNoteItem(input, item)
                : await applyLeaseItem(input, item),
          );
        } catch (error) {
          results.set(item, { item, outcome: "failed", reason: describeFailure(error) });
        }
      }
    });
  }
  if (work.implementationTasks.length > 0) {
    await applyImplementationItems(input, work.implementationTasks, results);
  }
  if (work.scouts.length > 0) await applyScoutItems(input, work.scouts, results);
  return input.plan.items.map(
    (item) =>
      results.get(item) ?? { item, outcome: "failed", reason: "the plan item was never applied" },
  );
}

function entryFor(item: ReconcilePlanItem, reason: string): ReconcileReportEntry {
  if (item.kind === "coordinator") {
    return {
      kind: item.kind,
      id: item.found.path,
      reason,
      repoPath: item.found.record.repoPath,
      sessionId: item.found.sessionId,
      path: item.found.path,
    };
  }
  if (item.kind === "worktree-lease") {
    return {
      kind: item.kind,
      id: item.observed.leaseId,
      reason,
      repoPath: item.repoPath,
      path: item.observed.path,
    };
  }
  if (item.kind === "superseded-task") {
    return {
      kind: "implementation-task",
      id: item.taskId,
      reason,
      repoPath: item.repoPath,
      containedIn: item.proof.label,
    };
  }
  if (item.kind === "implementation-task") {
    return {
      kind: item.kind,
      id: item.taskId,
      reason,
      repoPath: item.repoPath,
      ...(item.free === undefined ? {} : { containedIn: item.free.label }),
      ...(item.worktreeStays === undefined ? {} : { worktreeStays: item.worktreeStays }),
    };
  }
  if (item.kind === "scout-task") {
    return { kind: item.kind, id: item.taskId, reason, repoPath: item.repoPath };
  }
  if (item.kind === "unreadable-record") {
    return { kind: item.kind, id: item.path, reason, path: item.path };
  }
  return {
    kind: item.kind,
    id: item.path,
    reason,
    repoPath: item.repoPath,
    sessionId: item.sessionId,
    path: item.path,
  };
}

function plannedOutcome(action: ReconcilePlanItem["action"]): ReconcileOutcome {
  if (action === "offer") return "freeable";
  if (action === "clean") return "cleaned";
  return action === "retain" ? "retained" : "quarantined";
}

function reportFrom(
  input: Readonly<{
    readonly home: string;
    readonly mode: ReconcileReport["mode"];
    readonly results: readonly ReconcileResult[];
    readonly failures: readonly ReconcileScanFailure[];
  }>,
): ReconcileReport {
  const buckets: Record<ReconcileOutcome, ReconcileReportEntry[]> = {
    cleaned: [],
    retained: [],
    quarantined: [],
    failed: [],
    freeable: [],
  };
  for (const result of input.results) {
    buckets[result.outcome].push(entryFor(result.item, result.reason));
  }
  for (const failure of input.failures) {
    buckets.failed.push({
      kind: "worktree-lease",
      id: failure.subject,
      reason: failure.reason,
      path: failure.subject,
    });
  }
  return {
    schemaVersion: RECONCILE_REPORT_SCHEMA_VERSION,
    mode: input.mode,
    home: input.home,
    cleaned: buckets.cleaned,
    retained: buckets.retained,
    quarantined: buckets.quarantined,
    failed: buckets.failed,
    freeable: buckets.freeable,
  };
}

/**
 * Scans, classifies, and, when explicitly asked, settles every Tandem resource under one home.
 *
 * Without `apply` nothing is touched: the scan runs read-only commands, the plan is pure, and the
 * report says what an apply would do. Applying is idempotent, because every item is re-decided by
 * its owner against the resource as it is at that moment.
 */
export async function reconcileTandemResources(input: ReconcileInput): Promise<ReconcileReport> {
  const clock = input.clock ?? ((): string => new Date().toISOString());
  const newId = input.newId ?? randomUUID;
  const observation = await scanTandemResources({
    run: input.run,
    home: input.home,
    poolRoot: input.poolRoot,
    repoPaths: input.repoPaths,
    ...(input.discard === undefined ? {} : { discard: input.discard }),
    clock,
  });
  const plan = planTandemReconciliation(observation, {
    freeSuperseded: input.apply && input.freeSuperseded === true,
  });
  if (!input.apply) {
    return reportFrom({
      home: observation.home,
      mode: "dry-run",
      failures: observation.failures,
      results: plan.items.map((item) => ({
        item,
        outcome: plannedOutcome(item.action),
        reason: item.reason,
      })),
    });
  }
  return reportFrom({
    home: observation.home,
    mode: "applied",
    failures: observation.failures,
    results: await applyTandemReconciliation({
      run: input.run,
      home: observation.home,
      plan,
      clock,
      newId,
      discard: input.discard === true,
    }),
  });
}
