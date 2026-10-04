import type { TodoItem } from "../../playbooks/progress.ts";
import type { SessionEffect, SessionHost, ToolCall, ToolKind } from "../../session/events.ts";
import { WorkerOutputError } from "../../workers/protocol.ts";
import { COPY_ASSET_TOOL, type ReplyUsage, SUBMIT_REPORT_TOOL } from "../../workers/terminal.ts";
import { CLAUDE_CODE_PROVIDER } from "./models.ts";
import type {
  SidecarEvent,
  SidecarLine,
  WireToolCall,
  WireUsage,
} from "./plugins/tandem/hooks/protocol.ts";

/** What one core effect becomes on Claude Code. */
export type ClaudeCodeEffect = Readonly<{
  /** Written to stdout for the mod to carry out, in order. */
  lines: readonly SidecarLine[];
  /** Held for the model and sent with the next turn's `prompt.context`. */
  nextTurn?: string;
}>;

/** Claude Code cannot do these; each refusal says why, so the core's caller fails closed. */
export const UNSUPPORTED_EFFECTS = {
  shutdown:
    "Claude Code gives a mod no way to end its session; Herdr closes a Tandem pane instead.",
} as const;

function withHidden(hidden: string | undefined, text: string): string {
  return hidden === undefined ? text : `${hidden}\n\n${text}`;
}

/**
 * The decision table from core effects to mod effects. Claude Code cannot place a message into a
 * running turn or after a tool block, so every `timing` lands the same way: a delivery that wakes
 * the model is submitted (it starts a turn once the session is idle), and one that does not is
 * shown now and handed to the model with its next turn. The hidden part goes only to the model;
 * Tandem's renderer plugin hides the submitted row, so the person sees the shown part once.
 */
export function claudeCodeEffect(effect: SessionEffect): ClaudeCodeEffect {
  switch (effect.type) {
    case "deliver": {
      const forModel = withHidden(effect.hidden?.text, effect.text);
      return effect.triggerTurn
        ? {
            lines: [
              { type: "log", text: effect.text },
              { type: "submit", text: forModel },
            ],
          }
        : { lines: [{ type: "log", text: effect.text }], nextTurn: forModel };
    }
    case "showCard":
      return { lines: [{ type: "log", text: effect.text }] };
    case "showStatus":
      return effect.triggerTurn
        ? {
            lines: [
              { type: "log", text: effect.text },
              { type: "submit", text: effect.text },
            ],
          }
        : { lines: [{ type: "log", text: effect.text }] };
    case "promptAsUser":
      return { lines: [{ type: "submit", text: effect.text }] };
    case "notify":
      return { lines: [{ type: "toast", text: effect.text, level: effect.level }] };
    // OMP saves these entries in its session file for later inspection; nothing in Tandem reads
    // them back, and Claude Code gives a mod no session entries, so the store stays the record.
    case "recordEntry":
      return { lines: [] };
    case "compact":
      return { lines: [{ type: "compact" }] };
    case "abort":
      return { lines: [{ type: "abort" }] };
    case "shutdown":
      throw new Error(UNSUPPORTED_EFFECTS.shutdown);
  }
}

