/**
 * The single central recovery mechanism: the same three moves get a stuck task back into its core
 * loop from its current stage, whatever stage that is.
 *
 *   1. Stop  - prove whatever Tandem owns that is still running for the task is dead.
 *   2. Save  - preserve the worktree and snapshot any uncommitted diff as durable evidence.
 *   3. Re-enter - hand the task back to its stage's single re-entry action.
 *
 * This slice wires only the `implementing` (and, since it shares the exact same path, `scouting`)
 * stage's re-entry: a dead worker with no owned pane recorded gets a fresh worker launched through
 * `WorkerWorkflow.relaunchWorker`, bounded by a per-generation restart budget. `validating`,
 * `reviewing`, and `awaiting-fixes` are not wired yet; each can be added later as its own stage
 * branch in `recoverStuckWorker()` below without touching the stop/save/proof machinery.
 */
import { join } from "node:path";
import { closeEndpoint, inspectEndpoint, interruptEndpoint } from "../adapters/herdr.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type {
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  IsoTimestamp,
  Notification,
  TaskQuestion,
  TaskRecord,
} from "../contracts.ts";
import { activeRuntimeJob, taskRuntime, unreleasedReservation } from "../runtime/activity.ts";
import {
  readRuntimeState,
  taskJobsDirectory,
  updateRuntimeState,
  writeTextAtomically,
} from "../runtime/persistence.ts";
import type { DurableJob, RuntimeRecoveryState, RuntimeTaskState } from "../runtime/schema.ts";
import { isTerminalTask, replaceRuntimeTask, workerRoleForTask } from "../service/records.ts";
import { transitionTask } from "../tasks/lifecycle.ts";
import type { TaskStore } from "../tasks/store.ts";
import { readWorkerTerminal, type WorkerTerminalJob } from "../workers/terminal.ts";
import { pauseWorkerTerminal } from "../workers/terminal-control.ts";
import { taskAsking } from "./conversation.ts";
import {
  classifyRestartFailure,
  formatRecoveryQuestion,
  RECOVERY_QUESTION_ID_PREFIX,
  type RecoveryDecisionReceipt,
  type RecoveryEvidence,
  restartIncidentIdentity,
} from "./decision.ts";

/** The two-restart budget every task generation gets before central recovery has to ask. */
export const MAX_AUTOMATIC_RESTARTS_PER_GENERATION = 2;
/** How long the interrupt step waits to observe the pane go quiet before escalating. */
const INTERRUPT_PROOF_TIMEOUT_MS = 2_000;
const INTERRUPT_PROOF_POLL_MS = 100;
/** How long the pid-signal step waits to observe the pane go quiet. */
const KILL_PROOF_TIMEOUT_MS = 5_000;
const KILL_PROOF_POLL_MS = 100;
/** A dead job that failed inside this window of its own launch is treated as an immediate failure
 *  for the same-failure-class guard, e.g. a provider outage that rejects every attempt at once. */
const IMMEDIATE_FAILURE_WINDOW_MS = 15 * 1_000;
/** Bounds the durable decision receipt list the same way conversational recovery does. */
const MAX_RECOVERY_DECISION_RECEIPTS = 10;
/** Every restart question's id starts with this, so an answer path can route to this module alone. */
export const RESTART_QUESTION_ID_PREFIX = `${RECOVERY_QUESTION_ID_PREFIX}restart-`;

export type RelaunchWorker = (
  task: TaskRecord,
  extraInstructions: readonly string[],
) => Promise<Readonly<{ readonly relaunched: boolean; readonly reason?: string }>>;

export type CentralRecoveryDependencies = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  /** Central recovery's only mutation for the implementing/scouting re-entry: a new operation, a
   *  new pane when one is not already owned, and a normal `launchAgent` launch. */
  readonly relaunchWorker: RelaunchWorker;
  readonly blockTask: (taskId: string, reason: string) => Promise<void>;
}>;

export type CentralRecoveryAction = "relaunched" | "asked" | "blocked" | "skipped";

export type CentralRecoveryOutcome = Readonly<{
  readonly taskId: string;
  readonly action: CentralRecoveryAction;
  readonly reason: string;
}>;

