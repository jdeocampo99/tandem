/**
 * The wire between the Claude Code mod and Tandem's sidecar. Events go mod → sidecar as one JSON
 * object per `POST /event` over the sidecar's unix socket, and the HTTP response carries the
 * hook's answer. Effects go sidecar → mod as one JSON object per stdout line.
 *
 * It lives inside the `tandem` plugin and imports nothing, because a mod can import only files
 * inside its own plugin and has no Node APIs; the sidecar imports it from here.
 */

export const SIDECAR_PROTOCOL_VERSION = 2;

/** A tool call as Claude Code names it; the sidecar classifies it into the core's tool kinds. */
export type WireToolCall = Readonly<{
  id: string;
  name: string;
  input: Readonly<Record<string, unknown>>;
}>;

/** A tool the mod registers with `$.tool.register`; the model calls it as `mcp__tandem__<name>`. */
export type WireToolSpec = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

/**
 * Where a prompt came from, as Claude Code's `PromptOrigin.kind` names it: the person's Enter, a
 * finished background task's notification, or anything else (the bridge, the SDK, a peer).
 */
const PROMPT_ORIGINS = ["composer", "task-notification", "other"] as const;
export type PromptOrigin = (typeof PROMPT_ORIGINS)[number];

/** One finished model turn's tokens, from Claude Code's `turn.complete`. */
export type WireUsage = Readonly<{
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}>;

/**
 * Everything the mod forwards. There is no `contextBuild`: Claude Code shows a mod no message
 * history to rewrite.
 */
export type SidecarEvent =
  | Readonly<{ type: "sessionStart"; model: string }>
  | Readonly<{ type: "userPrompt"; text: string; origin: PromptOrigin; attachments: number }>
  /** `prompt` is the text the run begins with, when it begins with one. */
  | Readonly<{ type: "agentStart"; prompt?: string }>
  | Readonly<{ type: "turnStart" }>
  /** The model is streaming a response; the mod sends it at most every few seconds. */
  | Readonly<{ type: "streaming" }>
  | Readonly<{ type: "toolCall"; call: WireToolCall }>
  /** A call to one of the tools the ready line listed; `input` is parsed by the sidecar. */
  | Readonly<{ type: "pluginTool"; id: string; name: string; input: unknown }>
  | Readonly<{ type: "toolStart"; call: WireToolCall }>
  /** `result` is the tool's own record, sent only for tools whose result Tandem reads. */
  | Readonly<{ type: "toolEnd"; call: WireToolCall; result?: unknown }>
  /** `contextTokens` is the context size `$.session.usage()` reported after the turn. */
  | Readonly<{ type: "turnEnd"; usage?: WireUsage; contextTokens?: number }>
  /** `prompt` is the text the run began with (`turn.start`), `answer` its final text. */
  | Readonly<{
      type: "agentEnd";
      interrupted: boolean;
      failure?: string;
      prompt?: string;
      answer?: string;
    }>
  | Readonly<{ type: "stopRequested"; aborted: boolean }>
  /** The person edited the prompt box; `draft` says whether text is left in it. */
  | Readonly<{ type: "promptEdit"; draft: boolean }>
  | Readonly<{ type: "compacting" }>
  | Readonly<{ type: "compacted" }>
  | Readonly<{ type: "shutdown" }>
  /** The person's answer to an `ask` reply; its response is the original hook's next reply. */
  | Readonly<{ type: "askAnswer"; ask: string; allowed: boolean }>;

/**
 * A hook's answer, the body of every `/event` response. `ask` may answer any event: the mod shows
 * `$.ui.ask(title, ["Allow", "Deny"])` inside the same hook and posts `askAnswer`. `refused` means
 * the event was malformed or failed; the mod fails closed (denies a tool call, errors a `tandem`
 * call, and otherwise lets Claude Code go on as if Tandem were absent).
 */
