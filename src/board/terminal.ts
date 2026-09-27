import { basename, sep } from "node:path";
import { styleText } from "node:util";
import {
  elapsed,
  PR_MARKS,
  type PrWatchCheckCounts,
  type PrWatchViewRow,
} from "../pr-watch/view.ts";
import { dollars } from "../tasks/trace.ts";
import {
  RUNNING_STAGE_ORDER,
  type BoardRow,
  type BoardView,
  type WeekSummary,
} from "./view.ts";

/** What only `tandem status` adds below the board. */
export type StatusFooter = Readonly<{
  /** The commit the `tandem` command runs from, as `tandemCodeVersion` reads it. */
  readonly code: string;
  /** Projects with an open coordinator. */
  readonly coordinators: readonly string[];
}>;

/** How the terminal shows the status: colors only on a terminal, lines cut to its width. */
export type StatusStyle = Readonly<{
  readonly color: boolean;
  /** The terminal's width; absent when unknown, and then lines are never cut. */
  readonly columns?: number;
  /** The terminal opens OSC 8 links, so linked spans are clickable; plain text otherwise. */
  readonly links?: boolean;
}>;

export type Tone =
  | "bold"
  | "dim"
  | "underline"
  | "inverse"
  | "red"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "magenta";

/** A run of text drawn in one style. */
export type Span = Readonly<{
  readonly text: string;
  readonly tones: readonly Tone[];
  /** Where clicking the text goes, when the terminal opens links. */
  readonly link?: string;
}>;
export type Line = readonly Span[];
type Section = Readonly<{
  readonly title: string;
  readonly count: number;
  readonly tone: Tone;
  readonly lines: readonly Line[];
}>;

export const RULE_MIN = 40;
const CHECK_BAR = 8;
const STAGE_TONES: Readonly<Record<string, readonly Tone[]>> = {
  paused: ["dim"],
  queued: ["dim"],
  scouting: ["blue"],
  implementing: ["cyan"],
  "awaiting-fixes": ["cyan"],
  validating: ["magenta"],
  reviewing: ["magenta"],
};
const PR_TONES: Readonly<Record<PrWatchViewRow["color"], readonly Tone[]>> = {
  red: ["red"],
  yellow: ["yellow"],
  green: ["green"],
  done: ["dim"],
  unwatched: ["dim"],
};

export function span(text: string, ...tones: Tone[]): Span {
  return { text, tones };
}

/** The same text, clickable where the terminal opens links. */
export function linked(part: Span, link: string): Span {
  return { ...part, link };
}

/**
 * `tandem status`: the board in titled sections with column headers, then what was finished,
 * which coordinators are open, and how to go on. Colors mark what needs the user (yellow), what
 * failed (red), work in progress (cyan), and what is done (green).
 */
export function renderStatus(view: BoardView, footer: StatusFooter, style: StatusStyle): string {
  const sections: Section[] = [
    {
      title: "NEEDS YOU",
      count: view.needsYou.length,
      tone: "yellow",
      lines: needsYouLines(view.needsYou),
    },
    ...(view.running.length === 0
      ? []
      : [
          {
            title: "RUNNING",
            count: view.running.length,
            tone: "cyan",
            lines: runningLines(view.running, style.columns),
          } as const,
        ]),
    ...(view.pullRequests.length === 0
      ? []
      : [
          {
            title: "PRS",
            count: view.pullRequests.length,
            tone: "blue",
            lines: prLines(view.pullRequests),
          } as const,
        ]),
  ];
  const widest = Math.max(RULE_MIN, ...sections.flatMap((section) => section.lines.map(lineWidth)));
  const ruleWidth = style.columns === undefined ? widest : Math.min(widest, style.columns);
  const lines: Line[] = [header(view, style.color), []];
  for (const { title, count, tone, lines: rows } of sections) {
    lines.push(sectionHeading(title, count, tone, ruleWidth));
    // Only Needs you is shown empty; the other sections are left out.
    lines.push(...(rows.length === 0 ? [[span("Nothing needs you.", "dim")]] : rows), []);
  }
  if (view.week !== undefined)
    lines.push([span("THIS WEEK  ", "bold"), ...weekSpans(view.week)], []);
  lines.push([span("─".repeat(ruleWidth), "dim")], ...footerLines(view, footer));
  return `${lines.map((line) => draw(line, style)).join("\n")}\n`;
}

/** A bold, colored section title with its count, ruled out to `width`. */
export function sectionHeading(title: string, count: number, tone: Tone, width: number): Line {
  const heading = [span(title, "bold", tone), span(count === 0 ? " " : ` ${count} `, "dim")];
  return [...heading, span("─".repeat(Math.max(0, width - lineWidth(heading))), "dim")];
}

