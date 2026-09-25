import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
  copyMockupAsset,
  isBackgroundResultWake,
  OmpWorkerPane,
  ompWorkerToolCall,
} from "../../src/workers/terminal-extension.ts";

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

test("copy_asset copies a checkout file byte for byte and refuses anything outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-copy-asset-"));
  try {
    const cwd = join(root, "worktree");
    const artifactDir = join(root, "presentation");
    await mkdir(join(cwd, "public"), { recursive: true });
    await mkdir(artifactDir);
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10, 0x80]);
    await writeFile(join(cwd, "public", "jr.webp"), bytes);
    const target = await copyMockupAsset({
      cwd,
      artifactDir,
      from: "public/jr.webp",
      name: "jr.webp",
    });
    expect(target).toBe(join(artifactDir, "jr.webp"));
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);

    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(cwd, "public", "link.txt"));
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "../secret.txt", name: "secret.txt" }),
    ).rejects.toThrow("inside the repository checkout");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public/link.txt", name: "link.txt" }),
    ).rejects.toThrow("inside the repository checkout");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public/jr.webp", name: "../jr.webp" }),
    ).rejects.toThrow("plain file name");
    await expect(
      copyMockupAsset({ cwd, artifactDir, from: "public", name: "dir" }),
    ).rejects.toThrow("regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
