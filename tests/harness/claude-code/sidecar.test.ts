import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TANDEM_CHECKOUT } from "../../../src/coordinator/tandem-checkout.ts";
import {
  type HookEventType,
  type HookReply,
  parseHookReply,
  parseSidecarLine,
  type SidecarEvent,
  type SidecarLine,
} from "../../../src/harness/claude-code/protocol.ts";
import { claimSocket } from "../../../src/harness/claude-code/sidecar.ts";
import { sidecarSocketPath } from "../../../src/harness/claude-code/socket.ts";

const SIDECAR = join(TANDEM_CHECKOUT, "src", "harness", "claude-code", "sidecar.ts");

/** Under /tmp, not the platform temp dir: macOS caps a socket path at 104 bytes. */
async function tempDir(): Promise<string> {
  return mkdtemp("/tmp/tandem-sidecar-");
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Running = Readonly<{
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  socket: string;
  home: string;
  /** Resolves with the next stdout line, parsed; every line must be a protocol line. */
  nextLine(): Promise<SidecarLine>;
  post(event: SidecarEvent): Promise<Readonly<{ status: number; reply: HookReply }>>;
}>;

function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<SidecarLine> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stdout ended with ${JSON.stringify(buffered)} unread`);
      buffered += decoder.decode(value, { stream: true });
    }
    const end = buffered.indexOf("\n");
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    const parsed = parseSidecarLine(line);
    if (!parsed.ok) throw new Error(`not a protocol line: ${line} (${parsed.reason})`);
    return parsed.value;
  };
}

async function startSidecar(cwd: string, home?: string): Promise<Running> {
  const root = await tempDir();
  const tandemHome = home ?? join(root, "home");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const child = Bun.spawn(["bun", SIDECAR, "--role", "coordinator", "--session", "session-1"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      TANDEM_HOME: tandemHome,
      ...(process.env.TANDEM_IN_PROCESS_STORE_LOCK === undefined
        ? {}
        : { TANDEM_IN_PROCESS_STORE_LOCK: process.env.TANDEM_IN_PROCESS_STORE_LOCK }),
    },
  });
  cleanups.push(async () => {
    child.kill("SIGKILL");
    await child.exited;
  });
  const nextLine = lineReader(child.stdout);
  const ready = await nextLine();
  if (ready.type !== "ready") throw new Error(`sidecar did not start: ${JSON.stringify(ready)}`);
  const post = async (event: SidecarEvent) => {
    const response = await fetch("http://sidecar/event", {
      method: "POST",
      body: JSON.stringify(event),
      unix: ready.socket,
    });
    return { status: response.status, reply: (await response.json()) as HookReply };
  };
  return { process: child, socket: ready.socket, home: tandemHome, nextLine, post };
}

async function gitRepo(): Promise<string> {
  const repo = join(await tempDir(), "repo");
  cleanups.push(() => rm(join(repo, ".."), { recursive: true, force: true }));
  await mkdir(repo);
  await Bun.spawn(["git", "init", "-q", repo]).exited;
  return repo;
}

function expectReply(event: HookEventType, reply: HookReply): void {
  expect(parseHookReply(event, JSON.stringify(reply)).ok).toBe(true);
}

test("the sidecar announces its socket under the home and answers events over it", async () => {
  const sidecar = await startSidecar(await gitRepo());
  expect(sidecar.socket).toBe(sidecarSocketPath(sidecar.home, "session-1"));

  const started = await sidecar.post({ type: "sessionStart", model: "claude-opus-5-5" });
  expect(started).toEqual({ status: 200, reply: { type: "done" } });

  const listed = await sidecar.post({
    type: "tandemTool",
    id: "toolu_1",
    input: { request: { action: "list" } },
  });
  expect(listed).toEqual({
    status: 200,
    reply: { type: "toolResult", text: "list returned 0 task(s).", isError: false },
  });

  const read = await sidecar.post({
    type: "toolCall",
    call: { id: "toolu_2", name: "WebFetch", input: { url: "https://example.com" } },
  });
  expect(read.reply).toMatchObject({ type: "toolDecision", block: true });
  expectReply("toolCall", read.reply);

  const turn = await sidecar.post({ type: "agentStart" });
  expect(turn.reply).toMatchObject({ type: "turnContext", context: [] });
  expectReply("agentStart", turn.reply);
});

test("malformed events and unknown questions are refused without reaching the session", async () => {
  const sidecar = await startSidecar(await gitRepo());
  const malformed = await fetch("http://sidecar/event", {
    method: "POST",
    body: '{"type":"contextBuild"}',
    unix: sidecar.socket,
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({
    type: "refused",
    reason: 'unknown event type "contextBuild"',
  });
  expect(await sidecar.post({ type: "askAnswer", ask: "ask-9", allowed: true })).toEqual({
    status: 200,
    reply: { type: "refused", reason: "no question ask-9 is waiting" },
  });
  const tool = await sidecar.post({ type: "tandemTool", id: "toolu_1", input: { action: "list" } });
  expect(tool.reply).toMatchObject({ type: "toolResult", isError: true });
});

test("a delivery from the core arrives as stdout lines and reaches the model at the next turn", async () => {
  // The Tandem coordinator greets a home with no projects; with no Herdr pane the greeting falls
  // back to a chat delivery that does not wake the model.
  const sidecar = await startSidecar(TANDEM_CHECKOUT);
  await sidecar.post({ type: "sessionStart", model: "claude-opus-5-5" });
  const greeting = await sidecar.nextLine();
  expect(greeting).toMatchObject({
    type: "log",
    text: expect.stringContaining("Welcome to Tandem"),
  });

  const turn = await sidecar.post({ type: "agentStart" });
  if (turn.reply.type !== "turnContext") throw new Error(JSON.stringify(turn.reply));
  expect(turn.reply.context[0]).toContain("Welcome to Tandem");
  const next = await sidecar.post({ type: "agentStart" });
  expect(next.reply).toMatchObject({ type: "turnContext", context: [] });
}, 30_000);

test("SIGTERM stops the sidecar and removes its socket", async () => {
  const sidecar = await startSidecar(await gitRepo());
  expect(existsSync(sidecar.socket)).toBe(true);
  sidecar.process.kill("SIGTERM");
  expect(await sidecar.process.exited).toBe(0);
  expect(existsSync(sidecar.socket)).toBe(false);
});

test("closing stdin stops the sidecar, as when the mod that spawned it goes away", async () => {
  const sidecar = await startSidecar(await gitRepo());
  await sidecar.process.stdin.end();
  expect(await sidecar.process.exited).toBe(0);
  expect(existsSync(sidecar.socket)).toBe(false);
});

test("a shutdown event answers, then stops the sidecar", async () => {
  const sidecar = await startSidecar(await gitRepo());
  expect((await sidecar.post({ type: "shutdown" })).reply).toEqual({ type: "done" });
  expect(await sidecar.process.exited).toBe(0);
  expect(existsSync(sidecar.socket)).toBe(false);
});

test("a socket left by a killed sidecar is replaced on the next start", async () => {
  const root = await tempDir();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const socket = sidecarSocketPath(home, "session-1");
  await mkdir(join(home, "sidecars"), { recursive: true });
  await writeFile(socket, "");

  const sidecar = await startSidecar(await gitRepo(), home);
  expect(sidecar.socket).toBe(socket);
  expect((await sidecar.post({ type: "turnStart" })).reply).toEqual({ type: "done" });
});

test("a socket a live sidecar still answers on is never taken over", async () => {
  const root = await tempDir();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "live.sock");
  const live = Bun.serve({ unix: socket, fetch: () => new Response("ok") });
  cleanups.push(async () => {
    await live.stop(true);
  });
  await expect(claimSocket(socket, 200)).rejects.toThrow(
    `another sidecar is still serving this session at ${socket}`,
  );
  expect(existsSync(socket)).toBe(true);
});

test("a role the sidecar cannot run yet fails closed with a fatal line", async () => {
  const child = Bun.spawn(["bun", SIDECAR, "--role", "worker", "--session", "s"], {
    stdin: "pipe",
    stdout: "pipe",
  });
  const line = await lineReader(child.stdout)();
  expect(line).toMatchObject({
    type: "fatal",
    reason: "the Claude Code sidecar runs only a coordinator, not worker",
  });
  expect(await child.exited).toBe(1);
});
