import {
  focusedProject,
  type PanelFocus,
  type PanelTarget,
  type PanelView,
  panelView,
} from "../board/panel.ts";
import type { BoardSnapshot, PanelCoordinator } from "../board/snapshot.ts";
import { draw, type Line, span } from "../board/terminal.ts";
import type { CommandRunner, TerminalName } from "../contracts.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { clickStep, keyboardStep, readPanelToken } from "./panel-input.ts";
import { bodyLines, type PanelStyle, scrollStart, topLines } from "./panel-render.ts";

export type PanelInput =
  | Readonly<{ kind: "up" | "down" | "enter" | "escape" | "backspace" | "interrupt" }>
  | Readonly<{ kind: "char"; char: string }>
  /** A left-button press, in 1-based terminal cells. */
  | Readonly<{ kind: "click"; x: number; y: number }>
  | Readonly<{ kind: "focus"; focused: boolean }>;

export type PanelState = Readonly<{
  /** The current project's checkout path. */
  readonly project: string | undefined;
  /** The search line's text; undefined while it is closed. */
  readonly query: string | undefined;
  readonly selected: string | undefined;
  /** Row signatures as they were when the panel last lost focus. */
  readonly seen: ReadonlySet<string> | undefined;
  /** The first-run key help is showing. */
  readonly help: boolean;
  /** Why the last go or switch did not get there; the next key clears it. */
  readonly notice?: string;
  /** Keys of the rows whose step checklist is showing. */
  readonly expanded: ReadonlySet<string>;
  readonly lastClick?: Readonly<{ key: string; at: number }>;
}>;

export type PanelHit = Readonly<{ y: number; from: number; to: number }> &
  (Readonly<{ kind: "chip"; repoPath: string }> | Readonly<{ kind: "row"; key: string }>);

export type PanelFrame = Readonly<{
  readonly view: PanelView;
  readonly hits: readonly PanelHit[];
  readonly popup: boolean;
  /** Milliseconds, for telling a double-click from two clicks. */
  readonly now: number;
}>;

export type PanelEffect =
  | Readonly<{ kind: "go"; target: PanelTarget }>
  | Readonly<{ kind: "switch"; repoPath: string }>
  | Readonly<{ kind: "close" }>;

type Step = Readonly<{ state: PanelState; effect?: PanelEffect }>;

/** One move toward a target; when it fails and has a `failure`, the effect stops there and says so. */
export type NavigationStep = Readonly<{ failure?: string }> &
  (
    | Readonly<{ kind: "workspace"; terminal?: TerminalName; workspaceId: string }>
    | Readonly<{ kind: "agent"; terminal?: TerminalName; paneId: string }>
    | Readonly<{ kind: "url"; url: string }>
  );

/** What a terminal key bound to one of the panel's actions does, from anywhere. */
export type PanelAction = "home" | "prev" | "next";

function focusSteps(
  workspaceId: string,
  paneId?: string,
  terminal?: TerminalName,
): NavigationStep[] {
  const source = terminal === undefined ? {} : { terminal };
  const steps: NavigationStep[] = [
    { kind: "workspace", workspaceId, ...source, failure: "⚠ couldn't focus it" },
  ];
  if (paneId !== undefined) steps.push({ kind: "agent", paneId, ...source });
  return steps;
}
function chatSteps(repoPath: string, coordinators: readonly PanelCoordinator[]): NavigationStep[] {
  const found = coordinators.find((candidate) => candidate.repoPath === repoPath);
  return found === undefined ? [] : focusSteps(found.workspaceId, found.paneId, found.terminal);
}
type StepDeps = Pick<PanelDeps, "run" | "terminal" | "sessionId" | "cwd">;

async function takeStep(step: NavigationStep, deps: StepDeps): Promise<boolean> {
  const { sessionId, cwd, terminal, run } = deps;
  if (step.kind !== "url" && (step.terminal ?? "herdr") !== terminal.name) return false;
  if (step.kind === "workspace") {
    return (await terminal.focusWorkspace({ sessionId, cwd, workspaceId: step.workspaceId }))
      .focused;
  }
  if (step.kind === "agent") return terminal.focusAgent({ sessionId, cwd, paneId: step.paneId });
  return (await run({ argv: ["open", step.url], cwd })).code === 0;
}

export type PanelActionDeps = StepDeps & Pick<PanelDeps, "readSnapshot" | "focus">;

