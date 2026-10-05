import {
  focusedProject,
  type HerdrFocus,
  type PanelActivity,
  type PanelRow,
  type PanelStep,
  type PanelTarget,
  type PanelView,
  panelView,
} from "../board/panel.ts";
import type { BoardSnapshot, PanelCoordinator } from "../board/snapshot.ts";
import { draw, fit, fitStart, type Line, lineWidth, span, type Tone } from "../board/terminal.ts";
import type { CommandRunner } from "../contracts.ts";
import { isRecord } from "../coordinator/record.ts";

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

/** One command; when it fails and has a `failure`, the effect stops there and says so. */
export type HerdrStep = Readonly<{ readonly argv: readonly string[]; readonly failure?: string }>;

const DOUBLE_CLICK_MS = 400;
const REFRESH_MS = 1_000;
/** How long a lone Esc waits for the rest of an escape sequence split across reads. */
const ESCAPE_WAIT_MS = 50;
const PANEL_WIDTH = 46;
const HELP = [
  "j k ↑ ↓ move · Enter go · / search",
  "Space steps · 1-9 [ ] project",
  "Esc close · x hide",
];
const NO_COORDINATOR = "⚠ no coordinator is open for that project";
const STEP_MARKS: Readonly<Record<PanelStep["status"], string>> = {
  done: "☑",
  doing: "▸",
  todo: "☐",
  dropped: "☒",
};

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
    const escaped = rest.startsWith("\x1b") ? rest.slice(1) : undefined;
    if (escaped !== undefined && /^(?:\[[<0-9;?]*|O)?$/u.test(escaped)) {
      if (!final) return { inputs, pending: rest };
      if (escaped.length === 0) inputs.push({ kind: "escape" });
      return { inputs, pending: "" };
    }
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
      if (csi[0] === "[I" || csi[0] === "[O") {
        inputs.push({ kind: "focus", focused: final === "I" });
      }
      rest = rest.slice(1 + csi[0].length);
    } else {
      const char = String.fromCodePoint(rest.codePointAt(0) ?? 0);
      rest = rest.slice(char.length);
      if (char === "\x1b") inputs.push({ kind: "escape" });
      else if (char === "\r" || char === "\n") inputs.push({ kind: "enter" });
      else if (char === "\x7f" || char === "\b") inputs.push({ kind: "backspace" });
      else if (char === "\x03") inputs.push({ kind: "interrupt" });
      else if (char >= " ") inputs.push({ kind: "char", char });
    }
  }
  return { inputs, pending: "" };
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
      : { state: { ...state, seen: new Set(frame.view.signatures) } };
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
      if (key === "backspace") {
        return { state: { ...state, query: [...state.query].slice(0, -1).join("") } };
      }
      if (key === "escape") return { state: { ...state, query: undefined } };
    }
    if (key === "down" || key === "j") return move(1);
    if (key === "up" || key === "k") return move(-1);
    if (key === "enter") return go(rows[index]);
    if (state.query !== undefined) return { state };
    if (key === " ") return { state: toggleSteps(state, rows[index]) };
    if (key === "/") return { state: { ...state, query: "" } };
    if (key === "escape") return frame.popup ? { state, effect: { kind: "close" } } : { state };
    if (/^[1-9]$/u.test(key)) return switchTo(chips[Number(key) - 1]?.repoPath);
    if ((key === "[" || key === "]") && chips.length > 0) {
      const next = (current + (key === "]" ? 1 : -1) + chips.length) % chips.length;
      return switchTo(chips[next]?.repoPath);
    }
    return { state };
  })();
  const { notice: _cleared, ...rest } = step.state;
  return { ...step, state: { ...rest, help: false } };
}

function toggleSteps(state: PanelState, row: PanelRow | undefined): PanelState {
  if (row?.steps === undefined) return state;
  const expanded = new Set(state.expanded);
  if (!expanded.delete(row.key)) expanded.add(row.key);
  return { ...state, expanded };
}

