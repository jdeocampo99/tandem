import { expect, test } from "bun:test";
import {
  encodeWire,
  type HookReply,
  parseHookReply,
  parseSidecarEvent,
  parseSidecarLine,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarEvent,
  type SidecarLine,
} from "../../../src/harness/claude-code/protocol.ts";

const call = { id: "toolu_1", name: "Read", input: { file_path: "src/a.ts" } };

const EVENTS: readonly SidecarEvent[] = [
  { type: "sessionStart", model: "claude-opus-5-5" },
  { type: "userPrompt", text: "status?", interactive: true, attachments: 0 },
  { type: "agentStart" },
  { type: "turnStart" },
  { type: "toolCall", call },
  { type: "tandemTool", id: "toolu_2", input: { request: { action: "list" } } },
  { type: "toolStart", call },
  { type: "toolEnd", call },
  { type: "turnEnd" },
  {
    type: "turnEnd",
    usage: {
      model: "claude-opus-5-5",
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      costUsd: 0.25,
    },
    contextTokens: 4_000,
  },
  { type: "agentEnd", interrupted: false },
  { type: "agentEnd", interrupted: true, failure: "rate limited" },
  { type: "stopRequested", aborted: false },
  { type: "compacting" },
  { type: "compacted" },
  { type: "shutdown" },
  { type: "askAnswer", ask: "ask-1", allowed: true },
];

test("every event survives encoding and parsing unchanged", () => {
  for (const event of EVENTS) {
    expect(parseSidecarEvent(encodeWire(event))).toEqual({ ok: true, value: event });
  }
});

test("malformed or unknown events are refused with the reason", () => {
  const refusals: ReadonlyArray<readonly [string, string]> = [
    ["{", "event is not JSON"],
    ["[]", "event must be a JSON object"],
    ['{"type":"streaming"}', 'unknown event type "streaming"'],
    ['{"type":"contextBuild"}', 'unknown event type "contextBuild"'],
    ['{"type":"agentStart","extra":1}', "agentStart event has unknown fields: extra"],
    ['{"type":"sessionStart","model":" "}', "sessionStart event.model must not be empty"],
    [
      '{"type":"userPrompt","text":"hi","interactive":"yes","attachments":0}',
      "userPrompt event.interactive must be true or false",
    ],
    [
      '{"type":"userPrompt","text":"hi","interactive":true,"attachments":-1}',
      "userPrompt event.attachments must be a whole number of zero or more",
    ],
    [
      '{"type":"toolCall","call":{"id":"t","name":"Read","input":[]}}',
      "toolCall event.call must be a JSON object",
    ],
    [
      '{"type":"toolCall","call":{"id":"t","name":"Read","input":{},"kind":"read"}}',
      "toolCall event.call has unknown fields: kind",
    ],
    [
      '{"type":"turnEnd","usage":{"model":"m","input":1,"output":1,"cacheRead":0,"cacheWrite":0,"costUsd":-1}}',
      "turnEnd event.usage.costUsd must be a number of zero or more",
    ],
  ];
  for (const [body, reason] of refusals) {
    expect(parseSidecarEvent(body)).toEqual({ ok: false, reason });
  }
});

test("a hook reply parses only for the event that can get it", () => {
  const replies: ReadonlyArray<readonly [Parameters<typeof parseHookReply>[0], HookReply]> = [
    ["sessionStart", { type: "done" }],
    ["toolCall", { type: "toolDecision", block: false }],
    ["toolCall", { type: "toolDecision", block: true, reason: "Research is running." }],
    ["userPrompt", { type: "promptRoute", handled: true }],
    ["agentStart", { type: "turnContext", system: ["You are Tandem."], context: [] }],
    ["tandemTool", { type: "toolResult", text: "list returned 0 task(s).", isError: false }],
    ["stopRequested", { type: "stop" }],
    ["stopRequested", { type: "stop", continueWith: "Submit your report." }],
    ["compacting", { type: "compaction", instructions: "Keep the digest." }],
    ["tandemTool", { type: "ask", ask: "ask-1", title: "Publish?", message: "Open a PR" }],
    ["turnEnd", { type: "refused", reason: "the store is locked" }],
  ];
  for (const [event, reply] of replies) {
    expect(parseHookReply(event, encodeWire(reply))).toEqual({ ok: true, value: reply });
  }
  expect(parseHookReply("toolCall", encodeWire({ type: "done" }))).toEqual({
    ok: false,
    reason: "a toolCall event cannot be answered with done",
  });
  expect(parseHookReply("toolCall", '{"type":"toolDecision","block":false,"reason":"x"}')).toEqual({
    ok: false,
    reason: "toolDecision reply has unknown fields: reason",
  });
  expect(parseHookReply("toolCall", '{"type":"toolDecision","block":true}')).toEqual({
    ok: false,
    reason: "toolDecision reply.reason must be text",
  });
});

test("stdout lines round-trip, and a line from another protocol version is refused", () => {
  const lines: readonly SidecarLine[] = [
    { type: "ready", protocol: SIDECAR_PROTOCOL_VERSION, socket: "/h/sidecars/a.sock", pid: 42 },
    { type: "fatal", protocol: SIDECAR_PROTOCOL_VERSION, reason: "no home" },
    { type: "submit", text: "Owner decision required." },
    { type: "log", text: "Welcome to Tandem" },
    { type: "toast", text: "Task finished.", level: "info" },
    { type: "abort" },
    { type: "compact" },
  ];
  for (const line of lines) {
    const encoded = encodeWire(line);
    expect(encoded).not.toContain("\n");
    expect(parseSidecarLine(encoded)).toEqual({ ok: true, value: line });
  }
  expect(parseSidecarLine('{"type":"ready","protocol":2,"socket":"/s","pid":1}')).toEqual({
    ok: false,
    reason: `the sidecar speaks protocol 2, and this mod speaks ${SIDECAR_PROTOCOL_VERSION}`,
  });
  expect(parseSidecarLine('{"type":"shutdown"}')).toEqual({
    ok: false,
    reason: 'unknown line type "shutdown"',
  });
  expect(parseSidecarLine('{"type":"toast","text":"x","level":"warn"}')).toEqual({
    ok: false,
    reason: 'toast line.level must be "info" or "error"',
  });
  expect(parseSidecarLine("Tandem started")).toEqual({ ok: false, reason: "line is not JSON" });
});
