import type { BlockCauseKind } from "../contracts.ts";
import type { TodoItem } from "../playbooks/progress.ts";
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
  /** At most two short lines in plain words, counting `activity`. */
  readonly lines: readonly string[];
  /** A running worker's current tool, drawn last as `▸ edit src/auth/session.ts · 4s`. */
  readonly activity?: PanelActivity;
  /** A running worker's to-do list, shown under the row on request. */
  readonly steps?: readonly PanelStep[];
  readonly target: PanelTarget;
  readonly changed: boolean;
}>;

/** The renderer fits `target` to the width, so it is not cut here. */
export type PanelActivity = Readonly<{ verb: string; target?: string; age?: string }>;

export type PanelStep = Readonly<{
  readonly text: string;
  readonly status: "done" | "doing" | "todo" | "dropped";
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
/** How src/board/view.ts starts a running row's `since` when its worker has gone quiet. */
const IDLE_PREFIX = "idle ";
const SECTION_ORDER = ["Needs you", "Running", "Pull requests", "Done today"] as const;
type SectionTitle = (typeof SECTION_ORDER)[number];

const NEEDS_YOU: Readonly<
  Record<string, Readonly<{ stage: string; color: PanelColor; prefix?: string; words?: string }>>
> = {
  brief: { stage: "brief to approve", color: "yellow" },
  question: { stage: "question", color: "yellow", prefix: "question: " },
  "model-question": { stage: "model question", color: "yellow", prefix: "model question: " },
  "awaiting-approval": { stage: "to approve", color: "yellow" },
  ready: { stage: "ready to publish", color: "yellow" },
  blocked: { stage: "stopped", color: "red", prefix: "blocked: ", words: "stuck" },
  "pull-request": { stage: "PR failing", color: "red", words: "pr" },
};

/**
 * Short words for block causes whose kind alone says what happened. Kinds that cover several
 * situations, like `prerequisite-not-met`, show the reason the blocking site wrote instead.
 */
const STOP_CAUSES: Readonly<Partial<Record<BlockCauseKind, string>>> = {
  "worker-failed": "the worker failed",
  "review-lens-failed": "a review failed",
  "resource-lost": "its terminal was lost",
  "allocation-failed": "couldn't set up a worker",
  "stale-review-state": "the review went out of date",
  "fix-rounds-exhausted": "out of fix rounds",
  "validation-config-refused": "check commands aren't set up",
  "ownership-unprovable": "couldn't confirm the worker stopped",
  "quarantined-unknown-outcome": "an action's result is unknown",
};

const REVIEW_WORDS: Readonly<Record<NonNullable<BoardRow["reviewLevel"]>, string>> = {
  none: "no review",
  light: "light review",
  standard: "standard review",
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

/** OMP's and Claude Code's tool names, lowercased, as plain verbs; `undefined` hides the line. */
const TOOL_VERBS: ReadonlyMap<string, string | undefined> = new Map([
  ["read", "read"],
  ["notebookread", "read"],
  ["edit", "edit"],
  ["multiedit", "edit"],
  ["notebookedit", "edit"],
  ["write", "edit"],
  ["bash", "run"],
  ["grep", "search"],
  ["glob", "search"],
  ["find", "search"],
  ["ls", "search"],
  ["web_search", "browse"],
  ["websearch", "browse"],
  ["webfetch", "browse"],
  ["fetch", "browse"],
  ["task", "delegate"],
  ["agent", "delegate"],
  ["ask", "ask"],
  ["askuserquestion", "ask"],
  ["submit_report", "report"],
  ["copy_asset", "copy"],
  ["todo", undefined],
  ["todowrite", undefined],
  ["taskcreate", undefined],
  ["taskupdate", undefined],
  ["tasklist", undefined],
  ["taskget", undefined],
]);

const STEP_STATUSES: Readonly<Record<string, PanelStep["status"]>> = {
  completed: "done",
  in_progress: "doing",
  abandoned: "dropped",
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
          title: title.toUpperCase(),
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
    ...board.running
      .filter((row) => !withPullRequest.has(row.taskId))
      .map((row) => runningEntry(row, board.now)),
    ...board.pullRequests
      .filter((row) => row.taskId === undefined || !done.has(row.taskId))
      .map(pullRequestEntry),
    ...board.doneToday.map(doneEntry),
  ];
}

function needsYouEntry(row: BoardRow): Entry {
  const kind = NEEDS_YOU[row.cause] ?? { stage: row.text, color: "yellow" as const };
  const text =
    kind.prefix !== undefined && row.text.startsWith(kind.prefix)
      ? row.text.slice(kind.prefix.length)
      : row.text;
  const line = needsYouLine(row, text);
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

/** A needs-you row's second line, from its facts when the board has them, else its text. */
function needsYouLine(row: BoardRow, text: string): string {
  if (row.cause === "brief" && row.briefSize !== undefined) {
    const review = row.reviewLevel === undefined ? [] : [REVIEW_WORDS[row.reviewLevel]];
    return [`brief: ${row.briefSize} change`, ...review].join(" · ");
  }
  if (row.cause === "ready" && row.pullRequest !== undefined) {
    return `${row.pullRequest.draft ? "draft PR" : "PR"} #${row.pullRequest.number}`;
  }
  if (row.cause === "blocked") {
    const cause =
      (row.blockKind === undefined ? undefined : STOP_CAUSES[row.blockKind]) ??
      text.replace(/\.$/u, "");
    return row.restarts === undefined
      ? cause
      : `stopped after ${count(row.restarts, "restart")}: ${cause}`;
  }
  return text;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function runningEntry(row: RunningBoardRow, now: string): Entry {
  const idleFor = row.since.startsWith(IDLE_PREFIX)
    ? row.since.slice(IDLE_PREFIX.length)
    : undefined;
  const idle = idleFor !== undefined;
  const activity =
    row.cause === "paused" || row.cause === "queued" ? undefined : toolActivity(row, now);
  const steps = row.activity?.todos?.map((item) => ({
    text: item.content,
    status: STEP_STATUSES[item.status] ?? "todo",
  }));
  const lines = runningLines(row, idleFor, activity);
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
    signature: signature(
      rowKey(row),
      row.text,
      idle ? "idle" : "",
      row.openFindings === undefined ? "" : `${row.openFindings}`,
    ),
    row: {
      key: rowKey(row),
      name: row.name,
      stage: row.text,
      color: idle ? "yellow" : RUNNING_COLORS[row.cause],
      lines,
      ...(activity === undefined ? {} : { activity }),
      ...(steps === undefined || steps.length === 0 ? {} : { steps }),
      target:
        row.worker === undefined
          ? { kind: "none" }
          : { kind: "pane", workspaceId: row.worker.workspaceId, paneId: row.worker.paneId },
    },
  };
}

/**
 * The lines above the tool line: an implementer's step or a fixer's findings come first, idling
 * replaces them. Idling never claims Tandem is restarting the worker: nothing records that recovery
 * has noticed a quiet worker that is still alive.
 */
function runningLines(
  row: RunningBoardRow,
  idleFor: string | undefined,
  activity: PanelActivity | undefined,
): string[] {
  if (row.cause === "paused") return ["paused by you"];
  if (row.cause === "queued") return ["waiting for a free worktree"];
  if (idleFor !== undefined) return [`no progress for ${idleFor}`];
  const lead =
    row.cause === "implementing"
      ? currentStep(row.activity?.todos)
      : row.openFindings === undefined
        ? undefined
        : `review found ${count(row.openFindings, "issue")} · fixing them`;
  if (lead !== undefined) return [lead];
  return activity === undefined ? [`for ${row.since}`] : [];
}

/** The to-do in progress, else the next pending one. */
function currentStep(todos: readonly TodoItem[] | undefined): string | undefined {
  return (
    todos?.find((item) => item.status === "in_progress") ??
    todos?.find((item) => item.status === "pending")
  )?.content;
}

function toolActivity(row: RunningBoardRow, now: string): PanelActivity | undefined {
  const { tool, toolTarget, toolStartedAt } = row.activity ?? {};
  if (tool === undefined) return undefined;
  const name = tool.toLowerCase().replace(/^mcp__.+?__/u, "");
  const verb = TOOL_VERBS.has(name) ? TOOL_VERBS.get(name) : name;
  if (verb === undefined) return undefined;
  return {
    verb,
    ...(toolTarget === undefined ? {} : { target: toolTarget }),
    ...(toolStartedAt === undefined ? {} : { age: elapsed(toolStartedAt, now) }),
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
