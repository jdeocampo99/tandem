import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTaskEndpoint,
  type HerdrEndpointResult,
  type HerdrPaneInspection,
  inspectEndpoint,
  sendCommand,
  taskWorkspaceLabel,
} from "../adapters/herdr.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type { Clock, CommandRunner, Endpoint, IdFactory, TaskRecord } from "../contracts.ts";
import {
  activeReservations,
  activeRuntimeJob,
  presentationRuntime,
  unreleasedReservation,
} from "../runtime/activity.ts";
import { withRequestBudget } from "../runtime/budget.ts";
import type { RequestSpendGate } from "../runtime/budget-gate.ts";
import {
  readRuntimeState,
  updateRuntimeState,
  writeJsonAtomically,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type {
  DurableEndpointLaunch,
  DurableJob,
  DurableOperation,
  RuntimePresentation,
  RuntimeState,
} from "../runtime/schema.ts";
import {
  DEFAULT_STARTUP_GRACE_MS,
  describeError,
  endpointLaunchFor,
  isMissing,
  isOlderThan,
  replaceRuntimePresentation,
  runtimeReservation,
  singleLine,
  workerCommand,
} from "../service/records.ts";
import { recoverEndpointFromLaunch } from "../tasks/control.ts";
import type { TaskStore } from "../tasks/store.ts";
import { parseWorkerJob, readWorkerResult, type WorkerResult } from "../workers/jobs.ts";
import { liveWorkerTerminal } from "../workers/terminal.ts";
import type { PresentationFeedbackWorkflow } from "./feedback.ts";
import { withPresentationLock } from "./lock.ts";
import {
  hasPendingPresentationNotification,
  type PresentationRecord,
  readPresentationRecord,
} from "./records.ts";
import { completePresentation } from "./session.ts";

export type PresentationRuntimeDependencies = Readonly<{
  readonly sessionId: string;
  readonly parentWorkspaceId: string | undefined;
  readonly workerPath: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly readState: () => Promise<RuntimeState>;
  readonly readTask: (taskId: string) => Promise<TaskRecord>;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
  readonly feedback: PresentationFeedbackWorkflow;
  /** Decides whether this presentation may spend under its request's standing budget. */
  readonly requestSpend: RequestSpendGate;
}>;
export type PresentationFailureBinding = Readonly<{
  readonly jobId: string;
  readonly operationId: string | undefined;
  readonly fencingRevision: number | undefined;
  readonly claimOwner: string | undefined;
}>;

function presentationFailureBinding(runtime: RuntimePresentation): PresentationFailureBinding {
  return {
    jobId: runtime.job.id,
    operationId: runtime.operation?.id,
    fencingRevision: runtime.operation?.fencingRevision,
    claimOwner: runtime.operation?.claimOwner,
  };
}
export class PresentationRuntimeWorkflow {
  readonly #deps: PresentationRuntimeDependencies;

  constructor(deps: PresentationRuntimeDependencies) {
    this.#deps = deps;
  }

  private async launchPresentationJob(
    presentationId: string,
    jobId: string,
    endpoint: Endpoint,
    cwd: string,
    command: readonly string[],
  ): Promise<void> {
    const state = await this.#deps.readState();
    const initialRuntime = presentationRuntime(state, presentationId);
    if (initialRuntime === undefined) throw new Error(`presentation ${presentationId} is missing`);
    const intent = await withPresentationLock(initialRuntime.recordPath, undefined, () =>
      this.#deps.store.exclusive(async () => {
        const currentState = await readRuntimeState(this.#deps.runtimePath);
        const runtime = presentationRuntime(currentState, presentationId);
        if (runtime === undefined) throw new Error(`presentation ${presentationId} is missing`);
        if (
          runtime.operation === undefined ||
          runtime.job.operationId !== runtime.operation.id ||
          runtime.job.id !== jobId ||
          runtime.job.phase !== "reserved" ||
          runtime.job.launchAttempted
        ) {
          return undefined;
        }
        const launching = replaceRuntimePresentation(currentState, presentationId, (entry) => {
          if (entry.operation === undefined) return entry;
          return {
            ...entry,
            operation: {
              ...entry.operation,
              phase: "launching" as const,
              effects: [
                ...entry.operation.effects,
                {
                  id: jobId,
                  kind: "worker" as const,
                  phase: "intent" as const,
                  createdAt: this.#deps.clock(),
                  identity: entry.job.jobPath,
                },
              ],
            },
            job: { ...entry.job, phase: "launching", launchAttempted: true },
          };
        });
        await writeRuntimeState(this.#deps.runtimePath, launching);
        return {
          recordPath: runtime.recordPath,
          operationId: runtime.operation.id,
          fencingRevision: runtime.operation.fencingRevision,
          claimOwner: runtime.operation.claimOwner,
        };
      }),
    );
    if (intent === undefined) return;
    let reason: string | undefined;
    let stateUpdated = false;
    try {
      await sendCommand(this.#deps.run, { endpoint, cwd, command });
    } catch (error) {
      reason = `presentation launch failed after launch intent: ${describeError(error)}`;
    }
    await withPresentationLock(intent.recordPath, undefined, () =>
      this.#deps.store.exclusive(async () => {
        const currentState = await readRuntimeState(this.#deps.runtimePath);
        const runtime = presentationRuntime(currentState, presentationId);
        if (
          runtime === undefined ||
          runtime.job.id !== jobId ||
          runtime.job.operationId !== intent.operationId ||
          runtime.operation?.id !== intent.operationId ||
          runtime.operation.fencingRevision !== intent.fencingRevision ||
          runtime.operation.claimOwner !== intent.claimOwner
        )
          return;
        const next = replaceRuntimePresentation(currentState, presentationId, (entry) => {
          if (
            entry.operation === undefined ||
            entry.job.operationId !== intent.operationId ||
            entry.operation.id !== intent.operationId ||
            entry.operation.fencingRevision !== intent.fencingRevision ||
            entry.operation.claimOwner !== intent.claimOwner
          )
            return entry;
          stateUpdated = true;
          return {
            ...entry,
            ...(reason === undefined ? {} : { lastError: reason }),
            operation: {
              ...entry.operation,
              phase: reason === undefined ? ("running" as const) : ("quarantined" as const),
              effects: entry.operation.effects.map((effect) =>
                effect.id === jobId
                  ? {
                      ...effect,
                      phase: reason === undefined ? ("succeeded" as const) : ("unknown" as const),
                      ...(reason === undefined ? { receipt: endpoint.paneId } : {}),
                    }
                  : effect,
              ),
              ...(reason === undefined ? {} : { error: reason }),
            },
            job:
              reason === undefined
                ? { ...entry.job, phase: "running", launchedAt: this.#deps.clock() }
                : { ...entry.job, phase: "failed", error: reason },
          };
        });
        await writeRuntimeState(this.#deps.runtimePath, next);
      }),
    );
    if (reason !== undefined && stateUpdated) {
      const record = await readPresentationRecord(intent.recordPath);
      const failedRecord: PresentationRecord = {
        ...record,
        status: "failed",
        error: reason,
        updatedAt: this.#deps.clock(),
      };
      await writeJsonAtomically(
        intent.recordPath,
        this.#deps.feedback.withPresentationNotification(record, failedRecord),
      );
      await this.#deps.feedback.flushPresentationNotification({ recordPath: intent.recordPath });
    }
  }

  private async markPresentationRunning(id: string): Promise<RuntimePresentation | undefined> {
    const state = await this.#deps.readState();
    const initialRuntime = presentationRuntime(state, id);
    if (initialRuntime === undefined) return undefined;
    return withPresentationLock(initialRuntime.recordPath, undefined, async () => {
      const currentState = await this.#deps.readState();
      const runtime = presentationRuntime(currentState, id);
      if (runtime === undefined) return undefined;
      const endpoint = runtime.endpoint ?? runtime.job.endpoint;
      if (endpoint === undefined) return runtime;
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.status !== "queued") return undefined;
      await writeJsonAtomically(runtime.recordPath, {
        ...record,
        status: "running",
        endpoint,
        updatedAt: this.#deps.clock(),
      });
      return runtime;
    });
  }

  async startPresentation(id: string): Promise<void> {
    let state = await this.#deps.readState();
    let runtime = presentationRuntime(state, id);
    if (runtime === undefined) throw new Error(`presentation ${id} is missing`);
    if (runtime.endpointLaunch !== undefined && runtime.endpoint === undefined) {
      const recovered = await this.reconcilePresentationEndpointLaunch(runtime);
      if (recovered === undefined) return;
      state = await this.#deps.readState();
      runtime = presentationRuntime(state, id);
      if (runtime === undefined) throw new Error(`presentation ${id} is missing`);
    }
    const task = await this.#deps.readTask(runtime.taskId);
    if (task.stage === "cancelled") {
      throw new Error(`presentation ${id} cannot start for cancelled task ${task.id}`);
    }
    if (runtime.endpoint !== undefined) {
      const running = await this.markPresentationRunning(id);
      if (running === undefined) return;
      const endpoint = running.endpoint ?? running.job.endpoint;
      if (endpoint === undefined) return;
      await this.launchPresentationJob(
        id,
        running.job.id,
        endpoint,
        running.job.cwd,
        workerCommand(this.#deps.workerPath, running.job.jobPath),
      );
      return;
    }
    const capacity = await this.reservePresentation(id);
    if (!capacity) return;
    state = await this.#deps.readState();
    runtime = presentationRuntime(state, id);
    if (runtime === undefined || runtime.reservation === undefined) {
      throw new Error(`presentation ${id} lost its durable reservation`);
    }
    const taskName = `presentation-${id}`;
    const workspaceLabel = taskWorkspaceLabel(taskName, task.objective, "presentation");
    const endpointLaunch = endpointLaunchFor(
      runtime.reservation,
      this.#deps.sessionId,
      taskName,
      workspaceLabel,
      runtime.job.cwd,
      "presentation",
      runtime.job.generation,
      this.#deps.clock(),
      this.#deps.parentWorkspaceId,
      runtime.operation?.id,
    );
    try {
      const claimed = await this.savePresentationEndpointLaunch(id, endpointLaunch);
      if (!claimed) return;
    } catch (error) {
      await this.releaseUnlaunchedPresentationReservation(
        id,
        runtime.reservation.id,
        runtime.job.id,
        runtime.operation?.id,
      );
      await this.failPresentation(
        id,
        `presentation launch intent could not be persisted: ${describeError(error)}`,
        presentationFailureBinding(runtime),
      );
      return;
    }
    let endpointResult: HerdrEndpointResult;
    try {
      endpointResult = await createTaskEndpoint(this.#deps.run, {
        sessionId: this.#deps.sessionId,
        cwd: runtime.job.cwd,
        taskName,
        workspaceLabel: endpointLaunch.workspaceLabel,
        role: "presentation",
        generation: runtime.job.generation,
        ...(this.#deps.parentWorkspaceId === undefined
          ? {}
          : { parentWorkspaceId: this.#deps.parentWorkspaceId }),
      });
    } catch (error) {
      await this.failPresentation(
        id,
        `presentation pane allocation failed: ${describeError(error)}`,
        presentationFailureBinding(runtime),
        false,
      );
      return;
    }
    const endpoint = endpointResult.endpoint;
    try {
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
        replaceRuntimePresentation(current, id, (entry) => ({
          ...entry,
          endpoint,
          job: { ...entry.job, endpoint },
        })),
      );
    } catch (error) {
      await this.failPresentation(
        id,
        `presentation pane identity could not be persisted: ${describeError(error)}`,
        presentationFailureBinding(runtime),
        false,
      );
      return;
    }
    const running = await this.markPresentationRunning(id);
    if (running === undefined) return;
    const runningEndpoint = running.endpoint ?? running.job.endpoint;
    if (runningEndpoint === undefined) return;
    await this.launchPresentationJob(
      id,
      running.job.id,
      runningEndpoint,
      running.job.cwd,
      workerCommand(this.#deps.workerPath, running.job.jobPath),
    );
  }
  async answer(
    presentationId: string,
    questionId: string,
    answer: string,
  ): Promise<PresentationRecord> {
    const state = await this.#deps.readState();
    const initialRuntime = presentationRuntime(state, presentationId);
    if (initialRuntime === undefined) throw new Error(`presentation ${presentationId} is missing`);
    const nextJobId = singleLine(this.#deps.idFactory(), "presentation answer job id");
    const nextOperationId = singleLine(this.#deps.idFactory(), "presentation answer operation id");
    const normalizedAnswer = singleLine(answer, "presentation answer");
    await withPresentationLock(initialRuntime.recordPath, undefined, async () => {
      const currentState = await this.#deps.readState();
      const runtime = presentationRuntime(currentState, presentationId);
      if (runtime === undefined) throw new Error(`presentation ${presentationId} is missing`);
      const priorOperation = runtime.operation;
      if (priorOperation === undefined) {
        throw new Error(`presentation ${presentationId} has no durable operation`);
      }
      const owner = await this.#deps.readTask(runtime.taskId);
      if (owner.stage === "cancelled") {
        throw new Error(`presentation ${presentationId} cannot resume cancelled task ${owner.id}`);
      }
      const record = await readPresentationRecord(runtime.recordPath);
      const { question: askedQuestion, error: _error, ...recordWithoutTransient } = record;
      if (
        record.status !== "blocked" ||
        askedQuestion === undefined ||
        askedQuestion.id !== questionId
      ) {
        throw new Error(
          `question ${questionId} is no longer current for presentation ${presentationId}`,
        );
      }
      const workerValue = JSON.parse(await readFile(runtime.job.jobPath, "utf8")) as unknown;
      const worker = parseWorkerJob(workerValue);
      const attemptDirectory = join(runtime.job.cwd, "attempts", nextJobId);
      await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
      const nextJobPath = join(attemptDirectory, "job.json");
      const nextResultPath = join(attemptDirectory, "result.json");
      const recommendation =
        askedQuestion.recommendation === undefined
          ? ""
          : `\nRecommendation: ${askedQuestion.recommendation}`;
      const now = this.#deps.clock();
      const {
        error: _priorError,
        resultConsumedAt: _priorConsumedAt,
        ...operationBase
      } = priorOperation;
      const nextOperation: DurableOperation = {
        ...operationBase,
        id: nextOperationId,
        jobId: nextJobId,
        phase: "admitted",
        fencingRevision: priorOperation.fencingRevision + 1,
        claimOwner: `${this.#deps.sessionId}:${nextOperationId}`,
        createdAt: now,
        effects: [],
      };
      const nextWorker = {
        ...worker,
        id: nextJobId,
        jobPath: nextJobPath,
        resultPath: nextResultPath,
        prompt: [
          worker.prompt,
          `Prior worker report: ${runtime.job.resultPath}`,
          `Coordinator question: ${askedQuestion.text}`,
          `Coordinator answer: ${normalizedAnswer}${recommendation}`,
        ].join("\n\n"),
        ...(worker.execution === undefined
          ? {}
          : {
              execution: {
                ...worker.execution,
                operationId: nextOperation.id,
                fencingRevision: nextOperation.fencingRevision,
                claimOwner: nextOperation.claimOwner,
              },
            }),
      };
      parseWorkerJob(nextWorker);
      await writeJsonAtomically(nextJobPath, nextWorker);
      const nextDurableJob: DurableJob = {
        schemaVersion: 1,
        id: nextJobId,
        taskId: runtime.job.taskId,
        generation: runtime.job.generation,
        role: "presentation",
        kind: "worker",
        cwd: runtime.job.cwd,
        jobPath: nextJobPath,
        resultPath: nextResultPath,
        attempt: runtime.job.attempt + 1,
        phase: "reserved",
        launchAttempted: false,
        createdAt: now,
        operationId: nextOperation.id,
        ...(runtime.job.endpoint === undefined ? {} : { endpoint: runtime.job.endpoint }),
      };
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
        replaceRuntimePresentation(current, presentationId, (entry) => ({
          ...entry,
          operation: nextOperation,
          operationHistory: [
            ...(entry.operationHistory ?? []),
            entry.operation === undefined ? priorOperation : entry.operation,
          ],
          ...(entry.reservation === undefined
            ? {}
            : {
                reservation: {
                  ...entry.reservation,
                  ownerSessionId: this.#deps.sessionId,
                  operationId: nextOperation.id,
                },
              }),
          ...(entry.endpointLaunch === undefined
            ? {}
            : { endpointLaunch: { ...entry.endpointLaunch, operationId: nextOperation.id } }),
          job: nextDurableJob,
        })),
      );
      await writeJsonAtomically(runtime.recordPath, {
        ...recordWithoutTransient,
        status: "queued",
        updatedAt: now,
      });
    });
    await this.startPresentation(presentationId);
    const restartedState = await this.#deps.readState();
    const restarted = presentationRuntime(restartedState, presentationId);
    if (restarted === undefined) throw new Error(`presentation ${presentationId} disappeared`);
    return readPresentationRecord(restarted.recordPath);
  }

  async reconcilePresentation(runtime: RuntimePresentation): Promise<void> {
    let currentRuntime = runtime;
    if (currentRuntime.endpointLaunch !== undefined && currentRuntime.endpoint === undefined) {
      const recovered = await this.reconcilePresentationEndpointLaunch(currentRuntime);
      if (recovered === undefined) return;
      currentRuntime = recovered;
    }
    const state = await this.#deps.readState();
    const freshRuntime = presentationRuntime(state, currentRuntime.id);
    if (freshRuntime === undefined) return;
    let record = await readPresentationRecord(freshRuntime.recordPath);
    const job = freshRuntime.job;
    const endpoint = freshRuntime.endpoint ?? job.endpoint;
    if (
      (record.status === "blocked" || record.status === "running") &&
      record.question !== undefined &&
      record.question.id !== job.id &&
      (job.phase === "reserved" || job.phase === "launching" || job.phase === "running")
    ) {
      const { question: _question, error: _error, ...withoutTransient } = record;
      record = {
        ...withoutTransient,
        status: "queued",
        updatedAt: this.#deps.clock(),
      };
      await writeJsonAtomically(freshRuntime.recordPath, record);
    }
    if (record.status === "queued" && job.phase === "reserved") {
      await this.startPresentation(freshRuntime.id);
      return;
    }
    if (!activeRuntimeJob(job)) {
      this.#deps.feedback.startPresentationFeedback(freshRuntime, record);
      return;
    }
    if (endpoint === undefined) {
      if (isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
        await this.failPresentation(
          freshRuntime.id,
          "presentation has no endpoint identity",
          presentationFailureBinding(freshRuntime),
          true,
        );
      }
      return;
    }
    await this.consumePresentationResult(freshRuntime);
  }

  private async consumePresentationResult(runtimeHint: RuntimePresentation): Promise<void> {
    let failureReason: string | undefined;
    let followUp:
      | Readonly<{
          readonly runtime: RuntimePresentation;
          readonly record: PresentationRecord;
        }>
      | undefined;
    try {
      await withPresentationLock(runtimeHint.recordPath, undefined, async () => {
        const state = await this.#deps.readState();
        const runtime = presentationRuntime(state, runtimeHint.id);
        if (runtime === undefined) return;
        const record = await readPresentationRecord(runtime.recordPath);
        const job = runtime.job;
        if (!activeRuntimeJob(job)) {
          followUp = { runtime, record };
          return;
        }
        const endpoint = runtime.endpoint ?? job.endpoint;
        if (endpoint === undefined) {
          if (isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)) {
            failureReason = "presentation has no endpoint identity";
          }
          return;
        }
        let inspection: HerdrPaneInspection;
        try {
          inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd: job.cwd });
        } catch (error) {
          if (error instanceof EndpointOwnershipError) {
            failureReason = "presentation endpoint disappeared before result consumption";
            return;
          }
          throw error;
        }
        const terminal = inspection.activeWorker
          ? await liveWorkerTerminal(inspection, job)
          : undefined;
        if (
          inspection.activeWorker &&
          (terminal === undefined || (!terminal.completed && terminal.phase !== "paused"))
        )
          return;
        let result: WorkerResult;
        try {
          result = await readWorkerResult(job.resultPath, {
            id: job.id,
            taskId: job.taskId,
            generation: job.generation,
            role: "presentation",
          });
        } catch (error) {
          if (
            isMissing(error) &&
            !isOlderThan(job.createdAt, this.#deps.clock, DEFAULT_STARTUP_GRACE_MS)
          )
            return;
          failureReason = `presentation result rejected: ${describeError(error)}`;
          return;
        }
        let completed: PresentationRecord;
        try {
          completed = await completePresentation({
            record,
            result,
            now: this.#deps.clock(),
            run: this.#deps.run,
          });
        } catch (error) {
          failureReason = `presentation artifact was rejected: ${describeError(error)}`;
          return;
        }
        const completedWithNotification = this.#deps.feedback.withPresentationNotification(
          record,
          completed,
        );
        await writeJsonAtomically(runtime.recordPath, completedWithNotification);
        let consumed = false;
        await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
          replaceRuntimePresentation(current, runtime.id, (entry) => {
            if (
              entry.job.id !== job.id ||
              entry.job.operationId !== job.operationId ||
              entry.operation?.id !== runtime.operation?.id ||
              entry.operation?.fencingRevision !== runtime.operation?.fencingRevision ||
              entry.operation?.claimOwner !== runtime.operation?.claimOwner ||
              !activeRuntimeJob(entry.job)
            )
              return entry;
            consumed = true;
            const consumedAt = this.#deps.clock();
            return {
              ...entry,
              ...(entry.operation === undefined
                ? {}
                : {
                    operation: {
                      ...entry.operation,
                      phase: "completed" as const,
                      resultConsumedAt: consumedAt,
                    },
                  }),
              job: { ...entry.job, phase: "consumed", consumedAt },
              ...(entry.reservation === undefined
                ? {}
                : {
                    reservation: {
                      ...entry.reservation,
                      phase: "released",
                      releasedAt: consumedAt,
                    },
                  }),
            };
          }),
        );
        if (!consumed) {
          const latestState = await this.#deps.readState();
          const latestRuntime = presentationRuntime(latestState, runtime.id);
          if (latestRuntime !== undefined) {
            followUp = {
              runtime: latestRuntime,
              record: await readPresentationRecord(latestRuntime.recordPath),
            };
          }
          return;
        }
        const consumedState = await this.#deps.readState();
        const consumedRuntime = presentationRuntime(consumedState, runtime.id);
        followUp = {
          runtime: consumedRuntime ?? runtime,
          record: completedWithNotification,
        };
      });
    } catch (error) {
      if (failureReason === undefined) {
        failureReason = `presentation reconciliation failed: ${describeError(error)}`;
      }
    }
    if (failureReason !== undefined) {
      await this.failPresentation(
        runtimeHint.id,
        failureReason,
        presentationFailureBinding(runtimeHint),
        true,
      );
      return;
    }
    if (followUp === undefined) return;
    let delivered = followUp.record;
    try {
      delivered = await this.#deps.feedback.flushPresentationNotification(followUp.runtime);
    } catch {
      delivered = await readPresentationRecord(followUp.runtime.recordPath);
    }
    this.#deps.feedback.startPresentationFeedback(followUp.runtime, delivered);
  }

  async failPresentation(
    id: string,
    reason: string,
    expectedBinding: PresentationFailureBinding,
    releaseReservation = true,
  ): Promise<void> {
    const state = await this.#deps.readState();
    const initialRuntime = presentationRuntime(state, id);
    if (initialRuntime === undefined) return;
    let shouldFlush = false;
    await withPresentationLock(initialRuntime.recordPath, undefined, async () => {
      const currentState = await this.#deps.readState();
      const runtime = presentationRuntime(currentState, id);
      if (runtime === undefined) return;
      if (
        runtime.job.id !== expectedBinding.jobId ||
        runtime.job.operationId !== expectedBinding.operationId ||
        runtime.operation?.id !== expectedBinding.operationId ||
        runtime.operation?.fencingRevision !== expectedBinding.fencingRevision ||
        runtime.operation?.claimOwner !== expectedBinding.claimOwner ||
        !activeRuntimeJob(runtime.job)
      )
        return;
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.status === "ended") return;
      const canRelease =
        releaseReservation &&
        runtime.endpointLaunch === undefined &&
        runtime.job.phase === "reserved" &&
        !runtime.job.launchAttempted;
      let settled = false;
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
        replaceRuntimePresentation(current, id, (entry) => {
          if (
            entry.job.id !== expectedBinding.jobId ||
            entry.job.operationId !== expectedBinding.operationId ||
            entry.operation?.id !== expectedBinding.operationId ||
            entry.operation?.fencingRevision !== expectedBinding.fencingRevision ||
            entry.operation?.claimOwner !== expectedBinding.claimOwner
          )
            return entry;
          settled = true;
          if (!canRelease) {
            return {
              ...entry,
              lastError: reason,
              ...(entry.job.launchAttempted && entry.operation !== undefined
                ? {
                    operation: {
                      ...entry.operation,
                      phase: "quarantined" as const,
                      error: reason,
                    },
                  }
                : {}),
            };
          }
          return {
            ...entry,
            lastError: reason,
            ...(entry.operation === undefined
              ? {}
              : {
                  operation: {
                    ...entry.operation,
                    phase: "failed" as const,
                    error: reason,
                  },
                }),
            job: { ...entry.job, phase: "failed", error: reason },
            ...(entry.reservation === undefined
              ? {}
              : {
                  reservation: {
                    ...entry.reservation,
                    phase: "released" as const,
                    releasedAt: this.#deps.clock(),
                  },
                }),
          };
        }),
      );
      if (!settled) return;
      if (!canRelease && !runtime.job.launchAttempted) return;
      const failed: PresentationRecord = {
        ...record,
        status: "failed",
        error: reason,
        updatedAt: this.#deps.clock(),
      };
      const failedWithNotification = this.#deps.feedback.withPresentationNotification(
        record,
        failed,
      );
      await writeJsonAtomically(runtime.recordPath, failedWithNotification);
      shouldFlush = hasPendingPresentationNotification(failedWithNotification);
    });
    if (shouldFlush) await this.#deps.feedback.flushPresentationNotification(initialRuntime);
  }

  async reservePresentation(id: string): Promise<boolean> {
    return this.#deps.store.exclusive(async (store) => {
      const state = await readRuntimeState(this.#deps.runtimePath);
      const runtime = presentationRuntime(state, id);
      if (runtime === undefined) throw new Error(`presentation ${id} is missing`);
      if (unreleasedReservation(runtime.reservation)) return false;
      const task = await store.read(runtime.taskId);
      if (task === undefined || !(await this.#deps.taskInScope(task))) {
        throw new Error(`task ${runtime.taskId} is missing`);
      }
      if (activeReservations(state) >= task.policy.config.maxWorkers) return false;
      if (runtime.operation === undefined) {
        throw new Error(`presentation ${id} has no durable operation`);
      }
      const spend = await this.#deps.requestSpend.decideAdmission({
        task,
        state,
        operationId: runtime.operation.id,
      });
      if (spend?.outcome === "paused") {
        await writeRuntimeState(this.#deps.runtimePath, withRequestBudget(state, spend.budget));
        return false;
      }
      const reservation = runtimeReservation(
        singleLine(this.#deps.idFactory(), "presentation reservation id"),
        runtime.taskId,
        this.#deps.sessionId,
        this.#deps.clock(),
        runtime.operation.id,
      );
      const admitted = replaceRuntimePresentation(state, id, (current) => ({
        ...current,
        ...(current.operation === undefined
          ? {}
          : { operation: { ...current.operation, phase: "admitted" as const } }),
        reservation,
      }));
      await writeRuntimeState(
        this.#deps.runtimePath,
        spend === undefined ? admitted : withRequestBudget(admitted, spend.budget),
      );
      return true;
    });
  }

  async savePresentationEndpointLaunch(
    presentationId: string,
    launch: DurableEndpointLaunch,
  ): Promise<boolean> {
    let claimed = false;
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimePresentation(state, presentationId, (current) => {
        if (current.reservation?.id !== launch.reservationId) {
          throw new Error(`presentation ${presentationId} has no matching endpoint reservation`);
        }
        if (
          !unreleasedReservation(current.reservation) ||
          !activeRuntimeJob(current.job) ||
          current.operation === undefined ||
          current.operation.id !== launch.operationId ||
          current.reservation.operationId !== launch.operationId
        ) {
          return current;
        }
        if (
          current.endpointLaunch !== undefined ||
          current.endpoint !== undefined ||
          current.job.endpoint !== undefined
        ) {
          return current;
        }
        claimed = true;
        return { ...current, endpointLaunch: launch };
      }),
    );
    return claimed;
  }

  async releaseUnlaunchedPresentationReservation(
    presentationId: string,
    reservationId: string,
    expectedJobId?: string,
    expectedOperationId?: string,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimePresentation(state, presentationId, (current) => {
        if (
          current.reservation?.id !== reservationId ||
          !unreleasedReservation(current.reservation) ||
          current.endpointLaunch !== undefined ||
          activeRuntimeJob(current.job) ||
          (expectedJobId !== undefined && current.job.id !== expectedJobId) ||
          (expectedOperationId !== undefined && current.operation?.id !== expectedOperationId)
        ) {
          return current;
        }
        return {
          ...current,
          reservation: {
            ...current.reservation,
            phase: "released",
            releasedAt: this.#deps.clock(),
          },
        };
      }),
    );
  }

  private async reconcilePresentationEndpointLaunch(
    runtime: RuntimePresentation,
  ): Promise<RuntimePresentation | undefined> {
    const launch = runtime.endpointLaunch;
    if (launch === undefined) return runtime;
    const recovery = await recoverEndpointFromLaunch(this.#deps.run, launch);
    if (recovery.status !== "recovered") {
      const reason =
        recovery.status === "ambiguous"
          ? `presentation endpoint recovery is ambiguous: ${recovery.detail}`
          : `presentation endpoint recovery is pending: ${recovery.detail}`;
      await this.setPresentationError(runtime.id, reason, runtime);
      return undefined;
    }
    try {
      await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
        replaceRuntimePresentation(state, runtime.id, (current) => {
          if (
            current.job.id !== runtime.job.id ||
            current.job.operationId !== runtime.job.operationId ||
            current.operation?.id !== runtime.operation?.id ||
            current.operation?.fencingRevision !== runtime.operation?.fencingRevision ||
            current.operation?.claimOwner !== runtime.operation?.claimOwner ||
            current.endpointLaunch?.reservationId !== launch.reservationId ||
            current.endpointLaunch?.operationId !== launch.operationId ||
            current.endpointLaunch?.createdAt !== launch.createdAt ||
            current.endpointLaunch?.sessionId !== launch.sessionId ||
            current.endpointLaunch?.workspaceLabel !== launch.workspaceLabel
          )
            return current;
          const { endpointLaunch: _endpointLaunch, ...withoutLaunch } = current;
          return {
            ...withoutLaunch,
            endpoint: recovery.endpoint,
            job: { ...current.job, endpoint: recovery.endpoint },
          };
        }),
      );
    } catch (error) {
      await this.setPresentationError(
        runtime.id,
        `recovered presentation endpoint identity could not be persisted: ${describeError(error)}`,
        runtime,
      );
      return undefined;
    }
    const state = await this.#deps.readState();
    return presentationRuntime(state, runtime.id);
  }

  private async setPresentationError(
    id: string,
    error: string,
    expected?: RuntimePresentation,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimePresentation(state, id, (current) => {
        if (
          expected !== undefined &&
          (current.job.id !== expected.job.id ||
            current.job.operationId !== expected.job.operationId ||
            current.operation?.id !== expected.operation?.id ||
            current.operation?.fencingRevision !== expected.operation?.fencingRevision ||
            current.operation?.claimOwner !== expected.operation?.claimOwner)
        )
          return current;
        return current.lastError === error ? current : { ...current, lastError: error };
      }),
    );
  }
}