export type HookReply =
  | Readonly<{ type: "done" }>
  | Readonly<{ type: "toolDecision"; block: false }>
  | Readonly<{ type: "toolDecision"; block: true; reason: string }>
  | Readonly<{ type: "promptRoute"; handled: boolean }>
  /** `system` goes to `prompt.section`, `context` (deliveries held for this turn) to `prompt.context`. */
  | Readonly<{ type: "turnContext"; system: readonly string[]; context: readonly string[] }>
  | Readonly<{ type: "toolResult"; text: string; isError: boolean }>
  /** Text the model reads after the tool's result, never shown to the person. */
  | Readonly<{ type: "toolContext"; context: readonly string[] }>
  /** Whether the person's edit to the prompt box goes through. */
  | Readonly<{ type: "editDecision"; allowed: boolean }>
  | Readonly<{ type: "stop"; continueWith?: string }>
  | Readonly<{ type: "compaction"; instructions: string }>
  | Readonly<{ type: "ask"; ask: string; title: string; message: string }>
  | Readonly<{ type: "refused"; reason: string }>;

/** The events that start a hook; `askAnswer` continues one. */
export type HookEvent = Exclude<SidecarEvent, Readonly<{ type: "askAnswer" }>>;
export type HookEventType = HookEvent["type"];

/** The reply each hook event may get besides `ask` and `refused`. */
const REPLIES: Readonly<Record<HookEventType, HookReply["type"]>> = {
  sessionStart: "done",
  userPrompt: "promptRoute",
  agentStart: "turnContext",
  turnStart: "done",
  streaming: "done",
  toolCall: "toolDecision",
  pluginTool: "toolResult",
  toolStart: "done",
  toolEnd: "toolContext",
  turnEnd: "done",
  agentEnd: "done",
  stopRequested: "stop",
  promptEdit: "editDecision",
  compacting: "compaction",
  compacted: "done",
  shutdown: "done",
};

/** One stdout line. `ready` or `fatal` comes first and once; every later line is an effect. */
export type SidecarLine =
  /** `tools` are the session's own tools, which the mod registers before the first prompt. */
  | Readonly<{
      type: "ready";
      protocol: number;
      socket: string;
      pid: number;
      tools: readonly WireToolSpec[];
    }>
  | Readonly<{ type: "fatal"; protocol: number; reason: string }>
  /** `$.prompt.submit({ text, asUser: true })`: starts a turn once the session is idle. */
  | Readonly<{ type: "submit"; text: string }>
  /** `$.ui.log(text)`: shown in the chat, never read by the model. */
  | Readonly<{ type: "log"; text: string }>
  /** `$.ui.toast(text)`. */
  | Readonly<{ type: "toast"; text: string; level: "info" | "error" }>
  /** `$.turn.abort()`. */
  | Readonly<{ type: "abort" }>
  /** Post `compacting`, then `$.session.compact({ instructions })` with its reply. */
  | Readonly<{ type: "compact" }>;

export type Parsed<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string }>;

class WireError extends Error {}

type Fields = Readonly<Record<string, unknown>>;

function fields(value: unknown, where: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WireError(`${where} must be a JSON object`);
  }
  return value as Fields;
}

/** Rejects fields the protocol does not define, so drift between mod and sidecar fails loudly. */
function only(record: Fields, allowed: readonly string[], where: string): void {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new WireError(`${where} has unknown fields: ${extra.join(", ")}`);
}

function text(record: Fields, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new WireError(`${where}.${key} must be text`);
  return value;
}

function name(record: Fields, key: string, where: string): string {
  const value = text(record, key, where);
  if (value.trim().length === 0) throw new WireError(`${where}.${key} must not be empty`);
  return value;
}

function flag(record: Fields, key: string, where: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new WireError(`${where}.${key} must be true or false`);
  return value;
}

function promptOrigin(record: Fields, key: string, where: string): PromptOrigin {
  const value = record[key];
  const origin = PROMPT_ORIGINS.find((known) => known === value);
  if (origin === undefined) {
    throw new WireError(`${where}.${key} must be one of ${PROMPT_ORIGINS.join(", ")}`);
  }
  return origin;
}

function count(record: Fields, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WireError(`${where}.${key} must be a whole number of zero or more`);
  }
  return value;
}

function amount(record: Fields, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new WireError(`${where}.${key} must be a number of zero or more`);
  }
  return value;
}

