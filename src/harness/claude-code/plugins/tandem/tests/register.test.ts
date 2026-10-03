import { expect, mock, type TestBody, test } from "claude-code/testing";
import type { HookReply, SidecarEvent, SidecarLine } from "../hooks/protocol.ts";

const READY: SidecarLine = { type: "ready", protocol: 1, socket: "/home/sidecars/a.sock", pid: 7 };
const DONE: HookReply = { type: "done" };

type Stubs = Parameters<TestBody>[1];

/**
 * Stands in for Claude Code's answers and for the sidecar: `reply` answers each posted event,
 * and the sidecar's stdout is its first line followed by `effects`.
 */
function sidecar(
  on: Stubs,
  reply: (event: SidecarEvent) => HookReply,
  options: Readonly<{ first?: SidecarLine; effects?: readonly SidecarLine[] }> = {},
) {
  const posted: SidecarEvent[] = [];
  const spawned: (readonly string[])[] = [];
  const shown: string[] = [];
  const toasts: string[] = [];
  const submitted: string[] = [];
  const { promise: effectsDone, resolve: finishEffects } = Promise.withResolvers<void>();
  mock.clock(on);
  on("session.start", () => ({ cwd: "/work" }));
  on("tool.register", () => ({ value: { tool: "mcp__tandem__tandem" } }));
  on("session.id", () => ({ value: "session-1" }));
  on("session.model", () => ({ value: "claude-sonnet-5-5" }));
  on("session.usage", () => ({
    value: {
      startedAt: 0,
      context: { tokens: 9_000, window: 200_000 },
      rateLimits: [],
      cost: { usd: 1.5 },
    },
  }));
  on("process.spawn", async function* (_$, e) {
    spawned.push(e.argv);
    yield { stream: "stdout", text: `${JSON.stringify(options.first ?? READY)}\n` };
    for (const effect of options.effects ?? []) {
      yield { stream: "stdout", text: `${JSON.stringify(effect)}\n` };
    }
    finishEffects();
    await new Promise(() => {});
    return { value: { code: 0, signal: null } };
  });
  on("http.fetch", (_$, e) => {
    const event = JSON.parse(e.init?.body ?? "{}");
    posted.push(event);
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply(event)) } };
  });
  on("ui.log", (_$, e) => {
    if (e.to !== "debug") shown.push(e.text);
    return { value: undefined };
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("prompt.submit", (_$, e) => {
    submitted.push(e.text);
    return { text: e.text, context: e.context };
  });
  return { posted, spawned, shown, toasts, submitted, effectsDone };
}

const start = { surface: "terminal", isInteractive: true, cwd: "/work" } as const;

test("the session starts the sidecar beside the plugin and reports the running model", async ($, on) => {
  const { posted, spawned } = sidecar(on, () => DONE);
  await $.session.start(start);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]?.slice(1)).toEqual([
    `${spawned[0]?.[1]}`,
    "--role",
    "coordinator",
    "--session",
    "session-1",
  ]);
  expect(spawned[0]?.[1]).toMatch(/plugins\/tandem\/\.\.\/\.\.\/sidecar\.ts$/);
  expect(posted).toEqual([{ type: "sessionStart", model: "claude-sonnet-5-5" }]);
});

test("a tool the guard clears runs between its start and end", async ($, on) => {
  const { posted } = sidecar(on, (event) =>
    event.type === "toolCall" ? { type: "toolDecision", block: false } : DONE,
  );
  on("tool.call", () => ({ result: "file text" }));
  await $.session.start(start);
  const result = await $.tool.call({ tool: "Read", file_path: "a.ts", tool_use_id: "toolu_1" });
  expect(result).toMatchObject({ result: "file text" });
  const call = { id: "toolu_1", name: "Read", input: { file_path: "a.ts" } };
  expect(posted.slice(1)).toEqual([
    { type: "toolCall", call },
    { type: "toolStart", call },
    { type: "toolEnd", call },
  ]);
});

