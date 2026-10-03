import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnResult, Register } from "claude-code";
import {
  encodeWire,
  type HookEvent,
  type HookEventType,
  type HookReply,
  parseHookReply,
  parseSidecarLine,
  type SidecarEvent,
} from "./protocol.ts";
import { TANDEM_TOOL } from "./tandem-tool.ts";
import {
  ALLOW,
  agentEndEvent,
  askQuestion,
  compactionInstructions,
  costDelta,
  DENY,
  endsSidecar,
  isOwnPrompt,
  LineReader,
  promptHandled,
  sidecarArgv,
  stopBlock,
  TANDEM_TOOL_CALL,
  TurnLedger,
  tandemToolAnswer,
  tandemToolEvent,
  toolRefusal,
  turnContext,
  turnEndEvent,
  userPromptEvent,
  wireToolCall,
} from "./translate.ts";

type Api = EngineInterface;
type Sidecar = AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>;

/** Under the 10 s a hook may spend on its own, which waiting on `$.clock.sleep` counts toward. */
const READY_WAIT_MS = 8_000;
/** Every `session.end` hook together gets 1.5 s. */
const SHUTDOWN_WAIT_MS = 1_000;

/** The ready sidecar's socket. Unset, every hook fails closed as if Tandem refused it. */
let socket: string | undefined;
/** Bumped by each start, so a replaced sidecar's output loop changes nothing. */
let generation = 0;
let stopping = false;
/** The session's cost when the last turn ended, to price the next one. */
let sessionCostUsd: number | undefined;
const turns = new TurnLedger();
/** From `turn.start` until `turn.complete` is answered; Claude Code compacts only between turns. */
let turnOpen = false;
let compactAfterTurn = false;
/** A compaction the sidecar asked for, so its `session.compact` hook does not ask again. */
let requestedCompaction: { seen: boolean } | undefined;
/** `$.ui.ask` reaches this mod's own `tool.call` hook as an `AskUserQuestion` call. */
let asking = 0;

