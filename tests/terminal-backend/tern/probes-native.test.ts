import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TERN_BINARY } from "../../../src/terminal-backend/tern/cli.ts";
import {
  blocks,
  decode,
  Listing,
  type TernListing,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { launchTernWindow } from "./native-window.ts";

// Each probe records what real Tern does into its isolated root, for the Tern seam redesign.
// A probe asserts only that its observation was captured; the observation is the result.
const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";
const probe = enabled ? test : test.skip;

const MANIFEST = `schema = 1
id = "tandemprobe"
name = "Tandem probes"
version = "0.0.1"
description = "Records Tern host behavior for Tandem"
host = "host.luau"
window = "window.luau"

[[blocks]]
id = "args"
title = "Probe args"
palette = false

[[blocks]]
id = "opener"
title = "Probe opener"
palette = false
`;

const HOST = `local OBS = tern.getenv("PROBE_OBS") or ""
local PHASE = tern.getenv("PROBE_PHASE") or "unknown"
local inits = 0
local function record(name, value) tern.fs.write(OBS .. "/" .. name .. ".json", tern.json.encode(value)) end
tern.block.define("args", {
 init = function(cx, args, saved)
  inits += 1
  record("block-args-" .. PHASE .. "-" .. inits, {args = args, saved = saved, pane = cx.pane, osTime = os.time()})
  return {args = args}
 end,
 view = function() return {main = tern.ui.text({tern.ui.span("probe args", "strong")})} end,
 save = function(state) return state end,
})
tern.block.define("opener", {
 init = function(cx, args)
  local ok, problem = pcall(function() cx:open(args[1]) end)
  record("cx-open", {ok = ok, problem = if ok then nil else tostring(problem), pane = cx.pane})
  return {}
 end,
 view = function() return {main = tern.ui.text({tern.ui.span("probe opener", "strong")})} end,
})
`;

const WINDOW = `local OBS = tern.getenv("PROBE_OBS") or ""
local KEY = tern.getenv("TERN_WINDOW_KEY") or "none"
local routes = 0
local function record(name, value) tern.fs.write(OBS .. "/" .. name .. ".json", tern.json.encode(value)) end
tern.route.open(function(req, cx)
 local path = req.path
 if string.match(path, "%.probe%-time%.json$") then
  record("route-time-" .. KEY, {osTime = os.time(), osClock = os.clock(), ternNow = tern.now()})
  return {handled = true}
 elseif string.match(path, "%.probe%-route%.json$") then
  routes += 1
  record("route-open-" .. KEY .. "-" .. routes, {window = KEY, focused = cx.session:focused(), path = path})
  return {handled = true}
 elseif string.match(path, "%.probe%-decode%.json$") then
  tern.timer(1, function()
   local started = os.clock()
   local ok, result = pcall(function()
    local raw = tern.fs.read(path, 8 * 1024 * 1024)
    local read = os.clock()
    local value = tern.json.decode(raw)
    return {bytes = #raw, readMs = (read - started) * 1000, decodeMs = (os.clock() - read) * 1000, rows = #value.rows}
   end)
   record("decode-" .. KEY, if ok then result else {error = tostring(result), elapsedMs = (os.clock() - started) * 1000})
  end)
  return {handled = true}
 elseif string.match(path, "%.probe%-block%.json$") then
  local spec = tern.json.decode(tern.fs.read(path, 65536))
  tern.timer(1, function(timerCx)
   if not timerCx then return end
   local ok, result = pcall(function() return timerCx:new_block(spec.kind, spec.args, "tab", {focus = true, keep_open = true}) end)
   record("new-block-" .. KEY, {ok = ok, result = if ok then result else tostring(result)})
  end)
  return {handled = true}
 end
 return nil
end)
`;

type Run = Readonly<{ code: number; stdout: string; stderr: string }>;

type TernProbe = Readonly<{
  root: string;
  run: (args: readonly string[]) => Promise<Run>;
  until: (condition: () => Promise<boolean>, timeoutMs?: number) => Promise<boolean>;
  ctl: (key: string, ...args: string[]) => Promise<string>;
  start: (phase: string) => Promise<void>;
  stop: () => Promise<void>;
  observations: () => Promise<Record<string, unknown>>;
  listing: () => Promise<TernListing>;
  session: () => Promise<unknown>;
  record: (observation: Record<string, unknown>) => Promise<Record<string, unknown>>;
}>;

// Probes wait on real Tern processes, so they poll and pause on the wall clock. A fixed pause
// follows actions whose absence of effect is itself the observation.

/** An isolated daemon plus one window per key, with the probe plugin linked. */
async function startTern(
  name: string,
  windowKeys: readonly string[] = ["main"],
): Promise<TernProbe> {
  const root = await realpath(await mkdtemp(`/tmp/tdm-probe-${name}-`));
  const plugin = join(root, "plugin");
  const obs = join(root, "obs");
  const env = {
    HOME: root,
    USER: "tandem-test",
    LOGNAME: "tandem-test",
    SHELL: "/bin/zsh",
    TERM: "xterm-256color",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    ZDOTDIR: join(root, "zdot"),
    TERN_CONFIG_DIR: join(root, "config"),
    TERN_DAEMON_SOCKET: join(root, "d.sock"),
    STENCIL_LOG_DIR: join(root, "logs"),
    PROBE_OBS: obs,
  };
  await Promise.all(
    [plugin, obs, env.ZDOTDIR, env.TERN_CONFIG_DIR, join(root, "shots")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(join(plugin, "plugin.toml"), MANIFEST);
  await writeFile(join(plugin, "host.luau"), HOST);
  await writeFile(join(plugin, "window.luau"), WINDOW);
  const binary = Bun.which("tern", { PATH: env.PATH }) ?? TERN_BINARY;
  const run = async (args: readonly string[], extra: Record<string, string> = {}): Promise<Run> => {
    const child = Bun.spawn([binary, ...args], {
      cwd: root,
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const checked = async (...args: string[]) => {
    const result = await run(args);
    if (result.code !== 0) throw new Error(`tern ${args[0]}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  /** Waits for a condition; returns false instead of failing, because absence is an observation. */
  const until = async (condition: () => Promise<boolean>, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition().catch(() => false))) {
      if (Date.now() > deadline) return false;
      await Bun.sleep(50);
    }
    return true;
  };
  const control = (key: string) => join(root, `${key}.sock`);
  const ctl = (key: string, ...args: string[]) =>
    checked("ctl", "--control", control(key), ...args);
  let daemon: Bun.Subprocess | undefined;
  let windows: Bun.Subprocess[] = [];
  const start = async (phase: string) => {
    daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      cwd: root,
      env: { ...env, PROBE_PHASE: phase },
      stdout: "ignore",
      stderr: Bun.file(join(root, `daemon-${phase}.log`)),
    });
    if (!(await until(async () => (await run(["ls", "--json"])).code === 0)))
      throw new Error(`Tern daemon did not start: ${root}`);
    if (phase === "before") await checked("plugin", "link", plugin, "--json");
    for (const key of windowKeys)
      windows.push(
        await launchTernWindow({
          binary,
          control: control(key),
          args: ["--dir", root, "--out", join(root, "shots")],
          env: { ...env, PROBE_PHASE: phase, TERN_WINDOW_KEY: key },
          cwd: root,
          log: join(root, `window-${key}-${phase}.log`),
        }),
      );
  };
  const stop = async () => {
    for (const [index, window] of windows.entries()) {
      await ctl(windowKeys[index] ?? "", "quit").catch(() => undefined);
      if (window.exitCode === null) window.kill();
      await window.exited;
    }
    windows = [];
    daemon?.kill();
    await daemon?.exited;
    daemon = undefined;
  };
  const observations = async (): Promise<Record<string, unknown>> => {
    const names = (await readdir(obs)).filter((entry) => entry.endsWith(".json")).toSorted();
    return Object.fromEntries(
      await Promise.all(
        names.map(async (entry) => [
          entry.slice(0, -5),
          JSON.parse(await readFile(join(obs, entry), "utf8")) as unknown,
        ]),
      ),
    );
  };
  const listing = async () => decode(await checked("ls", "--json"), Listing, "tern ls");
  const session = async () =>
    JSON.parse(await checked("new", "session", "probe", "--cwd", root, "--json")) as unknown;
  /** Writes the observation next to the run's logs and returns what was saved. */
  const record = async (observation: Record<string, unknown>) => {
    const path = join(root, "observation.json");
    await writeFile(path, `${JSON.stringify(observation, null, 2)}\n`);
    console.log(`Tern probe ${name}: ${path}`);
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  };
  await start("before");
  return { root, run, until, ctl, start, stop, observations, listing, session, record };
}

async function probeRun(
  name: string,
  windowKeys: readonly string[] | undefined,
  body: (tern: TernProbe) => Promise<Record<string, unknown>>,
): Promise<void> {
  const tern = await startTern(name, windowKeys);
  try {
    const saved = await tern.record(await body(tern));
    expect(Object.keys(saved).length).toBeGreaterThan(0);
  } finally {
    await tern.stop();
  }
}

probe(
  "restored block args after a daemon restart",
  () =>
    probeRun("restored-args", undefined, async (tern) => {
      const created = await tern.session();
      const spec = join(tern.root, "args.probe-block.json");
      const args = ["/tmp/view.json", "101", "/tmp/cwd", "", '{"ctx":"opaque"}'];
      await writeFile(spec, JSON.stringify({ kind: "tandemprobe.args", args }));
      const opened = await tern.run(["open", spec, "--json"]);
      const initialized = await tern.until(async () =>
        Object.keys(await tern.observations()).some((key) => key.startsWith("block-args-before")),
      );
      const before = await tern.listing();
      await tern.stop();
      await tern.start("after");
      const restored = await tern.until(async () =>
        Object.keys(await tern.observations()).some((key) => key.startsWith("block-args-after")),
      );
      return {
        args,
        created,
        opened,
        initialized,
        restored,
        before: blocks(before).map((entry) => entry.block),
        after: blocks(await tern.listing()).map((entry) => entry.block),
        plugin: await tern.observations(),
      };
    }),
  120_000,
);

probe(
  "os.time inside a route callback",
  () =>
    probeRun("route-time", undefined, async (tern) => {
      await tern.session();
      const path = join(tern.root, "clock.probe-time.json");
      await writeFile(path, "{}");
      const wallBeforeMs = Date.now();
      const opened = await tern.run(["open", path, "--json"]);
      const routed = await tern.until(async () =>
        Object.keys(await tern.observations()).some((key) => key.startsWith("route-time-")),
      );
      return {
        wallBeforeMs,
        wallAfterMs: Date.now(),
        opened,
        routed,
        plugin: await tern.observations(),
      };
    }),
  120_000,
);

probe(
  "tern open on an already-open path",
  () =>
    probeRun("open-twice", undefined, async (tern) => {
      await tern.session();
      const file = join(tern.root, "notes.txt");
      const routed = join(tern.root, "again.probe-route.json");
      await writeFile(file, "probe\n");
      await writeFile(routed, "{}");
      const attempts = [];
      for (const path of [file, file, routed, routed]) {
        const result = await tern.run(["open", path, "--json"]);
        await Bun.sleep(500);
        attempts.push({
          path,
          result,
          blocks: blocks(await tern.listing()).map((entry) => entry.block),
        });
      }
      return { attempts, plugin: await tern.observations() };
    }),
  120_000,
);

probe(
  "decode time of an 8 MiB view file",
  () =>
    probeRun("decode-8mib", undefined, async (tern) => {
      await tern.session();
      const row = "x".repeat(1000);
      const target = 8 * 1024 * 1024 - 4096;
      const rows = Array.from({ length: Math.floor(target / (row.length + 3)) }, () => row);
      const text = JSON.stringify({ version: 1, kind: "panel", rows });
      const path = join(tern.root, "big.probe-decode.json");
      await writeFile(path, text);
      const opened = await tern.run(["open", path, "--json"]);
      const decoded = await tern.until(
        async () => Object.keys(await tern.observations()).some((key) => key.startsWith("decode-")),
        30_000,
      );
      return { bytes: Buffer.byteLength(text), opened, decoded, plugin: await tern.observations() };
    }),
  120_000,
);

probe(
  "cx:open versus tern browser targeting",
  () =>
    probeRun("open-vs-browser", undefined, async (tern) => {
      await tern.session();
      const url = "https://example.com/tandem-probe";
      const initial = blocks(await tern.listing()).map((entry) => entry.block);
      const spec = join(tern.root, "opener.probe-block.json");
      await writeFile(spec, JSON.stringify({ kind: "tandemprobe.opener", args: [url] }));
      const opened = await tern.run(["open", spec, "--json"]);
      await tern.until(async () => "cx-open" in (await tern.observations()));
      await Bun.sleep(1000);
      const afterCxOpen = blocks(await tern.listing()).map((entry) => entry.block);
      const owner = afterCxOpen.find((block) => block.program === "tandemprobe.opener");
      const browser =
        owner === undefined
          ? undefined
          : await tern.run([
              "browser",
              JSON.stringify({ op: "open", owner: Number(owner.id), url }),
              "--json",
            ]);
      await Bun.sleep(1000);
      return {
        url,
        initial,
        opened,
        afterCxOpen,
        browser,
        afterBrowser: blocks(await tern.listing()).map((entry) => entry.block),
        windowTree: await tern.ctl("main", "tree"),
        plugin: await tern.observations(),
      };
    }),
  120_000,
);

probe(
  "which window runs route.open",
  () =>
    probeRun("route-window", ["w1", "w2"], async (tern) => {
      await tern.session();
      const path = join(tern.root, "which.probe-route.json");
      await writeFile(path, "{}");
      const attempts = [];
      for (const scope of [[], ["--window", "w1"], ["--window", "w2"]]) {
        const result = await tern.run(["open", path, ...scope, "--json"]);
        await Bun.sleep(1500);
        attempts.push({ scope, result, plugin: await tern.observations() });
      }
      return { attempts };
    }),
  120_000,
);

probe(
  "two windows on one project and the OSC 777 entry",
  () =>
    probeRun("osc-two-windows", ["w1", "w2"], async (tern) => {
      await tern.session();
      const shell = blocks(await tern.listing()).find((entry) => entry.block.program === undefined);
      const title = "Tandem probe";
      const body = "two windows";
      const sent =
        shell === undefined
          ? undefined
          : await tern.run([
              "send",
              shell.block.id,
              "text",
              `printf '\\033]777;notify;${title};${body}\\007'\r`,
              "--json",
            ]);
      await Bun.sleep(2000);
      const trees = {
        w1: await tern.ctl("w1", "tree"),
        w2: await tern.ctl("w2", "tree"),
      };
      return {
        shell: shell?.block,
        sent,
        shownIn: Object.fromEntries(
          Object.entries(trees).map(([key, tree]) => [key, tree.includes(body)]),
        ),
        trees,
      };
    }),
  120_000,
);