test("a tool the guard blocks, or any tool while the sidecar is down, never runs", async ($, on) => {
  let up = true;
  sidecar(on, (event) =>
    event.type === "toolCall"
      ? up
        ? { type: "toolDecision", block: true, reason: "Coordinators do not edit files." }
        : { type: "refused", reason: "the store is locked" }
      : DONE,
  );
  let ran = 0;
  on("tool.call", () => {
    ran += 1;
    return { result: "ran" };
  });
  await $.session.start(start);
  expect(
    await $.tool.call({ tool: "Edit", file_path: "a.ts", old_string: "a", new_string: "b" }),
  ).toEqual({
    deny: "Coordinators do not edit files.",
  });
  up = false;
  expect(await $.tool.call({ tool: "Read", file_path: "a.ts" })).toEqual({
    deny: "Tandem could not check this tool call, so it did not run: the store is locked",
  });
  expect(ran).toBe(0);
});

test("a sidecar that fails to start is reported, and its tools stay off", async ($, on) => {
  const { posted, toasts } = sidecar(on, () => DONE, {
    first: { type: "fatal", protocol: 1, reason: "TANDEM_HOME is not set" },
  });
  on("tool.call", () => ({ result: "ran" }));
  await $.session.start(start);
  expect(toasts).toEqual([
    "Tandem could not start (TANDEM_HOME is not set). Its tools are turned off in this conversation.",
  ]);
  expect(await $.tool.call({ tool: "mcp__tandem__tandem", request: { action: "list" } })).toEqual({
    deny: "Tandem is not available: Tandem's sidecar is not running",
  });
  expect(posted).toEqual([]);
});

test("a tandem call that needs approval asks the person, then answers with the result", async ($, on) => {
  const { posted } = sidecar(on, (event) => {
    if (event.type === "tandemTool") {
      return { type: "ask", ask: "ask-1", title: "Publish?", message: "Opens a PR." };
    }
    if (event.type === "askAnswer") {
      return { type: "toolResult", text: `published: ${event.allowed}`, isError: false };
    }
    return DONE;
  });
  const asked: string[] = [];
  on("tool.call", (_$, e) => {
    const question = e.tool === "AskUserQuestion" ? (e.questions[0]?.question ?? "") : "";
    asked.push(question);
    return { result: { answers: { [question]: "Allow" } } };
  });
  await $.session.start(start);
  const result = await $.tool.call({
    tool: "mcp__tandem__tandem",
    tool_use_id: "toolu_9",
    request: { action: "publish", taskId: "T-1" },
  });
  expect(result).toEqual({ result: "published: true" });
  expect(asked).toEqual(["Publish?\n\nOpens a PR."]);
  expect(posted.slice(1)).toEqual([
    { type: "tandemTool", id: "toolu_9", input: { request: { action: "publish", taskId: "T-1" } } },
    { type: "askAnswer", ask: "ask-1", allowed: true },
  ]);
});

test("a typed prompt Tandem handles never reaches the model", async ($, on) => {
  const { submitted } = sidecar(on, (event) =>
    event.type === "userPrompt" ? { type: "promptRoute", handled: true } : DONE,
  );
  await $.session.start(start);
  const result = await $.prompt.submit({
    text: "https://github.com/o/r/pull/1",
    origin: { kind: "composer" },
    wait: false,
  });
  expect(result).toMatchObject({ drop: "Handled by Tandem." });
  expect(submitted).toEqual([]);
});