/** A move of the border left of the panel, as a fraction of the split's width. */
export type PanelResize = Readonly<{
  /** The window width this fit is for; the panel refits only once it changes. */
  readonly areaWidth: number;
  readonly direction: "left" | "right";
  /** 0 when the panel already fits. */
  readonly amount: number;
}>;

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

function rect(value: unknown): Rect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
    ? { x, y, width, height }
    : undefined;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * How to bring the panel back to `PANEL_WIDTH` columns, from `herdr pane layout`, or undefined to
 * leave it alone. Herdr splits keep a ratio, so the panel refits whenever the window width
 * changes (a client attaches or the terminal resizes) and never when only the border moved, which
 * is the user dragging it. It never takes more than half its split.
 */
export function panelResize(
  layout: unknown,
  paneId: string,
  fittedAreaWidth: number | undefined,
): PanelResize | undefined {
  const fields =
    isRecord(layout) && isRecord(layout.result) && isRecord(layout.result.layout)
      ? layout.result.layout
      : undefined;
  const areaWidth = rect(fields?.area)?.width;
  if (areaWidth === undefined || areaWidth === fittedAreaWidth) return undefined;
  const own = rect(records(fields?.panes).find((pane) => pane.pane_id === paneId)?.rect);
  if (own === undefined) return undefined;
  const split = records(fields?.splits)
    .flatMap((entry) => {
      const bounds = rect(entry.rect);
      return entry.direction === "right" && bounds !== undefined ? [bounds] : [];
    })
    .filter(
      (bounds) =>
        bounds.x < own.x &&
        bounds.x + bounds.width === own.x + own.width &&
        bounds.y <= own.y &&
        own.y + own.height <= bounds.y + bounds.height,
    )
    .sort((a, b) => b.x - a.x)[0];
  if (split === undefined) return undefined;
  const target = Math.min(PANEL_WIDTH, Math.floor(split.width / 2));
  return {
    areaWidth,
    direction: own.width > target ? "right" : "left",
    amount: Math.abs(own.width - target) / split.width,
  };
}

/** Fits the panel's pane once for the current window width; the width it fitted for. */
async function fitPanelPane(
  deps: Pick<PanelDeps, "run" | "sessionId" | "cwd">,
  paneId: string,
  fittedAreaWidth: number | undefined,
): Promise<number | undefined> {
  const herdr = (...args: string[]) => ({
    argv: ["herdr", "--session", deps.sessionId, ...args],
    cwd: deps.cwd,
  });
  const layout = await deps.run(herdr("pane", "layout", "--pane", paneId));
  if (layout.code !== 0) return fittedAreaWidth;
  const resize = panelResize(JSON.parse(layout.stdout), paneId, fittedAreaWidth);
  if (resize === undefined) return fittedAreaWidth;
  if (resize.amount === 0) return resize.areaWidth;
  const resized = await deps.run(
    herdr(
      "pane",
      "resize",
      "--pane",
      paneId,
      "--direction",
      resize.direction,
      "--amount",
      resize.amount.toFixed(4),
    ),
  );
  return resized.code === 0 ? resize.areaWidth : fittedAreaWidth;
}

/**
 * The commands for an effect, in order. Focusing the workspace lands on its active pane;
 * `agent focus` then picks the exact pane, which Herdr allows only for panes it knows run an
 * agent, so it may fail without failing the effect. No steps means there is nowhere to go.
 */
export function navigationSteps(
  effect: Exclude<PanelEffect, { kind: "close" }>,
  sessionId: string,
  coordinators: readonly PanelCoordinator[],
): readonly HerdrStep[] {
  const herdr = (...args: string[]) => ["herdr", "--session", sessionId, ...args];
  const focus = (workspaceId: string, paneId?: string): HerdrStep[] => [
    { argv: herdr("workspace", "focus", workspaceId), failure: "⚠ Herdr couldn't focus it" },
    ...(paneId === undefined ? [] : [{ argv: herdr("agent", "focus", paneId) }]),
  ];
  const coordinator = (repoPath: string) =>
    coordinators.find((candidate) => candidate.repoPath === repoPath);
  if (effect.kind === "switch") {
    const found = coordinator(effect.repoPath);
    return found === undefined ? [] : focus(found.workspaceId);
  }
  const { target } = effect;
  if (target.kind === "url") {
    return [{ argv: ["open", target.url], failure: "⚠ couldn't open the link" }];
  }
  if (target.kind === "pane") return focus(target.workspaceId, target.paneId);
  if (target.kind === "chat") {
    const found = coordinator(target.repoPath);
    return found === undefined ? [] : focus(found.workspaceId, found.paneId);
  }
  return [];
}

