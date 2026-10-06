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
} from "../../../src/harness/claude-code/plugins/tandem/hooks/protocol.ts";
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

async function startSidecar(
  cwd: string,
  home?: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<Running & Readonly<{ tools: readonly string[] }>> {
  const root = await tempDir();
  const tandemHome = home ?? join(root, "home");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const child = Bun.spawn(["bun", SIDECAR, "--session", "session-1"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      TANDEM_HOME: tandemHome,
      ...environment,
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
  return {
    process: child,
    socket: ready.socket,
    home: tandemHome,
    nextLine,
    post,
    tools: ready.tools.map((tool) => tool.name),
  };
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
  expect(sidecar.tools).toEqual(["tandem"]);

  const started = await sidecar.post({ type: "sessionStart", model: "claude-opus-5-5" });
  expect(started).toEqual({ status: 200, reply: { type: "done" } });

  const listed = await sidecar.post({
    type: "pluginTool",
    id: "toolu_1",
    name: "tandem",
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
  const tool = await sidecar.post({
    type: "pluginTool",
    id: "toolu_1",
    name: "tandem",
    input: { action: "list" },
  });
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

test("closed stdin does not stop the sidecar, since the mod spawns it with stdin closed", async () => {
  const sidecar = await startSidecar(await gitRepo());
  await sidecar.process.stdin.end();
  await Bun.sleep(500);
  expect(await (await fetch("http://sidecar/health", { unix: sidecar.socket })).text()).toBe("ok");
  sidecar.process.kill("SIGTERM");
  expect(await sidecar.process.exited).toBe(0);
});

async function startParent(repo: string, root: string) {
  const pidFile = join(root, "child-pid");
  const parent = Bun.spawn(
    [
      "bun",
      "-e",
      `const child = Bun.spawn([process.execPath, ${JSON.stringify(SIDECAR)}, "--session", "session-1"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
       await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
       await Bun.stdin.text();
       process.exit(0);`,
    ],
    {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH, HOME: root, TANDEM_HOME: join(root, "home") },
    },
  );
  cleanups.push(async () => {
    parent.kill("SIGKILL");
    await parent.exited;
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(await Bun.file(pidFile).text()), "SIGKILL");
      } catch {}
    }
  });
  return parent;
}

test("the sidecar stops when the process that started it dies", async () => {
  const repo = await gitRepo();
  const root = await tempDir();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const parent = await startParent(repo, root);
  const nextLine = lineReader(parent.stdout);
  const ready = await nextLine();
  if (ready.type !== "ready") throw new Error(`sidecar did not start: ${JSON.stringify(ready)}`);
  await parent.stdin.end();
  await parent.exited;
  await expect(nextLine()).rejects.toThrow("stdout ended");
  expect(existsSync(ready.socket)).toBe(false);
}, 10_000);

test("a parent exiting during socket initialization is not adopted as the sidecar's owner", async () => {
  const repo = await gitRepo();
  const root = await tempDir();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(join(home, "sidecars"), { recursive: true });
  const socket = sidecarSocketPath(home, "session-1");
  const observed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const previous = Bun.serve({
    unix: socket,
    async fetch() {
      observed.resolve();
      await release.promise;
      return new Response("ok");
    },
  });
  cleanups.push(async () => {
    release.resolve();
    await previous.stop(true);
  });
  const parent = await startParent(repo, root);
  await observed.promise;
  await parent.stdin.end();
  expect(await parent.exited).toBe(0);
  await rm(socket, { force: true });
  release.resolve();
  await expect(lineReader(parent.stdout)()).rejects.toThrow("stdout ended");
  expect(existsSync(socket)).toBe(false);
}, 10_000);

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

test("a worker whose job cannot be read fails closed with a fatal line", async () => {
  const root = await tempDir();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const child = Bun.spawn(["bun", SIDECAR, "--session", "s"], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TANDEM_HOME: join(root, "home"),
      TANDEM_WORKER_JOB_PATH: join(root, "missing.json"),
    },
  });
  const line = await lineReader(child.stdout)();
  expect(line).toMatchObject({ type: "fatal", reason: expect.stringContaining("missing.json") });
  expect(await child.exited).toBe(1);
});

/** A worker job in a fresh checkout, as Tandem writes it for a Claude Code worker. */
async function workerJob(
  role: "reviewer" | "scout",
): Promise<Readonly<{ jobPath: string; resultPath: string; cwd: string }>> {
  const cwd = await gitRepo();
  const jobs = join(cwd, "..", "jobs");
  await mkdir(jobs);
  const jobPath = join(jobs, "job.json");
  const resultPath = join(jobs, "result.json");
  await writeFile(
    jobPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role,
      cwd,
      harness: "claude-code",
      model: { model: "claude-code/sonnet", thinking: "low" },
      prompt: "Look at the cache.",
      resultPath,
    }),
  );
  return { jobPath, resultPath, cwd };
}

test("a reviewer's sidecar offers submit_report and refuses Edit, Write, and a mutating Bash", async () => {
  const { jobPath, cwd } = await workerJob("reviewer");
  const sidecar = await startSidecar(cwd, undefined, { TANDEM_WORKER_JOB_PATH: jobPath });
  expect(sidecar.tools).toEqual(["submit_report"]);
  await sidecar.post({ type: "sessionStart", model: "claude-sonnet-5-5" });
  const calls = [
    { id: "t1", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } },
    { id: "t2", name: "Write", input: { file_path: "a.ts", content: "x" } },
    { id: "t3", name: "Bash", input: { command: "rm -rf src" } },
  ];
  for (const call of calls) {
    expect((await sidecar.post({ type: "toolCall", call })).reply).toEqual({
      type: "toolDecision",
      block: true,
      reason: "A reviewer only reads: it cannot edit files or run commands.",
    });
  }
  const read = { id: "t4", name: "Read", input: { file_path: "a.ts" } };
  expect((await sidecar.post({ type: "toolCall", call: read })).reply).toEqual({
    type: "toolDecision",
    block: false,
  });
}, 30_000);

test("a scout's sidecar takes its report through submit_report and writes the job's result", async () => {
  const { jobPath, resultPath, cwd } = await workerJob("scout");
  const sidecar = await startSidecar(cwd, undefined, { TANDEM_WORKER_JOB_PATH: jobPath });
  expect(sidecar.tools).toEqual(["submit_report", "copy_asset"]);
  await sidecar.post({ type: "sessionStart", model: "claude-sonnet-5-5" });
  await sidecar.post({ type: "agentStart", prompt: "Look at the cache." });
  const submitted = await sidecar.post({
    type: "pluginTool",
    id: "t1",
    name: "submit_report",
    input: { outcome: "completed", report: "The cache is keyed by path." },
  });
  expect(submitted.reply).toEqual({
    type: "toolResult",
    text: "Report submitted with status completed.",
    isError: false,
  });
  expect(JSON.parse(await Bun.file(resultPath).text())).toMatchObject({
    status: "completed",
    text: expect.stringContaining("The cache is keyed by path."),
  });
  const again = await sidecar.post({
    type: "pluginTool",
    id: "t2",
    name: "submit_report",
    input: { outcome: "completed", report: "Again." },
  });
  expect(again.reply).toMatchObject({ type: "toolResult", isError: true });
}, 30_000);
