import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NativeAlerts } from "../../../src/board/native-alerts.ts";
import { NativeViewsReader } from "../../../src/board/native-read.ts";
import { readBoard } from "../../../src/board/read.ts";
import {
  type BoardSnapshot,
  publishNativeViews,
  writeBoardSnapshot,
} from "../../../src/board/snapshot.ts";
import { listCoordinatorRecords } from "../../../src/coordinator/registry.ts";
import { runTerminal } from "../../../src/main.ts";
import { recordNativePublication } from "../../../src/memory/native-visits.ts";
import { createTandemService } from "../../../src/service/controller.ts";
import { terminalBackend } from "../../../src/terminal-backend/compose.ts";
import { withNativeInput } from "../../../src/terminal/native-input.ts";
import { luauBinary } from "../../luau.ts";
import type { ScenarioTernProject, ScenarioWorld } from "../scenario.ts";

const PLUGIN = fileURLToPath(new URL("../../../tern-plugin/", import.meta.url));
const HOST = fileURLToPath(new URL("./host.luau", import.meta.url));
const FIRST_LUAU_PANE = 20001;
const FIRST_LUAU_TAB = 30001;
/** Staged route and launch timers use 1 ms; anything due this soon belongs to the current gesture. */
const SETTLE_WINDOW_MS = 50;

type Lua = string | number | boolean | undefined | readonly Lua[] | { readonly [key: string]: Lua };
type Command = Readonly<{ op: string } & { readonly [key: string]: Lua }>;

/** The stand-in's JSON encoder writes an empty Lua table as `{}`, so lists accept that too. */
function list<Item extends z.ZodTypeAny>(item: Item) {
  return z.preprocess(
    (value) =>
      typeof value === "object" && value !== null && Object.keys(value).length === 0 ? [] : value,
    z.array(item),
  );
}

export type ViewNode = Readonly<{
  k: string;
  tag?: string | undefined;
  p: Readonly<Record<string, unknown>>;
  c: readonly ViewNode[];
}>;
const ViewNode: z.ZodType<ViewNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    k: z.string(),
    tag: z.string().optional(),
    p: z.record(z.unknown()),
    c: list(ViewNode).default([]),
  }),
);
const Toast = z.object({
  pane: z.number().optional(),
  level: z.string(),
  title: z.string(),
  message: z.string(),
});
export type Toast = z.infer<typeof Toast>;
const HostEvent = z
  .object({
    created: z.object({
      id: z.number(),
      tab: z.number(),
      session: z.number(),
      program: z.string(),
      args: list(z.string()),
      cwd: z.string(),
    }),
    closed: z.number(),
    exit: z.object({ pane: z.number(), code: z.number() }),
    toast: Toast,
    open: z.object({ pane: z.number(), url: z.string() }),
    frame: z.unknown(),
    write: z.object({ path: z.string(), text: z.string() }),
    process: z.object({
      id: z.number(),
      argv: list(z.string()),
      cwd: z.string(),
      stdin: z.string().optional(),
    }),
    view: z.object({
      pane: z.number(),
      kind: z.string(),
      title: z.string().optional(),
      tree: z
        .object({
          main: ViewNode.optional(),
          dock: ViewNode.optional(),
          layer: ViewNode.optional(),
        })
        .optional(),
    }),
    route: z.object({ handled: z.boolean() }),
    link: z.object({ handled: z.boolean() }),
    commands: list(z.object({ id: z.string(), title: z.string(), visible: z.boolean() })),
    key: z.object({ name: z.string(), handled: z.boolean() }),
    command: z.string(),
    callbackError: z.object({ at: z.string(), message: z.string() }),
  })
  .partial();
export type HostEvent = z.infer<typeof HostEvent>;
const Line = z.object({
  events: list(HostEvent),
  error: z.string().optional(),
  next: z.number().optional(),
});
type Line = z.infer<typeof Line>;

export type Key = Readonly<{
  name: string;
  text?: string;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}>;

/** A visible string and the classes and tones of it and its ancestors, which carry its color. */
export type Span = Readonly<{ text: string; style: string }>;

/** What one block draws: its visible strings in order, and every enabled click by its label. */
export type Rendered = Readonly<{
  kind: string;
  title: string | undefined;
  text: readonly string[];
  spans: readonly Span[];
  actions: readonly Readonly<{ label: string; action: string }>[];
}>;

