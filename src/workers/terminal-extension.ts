import { copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { runCommand } from "../adapters/commands.ts";
import { createHerdrStatusReporter } from "../adapters/herdr-status.ts";
import { ompToolParameters } from "../adapters/omp-tool-schema.ts";
import { todoItems } from "../playbooks/progress.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import type {
  SessionDeps,
  SessionEffect,
  ToolCall,
  ToolKind,
  ToolOutcome,
  UsageCounts,
} from "../session/events.ts";
import {
  copyAssetSchema,
  submitReportSchema,
  submitResearchFollowUpSchema,
} from "../session/tools.ts";
import { type WorkerHost, WorkerSession } from "../session/worker.ts";
import { readWorkerReceipt } from "../tasks/communication-persistence.ts";
import type { TranscriptRef } from "../tasks/timeline.ts";
import { parseWorkerJob, persistWorkerResult, type WorkerJob } from "./jobs.ts";
import {
  assertSelectedModel,
  expectedModelParts,
  nativeAgentEndAborted,
  nativeAgentEndFailure,
} from "./protocol.ts";
import {
  COPY_ASSET_TOOL,
  readWorkerTerminalCommand,
  replyUsage,
  SUBMIT_REPORT_TOOL,
  taskUsage,
  traceWorkerTurn,
  WORKER_JOB_PATH_ENV,
  WORKER_RESEARCH_FOLLOW_UP_TOOL,
  writeWorkerTerminal,
  writeWorkerTokenTally,
} from "./terminal.ts";

/** The wall and monotonic clocks a worker session runs on. */
export const SYSTEM_CLOCK: SessionDeps["clock"] = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

/**
 * OMP wakes an idle agent with an `async-result` message when a backgrounded command finishes.
 * After the report is submitted that wake would hold the pane busy for nothing, while a person
 * typing or a Tandem inbox update (appended as a synthetic message) is still a real request.
 */
export function isBackgroundResultWake(messages: readonly AgentMessage[]): boolean {
  const latest = messages.findLast((message) => !("synthetic" in message && message.synthetic));
  return (
    latest !== undefined &&
    latest.role === "custom" &&
    "customType" in latest &&
    latest.customType === "async-result"
  );
}

const OMP_TOOL_KINDS: ReadonlyMap<string, ToolKind> = new Map([
  ["read", "read"],
  ["grep", "search"],
  ["glob", "search"],
  ["web_search", "web-search"],
  ["write", "write"],
  ["edit", "edit"],
  ["bash", "shell"],
  ["ask", "ask"],
  ["task", "subagent"],
  ["todo", "todo"],
  [COPY_ASSET_TOOL, "copy-asset"],
  [WORKER_RESEARCH_FOLLOW_UP_TOOL, "research-follow-up"],
]);

/** A worker's OMP tool call as the kinds its guards match on. */
export function ompWorkerToolCall(toolCallId: string, toolName: string, input?: unknown): ToolCall {
  const kind = OMP_TOOL_KINDS.get(toolName) ?? (toolName.startsWith("mcp__") ? "mcp" : "other");
  const args =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return {
    id: toolCallId,
    name: toolName,
    kind,
    ...(typeof args.path === "string" ? { path: args.path } : {}),
    ...(typeof args.command === "string" ? { command: args.command } : {}),
    ...(kind === "mcp" ? { mcpTool: toolName } : {}),
  };
}

/**
 * A worker session's host on OMP: effects, pane queries, and timers act on the ExtensionContext
 * the latest OMP handler ran with, which each handler records with `enter`.
 */
export class OmpWorkerPane {
  private context: ExtensionContext | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  enter(ctx: ExtensionContext): void {
    this.context = ctx;
  }

  readonly host: WorkerHost = {
    perform: async (effect) => this.perform(effect),
    paneState: () => {
      const ctx = this.current();
      return {
        idle: ctx.isIdle(),
        pendingMessages: ctx.hasPendingMessages(),
        draft: ctx.ui.getEditorText().trim().length > 0,
      };
    },
    assertSelectedModel: (selector) =>
      assertSelectedModel(expectedModelParts(selector), this.current().model),
  };

  readonly timers: SessionDeps["timers"] = {
    every: (ms, run) => {
      const ctx = this.current();
      const timer = ctx.setInterval(run, ms);
      return () => ctx.clearTimer(timer);
    },
    after: (ms, run) => {
      const ctx = this.current();
      const timer = ctx.setTimeout(run, ms);
      return () => ctx.clearTimer(timer);
    },
  };

  /** The conversation entry the worker is at now, when OMP keeps a transcript for it. */
  transcript(): TranscriptRef | undefined {
    const sessions = this.current().sessionManager;
    const file = sessions.getSessionFile();
    const entryId = sessions.getLeafId();
    return file === undefined || entryId === null ? undefined : { file, entryId };
  }

