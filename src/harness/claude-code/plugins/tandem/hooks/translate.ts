/**
 * What the mod sends the sidecar for each Claude Code event, and what it answers Claude Code with
 * for each sidecar reply. Nothing here touches `$`, so the decisions are tested without a session;
 * register.ts only carries them out.
 */

import type { HookEvent, HookReply, WireToolCall, WireUsage } from "./protocol.ts";

/** Claude Code names a tool this mod registers `mcp__tandem__<tool>`. */
const PLUGIN_TOOL_PREFIX = "mcp__tandem__";

/** The section of the system prompt that carries the coordinator's instructions each request. */
export const COORDINATOR_SECTION_ID = "tandem:coordinator";

/**
 * The plugin directory sits two levels under src/harness/claude-code/, beside the sidecar. The
 * sidecar tells a coordinator from a worker by the environment Tandem launched Claude Code with.
 */
export function sidecarArgv(pluginRoot: string, sessionId: string): readonly string[] {
  return ["bun", `${pluginRoot}/../../sidecar.ts`, "--session", sessionId];
}

/** Whole lines out of a child's output, which arrives in pieces that need not end at a newline. */
export class LineReader {
  private buffered = "";

  push(text: string): readonly string[] {
    this.buffered += text;
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }
}

/** The question `$.ui.ask` shows for an `ask` reply. */
export function askQuestion(ask: Extract<HookReply, { type: "ask" }>): string {
  return ask.message.length === 0 ? ask.title : `${ask.title}\n\n${ask.message}`;
}

export const ALLOW = "Allow";
export const DENY = "Deny";

type PromptFields = Readonly<{
  text: string;
  origin: Readonly<{ kind: string; name?: string }>;
  attachments?: readonly unknown[];
  turnId?: string;
}>;

/** The mod's own submits are Tandem's wakes, which Tandem already knows about. */
export function isOwnPrompt(prompt: PromptFields): boolean {
  return prompt.origin.kind === "plugin" && prompt.origin.name === "tandem";
}

/** A run begins: with the text it starts from, when there is one. */
export function agentStartEvent(text: string | undefined): HookEvent {
  return text === undefined || text.length === 0
    ? { type: "agentStart" }
    : { type: "agentStart", prompt: text };
}

export function userPromptEvent(prompt: PromptFields): HookEvent {
  return {
    type: "userPrompt",
    text: prompt.text,
    interactive: prompt.origin.kind === "composer",
    attachments: prompt.attachments?.length ?? 0,
  };
}

/** Routing refused or failed: the prompt goes on as if Tandem were absent. */
export function promptHandled(reply: HookReply): boolean {
  return reply.type === "promptRoute" && reply.handled;
}

export type TurnContext = Readonly<{ system: readonly string[]; context: readonly string[] }>;

export function turnContext(reply: HookReply): TurnContext {
  return reply.type === "turnContext"
    ? { system: reply.system, context: reply.context }
    : { system: [], context: [] };
}

/**
 * The coordinator's state across one Claude Code turn. A prompt the person submits while idle
 * starts its agent run in `prompt.submit`, so its held deliveries ride with the prompt; any other
 * turn (Tandem's own wakes, prompts typed over a running turn) starts its run in `turn.start`.
 */
export class TurnLedger {
  private started: TurnContext | undefined;
  private current: { prompt?: string; turnId: string; system: readonly string[] } | undefined;

  /** `agentStart` was answered for the prompt about to start the next turn. */
  promptStarted(context: TurnContext): void {
    this.started = context;
  }

  /** A turn begins; false when its agent run has not started yet. */
  begin(text: string, turnId: string): boolean {
    const started = this.started;
    this.started = undefined;
    this.current = {
      ...(text.length === 0 ? {} : { prompt: text }),
      turnId,
      system: started?.system ?? [],
    };
    return started !== undefined;
  }

  /**
   * The run started with the turn: with no prompt to attach held deliveries to, they join the
   * system text for this turn.
   */
  turnStarted(context: TurnContext): void {
    if (this.current !== undefined) {
      this.current.system = [...context.system, ...context.context];
    }
  }

  /** The `prompt.compose` section for the running turn, if it has system text. */
  section(): Readonly<{ id: string; text: string; scope: "session" }> | undefined {
    const system = this.current?.system ?? [];
    return system.length === 0
      ? undefined
      : { id: COORDINATOR_SECTION_ID, text: system.join("\n\n"), scope: "session" };
  }

  runningTurnId(): string | undefined {
    return this.current?.turnId;
  }

  /** The turn ended; returns the prompt it began with. */
  end(): string | undefined {
    const prompt = this.current?.prompt;
    this.current = undefined;
    return prompt;
  }
}

type ToolCallFields = Readonly<{
  tool: string;
  tool_use_id?: string;
  consent?: string;
  agentId?: string;
}> &
  Readonly<Record<string, unknown>>;

/** A tool call's arguments: every field Claude Code does not reserve for itself. */
function toolInput(call: ToolCallFields): Readonly<Record<string, unknown>> {
  const { tool: _tool, tool_use_id: _id, consent: _consent, agentId: _agent, ...input } = call;
  return input;
}

export function wireToolCall(call: ToolCallFields): WireToolCall {
  return { id: call.tool_use_id ?? call.tool, name: call.tool, input: toolInput(call) };
}

