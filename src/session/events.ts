import type { HerdrStatusReporter } from "../adapters/herdr-status.ts";
import type { CatchUpView } from "../memory/workstream.ts";
import type { TodoItem } from "../playbooks/progress.ts";
import type { TaskMessageBatch } from "../tasks/communication-protocol.ts";
import type { ReplyUsage } from "../workers/terminal.ts";

/** What the running harness can do. The core checks these, never the harness name. */
export type Capabilities = Readonly<{
  /** The `compact` effect exists; otherwise early compaction is off. */
  proactiveCompaction: boolean;
  /** `deliver.hidden` reaches the model unseen (OMP display:false, Claude Code channel meta). */
  hiddenMessages: boolean;
  /** `streaming` events arrive; otherwise the stall watchdog is off. */
  streamingProgress: boolean;
  /** `host.confirm` can show a dialog; otherwise approval fails closed. */
  perActionApproval: boolean;
}>;

/** Adapters map native tool names to these kinds; the core never sees "read", "Bash", or "xd://". */
export type ToolKind =
  | "read"
  | "search"
  | "web-search"
  | "write"
  | "edit"
  | "shell"
  | "mcp"
  | "ask"
  | "subagent"
  | "copy-asset"
  | "todo"
  | "research-follow-up"
  | "other";

export type ToolCall = Readonly<{
  id: string;
  /** The native name, for traces and receipts only. */
  name: string;
  kind: ToolKind;
  path?: string;
  command?: string;
  /** For kind "mcp": the native tool id, matched against host.mcpToolPrefix(server). */
  mcpTool?: string;
}>;

export type UsageCounts = Omit<ReplyUsage, "provider" | "model">;

export type SessionEvent =
  | Readonly<{ type: "sessionStart" }>
  | Readonly<{ type: "userPrompt"; text: string; interactive: boolean; attachments: number }>
  | Readonly<{ type: "agentStart" }>
  | Readonly<{ type: "turnStart" }>
  | Readonly<{ type: "streaming" }>
  | Readonly<{ type: "toolCall"; call: ToolCall }>
  | Readonly<{ type: "toolStart"; call: ToolCall }>
  | Readonly<{
      type: "toolEnd";
      call: ToolCall;
      subagentUsage?: UsageCounts;
      /** For kind "todo": the worker's to-do list as the call left it. */
      todos?: readonly TodoItem[];
    }>
  | Readonly<{ type: "turnEnd"; usage?: ReplyUsage }>
  | Readonly<{ type: "agentEnd"; willContinue: boolean; interrupted: boolean; failure?: string }>
  | Readonly<{
      type: "contextBuild";
      newestTaskMessages?: TaskMessageBatch;
      backgroundResultWake: boolean;
    }>
  | Readonly<{ type: "stopRequested"; aborted: boolean }>
  | Readonly<{ type: "compacting" }>
  | Readonly<{ type: "compacted" }>
  | Readonly<{ type: "shutdown" }>;

export type ToolDecision = Readonly<{ block: false } | { block: true; reason: string }>;

export type TaskMessagesPlacement = Readonly<{
  taskId: string;
  batch: TaskMessageBatch;
  replaceExisting: boolean;
}>;

/** The answer a hook must return synchronously with its event. */
export type ReplyFor<E extends SessionEvent> = E extends { type: "toolCall" }
  ? ToolDecision
  : E extends { type: "userPrompt" }
    ? Readonly<{ handled: boolean }>
    : E extends { type: "agentStart" }
      ? Readonly<{ systemContext: readonly string[] }>
      : E extends { type: "contextBuild" }
        ? Readonly<{ taskMessages?: TaskMessagesPlacement }>
        : E extends { type: "stopRequested" }
          ? Readonly<{ continueWith?: string }>
          : E extends { type: "compacting" }
            ? Readonly<{
                context: readonly string[];
                preserve: Readonly<Record<string, unknown>>;
              }>
            : undefined;

export type SessionEffect =
  | Readonly<{
      type: "deliver";
      source: "notification" | "prompt-route" | "stall-reminder";
      text: string;
      /** Delivered before `text`, never shown to the user. OMP sends it as a separate display:false message. */
      hidden?: Readonly<{ text: string; details?: unknown }>;
      details?: Readonly<Record<string, unknown>>;
      timing: "followUp" | "nextTurn" | "aside";
      triggerTurn: boolean;
    }>
  | Readonly<{
      /**
       * A workstream's catch-up card as its own chat message, drawn in color where the host can.
       * `text` is the same card without color, for the model and for hosts that only show text.
       */
      type: "showCard";
      view: CatchUpView;
      text: string;
    }>
  | Readonly<{ type: "promptAsUser"; text: string; deliverAs?: "aside" }>
  | Readonly<{ type: "notify"; text: string; level: "info" | "error" }>
  | Readonly<{
      type: "recordEntry";
      entryType: "tandem-digest" | "tandem-notification";
      data: unknown;
    }>
  | Readonly<{ type: "compact" }>
  | Readonly<{ type: "abort" }>
  | Readonly<{ type: "shutdown" }>;

export type ToolOutcome = Readonly<{ text: string; isError: boolean; details?: unknown }>;

export interface SessionHost {
  readonly capabilities: Capabilities;
  /** Awaited by the core, except `compact`, which re-enters the session. */
  perform(effect: SessionEffect): Promise<void>;
  /** False when nobody can answer, so approval fails closed. */
  confirm(title: string, message: string): Promise<boolean>;
  contextTokens(): number | undefined;
  paneState(): Readonly<{ idle: boolean; pendingMessages: boolean; draft: boolean }>;
  /** Throws WorkerOutputError when the running model is not `selector`. */
  assertSelectedModel(selector: string): void;
  mcpToolPrefix(server: string): string;
}

export type Cancel = () => void;

/** What every session role receives at the adapter boundary; role deps extend it. */
export type SessionDeps = Readonly<{
  host: SessionHost;
  clock: Readonly<{ now(): number; monotonic(): number }>;
  timers: Readonly<{
    every(ms: number, run: () => void): Cancel;
    after(ms: number, run: () => void): Cancel;
  }>;
  status: HerdrStatusReporter | undefined;
  logError(message: string, error: unknown): void;
}>;
