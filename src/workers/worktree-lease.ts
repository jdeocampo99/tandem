import { readCheckpoint } from "../adapters/git.ts";
import { LeaseSafetyError } from "../adapters/primitives.ts";
import { acquireWorktree } from "../adapters/treehouse.ts";
import type { Clock, CommandRunner, TaskRecord } from "../contracts.ts";
import { preparePrReviewRun } from "../pr-review/run.ts";
import { unreleasedReservation } from "../runtime/activity.ts";
import type { RuntimeTaskState } from "../runtime/schema.ts";
import { describeError } from "../service/records.ts";
import {
  closeFinishedScoutPanes,
  decideScoutWorktreeRelease,
  observeScoutCheckout,
} from "../service/scout-cleanup.ts";
import { taskSourcePath } from "../service/source.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import type { ReservationResult } from "./admission.ts";
import { assertSourceUnchanged, isCleanAt } from "./checkout.ts";
import type { OperationClaim } from "./operation-claim.ts";
import type { OperationRecords } from "./operation-records.ts";

export type WorktreeLeasesDependencies = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly poolRoot: string;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
  readonly clock: Clock;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  readonly runtimeFor: (taskId: string) => Promise<RuntimeTaskState | undefined>;
  readonly maintainPoolForAllocation: (task: TaskRecord) => Promise<boolean>;
  readonly records: OperationRecords;
}>;

/** Readies the worktree a queued task's first worker runs in, under the task's operation claim. */
export class WorktreeLeases {
  readonly #deps: WorktreeLeasesDependencies;

  constructor(deps: WorktreeLeasesDependencies) {
    this.#deps = deps;
  }