/**
 * `tandem status --line`: the board in one short line for Herdr's tab bar, like
 * "🙋 3 need you · 🔨 2 running · 🔴 1 🟡 1 🟢 1". Herdr strips colors there, so emoji carry the
 * meaning; paused tasks are left out, and pull request dots count only what PR watch still watches.
 */
export function renderStatusLine(view: BoardView): string {
  const needs = view.needsYou.length;
  const running = view.running.filter((row) => row.cause !== "paused").length;
  const colors = [
    ...view.needsYou.filter((row) => row.cause === "pull-request").map(() => "red" as const),
    ...view.pullRequests.map((row) => row.color),
  ];
  const dots = (["red", "yellow", "green"] as const)
    .map((color) => [PR_MARKS[color], colors.filter((each) => each === color).length] as const)
    .filter(([, count]) => count > 0)
    .map(([mark, count]) => `${mark} ${count}`);
  if (needs === 0 && running === 0 && dots.length === 0) return "✓ all quiet";
  return [
    needs === 0 ? "✓ nothing needs you" : `🙋 ${needs} ${needs === 1 ? "needs" : "need"} you`,
    ...(running === 0 ? [] : [`🔨 ${running} running`]),
    ...(dots.length === 0 ? [] : [dots.join(" ")]),
  ].join(" · ");
}

function header(view: BoardView, color: boolean): Line {
  const projects = view.projects.length === 0 ? "none yet" : view.projects.join(", ");
  const checked =
    view.checkedAt === undefined
      ? " · PRs not checked yet"
      : ` · PRs checked ${elapsed(view.checkedAt, view.now)} ago`;
  // The badge reads as a title only in color; plain text keeps the label.
  const title = color ? [span(" tandem ", "inverse", "bold"), span("  ")] : [span("Projects: ")];
  return [...title, span(projects), span(checked, "dim")];
}

function needsYouLines(rows: readonly BoardRow[]): Line[] {
  const projectWidth = columnWidth(rows.map((row) => row.project));
  const nameWidth = columnWidth(rows.map((row) => row.name));
  return rows.map((row) => [
    span(`${row.mark} `),
    ...cell(row.project, projectWidth, "dim"),
    span("  "),
    ...cell(
      row.name,
      nameWidth,
      ...(row.cause === "pull-request" ? (["red"] as const) : (["bold"] as const)),
    ),
    span("  "),
    ...needsYouText(row),
  ]);
}

/** The reason a row needs the user, colored by how urgent it is. */
function needsYouText(row: BoardRow): Line {
  if (row.cause === "pull-request") {
    const [note = "", link] = row.text.split(" → ");
    return [
      span(note, "red"),
      ...(link === undefined ? [] : [span(` → ${link}`, "dim", "underline")]),
    ];
  }
  for (const [prefix, tones] of [
    ["question: ", ["yellow"]],
    ["blocked: ", ["red", "bold"]],
  ] as const) {
    if (row.text.startsWith(prefix))
      return [span(prefix, ...tones), span(row.text.slice(prefix.length))];
  }
  return [span(row.text, "yellow")];
}

function runningLines(rows: readonly BoardRow[], columns?: number): Line[] {
  const ordered = [...rows].sort(compareRunningRows);
  const identitiesByProject = new Map<string, Set<string>>();
  for (const row of ordered) {
    const identity = row.repoPath ?? row.project;
    const identities = identitiesByProject.get(row.project) ?? new Set<string>();
    identities.add(identity);
    identitiesByProject.set(row.project, identities);
  }
  const lines: Line[] = [];
  let previousIdentity: string | undefined;
  for (const row of ordered) {
    const identity = row.repoPath ?? row.project;
    if (identity !== previousIdentity) {
      if (previousIdentity !== undefined) lines.push([]);
      const heading = projectHeading(row, identitiesByProject.get(row.project));
      lines.push([span(`  ${heading}`, "dim")]);
      previousIdentity = identity;
    }
    lines.push(...runningTaskLines(row, columns));
  }
  return lines;
}

