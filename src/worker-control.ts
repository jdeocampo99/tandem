import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { TaskInbox, WorkerReceipt } from "./contracts.ts";
import { readTaskInbox, writeWorkerReceipt } from "./tasks/communication-persistence.ts";
import {
  formatTaskMessages,
  parseTaskMessageBatch,
  type TaskMessageBatch,
} from "./tasks/communication-protocol.ts";
import {
  collapseMessageMarkers,
  type MarkerInsertion,
  markersFromMessages,
  parseWorkerControlConfig,
  toolName,
  type WorkerControlConfig,
} from "./workers/control-protocol.ts";

export const WORKER_CONTROL_ENV = "TANDEM_WORKER_CONTROL";
const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECEIPT_WRITE_INTERVAL_MS = 1_000;

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

export default async function workerControlExtension(pi: ExtensionAPI): Promise<void> {
  const config = parseWorkerControlConfig(process.env[WORKER_CONTROL_ENV]);
  if (config === undefined) return;

  await inboxFor(config);
  let receipt = initialReceipt(config);
  await writeWorkerReceipt(config.receiptPath, receipt);

  let closed = false;
  let fatalError: unknown;
  let timersStarted = false;
  let lastWriteAt = Date.now();
  let writeQueue = Promise.resolve();
  let pollInFlight = false;
  let latestContext: ExtensionContext | undefined;
  let retainedBatch: TaskMessageBatch | undefined;

  const fail = (ctx: ExtensionContext, error: unknown): void => {
    if (fatalError === undefined) fatalError = error;
    ctx.abort();
  };

  const persist = async (
    ctx: ExtensionContext,
    next: WorkerReceipt,
    force: boolean,
  ): Promise<void> => {
    if (closed) return;
    receipt = next;
    if (!force && Date.now() - lastWriteAt < RECEIPT_WRITE_INTERVAL_MS) return;
    const write = writeQueue.then(async () => {
      if (closed) return;
      await writeWorkerReceipt(config.receiptPath, receipt);
      lastWriteAt = Date.now();
    });
    writeQueue = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      fail(ctx, error);
      throw error;
    }
  };

  const touch = async (
    ctx: ExtensionContext,
    phase: WorkerReceipt["phase"],
    tool: string | undefined,
    meaningful: boolean,
    force = false,
  ): Promise<void> => {
    const now = readNow();
    const phaseChanged = receipt.phase !== phase;
    const toolChanged = phase === "tool" && receipt.tool !== tool;
    const { tool: _previousTool, ...withoutTool } = receipt;
    await persist(
      ctx,
      {
        ...withoutTool,
        heartbeatAt: now,
        progressAt: meaningful ? now : receipt.progressAt,
        phase,
        ...(phase === "tool" && tool !== undefined ? { tool } : {}),
      },
      force || phaseChanged || toolChanged,
    );
  };
  const retainInboxBatch = (inbox: TaskInbox | undefined): void => {
    if (inbox === undefined || inbox.revision === 0 || inbox.messages.length === 0) return;
    const candidate = parseTaskMessageBatch({
      taskId: config.taskId,
      revision: inbox.revision,
      messages: inbox.messages,
    });
    if (retainedBatch === undefined || candidate.revision >= retainedBatch.revision) {
      retainedBatch = candidate;
    }
  };

  const observeInbox = async (ctx: ExtensionContext): Promise<void> => {
    if (closed || fatalError !== undefined) return;
    const inbox = await inboxFor(config);
    retainInboxBatch(inbox);
    if (inbox === undefined || inbox.revision <= receipt.receivedRevision) return;
    await persist(
      ctx,
      {
        ...receipt,
        receivedRevision: inbox.revision,
        heartbeatAt: readNow(),
      },
      true,
    );
  };

  const poll = async (ctx: ExtensionContext): Promise<void> => {
    if (pollInFlight || closed || fatalError !== undefined) return;
    pollInFlight = true;
    try {
      await observeInbox(ctx);
    } catch (error) {
      fail(ctx, error);
    } finally {
      pollInFlight = false;
    }
  };
  const heartbeat = async (): Promise<void> => {
    if (latestContext === undefined || closed || fatalError !== undefined) return;
    try {
      await touch(
        latestContext,
        receipt.phase,
        receipt.phase === "tool" ? receipt.tool : undefined,
        false,
      );
    } catch {
      // touch aborts the worker when a receipt write fails.
    }
  };
  const applyContext = async (
    ctx: ExtensionContext,
    messages: AgentMessage[],
  ): Promise<AgentMessage[]> => {
    if (closed || fatalError !== undefined) return messages;
    const markers = markersFromMessages(messages).filter(
      (marker) => marker.batch.taskId === config.taskId && marker.batch.revision > 0,
    );
    const selected =
      markers.length === 0
        ? undefined
        : markers.reduce((best, marker) =>
            marker.batch.revision > best.batch.revision ? marker : best,
          );
    const inbox = await inboxFor(config);
    const selectedBatch = selected?.batch;
    let inboxBatch: TaskMessageBatch | undefined;
    if (
      inbox !== undefined &&
      inbox.revision > 0 &&
      inbox.messages.length > 0 &&
      (selectedBatch === undefined || inbox.revision >= selectedBatch.revision)
    ) {
      inboxBatch = parseTaskMessageBatch({
        taskId: config.taskId,
        revision: inbox.revision,
        messages: inbox.messages,
      });
    }
    if (
      inboxBatch !== undefined &&
      (retainedBatch === undefined || inboxBatch.revision >= retainedBatch.revision)
    ) {
      retainedBatch = inboxBatch;
    }
    if (
      selectedBatch !== undefined &&
      (retainedBatch === undefined || selectedBatch.revision > retainedBatch.revision)
    ) {
      retainedBatch = selectedBatch;
    }
    const materialized = retainedBatch;
    if (materialized === undefined || materialized.revision === 0) return messages;
    const replacement = formatTaskMessages(
      config.taskId,
      materialized.revision,
      materialized.messages,
    );
    const insertion: MarkerInsertion = { inserted: false };
    const updated: AgentMessage[] = [];
    if (selected === undefined) {
      updated.push(...messages);
      updated.push({
        role: "user",
        content: replacement,
        synthetic: true,
        attribution: "agent",
        timestamp: Date.now(),
      } as AgentMessage);
    } else {
      for (const message of messages) {
        const collapsed = collapseMessageMarkers(message, config.taskId, replacement, insertion);
        if (collapsed.message !== undefined) updated.push(collapsed.message);
      }
      if (!insertion.inserted) {
        updated.push({
          role: "user",
          content: replacement,
          synthetic: true,
          attribution: "agent",
          timestamp: Date.now(),
        } as AgentMessage);
      }
    }
    if (materialized.revision > receipt.appliedRevision) {
      await persist(
        ctx,
        {
          ...receipt,
          receivedRevision: Math.max(receipt.receivedRevision, materialized.revision),
          appliedRevision: materialized.revision,
          heartbeatAt: readNow(),
          progressAt: readNow(),
        },
        true,
      );
    }
    return updated;
  };

  pi.on("context", async (event, ctx) => {
    try {
      return { messages: await applyContext(ctx, event.messages) };
    } catch (error) {
      fail(ctx, error);
      return undefined;
    }
  });

  pi.on("session_stop", async (event, ctx) => {
    if (closed || fatalError !== undefined || event.signal.aborted) return undefined;
    try {
      const inbox = await inboxFor(config);
      if (
        inbox !== undefined &&
        inbox.revision > 0 &&
        inbox.messages.length > 0 &&
        (retainedBatch === undefined || inbox.revision >= retainedBatch.revision)
      ) {
        retainedBatch = parseTaskMessageBatch({
          taskId: config.taskId,
          revision: inbox.revision,
          messages: inbox.messages,
        });
      }
      const pendingBatch =
        retainedBatch !== undefined && retainedBatch.revision > receipt.appliedRevision
          ? retainedBatch
          : undefined;
      if (pendingBatch === undefined) {
        await touch(ctx, "finished", undefined, false, true);
        return undefined;
      }
      await persist(
        ctx,
        {
          ...receipt,
          receivedRevision: Math.max(receipt.receivedRevision, pendingBatch.revision),
          heartbeatAt: readNow(),
          phase: "model",
        },
        true,
      );
      return {
        continue: true,
        additionalContext: formatTaskMessages(
          config.taskId,
          pendingBatch.revision,
          pendingBatch.messages,
        ),
      };
    } catch (error) {
      fail(ctx, error);
      return undefined;
    }
  });

  pi.on("session_shutdown", () => {
    closed = true;
  });

  pi.on("agent_start", (_event, ctx) => {
    void touch(ctx, "model", undefined, true).catch((error) => fail(ctx, error));
  });
  pi.on("turn_start", (_event, ctx) => {
    void touch(ctx, "model", undefined, true).catch((error) => fail(ctx, error));
  });
  pi.on("turn_end", (_event, ctx) => {
    void touch(ctx, "idle", undefined, true).catch((error) => fail(ctx, error));
  });
  pi.on("message_start", (_event, ctx) => {
    void touch(ctx, "model", undefined, true).catch((error) => fail(ctx, error));
  });
  pi.on("message_end", (_event, ctx) => {
    void touch(ctx, "model", undefined, true).catch((error) => fail(ctx, error));
  });
  pi.on("message_update", (_event, ctx) => {
    void touch(ctx, "model", undefined, true).catch((error) => fail(ctx, error));
  });
  pi.on("tool_execution_start", (event, ctx) => {
    void touch(ctx, "tool", toolName(event.toolName), true).catch((error) => fail(ctx, error));
  });
  pi.on("tool_execution_update", (event, ctx) => {
    void touch(ctx, "tool", toolName(event.toolName), true).catch((error) => fail(ctx, error));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    void touch(ctx, "idle", toolName(event.toolName), true).catch((error) => fail(ctx, error));
  });
  pi.on("agent_end", (event, ctx) => {
    void touch(ctx, event.willContinue === true ? "model" : "idle", undefined, true).catch(
      (error) => fail(ctx, error),
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    if (!timersStarted) {
      timersStarted = true;
      ctx.setInterval(() => {
        const current = latestContext;
        if (current === undefined) return;
        void poll(current).catch((error) => fail(current, error));
      }, POLL_INTERVAL_MS);
      ctx.setInterval(() => {
        void heartbeat();
      }, HEARTBEAT_INTERVAL_MS);
    }
    try {
      await touch(ctx, "model", undefined, true, true);
      await poll(ctx);
    } catch (error) {
      fail(ctx, error);
    }
  });
}
