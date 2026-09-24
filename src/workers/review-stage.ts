import { readCheckpoint } from "../adapters/git.ts";
import {
  createReviewerEndpoint,
  createTaskEndpoint,
  inspectEndpoint,
  taskWorkspaceLabel,
} from "../adapters/herdr.ts";
import type {
  BlockCause,
  CommandRunner,
  Endpoint,
  IdFactory,
  ReviewLens,
  ReviewLevelRecord,
  ReviewMode,
  TaskRecord,
} from "../contracts.ts";
import { isQuarantinedReviewFailure, unresolvedReviewFailure } from "../recovery/central-review.ts";
import { writeJsonAtomically, writeTextAtomically } from "../runtime/persistence.ts";
import type { DurableJob, RuntimeTaskState } from "../runtime/schema.ts";
import {
  buildPrompt,
  currentWriter,
  describeError,
  isMissingEndpoint,
  jobDirectoryFor,
  jobPaths,
  makeDurableJob,
  reportPathFor,
  singleLine,
  workerCommand,
} from "../service/records.ts";
import { taskInboxPath, workerReceiptPath } from "../tasks/communication-persistence.ts";
import type { TaskEvent } from "../tasks/lifecycle.ts";
import { buildReviewBrief, renderReviewBrief } from "../tasks/review-brief.ts";
import { requiredReviewLenses } from "../tasks/review-levels.ts";
import type { ReservationResult } from "./admission.ts";
import { isCleanAt } from "./checkout.ts";
import { resolvedExecutionModel } from "./execution-routing.ts";
import type { JobLauncher } from "./job-launch.ts";
import type { WorkerJob, WorkerRole } from "./jobs.ts";
import { claimOf, executionIdentity, type OperationClaim } from "./operation-claim.ts";
import type { OperationRecords } from "./operation-records.ts";
import { reviewerBriefContext, reviewRoundPaths } from "./prompts.ts";
import type { TaskReservations } from "./reservation.ts";
import {
  type ClassifiedReviewRound,
  classifyReviewRound,
  type ReviewClassificationDependencies,
  type ReviewDiffFacts,
  readReviewDiffFacts,
  reviewBriefObservations,
} from "./review-round.ts";
import { workerDelegationStopped } from "./terminal.ts";
import { workerJobForEndpoint } from "./terminal-control.ts";

export type ReviewStageDependencies = ReviewClassificationDependencies &
  Readonly<{
    readonly home: string;
    readonly sessionId: string;
    readonly parentWorkspaceId: string | undefined;
    readonly run: CommandRunner;
    readonly idFactory: IdFactory;
    readonly workerPath: string;
    readonly workerTimeoutMs: number | undefined;
    readonly runtimeFor: (taskId: string) => Promise<RuntimeTaskState | undefined>;
    readonly updateTask: (
      taskId: string,
      transform: (task: TaskRecord) => TaskRecord,
    ) => Promise<TaskRecord>;
    readonly transition: (taskId: string, event: TaskEvent) => Promise<TaskRecord>;
    readonly blockTask: (taskId: string, reason: string, cause?: BlockCause) => Promise<TaskRecord>;
    readonly removeEndpoint: (taskId: string, paneId: string) => Promise<void>;
    /** Whether the request's approved brief says its work needs no code review. */
    readonly briefSkipsReview: (requestId: string) => Promise<boolean>;
    readonly records: OperationRecords;
    readonly launcher: JobLauncher;
    readonly reservations: TaskReservations;
  }>;

/** Runs a task's review round: one fresh read-only reviewer per required lens, at the reviewed HEAD. */
export class ReviewStage {
  readonly #deps: ReviewStageDependencies;

  constructor(deps: ReviewStageDependencies) {
    this.#deps = deps;
  }