const CLAUDE_CODE_TOOL_KINDS: ReadonlyMap<string, ToolKind> = new Map([
  ["Read", "read"],
  ["NotebookRead", "read"],
  ["WebFetch", "read"],
  ["Grep", "search"],
  ["Glob", "search"],
  ["LS", "search"],
  ["WebSearch", "web-search"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["NotebookEdit", "edit"],
  ["Bash", "shell"],
  ["AskUserQuestion", "ask"],
  ["Task", "subagent"],
  ["Agent", "subagent"],
  ["TaskCreate", "todo"],
  ["TaskUpdate", "todo"],
  ["TaskList", "todo"],
  ["TaskGet", "todo"],
  [`${claudeCodeMcpToolPrefix("tandem")}${COPY_ASSET_TOOL}`, "copy-asset"],
  [`${claudeCodeMcpToolPrefix("tandem")}${SUBMIT_REPORT_TOOL}`, "other"],
]);

function inputText(input: WireToolCall["input"], key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * A Claude Code tool call as the kinds the core's guards match on. A web fetch is a read of its
 * URL, as OMP's `read` of a URL is, so the coordinator's web-read guard applies to it.
 */
export function claudeCodeToolCall(call: WireToolCall): ToolCall {
  const kind =
    CLAUDE_CODE_TOOL_KINDS.get(call.name) ?? (call.name.startsWith("mcp__") ? "mcp" : "other");
  const path =
    inputText(call.input, "file_path") ??
    inputText(call.input, "notebook_path") ??
    inputText(call.input, "url") ??
    inputText(call.input, "path");
  const command = inputText(call.input, "command");
  return {
    id: call.id,
    name: call.name,
    kind,
    ...(path === undefined ? {} : { path }),
    ...(command === undefined ? {} : { command }),
    ...(kind === "mcp" ? { mcpTool: call.name } : {}),
  };
}

/** Claude Code names an MCP tool `mcp__<server>__<tool>`. */
export function claudeCodeMcpToolPrefix(server: string): string {
  return `mcp__${server}__`;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * The worker's to-do list, built up from Claude Code's task tools: `TaskCreate` adds an item
 * (its id is in the result) and `TaskUpdate` changes one. Deleting an item is how a worker drops
 * a step that does not apply, so it reads as OMP's `abandoned`.
 */
export class ClaudeCodeTodoList {
  private readonly items = new Map<string, { content: string; status: string }>();

  /** The list after this call, or undefined when the call is not a to-do change. */
  apply(call: WireToolCall, result: unknown): readonly TodoItem[] | undefined {
    if (call.name === "TaskCreate") {
      const id = record(record(result)?.task)?.id;
      const subject = call.input.subject;
      if (typeof id !== "string" || typeof subject !== "string") return undefined;
      this.items.set(id, { content: subject, status: "pending" });
      return this.list();
    }
    if (call.name !== "TaskUpdate") return undefined;
    const item = this.items.get(String(call.input.taskId));
    if (item === undefined) return undefined;
    const { subject, status } = call.input;
    if (typeof subject === "string") item.content = subject;
    if (typeof status === "string") item.status = status === "deleted" ? "abandoned" : status;
    return this.list();
  }

  private list(): readonly TodoItem[] {
    return [...this.items.values()].map((item) => ({ ...item }));
  }
}

export function claudeCodeUsage(usage: WireUsage): ReplyUsage {
  const { model, ...counts } = usage;
  return { provider: CLAUDE_CODE_PROVIDER, model, ...counts };
}

/**
 * Whether Claude Code's reported model id is the one a `claude-code/<alias>` selector names.
 * Claude Code reports ids such as `claude-opus-5-5`, so the alias must be one of its words.
 */
export function runsSelectedModel(selector: string, reported: string | undefined): boolean {
  const prefix = `${CLAUDE_CODE_PROVIDER}/`;
  if (reported === undefined || !selector.startsWith(prefix)) return false;
  const alias = selector.slice(prefix.length);
  return reported === alias || reported.split("-").includes(alias);
}

export type PaneDeps = Readonly<{
  write(line: SidecarLine): void;
  /** Claude Code was started with a prompt, which it runs before anything Tandem submits. */
  startsWithPrompt?: boolean;
  /** Asks inside the hook being answered; false when no hook is waiting. */
  confirm(title: string, message: string): Promise<boolean>;
}>;

/**
 * The Claude Code session as the sidecar sees it: what the mod has reported, and the core's
 * `SessionHost`, whose effects become stdout lines.
 */
export class ClaudeCodePane {
  private model: string | undefined;
  private contextTokens: number | undefined;
  private running = false;
  /** Submits written since the last agent run began; Claude Code queues them until idle. */
  private queuedSubmits: number;
  private draft = false;
  private heldForNextTurn: string[] = [];

  constructor(private readonly deps: PaneDeps) {
    this.queuedSubmits = deps.startsWithPrompt === true ? 1 : 0;
  }

  /** Records what an event says about the session, before the session handles it. */
  observe(event: SidecarEvent): void {
    switch (event.type) {
      case "sessionStart":
        this.model = event.model;
        return;
      case "agentStart":
        this.running = true;
        this.queuedSubmits = 0;
        return;
      case "agentEnd":
        this.running = false;
        return;
      case "turnEnd":
        if (event.contextTokens !== undefined) this.contextTokens = event.contextTokens;
        return;
      case "promptEdit":
        this.draft = event.draft;
        return;
      case "userPrompt":
        if (event.origin === "composer") this.draft = false;
        return;
      default:
        return;
    }
  }

  /** Deliveries held for the model, handed over once as the next turn starts. */
  takeNextTurn(): readonly string[] {
    const held = this.heldForNextTurn;
    this.heldForNextTurn = [];
    return held;
  }

  readonly host: SessionHost = {
    capabilities: {
      proactiveCompaction: true,
      hiddenMessages: true,
      streamingProgress: false,
      perActionApproval: true,
    },
    perform: async (effect) => this.perform(effect),
    confirm: (title, message) => this.deps.confirm(title, message),
    contextTokens: () => this.contextTokens,
    // The mod reports each edit of the prompt box, so a draft is known without reading the box.
    paneState: () => ({
      idle: !this.running,
      pendingMessages: this.queuedSubmits > 0,
      draft: this.draft,
    }),
    assertSelectedModel: (selector) => {
      if (!runsSelectedModel(selector, this.model)) {
        throw new WorkerOutputError(
          `Claude Code runs ${this.model ?? "an unreported model"}, not ${selector}`,
        );
      }
    },
    mcpToolPrefix: claudeCodeMcpToolPrefix,
  };

  private perform(effect: SessionEffect): void {
    const { lines, nextTurn } = claudeCodeEffect(effect);
    for (const line of lines) {
      if (line.type === "submit") this.queuedSubmits += 1;
      this.deps.write(line);
    }
    if (nextTurn !== undefined) this.heldForNextTurn.push(nextTurn);
  }
}
