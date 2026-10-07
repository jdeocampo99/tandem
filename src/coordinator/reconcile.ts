import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorktreeInUseError } from "../adapters/primitives.ts";
import { readTreehousePoolStatus, type TreehousePoolStatusRecord } from "../adapters/treehouse.ts";
import type { Clock, CommandRunner, TaskRecord, WorktreeLease } from "../contracts.ts";
import { taskRuntime } from "../runtime/activity.ts";
import { databasePath } from "../runtime/database.ts";
import { defaultIdFactory, readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import type { RuntimeState, RuntimeTaskState } from "../runtime/schema.ts";
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
import type {
  QuarantinedPane,
  RetainedViewOpen,
  TerminalBackend,
} from "../terminal-backend/contract.ts";
import { withCoordinatorLaunchLock, withCoordinatorRepositoryLock } from "./lock.ts";
import { findRunningCoordinator } from "./ownership.ts";
import {
  type CoordinatorQuarantineRecord,
  coordinatorQuarantineDirectory,
  isCoordinatorEffectQuarantine,
  listCoordinatorQuarantineRecords,
} from "./quarantine.ts";
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
  decideCoordinatorLeaseSettlement,
  judgeCoordinatorCheckout,
  observeCoordinatorCheckout,
  quarantineCoordinatorLease,
  readCoordinatorLeasePresence,
  releaseCoordinatorLease,
  retireCoordinatorQuarantineNote,
} from "./resources.ts";
import { retireCoordinatorWorkspace } from "./workspace.ts";

/** Version of the machine-readable reconciliation report; bumped when its shape changes. */
export const RECONCILE_REPORT_SCHEMA_VERSION = 3 as const;

/** The kinds of resource reconciliation knows how to classify. */
export type ReconcileResourceKind =
  | "coordinator"
  | "worktree-lease"
  | "scout-task"
  | "implementation-task"
  | "unreadable-record"
  | "quarantine-note"
  | "native-open"
  | "tern-quarantine";

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
  readonly kind: Extract<
    ReconcileResourceKind,
    "worktree-lease" | "native-open" | "tern-quarantine"
  >;
  readonly subject: string;
  readonly reason: string;
  /** The path that could not be read, when the subject is one. */
  readonly path?: string;
}>;

/** Whether a retained native open's coordinator is exactly present, exactly gone, or unclear. */
export type NativeOpenOwner =
  | Readonly<{ readonly status: "present" }>
  | Readonly<{ readonly status: "gone" }>
  | Readonly<{ readonly status: "ambiguous"; readonly detail: string }>;

type ReadableViewOpen = Extract<RetainedViewOpen, Readonly<{ status: "readable" }>>;

/** One native view open whose outcome was never proved, which pauses new opens for its owner. */
export type ObservedNativeOpen =
  | Readonly<{ readonly open: ReadableViewOpen; readonly owner: NativeOpenOwner }>
  | Readonly<{ readonly unreadable: Readonly<{ path: string; reason: string }> }>;

type ReadableQuarantinedPane = Extract<QuarantinedPane, Readonly<{ status: "readable" }>>;

/** Whether a quarantined pane can never repeat its doubted effect: gone, or idle at its exact id. */
export type QuarantinedPaneState =
  | Readonly<{ readonly status: "gone" }>
  | Readonly<{ readonly status: "idle" }>
  | Readonly<{ readonly status: "busy" }>
  | Readonly<{ readonly status: "ambiguous"; readonly detail: string }>;

/** One pane Tandem refuses to touch because an effect there ended with an unknown outcome. */
export type ObservedQuarantinedPane =
  | Readonly<{ readonly pane: ReadableQuarantinedPane; readonly state: QuarantinedPaneState }>
  | Readonly<{ readonly unreadable: Readonly<{ path: string; reason: string }> }>;

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
  readonly nativeOpens: readonly ObservedNativeOpen[];
  readonly quarantinedPanes: readonly ObservedQuarantinedPane[];
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
    }>
  | Readonly<{
      readonly kind: "native-open";
      readonly action: "clean" | "retain" | "quarantine";
      readonly reason: string;
      readonly path: string;
      readonly sessionId: string | undefined;
      /** Present only when the record parsed; an unreadable one is only ever reported. */
      readonly open: ReadableViewOpen | undefined;
    }>
  | Readonly<{
      readonly kind: "tern-quarantine";
      readonly action: "clean" | "retain" | "quarantine";
      readonly reason: string;
      readonly path: string;
      readonly sessionId: string | undefined;
      /** Present only when the record parsed; an unreadable one is only ever reported. */
      readonly pane: ReadableQuarantinedPane | undefined;
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
  readonly terminal: TerminalBackend;
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
  readonly terminal: TerminalBackend;
  readonly home: string;
  readonly plan: ReconcilePlan;
  readonly clock: Clock;
  readonly newId: () => string;
  /** Explicitly force-return cancelled implementation worktrees after identity checks. */
  readonly discard: boolean;
}>;

