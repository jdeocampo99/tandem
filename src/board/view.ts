import { basename } from "node:path";
import type { IsoTimestamp, RequestBriefRecord, TaskRecord, TaskStage } from "../contracts.ts";
import { type PrWatch, type PrWatchPoll, sameRef } from "../pr-watch/store.ts";
import { elapsed, type PrWatchViewRow, pad, prWatchLines, prWatchView } from "../pr-watch/view.ts";
import { awaitsApproval, requestApprovalState } from "../requests/brief.ts";
import { isTerminalTask } from "../service/records.ts";
import type { TimelineEvent } from "../tasks/timeline.ts";
import { dollars, summarizeRollups, type TaskRollup, type TraceSummary } from "../tasks/trace.ts";

/** Task stages that wait on the user. */
const NEEDS_YOU_STAGES: readonly TaskStage[] = ["awaiting-approval", "blocked", "ready"];
/** Task stages where Tandem is working on its own, or the user paused it. */
const RUNNING_STAGES: readonly TaskStage[] = [
  "paused",
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
];

/** Everything the board shows, read from what Tandem already saved. Nothing here calls GitHub. */
export type BoardState = Readonly<{
  /** Every onboarded project's path. */
  readonly projects: readonly string[];
  readonly tasks: readonly TaskRecord[];
  readonly briefs: readonly RequestBriefRecord[];
  readonly watches: readonly PrWatch[];
  readonly poll: PrWatchPoll;
  /** Rollups of the tasks {@link finishedWithinWeek} accepted, across every project. */
  readonly finishedThisWeek: readonly TaskRollup[];
}>;

export type BoardView = Readonly<{
  readonly now: IsoTimestamp;
  /** Project names, for the header. */
  readonly projects: readonly string[];
  /** When PR watch last read GitHub. */
  readonly checkedAt?: IsoTimestamp;
  readonly needsYou: readonly BoardRow[];
  readonly running: readonly BoardRow[];
  /** Watched pull requests that do not need the user. */
  readonly pullRequests: readonly PrWatchViewRow[];
  /** Completed, merged, and cancelled tasks, which the board leaves out. */
  readonly finished: number;
  /** The last 7 days; absent when no task finished in them. */
  readonly week?: WeekSummary;
}>;

export type WeekSummary = Pick<
  TraceSummary,
  "tasks" | "reviewedTasks" | "firstPassReviews" | "costMicros" | "unpricedSamples"
>;

/** What only `tandem status` adds below the board. */
export type StatusFooter = Readonly<{
  /** The commit the `tandem` command runs from, as `tandemCodeVersion` reads it. */
  readonly code: string;
  /** Projects with an open coordinator. */
  readonly coordinators: readonly string[];
}>;

export type BoardRow = Readonly<{
  /** Stays the same while the row stands for the same thing, so a new arrival can be noticed. */
  readonly key: string;
  /** What the row is: a brief, a task question, a pull request, or a task in this stage. */
  readonly cause: "brief" | "question" | "pull-request" | TaskStage;
  /** The project the row belongs to; absent for a pull request no project claims. */
  readonly repoPath?: string;
  readonly project: string;
  readonly mark: string;
  readonly name: string;
  readonly text: string;
}>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NAME_CHARS = 30;
const TEXT_CHARS = 80;

const RUNNING_LABELS: Readonly<Record<string, Readonly<{ mark: string; label: string }>>> = {
  paused: { mark: "⏸️", label: "paused" },
  queued: { mark: "⏳", label: "waiting to start" },
  scouting: { mark: "🔍", label: "researching" },
  implementing: { mark: "🔨", label: "implementing" },
  validating: { mark: "🧪", label: "checking" },
  reviewing: { mark: "👀", label: "in review" },
  "awaiting-fixes": { mark: "🔨", label: "fixing review findings" },
};

const NEEDS_YOU_LABELS: Readonly<Record<string, string>> = {
  "awaiting-approval": "waiting for approval",
  ready: "done, waiting for you",
};

/**
 * Sorts saved state into the board's sections. "Needs you" holds briefs awaiting approval, task
 * questions, tasks waiting on the user, and pull requests PR watch marked red; the rest is context.
 */
