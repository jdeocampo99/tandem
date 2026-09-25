import { readFile } from "node:fs/promises";
import type { Clock, CommandRunner } from "../contracts.ts";
import {
  activeRuntimeJob,
  presentationRuntime,
  taskRuntime,
  unreleasedReservation,
} from "../runtime/activity.ts";
import { updateRuntimeState, writeJsonAtomically } from "../runtime/persistence.ts";
import type { DurableJob, RuntimePresentation, RuntimeState } from "../runtime/schema.ts";
import { describeError, replaceRuntimePresentation } from "../service/records.ts";
import type { TaskStore } from "../tasks/store.ts";
import {
  readWorkerTerminal,
  requestWorkerMockup,
  type WorkerTerminalJob,
  type WorkerTerminalState,
} from "../workers/terminal.ts";
import { workerJobForEndpoint } from "../workers/terminal-control.ts";
import type { PresentationFeedbackWorkflow } from "./feedback.ts";
import { withPresentationLock } from "./lock.ts";
import {
  hasPendingPresentationNotification,
  type PresentationAgent,
  type PresentationRecord,
  type PresentationRequest,
  readPresentationRecord,
} from "./records.ts";
import { openDrawnPresentation } from "./session.ts";

export type PresentationRuntimeDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly readState: () => Promise<RuntimeState>;
  readonly feedback: PresentationFeedbackWorkflow;
}>;

/** How long a request waits for the agent to take it before the next tick tries again. */
const REQUEST_ACK_TIMEOUT_MS = 3_000;
/** The worker extension writes a heartbeat every second; older than this, the agent is gone. */
const AGENT_HEARTBEAT_MAX_AGE_MS = 30_000;

export type PresentationRequestStep = "finished" | "drawing" | "send" | "wait" | "gone";

/** What to do with a pending draw or revise request, given the agent's terminal as last written. */
export function presentationRequestStep(
  request: Pick<PresentationRequest, "id">,
  terminal: WorkerTerminalState | undefined,
  nowMs: number,
): PresentationRequestStep {
  if (terminal === undefined || terminal.phase === "closed" || terminal.phase === "closing") {
    return "gone";
  }
  if (Math.abs(nowMs - Date.parse(terminal.heartbeatAt)) > AGENT_HEARTBEAT_MAX_AGE_MS) {
    return "gone";
  }
  if (terminal.settledCommandId === request.id) return "finished";
  if (terminal.commandId === request.id) return "drawing";
  // Research still running, the person typing in the pane, or a pause: try again next tick.
  return terminal.completed && terminal.phase === "idle" ? "send" : "wait";
}

/** The research task's live scout job, the one whose pane draws its visuals. */
export function presentationAgentFor(
  state: RuntimeState,
  taskId: string,
): PresentationAgent | undefined {
  const runtime = taskRuntime(state, taskId);
  const endpoint = runtime?.endpoints.find((entry) => entry.role === "scout");
  if (runtime === undefined || endpoint === undefined) return undefined;
  const job: DurableJob | undefined = workerJobForEndpoint(runtime.jobs, endpoint);
  if (job === undefined || job.role !== "scout") return undefined;
  return { jobId: job.id, jobPath: job.jobPath, generation: job.generation, cwd: job.cwd };
}

function terminalJob(record: PresentationRecord, agent: PresentationAgent): WorkerTerminalJob {
  return {
    id: agent.jobId,
    taskId: record.taskId,
    generation: agent.generation,
    role: "scout",
    cwd: agent.cwd,
    jobPath: agent.jobPath,
  };
}

async function readAgentTerminal(
  record: PresentationRecord,
  agent: PresentationAgent,
): Promise<WorkerTerminalState | undefined> {
  try {
    return await readWorkerTerminal(terminalJob(record, agent));
  } catch {
    return undefined;
  }
}

function sameAgent(left: PresentationAgent | undefined, right: PresentationAgent): boolean {
  return left?.jobId === right.jobId && left.jobPath === right.jobPath;
}

/**
 * Drives each presentation's pending request through the research agent that draws it: sends the
 * request when the agent is free, opens the page the first time a draw finishes, and hands the
 * listener back to Lavish. Pages from the retired presentation worker only keep their listener.
 */
export class PresentationRuntimeWorkflow {
  readonly #deps: PresentationRuntimeDependencies;

  constructor(deps: PresentationRuntimeDependencies) {
    this.#deps = deps;
  }

