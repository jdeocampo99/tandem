import {
  type PanelColor,
  type PanelRow,
  type PanelTarget,
  type PanelView,
  panelProject,
  panelView,
} from "../board/panel.ts";
import type { BoardSnapshot, PanelCoordinator } from "../board/snapshot.ts";
import { draw, fit, type Line, lineWidth, span, type Tone } from "../board/terminal.ts";
import type { CommandRunner } from "../contracts.ts";

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
  readonly lastClick?: Readonly<{ key: string; at: number }>;
}>;

/** Where a click at a screen cell lands, as the last render laid it out. */
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

export type HerdrStep = Readonly<{ readonly argv: readonly string[]; readonly required: boolean }>;

const DOUBLE_CLICK_MS = 400;
const REFRESH_MS = 1_000;
const PANEL_WIDTH = 46;
const TONES: Readonly<Record<PanelColor, Tone>> = {
  yellow: "yellow",
  red: "red",
  blue: "blue",
  magenta: "magenta",
  green: "green",
};
const HELP = ["j k ↑ ↓ move · Enter go · / search", "1-9 [ ] project · Esc close · x hide"];

/** Splits raw terminal input into keys, left clicks (SGR mouse), and focus changes. */
export function parsePanelInput(chunk: string): PanelInput[] {
  const inputs: PanelInput[] = [];
  let rest = chunk;
  while (rest.length > 0) {
    const escaped = rest.startsWith("\x1b") ? rest.slice(1) : undefined;
    const mouse = escaped === undefined ? null : /^\[<(\d+);(\d+);(\d+)([Mm])/u.exec(escaped);
    const csi = escaped === undefined ? null : /^(?:\[[0-9;?]*|O)[@-~]/u.exec(escaped);
    if (mouse !== null) {
      if (mouse[4] === "M" && mouse[1] === "0") {
        inputs.push({ kind: "click", x: Number(mouse[2]), y: Number(mouse[3]) });
      }
      rest = rest.slice(1 + mouse[0].length);
    } else if (csi !== null) {
      const final = csi[0].at(-1);
      if (final === "A") inputs.push({ kind: "up" });
      if (final === "B") inputs.push({ kind: "down" });
      if (csi[0] === "[I" || csi[0] === "[O")
        inputs.push({ kind: "focus", focused: final === "I" });
      rest = rest.slice(1 + csi[0].length);
    } else {
      const char = rest[0] ?? "";
      rest = rest.slice(1);
      if (char === "\x1b") inputs.push({ kind: "escape" });
      else if (char === "\r" || char === "\n") inputs.push({ kind: "enter" });
      else if (char === "\x7f" || char === "\b") inputs.push({ kind: "backspace" });
      else if (char === "\x03") inputs.push({ kind: "interrupt" });
      else if (char >= " ") inputs.push({ kind: "char", char });
    }
  }
  return inputs;
}

/** What one input does to the panel, and what it asks the outside world to do. */
export function panelStep(
  state: PanelState,
  input: PanelInput,
  frame: PanelFrame,
): Readonly<{ state: PanelState; effect?: PanelEffect }> {
  const rows = frame.view.sections.flatMap((section) => section.rows);
  const index = Math.max(
    0,
    rows.findIndex((row) => row.key === state.selected),
  );
  const move = (by: number) => ({
    state: { ...state, selected: rows[Math.min(rows.length - 1, Math.max(0, index + by))]?.key },
  });
  const go = (row: PanelRow | undefined) =>
    row === undefined || row.target.kind === "none"
      ? { state }
      : { state, effect: { kind: "go", target: row.target } as const };
  const switchTo = (repoPath: string | undefined) =>
    repoPath === undefined
      ? { state }
      : {
          state: { ...state, project: repoPath, selected: undefined },
          effect: { kind: "switch", repoPath } as const,
        };
  const chips = frame.view.chips;
  const current = chips.findIndex((chip) => chip.current);
  if (input.kind === "focus") {
    return input.focused
      ? { state }
      : { state: { ...state, seen: new Set(rows.map((row) => row.signature)) } };
  }
  if (input.kind === "interrupt") return { state, effect: { kind: "close" } };
  if (input.kind === "click") {
    const hit = frame.hits.find(
      (each) => each.y === input.y && input.x >= each.from && input.x <= each.to,
    );
    if (hit?.kind === "chip") return switchTo(hit.repoPath);
    if (hit?.kind !== "row") return { state };
    const double =
      state.lastClick?.key === hit.key && frame.now - state.lastClick.at <= DOUBLE_CLICK_MS;
    const clicked = { ...state, selected: hit.key, lastClick: { key: hit.key, at: frame.now } };
    return double
      ? { ...go(rows.find((row) => row.key === hit.key)), state: clicked }
      : { state: clicked };
  }
  const step = ((): Readonly<{ state: PanelState; effect?: PanelEffect }> => {
    const key = input.kind === "char" ? input.char : input.kind;
    if (state.query !== undefined) {
      if (input.kind === "char") return { state: { ...state, query: state.query + input.char } };
      if (key === "backspace") return { state: { ...state, query: state.query.slice(0, -1) } };
      if (key === "escape") return { state: { ...state, query: undefined } };
    }
    if (key === "down" || key === "j") return move(1);
    if (key === "up" || key === "k") return move(-1);
    if (key === "enter") return go(rows[index]);
    if (state.query !== undefined) return { state };
    if (key === "/") return { state: { ...state, query: "" } };
    if (key === "escape") return frame.popup ? { state, effect: { kind: "close" } } : { state };
    if (/^[1-9]$/u.test(key)) return switchTo(chips[Number(key) - 1]?.repoPath);
    if ((key === "[" || key === "]") && chips.length > 0) {
      const next = (current + (key === "]" ? 1 : -1) + chips.length) % chips.length;
      return switchTo(chips[next]?.repoPath);
    }
    return { state };
  })();
  return { ...step, state: { ...step.state, help: false } };
}

/**
 * The Herdr commands for an effect, in order; a step that is not required may fail without
 * failing the effect. Focusing the workspace lands on its active pane; `agent focus` then picks
 * the exact pane, which Herdr allows only for panes it knows run an agent.
 */
export function navigationSteps(
  effect: Exclude<PanelEffect, { kind: "close" }>,
  sessionId: string,
  coordinators: readonly PanelCoordinator[],
): readonly HerdrStep[] {
  const herdr = (...args: string[]) => ["herdr", "--session", sessionId, ...args];
  const focus = (workspaceId: string, paneId?: string): HerdrStep[] => [
    { argv: herdr("workspace", "focus", workspaceId), required: true },
    ...(paneId === undefined ? [] : [{ argv: herdr("agent", "focus", paneId), required: false }]),
  ];
  const coordinator = (repoPath: string) =>
    coordinators.find((candidate) => candidate.repoPath === repoPath);
  if (effect.kind === "switch") {
    const found = coordinator(effect.repoPath);
    return found === undefined ? [] : focus(found.workspaceId);
  }
  const { target } = effect;
  if (target.kind === "url") return [{ argv: ["open", target.url], required: true }];
  if (target.kind === "pane") return focus(target.workspaceId, target.paneId);
  if (target.kind === "chat") {
    const found = coordinator(target.repoPath);
    return found === undefined ? [] : focus(found.workspaceId, found.paneId);
  }
  return [];
}

/** The panel as terminal text, plus where each chip and row sits for mouse clicks. */
export function renderPanel(
  view: PanelView,
  state: PanelState,
  style: Readonly<{ width: number; color: boolean }>,
): Readonly<{ text: string; hits: readonly PanelHit[] }> {
  const lines: Line[] = [];
  const hits: PanelHit[] = [];
  let x = 1;
  const chips: Line = view.chips.flatMap((chip) => {
    const label = ` ${chip.number} ${chip.name}${chip.needsYou > 0 ? ` ${chip.needsYou}` : ""}${chip.offline ? " offline" : ""} `;
    const width = lineWidth([span(label)]);
    hits.push({ kind: "chip", repoPath: chip.repoPath, y: 1, from: x, to: x + width - 1 });
    x += width + 1;
    const tones: Tone[] = chip.current ? ["inverse", "bold"] : chip.offline ? ["dim"] : [];
    return [span(label, ...tones), span(" ")];
  });
  lines.push(chips);
  lines.push(
    state.query === undefined
      ? [span(view.summary, "dim")]
      : [span("/ ", "cyan"), span(`${state.query}▏`)],
  );
  if (state.help) {
    const inner = Math.max(...HELP.map((line) => lineWidth([span(line)])));
    lines.push([span(`╭${"─".repeat(inner + 2)}╮`, "dim")]);
    for (const help of HELP) {
      lines.push([span("│ ", "dim"), span(help.padEnd(inner)), span(" │", "dim")]);
    }
    lines.push([span(`╰${"─".repeat(inner + 2)}╯`, "dim")]);
  }
  lines.push([]);
  if (view.quiet && state.query === undefined && view.chips.length > 0) {
    lines.push([span("✓ All quiet.", "green")], []);
  }
  const rows = view.sections.flatMap((section) => section.rows);
  const selected = rows.find((row) => row.key === state.selected)?.key ?? rows[0]?.key;
  for (const section of view.sections) {
    lines.push([span(section.title.toUpperCase(), "bold")]);
    for (const row of section.rows) {
      const first = lines.length + 1;
      lines.push(rowLine(row, row.key === selected, style.width));
      for (const text of row.lines.slice(0, 2)) lines.push([span(`    ${text}`, "dim")]);
      for (let y = first; y <= lines.length; y += 1) {
        hits.push({ kind: "row", key: row.key, y, from: 1, to: style.width });
      }
    }
    lines.push([]);
  }
  if (view.footer !== undefined) lines.push([span(view.footer, "yellow")]);
  const drawn = lines.map((line) => draw(line, { color: style.color, columns: style.width }));
  return { text: `${drawn.join("\n")}\n`, hits };
}

function rowLine(row: PanelRow, selected: boolean, width: number): Line {
  const stage = span(` ${row.stage}`, TONES[row.color]);
  const lead = [span(row.changed ? "•" : " ", "blue"), span(`${row.glyph} `, TONES[row.color])];
  const room = Math.max(1, width - lineWidth(lead) - lineWidth([stage]));
  const name = fit(
    [span(row.name, ...(selected ? (["inverse"] as const) : (["bold"] as const)))],
    room,
  );
  const gap = span(" ".repeat(Math.max(0, room - lineWidth(name))));
  return [...lead, ...name, gap, stage];
}

export type PanelDeps = Readonly<{
  readonly input: NodeJS.ReadableStream;
  readonly write: (text: string) => void;
  readonly columns: () => number | undefined;
  readonly color: boolean;
  readonly clock: () => Date;
  readonly readSnapshot: () => Promise<BoardSnapshot | undefined>;
  readonly run: CommandRunner;
  readonly sessionId: string;
  /** The directory the panel opened in; its project is the one shown first. */
  readonly cwd: string;
  readonly popup: boolean;
  /** Whether the first-run key help still shows, and how to remember that it was used. */
  readonly helpUnseen: boolean;
  readonly rememberHelpSeen: () => Promise<void>;
}>;

const SCREEN_ON = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1004h";
const SCREEN_OFF = "\x1b[?1004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";

/**
 * Draws the panel from the snapshot file until it is closed. Without a terminal to read keys
 * from, it draws once and returns.
 */
export async function runPanel(deps: PanelDeps): Promise<void> {
  let snapshot = await deps.readSnapshot();
  let state: PanelState = {
    project: undefined,
    query: undefined,
    selected: undefined,
    seen: undefined,
    help: deps.helpUnseen,
  };
  let shown = "";
  let hits: readonly PanelHit[] = [];
  const frame = (): PanelView => {
    const now = deps.clock().toISOString();
    if (state.project === undefined && snapshot !== undefined) {
      state = { ...state, project: panelProject(snapshot.board.projectPaths, deps.cwd) };
    }
    return panelView(snapshot, {
      project: state.project,
      query: state.query ?? "",
      now,
      ...(state.seen === undefined ? {} : { seen: state.seen }),
    });
  };
  const redraw = (view: PanelView, clear: string) => {
    const width = deps.columns() ?? PANEL_WIDTH;
    const rendered = renderPanel(view, state, { width, color: deps.color });
    hits = rendered.hits;
    if (rendered.text !== shown) deps.write(`${clear}${rendered.text}`);
    shown = rendered.text;
  };
  const tty = deps.input as NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  if (tty.isTTY !== true || tty.setRawMode === undefined) {
    redraw(frame(), "");
    return;
  }
  const { promise: closed, resolve: close } = Promise.withResolvers<void>();
  const navigate = async (effect: Exclude<PanelEffect, { kind: "close" }>) => {
    const steps = navigationSteps(effect, deps.sessionId, snapshot?.coordinators ?? []);
    for (const step of steps) {
      const result = await deps.run({ argv: step.argv, cwd: deps.cwd });
      if (result.code !== 0 && step.required) return;
    }
    if (steps.length > 0 && deps.popup) close();
  };
  const onData = (chunk: Buffer | string) => {
    for (const input of parsePanelInput(chunk.toString())) {
      const view = frame();
      const wasHelp = state.help;
      const step = panelStep(state, input, {
        view,
        hits,
        popup: deps.popup,
        now: deps.clock().getTime(),
      });
      state = step.state;
      if (wasHelp && !state.help) void deps.rememberHelpSeen().catch(() => undefined);
      if (step.effect?.kind === "close") close();
      else if (step.effect !== undefined) void navigate(step.effect);
    }
    redraw(frame(), "\x1b[H\x1b[2J");
  };
  tty.setRawMode(true);
  deps.write(SCREEN_ON);
  deps.input.on("data", onData);
  deps.input.resume();
  const timer = setInterval(() => {
    void deps.readSnapshot().then((read) => {
      snapshot = read ?? snapshot;
      redraw(frame(), "\x1b[H\x1b[2J");
    });
  }, REFRESH_MS);
  try {
    redraw(frame(), "\x1b[H\x1b[2J");
    await closed;
  } finally {
    clearInterval(timer);
    deps.input.off("data", onData);
    tty.setRawMode(false);
    deps.input.pause();
    deps.write(SCREEN_OFF);
  }
}
