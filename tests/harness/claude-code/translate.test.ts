import { expect, test } from "bun:test";
import {
  agentEndEvent,
  compactionInstructions,
  costDelta,
  endsSidecar,
  isOwnPrompt,
  LineReader,
  logLines,
  promptHandled,
  sidecarArgv,
  stopBlock,
  TurnLedger,
  tandemToolAnswer,
  tandemToolEvent,
  toolRefusal,
  turnEndEvent,
  userPromptEvent,
  wireToolCall,
} from "../../../src/harness/claude-code/plugins/tandem/hooks/translate.ts";

test("the sidecar runs from the checkout that holds the plugin", () => {
  expect(sidecarArgv("/tandem/src/harness/claude-code/plugins/tandem", "s-1")).toEqual([
    "bun",
    "/tandem/src/harness/claude-code/plugins/tandem/../../sidecar.ts",
    "--role",
    "coordinator",
    "--session",
    "s-1",
  ]);
});

test("output pieces become whole lines, holding back a line until its newline arrives", () => {
  const lines = new LineReader();
  expect(lines.push('{"type":"re')).toEqual([]);
  expect(lines.push('ady"}\n{"type":"log"')).toEqual(['{"type":"ready"}']);
  expect(lines.push(',"text":"hi"}\n\n')).toEqual(['{"type":"log","text":"hi"}']);
});

test("a typed prompt is interactive and counts its attachments; Tandem's own wakes are skipped", () => {
  const typed = { text: "status?", origin: { kind: "composer" }, attachments: [{}, {}] };
  expect(userPromptEvent(typed)).toEqual({
    type: "userPrompt",
    text: "status?",
    interactive: true,
    attachments: 2,
  });
  expect(userPromptEvent({ text: "hi", origin: { kind: "sdk" } })).toMatchObject({
    interactive: false,
    attachments: 0,
  });
  expect(isOwnPrompt({ text: "wake", origin: { kind: "plugin", name: "tandem" } })).toBe(true);
  expect(isOwnPrompt({ text: "x", origin: { kind: "plugin", name: "other" } })).toBe(false);
  expect(promptHandled({ type: "promptRoute", handled: true })).toBe(true);
  expect(promptHandled({ type: "refused", reason: "down" })).toBe(false);
});

test("a tool call's arguments are every field Claude Code does not reserve", () => {
  const call = {
    tool: "Read",
    tool_use_id: "toolu_1",
    consent: "c",
    agentId: "a",
    file_path: "src/a.ts",
  };
  expect(wireToolCall(call)).toEqual({
    id: "toolu_1",
    name: "Read",
    input: { file_path: "src/a.ts" },
  });
  expect(
    tandemToolEvent({ tool: "mcp__tandem__tandem", tool_use_id: "toolu_2", request: { a: 1 } }),
  ).toEqual({ type: "tandemTool", id: "toolu_2", input: { request: { a: 1 } } });
});

test("a tool runs only when the guard clears it; a refusal or an odd reply denies it", () => {
  expect(toolRefusal({ type: "toolDecision", block: false })).toBeUndefined();
  expect(toolRefusal({ type: "toolDecision", block: true, reason: "No edits." })).toBe("No edits.");
  expect(toolRefusal({ type: "refused", reason: "socket gone" })).toBe(
    "Tandem could not check this tool call, so it did not run: socket gone",
  );
  expect(toolRefusal({ type: "done" })).toContain("did not run");
});

test("the tandem tool answers with its result, and an error or refusal denies the call", () => {
  expect(tandemToolAnswer({ type: "toolResult", text: "0 tasks", isError: false })).toEqual({
    result: "0 tasks",
  });
  expect(tandemToolAnswer({ type: "toolResult", text: "bad input", isError: true })).toEqual({
    deny: "bad input",
  });
  expect(tandemToolAnswer({ type: "refused", reason: "socket gone" })).toEqual({
    deny: "Tandem is not available: socket gone",
  });
});

