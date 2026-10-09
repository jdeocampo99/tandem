import type { PanelActivity, PanelRow, PanelStep, PanelView } from "../board/panel.ts";
import { fit, fitStart, type Line, lineWidth, span, type Tone } from "../board/terminal.ts";
import type { PanelHit, PanelState } from "./panel.ts";

const HELP = ["j k ↑ ↓ move · Enter go · / search", "Space steps · 1-9 [ ] project"];
const STEP_MARKS: Readonly<Record<PanelStep["status"], string>> = {
  done: "☑",
  doing: "▸",
  todo: "☐",
  dropped: "☒",
};

export type PanelStyle = Readonly<{
  width: number;
  height?: number;
  color: boolean;
  popup: boolean;
}>;

export function topLines(
  view: PanelView,
  state: PanelState,
  style: PanelStyle,
  hits: PanelHit[],
): Line[] {
  let x = 1;
  const chips: Line = view.chips.flatMap((chip) => {
    const label = ` ${chip.number} ${chip.name}${chip.needsYou > 0 ? ` ${chip.needsYou}` : ""}${chip.offline ? " offline" : ""} `;
    const width = lineWidth([span(label)]);
    if (x <= style.width) {
      const to = Math.min(x + width - 1, style.width);
      hits.push({ kind: "chip", repoPath: chip.repoPath, y: 1, from: x, to });
    }
    x += width + 1;
    const tones: Tone[] = [];
    if (chip.current) tones.push("inverse", "bold");
    else if (chip.offline) tones.push("dim");
    return [span(label, ...tones), span(" ")];
  });
  const top: Line[] = [
    chips,
    state.query === undefined
      ? [span(view.summary, "dim")]
      : [span("/ ", "cyan"), span(`${state.query}▏`)],
  ];
  if (state.help) {
    const help = [...HELP, style.popup ? "Esc close · x hide" : "x hide"];
    const inner = Math.max(...help.map((line) => lineWidth([span(line)])));
    top.push(
      [span(`╭${"─".repeat(inner + 2)}╮`, "dim")],
      ...help.map((line) => [span("│ ", "dim"), span(line.padEnd(inner)), span(" │", "dim")]),
      [span(`╰${"─".repeat(inner + 2)}╯`, "dim")],
    );
  }
  return top;
}

export function bodyLines(
  view: PanelView,
  state: PanelState,
  width: number,
  selected: string | undefined,
) {
  const body: Line[] = [[]];
  if (view.quiet && state.query === undefined && view.chips.length > 0) {
    body.push([span("✓ All quiet.", "green")], []);
  }
  if ((state.query ?? "").trim() !== "" && view.sections.length === 0) {
    body.push([span("no matches", "dim")], []);
  }
  const spans: { key: string; first: number; last: number }[] = [];
  for (const section of view.sections) {
    body.push([span(section.title, "bold")]);
    for (const row of section.rows) {
      const first = body.length;
      body.push(rowLine(row, row.key === selected, width));
      body.push(...rowDetails(row, width));
      if (row.steps !== undefined && state.expanded.has(row.key)) {
        body.push(
          ...row.steps.map((step) => [
            span(`      ${STEP_MARKS[step.status]} ${step.text}`, "dim"),
          ]),
        );
      }
      spans.push({ key: row.key, first, last: body.length - 1 });
    }
    body.push([]);
  }
  return { body, spans };
}

export function scrollStart(
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
  const name = fit([span(row.name, selected ? "inverse" : "bold")], room);
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