/**
 * Splits raw terminal input into keys, left clicks (SGR mouse), and focus changes. An escape
 * sequence cut off at the end comes back as `pending` to join the next read, unless `final`.
 */
export function parsePanelInput(
  chunk: string,
  final: boolean,
): Readonly<{ inputs: PanelInput[]; pending: string }> {
  const inputs: PanelInput[] = [];
  let rest = chunk;
  while (rest.length > 0) {
    const token = readPanelToken(rest, final);
    if (token.pending) return { inputs, pending: rest };
    if (token.input !== undefined) inputs.push(token.input);
    rest = rest.slice(token.length);
  }
  return { inputs, pending: "" };
}

/** What one input does to the panel, and what it asks the outside world to do. */
export function panelStep(state: PanelState, input: PanelInput, frame: PanelFrame): Step {
  if (input.kind === "focus") {
    return input.focused
      ? { state }
      : { state: { ...state, seen: new Set(frame.view.signatures) } };
  }
  if (input.kind === "interrupt") return { state, effect: { kind: "close" } };
  if (input.kind === "click") return clickStep(state, input, frame);
  const step = keyboardStep(state, input, frame);
  const { notice: _cleared, ...rest } = step.state;
  return { ...step, state: { ...rest, help: false } };
}

/**
 * The steps for an effect, in order. Focusing the workspace lands on its active pane; focusing
 * the agent then picks the exact pane, which the terminal may refuse for a pane it does not know
 * runs an agent, so that may fail without failing the effect. Switching project lands in its
 * coordinator's chat, the same as going there. No steps means there is nowhere to go.
 */
export function navigationSteps(
  effect: Exclude<PanelEffect, { kind: "close" }>,
  coordinators: readonly PanelCoordinator[],
): readonly NavigationStep[] {
  if (effect.kind === "switch") return chatSteps(effect.repoPath, coordinators);
  const { target } = effect;
  if (target.kind === "url") {
    return [{ kind: "url", url: target.url, failure: "⚠ couldn't open the link" }];
  }
  if (target.kind === "pane") return focusSteps(target.workspaceId, target.paneId, target.terminal);
  if (target.kind === "chat") return chatSteps(target.repoPath, coordinators);
  return [];
}

/**
 * The steps for a panel action key: home goes to the focused project's chat; prev and
 * next go to the neighboring project with an open coordinator, wrapping around.
 */
export function panelActionSteps(
  action: PanelAction,
  snapshot: BoardSnapshot,
  focus: PanelFocus,
): readonly NavigationStep[] {
  const project = focusedProject(snapshot, focus);
  if (project === undefined) return [];
  if (action === "home") return chatSteps(project, snapshot.coordinators);
  const online = snapshot.board.projectPaths.filter((path) =>
    snapshot.coordinators.some((coordinator) => coordinator.repoPath === path),
  );
  const at = online.indexOf(project);
  const by = action === "next" ? 1 : -1;
  // From a project with no open coordinator, next starts at the first and prev at the last.
  let neighbor: string | undefined;
  if (at === -1) neighbor = by === 1 ? online[0] : online.at(-1);
  else neighbor = online[(at + by + online.length) % online.length];
  return neighbor === undefined ? [] : chatSteps(neighbor, snapshot.coordinators);
}

/** Runs a panel action key; the reason it went nowhere, or undefined when it went. */
export async function runPanelAction(
  action: PanelAction,
  deps: PanelActionDeps,
): Promise<string | undefined> {
  const snapshot = await deps.readSnapshot();
  const steps = snapshot === undefined ? [] : panelActionSteps(action, snapshot, deps.focus);
  if (steps.length === 0) return "no open coordinator to go to";
  for (const step of steps) {
    if (!(await takeStep(step, deps)) && step.failure !== undefined) return step.failure;
  }
  return undefined;
}
/**
 * The panel as terminal lines, plus where each chip and row sits for mouse clicks. Taller than
 * `height`, the rows scroll to keep the selection in sight while the top and footer stay put.
 */
