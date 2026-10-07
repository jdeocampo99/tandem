import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import { runWelcome, WELCOME_PROMPT, WELCOME_TEXT } from "../../src/terminal/welcome.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";

function keyboard(): PassThrough {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => input });
  return input;
}

function recorder(agentPromptCode = 0) {
  const ran: string[][] = [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    ran.push([...request.argv]);
    const agentPrompt = request.argv.includes("agent");
    return { code: agentPrompt ? agentPromptCode : 0, stdout: "", stderr: "" };
  };
  return { ran, run };
}

const popup = { HERDR_SESSION: "tandem", TANDEM_WELCOME_PANE: "w1:p1" };

test("Enter in the welcome popup asks the Tandem coordinator to start onboarding", async () => {
  const input = keyboard();
  const { ran, run } = recorder();
  const printed: string[] = [];
  const done = runWelcome({
    input,
    stdout: (text) => printed.push(text),
    terminal: terminalBackend(run, { terminal: "herdr" }),
    environment: popup,
    cwd: "/tmp",
  });
  input.write("x");
  input.write("\r");
  await done;
  // The popup's title bar already says "Welcome to Tandem", so the text starts after it.
  expect(printed.join("")).toStartWith("Tandem runs a team of agents");
  expect(printed.join("")).not.toContain("Welcome to Tandem");
  expect(printed.join("")).toContain("Press Enter to start");
  expect(ran).toEqual([
    ["herdr", "--session", "tandem", "agent", "prompt", "w1:p1", WELCOME_PROMPT],
  ]);
});

test("the prompt is typed into the pane when Herdr sees no agent there", async () => {
  const input = keyboard();
  const { ran, run } = recorder(1);
  const done = runWelcome({
    input,
    stdout: () => undefined,
    terminal: terminalBackend(run, { terminal: "herdr" }),
    environment: popup,
    cwd: "/tmp",
  });
  input.write("\r");
  await done;
  expect(ran.slice(1)).toEqual([
    ["herdr", "--session", "tandem", "pane", "send-text", "w1:p1", WELCOME_PROMPT],
    ["herdr", "--session", "tandem", "pane", "send-keys", "w1:p1", "enter"],
  ]);
});

test("Esc closes the welcome popup without sending anything", async () => {
  const input = keyboard();
  const { ran, run } = recorder();
  const done = runWelcome({
    input,
    stdout: () => undefined,
    terminal: terminalBackend(run, { terminal: "herdr" }),
    environment: popup,
    cwd: "/tmp",
  });
  input.write("\x1b");
  await done;
  expect(ran).toEqual([]);
});

test("outside the popup, tandem welcome only prints the message", async () => {
  const { ran, run } = recorder();
  const printed: string[] = [];
  await runWelcome({
    input: keyboard(),
    stdout: (text) => printed.push(text),
    terminal: terminalBackend(run, { terminal: "herdr" }),
    environment: {},
    cwd: "/tmp",
  });
  expect(printed).toEqual([`${WELCOME_TEXT}\n`]);
  expect(ran).toEqual([]);
});

test("every welcome line fits inside the popup without wrapping", async () => {
  const manifest = Bun.TOML.parse(
    await Bun.file(new URL("../../herdr-plugin/herdr-plugin.toml", import.meta.url)).text(),
  ) as { panes: { width: number }[] };
  const width = manifest.panes[0]?.width ?? 0;
  // The border and Herdr's padding take a few cells on each side.
  const usable = width - 6;
  const input = keyboard();
  const printed: string[] = [];
  const done = runWelcome({
    input,
    stdout: (text) => printed.push(text),
    terminal: terminalBackend(recorder().run, { terminal: "herdr" }),
    environment: popup,
    cwd: "/tmp",
  });
  input.write("\x1b");
  await done;
  const longest = Math.max(
    ...printed
      .join("")
      .split("\n")
      .map((line) => line.length),
  );
  expect(longest).toBeLessThanOrEqual(usable);
});
