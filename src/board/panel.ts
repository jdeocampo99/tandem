import { elapsed } from "../pr-watch/view.ts";
import type { BoardSnapshot } from "./snapshot.ts";
import type {
  BoardPullRequest,
  BoardRow,
  BoardView,
  RunningBoardRow,
  RunningStage,
} from "./view.ts";

export type PanelColor = "yellow" | "red" | "blue" | "magenta" | "green";

/** Where `Enter` on a row goes. */
export type PanelTarget =
  | Readonly<{ kind: "chat"; repoPath: string }>
  | Readonly<{ kind: "pane"; workspaceId: string; paneId: string }>
  | Readonly<{ kind: "url"; url: string }>
  | Readonly<{ kind: "none" }>;

export type PanelRow = Readonly<{
  /** Stays the same while the row stands for the same task, pull request, or brief. */
  readonly key: string;
  /** Changes when the row's stage or words change; elapsed times do not count. */
  readonly signature: string;
  readonly name: string;
  readonly stage: string;
  readonly color: PanelColor;
  readonly glyph: string;
  /** At most two short lines in plain words. */
  readonly lines: readonly string[];
  readonly target: PanelTarget;
  readonly changed: boolean;
}>;

export type PanelSection = Readonly<{ readonly title: string; readonly rows: readonly PanelRow[] }>;

export type PanelChip = Readonly<{
  readonly number: number;
  readonly name: string;
  readonly repoPath: string;
  readonly needsYou: number;
  readonly current: boolean;
  readonly offline: boolean;
}>;

export type PanelView = Readonly<{
  readonly chips: readonly PanelChip[];
  /** Like `2 need you · 4 running`. */
  readonly summary: string;
  /** Nothing needs the user and nothing runs in this project. */
  readonly quiet: boolean;
  /** The current project's sections, or each matching project's rows while searching. */
  readonly sections: readonly PanelSection[];
  /** Every project's row signatures, for remembering what the user has seen. */
  readonly signatures: readonly string[];
  readonly footer?: string;
}>;

export type PanelOptions = Readonly<{
  /** The current project's checkout path. */
  readonly project: string | undefined;
  /** Search words; empty shows the current project. */
  readonly query: string;
  readonly now: string;
  /** The last read of the snapshot file failed. */
  readonly readFailed: boolean;
  /** Row signatures the user has seen; undefined marks nothing changed. */
  readonly seen?: ReadonlySet<string>;
}>;

export const PANEL_GLYPHS: Readonly<Record<PanelColor, string>> = {
  yellow: "◆",
  red: "✖",
  blue: "●",
  magenta: "◎",
  green: "✓",
};

const STALE_MS = 10_000;
const SECTION_ORDER = ["Needs you", "Running", "Pull requests", "Done today"] as const;
type SectionTitle = (typeof SECTION_ORDER)[number];

const NEEDS_YOU: Readonly<
  Record<string, Readonly<{ stage: string; color: PanelColor; prefix?: string; words?: string }>>
> = {
  brief: { stage: "brief to approve", color: "yellow" },
  question: { stage: "question", color: "yellow", prefix: "question: " },
  "model-question": { stage: "model question", color: "yellow", prefix: "model question: " },
  "awaiting-approval": { stage: "to approve", color: "yellow" },
  ready: { stage: "ready", color: "yellow" },
  blocked: { stage: "stopped", color: "red", prefix: "blocked: ", words: "stuck" },
  "pull-request": { stage: "PR failing", color: "red", words: "pr" },
};

const RUNNING_COLORS: Readonly<Record<RunningStage, PanelColor>> = {
  paused: "yellow",
  queued: "yellow",
  scouting: "blue",
  implementing: "blue",
  "awaiting-fixes": "blue",
  validating: "magenta",
  reviewing: "magenta",
};

const PR_COLORS: Readonly<Record<BoardPullRequest["color"], PanelColor>> = {
  red: "red",
  yellow: "yellow",
  green: "green",
  done: "green",
  unwatched: "blue",
};

type Entry = Readonly<{
  readonly section: SectionTitle;
  readonly repoPath: string | undefined;
  readonly words: readonly string[];
  readonly signature: string;
  readonly row: Omit<PanelRow, "glyph" | "signature" | "changed">;
}>;

