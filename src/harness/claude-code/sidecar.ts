import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { environmentForContext } from "../../config/environment.ts";
import type { SessionDeps } from "../../session/events.ts";
import { workerJobPath } from "../worker-session.ts";
import { claudeCodeCoordinator, type SessionBinding } from "./coordinator.ts";
import { ClaudeCodePane } from "./host.ts";
import {
  encodeWire,
  type HookReply,
  parseSidecarEvent,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarLine,
} from "./plugins/tandem/hooks/protocol.ts";
import { sidecarSocketPath } from "./socket.ts";
import { openClaudeCodeWorker } from "./worker.ts";

/** How long a new sidecar waits for the one it replaces (a mod reload) to let go of the socket. */
const CLAIM_WAIT_MS = 3_000;
const CLAIM_POLL_MS = 100;
/** How often the sidecar checks that the Claude Code process that started it is still alive. */
const PARENT_POLL_MS = 1_000;

export type SidecarArgs = Readonly<{ sessionId: string }>;

/** `--session <id>`: the Claude Code session this sidecar serves. */
export function parseSidecarArgs(argv: readonly string[]): SidecarArgs {
  const [flag, value, ...rest] = argv;
  const sessionId = value?.trim();
  if (
    flag !== "--session" ||
    sessionId === undefined ||
    sessionId.length === 0 ||
    rest.length > 0
  ) {
    throw new Error(`usage: sidecar --session <id>, not ${argv.join(" ")}`);
  }
  return { sessionId };
}