function defaultRecovery(runtime: RuntimeTaskState | undefined): RuntimeRecoveryState {
  return (
    runtime?.recovery ?? {
      schemaVersion: 1,
      recoveryAttempts: 0,
      validationRetries: 0,
      evidenceRepairs: 0,
    }
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function terminalJobFor(job: DurableJob | undefined): WorkerTerminalJob | undefined {
  if (job === undefined || job.kind !== "worker") return undefined;
  return {
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    cwd: job.cwd,
    jobPath: job.jobPath,
  };
}

function elapsedMillis(job: DurableJob): number | undefined {
  const end = job.consumedAt ?? job.createdAt;
  const startMs = Date.parse(job.launchedAt ?? job.createdAt);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, endMs - startMs)
    : undefined;
}

type DeathProof = Readonly<{
  readonly proven: boolean;
  readonly deadJobId: string;
  readonly reasonSummary: string;
  readonly elapsedMs?: number;
}>;

/**
 * Central recovery: stop, save, re-enter. Only the `implementing`/`scouting` stage's re-entry is
 * wired in this slice; every other stage is reported as `skipped` so a caller falls back to whatever
 * it did before.
 */
export class CentralRecoveryWorkflow {
  readonly #deps: CentralRecoveryDependencies;

  public constructor(deps: CentralRecoveryDependencies) {
    this.#deps = deps;
  }

  /**
   * Gets a task whose worker pane is proven gone back into its core loop from `implementing` or
   * `scouting`. The caller (the coordinator's reconcile loop) is expected to have already confirmed
   * there is no active durable job and no unreleased reservation; this defends the same invariant.
   */
  public async recoverStuckWorker(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    if (task.stage !== "implementing" && task.stage !== "scouting") {
      return {
        taskId: task.id,
        action: "skipped",
        reason: `stage ${task.stage} has no wired re-entry yet`,
      };
    }
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined) {
      const reason = "durable runtime metadata is missing; no re-entry is possible";
      await this.#deps.blockTask(task.id, reason);
      return { taskId: task.id, action: "blocked", reason };
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "an active job or an unreleased reservation already owns this task",
      };
    }

    // --- Move 1: stop. Prove the prior worker is dead before anything else runs. ---
    const proof = await this.proveDeath(task, runtime);
    const now = this.#deps.clock();
    const incidentIdentity = restartIncidentIdentity({
      taskId: task.id,
      generation: task.generation,
      deadJobId: proof.deadJobId,
    });
    if (!proof.proven) {
      return this.askRestart(task, incidentIdentity, now, {
        what: `The worker for task ${task.id} stopped, but I could not prove it is actually gone (${proof.reasonSummary}).`,
        want: "Ask before touching anything: I will not restart, close a pane, or retry work I cannot prove is dead.",
        risk: "Restarting now could run two workers on the same worktree at once. Nothing has changed; your worktree and history are preserved.",
      });
    }

    const recovery = defaultRecovery(runtime);
    const restartsUsed =
      recovery.restartGeneration === task.generation ? (recovery.restarts ?? 0) : 0;
    if (restartsUsed >= MAX_AUTOMATIC_RESTARTS_PER_GENERATION) {
      return this.askRestart(task, incidentIdentity, now, {
        what: `The worker for task ${task.id} stopped again (${proof.reasonSummary}); I already restarted it automatically ${restartsUsed} time(s) this generation.`,
        want: "Ask before restarting a third time: say to restart and I will start a fresh worker in the same worktree, keeping every edit, or say to stop and leave it for you to inspect.",
        risk: "Restarting again may just repeat the same failure if it is not a one-off. Nothing is discarded either way; your worktree, reports, and history are preserved.",
      });
    }

    const failureClass = classifyRestartFailure(proof.reasonSummary);
    const withinImmediateWindow =
      proof.elapsedMs !== undefined && proof.elapsedMs < IMMEDIATE_FAILURE_WINDOW_MS;
    const sameClassAsLastRestart =
      restartsUsed > 0 && recovery.lastRestartFailureClass === failureClass;
    if (withinImmediateWindow && sameClassAsLastRestart) {
      return this.askRestart(task, incidentIdentity, now, {
        what: `The worker for task ${task.id} failed again within ${Math.round((proof.elapsedMs ?? 0) / 1000)}s of starting, the same way (${proof.reasonSummary}) as the restart before it.`,
        want: "Ask instead of restarting again automatically: this pattern looks systemic (for example a provider outage) rather than a one-off, so restarting blindly would likely just fail the same way again.",
        risk: "Nothing has changed; your worktree, reports, and history are preserved either way.",
      });
    }

    // --- Move 2: save. Snapshot uncommitted work before the next worker can touch it. ---
    await this.snapshotWorktree(task, runtime, restartsUsed + 1);

    // --- Move 3: re-enter. ---
    const extraInstructions = [
      `This is an automatic restart after the previous worker stopped without finishing (${proof.reasonSummary}). Uncommitted or partially applied changes from the previous attempt may already exist in this worktree. Run \`git status\` and \`git diff\` first, inspect any partial edits, and repair or complete them before continuing. This is restart ${restartsUsed + 1} of ${MAX_AUTOMATIC_RESTARTS_PER_GENERATION} for this generation.`,
    ];
    const relaunch = await this.#deps.relaunchWorker(task, extraInstructions);
    if (!relaunch.relaunched) {
      const reason = relaunch.reason ?? "relaunch was refused";
      await this.#deps.blockTask(
        task.id,
        `automatic restart could not launch a new worker: ${reason}`,
      );
      return { taskId: task.id, action: "blocked", reason };
    }

    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        recovery: {
          ...defaultRecovery(entry),
          restarts: restartsUsed + 1,
          restartGeneration: task.generation,
          lastRestartFailureClass: failureClass,
          lastRestartAt: now,
          lastOperation: "relaunch",
          lastAt: now,
        },
      })),
    );
    const notice = `The worker stopped (${proof.reasonSummary}). I restarted it; your edits are kept. (Restart ${restartsUsed + 1} of ${MAX_AUTOMATIC_RESTARTS_PER_GENERATION}.)`;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) return;
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message: notice,
        acknowledged: false,
        kind: "coordinator",
      };
      await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: now,
        notifications: [...entry.notifications, notification],
      }));
    });
    await this.saveDecision(task.id, {
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(incidentIdentity, proof.reasonSummary, now),
      ownership: "proven-owned",
      priorOutcome: "known",
      approval: "preapproved",
      unmetProofs: [],
      consequences: notice,
      disposition: "applied",
      dispositionReason: notice,
    });
    return { taskId: task.id, action: "relaunched", reason: notice };
  }

  /**
   * Answers the one question central recovery ever asks (the 3rd-restart or unproven-death
   * question). The reply is stored as a recovery decision, never as a worker instruction: it clears
   * the question directly and never calls `appendTaskMessage`, so `task.communication.revision` is
   * left exactly as it was.
   */
  public async answerRestartQuestion(
    taskId: string,
    questionId: string,
    text: string,
  ): Promise<Readonly<{ readonly handled: boolean }>> {
    if (!questionId.startsWith(RESTART_QUESTION_ID_PREFIX)) return { handled: false };
    const task = await this.#deps.getTask(taskId);
    if (task.communication?.question?.id !== questionId) return { handled: false };
    const now = this.#deps.clock();
    const approved = /^(y|yes|approve|approved|restart|proceed|go|ok|okay)\b/iu.test(text.trim());
    let cleared: TaskRecord | undefined;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || current.communication?.question?.id !== questionId) return;
      const { question: _question, ...withoutQuestion } = current.communication ?? {
        revision: 0,
        messages: [],
      };
      cleared = await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: now,
        communication: withoutQuestion,
      }));
    });
    const evidenceIdentity = questionId.slice(RESTART_QUESTION_ID_PREFIX.length);
    await this.saveDecision(taskId, {
      taskId,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(evidenceIdentity, "user answered the restart question", now),
      ownership: approved ? "proven-owned" : "unknown",
      priorOutcome: approved ? "known" : "uncertain",
      approval: "user-approval",
      unmetProofs: [],
      consequences: approved
        ? "the user approved restarting past the automatic budget"
        : "the user declined a further restart",
      disposition: approved ? "applied" : "refused",
      dispositionReason: `user answered: ${text}`.slice(0, 500),
      questionId,
    });
    if (approved && cleared !== undefined) {
      // The person explicitly authorized one more restart; reuse the same three-move path with a
      // budget that treats this approval as spending exactly one more restart. Asking blocked the
      // task, so it is resumed back to implementing/scouting first.
      const resumed = await this.resumeFromAsk(cleared);
      if (resumed !== undefined) await this.forceOneMoreRestart(resumed);
    }
    return { handled: true };
  }

  /** Undoes the block that asking the restart question applied, so relaunch can proceed. */
  private async resumeFromAsk(task: TaskRecord): Promise<TaskRecord | undefined> {
    if (task.stage !== "blocked")
      return task.stage === "implementing" || task.stage === "scouting" ? task : undefined;
    if (task.previousStage !== "implementing" && task.previousStage !== "scouting") {
      return undefined;
    }
    return this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined || current.stage !== "blocked") return current;
      return store.update(current.id, current.revision, (entry) =>
        transitionTask(
          entry,
          { type: "resume" },
          { now: this.#deps.clock(), notificationId: this.#deps.idFactory() },
        ),
      );
    });
  }

  /** After an explicit user approval, relaunch once more without re-asking the same question. */
  private async forceOneMoreRestart(task: TaskRecord): Promise<void> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || (task.stage !== "implementing" && task.stage !== "scouting"))
      return;
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) return;
    const proof = await this.proveDeath(task, runtime);
    if (!proof.proven) {
      await this.#deps.blockTask(
        task.id,
        `the approved restart could not proceed: ${proof.reasonSummary}`,
      );
      return;
    }
    const recovery = defaultRecovery(runtime);
    const restartsUsed =
      recovery.restartGeneration === task.generation ? (recovery.restarts ?? 0) : 0;
    await this.snapshotWorktree(task, runtime, restartsUsed + 1);
    const extraInstructions = [
      `This is a restart the user explicitly approved after the automatic restart budget was reached (${proof.reasonSummary}). Uncommitted or partially applied changes from the previous attempt may already exist in this worktree. Run \`git status\` and \`git diff\` first, inspect any partial edits, and repair or complete them before continuing.`,
    ];
    const relaunch = await this.#deps.relaunchWorker(task, extraInstructions);
    if (!relaunch.relaunched) {
      await this.#deps.blockTask(
        task.id,
        `the approved restart could not launch a new worker: ${relaunch.reason ?? "relaunch was refused"}`,
      );
      return;
    }
    const now = this.#deps.clock();
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        recovery: {
          ...defaultRecovery(entry),
          restarts: restartsUsed + 1,
          restartGeneration: task.generation,
          lastRestartFailureClass: classifyRestartFailure(proof.reasonSummary),
          lastRestartAt: now,
          lastOperation: "relaunch",
          lastAt: now,
        },
      })),
    );
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) return;
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message: `The worker stopped (${proof.reasonSummary}). You approved another restart; I restarted it and your edits are kept.`,
        acknowledged: false,
        kind: "coordinator",
      };
      await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: now,
        notifications: [...entry.notifications, notification],
      }));
    });
  }

  private evidenceFor(
    identity: string,
    summary: string,
    observedAt: IsoTimestamp,
  ): RecoveryEvidence {
    return { kind: "durable-blocker", identity, summary, observedAt };
  }

  private async askRestart(
    task: TaskRecord,
    incidentIdentity: string,
    now: IsoTimestamp,
    parts: Readonly<{ readonly what: string; readonly want: string; readonly risk: string }>,
  ): Promise<CentralRecoveryOutcome> {
    const questionId = `${RESTART_QUESTION_ID_PREFIX}${incidentIdentity}`;
    const text = formatRecoveryQuestion(parts);
    const question: TaskQuestion = { id: questionId, text, recommendation: parts.want };
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined || isTerminalTask(current)) return;
      if (current.communication?.question?.id === question.id) return;
      const asked = taskAsking(current, question, this.#deps.idFactory(), this.#deps.clock());
      await store.update(current.id, current.revision, () => asked);
    });
    await this.saveDecision(task.id, {
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(incidentIdentity, parts.what, now),
      ownership: "unknown",
      priorOutcome: "uncertain",
      approval: "user-approval",
      unmetProofs: [],
      consequences: parts.want,
      disposition: "asked",
      dispositionReason: parts.want,
      questionId,
    });
    return { taskId: task.id, action: "asked", reason: text };
  }

  private async saveDecision(
    taskId: string,
    draft: Omit<RecoveryDecisionReceipt, "schemaVersion" | "id" | "decidedAt">,
  ): Promise<void> {
    const receipt: RecoveryDecisionReceipt = {
      schemaVersion: 1,
      id: `${RESTART_QUESTION_ID_PREFIX}${draft.evidence.identity}-${draft.disposition}`,
      ...draft,
      decidedAt: this.#deps.clock(),
    };
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (entry) => ({
        ...entry,
        recoveryDecisions: [
          ...(entry.recoveryDecisions ?? []).filter((existing) => existing.id !== receipt.id),
          receipt,
        ].slice(-MAX_RECOVERY_DECISION_RECEIPTS),
      })),
    );
  }

  /** Snapshots the worktree's uncommitted diff and untracked files as durable evidence before relaunch. */
  private async snapshotWorktree(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    attempt: number,
  ): Promise<void> {
    const path = runtime.worktree?.path;
    if (path === undefined) return;
    const directory = join(
      taskJobsDirectory(this.#deps.home, task.id),
      String(task.generation),
      `recovery-restart-${attempt}`,
    );
    try {
      const diff = await this.#deps.run({ argv: ["git", "-C", path, "diff"], cwd: path });
      await writeTextAtomically(join(directory, "uncommitted.diff"), diff.stdout);
    } catch {
      // Best-effort evidence; a snapshot failure never blocks recovery.
    }
    try {
      const untracked = await this.#deps.run({
        argv: ["git", "-C", path, "ls-files", "--others", "--exclude-standard"],
        cwd: path,
      });
      await writeTextAtomically(join(directory, "untracked-files.txt"), untracked.stdout);
    } catch {
      // Best-effort evidence; a snapshot failure never blocks recovery.
    }
  }

  /**
   * Proof of death for the implementing/scouting re-entry. A candidate stale endpoint (one the task
   * record still names but the durable runtime no longer owns) is run through the stop ladder first;
   * only once nothing owned is left running is the prior job's outcome read.
   */
  private async proveDeath(task: TaskRecord, runtime: RuntimeTaskState): Promise<DeathProof> {
    const role = workerRoleForTask(task);
    const staleEndpoint = (task.endpoints ?? []).find(
      (endpoint) =>
        endpoint.role === role &&
        endpoint.generation === task.generation &&
        !runtime.endpoints.some((owned) => owned.paneId === endpoint.paneId),
    );
    const lastJob = this.lastJobFor(runtime, task, role);
    if (staleEndpoint !== undefined) {
      const cwd = runtime.worktree?.path;
      if (cwd === undefined) {
        return {
          proven: false,
          deadJobId: lastJob?.id ?? "none",
          reasonSummary: "the worker pane's working directory is unknown",
        };
      }
      const stopped = await this.stopLadder(staleEndpoint, cwd, terminalJobFor(lastJob));
      if (!stopped) {
        return {
          proven: false,
          deadJobId: lastJob?.id ?? "none",
          reasonSummary: `pane ${staleEndpoint.paneId} could not be proven stopped`,
        };
      }
      await this.clearTaskEndpoint(task.id, staleEndpoint.paneId);
    }
    if (lastJob === undefined) {
      return {
        proven: true,
        deadJobId: "none",
        reasonSummary: "no worker has run yet for this attempt",
      };
    }
    if (activeRuntimeJob(lastJob)) {
      return {
        proven: false,
        deadJobId: lastJob.id,
        reasonSummary: `job ${lastJob.id} is still recorded as ${lastJob.phase}`,
      };
    }
    const elapsedMs = elapsedMillis(lastJob);
    return {
      proven: true,
      deadJobId: lastJob.id,
      reasonSummary:
        lastJob.error ?? task.blockReason ?? `worker ${lastJob.phase} without completing`,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    };
  }

  private lastJobFor(
    runtime: RuntimeTaskState,
    task: TaskRecord,
    role: DurableJob["role"],
  ): DurableJob | undefined {
    const candidates = runtime.jobs.filter(
      (job) => job.kind === "worker" && job.role === role && job.generation === task.generation,
    );
    return candidates.at(-1);
  }

  /** Removes a proven-closed stale endpoint from the task's own durable record. */
  private async clearTaskEndpoint(taskId: string, paneId: string): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || current.endpoints === undefined) return;
      if (!current.endpoints.some((entry) => entry.paneId === paneId)) return;
      await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: this.#deps.clock(),
        ...(entry.endpoints === undefined
          ? {}
          : { endpoints: entry.endpoints.filter((candidate) => candidate.paneId !== paneId) }),
      }));
    });
  }

  /**
   * The stop ladder: control-file pause, then interrupt, then (only once the recorded pid is proven
   * to be the pane's own foreground process) a direct signal, then proof of exit, then closing the
   * pane Tandem now owns proven-stopped. Any step that cannot prove the pane is gone leaves it
   * alone and reports death unproven; nothing here ever touches a pane whose ownership is unproven.
   */
  private async stopLadder(
    endpoint: Endpoint,
    cwd: string,
    terminalJob: WorkerTerminalJob | undefined,
  ): Promise<boolean> {
    const observe = async (): Promise<"alive" | "gone" | "foreign" | "unknown"> => {
      try {
        const inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        return inspection.activeWorker ? "alive" : "gone";
      } catch (error) {
        if (error instanceof EndpointOwnershipError) {
          return error.reason === "missing" ? "gone" : "foreign";
        }
        return "unknown";
      }
    };
    const closeIfOwned = async (): Promise<boolean> => {
      try {
        await closeEndpoint(this.#deps.run, { endpoint, cwd });
        return true;
      } catch (error) {
        return error instanceof EndpointOwnershipError && error.reason === "missing";
      }
    };
    let state = await observe();
    if (state === "foreign" || state === "unknown") return false;
    if (state === "gone") return closeIfOwned();
    try {
      await pauseWorkerTerminal(this.#deps.run, {
        endpoint,
        cwd,
        ...(terminalJob === undefined ? {} : { job: terminalJob }),
      });
    } catch {
      // Best effort; the interrupt and pid-signal steps below can still finish the job.
    }
    state = await observe();
    if (state === "foreign" || state === "unknown") return false;
    if (state === "gone") return closeIfOwned();
    try {
      await interruptEndpoint(this.#deps.run, {
        endpoint,
        cwd,
        timeoutMs: INTERRUPT_PROOF_TIMEOUT_MS,
        pollIntervalMs: INTERRUPT_PROOF_POLL_MS,
      });
      return closeIfOwned();
    } catch {
      // Interrupt could not prove the pane stopped within its own bound; fall through to a direct
      // signal, but only once the recorded pid is proven to be this pane's own foreground process.
    }
    if (terminalJob !== undefined) {
      const terminal = await readWorkerTerminal(terminalJob).catch(() => undefined);
      if (terminal !== undefined) {
        let inspection: Awaited<ReturnType<typeof inspectEndpoint>> | undefined;
        try {
          inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        } catch {
          inspection = undefined;
        }
        const foreground =
          inspection?.processInfo.foregroundProcesses.some(
            (process) => process.pid === terminal.pid,
          ) === true;
        if (foreground) {
          try {
            await this.#deps.run({ argv: ["kill", "-TERM", String(terminal.pid)], cwd });
          } catch {
            // Best effort; the exit-proof poll below decides the outcome either way.
          }
          const deadline = Date.now() + KILL_PROOF_TIMEOUT_MS;
          while (Date.now() < deadline) {
            state = await observe();
            if (state === "gone") return closeIfOwned();
            if (state === "foreign" || state === "unknown") return false;
            await sleep(KILL_PROOF_POLL_MS);
          }
        }
      }
    }
    return false;
  }
}