/** What a Herdr key bound to one of the panel's plugin actions does, from anywhere. */
export type PanelAction = "home" | "prev" | "next";

/**
 * The Herdr commands for a panel action key: home goes to the focused project's chat; prev and
 * next go to the neighboring project with an open coordinator, wrapping around.
 */
export function panelActionSteps(
  action: PanelAction,
  snapshot: BoardSnapshot,
  focus: HerdrFocus,
  sessionId: string,
): readonly HerdrStep[] {
  const project = focusedProject(snapshot, focus);
  if (project === undefined) return [];
  if (action === "home") {
    return navigationSteps(
      { kind: "go", target: { kind: "chat", repoPath: project } },
      sessionId,
      snapshot.coordinators,
    );
  }
  const online = snapshot.board.projectPaths.filter((path) =>
    snapshot.coordinators.some((coordinator) => coordinator.repoPath === path),
  );
  const at = online.indexOf(project);
  const by = action === "next" ? 1 : -1;
  // From a project with no open coordinator, next starts at the first and prev at the last.
  const neighbor =
    at === -1
      ? by === 1
        ? online[0]
        : online.at(-1)
      : online[(at + by + online.length) % online.length];
  return neighbor === undefined
    ? []
    : navigationSteps({ kind: "switch", repoPath: neighbor }, sessionId, snapshot.coordinators);
}

export type PanelActionDeps = Readonly<{
  readonly readSnapshot: () => Promise<BoardSnapshot | undefined>;
  readonly run: CommandRunner;
  readonly sessionId: string;
  readonly focus: HerdrFocus;
  readonly cwd: string;
}>;