async function answers(socket: string): Promise<boolean> {
  try {
    await fetch("http://sidecar/health", { unix: socket });
    return true;
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes `socket` free to listen on. A socket nobody answers on is left by a killed sidecar and is
 * removed. One that answers belongs to a live sidecar for this session, which a mod reload is
 * stopping; it gets a moment to let go, and if it never does, this sidecar refuses to start
 * rather than run a second session owner.
 */
export async function claimSocket(socket: string, waitMs = CLAIM_WAIT_MS): Promise<void> {
  const deadline = performance.now() + waitMs;
  while (exists(socket)) {
    if (!(await answers(socket))) {
      unlinkSync(socket);
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error(`another sidecar is still serving this session at ${socket}`);
    }
    await Bun.sleep(CLAIM_POLL_MS);
  }
}

/** One hook the mod is waiting on: its final reply, and questions not yet sent to the mod. */
class HookCall {
  result: Promise<HookReply> = Promise.resolve({ type: "done" });
  readonly asks: HookReply[] = [];
  /** Set while the mod's HTTP request waits; a question answers it at once. */
  wake: ((reply: HookReply) => void) | undefined;
}

/**
 * Hooks in flight. `host.confirm` inside one ends that hook's HTTP response early with an `ask`;
 * the mod asks the person within the same Claude Code hook and posts `askAnswer`, whose response
 * is the hook's next reply. A confirm outside any hook has nobody to ask, so it is refused.
 */
export class HookCalls {
  private readonly scope = new AsyncLocalStorage<HookCall>();
  private readonly waiting = new Map<
    string,
    Readonly<{ call: HookCall; answer(allowed: boolean): void }>
  >();
  private asked = 0;

  start(run: () => Promise<HookReply>): Promise<HookReply> {
    const call = new HookCall();
    call.result = this.scope.run(call, run);
    return this.next(call);
  }

  confirm(title: string, message: string): Promise<boolean> {
    const call = this.scope.getStore();
    if (call === undefined) return Promise.resolve(false);
    this.asked += 1;
    const ask = `ask-${this.asked}`;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.waiting.set(ask, { call, answer: resolve });
    const reply: HookReply = { type: "ask", ask, title, message };
    if (call.wake === undefined) call.asks.push(reply);
    else call.wake(reply);
    return promise;
  }

  answer(ask: string, allowed: boolean): Promise<HookReply> {
    const waiting = this.waiting.get(ask);
    if (waiting === undefined) {
      return Promise.resolve({ type: "refused", reason: `no question ${ask} is waiting` });
    }
    this.waiting.delete(ask);
    waiting.answer(allowed);
    return this.next(waiting.call);
  }

  /** Every unanswered question is a refusal, so nothing waits on a mod that is gone. */
  denyAll(): void {
    for (const waiting of this.waiting.values()) waiting.answer(false);
    this.waiting.clear();
  }

  private next(call: HookCall): Promise<HookReply> {
    const queued = call.asks.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const asked = new Promise<HookReply>((resolve) => {
      call.wake = resolve;
    });
    return Promise.race([call.result, asked]).finally(() => {
      call.wake = undefined;
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(line: SidecarLine): void {
  process.stdout.write(`${encodeWire(line)}\n`);
}

const timers: SessionDeps["timers"] = {
  every: (ms, run) => {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Runs one Claude Code session's sidecar until SIGTERM, SIGHUP, its parent exiting, or a
 * `shutdown` event, then stops listening, removes its socket, and shuts the session down.
 */
async function main(): Promise<void> {
  // Stdout carries only protocol lines; anything else the core prints goes to stderr.
  console.log = console.error;
  const args = parseSidecarArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const { home } = environmentForContext({}, { cwd, sessionId: args.sessionId });
  const socket = sidecarSocketPath(home, args.sessionId);
  const hooks = new HookCalls();
  // Tandem launches a worker's Claude Code with its job in the environment, and with a brief.
  const jobPath = workerJobPath(process.env);
  const pane = new ClaudeCodePane({
    write: writeLine,
    confirm: (title, message) => hooks.confirm(title, message),
    startsWithPrompt: jobPath !== undefined,
  });
  const binding: SessionBinding =
    jobPath === undefined
      ? claudeCodeCoordinator(pane, {
          timers,
          logError: (message, error) => console.error(`${message}: ${errorMessage(error)}`),
          cwd,
          sessionId: args.sessionId,
        })
      : await openClaudeCodeWorker(pane, jobPath, process.env, timers);

  mkdirSync(join(home, "sidecars"), { recursive: true, mode: 0o700 });
  await claimSocket(socket);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      hooks.denyAll();
      await server.stop(true);
      // A replacement may already listen at this path; only this sidecar's own socket is removed.
      if (statSync(socket, { throwIfNoEntry: false })?.ino === listening) unlinkSync(socket);
      try {
        await binding.shutdown();
      } finally {
        process.exit(0);
      }
    })();
    return stopping;
  };

  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health") return new Response("ok");
      if (request.method !== "POST" || path !== "/event") {
        return Response.json({ type: "refused", reason: "not found" }, { status: 404 });
      }
      const parsed = parseSidecarEvent(await request.text());
      if (!parsed.ok)
        return Response.json({ type: "refused", reason: parsed.reason }, { status: 400 });
      const event = parsed.value;
      try {
        if (event.type === "askAnswer")
          return Response.json(await hooks.answer(event.ask, event.allowed));
        if (event.type === "shutdown") {
          setTimeout(() => void stop(), 0);
          return Response.json({ type: "done" });
        }
        return Response.json(await hooks.start(() => binding.handle(event)));
      } catch (error) {
        return Response.json({ type: "refused", reason: errorMessage(error) }, { status: 500 });
      }
    },
  });
  const listening = statSync(socket).ino;

  // The service loads OMP's SDK, whose postmortem module exits on these signals before this
  // sidecar could remove its socket, so the sidecar takes them over.
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.removeAllListeners(signal);
  process.on("SIGTERM", () => void stop());
  process.on("SIGHUP", () => void stop());
  // `$.process.spawn` closes stdin from the start, so a dead Claude Code shows only as a new parent.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) void stop();
  }, PARENT_POLL_MS).unref();
  writeLine({
    type: "ready",
    protocol: SIDECAR_PROTOCOL_VERSION,
    socket,
    pid: process.pid,
    tools: binding.tools,
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    writeLine({ type: "fatal", protocol: SIDECAR_PROTOCOL_VERSION, reason: errorMessage(error) });
    process.exit(1);
  });
}
