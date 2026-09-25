import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { TaskInbox, WorkerReceipt } from "./contracts.ts";
import { readTaskInbox, writeWorkerReceipt } from "./tasks/communication-persistence.ts";
import { formatTaskMessages, type TaskMessageBatch } from "./tasks/communication-protocol.ts";
import {
  atLeastAsNewBatch,
  contextWithTaskMessages,
  inboxMessageBatch,
  newestTaskMarker,
  parseWorkerControlConfig,
  type ReceiptActivity,
  toolName,
  touchedReceipt,
  type WorkerControlConfig,
} from "./workers/control-protocol.ts";
import { traceWorkerTurn, WORKER_JOB_PATH_ENV } from "./workers/terminal.ts";
import { registerWorkerTerminalExtension } from "./workers/terminal-extension.ts";

export const WORKER_CONTROL_ENV = "TANDEM_WORKER_CONTROL";
const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECEIPT_WRITE_INTERVAL_MS = 1_000;

type Trace = (event: string, detail?: Readonly<Record<string, unknown>>) => void;
type SessionStopResult = Readonly<{ continue: true; additionalContext: string }>;

function readNow(): string {
  return new Date().toISOString();
}

async function inboxFor(config: WorkerControlConfig): Promise<TaskInbox | undefined> {
  const inbox = await readTaskInbox(config.inboxPath);
  if (inbox !== undefined && inbox.taskId !== config.taskId) {
    throw new Error("worker control inbox belongs to a different task");
  }
  if (inbox === undefined && config.initialRevision > 0) {
    throw new Error("worker control inbox is missing for a nonzero revision");
  }
  return inbox;
}

function initialReceipt(config: WorkerControlConfig): WorkerReceipt {
  const now = readNow();
  return {
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
}

function jobTrace(jobPath: string | undefined): Trace {
  return (event, detail) => {
    if (jobPath !== undefined && jobPath.trim().length > 0) traceWorkerTurn(jobPath, event, detail);
  };
}

function failClosed(pi: ExtensionAPI, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  pi.on("tool_call", () => ({ block: true, reason: `Worker initialization failed: ${message}` }));
  pi.on("input", () => ({ handled: true }));
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`Tandem worker initialization failed: ${message}`, "error");
    ctx.abort();
    ctx.shutdown();
  });
}

export default async function workerControlExtension(pi: ExtensionAPI): Promise<void> {
  try {
    await registerWorkerCommunication(pi);
    await registerWorkerTerminalExtension(pi);
  } catch (error) {
    failClosed(pi, error);
  }
}

/**
 * Keeps the worker's communication receipt current and shows the worker the newest steering batch
 * from its task inbox exactly once in its context. Any receipt or inbox failure aborts the worker.
 */
class WorkerCommunication {
  private closed = false;
  private fatalError: unknown;
  private timersStarted = false;
  private lastWriteAt = Date.now();
  private writeQueue = Promise.resolve();
  private pollInFlight = false;
  private latestContext: ExtensionContext | undefined;
  private retainedBatch: TaskMessageBatch | undefined;

  constructor(
    private readonly config: WorkerControlConfig,
    private receipt: WorkerReceipt,
    readonly trace: Trace,
  ) {}

  private get stopped(): boolean {
    return this.closed || this.fatalError !== undefined;
  }

  private fail(ctx: ExtensionContext, error: unknown): void {
    if (this.fatalError === undefined) this.fatalError = error;
    ctx.abort();
  }