/** Tern ticks an `elapsed` node itself; draw it as the clock it starts at. */
function elapsedText(node: ViewNode): string | undefined {
  const age = node.p.age;
  if (node.k !== "elapsed" || typeof age !== "number") return undefined;
  const seconds = Math.floor(age / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function spans(node: ViewNode, inherited = ""): Span[] {
  const style = [inherited, node.p.class, node.p.tone]
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join(" ");
  const own: Span[] = [];
  for (const value of [node.p.text, node.p.label, node.p.placeholder, elapsedText(node)])
    if (typeof value === "string" && value !== "") own.push({ text: value, style });
  return [...own, ...node.c.flatMap((child) => spans(child, style))];
}

function clickable(node: ViewNode): Readonly<{ label: string; action: string }>[] {
  const actions = node.p.actions;
  const click =
    typeof actions === "object" && actions !== null && "click" in actions
      ? actions.click
      : undefined;
  const own =
    typeof click === "string"
      ? [
          {
            label: spans(node)
              .map((span) => span.text)
              .join(" "),
            action: click,
          },
        ]
      : [];
  return [...own, ...node.c.flatMap(clickable)];
}

/** A Lua long-bracket literal whose level does not occur in the text. */
function longString(text: string): string {
  let level = "";
  while (text.includes(`]${level}]`)) level += "=";
  return `[${level}[\n${text}]${level}]`;
}

function lua(value: Lua): string {
  if (value === undefined) return "nil";
  if (typeof value === "string") return longString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `{${value.map(lua).join(",")}}`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => `[ ${longString(key)} ]=${lua(entry)}`)
    .join(",")}}`;
}

async function listFiles(directory: string, pattern: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export type CliRun = Readonly<{
  argv: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/**
 * One Tern window over the scenario's fake terminal: the production plugin renders in the
 * `luau` VM and every `tern.process.run` reaches the real CLI through `runCli`.
 */
export class TernParityHost {
  readonly world: ScenarioWorld;
  readonly project: ScenarioTernProject;
  readonly events: HostEvent[] = [];
  readonly cli: CliRun[] = [];
  /** When set, `tern open` returns as Tern does but the route never reaches the plugin. */
  dropRoutes = false;
  readonly #modules: string;
  readonly #host: string;
  readonly #commands: Command[] = [];
  readonly #lines: string[] = [];
  readonly #files = new Map<string, string>();
  #paneKey: string | undefined;
  readonly #pending: NonNullable<HostEvent["process"]>[] = [];
  readonly #readers = new Map<string, NativeViewsReader>();
  #next: number | undefined;
  readonly #scratch: string;
  readonly #epochMs: number;

  private constructor(
    world: ScenarioWorld,
    project: ScenarioTernProject,
    modules: string,
    host: string,
    scratch: string,
  ) {
    this.world = world;
    this.project = project;
    this.#modules = modules;
    this.#host = host;
    this.#scratch = scratch;
    this.#epochMs = Date.parse(world.clock());
  }

  static async start(world: ScenarioWorld, project: ScenarioTernProject): Promise<TernParityHost> {
    const names = (await readdir(PLUGIN)).filter((name) => name.endsWith(".luau")).toSorted();
    const sources = await Promise.all(
      names.map(
        async (name) =>
          `["./${name.slice(0, -5)}"]=${longString(await readFile(join(PLUGIN, name), "utf8"))}`,
      ),
    );
    const host = new TernParityHost(
      world,
      project,
      `local MODULES={${sources.join(",\n")}}\n`,
      await readFile(HOST, "utf8"),
      await mkdtemp("/tmp/tandem-parity-"),
    );
    world.routeTernOpen((path) => host.#route(path));
    await host.send({ op: "boot" });
    return host;
  }

  async close(): Promise<void> {
    for (const reader of this.#readers.values()) await reader.settle();
    await rm(this.#scratch, { recursive: true, force: true });
  }

  /** The panel opens the way a coordinator launch opens it, through the Tern backend. */
  async openPanel(project: ScenarioTernProject = this.project): Promise<number> {
    const id = await terminalBackend(this.world.run, { home: this.world.home }).openPanel({
      coordinator: project.coordinator,
      cwd: project.worktree.path,
      project: project.repoPath,
    });
    await this.settle();
    return Number(id);
  }

  /**
   * One coordinator tick: the board snapshot, alerts and native views, written by the same
   * functions the coordinator's publisher composes. `snapshotAgeMs` models a board snapshot
   * that is older than the read that publishes it.
   */
  async publish(
    project: ScenarioTernProject = this.project,
    options: Readonly<{ snapshotAgeMs?: number }> = {},
  ): Promise<void> {
    const { home, clock, run, sessionId } = this.world;
    const terminal = terminalBackend(run, { home });
    const records = await listCoordinatorRecords(home, sessionId);
    const snapshot: BoardSnapshot = {
      version: 1,
      writtenAt: new Date(Date.parse(clock()) - (options.snapshotAgeMs ?? 0)).toISOString(),
      board: await readBoard(home, clock),
      coordinators: records.map((record) => ({
        repoPath: record.repoPath,
        project: basename(record.repoPath),
        terminal: record.endpoint.terminal,
        workspaceId: record.endpoint.workspaceId,
        paneId: record.endpoint.paneId,
      })),
    };
    await writeBoardSnapshot(home, snapshot);
    const sessions = new Map(
      records.map((record) => [
        record.repoPath,
        { terminal: "tern", sessionId: record.endpoint.sessionId },
      ]),
    );
    const deps = { home, clock, run, terminal };
    const reader = this.#readers.get(project.repoPath) ?? new NativeViewsReader(deps);
    this.#readers.set(project.repoPath, reader);
    await new NativeAlerts(deps).observe(snapshot, project.repoPath, sessionId);
    for (let attempt = 0; ; attempt++) {
      const view = await publishNativeViews(home, project.repoPath, () =>
        reader.read(snapshot, project.repoPath, sessions),
      );
      const refreshing = view.bundle.warnings.some((warning) => warning.includes("refreshing"));
      if (!refreshing || attempt > 40) {
        await recordNativePublication({
          home,
          project: project.repoPath,
          signature: view.bundle.changeSignature,
        });
        return;
      }
      await Bun.sleep(5);
    }
  }

  /** Lets every open block poll its file again, as Tern's one-second watch timers do. */
  async refresh(): Promise<void> {
    await this.send({ op: "advance", ms: 1001 });
    await this.settle();
  }

  /** Fires the staged timers and launches of the current gesture until nothing is due soon. */
  async settle(options: Readonly<{ processes: boolean }> = { processes: true }): Promise<void> {
    for (let round = 0; round < 200; round++) {
      const process = options.processes ? this.#pending.shift() : undefined;
      if (process !== undefined) {
        const result = await this.runCli(process);
        await this.send({
          op: "result",
          id: process.id,
          status: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        continue;
      }
      if (this.#next === undefined || this.#next > SETTLE_WINDOW_MS) return;
      await this.send({ op: "advance", ms: Math.max(1, this.#next) });
    }
    throw new Error("Tern window did not settle");
  }

  screen(pane: number): Screen {
    return new Screen(this, pane);
  }

  /** The pane of the one live block of this kind. */
  pane(kind: string): number {
    const matches = this.world.ternBlocks().filter((block) => block.program === `tandem.${kind}`);
    if (matches.length !== 1)
      throw new Error(`expected one tandem.${kind} block, found ${matches.length}`);
    return Number(matches[0]?.paneId);
  }

  /** Events since `mark`, for asserting one gesture's toasts, opens and exits. */
  since(mark: number): readonly HostEvent[] {
    return this.events.slice(mark);
  }

  toasts(mark = 0): readonly Toast[] {
    return this.since(mark).flatMap((event) => (event.toast === undefined ? [] : [event.toast]));
  }

  /** Every registered window command, and whether Tern's palette lists it. */
  async commands(): Promise<readonly Readonly<{ id: string; title: string; visible: boolean }>[]> {
    const line = await this.send({ op: "commands" });
    return line.events.find((event) => event.commands !== undefined)?.commands ?? [];
  }

  async command(id: string): Promise<void> {
    await this.send({ op: "command", id });
    await this.settle();
  }

  /** A link click in a coordinator reply; the click focuses the coordinator's pane first. */
  async link(url: string): Promise<boolean> {
    await this.focus(Number(this.project.coordinator.paneId));
    const line = await this.send({ op: "link", url });
    await this.settle();
    return line.events.some((event) => event.link?.handled === true);
  }

  async focus(pane: number): Promise<void> {
    await this.send({ op: "focus", pane });
    await this.settle();
  }

  async windowStart(): Promise<void> {
    await this.send({ op: "windowStart" });
    await this.settle();
  }

  async fault(name: "move" | "newBlock" | "spawn", enabled: boolean): Promise<void> {
    await this.send({ op: "fault", name, enabled });
  }

  /**
   * The only transport later steps may change: Luau's argv and stdin run the real CLI
   * in-process against the scenario home, exactly as `tandem.sh` and `native-input.sh` do.
   */
  async runCli(
    process: Readonly<{ argv: readonly string[]; stdin?: string }>,
  ): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
    const [shell, script, ...rest] = process.argv;
    if (shell !== "/bin/sh") throw new Error(`Tern plugin spawned ${shell}`);
    const { world } = this;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const invoke = (argv: readonly string[]) =>
      runTerminal(argv, {
        cwd: PLUGIN,
        processEnvironment: {
          TANDEM_HOME: world.home,
          TANDEM_SESSION: world.sessionId,
          TANDEM_POOL_ROOT: world.poolRoot,
        },
        run: world.run,
        terminal: terminalBackend(world.run, { home: world.home }),
        createService: (options) =>
          createTandemService({
            ...options,
            run: world.run,
            clock: world.clock,
            idFactory: world.idFactory,
          }),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
    let exitCode: number;
    if (script === "tandem.sh") exitCode = (await invoke(rest)).exitCode;
    else if (script === "native-input.sh") {
      const [verb, id, ...context] = rest;
      if (verb === undefined || id === undefined) throw new Error("native-input.sh needs a verb");
      exitCode = await withNativeInput(
        process.stdin ?? "",
        async (path) => (await invoke(["native", verb, id, "--input", path, ...context])).exitCode,
      );
    } else throw new Error(`Tern plugin ran unknown script ${script}`);
    const run = { argv: process.argv, exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
    this.cli.push(run);
    return run;
  }

  async send(...commands: Command[]): Promise<Line> {
    const sync = await this.#sync();
    const appended = [...(sync === undefined ? [] : [sync]), ...commands];
    this.#commands.push(...appended);
    const source = [
      this.#modules,
      `local CONFIG=${lua({
        epochMs: this.#epochMs,
        firstPaneId: FIRST_LUAU_PANE,
        firstTabId: FIRST_LUAU_TAB,
        env: { TERN_WINDOW_KEY: "parity-window" },
      })}\n`,
      `local COMMANDS={${this.#commands.map(lua).join(",\n")}}\n`,
      this.#host,
    ].join("");
    const script = join(this.#scratch, "replay.luau");
    await writeFile(script, source);
    const child = Bun.spawn([luauBinary(), script], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`luau replay failed (${status}): ${stderr}${stdout}`);
    const lines = stdout
      .split("\n")
      .filter((line) => line.startsWith("@@"))
      .map((line) => line.slice(line.indexOf("\t") + 1));
    if (lines.length !== this.#commands.length)
      throw new Error(`luau replay printed ${lines.length} of ${this.#commands.length} results`);
    for (const [index, line] of this.#lines.entries())
      if (lines[index] !== line)
        throw new Error(`luau replay diverged at command ${index + 1}: ${line} → ${lines[index]}`);
    const fresh = lines.slice(this.#lines.length);
    this.#lines.push(...fresh);
    let last: Line = { events: [] };
    for (const text of fresh) {
      last = Line.parse(JSON.parse(text));
      if (last.error !== undefined) throw new Error(`Tern host stand-in failed: ${last.error}`);
      await this.#apply(last.events);
      this.#next = last.next;
    }
    return last;
  }

  async #apply(events: readonly HostEvent[]): Promise<void> {
    for (const event of events) {
      this.events.push(event);
      if (event.callbackError !== undefined)
        throw new Error(
          `Tern plugin callback failed in ${event.callbackError.at}: ${event.callbackError.message}`,
        );
      if (event.created !== undefined) {
        const { id, tab, session, program, args, cwd } = event.created;
        this.world.openPane({
          paneId: String(id),
          cwd,
          blockProgram: program,
          blockArgs: args,
          terminalSessionId: String(session),
          anchor: { ...this.project.coordinator, workspaceId: String(tab), tabId: String(tab) },
        });
      }
      if (event.closed !== undefined && this.world.paneIsPresent(String(event.closed)))
        this.world.removePane(String(event.closed));
      if (event.write !== undefined) {
        const path = relative(this.world.home, event.write.path);
        if (path.startsWith("..") || isAbsolute(path))
          throw new Error(`Tern plugin wrote outside the Tandem home: ${event.write.path}`);
        await writeFile(event.write.path, event.write.text, { mode: 0o600 });
      }
      if (event.process !== undefined) this.#pending.push(event.process);
    }
  }

  /** Mirrors the scenario's panes and Tandem's published files into the window before a command. */
  async #sync(): Promise<Command | undefined> {
    const panes = this.world.ternBlocks().map((block) => ({
      id: Number(block.paneId),
      tab: Number(block.tabId),
      session: Number(block.sessionId),
      block: block.program ?? "terminal",
      cwd: block.cwd,
    }));
    const paneKey = JSON.stringify(panes);
    const paths = [
      ...(await listFiles(join(this.world.home, "native-views"), /\.json$/u)),
      ...(await listFiles(join(this.world.home, "native-host"), /\.tandem-open\.json$/u)),
    ];
    const files: Record<string, string | boolean> = {};
    for (const path of paths) {
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text !== undefined && this.#files.get(path) !== text) {
        files[path] = text;
        this.#files.set(path, text);
      }
    }
    for (const path of [...this.#files.keys()])
      if (!paths.includes(path)) {
        files[path] = false;
        this.#files.delete(path);
      }
    if (this.#paneKey === paneKey && Object.keys(files).length === 0) return undefined;
    this.#paneKey = paneKey;
    return { op: "sync", panes, files };
  }

  async #route(path: string) {
    if (!this.dropRoutes) {
      await this.send({ op: "route", path });
      await this.settle({ processes: false });
    }
    return { code: 1, stdout: "", stderr: "tern: cannot open in a file block" };
  }
}

/** One block as the user sees and drives it. Every gesture settles before it returns. */
export class Screen {
  readonly #host: TernParityHost;
  readonly pane: number;
  constructor(host: TernParityHost, pane: number) {
    this.#host = host;
    this.pane = pane;
  }

  async render(): Promise<Rendered> {
    const line = await this.#host.send({ op: "render", pane: this.pane });
    const view = line.events.find((event) => event.view !== undefined)?.view;
    if (view === undefined) throw new Error(`pane ${this.pane} did not render`);
    const roots = [view.tree?.layer, view.tree?.main, view.tree?.dock].filter(
      (node): node is ViewNode => node !== undefined,
    );
    const drawn = roots.flatMap((root) => spans(root));
    return {
      kind: view.kind,
      title: view.title,
      text: drawn.map((span) => span.text),
      spans: drawn,
      actions: roots.flatMap(clickable),
    };
  }

  /**
   * Clicks the one enabled control whose label is exactly `label`, or matches it; `nth` picks
   * one of several identical controls, such as a brief's per-line `+`, in drawing order. With
   * `hold`, any CLI it starts stays in flight until the next `host.settle()`.
   */
  async click(
    label: string | RegExp,
    options: Readonly<{ hold?: boolean; nth?: number }> = {},
  ): Promise<void> {
    const { actions } = await this.render();
    const matches = actions.filter((entry) =>
      typeof label === "string" ? entry.label === label : label.test(entry.label),
    );
    const chosen =
      options.nth === undefined ? matches : matches.slice(options.nth - 1, options.nth);
    if (chosen.length !== 1 || (options.nth === undefined && matches.length !== 1))
      throw new Error(
        `expected one enabled "${String(label)}" in pane ${this.pane}, found ${matches.length}: ${JSON.stringify(actions.map((entry) => entry.label))}`,
      );
    await this.#host.send({ op: "action", pane: this.pane, action: chosen[0]?.action ?? "" });
    await this.#host.settle({ processes: options.hold !== true });
  }

  async press(key: Key): Promise<boolean> {
    const line = await this.#host.send({ op: "key", pane: this.pane, key });
    await this.#host.settle();
    return line.events.some((event) => event.key?.handled === true);
  }

  async type(text: string): Promise<void> {
    await this.#host.send({ op: "type", pane: this.pane, text });
    await this.#host.settle();
  }

  /** Tern's focus event when the user clicks into a field. */
  async focusField(id: string): Promise<void> {
    await this.#host.send({ op: "event", pane: this.pane, event: { ev: "focus", id } });
    await this.#host.settle();
  }
}