export type ReconcileInput = Readonly<{
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
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
  terminal: TerminalBackend,
  home: string,
  found: DiscoveredCoordinatorRecord,
): Promise<CoordinatorLiveness> {
  try {
    const running = await findRunningCoordinator(run, terminal, {
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
 * Reads every stored coordinator record across sessions and asks the terminal whether each one still
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
    const liveness = await observeCoordinatorLiveness(input.run, input.terminal, home, found);
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
        kind: "worktree-lease",
        path: location.poolRoot,
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

type TaskState = Readonly<{
  readonly tasks: readonly TaskRecord[];
  readonly state: RuntimeState;
}>;

/** Reads durable tasks and runtime state, or nothing when this home has never stored a task. */
async function readTaskState(home: string, clock: Clock): Promise<TaskState | undefined> {
  if (!(await fileExists(databasePath(home)))) return undefined;
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock,
    idFactory: defaultIdFactory(),
  });
  const tasks = await store.list();
  return { tasks, state: await readRuntimeState(runtimeFile(home)) };
}

/** A task whose cleanup already settled, or was quarantined, has nothing left for reconcile. */
function cleanupUnsettled(task: TaskRecord, runtime: RuntimeTaskState | undefined): boolean {
  return (
    task.cleanup?.status !== "quarantined" &&
    runtime !== undefined &&
    runtime.terminalCleanupRevision !== task.revision
  );
}

function implementationAwaitsCleanup(task: TaskRecord, discard: boolean): boolean {
  if (task.kind !== "implementation") return false;
  return isTerminalTask(task) || (discard && task.stage === "blocked");
}

/**
 * Lists the terminal scouts whose cleanup is still unsettled, using the same durable eligibility
 * owner the cleanup itself uses, so the plan never promises work that owner would refuse.
 */
async function observePendingScouts(
  home: string,
  clock: Clock,
): Promise<readonly ObservedPendingScout[]> {
  const stored = await readTaskState(home, clock);
  if (stored === undefined) return [];
  return stored.tasks
    .filter(
      (task) =>
        decideScoutCleanupEligibility(task).kind === "eligible" &&
        cleanupUnsettled(task, taskRuntime(stored.state, task.id)),
    )
    .map((task) => ({
      taskId: task.id,
      repoPath: task.repoPath,
      reason: `the ${task.stage} scout still holds child resources its coordinator did not release`,
    }));
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
  const stored = await readTaskState(home, clock);
  if (stored === undefined) return [];
  const { tasks, state } = stored;
  const pending: ObservedPendingImplementation[] = [];
  const others = otherTaskWork(tasks, state);
  for (const task of tasks) {
    if (!implementationAwaitsCleanup(task, discard)) continue;
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || !cleanupUnsettled(task, runtime)) continue;
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
  const native = await observeNativeOpens(input.terminal, home);
  const panes = await observeQuarantinedPanes(input.terminal, home);
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
    failures: [...failures, ...native.failures, ...panes.failures],
    nativeOpens: native.opens,
    quarantinedPanes: panes.panes,
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
  const effect = quarantines.find(
    (note) =>
      isCoordinatorEffectQuarantine(note) &&
      note.lease.leaseId === found.record.worktree.leaseId &&
      note.lease.path === found.record.worktree.path,
  );
  if (effect !== undefined) return item("quarantine", effect.reason);
  if (found.placement === "foreign-directory") {
    return item(
      "quarantine",
      `the record sits under a session directory it does not belong to; it names terminal session ${JSON.stringify(found.sessionId)}`,
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
      `a coordinator is running in terminal session ${JSON.stringify(found.sessionId)} (pane ${JSON.stringify(found.record.endpoint.paneId)})`,
    );
  }
  const settlement = judgeCoordinatorCheckout(found.record, observed.checkout);
  if (settlement.kind !== "release") {
    return item(settlement.kind === "retain" ? "retain" : "quarantine", settlement.reason);
  }
  const checkout = observed.checkout;
  return item(
    "clean",
    `the coordinator recorded in terminal session ${JSON.stringify(found.sessionId)} is stopped and its checkout ${
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

function planPoolLease(
  observed: ObservedPoolLease,
  quarantines: readonly CoordinatorQuarantineRecord[],
): ReconcilePlanItem {
  const lease = orphanedCoordinatorLease(observed);
  const item = (action: ReconcileAction, reason: string): ReconcilePlanItem => ({
    kind: "worktree-lease",
    action,
    reason,
    repoPath: observed.repoPath,
    observed,
    lease,
  });
  const effect = quarantines.find(
    (note) =>
      isCoordinatorEffectQuarantine(note) &&
      note.lease.leaseId === observed.leaseId &&
      note.lease.path === observed.path,
  );
  if (effect !== undefined) return item("quarantine", effect.reason);
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

function planScout(scout: ObservedPendingScout): ReconcilePlanItem {
  return {
    kind: "scout-task",
    action: "clean",
    reason: scout.reason,
    taskId: scout.taskId,
    repoPath: scout.repoPath,
  };
}

/** A superseded worktree is only offered unless freeing it was separately approved. */
function planImplementationTask(
  task: ObservedPendingImplementation,
  freeSuperseded: boolean,
): ReconcilePlanItem {
  const containment = task.containment;
  if (containment?.kind === "superseded" && !freeSuperseded) {
    return {
      kind: "superseded-task",
      action: "offer",
      reason: `its worktree is clean and every commit is already in ${containment.proof.label}`,
      taskId: task.taskId,
      repoPath: task.repoPath,
      proof: containment.proof,
    };
  }
  return {
    kind: "implementation-task",
    action: "clean",
    reason: task.reason,
    taskId: task.taskId,
    repoPath: task.repoPath,
    ...(containment?.kind === "superseded" ? { free: containment.proof } : {}),
    ...(containment?.kind === "kept" ? { worktreeStays: containment.reason } : {}),
  };
}

function planUnreadableRecord(entry: UnreadableCoordinatorRecord): ReconcilePlanItem {
  return {
    kind: "unreadable-record",
    action: "quarantine",
    reason: `the stored coordinator record could not be read and is left in place: ${entry.reason}`,
    path: entry.path,
  };
}

/**
 * Whether a retained open's coordinator is exactly present or exactly gone. Anything the terminal
 * cannot answer exactly, including a detached listing, leaves the open retained.
 */
async function nativeOpenOwner(
  terminal: TerminalBackend,
  open: ReadableViewOpen,
): Promise<NativeOpenOwner> {
  try {
    await terminal.inspect({ endpoint: open.coordinator, cwd: open.cwd });
    return { status: "present" };
  } catch (error) {
    return terminal.isEndpointGone(error)
      ? { status: "gone" }
      : { status: "ambiguous", detail: describeFailure(error) };
  }
}

async function observeNativeOpens(
  terminal: TerminalBackend,
  home: string,
): Promise<Readonly<{ opens: readonly ObservedNativeOpen[]; failures: ReconcileScanFailure[] }>> {
  let retained: readonly RetainedViewOpen[];
  try {
    retained = (await terminal.views?.retained(home)) ?? [];
  } catch (error) {
    return {
      opens: [],
      failures: [
        {
          kind: "native-open",
          subject: "native view opens",
          reason: `paused views could not be listed: ${describeFailure(error)}`,
        },
      ],
    };
  }
  const opens: ObservedNativeOpen[] = [];
  for (const open of retained)
    opens.push(
      open.status === "unreadable"
        ? { unreadable: open }
        : { open, owner: await nativeOpenOwner(terminal, open) },
    );
  return { opens, failures: [] };
}

function planNativeOpen(observed: ObservedNativeOpen): ReconcilePlanItem {
  if ("unreadable" in observed)
    return {
      kind: "native-open",
      action: "quarantine",
      reason: `the paused Tern view record could not be read and is left in place: ${observed.unreadable.reason}`,
      path: observed.unreadable.path,
      sessionId: undefined,
      open: undefined,
    };
  const { open, owner } = observed;
  const item = (action: "clean" | "retain", why: string): ReconcilePlanItem => ({
    kind: "native-open",
    action,
    reason: `${open.view} view: ${open.reason}; ${why}`,
    path: open.path,
    sessionId: open.coordinator.sessionId,
    open,
  });
  if (owner.status === "present")
    return item(
      "clean",
      "new Tandem views stay paused for its running coordinator until the record is abandoned; every pane is kept",
    );
  if (owner.status === "gone")
    return item("clean", "its coordinator is gone, so the record can be removed");
  return item("retain", `kept because its coordinator cannot be proved: ${owner.detail}`);
}

async function applyNativeOpenItem(
  terminal: TerminalBackend,
  item: NativeOpenItem,
): Promise<ReconcileResult> {
  const views = terminal.views;
  if (item.open === undefined || views === undefined)
    return { item, outcome: "quarantined", reason: item.reason };
  const { open } = item;
  let detail = "";
  const outcome = await views.abandon(open, async () => {
    const owner = await nativeOpenOwner(terminal, open);
    if (owner.status === "ambiguous") detail = owner.detail;
    return owner.status !== "ambiguous";
  });
  if (outcome === "abandoned" || outcome === "settled")
    return { item, outcome: "cleaned", reason: item.reason };
  return {
    item,
    outcome: "retained",
    reason:
      outcome === "changed"
        ? "the paused view record changed while fix ran, so it was kept"
        : `kept because its coordinator cannot be proved: ${detail}`,
  };
}

/**
 * Whether a quarantined pane is gone or idle at its exact id. Anything the terminal cannot answer
 * exactly, including a detached listing, keeps the record.
 */
async function quarantinedPaneState(
  terminal: TerminalBackend,
  pane: ReadableQuarantinedPane,
): Promise<QuarantinedPaneState> {
  try {
    const inspected = await terminal.inspect({ endpoint: pane.endpoint, cwd: pane.cwd });
    return { status: inspected.activeWorker ? "busy" : "idle" };
  } catch (error) {
    return terminal.isEndpointGone(error)
      ? { status: "gone" }
      : { status: "ambiguous", detail: describeFailure(error) };
  }
}

async function observeQuarantinedPanes(
  terminal: TerminalBackend,
  home: string,
): Promise<
  Readonly<{ panes: readonly ObservedQuarantinedPane[]; failures: ReconcileScanFailure[] }>
> {
  let listed: readonly QuarantinedPane[];
  try {
    listed = await terminal.quarantinedPanes(home);
  } catch (error) {
    return {
      panes: [],
      failures: [
        {
          kind: "tern-quarantine",
          subject: "quarantined panes",
          reason: `quarantined panes could not be listed: ${describeFailure(error)}`,
        },
      ],
    };
  }
  const panes: ObservedQuarantinedPane[] = [];
  for (const pane of listed)
    panes.push(
      pane.status === "unreadable"
        ? { unreadable: pane }
        : { pane, state: await quarantinedPaneState(terminal, pane) },
    );
  return { panes, failures: [] };
}

function planQuarantinedPane(observed: ObservedQuarantinedPane): ReconcilePlanItem {
  if ("unreadable" in observed)
    return {
      kind: "tern-quarantine",
      action: "quarantine",
      reason: `the Tern pane quarantine record could not be read and is left in place: ${observed.unreadable.reason}`,
      path: observed.unreadable.path,
      sessionId: undefined,
      pane: undefined,
    };
  const { pane, state } = observed;
  const item = (action: "clean" | "retain", why: string): ReconcilePlanItem => ({
    kind: "tern-quarantine",
    action,
    reason: `${pane.operation} on ${pane.key} at ${pane.at} has an unknown outcome (${pane.reason}); ${why}`,
    path: pane.path,
    sessionId: pane.endpoint.sessionId,
    pane,
  });
  if (state.status === "gone")
    return item("clean", "the pane is gone, so the record can be removed");
  if (state.status === "idle")
    return item(
      "clean",
      "the pane is idle at its exact id, so the record can be removed; the pane is kept",
    );
  if (state.status === "busy")
    return item("retain", "kept because the pane is still running something");
  return item("retain", `kept because the pane cannot be proved: ${state.detail}`);
}

async function applyQuarantinedPaneItem(
  terminal: TerminalBackend,
  item: QuarantinedPaneItem,
): Promise<ReconcileResult> {
  if (item.pane === undefined) return { item, outcome: "quarantined", reason: item.reason };
  const { pane } = item;
  let detail = "";
  const outcome = await terminal.clearPaneQuarantine(pane, async () => {
    const state = await quarantinedPaneState(terminal, pane);
    if (state.status === "ambiguous") detail = state.detail;
    if (state.status === "busy") detail = "the pane is running something";
    return state.status === "gone" || state.status === "idle";
  });
  if (outcome === "cleared" || outcome === "settled")
    return { item, outcome: "cleaned", reason: item.reason };
  return {
    item,
    outcome: "retained",
    reason:
      outcome === "changed"
        ? "the pane quarantine record changed while fix ran, so it was kept"
        : `kept because the pane is not proven gone or idle: ${detail}`,
  };
}

function planQuarantineNote(
  record: CoordinatorQuarantineRecord,
  observation: ReconcileObservation,
): ReconcilePlanItem {
  const settled = observation.settledQuarantineIds.includes(record.quarantineId);
  return {
    kind: "quarantine-note",
    action: settled ? "clean" : "quarantine",
    reason: settled
      ? `the lease this note kept track of has since been returned, so the note can be removed`
      : `${record.stage} quarantine from ${record.quarantinedAt}: ${record.reason}`,
    record,
    path: join(coordinatorQuarantineDirectory(observation.home), `${record.quarantineId}.json`),
    repoPath: record.repoPath,
    sessionId: record.sessionId,
  };
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
  const freeSuperseded = options.freeSuperseded === true;
  const items: ReconcilePlanItem[] = [
    ...observation.coordinators.map((observed) =>
      planCoordinator(observed, observation.quarantines),
    ),
    ...observation.leases.map((lease) => planPoolLease(lease, observation.quarantines)),
    ...observation.scouts.map(planScout),
    ...(observation.implementationTasks ?? []).map((task) =>
      planImplementationTask(task, freeSuperseded),
    ),
    ...observation.unreadable.map(planUnreadableRecord),
    ...observation.quarantines.map((record) => planQuarantineNote(record, observation)),
    ...observation.nativeOpens.map(planNativeOpen),
    ...observation.quarantinedPanes.map(planQuarantinedPane),
  ];
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
    const paneRetirement = await retireCoordinatorWorkspace(input.terminal, input.home, record);
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
  let released: Awaited<ReturnType<typeof releaseCoordinatorLease>>;
  try {
    released = await releaseCoordinatorLease(input.run, {
      home: input.home,
      repoPath: item.repoPath,
      lease,
    });
  } catch (error) {
    if (!(error instanceof WorktreeInUseError)) throw error;
    return { item, outcome: "retained", reason: error.message };
  }
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

/** Runs one durable task cleanup owner and records its outcome for each item, failing all on error. */
async function recordTaskCleanup(
  items: readonly (ScoutItem | ImplementationTaskItem)[],
  finishCleanup: () => Promise<readonly TaskCleanupOutcome[]>,
  results: Map<ReconcilePlanItem, ReconcileResult>,
): Promise<void> {
  let settled: readonly TaskCleanupOutcome[];
  try {
    settled = await finishCleanup();
  } catch (error) {
    const reason = describeFailure(error);
    for (const item of items) results.set(item, { item, outcome: "failed", reason });
    return;
  }
  const outcomes = new Map(settled.map((outcome) => [outcome.taskId, outcome]));
  for (const item of items) results.set(item, taskCleanupResult(item, outcomes.get(item.taskId)));
}

/** Finishes every unsettled scout through the one durable owner that may release their resources. */
function applyScoutItems(
  input: ReconcileApplyInput,
  items: readonly ScoutItem[],
  results: Map<ReconcilePlanItem, ReconcileResult>,
): Promise<void> {
  return recordTaskCleanup(
    items,
    () =>
      finishPendingScoutCleanup({
        home: input.home,
        run: input.run,
        terminal: input.terminal,
        clock: input.clock,
      }),
    results,
  );
}

/** Finishes every unsettled implementation task through the durable task cleanup owner. */
function applyImplementationItems(
  input: ReconcileApplyInput,
  items: readonly ImplementationTaskItem[],
  results: Map<ReconcilePlanItem, ReconcileResult>,
): Promise<void> {
  const free = new Map<string, SupersededProof>();
  for (const item of items) if (item.free !== undefined) free.set(item.taskId, item.free);
  return recordTaskCleanup(
    items,
    () =>
      finishPendingImplementationCleanup({
        home: input.home,
        run: input.run,
        terminal: input.terminal,
        clock: input.clock,
        discard: input.discard,
        taskIds: new Set(items.map((item) => item.taskId)),
        free,
      }),
    results,
  );
}

function applyRepositoryItem(
  input: ReconcileApplyInput,
  item: RepositoryItem,
): Promise<ReconcileResult> {
  if (item.kind === "coordinator") return applyCoordinatorItem(input, item);
  if (item.kind === "quarantine-note") return applyQuarantineNoteItem(input, item);
  return applyLeaseItem(input, item);
}

type NativeOpenItem = Extract<ReconcilePlanItem, Readonly<{ readonly kind: "native-open" }>>;
type QuarantinedPaneItem = Extract<
  ReconcilePlanItem,
  Readonly<{ readonly kind: "tern-quarantine" }>
>;

type ReconcileWork = Readonly<{
  readonly repositories: ReadonlyMap<string, readonly RepositoryItem[]>;
  readonly scouts: readonly ScoutItem[];
  readonly implementationTasks: readonly ImplementationTaskItem[];
  readonly nativeOpens: readonly NativeOpenItem[];
  readonly quarantinedPanes: readonly QuarantinedPaneItem[];
  readonly reported: readonly ReconcilePlanItem[];
}>;

/** Sorts plan items by the owner that must carry them out, keeping each repository's together. */
function reconcileWork(plan: ReconcilePlan): ReconcileWork {
  const repositories = new Map<string, RepositoryItem[]>();
  const scouts: ScoutItem[] = [];
  const implementationTasks: ImplementationTaskItem[] = [];
  const nativeOpens: NativeOpenItem[] = [];
  const quarantinedPanes: QuarantinedPaneItem[] = [];
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
    if (item.kind === "native-open" && item.action === "clean") {
      nativeOpens.push(item);
      continue;
    }
    if (item.kind === "tern-quarantine" && item.action === "clean") {
      quarantinedPanes.push(item);
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
  return { repositories, scouts, implementationTasks, nativeOpens, quarantinedPanes, reported };
}

/**
 * Carries out one plan.
 *
 * Coordinator and lease work is grouped per repository and held under that repository's shared
 * lock, so a launch in another session cannot allocate underneath the reconcile. Task cleanup runs
 * through its durable owner, which revalidates state and lease identity before every release.
 * Unreadable records are only ever reported. A quarantine note is deleted only after its lease is
 * re-read under the repository lock and found returned. A retained native open is abandoned only
 * under its own open lock, after its coordinator is proved exactly present or exactly gone again.
 * A pane quarantine record is cleared only under its own lock, after the pane is proved gone or
 * idle at its exact id again; the pane itself is never touched.
 */
export async function applyTandemReconciliation(
  input: ReconcileApplyInput,
): Promise<readonly ReconcileResult[]> {
  const results = new Map<ReconcilePlanItem, ReconcileResult>();
  const work = reconcileWork(input.plan);
  for (const item of work.reported) {
    results.set(item, { item, outcome: plannedOutcome(item.action), reason: item.reason });
  }
  for (const item of work.nativeOpens) {
    try {
      results.set(item, await applyNativeOpenItem(input.terminal, item));
    } catch (error) {
      results.set(item, { item, outcome: "failed", reason: describeFailure(error) });
    }
  }
  for (const item of work.quarantinedPanes) {
    try {
      results.set(item, await applyQuarantinedPaneItem(input.terminal, item));
    } catch (error) {
      results.set(item, { item, outcome: "failed", reason: describeFailure(error) });
    }
  }
  for (const [repoPath, items] of work.repositories) {
    await withCoordinatorRepositoryLock(input.home, repoPath, async () => {
      for (const item of items) {
        try {
          results.set(item, await applyRepositoryItem(input, item));
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
  if (item.kind === "native-open" || item.kind === "tern-quarantine") {
    return {
      kind: item.kind,
      id: item.path,
      reason,
      path: item.path,
      ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
    };
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
      kind: failure.kind,
      id: failure.subject,
      reason: failure.reason,
      ...(failure.path === undefined ? {} : { path: failure.path }),
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
    terminal: input.terminal,
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
      terminal: input.terminal,
      home: observation.home,
      plan,
      clock,
      newId,
      discard: input.discard === true,
    }),
  });
}
