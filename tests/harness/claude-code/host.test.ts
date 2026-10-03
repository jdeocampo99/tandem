import { expect, test } from "bun:test";
import {
  ClaudeCodePane,
  claudeCodeEffect,
  claudeCodeToolCall,
  UNSUPPORTED_EFFECTS,
} from "../../../src/harness/claude-code/host.ts";
import type { SidecarLine } from "../../../src/harness/claude-code/protocol.ts";
import { HookCalls } from "../../../src/harness/claude-code/sidecar.ts";
import { WorkerOutputError } from "../../../src/workers/protocol.ts";

const wake = {
  type: "deliver",
  source: "notification",
  text: "Owner decision required.",
  hidden: { text: "task task-1, notification blocked-1" },
  timing: "followUp",
  triggerTurn: true,
} as const;

test("a wake is shown once and submitted to the model with its hidden part first", () => {
  expect(claudeCodeEffect(wake)).toEqual({
    lines: [
      { type: "log", text: "Owner decision required." },
      { type: "submit", text: "task task-1, notification blocked-1\n\nOwner decision required." },
    ],
  });
});

test("a delivery that does not wake the model is shown now and held for its next turn", () => {
  for (const timing of ["followUp", "nextTurn", "aside"] as const) {
    expect(claudeCodeEffect({ ...wake, timing, triggerTurn: false })).toEqual({
      lines: [{ type: "log", text: "Owner decision required." }],
      nextTurn: "task task-1, notification blocked-1\n\nOwner decision required.",
    });
  }
});

test("each other core effect maps to what a mod can do, and session exit is refused", () => {
  expect(
    claudeCodeEffect({ type: "promptAsUser", text: "From Lavish", deliverAs: "aside" }),
  ).toEqual({ lines: [{ type: "submit", text: "From Lavish" }] });
  expect(claudeCodeEffect({ type: "notify", text: "Task finished.", level: "error" })).toEqual({
    lines: [{ type: "toast", text: "Task finished.", level: "error" }],
  });
  expect(
    claudeCodeEffect({ type: "recordEntry", entryType: "tandem-digest", data: { digest: "" } }),
  ).toEqual({ lines: [] });
  expect(claudeCodeEffect({ type: "compact" })).toEqual({ lines: [{ type: "compact" }] });
  expect(claudeCodeEffect({ type: "abort" })).toEqual({ lines: [{ type: "abort" }] });
  expect(() => claudeCodeEffect({ type: "shutdown" })).toThrow(UNSUPPORTED_EFFECTS.shutdown);
});

test("Claude Code tools become the kinds the core's guards read", () => {
  expect(claudeCodeToolCall({ id: "1", name: "Read", input: { file_path: "src/a.ts" } })).toEqual({
    id: "1",
    name: "Read",
    kind: "read",
    path: "src/a.ts",
  });
  expect(
    claudeCodeToolCall({ id: "2", name: "WebFetch", input: { url: "https://x.dev", prompt: "?" } }),
  ).toMatchObject({ kind: "read", path: "https://x.dev" });
  expect(claudeCodeToolCall({ id: "3", name: "Bash", input: { command: "ls" } })).toMatchObject({
    kind: "shell",
    command: "ls",
  });
  expect(claudeCodeToolCall({ id: "4", name: "mcp__linear__get_issue", input: {} })).toEqual({
    id: "4",
    name: "mcp__linear__get_issue",
    kind: "mcp",
    mcpTool: "mcp__linear__get_issue",
  });
  expect(claudeCodeToolCall({ id: "5", name: "Mystery", input: {} }).kind).toBe("other");
});

function pane(confirm: (title: string, message: string) => Promise<boolean> = async () => false) {
  const lines: SidecarLine[] = [];
  return { lines, pane: new ClaudeCodePane({ write: (line) => lines.push(line), confirm }) };
}

test("the pane writes effects as lines and reports queued submits until a run starts", async () => {
  const { lines, pane: claude } = pane();
  expect(claude.host.paneState()).toEqual({ idle: true, pendingMessages: false, draft: false });

  await claude.host.perform(wake);
  expect(lines.map((line) => line.type)).toEqual(["log", "submit"]);
  expect(claude.host.paneState().pendingMessages).toBe(true);

  claude.observe({ type: "agentStart" });
  expect(claude.host.paneState()).toEqual({ idle: false, pendingMessages: false, draft: false });
  claude.observe({ type: "agentEnd", interrupted: false });
  expect(claude.host.paneState().idle).toBe(true);
  await expect(claude.host.perform({ type: "shutdown" })).rejects.toThrow(
    UNSUPPORTED_EFFECTS.shutdown,
  );
});

test("held deliveries reach the model once, at the next turn", async () => {
  const { pane: claude } = pane();
  const { hidden: _hidden, ...shown } = wake;
  await claude.host.perform({ ...shown, triggerTurn: false });
  expect(claude.takeNextTurn()).toEqual(["Owner decision required."]);
  expect(claude.takeNextTurn()).toEqual([]);
});

test("context size and the running model come from what the mod reported", () => {
  const { pane: claude } = pane();
  expect(claude.host.contextTokens()).toBeUndefined();
  expect(() => claude.host.assertSelectedModel("claude-code/opus")).toThrow(WorkerOutputError);

  claude.observe({ type: "sessionStart", model: "claude-opus-5-5" });
  claude.observe({ type: "turnEnd", contextTokens: 120_000 });
  expect(claude.host.contextTokens()).toBe(120_000);
  expect(() => claude.host.assertSelectedModel("claude-code/opus")).not.toThrow();
  expect(() => claude.host.assertSelectedModel("claude-code/sonnet")).toThrow(
    "Claude Code runs claude-opus-5-5, not claude-code/sonnet",
  );
  expect(() => claude.host.assertSelectedModel("anthropic/opus")).toThrow(WorkerOutputError);
  expect(claude.host.mcpToolPrefix("linear")).toBe("mcp__linear__");
});

test("a confirm inside a hook is asked through the hook's reply and resumes on the answer", async () => {
  const hooks = new HookCalls();
  const asked = hooks.start(async () => {
    const allowed = await hooks.confirm("Publish?", "Open a PR for task-1");
    return { type: "toolResult", text: allowed ? "published" : "declined", isError: false };
  });
  const ask = await asked;
  expect(ask).toEqual({
    type: "ask",
    ask: "ask-1",
    title: "Publish?",
    message: "Open a PR for task-1",
  });
  if (ask.type !== "ask") throw new Error("expected an ask");

  expect(await hooks.answer(ask.ask, true)).toEqual({
    type: "toolResult",
    text: "published",
    isError: false,
  });
  expect(await hooks.answer(ask.ask, true)).toEqual({
    type: "refused",
    reason: "no question ask-1 is waiting",
  });
});

test("a confirm outside any hook, or one left unanswered at shutdown, is a refusal", async () => {
  const hooks = new HookCalls();
  expect(await hooks.confirm("Publish?", "Open a PR")).toBe(false);

  let answered: boolean | undefined;
  const asked = hooks.start(async () => {
    answered = await hooks.confirm("Merge?", "Merge task-1");
    return { type: "done" };
  });
  expect((await asked).type).toBe("ask");
  hooks.denyAll();
  await Bun.sleep(0);
  expect(answered).toBe(false);
});

test("a hook with no question returns its reply directly", async () => {
  const hooks = new HookCalls();
  expect(await hooks.start(async () => ({ type: "promptRoute", handled: false }))).toEqual({
    type: "promptRoute",
    handled: false,
  });
});