export function boardView(state: BoardState, now: IsoTimestamp): BoardView {
  const live = state.tasks.filter((task) => !isTerminalTask(task));
  const pullRequests = prWatchView(state.watches, state.poll, now, []);
  const red = pullRequests.rows.filter((row) => row.color === "red");
  return {
    now,
    projects: state.projects.map((path) => basename(path)),
    ...(pullRequests.readAt === undefined ? {} : { checkedAt: pullRequests.readAt }),
    needsYou: [
      ...state.briefs.filter(awaitsApproval).map(briefRow),
      ...live.filter(needsYou).map(taskNeedsYouRow),
      ...red.map((row) => pullRequestRow(row, state)),
    ],
    running: live
      .filter((task) => !needsYou(task) && RUNNING_STAGES.includes(task.stage))
      .map((task) => runningRow(task, now)),
    pullRequests: pullRequests.rows.filter((row) => row.color !== "red"),
    finished: state.tasks.length - live.length,
    ...(state.finishedThisWeek.length === 0 ? {} : { week: weekSummary(state.finishedThisWeek) }),
  };
}

/** Whether a time falls in the 7 days before `now`. */
export function withinWeek(at: IsoTimestamp, now: IsoTimestamp): boolean {
  return Date.parse(now) - Date.parse(at) <= WEEK_MS;
}

/** Whether a task's timeline last marked it completed or merged within the 7 days before `now`. */
export function finishedWithinWeek(events: readonly TimelineEvent[], now: IsoTimestamp): boolean {
  const finished = events.findLast(
    (event) =>
      event.type === "stage-changed" && (event.to === "completed" || event.to === "merged"),
  );
  return finished !== undefined && withinWeek(finished.at, now);
}

/**
 * Whether a "Needs you" row is worth opening the board for. A blocked task is not: recovery
 * restarts most blocks on its own, so the pane would pop for blocks that clear themselves.
 */
export function opensBoard(row: BoardRow): boolean {
  return (
    row.cause === "brief" ||
    row.cause === "question" ||
    row.cause === "pull-request" ||
    row.cause === "awaiting-approval" ||
    row.cause === "ready"
  );
}

/** The board: header and sections, as "how's it going?" shows it in the chat. */
export function renderBoard(view: BoardView): string {
  const header = [
    `Projects: ${view.projects.length === 0 ? "none yet" : view.projects.join(", ")}`,
    view.checkedAt === undefined
      ? "PRs not checked yet"
      : `PRs checked ${elapsed(view.checkedAt, view.now)} ago`,
  ].join(" · ");
  const sections = [
    ["Needs you", ...(view.needsYou.length === 0 ? ["Nothing needs you."] : [])]
      .concat(boardLines(view.needsYou))
      .join("\n"),
    ...(view.running.length === 0 ? [] : [["Running", ...boardLines(view.running)].join("\n")]),
    ...(view.pullRequests.length === 0
      ? []
      : [["PRs", ...prWatchLines(view.pullRequests, true)].join("\n")]),
    ...(view.week === undefined ? [] : [weekLine(view.week)]),
  ];
  return `${[header, ...sections].join("\n\n")}\n`;
}

/** `tandem status`: the board, then what was finished, which coordinators are open, and how to go on. */
export function renderStatus(view: BoardView, footer: StatusFooter): string {
  const coordinators =
    footer.coordinators.length === 0
      ? "no coordinators open, run `tandem`"
      : `coordinators open: ${footer.coordinators.map((path) => basename(path)).join(", ")}`;
  const plural = view.finished === 1 ? "" : "s";
  return [
    renderBoard(view),
    [
      ...(view.finished === 0 ? [] : [`${view.finished} finished task${plural} hidden`]),
      coordinators,
    ].join(" · "),
    `Tandem code: ${footer.code}`,
    "Ask the coordinator about any task, or run `tandem status --json` for task IDs · live view: tandem status --watch",
    "",
  ].join("\n");
}

