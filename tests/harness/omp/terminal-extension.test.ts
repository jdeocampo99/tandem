import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
  isBackgroundResultWake,
  OmpWorkerPane,
  ompWorkerToolCall,
} from "../../../src/harness/omp/terminal-extension.ts";

test("only a finished background command's wake-up counts as a background wake", () => {
  const assistant = { role: "assistant", content: [], timestamp: 1 } as unknown as AgentMessage;
  const backgroundResult = {
    role: "custom",
    customType: "async-result",
    content: "bg_1 finished",
    display: true,
    timestamp: 2,
  } as unknown as AgentMessage;
  const typed = { role: "user", content: "one more thing", timestamp: 3 } as AgentMessage;
  const inbox = { ...typed, synthetic: true } as AgentMessage;

  expect(isBackgroundResultWake([assistant, backgroundResult])).toBe(true);
  // Tandem's inbox rendering is appended as a synthetic message and is not a new request.
  expect(isBackgroundResultWake([assistant, backgroundResult, inbox])).toBe(true);
  expect(isBackgroundResultWake([assistant, backgroundResult, typed])).toBe(false);
  expect(isBackgroundResultWake([assistant, inbox])).toBe(false);
  expect(isBackgroundResultWake([])).toBe(false);
});

test("OMP worker tools map to the kinds the worker guards match on", () => {
  const kinds: Record<string, string> = Object.fromEntries(
    [
      "read",
      "grep",
      "glob",
      "web_search",
      "write",
      "edit",
      "bash",
      "ask",
      "task",
      "copy_asset",
      "todo",
      "submit_report",
      "mcp__playwright_click",
      "fetch",
      "find",
      "toString",
    ].map((name) => [name, ompWorkerToolCall("call", name).kind]),
  );
  expect(kinds).toEqual({
    read: "read",
    grep: "search",
    glob: "search",
    web_search: "web-search",
    write: "write",
    edit: "edit",
    bash: "shell",
    ask: "ask",
    task: "subagent",
    copy_asset: "copy-asset",
    todo: "todo",
    submit_report: "other",
    mcp__playwright_click: "mcp",
    fetch: "other",
    find: "other",
    toString: "other",
  });
  // A write to an MCP resource is still a write: a scout's mockup guard must see its path.
  expect(ompWorkerToolCall("c", "write", { path: "xd://mcp__tool", content: "x" })).toEqual({
    id: "c",
    name: "write",
    kind: "write",
    path: "xd://mcp__tool",
  });
  expect(ompWorkerToolCall("c", "bash", { command: "git diff" }).command).toBe("git diff");
  expect(ompWorkerToolCall("c", "bash", { command: 7 }).command).toBeUndefined();
  expect(ompWorkerToolCall("c", "edit").path).toBeUndefined();
});

test("the OMP worker pane sends the stall reminder, prompts, and aborts on the latest context", async () => {
  const sent: unknown[] = [];
  const aborted: string[] = [];
  const pi = {
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
    sendUserMessage: (text: string) => sent.push({ user: text }),
  };
  const pane = new OmpWorkerPane(pi as never);
  await expect(pane.host.perform({ type: "abort" })).rejects.toThrow("no OMP context");
  pane.enter({ abort: () => aborted.push("first") } as never);
  pane.enter({ abort: () => aborted.push("second") } as never);
  await pane.host.perform({ type: "abort" });
  await pane.host.perform({ type: "promptAsUser", text: "Draw the mockup." });
  await pane.host.perform({
    type: "deliver",
    source: "stall-reminder",
    text: "Tandem stopped your turn.",
    timing: "nextTurn",
    triggerTurn: true,
  });
  expect(aborted).toEqual(["second"]);
  expect(sent).toEqual([
    { user: "Draw the mockup." },
    {
      message: {
        customType: "tandem-stall-reminder",
        content: "Tandem stopped your turn.",
        display: true,
        attribution: "agent",
      },
      options: { deliverAs: "nextTurn", triggerTurn: true },
    },
  ]);
  await expect(pane.host.perform({ type: "compact" })).rejects.toThrow("cannot perform compact");
});
