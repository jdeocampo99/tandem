import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { WorkerReceipt } from "../../contracts.ts";
import { WorkerSteering } from "../../session/worker-steering.ts";
import { readTaskInbox, writeWorkerReceipt } from "../../tasks/communication-persistence.ts";
import {
  parseWorkerControlConfig,
  toolName,
  WORKER_CONTROL_ENV,
} from "../../workers/control-protocol.ts";
import { traceWorkerTurn, WORKER_JOB_PATH_ENV } from "../../workers/terminal.ts";
import { contextWithTaskMessages, newestTaskMarker } from "./task-messages.ts";
import {
  OmpWorkerPane,
  registerWorkerTerminalExtension,
  SYSTEM_CLOCK,
} from "./terminal-extension.ts";

export default async function workerControlExtension(pi: ExtensionAPI): Promise<void> {
  try {
    await registerWorkerSteering(pi);
    await registerWorkerTerminalExtension(pi);
  } catch (error) {
    failClosed(pi, error);
  }
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

function jobTrace(
  jobPath: string | undefined,
): (event: string, detail?: Readonly<Record<string, unknown>>) => void {
  return (event, detail) => {
    if (jobPath !== undefined && jobPath.trim().length > 0) traceWorkerTurn(jobPath, event, detail);
  };
}

async function registerWorkerSteering(pi: ExtensionAPI): Promise<void> {
  const config = parseWorkerControlConfig(process.env[WORKER_CONTROL_ENV]);
  if (config === undefined) return;
  const pane = new OmpWorkerPane(pi);
  const trace = jobTrace(process.env[WORKER_JOB_PATH_ENV]);
  const steering = await WorkerSteering.open({
    host: pane.host,
    clock: SYSTEM_CLOCK,
    timers: pane.timers,
    config,
    readInbox: () => readTaskInbox(config.inboxPath),
    writeReceipt: (receipt) => writeWorkerReceipt(config.receiptPath, receipt),
    trace,
  });
  const record = (ctx: ExtensionContext, phase: WorkerReceipt["phase"], tool?: string) => {
    pane.enter(ctx);
    steering.recordActivity(phase, tool);
  };

  pi.on("context", async (event, ctx) => {
    pane.enter(ctx);
    const newest = newestTaskMarker(event.messages, config.taskId);
    const { taskMessages } = await steering.onContextBuild(newest?.batch);
    if (taskMessages === undefined) return undefined;
    return { messages: contextWithTaskMessages(event.messages, taskMessages, Date.now()) };
  });
  pi.on("session_stop", async (event, ctx) => {
    pane.enter(ctx);
    const { continueWith } = await steering.onStopRequested(event.signal.aborted);
    return continueWith === undefined
      ? undefined
      : { continue: true as const, additionalContext: continueWith };
  });
  pi.on("session_shutdown", () => steering.onShutdown());
  pi.on("agent_start", (_event, ctx) => record(ctx, "model"));
  pi.on("turn_start", (_event, ctx) => record(ctx, "model"));
  pi.on("turn_end", (_event, ctx) => record(ctx, "idle"));
  pi.on("message_start", (_event, ctx) => record(ctx, "model"));
  pi.on("message_end", (_event, ctx) => record(ctx, "model"));
  pi.on("message_update", (_event, ctx) => record(ctx, "model"));
  pi.on("tool_execution_start", (event, ctx) => record(ctx, "tool", toolName(event.toolName)));
  pi.on("tool_execution_update", (event, ctx) => record(ctx, "tool", toolName(event.toolName)));
  pi.on("tool_execution_end", (event, ctx) => record(ctx, "idle", toolName(event.toolName)));
  pi.on("agent_end", (event, ctx) => {
    trace("communication_agent_end", { willContinue: event.willContinue });
    record(ctx, event.willContinue === true ? "model" : "idle");
  });
  pi.on("session_start", (_event, ctx) => {
    pane.enter(ctx);
    return steering.onSessionStart();
  });
}