export function renderPanel(
  view: PanelView,
  state: PanelState,
  style: PanelStyle,
): Readonly<{ lines: readonly string[]; hits: readonly PanelHit[] }> {
  const hits: PanelHit[] = [];
  const top = topLines(view, state, style, hits);
  const rows = view.sections.flatMap((section) => section.rows);
  const selected = rows.find((row) => row.key === state.selected)?.key ?? rows[0]?.key;
  const { body, spans } = bodyLines(view, state, style.width, selected);
  const bottom: Line[] = [view.footer, state.notice].flatMap((text) =>
    text === undefined ? [] : [[span(text, "yellow")]],
  );
  const room =
    style.height === undefined
      ? body.length
      : Math.max(1, style.height - top.length - bottom.length);
  const chosen = spans.find((each) => each.key === selected);
  const start = scrollStart(body.length, room, chosen);
  for (const each of spans) {
    for (let index = each.first; index <= each.last; index += 1) {
      if (index < start || index >= start + room) continue;
      hits.push({
        kind: "row",
        key: each.key,
        y: top.length + index - start + 1,
        from: 1,
        to: style.width,
      });
    }
  }
  const lines = [...top, ...body.slice(start, start + room), ...bottom];
  return {
    lines: lines.map((line) => draw(line, { color: style.color, columns: style.width })),
    hits,
  };
}

type PanelTTY = NodeJS.ReadableStream & { isTTY: true; setRawMode: (raw: boolean) => void };

function isPanelTTY(input: NodeJS.ReadableStream): input is PanelTTY {
  return (
    "isTTY" in input &&
    input.isTTY === true &&
    "setRawMode" in input &&
    input.setRawMode !== undefined
  );
}

/**
 * Draws the panel from the snapshot file until it is closed, a signal ends it, or drawing
 * fails; the terminal is put back in every case. Without a terminal to read keys from, it draws
 * once and returns.
 */
export async function runPanel(deps: PanelDeps): Promise<void> {
  const session = new PanelSession(deps);
  await session.refresh();
  if (!isPanelTTY(deps.input)) {
    deps.write(`${session.layout().lines.join("\n")}\n`);
    return;
  }
  await session.run(deps.input);
}

export type PanelDeps = Readonly<{
  readonly input: NodeJS.ReadableStream;
  readonly write: (text: string) => void;
  readonly size: () => Readonly<{ columns?: number; rows?: number }>;
  readonly color: boolean;
  readonly clock: () => Date;
  /** The snapshot, undefined when there is none yet; throws when it cannot be read. */
  readonly readSnapshot: () => Promise<BoardSnapshot | undefined>;
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
  readonly sessionId: string;
  /** Where the terminal's focus was when the panel opened; its project is the one shown first. */
  readonly focus: PanelFocus;
  readonly cwd: string;
  readonly popup: boolean;
  /** Whether the first-run key help still shows, and how to remember that it was used. */
  readonly helpUnseen: boolean;
  readonly rememberHelpSeen: () => Promise<void>;
  /** Calls `stop` when the process is asked to end; returns how to stop listening. */
  readonly onExitSignal: (stop: () => void) => () => void;
  /** The split pane a coordinator opened the panel in, which it keeps `PANEL_WIDTH` wide. */
  readonly paneId: string | undefined;
  /** Calls `resized` when the terminal changes size; returns how to stop listening. */
  readonly onResize: (resized: () => void) => () => void;
}>;

const REFRESH_MS = 1_000;
/** How long a lone Esc waits for the rest of an escape sequence split across reads. */
const ESCAPE_WAIT_MS = 50;
const SCREEN_ON = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1004h";
const SCREEN_OFF = "\x1b[?1004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";
const PANEL_WIDTH = 46;
const HOME_CLEAR = "\x1b[H\x1b[2J";
const NO_COORDINATOR = "⚠ no coordinator is open for that project";

class PanelSession {
  private closing: boolean = false;
  private snapshot: BoardSnapshot | undefined;
  private readFailed = false;
  private state: PanelState;
  private shown = "";
  private hits: readonly PanelHit[] = [];
  private fittedAreaWidth: number | undefined;
  private fitting = Promise.resolve();
  private readonly completion = Promise.withResolvers<void>();

  constructor(private readonly deps: PanelDeps) {
    this.state = {
      project: undefined,
      query: undefined,
      selected: undefined,
      seen: undefined,
      help: deps.helpUnseen,
      expanded: new Set(),
    };
  }

  async refresh(): Promise<void> {
    try {
      this.snapshot = (await this.deps.readSnapshot()) ?? this.snapshot;
      this.readFailed = false;
    } catch {
      this.readFailed = true;
    }
    if (this.state.project === undefined && this.snapshot !== undefined) {
      this.state = { ...this.state, project: focusedProject(this.snapshot, this.deps.focus) };
    }
  }

