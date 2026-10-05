// Throwaway probe: can Tern stand in for Herdr behind Tandem's terminal port?
// Drives an isolated Tern daemon (temporary TERN_CONFIG_DIR + TERN_DAEMON_SOCKET) and prints one
// JSON result per question with the raw CLI output. Run: bun spikes/tern-probe/probe.ts [out.json]
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";

type Run = { argv: string[]; exit: number | null; ms: number; stdout: string; stderr: string };
type Fact = string | number | boolean | null | Fact[] | { [key: string]: Fact };
type Result = {
  question: string;
  herdr: string[];
  facts: Record<string, Fact>;
  unproven: { claim: string; reason: string }[];
  raw: Run[];
};

const Id = z.string().regex(/^\d+$/);
const Block = z.object({
  id: Id,
  title: z.string(),
  cwd: z.string(),
  program: z.string(),
  args: z.array(z.string()),
  command: z.string().nullable(),
  exited: z.number().nullable(),
  live: z.boolean(),
});
const Ls = z.object({
  sessions: z.array(
    z.object({
      id: Id,
      name: z.string(),
      tabs: z.array(z.object({ id: Id, name: z.string().nullable(), blocks: z.array(Block) })),
    }),
  ),
  detached: z.array(z.unknown()),
});
const ProcInfo = z.object({
  pid: z.number(),
  name: z.string(),
  argv: z.array(z.string()),
  cwd: z.string(),
});
const Proc = z.object({
  pane: Id,
  child: ProcInfo.nullable(),
  group: z.number().nullable(),
  foreground: ProcInfo.nullable(),
});
const Created = z.object({ session: Id, tab: Id, block: Id });
const Ack = z.object({ block: Id });
const SessionAck = z.object({ session: Id });
const Waited = z.object({ block: Id, status: z.number() });
const PluginList = z.object({
  plugins: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
      status: z.string(),
      host: z.boolean(),
      window: z.boolean(),
      blocks: z.array(z.object({ id: z.string(), title: z.string() })),
    }),
  ),
  problems: z.array(z.unknown()),
});
type Ls = z.infer<typeof Ls>;
type Proc = z.infer<typeof Proc>;

// Tern prints u64 ids as bare JSON numbers; keep them as decimal strings so no id loses precision.
const ID_FIELDS = /"(id|session|tab|block|pane|Leaf)":\s*(\d+)/g;
function parse<S extends z.ZodTypeAny>(run: Run, schema: S): z.infer<S> {
  return schema.parse(JSON.parse(run.stdout.replace(ID_FIELDS, '"$1":"$2"')));
}