function optional<T>(
  record: Fields,
  key: string,
  read: (record: Fields, key: string, where: string) => T,
  where: string,
): Readonly<Record<string, T>> {
  return record[key] === undefined ? {} : { [key]: read(record, key, where) };
}

function toolCall(record: Fields, key: string, where: string): WireToolCall {
  const at = `${where}.${key}`;
  const call = fields(record[key], at);
  only(call, ["id", "name", "input"], at);
  return { id: name(call, "id", at), name: name(call, "name", at), input: fields(call.input, at) };
}

function usage(record: Fields, key: string, where: string): WireUsage {
  const at = `${where}.${key}`;
  const value = fields(record[key], at);
  only(value, ["model", "input", "output", "cacheRead", "cacheWrite", "costUsd"], at);
  return {
    model: name(value, "model", at),
    input: count(value, "input", at),
    output: count(value, "output", at),
    cacheRead: count(value, "cacheRead", at),
    cacheWrite: count(value, "cacheWrite", at),
    costUsd: amount(value, "costUsd", at),
  };
}

function eventFrom(value: unknown): SidecarEvent {
  const record = fields(value, "event");
  const type = text(record, "type", "event");
  const where = `${type} event`;
  const shape = (...keys: string[]) => only(record, ["type", ...keys], where);
  switch (type) {
    case "sessionStart":
      shape("model");
      return { type, model: name(record, "model", where) };
    case "userPrompt":
      shape("text", "origin", "attachments");
      return {
        type,
        text: text(record, "text", where),
        origin: promptOrigin(record, "origin", where),
        attachments: count(record, "attachments", where),
      };
    case "agentStart":
      shape("prompt");
      return { type, ...optional(record, "prompt", text, where) };
    case "turnStart":
    case "streaming":
    case "compacting":
    case "compacted":
    case "shutdown":
      shape();
      return { type };
    case "toolCall":
    case "toolStart":
      shape("call");
      return { type, call: toolCall(record, "call", where) };
    case "toolEnd":
      shape("call", "result");
      return {
        type,
        call: toolCall(record, "call", where),
        ...(record.result === undefined ? {} : { result: record.result }),
      };
    case "pluginTool":
      shape("id", "name", "input");
      return {
        type,
        id: name(record, "id", where),
        name: name(record, "name", where),
        input: record.input,
      };
    case "turnEnd":
      shape("usage", "contextTokens");
      return {
        type,
        ...optional(record, "usage", usage, where),
        ...optional(record, "contextTokens", count, where),
      };
    case "agentEnd":
      shape("interrupted", "failure", "prompt", "answer");
      return {
        type,
        interrupted: flag(record, "interrupted", where),
        ...optional(record, "failure", text, where),
        ...optional(record, "prompt", text, where),
        ...optional(record, "answer", text, where),
      };
    case "stopRequested":
      shape("aborted");
      return { type, aborted: flag(record, "aborted", where) };
    case "promptEdit":
      shape("draft");
      return { type, draft: flag(record, "draft", where) };
    case "askAnswer":
      shape("ask", "allowed");
      return { type, ask: name(record, "ask", where), allowed: flag(record, "allowed", where) };
    default:
      throw new WireError(`unknown event type ${JSON.stringify(type)}`);
  }
}

function replyFrom(value: unknown): HookReply {
  const record = fields(value, "reply");
  const type = text(record, "type", "reply");
  const where = `${type} reply`;
  const shape = (...keys: string[]) => only(record, ["type", ...keys], where);
  switch (type) {
    case "done":
      shape();
      return { type };
    case "toolDecision":
      if (flag(record, "block", where)) {
        shape("block", "reason");
        return { type, block: true, reason: name(record, "reason", where) };
      }
      shape("block");
      return { type, block: false };
    case "promptRoute":
      shape("handled");
      return { type, handled: flag(record, "handled", where) };
    case "turnContext":
      shape("system", "context");
      return {
        type,
        system: texts(record, "system", where),
        context: texts(record, "context", where),
      };
    case "toolResult":
      shape("text", "isError");
      return { type, text: text(record, "text", where), isError: flag(record, "isError", where) };
    case "toolContext":
      shape("context");
      return { type, context: texts(record, "context", where) };
    case "editDecision":
      shape("allowed");
      return { type, allowed: flag(record, "allowed", where) };
    case "stop":
      shape("continueWith");
      return { type, ...optional(record, "continueWith", name, where) };
    case "compaction":
      shape("instructions");
      return { type, instructions: text(record, "instructions", where) };
    case "ask":
      shape("ask", "title", "message");
      return {
        type,
        ask: name(record, "ask", where),
        title: name(record, "title", where),
        message: text(record, "message", where),
      };
    case "refused":
      shape("reason");
      return { type, reason: name(record, "reason", where) };
    default:
      throw new WireError(`unknown reply type ${JSON.stringify(type)}`);
  }
}