/** The project a checkout path belongs to: the longest project path containing it. */
export function panelProject(projectPaths: readonly string[], path: string): string | undefined {
  const containing = projectPaths.filter(
    (project) => path === project || path.startsWith(`${project}/`),
  );
  return containing.toSorted((left, right) => right.length - left.length)[0] ?? projectPaths[0];
}

/** Where Herdr's focus is: the focused pane's workspace, when known, and a directory. */
export type HerdrFocus = Readonly<{ readonly workspaceId?: string; readonly cwd: string }>;

/**
 * The project Herdr's focus is in: the one whose coordinator or worker runs in the focused
 * workspace, or else the one the directory is in. Worker worktrees sit outside every project, so
 * the workspace comes first.
 */
export function focusedProject(snapshot: BoardSnapshot, focus: HerdrFocus): string | undefined {
  const { workspaceId } = focus;
  const owner =
    workspaceId === undefined
      ? undefined
      : (snapshot.coordinators.find((each) => each.workspaceId === workspaceId)?.repoPath ??
        snapshot.board.running.find((row) => row.worker?.workspaceId === workspaceId)?.repoPath);
  return owner ?? panelProject(snapshot.board.projectPaths, focus.cwd);
}

/** What the panel shows from the last snapshot it could read, if any. */
export function panelView(snapshot: BoardSnapshot | undefined, options: PanelOptions): PanelView {
  const footer = staleFooter(snapshot, options);
  if (snapshot === undefined) {
    return {
      chips: [],
      summary: "",
      quiet: false,
      sections: [],
      signatures: [],
      ...(footer === undefined ? {} : { footer }),
    };
  }
  const { board } = snapshot;
  const entries = boardEntries(board);
  const online = new Set(snapshot.coordinators.map((coordinator) => coordinator.repoPath));
  const chips = board.projectPaths.map((repoPath, index) => ({
    number: index + 1,
    name: board.projects[index] ?? repoPath,
    repoPath,
    needsYou: entries.filter(
      (entry) => entry.repoPath === repoPath && entry.section === "Needs you",
    ).length,
    current: repoPath === options.project,
    offline: !online.has(repoPath),
  }));
  const mine = entries.filter((entry) => entry.repoPath === options.project);
  const needs = mine.filter((entry) => entry.section === "Needs you").length;
  const running = mine.filter(
    (entry) => entry.section === "Running" && entry.row.stage !== "paused",
  ).length;
  const words = searchWords(options.query);
  const sections =
    words.length === 0
      ? SECTION_ORDER.map((title) => ({
          title,
          rows: mine
            .filter((entry) => entry.section === title)
            .map((entry) => panelRow(entry, options.seen)),
        }))
      : chips.map((chip) => ({
          title: chip.name,
          rows: entries
            .filter((entry) => entry.repoPath === chip.repoPath)
            .filter((entry) =>
              words.every((word) => entry.words.some((each) => each.startsWith(word))),
            )
            .toSorted(
              (left, right) =>
                SECTION_ORDER.indexOf(left.section) - SECTION_ORDER.indexOf(right.section),
            )
            .map((entry) => panelRow(entry, options.seen)),
        }));
  return {
    chips,
    summary: `${needs} ${needs === 1 ? "needs" : "need"} you · ${running} running`,
    quiet: needs === 0 && running === 0,
    sections: sections.filter((section) => section.rows.length > 0),
    signatures: entries.map((entry) => entry.signature),
    ...(footer === undefined ? {} : { footer }),
  };
}

function staleFooter(
  snapshot: BoardSnapshot | undefined,
  options: PanelOptions,
): string | undefined {
  const reason = options.readFailed ? "can't read state, retrying" : "no coordinator running";
  if (snapshot === undefined) return options.readFailed ? `⚠ ${reason}` : "⚠ no status yet";
  if (Date.parse(options.now) - Date.parse(snapshot.writtenAt) <= STALE_MS) return undefined;
  return `⚠ updated ${elapsed(snapshot.writtenAt, options.now)} ago · ${reason}`;
}

function panelRow(entry: Entry, seen: ReadonlySet<string> | undefined): PanelRow {
  return {
    ...entry.row,
    signature: entry.signature,
    glyph: PANEL_GLYPHS[entry.row.color],
    changed: seen !== undefined && !seen.has(entry.signature),
  };
}

function signature(key: string, ...parts: readonly string[]): string {
  return [key, ...parts].join("\n");
}