test("a typed prompt's run starts before its turn, and a wake's run starts with its turn", () => {
  const turns = new TurnLedger();
  turns.promptStarted({ system: ["Coordinate."], context: ["held"] });
  expect(turns.begin("status?", "t-1")).toBe(true);
  expect(turns.section()).toEqual({
    id: "tandem:coordinator",
    text: "Coordinate.",
    scope: "session",
  });
  expect(turns.runningTurnId()).toBe("t-1");
  expect(turns.end()).toBe("status?");
  expect(turns.section()).toBeUndefined();

  expect(turns.begin("Task T-1 finished.", "t-2")).toBe(false);
  turns.turnStarted({ system: ["Coordinate."], context: ["Held delivery."] });
  expect(turns.section()?.text).toBe("Coordinate.\n\nHeld delivery.");
  expect(turns.end()).toBe("Task T-1 finished.");

  expect(turns.begin("", "t-3")).toBe(false);
  expect(turns.end()).toBeUndefined();
});

test("a turn's cost is the rise in the session's cost, or zero when that is unknown", () => {
  expect(costDelta(1.25, 1.5)).toBe(0.25);
  expect(costDelta(undefined, 1.5)).toBe(0);
  expect(costDelta(1.5, undefined)).toBe(0);
  expect(costDelta(2, 0.5)).toBe(0);
});

test("a finished turn reports its usage, context size, prompt, answer, and how it ended", () => {
  const usage = {
    model: "claude-sonnet-5-5",
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  };
  expect(turnEndEvent(usage, 0.5, 9_000)).toEqual({
    type: "turnEnd",
    usage: {
      model: "claude-sonnet-5-5",
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      costUsd: 0.5,
    },
    contextTokens: 9_000,
  });
  expect(turnEndEvent(undefined, 0, undefined)).toEqual({ type: "turnEnd" });
  expect(agentEndEvent({ answer: "Done.", isAborted: false, reason: "answer" }, "status?")).toEqual(
    { type: "agentEnd", interrupted: false, prompt: "status?", answer: "Done." },
  );
  expect(agentEndEvent({ answer: "", isAborted: true, reason: "aborted" }, undefined)).toEqual({
    type: "agentEnd",
    interrupted: true,
    answer: "",
  });
  expect(
    agentEndEvent(
      { answer: "", isAborted: false, reason: "refusal", refusal: { explanation: "policy" } },
      undefined,
    ),
  ).toMatchObject({ failure: "the model refused: policy" });
  expect(agentEndEvent({ answer: "", isAborted: false, reason: "error" }, undefined)).toMatchObject(
    { failure: "the turn ended with an error" },
  );
});

test("stop, compaction, and session end follow the sidecar's replies", () => {
  expect(stopBlock({ type: "stop" })).toBeUndefined();
  expect(stopBlock({ type: "stop", continueWith: "Submit your report." })).toBe(
    "Submit your report.",
  );
  expect(stopBlock({ type: "refused", reason: "down" })).toBeUndefined();
  expect(compactionInstructions({ type: "compaction", instructions: "Keep T-1." }, "Mine.")).toBe(
    "Mine.\n\nKeep T-1.",
  );
  expect(compactionInstructions({ type: "refused", reason: "down" }, "Mine.")).toBe("Mine.");
  expect(compactionInstructions({ type: "compaction", instructions: "" }, undefined)).toBe(
    undefined,
  );
  expect(endsSidecar("prompt_input_exit")).toBe(true);
  expect(endsSidecar("clear")).toBe(false);
  expect(endsSidecar("resume")).toBe(false);
});

test("a shown text becomes one log row per line, without blank rows", () => {
  expect(logLines("Scout finished.\n\n- first finding\n- second finding\n")).toEqual([
    "Scout finished.",
    "- first finding",
    "- second finding",
  ]);
});