function debug($: Api, text: string): void {
  $.ui.log(text, { to: "debug" });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function post($: Api, hook: HookEventType, event: SidecarEvent): Promise<HookReply> {
  if (socket === undefined) return { type: "refused", reason: "Tandem's sidecar is not running" };
  try {
    const response = await $.http.fetch("http://sidecar/event", {
      method: "POST",
      socketPath: socket,
      body: encodeWire(event),
    });
    const reply = parseHookReply(hook, response.text);
    return reply.ok ? reply.value : { type: "refused", reason: reply.reason };
  } catch (error) {
    return { type: "refused", reason: `Tandem's sidecar did not answer: ${message(error)}` };
  }
}

async function allowed($: Api, ask: Extract<HookReply, { type: "ask" }>): Promise<boolean> {
  asking += 1;
  try {
    return (await $.ui.ask(askQuestion(ask), [ALLOW, DENY])) === ALLOW;
  } catch {
    return false;
  } finally {
    asking -= 1;
  }
}

/** One hook's exchange with the sidecar, asking the person each question it raises on the way. */
async function exchange($: Api, event: HookEvent): Promise<HookReply> {
  let reply = await post($, event.type, event);
  while (reply.type === "ask") {
    const answer = await allowed($, reply);
    reply = await post($, event.type, { type: "askAnswer", ask: reply.ask, allowed: answer });
  }
  return reply;
}

async function compact($: Api): Promise<void> {
  if (turnOpen) {
    compactAfterTurn = true;
    return;
  }
  const instructions = compactionInstructions(await exchange($, { type: "compacting" }), undefined);
  const requested = { seen: false };
  requestedCompaction = requested;
  try {
    const result = await $.session.compact(instructions === undefined ? {} : { instructions });
    if (!requested.seen && result.skip === undefined) await exchange($, { type: "compacted" });
  } catch (error) {
    debug($, `Tandem could not compact the conversation: ${message(error)}`);
  } finally {
    if (requestedCompaction === requested) requestedCompaction = undefined;
  }
}

async function perform($: Api, line: string): Promise<void> {
  const parsed = parseSidecarLine(line);
  if (!parsed.ok) {
    debug($, `Tandem ignored a sidecar line it could not read: ${parsed.reason}`);
    return;
  }
  const effect = parsed.value;
  switch (effect.type) {
    case "submit":
      void $.prompt.submit({ text: effect.text, asUser: true });
      return;
    case "log":
      $.ui.log(effect.text);
      return;
    case "toast":
      $.ui.toast(effect.text);
      return;
    case "abort": {
      const turnId = turns.runningTurnId();
      if (turnId === undefined) return;
      await $.turn.abort({ turnId }).catch((error: unknown) => {
        debug($, `Tandem could not stop the turn: ${message(error)}`);
      });
      return;
    }
    case "compact":
      void compact($);
      return;
    case "ready":
    case "fatal":
      debug($, `Tandem ignored a second ${effect.type} line from its sidecar`);
      return;
  }
}

/** Carries out the sidecar's effects until it exits, then leaves the mod failing closed. */
async function followSidecar(
  $: Api,
  sidecar: Sidecar,
  lines: LineReader,
  started: number,
): Promise<void> {
  try {
    for await (const piece of sidecar) {
      if (generation !== started) return;
      if (piece.stream === "stderr") debug($, piece.text);
      else for (const line of lines.push(piece.text)) await perform($, line);
    }
  } catch (error) {
    debug($, `Tandem's sidecar output ended: ${message(error)}`);
  }
  if (generation !== started || stopping) return;
  socket = undefined;
  $.ui.toast(
    "Tandem stopped. This conversation goes on without Tandem until Claude Code restarts.",
  );
}

async function firstLine($: Api, sidecar: Sidecar, lines: LineReader): Promise<string | undefined> {
  for (;;) {
    const piece = await sidecar.next();
    if (piece.done) return undefined;
    if (piece.value.stream === "stderr") {
      debug($, piece.value.text);
      continue;
    }
    const [line] = lines.push(piece.value.text);
    if (line !== undefined) return line;
  }
}

/**
 * Starts this session's sidecar, waits for its ready line, and starts its session before carrying
 * out any of its effects. A sidecar that fails or never gets ready is stopped, and the mod stays
 * without one, so every hook fails closed.
 */
async function startSidecar($: Api): Promise<void> {
  generation += 1;
  const started = generation;
  socket = undefined;
  const sidecar = $.process.spawn({ argv: sidecarArgv($.plugin.root, await $.session.id()) });
  const lines = new LineReader();
  let line: string | undefined;
  try {
    line = await Promise.race([
      firstLine($, sidecar, lines),
      $.clock.sleep(READY_WAIT_MS).then(() => undefined),
    ]);
  } catch (error) {
    line = undefined;
    debug($, `Tandem's sidecar did not start: ${message(error)}`);
  }
  const ready = line === undefined ? undefined : parseSidecarLine(line);
  if (ready?.ok && ready.value.type === "ready") {
    socket = ready.value.socket;
    sessionCostUsd = (await $.session.usage()).cost?.usd;
    await exchange($, { type: "sessionStart", model: await $.session.model() });
    void followSidecar($, sidecar, lines, started);
    return;
  }
  void sidecar.return({ code: null, signal: null });
  const reason =
    ready === undefined
      ? "it did not get ready"
      : ready.ok
        ? ready.value.type === "fatal"
          ? ready.value.reason
          : `it sent ${ready.value.type} first`
        : ready.reason;
  $.ui.toast(`Tandem could not start (${reason}). Its tools are turned off in this conversation.`);
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.tool.register(TANDEM_TOOL);
    const started = await next(e);
    await startSidecar($);
    return started;
  });

  on("prompt.submit", async ($, e, next) => {
    if (isOwnPrompt(e)) return next(e);
    if (promptHandled(await exchange($, userPromptEvent(e)))) return { drop: "Handled by Tandem." };
    if (e.turnId !== undefined) return next(e);
    const context = turnContext(await exchange($, { type: "agentStart" }));
    turns.promptStarted(context);
    return next({ ...e, context: [...(e.context ?? []), ...context.context] });
  });

  on("turn.start", async ($, e, next) => {
    turnOpen = true;
    if (!turns.begin(e.text, e.turnId)) {
      turns.turnStarted(turnContext(await exchange($, { type: "agentStart" })));
    }
    await exchange($, { type: "turnStart" });
    return next(e);
  });

  on("prompt.compose", async (_$, e, next) => {
    const composed = await next(e);
    const section = turns.section();
    return section === undefined ? composed : { sections: [...composed.sections, section] };
  });

  on("tool.call", async ($, e, next) => {
    const tool: string = e.tool;
    if (tool === TANDEM_TOOL_CALL) return tandemToolAnswer(await exchange($, tandemToolEvent(e)));
    if (asking > 0 && e.tool === "AskUserQuestion") return next(e);
    const call = wireToolCall(e);
    const refusal = toolRefusal(await exchange($, { type: "toolCall", call }));
    if (refusal !== undefined) return { deny: refusal };
    await exchange($, { type: "toolStart", call });
    const result = await next(e);
    await exchange($, { type: "toolEnd", call });
    return result;
  }).catch(async () => ({ deny: "Tandem's tool check failed, so this tool call did not run." }));

  on("classic.Stop", async ($, e, next) => {
    const block = stopBlock(await exchange($, { type: "stopRequested", aborted: false }));
    return block === undefined ? next(e) : { block };
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const prompt = turns.end();
    const usage = await $.session.usage();
    const costUsd = usage.cost?.usd;
    const turnCostUsd = costDelta(sessionCostUsd, costUsd);
    sessionCostUsd = costUsd ?? sessionCostUsd;
    await exchange($, turnEndEvent(e.usage ?? undefined, turnCostUsd, usage.context.tokens));
    await exchange($, agentEndEvent(e, prompt));
    const result = await next(e);
    turnOpen = false;
    if (compactAfterTurn) {
      compactAfterTurn = false;
      $.clock.after(0, () => void compact($));
    }
    return result;
  });

  on("session.compact", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const requested = requestedCompaction;
    requestedCompaction = undefined;
    if (requested !== undefined) requested.seen = true;
    const instructions =
      requested === undefined
        ? compactionInstructions(await exchange($, { type: "compacting" }), e.instructions)
        : undefined;
    const result = await next(instructions === undefined ? e : { ...e, instructions });
    if (e.trigger !== "precompute" && result.skip === undefined) {
      await exchange($, { type: "compacted" });
    }
    return result;
  });

  on("session.end", async ($, e, next) => {
    if (endsSidecar(e.reason) && socket !== undefined) {
      stopping = true;
      await Promise.race([exchange($, { type: "shutdown" }), $.clock.sleep(SHUTDOWN_WAIT_MS)]);
      socket = undefined;
    }
    return next(e);
  });
};
