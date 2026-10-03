import type { TaskInbox, WorkerReceipt } from "../contracts.ts";
import { formatTaskMessages, type TaskMessageBatch } from "../tasks/communication-protocol.ts";
import {
  atLeastAsNewBatch,
  inboxMessageBatch,
  type ReceiptActivity,
  touchedReceipt,
  type WorkerControlConfig,
} from "../workers/control-protocol.ts";
import type { ReplyFor, SessionDeps, SessionEvent, SessionHost } from "./events.ts";

export type WorkerSteeringDeps = Pick<SessionDeps, "clock" | "timers"> &
  Readonly<{
    host: Pick<SessionHost, "perform">;
    config: WorkerControlConfig;
    /** The task inbox at `config.inboxPath`, or undefined when there is none. */
    readInbox(): Promise<TaskInbox | undefined>;
    writeReceipt(receipt: WorkerReceipt): Promise<void>;
    trace(event: string, detail?: Readonly<Record<string, unknown>>): void;
  }>;

const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECEIPT_WRITE_INTERVAL_MS = 1_000;

type ContextBuildReply = ReplyFor<Extract<SessionEvent, { type: "contextBuild" }>>;
type StopReply = ReplyFor<Extract<SessionEvent, { type: "stopRequested" }>>;

function isoNow(clock: WorkerSteeringDeps["clock"]): string {
  return new Date(clock.now()).toISOString();
}

/** The task inbox, refusing one for another task or a missing one past revision zero. */
async function checkedInbox(deps: WorkerSteeringDeps): Promise<TaskInbox | undefined> {
  const { config } = deps;
  const inbox = await deps.readInbox();
  if (inbox !== undefined && inbox.taskId !== config.taskId) {
    throw new Error("worker control inbox belongs to a different task");
  }
  if (inbox === undefined && config.initialRevision > 0) {
    throw new Error("worker control inbox is missing for a nonzero revision");
  }
  return inbox;
}

/**
 * Keeps the worker's communication receipt current and shows the worker the newest steering batch
 * from its task inbox exactly once in its context. Any receipt or inbox failure aborts the worker.
 */
export class WorkerSteering {
  private closed = false;
  private fatalError: unknown;
  private timersStarted = false;
  private lastWriteAt: number;
  private writeQueue = Promise.resolve();
  private pollInFlight = false;
  private retainedBatch: TaskMessageBatch | undefined;

  private constructor(
    private readonly deps: WorkerSteeringDeps,
    private receipt: WorkerReceipt,
  ) {
    this.lastWriteAt = deps.clock.now();
  }

  /** Checks the inbox belongs to this task and writes the starting receipt before any event. */
  static async open(deps: WorkerSteeringDeps): Promise<WorkerSteering> {
    const { config } = deps;
    await checkedInbox(deps);
    const now = isoNow(deps.clock);
    const receipt: WorkerReceipt = {
      schemaVersion: 1,
      jobId: config.jobId,
      taskId: config.taskId,
      generation: config.generation,
      receivedRevision: 0,
      appliedRevision: 0,
      heartbeatAt: now,
      progressAt: now,
      phase: "starting",
    };
    await deps.writeReceipt(receipt);
    return new WorkerSteering(deps, receipt);
  }

  /** The task whose inbox steers this worker. */
  get taskId(): string {
    return this.deps.config.taskId;
  }

  /** Records harness activity; a failed receipt write aborts the worker. */
  recordActivity(phase: WorkerReceipt["phase"], tool?: string): void {
    void this.touch({ phase, tool, meaningful: true }).catch((error) => this.fail(error));
  }