function rowKey(row: Readonly<{ key: string; taskId?: string }>): string {
  return row.taskId === undefined ? row.key : `task:${row.taskId}`;
}

/**
 * Every project's rows. A running task with a pull request shows only as that pull request, and a
 * task done today only as its Done row.
 */
function boardEntries(board: BoardView): Entry[] {
  const withPullRequest = new Set([
    ...board.pullRequests.flatMap((row) => row.taskId ?? []),
    ...board.needsYou
      .filter((row) => row.cause === "pull-request")
      .flatMap((row) => row.taskId ?? []),
  ]);
  const done = new Set(board.doneToday.flatMap((row) => row.taskId ?? []));
  return [
    ...board.needsYou.map(needsYouEntry),
    ...board.running.filter((row) => !withPullRequest.has(row.taskId)).map(runningEntry),
    ...board.pullRequests
      .filter((row) => row.taskId === undefined || !done.has(row.taskId))
      .map(pullRequestEntry),
    ...board.doneToday.map(doneEntry),
  ];
}

function needsYouEntry(row: BoardRow): Entry {
  const kind = NEEDS_YOU[row.cause] ?? { stage: row.text, color: "yellow" as const };
  const line =
    kind.prefix !== undefined && row.text.startsWith(kind.prefix)
      ? row.text.slice(kind.prefix.length)
      : row.text;
  const target: PanelTarget =
    row.cause === "pull-request"
      ? row.url === undefined
        ? { kind: "none" }
        : { kind: "url", url: row.url }
      : row.repoPath === undefined
        ? { kind: "none" }
        : { kind: "chat", repoPath: row.repoPath };
  return {
    section: "Needs you",
    repoPath: row.repoPath,
    words: searchWords(row.name, kind.stage, `needs you ${kind.words ?? ""}`, row.project),
    signature: signature(rowKey(row), kind.stage, line),
    row: {
      key: rowKey(row),
      name: row.name,
      stage: kind.stage,
      color: kind.color,
      lines: [line],
      target,
    },
  };
}

function runningEntry(row: RunningBoardRow): Entry {
  const idle = row.since.startsWith("idle");
  const lines =
    row.cause === "paused"
      ? ["paused by you"]
      : row.cause === "queued"
        ? ["waiting for a free worktree"]
        : [idle ? row.since : `for ${row.since}`];
  const review = row.cause === "reviewing" || row.cause === "awaiting-fixes" ? "review" : "";
  return {
    section: "Running",
    repoPath: row.repoPath,
    words: searchWords(
      row.name,
      row.text,
      `running ${row.cause} ${review} ${idle ? "stuck" : ""}`,
      row.project,
    ),
    signature: signature(rowKey(row), row.text, idle ? "idle" : ""),
    row: {
      key: rowKey(row),
      name: row.name,
      stage: row.text,
      color: idle ? "yellow" : RUNNING_COLORS[row.cause],
      lines,
      target:
        row.worker === undefined
          ? { kind: "none" }
          : { kind: "pane", workspaceId: row.worker.workspaceId, paneId: row.worker.paneId },
    },
  };
}

function pullRequestEntry(row: BoardPullRequest): Entry {
  const stage = row.status.replace(/^\S+\s+/u, "");
  const name = `#${row.number} ${row.branch}`.trimEnd();
  const key = `pr:${row.repo}#${row.number}`;
  return {
    section: "Pull requests",
    repoPath: row.repoPath,
    words: searchWords(name, stage, "pr pull request", row.repo),
    signature: signature(key, stage, row.note),
    row: {
      key,
      name,
      stage,
      color: PR_COLORS[row.color],
      lines: row.note.length === 0 ? [] : [row.note],
      target: row.url.length === 0 ? { kind: "none" } : { kind: "url", url: row.url },
    },
  };
}

function doneEntry(row: BoardRow): Entry {
  return {
    section: "Done today",
    repoPath: row.repoPath,
    words: searchWords(row.name, "done", row.text, row.project),
    signature: signature(rowKey(row), "done", row.text),
    row: {
      key: rowKey(row),
      name: row.name,
      stage: "done",
      color: "green",
      lines: [row.text],
      target:
        row.repoPath === undefined ? { kind: "none" } : { kind: "chat", repoPath: row.repoPath },
    },
  };
}

function searchWords(...parts: readonly string[]): string[] {
  return parts
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}@]+/u)
    .filter(Boolean);
}