  private current(): ExtensionContext {
    if (this.context === undefined) throw new Error("no OMP context has reached the worker yet");
    return this.context;
  }

  private perform(effect: SessionEffect): void {
    switch (effect.type) {
      case "abort":
        this.current().abort();
        return;
      case "promptAsUser":
        this.pi.sendUserMessage(
          effect.text,
          effect.deliverAs === "aside" ? { deliverAs: "aside" } : undefined,
        );
        return;
      case "deliver":
        if (effect.hidden !== undefined) throw new Error("a worker pane has no hidden messages");
        this.pi.sendMessage(
          {
            customType: `tandem-${effect.source}`,
            content: effect.text,
            display: true,
            attribution: "agent",
          },
          { deliverAs: effect.timing, triggerTurn: effect.triggerTurn },
        );
        return;
      default:
        throw new Error(`a worker pane cannot perform ${effect.type}`);
    }
  }
}

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Copies one file from the scout's checkout next to its mockup, byte for byte. */
export async function copyMockupAsset(
  input: Readonly<{ cwd: string; artifactDir: string; from: string; name: string }>,
): Promise<string> {
  if (!ASSET_NAME.test(input.name)) {
    throw new Error("name must be a plain file name such as jr-thinking.webp");
  }
  const [root, source] = await Promise.all([
    realpath(input.cwd),
    realpath(resolve(input.cwd, input.from)),
  ]);
  if (!isWithin(root, source))
    throw new Error("from must be a file inside the repository checkout");
  const entry = await lstat(source);
  if (!entry.isFile()) throw new Error("from must be a regular file");
  if (entry.size > MAX_ASSET_BYTES) throw new Error("from is larger than 20 MB");
  const target = resolve(input.artifactDir, input.name);
  if (basename(target) !== input.name) throw new Error("name must be a plain file name");
  await copyFile(source, target);
  return target;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function readJob(path: string): Promise<WorkerJob> {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  return parseWorkerJob(value);
}

/**
 * The worktree's `git status --porcelain=v1` output, or undefined when git cannot report it. The
 * settle-time checkpoint check stays authoritative, so an unreadable status never blocks a report.
 */
async function worktreeStatus(cwd: string): Promise<string | undefined> {
  try {
    const result = await runCommand({
      argv: ["git", "-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    });
    return result.code === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The usage all subagents of one OMP `task` call reported, without a provider or model. */
function subagentUsage(result: unknown): UsageCounts | undefined {
  const usage = taskUsage(result, undefined);
  if (usage === undefined) return undefined;
  const { provider: _provider, model: _model, ...counts } = usage;
  return counts;
}

/** Why a settled agent_end fails the job before any report arrives, if it does. */
function agentEndFailure(event: unknown, job: WorkerJob): string | undefined {
  try {
    return nativeAgentEndFailure(event, expectedModelParts(job.model.model));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function ompToolResult(outcome: ToolOutcome): {
  content: { type: "text"; text: string }[];
  details: undefined;
  isError?: true;
} {
  return {
    content: [{ type: "text", text: outcome.text }],
    details: undefined,
    ...(outcome.isError ? { isError: true as const } : {}),
  };
}

/**
 * Jobs whose worker copy this process already loaded. OMP loads a fresh copy of this extension into
 * each subagent, in the same process and with the same job; the first copy is the worker's.
 */
const loadedJobs = new Set<string>();

export async function registerWorkerTerminalExtension(pi: ExtensionAPI): Promise<void> {
  const jobPath = process.env[WORKER_JOB_PATH_ENV];
  if (jobPath === undefined || jobPath.trim().length === 0) return;
  const subagent = loadedJobs.has(jobPath);
  loadedJobs.add(jobPath);
  const job = await readJob(jobPath);
  const pane = new OmpWorkerPane(pi);
  const trace = (event: string, detail?: Readonly<Record<string, unknown>>) =>
    traceWorkerTurn(jobPath, event, detail);
  const session = new WorkerSession({
    host: pane.host,
    clock: SYSTEM_CLOCK,
    timers: pane.timers,
    status: createHerdrStatusReporter(runCommand, {
      cwd: job.cwd,
      agentLabel: `tandem-${job.role}-${job.taskId.slice(0, 8)}`,
    }),
    job,
    pid: process.pid,
    terminal: {
      readCommand: () => readWorkerTerminalCommand(jobPath, job),
      writeState: (state) => writeWorkerTerminal(jobPath, state),
      writeTokenTally: (tally) => writeWorkerTokenTally(jobPath, tally),
    },
    submitResearchFollowUp: ({ decisionId, resultPath, answer }) =>
      writeJsonAtomically(resultPath, { schemaVersion: 1, decisionId, answer }),
    persistResult: (result) => {
      const transcript = pane.transcript();
      return persistWorkerResult(
        job.resultPath,
        transcript === undefined ? result : { ...result, transcript },
      );
    },
    readReceipt: (receiptPath) =>
      readWorkerReceipt(receiptPath, {
        jobId: job.id,
        taskId: job.taskId,
        generation: job.generation,
      }),
    gitStatus: worktreeStatus,
    readFile: (path) => readFile(path, "utf8"),
    copyAsset: copyMockupAsset,
    trace,
  });
  if (subagent) {
    // A subagent keeps the worker's role limits but never drives the job: its turns, idle time,
    // model, and reports are not the worker's.
    pi.on("tool_call", (event) => {
      const decision = session.guardToolCall(
        ompWorkerToolCall(event.toolCallId, event.toolName, event.input),
      );
      return decision.block ? decision : undefined;
    });
    return;
  }
  await session.start();

  const reportSchema = submitReportSchema(job.role);
  pi.registerTool({
    name: SUBMIT_REPORT_TOOL,
    label: "Submit report",
    description:
      "Submit your final report to the Tandem coordinator once the delegated work is done. Only this call delivers the report; ordinary replies are conversation. A rejected submission explains what to fix; correct it and call again.",
    parameters: ompToolParameters(reportSchema),
    strict: true,
    loadMode: "essential",
    approval: "read",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      pane.enter(ctx);
      return ompToolResult(await session.submitReport(reportSchema.parse(params)));
    },
  });

  if (job.role === "scout") {
    pi.registerTool({
      name: COPY_ASSET_TOOL,
      label: "Copy asset",
      description:
        "Copy an image, font, or other file from the repository checkout into the mockup folder, byte for byte, so the mockup can load it by relative path (for example ./jr-thinking.webp). Only works while drawing a mockup.",
      parameters: ompToolParameters(copyAssetSchema),
      strict: true,
      approval: "read",
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        pane.enter(ctx);
        const { from, name } = copyAssetSchema.parse(params);
        return ompToolResult(await session.copyAsset(from, name));
      },
    });
  }
  if (job.role === "scout") {
    pi.registerTool({
      name: WORKER_RESEARCH_FOLLOW_UP_TOOL,
      label: "Submit research follow-up",
      description:
        "Submit the answer to the coordinator's focused research question, using the completed report and read-only inspection. Do not modify repository files.",
      parameters: ompToolParameters(submitResearchFollowUpSchema),
      strict: true,
      approval: "read",
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        pane.enter(ctx);
        const { answer } = submitResearchFollowUpSchema.parse(params);
        return ompToolResult(await session.submitResearchFollowUp(answer));
      },
    });
  }
  pi.on("tool_call", (event, ctx) => {
    pane.enter(ctx);
    const decision = session.guardToolCall(
      ompWorkerToolCall(event.toolCallId, event.toolName, event.input),
    );
    return decision.block ? decision : undefined;
  });
  pi.on("session_start", async (_event, ctx) => {
    pane.enter(ctx);
    // Freeze an empty editor before the controller sends the native exit key.
    // ctx.shutdown() alone does not wake OMP's idle interactive input loop.
    ctx.ui.onTerminalInput((data) =>
      session.closing && !matchesKey(data, "ctrl+d") ? { consume: true } : undefined,
    );
    await session.onSessionStart();
  });
  pi.on("input", (event) => {
    if (event.source === "interactive") session.onHumanInput();
  });
  pi.on("agent_start", (_event, ctx) => {
    pane.enter(ctx);
    session.onAgentStart();
  });
  pi.on("turn_start", (_event, ctx) => {
    pane.enter(ctx);
    session.onTurnStart();
  });
  pi.on("message_update", () => session.onStreaming());
  pi.on("tool_execution_start", (event, ctx) => {
    pane.enter(ctx);
    session.onToolStart(ompWorkerToolCall(event.toolCallId, event.toolName));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    pane.enter(ctx);
    const call = ompWorkerToolCall(event.toolCallId, event.toolName);
    const usage = call.kind === "subagent" ? subagentUsage(event.result) : undefined;
    const todos = call.kind === "todo" ? todoItems(event.result) : undefined;
    session.onToolEnd({
      call,
      ...(usage === undefined ? {} : { subagentUsage: usage }),
      ...(todos === undefined ? {} : { todos }),
    });
  });
  pi.on("turn_end", (event, ctx) => {
    pane.enter(ctx);
    session.onTurnEnd(replyUsage(event.message));
  });
  pi.on("context", (event, ctx) => {
    pane.enter(ctx);
    trace("context", { messages: event.messages.length, latest: event.messages.at(-1)?.role });
    session.onContextBuild(isBackgroundResultWake(event.messages));
  });
  pi.on("agent_end", (event, ctx) => {
    pane.enter(ctx);
    const failure = agentEndFailure(event, job);
    return session.onAgentEnd({
      willContinue: event.willContinue === true,
      interrupted: nativeAgentEndAborted(event),
      ...(failure === undefined ? {} : { failure }),
    });
  });
  pi.on("session_shutdown", () => session.onShutdown());
}