  async advanceReview(task: TaskRecord, reserved?: ReservationResult): Promise<void> {
    const reviewHead = task.reviewHead;
    const worktree = task.worktree;
    if (reviewHead === undefined || worktree === undefined) {
      const reason = "review requires a task worktree and reviewed HEAD";
      await this.#deps.blockTask(task.id, reason, {
        group: "user-decision",
        kind: "prerequisite-not-met",
        summary: "There's no finished work to review yet.",
        detail: reason,
      });
      return;
    }
    const runtime = await this.#deps.runtimeFor(task.id);
    if (runtime === undefined) {
      const reason = "review has no durable runtime metadata";
      await this.#deps.blockTask(task.id, reason, {
        group: "safety-stop",
        kind: "runtime-metadata-missing",
        summary: "Tandem lost its saved record for this task, so the review can't run.",
        detail: reason,
      });
      return;
    }
    // A lens whose most recent job failed and is still unresolved either blocks (a genuine content
    // failure the worker itself reported, a stale canonical instruction, or a malformed result) or,
    // when the job's own recorded reason is a durable-quarantine one (proven-unowned: the pane or its
    // result disappeared, never proof of a real outcome), is left for central recovery's `reviewing`
    // re-entry, which the caller runs before this method and which clears the dead lens so it is
    // picked up as `nextLens` below instead.
    const failedReview = unresolvedReviewFailure(task, runtime);
    if (failedReview !== undefined && !isQuarantinedReviewFailure(failedReview)) {
      const reason = failedReview.error ?? `review ${failedReview.reviewLens ?? "worker"} failed`;
      await this.#deps.blockTask(task.id, reason, {
        group: "unusable-result",
        kind: "review-lens-failed",
        summary: "One of the reviews failed.",
        detail: reason,
      });
      return;
    }
    if (!(await this.reviewersStopped(task, runtime, worktree.path))) return;
    const currentCheckout = await readCheckpoint(this.#deps.run, {
      repo: worktree.path,
      baseRef: worktree.baseHead,
    });
    if (!isCleanAt(currentCheckout, reviewHead)) {
      const reason = "review refused because the worktree is stale or dirty";
      await this.#deps.blockTask(task.id, reason, {
        group: "user-decision",
        kind: "prerequisite-not-met",
        summary: "The code changed after it was submitted, so the review didn't run.",
        detail: reason,
      });
      return;
    }
    const facts = await readReviewDiffFacts(this.#deps.run, {
      task,
      head: reviewHead,
      repo: worktree.path,
      baseHead: worktree.baseHead,
    });
    const classified = await classifyReviewRound(this.#deps, { task, head: reviewHead, facts });
    const leveledTask = await this.recordReviewLevel(task, classified.record);
    // The user's approved "no review" wins over the risk classification recorded just above.
    if (task.requestId !== undefined && (await this.#deps.briefSkipsReview(task.requestId))) {
      await this.#deps.transition(task.id, { type: "skip-review", head: reviewHead });
      return;
    }
    const nextLens = requiredReviewLenses(leveledTask, reviewHead).find(
      (lens) =>
        !leveledTask.reviews.some(
          (review) =>
            review.lens === lens &&
            review.head === reviewHead &&
            review.generation === leveledTask.generation,
        ),
    );
    if (nextLens === undefined) {
      await this.#deps.transition(task.id, {
        type: "finish-review",
        head: reviewHead,
        generation: task.generation,
      });
      return;
    }
    const reservation =
      reserved ?? (await this.#deps.reservations.reserveTask(task.id, "reviewer"));
    if ("refusal" in reservation) return;
    const reservedRuntime = reservation.runtime;
    const claim = claimOf(reservedRuntime.operation);
    if (claim === undefined) {
      await this.#deps.records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      return;
    }
    if (
      currentWriter(reservedRuntime) === undefined &&
      reservedRuntime.reviewMode !== "review_existing_head"
    ) {
      await this.#deps.records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      const reason = "review has no writer endpoint";
      await this.#deps.records.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "resource-lost",
        summary: "The worker's terminal is gone, so the review can't run.",
        detail: reason,
      });
      return;
    }
    let endpoint: Endpoint | undefined;
    try {
      endpoint = await this.#deps.records.withOperationEffect(
        task.id,
        claim,
        task.generation,
        ["reviewing"],
        (current) => this.ensureReviewEndpoint(task, current.runtime, claim, nextLens),
      );
      if (endpoint === undefined) {
        await this.#deps.records.releaseUnlaunchedTaskReservation(
          task.id,
          reservation.reservation.id,
          claim,
        );
        return;
      }
    } catch (error) {
      await this.#deps.records.releaseUnlaunchedTaskReservation(
        task.id,
        reservation.reservation.id,
        claim,
      );
      const reason = `review pane allocation failed: ${describeError(error)}`;
      await this.#deps.records.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: "Tandem couldn't open a terminal for the review.",
        detail: reason,
      });
      return;
    }
    const reviewEndpoint = endpoint;
    try {
      await this.launchReviewer({
        task,
        leveledTask,
        runtime: reservedRuntime,
        claim,
        endpoint: reviewEndpoint,
        head: reviewHead,
        cwd: worktree.path,
        lens: nextLens,
        facts,
        classified,
        changedDiff: currentCheckout.diff,
      });
    } catch (error) {
      const currentRuntime = await this.#deps.runtimeFor(task.id);
      if (
        currentRuntime?.endpoints.some((candidate) => candidate.paneId === reviewEndpoint.paneId)
      ) {
        await this.#deps.records.releaseUnlaunchedTaskReservation(
          task.id,
          reservation.reservation.id,
          claim,
        );
      }
      const reason = `review job could not be prepared: ${describeError(error)}`;
      await this.#deps.records.blockIfOperationClaim(task.id, reason, claim, {
        group: "lost-resource",
        kind: "persistence-failed",
        summary: "Tandem couldn't set up the review.",
        detail: reason,
        paneId: reviewEndpoint.paneId,
      });
    }
  }

  /**
   * Persists the round's classification so the level and its reason survive a restart and appear
   * in the task summary. The durable write is skipped when the classification is unchanged, which
   * keeps a review tick from bumping the task revision for nothing.
   */
  private async recordReviewLevel(
    task: TaskRecord,
    record: ReviewLevelRecord,
  ): Promise<TaskRecord> {
    if (
      task.reviewLevel !== undefined &&
      JSON.stringify(task.reviewLevel) === JSON.stringify(record)
    ) {
      return task;
    }
    return this.#deps.updateTask(task.id, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: this.#deps.clock(),
      reviewLevel: record,
    }));
  }

  /**
   * Whether every recorded reviewer pane is proven stopped, so a new review may start. A missing
   * pane is forgotten for the next tick; a pane whose ownership cannot be proven blocks the task.
   */
  private async reviewersStopped(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    cwd: string,
  ): Promise<boolean> {
    for (const reviewer of runtime.endpoints) {
      if (reviewer.role !== "reviewer" && reviewer.role !== "verifier") continue;
      try {
        const inspection = await inspectEndpoint(this.#deps.run, { endpoint: reviewer, cwd });
        const job = workerJobForEndpoint(runtime.jobs, reviewer);
        if (!(await workerDelegationStopped(inspection, job))) return false;
      } catch (error) {
        if (isMissingEndpoint(error)) {
          await this.#deps.removeEndpoint(task.id, reviewer.paneId);
          return false;
        }
        // Foreign ownership or a proof failure (stale heartbeat, PID no longer foreground): the pane
        // is never touched without proof either way, so this blocks instead of retrying forever.
        const reason = `review pane ${reviewer.paneId} ownership could not be proven: ${describeError(error)}`;
        await this.#deps.blockTask(task.id, reason, {
          group: "safety-stop",
          kind: "ownership-unprovable",
          summary:
            "Tandem couldn't confirm the reviewer's terminal belongs to this task, so it didn't touch it.",
          detail: reason,
          paneId: reviewer.paneId,
        });
        return false;
      }
    }
    return true;
  }

  /**
   * Returns this generation's reviewer pane, or opens one: beside the writer's pane when it still
   * exists, or as a fresh task pane when reviewing an existing HEAD with no writer.
   */
  private async ensureReviewEndpoint(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    claim: OperationClaim,
    lens: ReviewLens,
  ): Promise<Endpoint> {
    const role: WorkerRole = "reviewer";
    const existingEndpoint = runtime.endpoints.find(
      (entry) => entry.role === role && entry.generation === task.generation,
    );
    if (existingEndpoint !== undefined) return existingEndpoint;
    const reviewExisting = runtime.reviewMode === "review_existing_head";
    const writer = reviewExisting ? undefined : currentWriter(runtime);
    const reviewCwd = runtime.worktree?.path ?? task.worktree?.path;
    if (reviewCwd === undefined) throw new Error("review has no worktree");
    if (writer === undefined && !reviewExisting) throw new Error("review has no writer endpoint");
    const effectId = `endpoint:${claim.id}`;
    const identity = `review:${task.id}:${task.generation}`;
    const writerJob = writer === undefined ? undefined : workerJobForEndpoint(runtime.jobs, writer);
    await this.#deps.records.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "endpoint",
      "intent",
      identity,
    );
    let createdEndpoint: Endpoint;
    if (writer === undefined) {
      const taskName = `${runtime.taskName}-${lens}`;
      const created = await createTaskEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: reviewCwd,
        taskName,
        workspaceLabel: taskWorkspaceLabel(taskName, task.objective, role),
        role,
        generation: task.generation,
        ...(this.#deps.parentWorkspaceId === undefined
          ? {}
          : { parentWorkspaceId: this.#deps.parentWorkspaceId }),
      });
      createdEndpoint = created.endpoint;
    } else {
      const created = await createReviewerEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: reviewCwd,
        writer,
        ...(writerJob === undefined ? {} : { writerJob }),
        generation: task.generation,
      });
      createdEndpoint = { ...created.endpoint, role };
    }
    await this.#deps.records.recordOperationEffect(
      task.id,
      claim,
      effectId,
      "endpoint",
      "succeeded",
      identity,
      JSON.stringify(createdEndpoint),
    );
    await this.#deps.records.saveEndpoint(task.id, createdEndpoint, claim);
    return createdEndpoint;
  }

  /** Writes one review round's inputs and job spec under the claim, then launches the reviewer. */
  private async launchReviewer(
    input: Readonly<{
      readonly task: TaskRecord;
      /** The task after this round's review level was recorded; the brief reads its ledger. */
      readonly leveledTask: TaskRecord;
      readonly runtime: RuntimeTaskState;
      readonly claim: OperationClaim;
      readonly endpoint: Endpoint;
      readonly head: string;
      readonly cwd: string;
      readonly lens: ReviewLens;
      readonly facts: ReviewDiffFacts;
      readonly classified: ClassifiedReviewRound;
      readonly changedDiff: string;
    }>,
  ): Promise<void> {
    const { task, runtime, claim, facts, head, lens } = input;
    const role: WorkerRole = "reviewer";
    const operation = runtime.operation;
    const jobId = operation?.jobId ?? singleLine(this.#deps.idFactory(), "review job id");
    const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
    const jobFiles = jobPaths(directory);
    const paths = reviewRoundPaths(directory);
    const reviewMode: ReviewMode = runtime.reviewMode ?? "review_changed_diff";
    const existingHead = reviewMode === "review_existing_head";
    const brief = renderReviewBrief(
      buildReviewBrief({
        task: input.leveledTask,
        head,
        lens,
        observations: reviewBriefObservations(facts, {
          cumulativePatchPath: existingHead ? paths.cumulativePatchPath : paths.diffPath,
          incrementalPatchPath: paths.incrementalPatchPath,
        }),
        advisoryLeads: input.classified.leads,
      }),
    );
    const artifactsWritten = await this.#deps.records.withOperationEffect(
      task.id,
      claim,
      task.generation,
      ["reviewing"],
      async () => {
        await writeTextAtomically(paths.diffPath, existingHead ? "" : input.changedDiff);
        if (existingHead) {
          await writeTextAtomically(paths.cumulativePatchPath, facts.cumulative.patch);
        }
        if (facts.sinceLastReview !== undefined) {
          await writeTextAtomically(paths.incrementalPatchPath, facts.sinceLastReview.patch);
        }
        await writeTextAtomically(paths.briefPath, brief);
        await writeJsonAtomically(paths.evidencePath, task.validationEvidence);
        return true;
      },
    );
    if (artifactsWritten !== true) return;
    const instructionRevision = task.communication?.revision ?? 0;
    const communication = {
      inboxPath: taskInboxPath(this.#deps.home, task.id),
      receiptPath: workerReceiptPath(jobFiles.jobPath),
      initialRevision: instructionRevision,
    };
    const context = reviewerBriefContext({
      task,
      runtime,
      head,
      lens,
      level: input.classified.record.level,
      reviewMode,
      paths,
      hasIncrementalPatch: facts.sinceLastReview !== undefined,
    });
    const spec: WorkerJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      role,
      cwd: input.cwd,
      model: resolvedExecutionModel(operation?.routing, task.policy.config.models[role]),
      prompt: buildPrompt(
        task,
        role,
        reportPathFor(jobFiles.jobPath),
        context.artifacts,
        { head, generation: task.generation, pass: lens },
        context.instructions,
      ),
      resultPath: jobFiles.resultPath,
      ...(operation === undefined
        ? {}
        : { execution: executionIdentity(this.#deps.home, operation) }),
      communication,
      review: { head, lens, round: task.reviewRound + 1 },
      ...(this.#deps.workerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#deps.workerTimeoutMs }),
    };
    const specWritten = await this.#deps.records.withOperationEffect(
      task.id,
      claim,
      task.generation,
      ["reviewing"],
      async () => {
        await writeJsonAtomically(jobFiles.jobPath, spec);
        return true;
      },
    );
    if (specWritten !== true) return;
    const durableJob: DurableJob = makeDurableJob(
      task.id,
      task.generation,
      role,
      "worker",
      input.cwd,
      jobFiles.jobPath,
      jobFiles.resultPath,
      1,
      this.#deps.clock(),
      {
        ...(operation === undefined ? {} : { operationId: operation.id }),
        endpoint: input.endpoint,
        head,
        reviewLens: lens,
        receiptPath: communication.receiptPath,
        instructionRevision,
      },
    );
    await this.#deps.records.appendJob(task.id, durableJob, claim);
    await this.#deps.launcher.launchJob(
      task.id,
      durableJob.id,
      input.endpoint,
      input.cwd,
      workerCommand(this.#deps.workerPath, jobFiles.jobPath),
      claim,
    );
  }
}