/** Like "This week: 7 done · 5 of 7 passed review first time · $14.20". */
function weekLine(week: WeekSummary): string {
  const unpriced = week.unpricedSamples === 0 ? "" : " + unpriced usage";
  return [
    `This week: ${week.tasks} done`,
    ...(week.reviewedTasks === 0
      ? []
      : [`${week.firstPassReviews} of ${week.reviewedTasks} passed review first time`]),
    `${dollars(week.costMicros)}${unpriced}`,
  ].join(" · ");
}

function weekSummary(rollups: readonly TaskRollup[]): WeekSummary {
  const { tasks, reviewedTasks, firstPassReviews, costMicros, unpricedSamples } =
    summarizeRollups(rollups);
  return { tasks, reviewedTasks, firstPassReviews, costMicros, unpricedSamples };
}

/** Aligned rows, two spaces between columns. */
function boardLines(rows: readonly BoardRow[]): string[] {
  const width = (values: readonly string[]) =>
    Math.max(0, ...values.map((value) => [...value].length));
  const projectWidth = width(rows.map((row) => row.project));
  const nameWidth = width(rows.map((row) => row.name));
  return rows.map((row) =>
    `${row.mark} ${[pad(row.project, projectWidth), pad(row.name, nameWidth), row.text].join("  ")}`.trimEnd(),
  );
}

function needsYou(task: TaskRecord): boolean {
  return task.communication?.question !== undefined || NEEDS_YOU_STAGES.includes(task.stage);
}

function briefRow(brief: RequestBriefRecord): BoardRow {
  return {
    key: `brief:${brief.id}`,
    cause: "brief",
    repoPath: brief.repoPath,
    project: basename(brief.repoPath),
    mark: "🙋",
    name: shorten(brief.draft.content.goal, NAME_CHARS),
    text:
      requestApprovalState(brief) === "unapproved"
        ? "brief waiting for approval"
        : "brief changed, needs approval again",
  };
}

function taskNeedsYouRow(task: TaskRecord): BoardRow {
  const question = task.communication?.question;
  const text =
    question !== undefined
      ? `question: ${question.text}`
      : task.stage === "blocked"
        ? `blocked: ${task.blockReason ?? "no reason recorded"}`
        : (NEEDS_YOU_LABELS[task.stage] ?? task.stage);
  return {
    key: question === undefined ? `task:${task.id}:${task.stage}` : `question:${question.id}`,
    cause: question === undefined ? task.stage : "question",
    ...taskIdentity(task),
    mark: "🙋",
    text: shorten(text, TEXT_CHARS),
  };
}

function runningRow(task: TaskRecord, now: IsoTimestamp): BoardRow {
  const { mark, label } = RUNNING_LABELS[task.stage] ?? { mark: "🔨", label: task.stage };
  return {
    key: `task:${task.id}:${task.stage}`,
    cause: task.stage,
    ...taskIdentity(task),
    mark,
    text: `${label} · ${elapsed(task.createdAt, now)}`,
  };
}

function taskIdentity(task: TaskRecord): Pick<BoardRow, "repoPath" | "project" | "name"> {
  return {
    repoPath: task.repoPath,
    project: basename(task.repoPath),
    name: shorten(task.objective, NAME_CHARS),
  };
}

/** A red PR row: it belongs to its task's project, or the checkout it was watched from. */
function pullRequestRow(row: PrWatchViewRow, state: BoardState): BoardRow {
  const watch = state.watches.find((candidate) => sameRef(candidate.ref, row));
  const task = state.tasks.find((candidate) => candidate.id === watch?.taskId);
  const repoPath = task?.repoPath ?? watch?.repoPath;
  const note = row.link === undefined ? row.note : `${row.note} → ${row.link}`;
  return {
    key: `pr:${row.repo}#${row.number}`,
    cause: "pull-request",
    ...(repoPath === undefined ? {} : { repoPath }),
    project:
      repoPath === undefined ? row.repo.slice(row.repo.indexOf("/") + 1) : basename(repoPath),
    mark: "🔴",
    name: `${row.repo}#${row.number} ${row.branch}`.trimEnd(),
    text: note.length > 0 ? note : row.status,
  };
}

function shorten(text: string, limit: number): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}