  async onSessionStart(): Promise<void> {
    if (!this.timersStarted) {
      this.timersStarted = true;
      this.deps.timers.every(POLL_INTERVAL_MS, () => {
        void this.poll().catch((error) => this.fail(error));
      });
      this.deps.timers.every(HEARTBEAT_INTERVAL_MS, () => {
        void this.heartbeat();
      });
    }
    try {
      await this.touch({ phase: "model", meaningful: true }, true);
      await this.poll();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Where the newest steering batch belongs in the context being built. `newestInContext` is the
   * newest batch for this task already in the conversation; the reply replaces every copy with one.
   */
  async onContextBuild(newestInContext: TaskMessageBatch | undefined): Promise<ContextBuildReply> {
    if (this.stopped) return {};
    try {
      this.retainInbox(await checkedInbox(this.deps), newestInContext?.revision);
      if (
        newestInContext !== undefined &&
        (this.retainedBatch === undefined || newestInContext.revision > this.retainedBatch.revision)
      ) {
        this.retainedBatch = newestInContext;
      }
      const batch = this.retainedBatch;
      if (batch === undefined || batch.revision === 0) return {};
      if (batch.revision > this.receipt.appliedRevision) {
        const now = isoNow(this.deps.clock);
        await this.persist(
          {
            ...this.receipt,
            receivedRevision: Math.max(this.receipt.receivedRevision, batch.revision),
            appliedRevision: batch.revision,
            heartbeatAt: now,
            progressAt: now,
          },
          true,
        );
      }
      return {
        taskMessages: {
          taskId: this.deps.config.taskId,
          batch,
          replaceExisting: newestInContext !== undefined,
        },
      };
    } catch (error) {
      this.fail(error);
      return {};
    }
  }

  /** Continues the session with any steering that arrived after the worker last saw its context. */
  async onStopRequested(aborted: boolean): Promise<StopReply> {
    this.deps.trace("session_stop", { aborted, closed: this.closed });
    if (this.stopped || aborted) return {};
    try {
      this.retainInbox(await checkedInbox(this.deps), this.retainedBatch?.revision);
      const pendingBatch =
        this.retainedBatch !== undefined &&
        this.retainedBatch.revision > this.receipt.appliedRevision
          ? this.retainedBatch
          : undefined;
      if (pendingBatch === undefined) {
        await this.touch({ phase: "finished", meaningful: false }, true);
        this.deps.trace("session_stop_done", { continuing: false });
        return {};
      }
      this.deps.trace("session_stop_done", { continuing: true, revision: pendingBatch.revision });
      await this.persist(
        {
          ...this.receipt,
          receivedRevision: Math.max(this.receipt.receivedRevision, pendingBatch.revision),
          heartbeatAt: isoNow(this.deps.clock),
          phase: "model",
        },
        true,
      );
      return {
        continueWith: formatTaskMessages(
          this.deps.config.taskId,
          pendingBatch.revision,
          pendingBatch.messages,
        ),
      };
    } catch (error) {
      this.fail(error);
      return {};
    }
  }

  onShutdown(): void {
    this.closed = true;
  }

  private get stopped(): boolean {
    return this.closed || this.fatalError !== undefined;
  }

  private fail(error: unknown): void {
    if (this.fatalError === undefined) this.fatalError = error;
    void this.deps.host.perform({ type: "abort" });
  }

  private async persist(next: WorkerReceipt, force: boolean): Promise<void> {
    if (this.closed) return;
    this.receipt = next;
    if (!force && this.deps.clock.now() - this.lastWriteAt < RECEIPT_WRITE_INTERVAL_MS) return;
    const write = this.writeQueue.then(async () => {
      if (this.closed) return;
      await this.deps.writeReceipt(this.receipt);
      this.lastWriteAt = this.deps.clock.now();
    });
    this.writeQueue = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private async touch(activity: ReceiptActivity, force = false): Promise<void> {
    const touched = touchedReceipt(this.receipt, activity, isoNow(this.deps.clock));
    await this.persist(touched.receipt, force || touched.changed);
  }

  private async observeInbox(): Promise<void> {
    if (this.stopped) return;
    const inbox = await checkedInbox(this.deps);
    this.retainInbox(inbox, undefined);
    if (inbox === undefined || inbox.revision <= this.receipt.receivedRevision) return;
    await this.persist(
      { ...this.receipt, receivedRevision: inbox.revision, heartbeatAt: isoNow(this.deps.clock) },
      true,
    );
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight || this.stopped) return;
    this.pollInFlight = true;
    try {
      await this.observeInbox();
    } catch (error) {
      this.fail(error);
    } finally {
      this.pollInFlight = false;
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped) return;
    const { phase } = this.receipt;
    try {
      await this.touch({
        phase,
        tool: phase === "tool" ? this.receipt.tool : undefined,
        meaningful: false,
      });
    } catch {
      // touch aborts the worker when a receipt write fails.
    }
  }

  /** Keeps the inbox batch when it is at least as new as `floor` and as the retained batch. */
  private retainInbox(inbox: TaskInbox | undefined, floor: number | undefined): void {
    if (inbox === undefined || (floor !== undefined && inbox.revision < floor)) return;
    this.retainedBatch = atLeastAsNewBatch(
      inboxMessageBatch(this.deps.config.taskId, inbox),
      this.retainedBatch,
    );
  }
}