/** Runs a panel action key; the reason it went nowhere, or undefined when it went. */
export async function runPanelAction(
  action: PanelAction,
  deps: PanelActionDeps,
): Promise<string | undefined> {
  const snapshot = await deps.readSnapshot();
  const steps =
    snapshot === undefined ? [] : panelActionSteps(action, snapshot, deps.focus, deps.sessionId);
  if (steps.length === 0) return "no open coordinator to go to";
  for (const step of steps) {
    const result = await deps.run({ argv: step.argv, cwd: deps.cwd });
    if (result.code !== 0 && step.failure !== undefined) return step.failure;
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
  style: Readonly<{ width: number; height?: number; color: boolean }>,
): Readonly<{ lines: readonly string[]; hits: readonly PanelHit[] }> {
  const hits: PanelHit[] = [];
  let x = 1;
  const chips: Line = view.chips.flatMap((chip) => {
    const label = ` ${chip.number} ${chip.name}${chip.needsYou > 0 ? ` ${chip.needsYou}` : ""}${chip.offline ? " offline" : ""} `;
    const width = lineWidth([span(label)]);
    if (x <= style.width) {
      const to = Math.min(x + width - 1, style.width);
      hits.push({ kind: "chip", repoPath: chip.repoPath, y: 1, from: x, to });
    }
    x += width + 1;
    const tones: Tone[] = chip.current ? ["inverse", "bold"] : chip.offline ? ["dim"] : [];
    return [span(label, ...tones), span(" ")];
  });
  const top: Line[] = [
    chips,
    state.query === undefined
      ? [span(view.summary, "dim")]
      : [span("/ ", "cyan"), span(`${state.query}▏`)],
  ];
  if (state.help) {
    const inner = Math.max(...HELP.map((line) => lineWidth([span(line)])));
    top.push([span(`╭${"─".repeat(inner + 2)}╮`, "dim")]);
    for (const help of HELP) {
      top.push([span("│ ", "dim"), span(help.padEnd(inner)), span(" │", "dim")]);
    }
    top.push([span(`╰${"─".repeat(inner + 2)}╯`, "dim")]);
  }
  const body: Line[] = [[]];
  if (view.quiet && state.query === undefined && view.chips.length > 0) {
    body.push([span("✓ All quiet.", "green")], []);
  }
  const rows = view.sections.flatMap((section) => section.rows);
  const selected = rows.find((row) => row.key === state.selected)?.key ?? rows[0]?.key;
  const spans: { key: string; first: number; last: number }[] = [];
  for (const section of view.sections) {
    body.push([span(section.title.toUpperCase(), "bold")]);
    for (const row of section.rows) {
      const first = body.length;
      body.push(rowLine(row, row.key === selected, style.width));
      body.push(...rowDetails(row, style.width));
      if (row.steps !== undefined && state.expanded.has(row.key)) {
        for (const step of row.steps) {
          body.push([span(`      ${STEP_MARKS[step.status]} ${step.text}`, "dim")]);
        }
      }
      spans.push({ key: row.key, first, last: body.length - 1 });
    }
    body.push([]);
  }
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

function scrollStart(
  length: number,
  room: number,
  selected: Readonly<{ first: number; last: number }> | undefined,
): number {
  if (length <= room || selected === undefined) return 0;
  const centered = Math.min(Math.max(0, selected.first - Math.floor(room / 3)), length - room);
  return selected.last >= centered + room ? selected.last - room + 1 : centered;
}

function rowLine(row: PanelRow, selected: boolean, width: number): Line {
  const stage = span(` ${row.stage}`, row.color);
  const lead = [span(row.changed ? "•" : " ", "blue"), span(`${row.glyph} `, row.color)];
  const room = Math.max(1, width - lineWidth(lead) - lineWidth([stage]));
  const name = fit(
    [span(row.name, ...(selected ? (["inverse"] as const) : (["bold"] as const)))],
    room,
  );
  const gap = span(" ".repeat(Math.max(0, room - lineWidth(name))));
  return [...lead, ...name, gap, stage];
}

/** The row's second lines and its tool line, at most two together. */
function rowDetails(row: PanelRow, width: number): Line[] {
  const details: Line[] = row.lines.map((text) => [span(`    ${text}`, "dim")]);
  if (row.activity !== undefined) details.push(activityLine(row.activity, width));
  return details.slice(0, 2);
}

function activityLine(activity: PanelActivity, width: number): Line {
  const lead = `    ▸ ${activity.verb}`;
  const tail = activity.age === undefined ? "" : ` · ${activity.age}`;
  const room = width - lineWidth([span(`${lead} ${tail}`)]);
  const target =
    activity.target === undefined || room < 2 ? "" : ` ${fitStart(activity.target, room)}`;
  return [span(`${lead}${target}${tail}`, "dim")];
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
  readonly sessionId: string;
  /** Where Herdr's focus was when the panel opened; its project is the one shown first. */
  readonly focus: HerdrFocus;
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

const SCREEN_ON = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1004h";
const SCREEN_OFF = "\x1b[?1004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";
const HOME_CLEAR = "\x1b[H\x1b[2J";

/**
 * Draws the panel from the snapshot file until it is closed, a signal ends it, or drawing
 * fails; the terminal is put back in every case. Without a terminal to read keys from, it draws
 * once and returns.
 */
export async function runPanel(deps: PanelDeps): Promise<void> {
  let snapshot: BoardSnapshot | undefined;
  let readFailed = false;
  let state: PanelState = {
    project: undefined,
    query: undefined,
    selected: undefined,
    seen: undefined,
    help: deps.helpUnseen,
    expanded: new Set(),
  };
  const refresh = async () => {
    try {
      snapshot = (await deps.readSnapshot()) ?? snapshot;
      readFailed = false;
    } catch {
      readFailed = true;
    }
    if (state.project === undefined && snapshot !== undefined) {
      state = { ...state, project: focusedProject(snapshot, deps.focus) };
    }
  };
  const view = () =>
    panelView(snapshot, {
      project: state.project,
      query: state.query ?? "",
      now: deps.clock().toISOString(),
      readFailed,
      ...(state.seen === undefined ? {} : { seen: state.seen }),
    });
  const layout = () => {
    const { columns, rows } = deps.size();
    return renderPanel(view(), state, {
      width: columns ?? PANEL_WIDTH,
      ...(rows === undefined ? {} : { height: rows }),
      color: deps.color,
    });
  };
  await refresh();
  const tty = deps.input as NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  if (tty.isTTY !== true || tty.setRawMode === undefined) {
    deps.write(`${layout().lines.join("\n")}\n`);
    return;
  }
  const setRawMode = tty.setRawMode.bind(tty);
  let closing = false;
  let shown = "";
  let hits: readonly PanelHit[] = [];
  const redraw = () => {
    if (closing) return;
    const rendered = layout();
    hits = rendered.hits;
    const text = rendered.lines.join("\n");
    if (text !== shown) deps.write(`${HOME_CLEAR}${text}`);
    shown = text;
  };
  const { promise: closed, resolve: close, reject: fail } = Promise.withResolvers<void>();
  const guarded = (work: () => void) => {
    try {
      work();
    } catch (error) {
      fail(error);
    }
  };
  const navigate = async (effect: Exclude<PanelEffect, { kind: "close" }>) => {
    const steps = navigationSteps(effect, deps.sessionId, snapshot?.coordinators ?? []);
    let notice = steps.length === 0 ? NO_COORDINATOR : undefined;
    for (const step of steps) {
      const result = await deps.run({ argv: step.argv, cwd: deps.cwd }).catch(() => undefined);
      if (result?.code !== 0 && step.failure !== undefined) {
        notice = step.failure;
        break;
      }
    }
    if (notice !== undefined) state = { ...state, notice };
    else if (deps.popup) close();
    guarded(redraw);
  };
  const handle = (inputs: readonly PanelInput[]) => {
    for (const input of inputs) {
      const wasHelp = state.help;
      const step = panelStep(state, input, {
        view: view(),
        hits,
        popup: deps.popup,
        now: deps.clock().getTime(),
      });
      state = step.state;
      if (wasHelp && !state.help) void deps.rememberHelpSeen().catch(() => undefined);
      if (step.effect?.kind === "close") close();
      else if (step.effect !== undefined) void navigate(step.effect);
    }
    redraw();
  };
  let pending = "";
  let flush: ReturnType<typeof setTimeout> | undefined;
  const onData = (chunk: Buffer | string) =>
    guarded(() => {
      clearTimeout(flush);
      const parsed = parsePanelInput(pending + chunk.toString(), false);
      pending = parsed.pending;
      handle(parsed.inputs);
      if (pending.length === 0) return;
      flush = setTimeout(
        () =>
          guarded(() => {
            const rest = parsePanelInput(pending, true);
            pending = "";
            handle(rest.inputs);
          }),
        ESCAPE_WAIT_MS,
      );
    });
  const timer = setInterval(() => {
    void refresh().then(() => guarded(redraw));
  }, REFRESH_MS);
  let fittedAreaWidth: number | undefined;
  let fitting = Promise.resolve();
  // One fit at a time, so a burst of resizes reads the width the previous fit left.
  const keepWidth = () => {
    const paneId = deps.paneId;
    if (paneId === undefined) return;
    fitting = fitting
      .then(async () => {
        fittedAreaWidth = await fitPanelPane(deps, paneId, fittedAreaWidth);
      })
      .catch(() => undefined);
  };
  const stopListening = deps.onExitSignal(() => close());
  const stopResizing = deps.onResize(() => {
    keepWidth();
    guarded(redraw);
  });
  keepWidth();
  try {
    setRawMode(true);
    deps.write(SCREEN_ON);
    deps.input.on("data", onData);
    deps.input.resume();
    redraw();
    await closed;
  } finally {
    closing = true;
    clearInterval(timer);
    clearTimeout(flush);
    stopListening();
    stopResizing();
    deps.input.off("data", onData);
    setRawMode(false);
    deps.input.pause();
    deps.write(SCREEN_OFF);
  }
}
