import type { PanelRow } from "../board/panel.ts";
import type { PanelEffect, PanelFrame, PanelInput, PanelState } from "./panel.ts";

const DOUBLE_CLICK_MS = 400;

export function readPanelToken(rest: string, final: boolean) {
  const escaped = rest.startsWith("\x1b") ? rest.slice(1) : undefined;
  if (escaped !== undefined && /^(?:\[[<0-9;?]*|O)?$/u.test(escaped)) {
    const input: PanelInput | undefined =
      final && escaped.length === 0 ? { kind: "escape" } : undefined;
    return { pending: !final, length: rest.length, input };
  }
  const mouse = escaped === undefined ? null : /^\[<(\d+);(\d+);(\d+)([Mm])/u.exec(escaped);
  if (mouse !== null) {
    const input: PanelInput | undefined =
      mouse[4] === "M" && mouse[1] === "0"
        ? { kind: "click", x: Number(mouse[2]), y: Number(mouse[3]) }
        : undefined;
    return { pending: false, length: 1 + mouse[0].length, input };
  }
  const csi = escaped === undefined ? null : /^(?:\[[0-9;?]*|O)[@-~]/u.exec(escaped);
  if (csi !== null)
    return { pending: false, length: 1 + csi[0].length, input: escapeInput(csi[0]) };
  const char = String.fromCodePoint(rest.codePointAt(0) ?? 0);
  return { pending: false, length: char.length, input: characterInput(char) };
}

function escapeInput(sequence: string): PanelInput | undefined {
  const ending = sequence.at(-1);
  if (ending === "A") return { kind: "up" };
  if (ending === "B") return { kind: "down" };
  if (sequence === "[I" || sequence === "[O") {
    return { kind: "focus", focused: ending === "I" };
  }
  return undefined;
}

function characterInput(char: string): PanelInput | undefined {
  if (char === "\x1b") return { kind: "escape" };
  if (char === "\r" || char === "\n") return { kind: "enter" };
  if (char === "\x7f" || char === "\b") return { kind: "backspace" };
  if (char === "\x03") return { kind: "interrupt" };
  return char >= " " ? { kind: "char", char } : undefined;
}

type Step = Readonly<{ state: PanelState; effect?: PanelEffect }>;

export function clickStep(
  state: PanelState,
  input: Extract<PanelInput, { kind: "click" }>,
  frame: PanelFrame,
): Step {
  const hit = frame.hits.find(
    (each) => each.y === input.y && input.x >= each.from && input.x <= each.to,
  );
  if (hit?.kind === "chip") return switchTo(state, hit.repoPath);
  if (hit?.kind !== "row") return { state };
  const double =
    state.lastClick?.key === hit.key && frame.now - state.lastClick.at <= DOUBLE_CLICK_MS;
  const clicked = { ...state, selected: hit.key, lastClick: { key: hit.key, at: frame.now } };
  const rows = frame.view.sections.flatMap((section) => section.rows);
  if (!double) return { state: clicked };
  const row = rows.find((candidate) => candidate.key === hit.key);
  return go(clicked, row);
}

export function keyboardStep(state: PanelState, input: PanelInput, frame: PanelFrame): Step {
  const key = input.kind === "char" ? input.char : input.kind;
  if (state.query !== undefined) {
    const search = searchStep(state, input, key, state.query);
    if (search !== undefined) return search;
  }
  const rows = frame.view.sections.flatMap((section) => section.rows);
  const found = rows.findIndex((row) => row.key === state.selected);
  const index = Math.max(0, found);
  const by = MOVE_KEYS.get(key);
  if (by !== undefined) {
    return {
      state: { ...state, selected: rows[Math.min(rows.length - 1, Math.max(0, index + by))]?.key },
    };
  }
  if (key === "enter") return go(state, rows[index]);
  if (state.query !== undefined) return { state };
  return shortcutStep(state, key, frame, rows[index]);
}

const MOVE_KEYS = new Map<string, number>(Object.entries({ down: 1, j: 1, up: -1, k: -1 }));

function searchStep(
  state: PanelState,
  input: PanelInput,
  key: string,
  query: string,
): Step | undefined {
  if (input.kind === "char") return { state: { ...state, query: query + input.char } };
  if (key === "backspace") return { state: { ...state, query: [...query].slice(0, -1).join("") } };
  if (key === "escape") return { state: { ...state, query: undefined } };
  return undefined;
}

function shortcutStep(
  state: PanelState,
  key: string,
  frame: PanelFrame,
  row: PanelRow | undefined,
): Step {
  if (key === " ") return { state: toggleSteps(state, row) };
  if (key === "/") return { state: { ...state, query: "" } };
  if (key === "escape") return frame.popup ? { state, effect: { kind: "close" } } : { state };
  const chips = frame.view.chips;
  if (/^[1-9]$/u.test(key)) return switchTo(state, chips[Number(key) - 1]?.repoPath);
  if ((key === "[" || key === "]") && chips.length > 0) {
    const current = chips.findIndex((chip) => chip.current);
    const next = (current + (key === "]" ? 1 : -1) + chips.length) % chips.length;
    return switchTo(state, chips[next]?.repoPath);
  }
  return { state };
}

function go(state: PanelState, row: PanelRow | undefined): Step {
  if (row === undefined || row.target.kind === "none") return { state };
  return { state: { ...state, query: undefined }, effect: { kind: "go", target: row.target } };
}

function switchTo(state: PanelState, repoPath: string | undefined): Step {
  if (repoPath === undefined) return { state };
  return {
    state: { ...state, project: repoPath, query: undefined, selected: undefined },
    effect: { kind: "switch", repoPath },
  };
}

function toggleSteps(state: PanelState, row: PanelRow | undefined): PanelState {
  if (row?.steps === undefined) return state;
  const expanded = new Set(state.expanded);
  if (!expanded.delete(row.key)) expanded.add(row.key);
  return { ...state, expanded };
}