async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<{ value: T; ok: boolean; ms: number }> {
  const started = performance.now();
  for (;;) {
    const value = await read();
    const ms = Math.round(performance.now() - started);
    if (done(value)) return { value, ok: true, ms };
    if (ms > timeoutMs) return { value, ok: false, ms };
    await Bun.sleep(100);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function blocksOf(ls: Ls) {
  return ls.sessions.flatMap((session) =>
    session.tabs.flatMap((tab) =>
      tab.blocks.map((block) => ({ session: session.id, tab: tab.id, block })),
    ),
  );
}

class Tern {
  log: Run[] = [];
  constructor(
    readonly bin: string,
    readonly env: Record<string, string | undefined>,
    readonly cwd: string,
  ) {}

  async run(...args: string[]): Promise<Run> {
    const started = performance.now();
    const proc = Bun.spawn([this.bin, ...args], {
      env: this.env,
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 20_000);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const run = {
      argv: ["tern", ...args],
      exit,
      ms: Math.round(performance.now() - started),
      stdout,
      stderr,
    };
    this.log.push(run);
    return run;
  }

  take(): Run[] {
    const log = this.log;
    this.log = [];
    return log;
  }

  async ls(): Promise<Ls> {
    return parse(await this.run("ls", "--json"), Ls);
  }

  async proc(pane: string): Promise<Proc> {
    return parse(await this.run("process", pane, "--json"), Proc);
  }

  async shellReady(pane: string): Promise<Proc> {
    return (
      await poll(
        () => this.proc(pane),
        (p) => p.child !== null,
        5_000,
      )
    ).value;
  }
}

class EventTap {
  lines: { ms: number; event: Record<string, Fact> }[] = [];
  ends: { exit: number | null; stderr: string }[] = [];
  #streams: Subprocess<"ignore", "pipe", "pipe">[] = [];

  constructor(
    readonly tern: Tern,
    readonly t0: number,
  ) {}

  start(): void {
    const proc = Bun.spawn([this.tern.bin, "events"], {
      env: this.tern.env,
      cwd: this.tern.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#streams.push(proc);
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk);
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const line = buffer.slice(0, at).replace(ID_FIELDS, '"$1":"$2"');
          buffer = buffer.slice(at + 1);
          this.lines.push({ ms: Math.round(performance.now() - this.t0), event: JSON.parse(line) });
        }
      }
    })();
  }

  async ended(): Promise<void> {
    for (const proc of this.#streams.splice(0)) {
      const exit = await proc.exited;
      this.ends.push({ exit, stderr: await new Response(proc.stderr).text() });
    }
  }

  stop(): void {
    for (const proc of this.#streams) proc.kill();
  }
}

const SESSION_A = "tandem-probe-a";
const SESSION_B = "tandem-probe-b";
const NO_SUCH_WINDOW = "tandem-probe-no-such-window";
const IDLE_LOOP = "setInterval(()=>{},1e3)";

class Probe {
  readonly t0 = performance.now();
  daemon: Subprocess<"ignore", "ignore", "ignore"> | null = null;
  readonly tern: Tern;
  readonly events: EventTap;
  readonly hostLog: string;

  constructor(
    readonly bin: string,
    readonly root: string,
  ) {
    this.hostLog = join(root, "host-events.jsonl");
    this.tern = new Tern(
      bin,
      {
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME ?? process.env.USER,
        SHELL: process.env.SHELL ?? "/bin/zsh",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
        TERN_CONFIG_DIR: join(root, "config"),
        TERN_DAEMON_SOCKET: join(root, "d.sock"),
        STENCIL_LOG_DIR: join(root, "logs"),
        // Panes start the login shell; this ZDOTDIR keeps the user's rc files and history out.
        ZDOTDIR: join(root, "zdot"),
        TANDEM_PROBE_HOST_LOG: this.hostLog,
      },
      root,
    );
    this.events = new EventTap(this.tern, this.t0);
  }

  get socket(): string {
    return join(this.root, "d.sock");
  }

  async startDaemon(): Promise<{ ready: boolean; ms: number; attempts: number }> {
    this.daemon = Bun.spawn([this.bin, "daemon", "--socket", this.socket], {
      env: this.tern.env,
      cwd: this.root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let attempts = 0;
    const ready = await poll(
      async () => {
        attempts += 1;
        const proc = Bun.spawn([this.bin, "ls", "--json"], {
          env: this.tern.env,
          stdout: "ignore",
          stderr: "ignore",
        });
        return proc.exited;
      },
      (exit) => exit === 0,
      10_000,
    );
    if (ready.ok) this.events.start();
    return { ready: ready.ok, ms: ready.ms, attempts };
  }

  async stopDaemon(): Promise<number | null> {
    const daemon = this.daemon;
    if (daemon === null) return null;
    daemon.kill("SIGTERM");
    const exit = await daemon.exited;
    this.daemon = null;
    await this.events.ended();
    return exit;
  }

  result(question: string, herdr: string[], facts: Record<string, Fact>): Result {
    return { question, herdr, facts, unproven: [], raw: this.tern.take() };
  }
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// The structure the probe could disturb: session, tab and block identity. Titles, focus and
// sizes change on their own while the live window runs (an agent spinner in a tab title).
// Only digests are kept: the live session list names the user's other projects.
function liveStructure(run: Run): string | null {
  if (run.exit !== 0) return null;
  const structure = parse(run, Ls).sessions.map((s) => ({
    id: s.id,
    name: s.name,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      blocks: t.blocks.map((b) => ({ id: b.id, program: b.program, cwd: b.cwd })),
    })),
  }));
  return sha256(JSON.stringify(structure));
}

async function readiness(p: Probe): Promise<Record<string, Fact>> {
  const before = await p.tern.run("ls", "--json");
  const started = await p.startDaemon();
  if (!started.ready) throw new Error("isolated daemon never answered `tern ls`");
  const fresh = await p.tern.ls();
  if (fresh.sessions.length > 0)
    throw new Error("isolated daemon is not empty; refusing to mutate");
  return {
    lsBeforeDaemonExit: before.exit,
    lsBeforeDaemonStderr: before.stderr.trim(),
    daemonReady: started.ready,
    readyAfterMs: started.ms,
    readyAttempts: started.attempts,
    freshDaemonSessions: fresh.sessions.length,
  };
}

async function identity(p: Probe, workA: string, workB: string) {
  const t = p.tern;
  const root = parse(await t.run("new", "session", SESSION_A, "--cwd", workA, "--json"), Created);
  const split = parse(await t.run("split", root.block, "right", "--cwd", workB, "--json"), Created);
  const ls1 = await t.ls();
  const placed = blocksOf(ls1).find((b) => b.block.id === split.block);
  const before = { root: await t.shellReady(root.block), split: await t.shellReady(split.block) };
  const ids1 = blocksOf(ls1).flatMap((b) => [b.session, b.tab, b.block.id]);
  const layout1 = JSON.stringify(
    ls1.sessions.map((s) => s.tabs.map((tab) => tab.blocks.map((b) => b.id))),
  );

  const stopExit = await p.stopDaemon();
  const oldPids = [before.root.child?.pid, before.split.child?.pid].filter(
    (pid): pid is number => pid !== undefined,
  );
  const restart = await p.startDaemon();
  if (!restart.ready) throw new Error("isolated daemon did not come back after restart");
  const ls2 = await t.ls();
  const ids2 = blocksOf(ls2).flatMap((b) => [b.session, b.tab, b.block.id]);
  const layout2 = JSON.stringify(
    ls2.sessions.map((s) => s.tabs.map((tab) => tab.blocks.map((b) => b.id))),
  );
  const after = { root: await t.shellReady(root.block), split: await t.shellReady(split.block) };
  const fresh = parse(await t.run("split", root.block, "down", "--cwd", workA, "--json"), Created);
  await t.run("close", fresh.block, "--json");
  const allIds = [...ids1, fresh.block];

  const result = p.result(
    "a. identity",
    ["workspace create", "pane split", "pane get", "session restart"],
    {
      newSessionReturns: root,
      splitReturns: split,
      splitParentageMatchesLs: placed?.session === split.session && placed.tab === split.tab,
      idsHigh32Bits: allIds.map((id) => Number(BigInt(id) >> 32n)),
      idsWithinJsSafeInteger: allIds.every((id) => BigInt(id) <= BigInt(Number.MAX_SAFE_INTEGER)),
      lsCwd: placed?.block.cwd ?? null,
      processCwd: before.split.child?.cwd ?? null,
      processCwdIsRealpath: before.split.child?.cwd === (await realpath(workB)),
      daemonStopExit: stopExit,
      idsStableAcrossRestart: JSON.stringify(ids1) === JSON.stringify(ids2),
      layoutStableAcrossRestart: layout1 === layout2,
      shellPidsBefore: oldPids,
      shellPidsAfter: [after.root.child?.pid ?? null, after.split.child?.pid ?? null],
      oldShellsAliveAfterRestart: oldPids.map(alive),
      newIdAfterRestartUnused: !ids1.includes(fresh.block),
    },
  );
  return { result, root, split };
}

async function windowScoping(p: Probe, rootA: string, workB: string) {
  const t = p.tern;
  const b = parse(await t.run("new", "session", SESSION_B, "--cwd", workB, "--json"), Created);
  await t.shellReady(b.block);
  const inA = await t.run("process", rootA, "--json");
  const inB = await t.run("process", b.block, "--json");
  const qualified = await t.run("process", `${SESSION_B}/zsh`, "--json");
  const ambiguous = await t.run("process", "zsh", "--json");
  const bogusLs = await t.run("ls", "--window", NO_SUCH_WINDOW, "--json");
  const bogusProc = await t.run("process", b.block, "--window", NO_SUCH_WINDOW, "--json");
  const emptyKeyLs = await t.run("ls", "--window", "", "--json");

  const envFile = join(p.root, "pane-env.txt");
  const whoamiFile = join(p.root, "pane-whoami.json");
  await t.run(
    "run",
    rootA,
    `env | grep '^TERN_' | sort > '${envFile}'; '${p.bin}' whoami --json > '${whoamiFile}' 2>&1`,
  );
  await poll(
    async () => (await Bun.file(whoamiFile).exists()) && (await Bun.file(whoamiFile).text()) !== "",
    (ready) => ready,
    5_000,
  );
  const paneEnv = Object.fromEntries(
    (await Bun.file(envFile).text())
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

  const result = p.result("b. window scoping", ["HERDR_* context", "session status"], {
    sessionB: b,
    oneCallerReachesBothSessions: inA.exit === 0 && inB.exit === 0,
    sessionQualifiedSelectorPane: qualified.exit === 0 ? parse(qualified, Proc).pane : null,
    bareProgramSelector: { exit: ambiguous.exit, stderr: ambiguous.stderr.trim() },
    unknownWindowLs: { exit: bogusLs.exit, sessions: parse(bogusLs, Ls).sessions.length },
    unknownWindowProcess: { exit: bogusProc.exit, stderr: bogusProc.stderr.trim() },
    emptyWindowKeyLsSessions: parse(emptyKeyLs, Ls).sessions.length,
    paneEnv,
    paneEnvHasSessionOrTab: Object.keys(paneEnv).some((k) => /SESSION|TAB/.test(k)),
    whoami: (await Bun.file(whoamiFile).text()).trim(),
  });
  result.unproven.push({
    claim: "With two GUI windows, a caller outside both needs --window KEY to reach the second.",
    reason:
      "No isolated GUI window exists. A real window passes the closed-beta account gate, whose " +
      "keychain credentials the user's live Tern shares; `tern serve` runs its own ephemeral session.",
  });
  return { result, b };
}

async function processProof(p: Probe, pane: string): Promise<Result> {
  const t = p.tern;
  const idle = await t.shellReady(pane);
  await t.run("run", pane, `'${process.execPath}' -e '${IDLE_LOOP}'`);
  const busy = await poll(
    () => t.proc(pane),
    (proc) => proc.foreground !== null && proc.foreground.pid !== proc.child?.pid,
    5_000,
  );
  const fg = busy.value.foreground;
  const ps = fg
    ? (await Bun.$`ps -o pid=,pgid=,command= -p ${fg.pid}`.nothrow().text()).trim()
    : "";
  return p.result("c. process proof", ["pane process-info", "ps scan"], {
    idleShell: idle,
    idleForegroundIsShell: idle.foreground?.pid === idle.child?.pid,
    busy: busy.value,
    busySeenAfterMs: busy.ms,
    foregroundDistinctFromShell: busy.ok,
    groupIsForegroundPid: busy.value.group === fg?.pid,
    argvExact: JSON.stringify(fg?.argv) === JSON.stringify([process.execPath, "-e", IDLE_LOOP]),
    psLine: ps,
    psAgreesOnGroup: ps.split(/\s+/)[1] === String(busy.value.group),
  });
}

async function input(p: Probe, busyPane: string, rootA: string): Promise<Result> {
  const t = p.tern;
  const busy = await t.proc(busyPane);
  const busyPid = busy.foreground?.pid ?? -1;
  const ctrlC = await t.run("send", busyPane, "keys", "ctrl+c", "--json");
  const stopped = await poll(
    () => t.proc(busyPane),
    (proc) => proc.foreground?.pid === proc.child?.pid,
    3_000,
  );

  const text = await t.run(
    "send",
    busyPane,
    "text",
    "echo tandem-probe-text-$((40+2))\r",
    "--json",
  );
  const textSeen = await poll(
    async () => (await t.run("capture", busyPane)).stdout,
    (screen) => screen.includes("tandem-probe-text-42"),
    3_000,
  );
  const badKey = await t.run("send", busyPane, "keys", "not-a-key", "--json");

  const d = parse(await t.run("split", rootA, "down", "--json"), Created);
  await t.shellReady(d.block);
  const prompt = await t.run("wait", d.block, "--until", "prompt", "--timeout", "5", "--json");
  const ctrlD = await t.run("send", d.block, "keys", "ctrl+d", "--json");
  const exited = await poll(
    async () => blocksOf(await t.ls()).find((b) => b.block.id === d.block)?.block ?? null,
    (block) => block?.exited !== null,
    3_000,
  );
  await Bun.sleep(1_500);
  const lingering = blocksOf(await t.ls()).find((b) => b.block.id === d.block)?.block ?? null;
  const exitedProc = await t.proc(d.block);
  const waited = await t.run("wait", d.block, "--until", "exit", "--timeout", "3", "--json");
  await t.run("close", d.block, "--json");

  return p.result("d. input", ["pane send-keys", "pane send-text", "pane run", "interrupt"], {
    waitUntilPrompt:
      prompt.exit === 0
        ? parse(prompt, z.object({ block: Id, status: z.number().nullable() }))
        : { exit: prompt.exit, stderr: prompt.stderr.trim() },
    ctrlCAck: parse(ctrlC, Ack),
    ctrlCStoppedForeground: stopped.ok,
    ctrlCStoppedAfterMs: stopped.ms,
    interruptedPidAlive: alive(busyPid),
    sendTextAck: parse(text, Ack),
    sendTextReachedShell: textSeen.ok,
    unknownKey: { exit: badKey.exit, stderr: badKey.stderr.trim() },
    ctrlDAck: parse(ctrlD, Ack),
    ctrlDExitStatus: exited.value?.exited ?? null,
    exitedPaneStillListedAfter1500ms: lingering !== null,
    exitedPaneLive: lingering?.live ?? null,
    exitedPaneProcess: exitedProc,
    waitUntilExit: waited.exit === 0 ? parse(waited, Waited) : { exit: waited.exit },
  });
}

async function closeSemantics(p: Probe, rootA: string, sessionB: string, rootB: string) {
  const t = p.tern;
  const gone = async (pane: string) =>
    poll(
      async () => blocksOf(await t.ls()).some((b) => b.block.id === pane),
      (present) => !present,
      3_000,
    );

  const idle = parse(await t.run("split", rootA, "down", "--json"), Created);
  await t.shellReady(idle.block);
  const idleClose = await t.run("close", idle.block, "--json");
  const idleGone = await gone(idle.block);

  const busy = parse(await t.run("split", rootA, "down", "--json"), Created);
  await t.shellReady(busy.block);
  await t.run("run", busy.block, `'${process.execPath}' -e '${IDLE_LOOP}'`);
  const fg = await poll(
    () => t.proc(busy.block),
    (proc) => proc.foreground?.name === "bun",
    5_000,
  );
  const busyPid = fg.value.foreground?.pid ?? -1;
  const busyClose = await t.run("close", busy.block, "--json");
  const busyGone = await gone(busy.block);
  const busyPidDead = await poll(
    async () => alive(busyPid),
    (a) => !a,
    3_000,
  );

  const missing = await t.run("close", "999999999999", "--json");
  const again = await t.run("close", idle.block, "--json");
  const wrongWindow = await t.run("close", rootB, "--window", NO_SUCH_WINDOW, "--json");
  const rootBStillThere = blocksOf(await t.ls()).some((b) => b.block.id === rootB);

  const victim = parse(await t.run("split", rootB, "right", "--json"), Created);
  await t.shellReady(victim.block);
  await t.run("send", victim.block, "text", `printf '\\033]0;${idle.block}\\007'; sleep 30\r`);
  const retitled = await poll(
    async () => blocksOf(await t.ls()).find((b) => b.block.id === victim.block)?.block.title,
    (title) => title === idle.block,
    3_000,
  );
  const staleProc = await t.run("process", idle.block, "--json");
  const staleClose = await t.run("close", idle.block, "--json");
  const victimGone = await gone(victim.block);

  const lastClose = await t.run("close", rootB, "--json");
  const afterLast = (await t.ls()).sessions.find((s) => s.id === sessionB);
  const kill = await t.run("kill", "session", sessionB, "--json");
  const killAgain = await t.run("kill", "session", sessionB, "--json");

  return p.result("e. close semantics", ["pane close", "workspace retirement"], {
    idleClose: { exit: idleClose.exit, ack: parse(idleClose, Ack), goneFromLsAfterMs: idleGone.ms },
    busyClose: {
      exit: busyClose.exit,
      ack: parse(busyClose, Ack),
      goneFromLs: busyGone.ok,
      foregroundKilled: busyPidDead.ok,
    },
    nonexistentId: { exit: missing.exit, stderr: missing.stderr.trim() },
    alreadyClosedId: { exit: again.exit, stderr: again.stderr.trim() },
    unknownWindow: {
      exit: wrongWindow.exit,
      stderr: wrongWindow.stderr.trim(),
      paneStillThere: rootBStillThere,
    },
    victimRetitledToStaleId: retitled.ok,
    staleIdResolvesToRetitledPane:
      staleProc.exit === 0 ? parse(staleProc, Proc).pane === victim.block : false,
    staleIdClose: {
      requested: idle.block,
      exit: staleClose.exit,
      ack: staleClose.exit === 0 ? parse(staleClose, Ack) : null,
      closedOtherPane: victimGone.ok,
    },
    lastPaneClose: { exit: lastClose.exit, sessionRemains: afterLast !== undefined },
    sessionTabsAfterLastPane: afterLast?.tabs.length ?? null,
    killSessionById: parse(kill, SessionAck),
    killSessionAgain: { exit: killAgain.exit, stderr: killAgain.stderr.trim() },
  });
}

async function plugin(p: Probe): Promise<Result> {
  const t = p.tern;
  const dir = join(import.meta.dir, "plugin");
  const link = await t.run("plugin", "link", dir, "--json");
  const pluginDir = await t.run("plugin", "dir", "--json");
  const list = parse(await t.run("plugin", "list", "--json"), PluginList);
  const entry = list.plugins.find((pl) => pl.id === "tandemprobe");
  const splitHelp = await t.run("split", "--help");
  const newHelp = await t.run("new", "--help");

  const control = join(p.root, "ctl.sock");
  const serve = Bun.spawn([p.bin, "serve", "--control", control], {
    env: t.env,
    cwd: p.root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const serveUp = await poll(
    () =>
      Bun.spawn([p.bin, "ctl", "--control", control, "stats"], {
        env: t.env,
        stdout: "ignore",
        stderr: "ignore",
      }).exited,
    (exit) => exit === 0,
    10_000,
  );
  const serveState = serveUp.ok ? await t.run("ctl", "--control", control, "state") : null;
  const state = serveState ? (JSON.parse(serveState.stdout) as Record<string, Fact>) : null;
  const clients = parse(
    await t.run("inspect", "--json"),
    z.object({ clients: z.array(z.object({ kind: z.string() })) }),
  ).clients;
  if (serveUp.ok) await t.run("ctl", "--control", control, "quit");
  serve.kill();
  await serve.exited;

  return {
    question: "g. plugin",
    herdr: [
      "plugin link",
      "plugin pane open",
      "ui.tab_bar_right",
      "notification show",
      "keys.command",
    ],
    facts: {
      manifest: await Bun.file(join(dir, "plugin.toml")).text(),
      linkExit: link.exit,
      pluginDir: JSON.parse(pluginDir.stdout) as Fact,
      loaded: entry ?? null,
      problems: list.problems.length,
      cliLaunchGrammar: [
        splitHelp.stdout.split("\n")[0] ?? "",
        newHelp.stdout.split("\n").find((line) => line.startsWith("LAUNCH is")) ?? "",
      ],
      headlessServe: {
        answered: serveUp.ok,
        sessions: state?.sessions ?? null,
        tabs: state?.tabs ?? null,
        gate: state?.gate ?? null,
      },
      isolatedDaemonClientKindsWhileServeRan: clients.map((c) => c.kind),
    },
    unproven: [
      {
        claim:
          "The window half (status segment, toast, palette command, key bind, block opened in a split) works.",
        reason:
          "Each is window-only Luau. The CLI LAUNCH grammar takes a command, never a block kind. " +
          "`tern serve` is an ephemeral in-process session: it does not attach to the daemon or load " +
          "TERN_CONFIG_DIR plugins. A real window passes the closed-beta account gate, which shares " +
          "keychain credentials with the user's live Tern. So no isolated window ran window.luau.",
      },
    ],
    raw: t.take(),
  };
}

async function portOps(p: Probe, sessionA: string, rootA: string): Promise<Result> {
  const t = p.tern;
  const label = "└ probe task: ünïcode label";
  const rename = await t.run("rename", sessionA, label, "--json");
  const renamed = (await t.ls()).sessions.find((s) => s.id === sessionA)?.name ?? null;
  const duplicate = await t.run("new", "session", label, "--json");
  await t.run("rename", sessionA, SESSION_A, "--json");

  const focus = await t.run("focus", rootA, "--json");
  const welcome = parse(
    await t.run("split", rootA, "right", "--keep-open", "--json", "--", "sh", "-c", "echo hi"),
    Created,
  );
  const pip = await t.run("pip", welcome.block, "--over", rootA, "--json");
  const dock = await t.run("dock", welcome.block, "--json");
  await t.run("close", welcome.block, "--json");
  // `tern help` lists the scripting verbs; an unknown verb would be read as a FILE to open in a window.
  const help = await t.run("help");
  const verbs = (help.stdout.replace(/\|\n\s+/g, "|").match(/tern (ls\|\S+)/)?.[1] ?? "").split(
    "|",
  );
  const version = await t.run("--version");

  return p.result(
    "i. port ops",
    ["renameWorkspace", "createWorkspace label", "focusAgent", "openWelcome", "fitPanel", "notify"],
    {
      renameSessionById: { exit: rename.exit, nameAfter: renamed },
      duplicateSessionName: { exit: duplicate.exit, stderr: duplicate.stderr.trim() },
      focus: { exit: focus.exit, stdout: focus.stdout.trim(), stderr: focus.stderr.trim() },
      pipOverCoordinator: { exit: pip.exit, stdout: pip.stdout.trim(), stderr: pip.stderr.trim() },
      dockBack: { exit: dock.exit, stderr: dock.stderr.trim() },
      scriptVerbs: verbs,
      verbsForMissingOps: Object.fromEntries(
        ["resize", "notify", "toast", "order"].map((verb) => [verb, verbs.includes(verb)]),
      ),
      version: version.stdout.trim(),
    },
  );
}

async function hostHooks(p: Probe, result: Result): Promise<void> {
  const file = Bun.file(p.hostLog);
  const lines = (await file.exists()) ? (await file.text()).trim().split("\n") : [];
  const records = lines.map(
    (line) => JSON.parse(line.replace(ID_FIELDS, '"$1":"$2"')) as { kind: string; ev: Fact },
  );
  const kinds: Record<string, number> = {};
  for (const r of records) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  result.facts.hostHookKinds = kinds;
  result.facts.hostHookSamples = records
    .filter((r, i) => records.findIndex((o) => o.kind === r.kind) === i)
    .map((r) => ({ kind: r.kind, ev: r.ev }));
}

function eventSummary(p: Probe, panes: Record<string, string>): Result {
  const kinds: Record<string, number> = {};
  for (const line of p.events.lines) {
    const kind = String(line.event.event);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return {
    question: "f. events",
    herdr: ["pane exit / close polling", "status refresh"],
    facts: {
      kinds,
      perPane: Object.fromEntries(
        Object.entries(panes).map(([label, pane]) => [
          label,
          p.events.lines.filter((l) => l.event.pane === pane).map((l) => String(l.event.event)),
        ]),
      ),
      streamEnds: p.events.ends,
      commandEventsOnCli: "command_started" in kinds || "command_finished" in kinds,
    },
    unproven: [],
    raw: p.events.lines
      .filter((l) => !String(l.event.event).startsWith("client_"))
      .map((l) => ({
        argv: ["tern", "events"],
        exit: null,
        ms: l.ms,
        stdout: JSON.stringify(l.event),
        stderr: "",
      })),
  };
}

async function idleExit(p: Probe): Promise<Record<string, Fact>> {
  const t = p.tern;
  for (const s of (await t.ls()).sessions) await t.run("kill", "session", s.id, "--json");
  await t.run("plugin", "unlink", "tandemprobe", "--json");
  p.events.stop();
  await p.events.ended();
  const daemon = p.daemon;
  if (daemon === null) return { idleExit: null };
  const started = performance.now();
  const exited = await Promise.race([
    daemon.exited,
    Bun.sleep(20_000).then(() => "timeout" as const),
  ]);
  const ms = Math.round(performance.now() - started);
  if (exited !== "timeout") p.daemon = null;
  return {
    socketAfterIdleExit: existsSync(p.socket),
    idleExitCode: exited === "timeout" ? null : exited,
    idleExitAfterMs: exited === "timeout" ? null : ms,
  };
}

function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object") {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) => changedPaths(a[key], b[key], `${path}/${key}`));
  }
  return [path];
}

async function main(): Promise<void> {
  const bin = process.env.TERN_BIN ?? Bun.which("tern");
  if (!bin) throw new Error("tern not found; set TERN_BIN");
  const out = process.argv[2] ?? join(import.meta.dir, "results.json");
  const live = new Tern(bin, process.env, process.cwd());
  const liveBefore = await live.run("ls", "--json");
  const historyPath = join(process.env.HOME ?? "", ".zsh_history");
  const historyBefore = existsSync(historyPath) ? statSync(historyPath).mtimeMs : null;
  const root = await realpath(await mkdtemp("/tmp/tern-probe-"));
  const p = new Probe(bin, root);
  const liveSocket = process.env.TERN_PANE_SOCKET ?? "";
  if (p.socket === liveSocket) throw new Error("isolated socket equals the live socket");
  await mkdir(join(root, "zdot"));
  await writeFile(join(root, "zdot", ".zshrc"), "unset HISTFILE\nPROMPT='%~ %# '\n");
  const workA = join(root, "work-a");
  const workB = join(root, "work b");
  await mkdir(workA);
  await mkdir(workB);

  const results: Result[] = [];
  try {
    const ready = await readiness(p);
    const readyRaw = p.tern.take();
    const pluginResult = await plugin(p);
    const a = await identity(p, workA, workB);
    const rootA = a.root.block;
    const splitA = a.split.block;
    const b = await windowScoping(p, rootA, workB);
    const c = await processProof(p, splitA);
    const d = await input(p, splitA, rootA);
    const e = await closeSemantics(p, rootA, b.b.session, b.b.block);
    await hostHooks(p, pluginResult);
    const f = eventSummary(p, { rootA, splitA, rootB: b.b.block });
    const i = await portOps(p, a.root.session, rootA);
    const idle = await idleExit(p);
    const h: Result = {
      question: "h. readiness",
      herdr: ["status server", "status --json"],
      facts: { ...ready, ...idle },
      unproven: [],
      raw: [...readyRaw, ...p.tern.take()],
    };
    results.push(a.result, b.result, c, d, e, f, pluginResult, h, i);
  } finally {
    p.events.stop();
    if (p.daemon) await p.stopDaemon();
    await rm(root, { recursive: true, force: true });
  }

  const liveAfter = await live.run("ls", "--json");
  const historyAfter = existsSync(historyPath) ? statSync(historyPath).mtimeMs : null;
  const isolation: Result = {
    question: "isolation",
    herdr: [],
    facts: {
      isolatedRoot: root,
      isolatedEnv: Object.keys(p.tern.env),
      liveStructureBefore: liveStructure(liveBefore),
      liveStructureAfter: liveStructure(liveAfter),
      liveStructureIdentical:
        liveBefore.exit === 0 && liveStructure(liveBefore) === liveStructure(liveAfter),
      liveRawIdentical: liveBefore.stdout === liveAfter.stdout,
      liveRawChangedPaths:
        liveBefore.exit === 0 && liveAfter.exit === 0
          ? changedPaths(JSON.parse(liveBefore.stdout), JSON.parse(liveAfter.stdout))
          : null,
      userZshHistoryUnchanged: historyBefore === historyAfter,
      liveMentionsProbeSessions: [liveBefore, liveAfter].some(
        (run) => run.stdout.includes(SESSION_A) || run.stdout.includes(SESSION_B),
      ),
    },
    unproven: [],
    raw: [liveBefore, liveAfter].map((run) => ({
      ...run,
      stdout: `sha256:${sha256(run.stdout)} (${run.stdout.length} bytes, withheld)`,
    })),
  };
  results.unshift(isolation);
  const home = process.env.HOME ?? "~";
  const redact = (text: string) =>
    text
      .replaceAll(home, "~")
      .replaceAll(process.env.USER ?? "<user>", "<user>")
      .replaceAll(hostname().split(".")[0] ?? "<host>", "<host>");
  for (const r of results) {
    console.log(redact(JSON.stringify({ question: r.question, facts: r.facts })));
  }
  await writeFile(out, redact(`${JSON.stringify(results, null, 2)}\n`));
}

await main();