function toolSpecs(record: Fields, key: string, where: string): readonly WireToolSpec[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new WireError(`${where}.${key} must be a list of tools`);
  return value.map((item, index) => {
    const at = `${where}.${key}[${index}]`;
    const spec = fields(item, at);
    only(spec, ["name", "description", "inputSchema"], at);
    return {
      name: name(spec, "name", at),
      description: text(spec, "description", at),
      inputSchema: fields(spec.inputSchema, `${at}.inputSchema`),
    };
  });
}

function texts(record: Fields, key: string, where: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new WireError(`${where}.${key} must be a list of text`);
  }
  return value as readonly string[];
}

function lineFrom(value: unknown): SidecarLine {
  const record = fields(value, "line");
  const type = text(record, "type", "line");
  const where = `${type} line`;
  const shape = (...keys: string[]) => only(record, ["type", ...keys], where);
  switch (type) {
    case "ready":
    case "fatal": {
      const protocol = count(record, "protocol", where);
      if (protocol !== SIDECAR_PROTOCOL_VERSION) {
        throw new WireError(
          `the sidecar speaks protocol ${protocol}, and this mod speaks ${SIDECAR_PROTOCOL_VERSION}`,
        );
      }
      if (type === "fatal") {
        shape("protocol", "reason");
        return { type, protocol, reason: name(record, "reason", where) };
      }
      shape("protocol", "socket", "pid", "tools");
      return {
        type,
        protocol,
        socket: name(record, "socket", where),
        pid: count(record, "pid", where),
        tools: toolSpecs(record, "tools", where),
      };
    }
    case "submit":
    case "log":
      shape("text");
      return { type, text: name(record, "text", where) };
    case "toast": {
      shape("text", "level");
      const level = text(record, "level", where);
      if (level !== "info" && level !== "error") {
        throw new WireError(`${where}.level must be "info" or "error"`);
      }
      return { type, text: name(record, "text", where), level };
    }
    case "abort":
    case "compact":
      shape();
      return { type };
    default:
      throw new WireError(`unknown line type ${JSON.stringify(type)}`);
  }
}

function parsed<T>(read: () => T): Parsed<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof WireError) return { ok: false, reason: error.message };
    throw error;
  }
}

function json(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new WireError(`${what} is not JSON`);
  }
}

/** The sidecar's reading of one `/event` body. */
export function parseSidecarEvent(body: string): Parsed<SidecarEvent> {
  return parsed(() => eventFrom(json(body, "event")));
}

/**
 * The mod's reading of a reply to the hook `event` started, including the reply to each of its
 * `askAnswer`s; a reply that event cannot get is refused.
 */
export function parseHookReply(event: HookEventType, body: string): Parsed<HookReply> {
  return parsed(() => {
    const reply = replyFrom(json(body, "reply"));
    if (reply.type === "ask" || reply.type === "refused" || reply.type === REPLIES[event]) {
      return reply;
    }
    throw new WireError(`a ${event} event cannot be answered with ${reply.type}`);
  });
}

/** The mod's reading of one stdout line; a line from another protocol version is refused. */
export function parseSidecarLine(line: string): Parsed<SidecarLine> {
  return parsed(() => lineFrom(json(line, "line")));
}

/** Every wire message is one line of JSON; JSON.stringify never emits a raw newline. */
export function encodeWire(message: SidecarEvent | HookReply | SidecarLine): string {
  return JSON.stringify(message);
}