  async reconcilePresentation(runtime: RuntimePresentation): Promise<void> {
    const record = await readPresentationRecord(runtime.recordPath);
    if (record.agent === undefined) {
      await this.reconcileRetired(runtime, record);
      return;
    }
    const request = record.request;
    if (request === undefined) {
      this.#deps.feedback.startPresentationFeedback(runtime, record);
      return;
    }
    const state = await this.#deps.readState();
    const agent = presentationAgentFor(state, record.taskId) ?? record.agent;
    const terminal = await readAgentTerminal(record, agent);
    const step = presentationRequestStep(request, terminal, Date.parse(this.#deps.clock()));
    if (step === "send") {
      if (!sameAgent(record.agent, agent)) await this.updateAgent(runtime, request, agent);
      try {
        await requestWorkerMockup(
          terminalJob(record, agent),
          request.id,
          { briefPath: request.briefPath, artifactDir: record.cwd },
          REQUEST_ACK_TIMEOUT_MS,
        );
      } catch {
        // The agent was busy after all; the next tick sends again with the same request id.
      }
    } else if (step === "finished") {
      await this.finishRequest(runtime, request);
    } else if (step === "gone") {
      await this.abandonRequest(runtime, request);
    }
    const current = await readPresentationRecord(runtime.recordPath);
    this.#deps.feedback.startPresentationFeedback(runtime, current);
  }

  /** Marks a presentation failed and tells the coordinator, unless the user already ended it. */
  async failPresentation(id: string, reason: string): Promise<void> {
    const runtime = presentationRuntime(await this.#deps.readState(), id);
    if (runtime === undefined) return;
    const flush = await withPresentationLock(runtime.recordPath, undefined, async () => {
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.status === "ended" || record.status === "failed") return false;
      const { request: _request, ...withoutRequest } = record;
      const failed = this.#deps.feedback.withPresentationNotification(record, {
        ...withoutRequest,
        status: "failed",
        error: reason,
        updatedAt: this.#deps.clock(),
      });
      await writeJsonAtomically(runtime.recordPath, failed);
      return hasPendingPresentationNotification(failed);
    });
    if (flush) await this.#deps.feedback.flushPresentationNotification(runtime);
  }

  private async updateAgent(
    runtime: RuntimePresentation,
    request: PresentationRequest,
    agent: PresentationAgent,
  ): Promise<void> {
    await withPresentationLock(runtime.recordPath, undefined, async () => {
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.request?.id !== request.id) return;
      await writeJsonAtomically(runtime.recordPath, { ...record, agent });
    });
  }

  private async finishRequest(
    runtime: RuntimePresentation,
    request: PresentationRequest,
  ): Promise<void> {
    const flush = await withPresentationLock(runtime.recordPath, undefined, async () => {
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.request?.id !== request.id) return false;
      const { request: _request, ...withoutRequest } = record;
      const now = this.#deps.clock();
      const next =
        request.kind === "draw"
          ? this.#deps.feedback.withPresentationNotification(
              record,
              await openDrawnPresentation({ record: withoutRequest, now, run: this.#deps.run }),
            )
          : this.#deps.feedback.withRevisionNotification(
              { ...withoutRequest, updatedAt: now },
              "The research agent updated the visual; the open tab reloads by itself.",
              "routine",
            );
      const queued = await this.#deps.feedback.nextQueuedRevision(next);
      await writeJsonAtomically(runtime.recordPath, queued);
      return hasPendingPresentationNotification(queued);
    });
    if (flush) await this.#deps.feedback.flushPresentationNotification(runtime);
  }

  /** The agent's pane closed: a draw fails, and a revision's comment goes to the coordinator. */
  private async abandonRequest(
    runtime: RuntimePresentation,
    request: PresentationRequest,
  ): Promise<void> {
    if (request.kind === "draw") {
      await this.failPresentation(
        runtime.id,
        "The research agent's pane closed before it drew the page.",
      );
      return;
    }
    const flush = await withPresentationLock(runtime.recordPath, undefined, async () => {
      const record = await readPresentationRecord(runtime.recordPath);
      if (record.request?.id !== request.id) return false;
      const { request: _request, pendingFeedback, ...withoutRequest } = record;
      const brief = await readFile(request.briefPath, "utf8").catch(
        (error: unknown) => `(the comment could not be read: ${describeError(error)})`,
      );
      const later = (pendingFeedback ?? []).join("\n\n");
      const next = this.#deps.feedback.withRevisionNotification(
        { ...withoutRequest, updatedAt: this.#deps.clock() },
        `Presentation ${record.id}: the research agent's pane is closed, so these Lavish comments were not applied. Restart the research task to keep iterating, or handle them here.\n${brief}${later.length === 0 ? "" : `\n\n${later}`}`,
        "coordinator",
      );
      await writeJsonAtomically(runtime.recordPath, next);
      return hasPendingPresentationNotification(next);
    });
    if (flush) await this.#deps.feedback.flushPresentationNotification(runtime);
  }

  // ponytail: pages drawn by the retired presentation worker keep their listener; unfinished ones fail.
  private async reconcileRetired(
    runtime: RuntimePresentation,
    record: PresentationRecord,
  ): Promise<void> {
    if (record.status === "queued" || record.status === "running" || record.status === "blocked") {
      await this.failPresentation(
        runtime.id,
        "Tandem no longer uses a separate presentation agent; ask the research task for the visual again.",
      );
    }
    await this.settleRetiredJob(runtime.id);
    const current = await readPresentationRecord(runtime.recordPath);
    this.#deps.feedback.startPresentationFeedback(runtime, current);
  }

  /**
   * Marks a retired presentation worker's unfinished job failed, so it no longer holds its task's
   * cleanup or its own pane open. A reservation it still holds is left for `tandem fix`.
   */
  private async settleRetiredJob(id: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimePresentation(state, id, (entry) => {
        const job = entry.job;
        if (
          job === undefined ||
          !activeRuntimeJob(job) ||
          unreleasedReservation(entry.reservation)
        ) {
          return entry;
        }
        const error = "the separate presentation worker was retired";
        return {
          ...entry,
          lastError: error,
          job: { ...job, phase: "failed", error },
          ...(entry.operation === undefined
            ? {}
            : { operation: { ...entry.operation, phase: "failed" as const, error } }),
        };
      }),
    );
  }
}
