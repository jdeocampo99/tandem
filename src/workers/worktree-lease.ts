import { readCheckpoint } from "../adapters/git.ts";
import { LeaseSafetyError } from "../adapters/primitives.ts";
import { acquireWorktree } from "../adapters/treehouse.ts";
import type { Clock, CommandRunner, TaskRecord } from "../contracts.ts";
import { preparePrReviewRun } from "../pr-review/run.ts";
import { activeRuntimeJob, unreleasedReservation } from "../runtime/activity.ts";
import type { RuntimeTaskState } from "../runtime/schema.ts";
import { describeError } from "../service/records.ts";
import {
  closeFinishedScoutPanes,
  decideScoutWorktreeRelease,
  observeScoutCheckout,
  type TaskCleanupOutcome,
} from "../service/scout-cleanup.ts";
import { taskSourcePath } from "../service/source.ts";
import type { TaskStore } from "../tasks/store.ts";
import {
  finishResearchInterview,
  pendingResearchDecision,
  researchInterviewFor,
} from "../tasks/research-interview.ts";
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
  readonly clock: Clock;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  readonly runtimeFor: (taskId: string) => Promise<RuntimeTaskState | undefined>;
  readonly cleanupNonAdoptedResearchHandoff: (task: TaskRecord) => Promise<TaskCleanupOutcome>;
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
    let adoption: NonNullable<RuntimeTaskState["worktree"]> | undefined;
    try {
      adoption = runtime.worktree === undefined ? await this.adoptableScoutWorktree(task) : undefined;
    } catch (error) {
      await this.#deps.records.releaseAndBlock(task.id, reservation.reservation.id, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't adopt the research workspace.",
        detail: `research worktree handoff failed: ${describeError(error)}`,
      });
      return "stopped";
    }
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
   * Adopts the first cited scout's exact clean worktree. Every other cited scout is closed and
   * safely released or retained before implementation can start.
   */
  private async adoptableScoutWorktree(
    task: TaskRecord,
  ): Promise<NonNullable<RuntimeTaskState["worktree"]> | undefined> {
    const handoffs = task.kind === "implementation" ? (task.researchHandoffs ?? []) : [];
    if (handoffs.length === 0) return undefined;
    const scouts: TaskRecord[] = [];
    for (const handoff of handoffs) {
      const scout = await this.settleResearchHandoff(task, handoff.scoutTaskId);
      if (scout !== undefined) scouts.push(scout);
    }
    for (const [index, scout] of scouts.entries()) {
      if (index === 0) continue;
      await this.cleanupNonAdoptedResearchHandoff(task, scout);
    }

    const [primaryScout] = scouts;
    if (primaryScout === undefined) return undefined;
    await closeFinishedScoutPanes(this.#deps, primaryScout.id);
    const [scout, runtime] = await Promise.all([
      this.#deps.getTask(primaryScout.id),
      this.#deps.runtimeFor(primaryScout.id),
    ]);
    const lease = runtime?.worktree;
    if (
      scout.kind !== "scout" ||
      scout.stage !== "completed" ||
      researchInterviewFor(scout)?.status !== "approved" ||
      scout.communication?.question !== undefined ||
      scout.target?.repo !== task.target?.repo ||
      runtime === undefined ||
      lease === undefined ||
      lease.leaseHolder !== `${this.#deps.sessionId}:${scout.id}` ||
      lease.baseHead !== runtime.sourceCheckpoint.head ||
      runtime.endpoints.length > 0 ||
      (scout.endpoints?.length ?? 0) > 0 ||
      runtime.endpointLaunch !== undefined ||
      runtime.jobs.some(activeRuntimeJob) ||
      unreleasedReservation(runtime.reservation)
    ) {
      throw new Error(`research handoff ${primaryScout.id} has not proven a stopped, owned session`);
    }
    const checkout = await observeScoutCheckout(this.#deps.run, lease.path);
    const decision = decideScoutWorktreeRelease({ lease, checkout });
    if (decision.kind !== "release") {
      throw new Error(
        `research handoff ${primaryScout.id} workspace is ${decision.kind}: ${decision.reason}`,
      );
    }
    return lease;
  }

  /**
   * The cited scout whose retained session this implementation takes over, approving an interview
   * an older approval left open. `undefined` when the scout was stopped.
   */
  private async settleResearchHandoff(
    task: TaskRecord,
    scoutId: string,
  ): Promise<TaskRecord | undefined> {
    const before = await this.#deps.getTask(scoutId);
    if (
      before.kind !== "scout" ||
      before.stage !== "completed" ||
      before.target?.repo !== task.target?.repo
    ) {
      return undefined;
    }
    if (before.communication?.question !== undefined) {
      throw new Error(`research handoff ${scoutId} has an unanswered question`);
    }
    const interview = researchInterviewFor(before);
    if (interview?.status === "approved") return before;
    if (interview?.status !== "open") return undefined;
    if (!task.scopeApproved || pendingResearchDecision(interview) !== undefined) {
      throw new Error(`research handoff ${scoutId} has an unanswered question`);
    }
    return this.#deps.store.exclusive(async (store) => {
      const current = await store.read(scoutId);
      if (
        current?.kind !== "scout" ||
        current.stage !== "completed" ||
        current.target?.repo !== task.target?.repo ||
        current.communication?.question !== undefined
      ) {
        throw new Error(`research handoff ${scoutId} changed before approval recovery`);
      }
      const currentInterview = researchInterviewFor(current);
      if (currentInterview?.status !== "open") return current;
      if (pendingResearchDecision(currentInterview) !== undefined) {
        throw new Error(`research handoff ${scoutId} has an unanswered question`);
      }
      const approvedAt = this.#deps.clock();
      const approvedInterview = finishResearchInterview(currentInterview, "approved", approvedAt);
      return store.update(current.id, current.revision, (latest) => ({
        ...latest,
        revision: latest.revision + 1,
        updatedAt: approvedAt,
        researchInterview: approvedInterview,
        cleanup: {
          schemaVersion: 1,
          status: "retained",
          reason: "research approved for implementation handoff",
          observedAt: approvedAt,
        },
      }));
    });
  }

  private async cleanupNonAdoptedResearchHandoff(
    task: TaskRecord,
    captured: TaskRecord,
  ): Promise<void> {
    const outcome = await this.#deps.cleanupNonAdoptedResearchHandoff(captured);
    if (outcome.status !== "released" && outcome.status !== "retained") {
      throw new Error(
        `research handoff ${captured.id} cleanup is ${outcome.status}: ${outcome.reason}`,
      );
    }
    const [scout, runtime] = await Promise.all([
      this.#deps.getTask(captured.id),
      this.#deps.runtimeFor(captured.id),
    ]);
    if (
      scout.kind !== "scout" ||
      scout.stage !== "completed" ||
      scout.target?.repo !== task.target?.repo ||
      scout.communication?.question !== undefined ||
      researchInterviewFor(scout)?.status !== "approved" ||
      runtime === undefined ||
      runtime.endpoints.length > 0 ||
      (scout.endpoints?.length ?? 0) > 0 ||
      runtime.endpointLaunch !== undefined ||
      runtime.jobs.some(activeRuntimeJob) ||
      unreleasedReservation(runtime.reservation) ||
      scout.cleanup?.status !== outcome.status
    ) {
      throw new Error(`research handoff ${captured.id} has not proven a stopped, settled session`);
    }
    const lease = runtime.worktree;
    if (outcome.status === "released") {
      if (lease !== undefined) {
        throw new Error(`research handoff ${captured.id} still owns a released worktree`);
      }
      return;
    }
    if (
      lease === undefined ||
      lease.leaseHolder !== `${this.#deps.sessionId}:${captured.id}` ||
      lease.baseHead !== runtime.sourceCheckpoint.head
    ) {
      throw new Error(`research handoff ${captured.id} retained an unproven workspace`);
    }
    const checkout = await observeScoutCheckout(this.#deps.run, lease.path);
    const decision = decideScoutWorktreeRelease({ lease, checkout });
    if (decision.kind !== "retain") {
      throw new Error(`research handoff ${captured.id} retention is not proven safe`);
    }
  }
}
