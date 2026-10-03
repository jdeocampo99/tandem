import type { SessionDeps, ToolCall, ToolOutcome } from "../../session/events.ts";
import { copyAssetSchema, submitReportSchema } from "../../session/tools.ts";
import type { WorkerSession } from "../../session/worker.ts";
import type { WorkerSteering } from "../../session/worker-steering.ts";
import type { WorkerJob } from "../../workers/jobs.ts";
import { COPY_ASSET_TOOL, SUBMIT_REPORT_TOOL } from "../../workers/terminal.ts";
import {
  jobTrace,
  openWorkerSteering,
  readWorkerJob,
  type WorkerTrace,
  workerSession,
} from "../worker-session.ts";
import type { SessionBinding, SessionHookEvent } from "./coordinator.ts";
import {
  type ClaudeCodePane,
  claudeCodeMcpToolPrefix,
  claudeCodeTodos,
  claudeCodeToolCall,
  claudeCodeUsage,
} from "./host.ts";
import type { HookReply, SidecarEvent } from "./plugins/tandem/hooks/protocol.ts";
import { workerTools } from "./tool-specs.ts";

const DONE: HookReply = { type: "done" };

/** The parts a worker binding drives; production builds them from the job's files. */
export type WorkerParts = Readonly<{
  job: WorkerJob;
  session: WorkerSession;
  steering: WorkerSteering | undefined;
  trace: WorkerTrace;
}>;

type PluginToolEvent = Extract<SidecarEvent, { type: "pluginTool" }>;

function toolResult(outcome: ToolOutcome): HookReply {
  return { type: "toolResult", text: outcome.text, isError: outcome.isError };
}

function inputRecord(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * The model ran its own tool: `submit_report`, or a scout's `copy_asset`. The worker's guard sees
 * it first, as OMP's `tool_call` does, so a settled worker cannot report twice.
 */
async function runPluginTool(parts: WorkerParts, event: PluginToolEvent): Promise<HookReply> {
  const { job, session } = parts;
  const call: ToolCall = claudeCodeToolCall({
    id: event.id,
    name: `${claudeCodeMcpToolPrefix("tandem")}${event.name}`,
    input: inputRecord(event.input),
  });
  const decision = session.guardToolCall(call);
  if (decision.block) return { type: "toolResult", text: decision.reason, isError: true };
  session.onToolStart(call);
  try {
    if (event.name === SUBMIT_REPORT_TOOL) {
      const report = submitReportSchema(job.role).safeParse(event.input);
      if (!report.success) return { type: "toolResult", text: report.error.message, isError: true };
      return toolResult(await session.submitReport(report.data));
    }
    if (event.name === COPY_ASSET_TOOL && job.role === "scout") {
      const asset = copyAssetSchema.safeParse(event.input);
      if (!asset.success) return { type: "toolResult", text: asset.error.message, isError: true };
      return toolResult(await session.copyAsset(asset.data.from, asset.data.name));
    }
    return { type: "toolResult", text: `no tool named ${event.name}`, isError: true };
  } finally {
    session.onToolEnd({ call });
  }
}

/**
 * A worker's `WorkerSession` and `WorkerSteering` driven by Claude Code events, mirroring the OMP
 * worker extension in src/harness/omp/terminal-extension.ts and worker-control.ts. Steering
 * reaches the model as new text (see `SteeringDelivery`), since Claude Code cannot rewrite the
 * conversation.
 */
export function claudeCodeWorker(pane: ClaudeCodePane, parts: WorkerParts): SessionBinding {
  const { job, session, steering, trace } = parts;

  async function handle(event: SessionHookEvent): Promise<HookReply> {
    pane.observe(event);
    switch (event.type) {
      case "sessionStart":
        await steering?.onSessionStart();
        await session.onSessionStart();
        return DONE;
      case "userPrompt":
        // Tandem's brief, given as Claude Code's first prompt, is not the person at the pane.
        if (event.interactive && !event.text.startsWith(job.prompt)) session.onHumanInput();
        return { type: "promptRoute", handled: false };
      case "agentStart":
        session.onAgentStart();
        steering?.recordActivity("model");
        if (event.prompt !== undefined) await steering?.onPromptSeen(event.prompt);
        return { type: "turnContext", system: [], context: pane.takeNextTurn() };
      case "turnStart":
        session.onTurnStart();
        steering?.recordActivity("model");
        return DONE;
      case "streaming":
        session.onStreaming();
        return DONE;
      case "toolCall": {
        const decision = session.guardToolCall(claudeCodeToolCall(event.call));
        return decision.block
          ? { type: "toolDecision", block: true, reason: decision.reason }
          : { type: "toolDecision", block: false };
      }
      case "pluginTool":
        return runPluginTool(parts, event);
      case "toolStart": {
        const call = claudeCodeToolCall(event.call);
        session.onToolStart(call);
        steering?.recordActivity("tool", call.name);
        return DONE;
      }
      case "toolEnd": {
        const call = claudeCodeToolCall(event.call);
        const todos = claudeCodeTodos(event.call);
        session.onToolEnd({ call, ...(todos === undefined ? {} : { todos }) });
        steering?.recordActivity("idle", call.name);
        const steer = await steering?.takePending();
        return { type: "toolContext", context: steer === undefined ? [] : [steer] };
      }
      case "turnEnd":
        session.onTurnEnd(event.usage === undefined ? undefined : claudeCodeUsage(event.usage));
        steering?.recordActivity("idle");
        return DONE;
      case "agentEnd":
        trace("communication_agent_end", { willContinue: false });
        steering?.recordActivity("idle");
        await session.onAgentEnd({
          willContinue: false,
          interrupted: event.interrupted,
          ...(event.failure === undefined ? {} : { failure: event.failure }),
        });
        return DONE;
      case "stopRequested": {
        const { continueWith } = (await steering?.onStopRequested(event.aborted)) ?? {};
        return continueWith === undefined ? { type: "stop" } : { type: "stop", continueWith };
      }
      // While the pane closes, only Claude Code's exit keys may reach it, as on OMP.
      case "promptEdit":
        return { type: "editDecision", allowed: !session.closing };
      case "compacting":
        return { type: "compaction", instructions: "" };
      case "compacted":
        return DONE;
    }
  }

  return {
    tools: workerTools(job.role),
    handle,
    shutdown: async () => {
      steering?.onShutdown();
      await session.onShutdown();
    },
  };
}

/** Opens the job at `jobPath` and its steering, and writes the worker's starting state. */
export async function openClaudeCodeWorker(
  pane: ClaudeCodePane,
  jobPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  timers: SessionDeps["timers"],
): Promise<SessionBinding> {
  const job = await readWorkerJob(jobPath);
  const trace = jobTrace(jobPath);
  const harness = { host: pane.host, timers, transcript: () => undefined };
  const session = workerSession(job, jobPath, harness);
  const steering = await openWorkerSteering(environment, {
    ...harness,
    trace,
    delivery: "messages",
  });
  await session.start();
  return claudeCodeWorker(pane, { job, session, steering, trace });
}