test("a typed turn carries held deliveries, the coordinator section, and its answer back", async ($, on) => {
  const { posted } = sidecar(on, (event) => {
    if (event.type === "userPrompt") return { type: "promptRoute", handled: false };
    if (event.type === "agentStart") {
      return { type: "turnContext", system: ["You coordinate."], context: ["T-1 is done."] };
    }
    return DONE;
  });
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("prompt.compose", () => ({ sections: [{ id: "base", text: "Base.", scope: "session" }] }));
  on("turn.complete", () => ({ text: "" }));
  await $.session.start(start);
  const entered = await $.prompt.submit({
    text: "status?",
    origin: { kind: "composer" },
    wait: false,
  });
  expect(entered).toMatchObject({ context: ["T-1 is done."] });
  await $.turn.start({ text: "status?", turnId: "turn-1" });
  const composed = await $.prompt.compose({
    model: "claude-sonnet-5-5",
    promptModel: "claude-sonnet-5-5",
    surfaces: ["terminal"],
    tools: [],
    outputStyle: null,
    traits: [],
  });
  expect(composed.sections).toEqual([
    { id: "base", text: "Base.", scope: "session" },
    { id: "tandem:coordinator", text: "You coordinate.", scope: "session" },
  ]);
  await $.turn.complete({
    turnId: "turn-1",
    answer: "Nothing is running.",
    durationMs: 10,
    isAborted: false,
    reason: "answer",
    usage: {
      model: "claude-sonnet-5-5",
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  expect(posted.slice(1).map((event) => event.type)).toEqual([
    "userPrompt",
    "agentStart",
    "turnStart",
    "turnEnd",
    "agentEnd",
  ]);
  expect(posted.at(-2)).toEqual({
    type: "turnEnd",
    usage: {
      model: "claude-sonnet-5-5",
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    },
    contextTokens: 9_000,
  });
  expect(posted.at(-1)).toEqual({
    type: "agentEnd",
    interrupted: false,
    prompt: "status?",
    answer: "Nothing is running.",
  });
});

test("a wake Tandem submitted starts its run with its turn", async ($, on) => {
  const { posted } = sidecar(on, (event) =>
    event.type === "agentStart"
      ? { type: "turnContext", system: ["You coordinate."], context: ["Held."] }
      : DONE,
  );
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("prompt.compose", () => ({ sections: [] }));
  await $.session.start(start);
  await $.turn.start({ text: "Task T-1 finished.", turnId: "turn-2" });
  const composed = await $.prompt.compose({
    model: "m",
    promptModel: "m",
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: [],
  });
  expect(composed.sections).toEqual([
    { id: "tandem:coordinator", text: "You coordinate.\n\nHeld.", scope: "session" },
  ]);
  expect(posted.slice(1).map((event) => event.type)).toEqual(["agentStart", "turnStart"]);
});

test("the sidecar's lines are shown, submitted, and toasted in order", async ($, on) => {
  const { shown, submitted, toasts, effectsDone } = sidecar(on, () => DONE, {
    effects: [
      { type: "log", text: "T-1 finished." },
      { type: "submit", text: "[hidden]\n\nT-1 finished." },
      { type: "toast", text: "T-2 needs you.", level: "info" },
    ],
  });
  await $.session.start(start);
  await effectsDone;
  expect(shown).toEqual(["T-1 finished."]);
  expect(submitted).toEqual(["[hidden]\n\nT-1 finished."]);
  expect(toasts).toEqual(["T-2 needs you."]);
});

test("compaction keeps its own instructions and adds Tandem's, then reports it compacted", async ($, on) => {
  const { posted } = sidecar(on, (event) =>
    event.type === "compacting" ? { type: "compaction", instructions: "Keep T-1." } : DONE,
  );
  const instructions: (string | undefined)[] = [];
  on("session.compact", (_$, e) => {
    instructions.push(e.instructions);
    return { messages: [{ role: "user", text: "Summary.", toolUses: [] }] };
  });
  await $.session.start(start);
  await $.session.compact({
    trigger: "manual",
    instructions: "Mine.",
    messages: [{ role: "user", text: "status?", toolUses: [] }],
  });
  expect(instructions).toEqual(["Mine.\n\nKeep T-1."]);
  expect(posted.slice(1).map((event) => event.type)).toEqual(["compacting", "compacted"]);
});

test("the session's end stops the sidecar, but /clear keeps it", async ($, on) => {
  const { posted } = sidecar(on, () => DONE);
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  await $.session.start(start);
  await $.session.end({ reason: "clear", sessionId: "session-1", resume: { id: "session-1" } });
  expect(posted.slice(1)).toEqual([]);
  await $.session.end({
    reason: "prompt_input_exit",
    sessionId: "session-1",
    resume: { id: "session-1" },
  });
  expect(posted.slice(1)).toEqual([{ type: "shutdown" }]);
});

test("a compaction the sidecar asks for asks for Tandem's instructions once", async ($, on) => {
  const { promise: compacted, resolve: finish } = Promise.withResolvers<void>();
  const { posted } = sidecar(
    on,
    (event) => {
      if (event.type === "compacted") finish();
      return event.type === "compacting" ? { type: "compaction", instructions: "Keep T-1." } : DONE;
    },
    { effects: [{ type: "compact" }] },
  );
  const instructions: (string | undefined)[] = [];
  on("session.compact", (_$, e) => {
    instructions.push(e.instructions);
    return { messages: [{ role: "user", text: "Summary.", toolUses: [] }] };
  });
  await $.session.start(start);
  await compacted;
  expect(instructions).toEqual(["Keep T-1."]);
  expect(posted.slice(1).map((event) => event.type)).toEqual(["compacting", "compacted"]);
});