  /** Leases and checks a pool worktree at the pinned source commit for a scout or implementation. */
  async prepareTaskLease(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    reservation: ReservationResult,
    claim: OperationClaim,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | undefined | "stopped"> {
    const adoption =
      runtime.worktree === undefined ? await this.adoptableScoutWorktree(task) : undefined;
    if (runtime.worktree === undefined && adoption === undefined) {
      const poolReady = await this.#deps.records.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["queued"],
        ({ task: currentTask }) => this.#deps.maintainPoolForAllocation(currentTask),
      );
      if (poolReady !== true) {
        await this.#deps.records.releaseUnlaunchedTaskReservation(
          task.id,
          reservation.reservation.id,
          claim,
        );
        return "stopped";
      }
    }
    let lease = runtime.worktree;
    try {
      // A target task is pinned to a fetched commit; the user's own checkout may be anywhere.
      if (task.target === undefined) {
        const source = await readCheckpoint(this.#deps.run, {
          repo: taskSourcePath(task, runtime),
        });
        assertSourceUnchanged(
          runtime.sourceCheckpoint,
          source,
          runtime.sourceRepoPath !== undefined,
        );
      }
      const expectedHolder = `${this.#deps.sessionId}:${task.id}`;
      // An implementation may run in the worktree it adopted from its first research handoff's
      // scout, which Treehouse still records under that scout's holder.
      const adoptedFrom =
        task.kind === "implementation" ? task.researchHandoffs?.[0]?.scoutTaskId : undefined;
      const allowedHolders =
        adoptedFrom === undefined
          ? [expectedHolder]
          : [expectedHolder, `${this.#deps.sessionId}:${adoptedFrom}`];
      if (lease !== undefined && !allowedHolders.includes(lease.leaseHolder)) {
        throw new LeaseSafetyError(
          `runtime worktree lease is held by ${JSON.stringify(lease.leaseHolder)}, expected ${JSON.stringify(expectedHolder)}`,
          lease,
        );
      }
      const needsFirstLaunchValidation = runtime.jobs.length === 0;
      const needsLeasePreparation =
        lease === undefined ||
        lease.baseHead === "unknown" ||
        (needsFirstLaunchValidation &&
          task.worktree === undefined &&
          runtime.endpointLaunch === undefined &&
          runtime.endpoints.length === 0);
      if (lease !== undefined && needsFirstLaunchValidation) {
        const savedLease = await readCheckpoint(this.#deps.run, { repo: lease.path });
        if (!isCleanAt(savedLease, runtime.sourceCheckpoint.head)) {
          throw new LeaseSafetyError(
            `saved worktree is not the captured source commit ${runtime.sourceCheckpoint.head}`,
            lease,
          );
        }
      }
      if (needsLeasePreparation) {
        const holder = adoption?.leaseHolder ?? expectedHolder;
        const prepared = await this.#deps.records.withOperationEffect(
          task.id,
          claim,
          task.generation,
          ["queued"],
          (current) =>
            this.restoreOrAcquireWorktree(current.task, current.runtime, claim, {
              holder,
              adoption,
              adoptedFrom,
              lease,
            }),
        );
        if (prepared === undefined) {
          await this.#deps.records.releaseUnlaunchedTaskReservation(
            task.id,
            reservation.reservation.id,
            claim,
          );
          return "stopped";
        }
        lease = prepared;
      }
    } catch (error) {
      if (error instanceof LeaseSafetyError) {
        await this.#deps.records.saveWorktree(
          task.id,
          { ...error.lease, baseHead: "unknown" },
          claim,
        );
      }
      await this.#deps.records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't set up a working copy for this task.",
        detail: `worktree allocation failed: ${describeError(error)}`,
      });
      return "stopped";
    }
    return lease;
  }

  /**
   * Restores the worktree a prior attempt of this operation already acquired, or acquires one
   * from Treehouse under `holder`, recording the allocator effect before and after. An unresolved
   * or unreadable earlier effect quarantines the operation instead of retrying the allocator.
   */
  private async restoreOrAcquireWorktree(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    claim: OperationClaim,
    input: Readonly<{
      readonly holder: string;
      readonly adoption: NonNullable<RuntimeTaskState["worktree"]> | undefined;
      readonly adoptedFrom: string | undefined;
      readonly lease: NonNullable<RuntimeTaskState["worktree"]> | undefined;
    }>,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | undefined> {
    const effectId = `worktree:${claim.id}`;
    const existingEffect = runtime.operation?.effects.find((entry) => entry.id === effectId);
    if (existingEffect !== undefined) {
      if (existingEffect.phase !== "succeeded" || existingEffect.receipt === undefined) {
        await this.#deps.records.quarantineOperation(
          task.id,
          `worktree effect ${existingEffect.id} is unresolved; allocator retry refused`,
          claim,
        );
        return undefined;
      }
      try {
        const restored = JSON.parse(existingEffect.receipt) as NonNullable<
          RuntimeTaskState["worktree"]
        >;
        await this.#deps.records.saveWorktree(task.id, restored, claim, input.adoptedFrom);
        return restored;
      } catch {
        await this.#deps.records.quarantineOperation(
          task.id,
          `worktree effect ${existingEffect.id} has an invalid receipt`,
          claim,
        );
        return undefined;
      }
    }
    await this.#deps.records.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "worktree",
      "intent",
      input.holder,
    );
    const { adoption, lease } = input;
    const acquired = await acquireWorktree(this.#deps.run, {
      repo: taskSourcePath(task, runtime),
      root: this.#deps.poolRoot,
      tandemId: input.holder,
      taskName: runtime.taskName,
      sourceHead: runtime.sourceCheckpoint.head,
      ...(adoption === undefined
        ? {}
        : { adopt: { branch: adoption.branch, head: adoption.baseHead } }),
    });
    if (
      lease !== undefined &&
      (acquired.leaseId !== lease.leaseId || acquired.path !== lease.path)
    ) {
      throw new LeaseSafetyError(
        "treehouse returned a different lease than the runtime worktree",
        acquired,
      );
    }
    if (acquired.baseHead !== runtime.sourceCheckpoint.head) {
      throw new LeaseSafetyError(
        `acquired worktree base ${acquired.baseHead} does not match pinned source ${runtime.sourceCheckpoint.head}`,
        acquired,
      );
    }
    await this.#deps.records.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "worktree",
      "succeeded",
      input.holder,
      JSON.stringify(acquired),
    );
    await this.#deps.records.saveWorktree(task.id, acquired, claim, input.adoptedFrom);
    return acquired;
  }

  /**
   * Readies the PR review worktree from the user's own checkout and writes the run's diff and
   * context. It replaces the pool lease: a review never uses the coordinator's source commit.
   */
  async preparePrReviewLease(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    reservation: ReservationResult,
    claim: OperationClaim,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | "stopped"> {
    const state = task.prReview;
    try {
      if (state === undefined) throw new Error("the task records no pull request");
      const lease = await this.#deps.records.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["queued"],
        async ({ task: currentTask }) => {
          const prepared = await preparePrReviewRun({
            run: this.#deps.run,
            clock: this.#deps.clock,
            home: this.#deps.home,
            taskId: currentTask.id,
            holder: `${this.#deps.sessionId}:${currentTask.id}`,
            generation: currentTask.generation,
            state: currentTask.prReview ?? state,
            ...(runtime.worktree === undefined ? {} : { existing: runtime.worktree }),
          });
          await this.#deps.records.saveWorktree(currentTask.id, prepared.lease, claim);
          return prepared.lease;
        },
      );
      if (lease !== undefined) return lease;
      await this.#deps.records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      return "stopped";
    } catch (error) {
      await this.#deps.records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't set up a checkout of this pull request.",
        detail: `PR review checkout failed: ${describeError(error)}`,
      });
      return "stopped";
    }
  }

  /**
   * The worktree an implementation can take over from the scout of its first research handoff:
   * the scout has settled, holds no pane or reservation, and its checkout is still clean on its
   * own branch at its source commit. Anything else falls back to leasing a fresh worktree. A
   * finished scout kept alive for mockups has its pane closed first, since building has started.
   */
  private async adoptableScoutWorktree(
    task: TaskRecord,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | undefined> {
    const scoutId =
      task.kind === "implementation" ? task.researchHandoffs?.[0]?.scoutTaskId : undefined;
    if (scoutId === undefined) return undefined;
    try {
      await closeFinishedScoutPanes(this.#deps, scoutId);
    } catch {
      // A pane that would not close keeps the scout's worktree; the implementation leases another.
    }
    const [scout, runtime] = await Promise.all([
      this.#deps.getTask(scoutId),
      this.#deps.runtimeFor(scoutId),
    ]);
    const lease = runtime?.worktree;
    if (
      scout.target?.repo !== task.target?.repo ||
      scout.stage !== "completed" ||
      lease === undefined ||
      lease.leaseHolder !== `${this.#deps.sessionId}:${scoutId}` ||
      runtime === undefined ||
      runtime.endpoints.length > 0 ||
      runtime.endpointLaunch !== undefined ||
      unreleasedReservation(runtime.reservation)
    ) {
      return undefined;
    }
    const checkout = await observeScoutCheckout(this.#deps.run, lease.path);
    if (checkout.status !== "observed") return undefined;
    return decideScoutWorktreeRelease({ lease, checkout }).kind === "release" ? lease : undefined;
  }
}