  private async persist(ctx: ExtensionContext, next: WorkerReceipt, force: boolean): Promise<void> {
    if (this.closed) return;
    this.receipt = next;
    if (!force && Date.now() - this.lastWriteAt < RECEIPT_WRITE_INTERVAL_MS) return;
    const write = this.writeQueue.then(async () => {
      if (this.closed) return;
      await writeWorkerReceipt(this.config.receiptPath, this.receipt);
      this.lastWriteAt = Date.now();
    });
    this.writeQueue = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      this.fail(ctx, error);
      throw error;
    }
  }

  private async touch(
    ctx: ExtensionContext,
    activity: ReceiptActivity,
    force = false,
  ): Promise<void> {
    const touched = touchedReceipt(this.receipt, activity, readNow());
    await this.persist(ctx, touched.receipt, force || touched.changed);
  }

  /** Records activity from an OMP event; a failed receipt write aborts the worker. */
  recordActivity(ctx: ExtensionContext, phase: WorkerReceipt["phase"], tool?: string): void {
    void this.touch(ctx, { phase, tool, meaningful: true }).catch((error) => this.fail(ctx, error));
  }

  private async observeInbox(ctx: ExtensionContext): Promise<void> {
    if (this.stopped) return;
    const inbox = await inboxFor(this.config);
    this.retainInbox(inbox, undefined);
    if (inbox === undefined || inbox.revision <= this.receipt.receivedRevision) return;
    await this.persist(
      ctx,
      { ...this.receipt, receivedRevision: inbox.revision, heartbeatAt: readNow() },
      true,
    );
  }

  private async poll(ctx: ExtensionContext): Promise<void> {
    if (this.pollInFlight || this.stopped) return;
    this.pollInFlight = true;
    try {
      await this.observeInbox(ctx);
    } catch (error) {
      this.fail(ctx, error);
    } finally {
      this.pollInFlight = false;
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.latestContext === undefined || this.stopped) return;
    const { phase } = this.receipt;
    try {
      await this.touch(this.latestContext, {
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
      inboxMessageBatch(this.config.taskId, inbox),
      this.retainedBatch,
    );
  }

  private async applyContext(
    ctx: ExtensionContext,
    messages: AgentMessage[],
  ): Promise<AgentMessage[]> {
    if (this.stopped) return messages;
    const selected = newestTaskMarker(messages, this.config.taskId);
    this.retainInbox(await inboxFor(this.config), selected?.batch.revision);
    if (
      selected !== undefined &&
      (this.retainedBatch === undefined || selected.batch.revision > this.retainedBatch.revision)
    ) {
      this.retainedBatch = selected.batch;
    }
    const materialized = this.retainedBatch;
    if (materialized === undefined || materialized.revision === 0) return messages;
    const updated = contextWithTaskMessages(
      messages,
      this.config.taskId,
      materialized,
      selected !== undefined,
      Date.now(),
    );
    if (materialized.revision > this.receipt.appliedRevision) {
      await this.persist(
        ctx,
        {
          ...this.receipt,
          receivedRevision: Math.max(this.receipt.receivedRevision, materialized.revision),
          appliedRevision: materialized.revision,
          heartbeatAt: readNow(),
          progressAt: readNow(),
        },
        true,
      );
    }
    return updated;
  }

  async onContext(
    ctx: ExtensionContext,
    messages: AgentMessage[],
  ): Promise<{ messages: AgentMessage[] } | undefined> {
    try {
      return { messages: await this.applyContext(ctx, messages) };
    } catch (error) {
      this.fail(ctx, error);
      return undefined;
    }
  }

  /** Continues the session with any steering that arrived after the worker last saw its context. */
  async onSessionStop(
    ctx: ExtensionContext,
    aborted: boolean,
  ): Promise<SessionStopResult | undefined> {
    this.trace("session_stop", { aborted, closed: this.closed });
    if (this.stopped || aborted) return undefined;
    try {
      this.retainInbox(await inboxFor(this.config), this.retainedBatch?.revision);
      const pendingBatch =
        this.retainedBatch !== undefined &&
        this.retainedBatch.revision > this.receipt.appliedRevision
          ? this.retainedBatch
          : undefined;
      if (pendingBatch === undefined) {
        await this.touch(ctx, { phase: "finished", meaningful: false }, true);
        this.trace("session_stop_done", { continuing: false });
        return undefined;
      }
      this.trace("session_stop_done", { continuing: true, revision: pendingBatch.revision });
      await this.persist(
        ctx,
        {
          ...this.receipt,
          receivedRevision: Math.max(this.receipt.receivedRevision, pendingBatch.revision),
          heartbeatAt: readNow(),
          phase: "model",
        },
        true,
      );
      return {
        continue: true,
        additionalContext: formatTaskMessages(
          this.config.taskId,
          pendingBatch.revision,
          pendingBatch.messages,
        ),
      };
    } catch (error) {
      this.fail(ctx, error);
      return undefined;
    }
  }

  close(): void {
    this.closed = true;
  }

  async onSessionStart(ctx: ExtensionContext): Promise<void> {
    this.latestContext = ctx;
    if (!this.timersStarted) {
      this.timersStarted = true;
      ctx.setInterval(() => {
        const current = this.latestContext;
        if (current === undefined) return;
        void this.poll(current).catch((error) => this.fail(current, error));
      }, POLL_INTERVAL_MS);
      ctx.setInterval(() => {
        void this.heartbeat();
      }, HEARTBEAT_INTERVAL_MS);
    }
    try {
      await this.touch(ctx, { phase: "model", meaningful: true }, true);
      await this.poll(ctx);
    } catch (error) {
      this.fail(ctx, error);
    }
  }
}

async function registerWorkerCommunication(pi: ExtensionAPI): Promise<void> {
  const config = parseWorkerControlConfig(process.env[WORKER_CONTROL_ENV]);
  if (config === undefined) return;
  await inboxFor(config);
  const receipt = initialReceipt(config);
  await writeWorkerReceipt(config.receiptPath, receipt);
  const communication = new WorkerCommunication(
    config,
    receipt,
    jobTrace(process.env[WORKER_JOB_PATH_ENV]),
  );

  pi.on("context", (event, ctx) => communication.onContext(ctx, event.messages));
  pi.on("session_stop", (event, ctx) => communication.onSessionStop(ctx, event.signal.aborted));
  pi.on("session_shutdown", () => communication.close());
  pi.on("agent_start", (_event, ctx) => communication.recordActivity(ctx, "model"));
  pi.on("turn_start", (_event, ctx) => communication.recordActivity(ctx, "model"));
  pi.on("turn_end", (_event, ctx) => communication.recordActivity(ctx, "idle"));
  pi.on("message_start", (_event, ctx) => communication.recordActivity(ctx, "model"));
  pi.on("message_end", (_event, ctx) => communication.recordActivity(ctx, "model"));
  pi.on("message_update", (_event, ctx) => communication.recordActivity(ctx, "model"));
  pi.on("tool_execution_start", (event, ctx) =>
    communication.recordActivity(ctx, "tool", toolName(event.toolName)),
  );
  pi.on("tool_execution_update", (event, ctx) =>
    communication.recordActivity(ctx, "tool", toolName(event.toolName)),
  );
  pi.on("tool_execution_end", (event, ctx) =>
    communication.recordActivity(ctx, "idle", toolName(event.toolName)),
  );
  pi.on("agent_end", (event, ctx) => {
    communication.trace("communication_agent_end", { willContinue: event.willContinue });
    communication.recordActivity(ctx, event.willContinue === true ? "model" : "idle");
  });
  pi.on("session_start", (_event, ctx) => communication.onSessionStart(ctx));
}