  private view() {
    return panelView(this.snapshot, {
      project: this.state.project,
      query: this.state.query ?? "",
      now: this.deps.clock().toISOString(),
      readFailed: this.readFailed,
      ...(this.state.seen === undefined ? {} : { seen: this.state.seen }),
    });
  }

  layout() {
    const { columns, rows } = this.deps.size();
    return renderPanel(this.view(), this.state, {
      width: columns ?? PANEL_WIDTH,
      ...(rows === undefined ? {} : { height: rows }),
      color: this.deps.color,
      popup: this.deps.popup,
    });
  }

  redraw(): void {
    if (this.closing) return;
    const rendered = this.layout();
    this.hits = rendered.hits;
    const text = rendered.lines.join("\n");
    if (text !== this.shown) this.deps.write(`${HOME_CLEAR}${text}`);
    this.shown = text;
  }

  private async navigate(effect: Exclude<PanelEffect, { kind: "close" }>): Promise<void> {
    const steps = navigationSteps(effect, this.snapshot?.coordinators ?? []);
    let notice = steps.length === 0 ? NO_COORDINATOR : undefined;
    for (const step of steps) {
      const arrived = await takeStep(step, this.deps).catch(() => false);
      if (!arrived && step.failure !== undefined) {
        notice = step.failure;
        break;
      }
    }
    if (notice !== undefined) this.state = { ...this.state, notice };
    else if (this.deps.popup) this.completion.resolve();
    this.guarded(() => this.redraw());
  }

  handle(inputs: readonly PanelInput[]): void {
    for (const input of inputs) {
      const wasHelp = this.state.help;
      const step = panelStep(this.state, input, {
        view: this.view(),
        hits: this.hits,
        popup: this.deps.popup,
        now: this.deps.clock().getTime(),
      });
      this.state = step.state;
      if (wasHelp && !this.state.help) void this.deps.rememberHelpSeen().catch(() => undefined);
      if (step.effect?.kind === "close") this.completion.resolve();
      else if (step.effect !== undefined) void this.navigate(step.effect);
    }
    this.redraw();
  }

  // One fit at a time, so a burst of resizes reads the width the previous fit left.
  keepWidth(): void {
    const paneId = this.deps.paneId;
    if (paneId === undefined) return;
    this.fitting = this.fitting
      .then(async () => {
        const fitted = await this.deps.terminal.fitPanel({
          sessionId: this.deps.sessionId,
          cwd: this.deps.cwd,
          paneId,
          columns: PANEL_WIDTH,
          fittedWidth: this.fittedAreaWidth,
        });
        this.fittedAreaWidth = fitted.fittedWidth;
        if (fitted.warnings.length > 0) {
          this.state = { ...this.state, notice: fitted.warnings.join(" ") };
          this.guarded(() => this.redraw());
        }
      })
      .catch(() => undefined);
  }
  private guarded(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.completion.reject(error);
    }
  }

  async run(input: PanelTTY): Promise<void> {
    const { deps } = this;
    const setRawMode = input.setRawMode.bind(input);
    let pending = "";
    let flush: ReturnType<typeof setTimeout> | undefined;
    const onData = (chunk: Buffer | string) =>
      this.guarded(() => {
        clearTimeout(flush);
        const parsed = parsePanelInput(pending + chunk.toString(), false);
        pending = parsed.pending;
        this.handle(parsed.inputs);
        if (pending.length === 0) return;
        flush = setTimeout(
          () =>
            this.guarded(() => {
              const rest = parsePanelInput(pending, true);
              pending = "";
              this.handle(rest.inputs);
            }),
          ESCAPE_WAIT_MS,
        );
      });
    const timer = setInterval(() => {
      void this.refresh().then(() => this.guarded(() => this.redraw()));
    }, REFRESH_MS);
    const stopListening = deps.onExitSignal(() => this.completion.resolve());
    const stopResizing = deps.onResize(() => {
      this.keepWidth();
      this.guarded(() => this.redraw());
    });
    this.keepWidth();
    try {
      setRawMode(true);
      deps.write(SCREEN_ON);
      input.on("data", onData);
      input.resume();
      this.redraw();
      await this.completion.promise;
    } finally {
      this.closing = true;
      clearInterval(timer);
      clearTimeout(flush);
      stopListening();
      stopResizing();
      input.off("data", onData);
      setRawMode(false);
      input.pause();
      deps.write(SCREEN_OFF);
    }
  }
}
