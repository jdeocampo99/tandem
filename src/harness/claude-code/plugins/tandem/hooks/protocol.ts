/**
 * The wire between the Claude Code mod and Tandem's sidecar. Events go mod → sidecar as one JSON
 * object per `POST /event` over the sidecar's unix socket, and the HTTP response carries the
 * hook's answer. Effects go sidecar → mod as one JSON object per stdout line.
 *
 * It lives inside the `tandem` plugin and imports nothing, because a mod can import only files
 * inside its own plugin and has no Node APIs; the sidecar imports it from here.
 */

export const SIDECAR_PROTOCOL_VERSION = 1;

/** A tool call as Claude Code names it; the sidecar classifies it into the core's tool kinds. */
export type WireToolCall = Readonly<{
  id: string;
  name: string;
  input: Readonly<Record<string, unknown>>;
}>;

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
 * Everything the mod forwards. There is no `streaming` or `contextBuild`: Claude Code exposes no
 * per-token progress and no message history to a mod.
 */
export type SidecarEvent =
  | Readonly<{ type: "sessionStart"; model: string }>
  | Readonly<{ type: "userPrompt"; text: string; interactive: boolean; attachments: number }>
  | Readonly<{ type: "agentStart" }>
  | Readonly<{ type: "turnStart" }>
  | Readonly<{ type: "toolCall"; call: WireToolCall }>
  /** A call to the mod's own `tandem` tool; `input` is parsed by the sidecar. */
  | Readonly<{ type: "tandemTool"; id: string; input: unknown }>
  | Readonly<{ type: "toolStart"; call: WireToolCall }>
  | Readonly<{ type: "toolEnd"; call: WireToolCall }>
  /** `contextTokens` is the context size `$.session.usage()` reported after the turn. */
  | Readonly<{ type: "turnEnd"; usage?: WireUsage; contextTokens?: number }>
  | Readonly<{ type: "agentEnd"; interrupted: boolean; failure?: string }>
  | Readonly<{ type: "stopRequested"; aborted: boolean }>
  | Readonly<{ type: "compacting" }>
  | Readonly<{ type: "compacted" }>
  | Readonly<{ type: "shutdown" }>
  /** The person's answer to an `ask` reply; its response is the original hook's next reply. */
  | Readonly<{ type: "askAnswer"; ask: string; allowed: boolean }>;

export type SidecarEventType = SidecarEvent["type"];

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
  | Readonly<{ type: "stop"; continueWith?: string }>
  | Readonly<{ type: "compaction"; instructions: string }>
  | Readonly<{ type: "ask"; ask: string; title: string; message: string }>
  | Readonly<{ type: "refused"; reason: string }>;

/** The events that start a hook; `askAnswer` continues one. */
export type HookEventType = Exclude<SidecarEventType, "askAnswer">;

/** The reply each hook event may get besides `ask` and `refused`. */
const REPLIES: Readonly<Record<HookEventType, HookReply["type"]>> = {
  sessionStart: "done",
  userPrompt: "promptRoute",
  agentStart: "turnContext",
  turnStart: "done",
  toolCall: "toolDecision",
  tandemTool: "toolResult",
  toolStart: "done",
  toolEnd: "done",
  turnEnd: "done",
  agentEnd: "done",
  stopRequested: "stop",
  compacting: "compaction",
  compacted: "done",
  shutdown: "done",
};

/** One stdout line. `ready` or `fatal` comes first and once; every later line is an effect. */
export type SidecarLine =
  | Readonly<{ type: "ready"; protocol: number; socket: string; pid: number }>
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
      shape("text", "interactive", "attachments");
      return {
        type,
        text: text(record, "text", where),
        interactive: flag(record, "interactive", where),
        attachments: count(record, "attachments", where),
      };
    case "agentStart":
    case "turnStart":
    case "compacting":
    case "compacted":
    case "shutdown":
      shape();
      return { type };
    case "toolCall":
    case "toolStart":
    case "toolEnd":
      shape("call");
      return { type, call: toolCall(record, "call", where) };
    case "tandemTool":
      shape("id", "input");
      return { type, id: name(record, "id", where), input: record.input };
    case "turnEnd":
      shape("usage", "contextTokens");
      return {
        type,
        ...optional(record, "usage", usage, where),
        ...optional(record, "contextTokens", count, where),
      };
    case "agentEnd":
      shape("interrupted", "failure");
      return {
        type,
        interrupted: flag(record, "interrupted", where),
        ...optional(record, "failure", text, where),
      };
    case "stopRequested":
      shape("aborted");
      return { type, aborted: flag(record, "aborted", where) };
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
      shape("protocol", "socket", "pid");
      return {
        type,
        protocol,
        socket: name(record, "socket", where),
        pid: count(record, "pid", where),
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