/** The short name of a call to one of `registered`, the tools the sidecar listed; else undefined. */
export function pluginToolName(tool: string, registered: ReadonlySet<string>): string | undefined {
  if (!tool.startsWith(PLUGIN_TOOL_PREFIX)) return undefined;
  const name = tool.slice(PLUGIN_TOOL_PREFIX.length);
  return registered.has(name) ? name : undefined;
}

export function pluginToolEvent(call: ToolCallFields, name: string): HookEvent {
  return { type: "pluginTool", id: call.tool_use_id ?? call.tool, name, input: toolInput(call) };
}

/** The tools whose result the sidecar reads: a new to-do item's id comes only in its result. */
const RESULTS_READ: ReadonlySet<string> = new Set(["TaskCreate"]);

export function toolEndEvent(call: WireToolCall, result: unknown): HookEvent {
  return RESULTS_READ.has(call.name) && result !== undefined
    ? { type: "toolEnd", call, result }
    : { type: "toolEnd", call };
}

/** What the model reads after a tool's result; nothing when Tandem refused or failed. */
export function toolContext(reply: HookReply): readonly string[] {
  return reply.type === "toolContext" ? reply.context : [];
}

/** A tool the coordinator guard did not clear never runs, including when Tandem is unreachable. */
export function toolRefusal(reply: HookReply): string | undefined {
  switch (reply.type) {
    case "toolDecision":
      return reply.block ? reply.reason : undefined;
    case "refused":
      return `Tandem could not check this tool call, so it did not run: ${reply.reason}`;
    default:
      return `Tandem answered this tool call with ${reply.type}, so it did not run.`;
  }
}

export type ToolAnswer = Readonly<{ result: string }> | Readonly<{ deny: string }>;

export function pluginToolAnswer(reply: HookReply): ToolAnswer {
  switch (reply.type) {
    case "toolResult":
      return reply.isError ? { deny: reply.text } : { result: reply.text };
    case "refused":
      return { deny: `Tandem is not available: ${reply.reason}` };
    default:
      return { deny: `Tandem answered with ${reply.type} instead of a result.` };
  }
}

type TurnUsageFields = Readonly<{
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}>;

/**
 * What a turn cost: the rise in the session's cost, which Claude Code reports only for the whole
 * session. Zero when either reading is missing or the cost went down (a new conversation).
 */
export function costDelta(before: number | undefined, after: number | undefined): number {
  if (before === undefined || after === undefined || after < before) return 0;
  return after - before;
}

export function turnEndEvent(
  usage: TurnUsageFields | undefined,
  costUsd: number,
  contextTokens: number | undefined,
): HookEvent {
  const wire: WireUsage | undefined =
    usage === undefined
      ? undefined
      : {
          model: usage.model,
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheWrite: usage.cache_creation_input_tokens,
          costUsd,
        };
  return {
    type: "turnEnd",
    ...(wire === undefined ? {} : { usage: wire }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}

type TurnCompleteFields = Readonly<{
  answer: string;
  isAborted: boolean;
  reason: string;
  refusal?: Readonly<{ explanation: string | null }>;
}>;

function turnFailure(turn: TurnCompleteFields): string | undefined {
  if (turn.reason === "error") return "the turn ended with an error";
  if (turn.reason !== "refusal") return undefined;
  const explanation = turn.refusal?.explanation;
  return explanation ? `the model refused: ${explanation}` : "the model refused";
}

export function agentEndEvent(turn: TurnCompleteFields, prompt: string | undefined): HookEvent {
  const failure = turnFailure(turn);
  return {
    type: "agentEnd",
    interrupted: turn.isAborted,
    ...(failure === undefined ? {} : { failure }),
    ...(prompt === undefined ? {} : { prompt }),
    answer: turn.answer,
  };
}

/** A `stop` reply that asks to go on becomes a classic Stop block, which re-prompts the model. */
export function stopBlock(reply: HookReply): string | undefined {
  return reply.type === "stop" ? reply.continueWith : undefined;
}

/** Tandem's compaction instructions after any the compaction already had. */
export function compactionInstructions(
  reply: HookReply,
  existing: string | undefined,
): string | undefined {
  const ours = reply.type === "compaction" ? reply.instructions : "";
  const parts = [existing ?? "", ours].filter((part) => part.trim().length > 0);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/** `/clear` and `/resume` end the conversation, not the Claude Code session the sidecar serves. */
export function endsSidecar(reason: string): boolean {
  return reason !== "clear" && reason !== "resume";
}

/**
 * The rows `$.ui.log` draws for one shown text. Claude Code draws a newline inside a log row as a
 * replacement character, so each line gets its own row and blank lines are dropped.
 */
export function logLines(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

type PromptEditFields = Readonly<{ text: string; start: number; end: number; inputText: string }>;

/** Whether the prompt box holds text once this edit is applied. */
export function draftAfterEdit(edit: PromptEditFields): boolean {
  const next = edit.text.slice(0, edit.start) + edit.inputText + edit.text.slice(edit.end);
  return next.trim().length > 0;
}

/** Only a refusal from Tandem holds an edit back; an unreachable sidecar never locks the box. */
export function editAllowed(reply: HookReply): boolean {
  return reply.type !== "editDecision" || reply.allowed;
}