function projectHeading(
  row: BoardRow,
  identities: ReadonlySet<string> | undefined,
): string {
  if (identities === undefined || identities.size < 2 || row.repoPath === undefined) {
    return row.project;
  }
  const paths = [...identities].map((path) => path.split(sep).filter(Boolean));
  const projectPath = row.repoPath.split(sep).filter(Boolean);
  const maximumDepth = Math.max(...paths.map((path) => path.length));
  let depth = 1;
  while (depth < maximumDepth) {
    const suffixes = new Set(paths.map((path) => path.slice(-depth).join(sep)));
    if (suffixes.size === paths.length) break;
    depth += 1;
  }
  const suffix = projectPath.slice(-depth).join(sep);
  return `${row.project} · ${depth < projectPath.length ? `…${sep}${suffix}` : suffix}`;
}

function compareRunningRows(left: BoardRow, right: BoardRow): number {
  return (
    compareText(left.project, right.project) ||
    compareText(left.repoPath ?? left.project, right.repoPath ?? right.project) ||
    runningStageOrder(left.cause) - runningStageOrder(right.cause) ||
    compareText(left.name, right.name) ||
    compareText(left.key, right.key)
  );
}

function runningStageOrder(cause: BoardRow["cause"]): number {
  const order = RUNNING_STAGE_ORDER.findIndex((stage) => stage === cause);
  return order < 0 ? RUNNING_STAGE_ORDER.length : order;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runningTaskLines(row: BoardRow, columns?: number): Line[] {
  const tones = STAGE_TONES[row.cause] ?? ["cyan"];
  const quiet = tones.includes("dim");
  const nameTones = quiet ? (["dim"] as const) : ([] as const);
  const prefix: Line = [
    span("  "),
    span(`${row.mark} `),
    span(row.text, ...tones),
    span(` · ${row.since ?? ""}`, "dim"),
    span("  "),
  ];
  const prefixWidth = lineWidth(prefix);
  const descriptionWidth =
    columns === undefined ? Number.POSITIVE_INFINITY : Math.max(1, columns - prefixWidth);
  const description = wrapDescription(row.name, descriptionWidth);
  return [
    [...prefix, span(description[0] ?? "", ...nameTones)],
    ...description.slice(1).map((text): Line => [
      span(" ".repeat(prefixWidth)),
      span(text, ...nameTones),
    ]),
  ];
}

function wrapDescription(text: string, width: number): string[] {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return [""];

  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  const spaceWidth = textWidth(" ");
  for (const word of normalized.split(" ")) {
    const wordWidth = textWidth(word);
    const nextWidth = line.length === 0 ? wordWidth : lineWidth + spaceWidth + wordWidth;
    if (nextWidth <= width) {
      line = line.length === 0 ? word : `${line} ${word}`;
      lineWidth = nextWidth;
      continue;
    }
    if (line.length > 0) lines.push(line);
    let piece = "";
    let pieceWidth = 0;
    for (const { segment } of graphemes.segment(word)) {
      const segmentWidth = textWidth(segment);
      if (piece.length > 0 && pieceWidth + segmentWidth > width) {
        lines.push(piece);
        piece = "";
        pieceWidth = 0;
      }
      piece += segment;
      pieceWidth += segmentWidth;
    }
    line = piece;
    lineWidth = pieceWidth;
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  if (lines.length <= 2) return lines;
  return [lines[0] ?? "", appendEllipsis(lines[1] ?? "", width)];
}

function appendEllipsis(text: string, width: number): string {
  const room = Math.max(0, width - textWidth("…"));
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = textWidth(segment);
    if (used + segmentWidth > room) break;
    result += segment;
    used += segmentWidth;
  }
  return `${result.trimEnd()}…`;
}

function prLines(rows: readonly PrWatchViewRow[]): Line[] {
  const names = rows.map((row) => `${row.repo}#${row.number}`);
  const checks = rows.map(checksSpans);
  const nameWidth = columnWidth([
    "PULL REQUEST",
    ...rows.map((row, index) => `${names[index]} ${row.branch}`.trimEnd()),
  ]);
  const checksWidth = Math.max(textWidth("CHECKS"), ...checks.map(lineWidth));
  const statusWidth = columnWidth(["STATUS", ...rows.map((row) => row.status)]);
  const heading: Line = [
    span("   "),
    ...cell("PULL REQUEST", nameWidth, "dim"),
    span("  "),
    ...cell("CHECKS", checksWidth, "dim"),
    span("  "),
    ...cell("STATUS", statusWidth, "dim"),
    span("  "),
    span("NEXT", "dim"),
  ];
  return [
    heading,
    ...rows.map((row, index): Line => {
      const name = names[index] ?? "";
      const branch = row.branch.length === 0 ? "" : ` ${row.branch}`;
      const note = row.link === undefined ? row.note : `${row.note} → ${row.link}`;
      return [
        span(`${PR_MARKS[row.color]} `),
        span(name, "blue"),
        ...cell(branch, nameWidth - textWidth(name)),
        span("  "),
        ...pad(checks[index] ?? [], checksWidth),
        span("  "),
        ...cell(row.status, statusWidth, ...PR_TONES[row.color]),
        span("  "),
        span(note, "dim"),
      ];
    }),
  ];
}

/** Like `██████░░ 12/16`: a bar of passed checks, yellow while some run and red when one failed. */
function checksSpans(row: PrWatchViewRow): Line {
  const counts = row.checkCounts;
  if (counts === undefined) return [span(row.checks)];
  const total = counts.passed + counts.failed + counts.pending;
  const filled = Math.round((counts.passed / total) * CHECK_BAR);
  const tone = checkTone(counts);
  return [
    span("█".repeat(filled), tone),
    span("░".repeat(CHECK_BAR - filled), "dim"),
    span(` ${String(counts.passed).padStart(String(total).length)}/${total}`, tone),
  ];
}

function checkTone(counts: PrWatchCheckCounts): Tone {
  return counts.failed > 0 ? "red" : counts.pending > 0 ? "yellow" : "green";
}

function weekSpans(week: WeekSummary): Line {
  const unpriced = week.unpricedSamples === 0 ? "" : " + unpriced usage";
  return [
    span(`${week.tasks} done`, "bold"),
    ...(week.reviewedTasks === 0
      ? []
      : [
          span(" · ", "dim"),
          span(`${week.firstPassReviews} of ${week.reviewedTasks} passed review first time`),
        ]),
    span(" · ", "dim"),
    span(dollars(week.costMicros), "green", "bold"),
    span(unpriced, "dim"),
  ];
}

function footerLines(view: BoardView, footer: StatusFooter): Line[] {
  const coordinators =
    footer.coordinators.length === 0
      ? "no coordinators open, run `tandem`"
      : `coordinators open: ${footer.coordinators.map((path) => basename(path)).join(", ")}`;
  const plural = view.finished === 1 ? "" : "s";
  return [
    [
      span(
        [
          ...(view.finished === 0 ? [] : [`${view.finished} finished task${plural} hidden`]),
          coordinators,
        ].join(" · "),
        "dim",
      ),
    ],
    [span(`Tandem code: ${footer.code}`, "dim")],
    [
      span("Ask the coordinator about any task · ", "dim"),
      span("tandem status --json", "cyan"),
      span(" for task IDs · ", "dim"),
      span("tandem status --watch", "cyan"),
      span(" for the live view", "dim"),
    ],
  ];
}

export function cell(text: string, width: number, ...tones: Tone[]): Line {
  return pad([span(text, ...tones)], width);
}

function pad(line: Line, width: number): Line {
  const missing = width - lineWidth(line);
  return missing > 0 ? [...line, span(" ".repeat(missing))] : line;
}

export function columnWidth(values: readonly string[]): number {
  return Math.max(0, ...values.map(textWidth));
}

/** Terminal cells, so emoji count as two. */
function textWidth(text: string): number {
  return Bun.stringWidth(text);
}

export function lineWidth(line: Line): number {
  return line.reduce((total, part) => total + textWidth(part.text), 0);
}

/** One line as terminal text: cut to the terminal's width, then colored when color is on. */
export function draw(line: Line, style: StatusStyle): string {
  const fitted = style.columns === undefined ? line : fit(line, style.columns);
  return fitted
    .map((part) => {
      const text =
        style.color && part.tones.length > 0 && part.text.trim().length > 0
          ? styleText([...part.tones], part.text, { validateStream: false })
          : part.text;
      return style.links === true && part.link !== undefined ? osc8(part.link, text) : text;
    })
    .join("")
    .trimEnd();
}

/** An OSC 8 hyperlink; a link holding control characters is left as plain text. */
function osc8(link: string, text: string): string {
  const control = [...link].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (control) return text;
  return `\u001b]8;;${link}\u001b\\${text}\u001b]8;;\u001b\\`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cuts a line that would wrap, ending it with "…", so each row stays one terminal line. */
function fit(line: Line, columns: number): Line {
  if (lineWidth(line) <= columns) return line;
  const fitted: Span[] = [];
  let room = columns - 1;
  for (const part of line) {
    let text = "";
    for (const { segment } of graphemes.segment(part.text)) {
      const width = textWidth(segment);
      if (width > room) {
        fitted.push({ ...part, text }, span("…", ...part.tones));
        return fitted;
      }
      text += segment;
      room -= width;
    }
    fitted.push({ ...part, text });
  }
  return fitted;
}
