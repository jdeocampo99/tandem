import { basename } from "node:path";
import type { IsoTimestamp, RequestBriefRecord, TaskRecord, TaskStage } from "../contracts.ts";
import { type PrWatch, type PrWatchPoll, sameRef } from "../pr-watch/store.ts";
import { elapsed, PR_MARKS, type PrWatchViewRow, prWatchView } from "../pr-watch/view.ts";
import { awaitsApproval, requestApprovalState } from "../requests/brief.ts";
import type { DurableExecutionRoutingPause } from "../runtime/schema.ts";
import { isTerminalTask } from "../service/records.ts";
import type { TimelineEvent } from "../tasks/timeline.ts";
import { dollars, summarizeRollups, type TaskRollup, type TraceSummary } from "../tasks/trace.ts";
import { raisedRoutingPause, routingPauseExplanation } from "../workers/execution-routing.ts";
import type { WorkerActivity } from "../workers/worker-activity.ts";

/** Task stages that wait on the user. */
const NEEDS_YOU_STAGES: readonly TaskStage[] = ["awaiting-approval", "blocked", "ready"];
/** Terminal order for work Tandem is currently doing. */
export const RUNNING_STAGE_ORDER = [
  "paused",
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
] as const satisfies readonly TaskStage[];
export type RunningStage = (typeof RUNNING_STAGE_ORDER)[number];
type RunningTaskRecord = TaskRecord & Readonly<{ stage: RunningStage }>;

/** Everything the board shows, read from what Tandem already saved. Nothing here calls GitHub. */
export type BoardState = Readonly<{
  /** Every onboarded project's path. */
  readonly projects: readonly string[];
  readonly tasks: readonly TaskRecord[];
  readonly briefs: readonly RequestBriefRecord[];
  /** Saved routing questions; one for a task's current generation stops it until the user answers. */
  readonly routingPauses: readonly DurableExecutionRoutingPause[];
  readonly watches: readonly PrWatch[];
  readonly poll: PrWatchPoll;
  /** Rollups of the tasks {@link finishedWithinWeek} accepted, across every project. */
  readonly finishedThisWeek: readonly TaskRollup[];
  /** Task id to when its worker last made progress; tasks without a receipt are absent. */
  readonly progressAt: ReadonlyMap<string, IsoTimestamp>;
  /** Task id to what its primary worker is doing, for display; tasks without it are absent. */
  readonly activities: ReadonlyMap<string, WorkerActivity>;
  /** Task id to the pane of its live primary worker; tasks without one are absent. */
  readonly workerPanes: ReadonlyMap<string, WorkerPane>;
}>;

/** Where a task's worker runs in Herdr, so the panel can focus it. */
export type WorkerPane = Readonly<{ readonly workspaceId: string; readonly paneId: string }>;

export type BoardView = Readonly<{
  readonly now: IsoTimestamp;
  /** Project names, for the header. */
  readonly projects: readonly string[];
  /** The same projects' checkout paths, in the same order. */
  readonly projectPaths: readonly string[];
  /** When PR watch last read GitHub. */
  readonly checkedAt?: IsoTimestamp;
  readonly needsYou: readonly BoardRow[];
  readonly running: readonly RunningBoardRow[];
  /** Watched pull requests that do not need the user. */
  readonly pullRequests: readonly BoardPullRequest[];
  /** Completed, merged, and cancelled tasks, which the board leaves out. */
  readonly finished: number;
  /** Tasks completed or merged in the last day, newest first; `tandem status` only counts them. */
  readonly doneToday: readonly BoardRow[];
  /** The last 7 days; absent when no task finished in them. */
  readonly week?: WeekSummary;
}>;

export type BoardPullRequest = PrWatchViewRow & Readonly<{ readonly repoPath?: string }>;

export type WeekSummary = Pick<
  TraceSummary,
  "tasks" | "reviewedTasks" | "firstPassReviews" | "costMicros" | "unpricedSamples"
>;

export type BoardRow = Readonly<{
  /** Stays the same while the row stands for the same thing, so a new arrival can be noticed. */
  readonly key: string;
  /** What the row is: a brief, a task or model question, a pull request, or a task in this stage. */
  readonly cause: "brief" | "question" | "model-question" | "pull-request" | TaskStage;
  /** The project the row belongs to; absent for a pull request no project claims. */
  readonly repoPath?: string;
  /** The task the row stands for; absent for briefs and pull requests no task opened. */
  readonly taskId?: string;
  /** A pull request row's page. */
  readonly url?: string;
  readonly project: string;
  readonly mark: string;
  readonly name: string;
  readonly text: string;
  /** How long a running task has existed, like 12m. */
  readonly since?: string;
}>;
const BOARD_ROW_CAUSES = new Set<BoardRow["cause"]>([
  "brief",
  "question",
  "pull-request",
  "awaiting-approval",
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
  "ready",
  "paused",
  "blocked",
  "cancelled",
  "completed",
  "merged",
]);
const PR_WATCH_COLORS = new Set<PrWatchViewRow["color"]>([
  "red",
  "yellow",
  "green",
  "done",
  "unwatched",
]);

/** Checks persisted board details before a chat renderer uses them. */
export function isBoardView(value: unknown): value is BoardView {
  const view = recordOf(value);
  return (
    view !== undefined &&
    typeof view.now === "string" &&
    isStringArray(view.projects) &&
    isStringArray(view.projectPaths) &&
    (view.checkedAt === undefined || typeof view.checkedAt === "string") &&
    Array.isArray(view.needsYou) &&
    view.needsYou.every(isBoardRow) &&
    Array.isArray(view.running) &&
    view.running.every(isRunningBoardRow) &&
    Array.isArray(view.pullRequests) &&
    view.pullRequests.every(isBoardPullRequest) &&
    isFiniteNumber(view.finished) &&
    Array.isArray(view.doneToday) &&
    view.doneToday.every(isBoardRow) &&
    (view.week === undefined || isWeekSummary(view.week))
  );
}

function isBoardRow(value: unknown): value is BoardRow {
  const row = recordOf(value);
  return (
    row !== undefined &&
    typeof row.key === "string" &&
    typeof row.cause === "string" &&
    BOARD_ROW_CAUSES.has(row.cause as BoardRow["cause"]) &&
    (row.repoPath === undefined || typeof row.repoPath === "string") &&
    (row.taskId === undefined || typeof row.taskId === "string") &&
    (row.url === undefined || typeof row.url === "string") &&
    typeof row.project === "string" &&
    typeof row.mark === "string" &&
    typeof row.name === "string" &&
    typeof row.text === "string" &&
    (row.since === undefined || typeof row.since === "string")
  );
}

function isRunningBoardRow(value: unknown): value is RunningBoardRow {
  const row = recordOf(value);
  return (
    isBoardRow(value) &&
    row !== undefined &&
    isRunningStage(row.cause) &&
    typeof row.repoPath === "string" &&
    typeof row.taskId === "string" &&
    typeof row.since === "string" &&
    (row.worker === undefined || isWorkerPane(row.worker)) &&
    (row.activity === undefined || recordOf(row.activity) !== undefined)
  );
}

function isWorkerPane(value: unknown): value is WorkerPane {
  const pane = recordOf(value);
  return (
    pane !== undefined && typeof pane.workspaceId === "string" && typeof pane.paneId === "string"
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPrWatchViewRow(value: unknown): value is PrWatchViewRow {
  const row = recordOf(value);
  return (
    row !== undefined &&
    typeof row.repo === "string" &&
    isFiniteNumber(row.number) &&
    typeof row.branch === "string" &&
    typeof row.url === "string" &&
    typeof row.color === "string" &&
    PR_WATCH_COLORS.has(row.color as PrWatchViewRow["color"]) &&
    typeof row.checks === "string" &&
    (row.checkCounts === undefined || isCheckCounts(row.checkCounts)) &&
    typeof row.status === "string" &&
    typeof row.note === "string" &&
    (row.link === undefined || typeof row.link === "string") &&
    (row.taskId === undefined || typeof row.taskId === "string")
  );
}

function isBoardPullRequest(value: unknown): value is BoardPullRequest {
  const repoPath = recordOf(value)?.repoPath;
  return isPrWatchViewRow(value) && (repoPath === undefined || typeof repoPath === "string");
}

function isCheckCounts(value: unknown): boolean {
  const counts = recordOf(value);
  return (
    counts !== undefined &&
    isFiniteNumber(counts.passed) &&
    isFiniteNumber(counts.failed) &&
    isFiniteNumber(counts.pending)
  );
}

function isWeekSummary(value: unknown): value is WeekSummary {
  const week = recordOf(value);
  return (
    week !== undefined &&
    isFiniteNumber(week.tasks) &&
    isFiniteNumber(week.reviewedTasks) &&
    isFiniteNumber(week.firstPassReviews) &&
    isFiniteNumber(week.costMicros) &&
    isFiniteNumber(week.unpricedSamples)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type RunningBoardRow = Omit<BoardRow, "cause" | "repoPath" | "taskId" | "since"> &
  Readonly<{
    cause: RunningStage;
    repoPath: string;
    taskId: string;
    since: string;
    worker?: WorkerPane;
    activity?: WorkerActivity;
  }>;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** A running task whose worker has made no progress for this long shows as idle. */
const IDLE_MS = 5 * 60 * 1000;
const NAME_CHARS = 30;
const TEXT_CHARS = 80;

const RUNNING_LABELS: Readonly<Record<RunningStage, Readonly<{ mark: string; label: string }>>> = {
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

export function isRunningStage(stage: unknown): stage is RunningStage {
  return RUNNING_STAGE_ORDER.some((candidate) => candidate === stage);
}

/**
 * Sorts saved state into the board's sections. "Needs you" holds briefs awaiting approval, task
 * questions, tasks waiting on the user, and pull requests PR watch marked red; the rest is context.
 */
export function boardView(state: BoardState, now: IsoTimestamp): BoardView {
  const live = state.tasks.filter((task) => !isTerminalTask(task));
  const pullRequests = prWatchView(state.watches, state.poll, now, []);
  const red = pullRequests.rows.filter((row) => row.color === "red");
  const needsYou = (task: TaskRecord) =>
    taskNeedsYou(task) || modelQuestion(task, state.routingPauses) !== undefined;
  return {
    now,
    projects: state.projects.map((path) => basename(path)),
    projectPaths: state.projects,
    ...(pullRequests.readAt === undefined ? {} : { checkedAt: pullRequests.readAt }),
    needsYou: [
      ...state.briefs.filter(awaitsApproval).map(briefRow),
      ...live
        .filter(needsYou)
        .map((task) => taskNeedsYouRow(task, modelQuestion(task, state.routingPauses))),
      ...red.map((row) => pullRequestRow(row, state)),
    ],
    running: live
      .filter((task): task is RunningTaskRecord => !needsYou(task) && isRunningStage(task.stage))
      .map((task) => runningRow(task, now, state, state.workerPanes.get(task.id))),
    pullRequests: pullRequests.rows
      .filter((row) => row.color !== "red")
      .map((row) => {
        const { repoPath } = pullRequestOwner(row, state);
        return repoPath === undefined ? row : { ...row, repoPath };
      }),
    finished: state.tasks.length - live.length,
    doneToday: state.tasks
      .filter((task) => doneWithinDay(task, now))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(doneRow),
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
 * Whether a new "Needs you" row is worth a Herdr notification. A blocked task is not: recovery
 * restarts most blocks on its own, so it would notify for blocks that clear themselves.
 */
export function notifiesUser(row: BoardRow): boolean {
  return (
    row.cause === "brief" ||
    row.cause === "question" ||
    row.cause === "model-question" ||
    row.cause === "pull-request" ||
    row.cause === "awaiting-approval" ||
    row.cause === "ready"
  );
}

/** A Herdr notification: Herdr trims the title to 80 characters and the body to 240. */
export type NeedsYouNotice = Readonly<{ readonly title: string; readonly body: string }>;

/**
 * The notification for rows that just arrived in "Needs you": one row names itself and why; more
 * than one are counted and named. Both point at the live view.
 */
export function needsYouNotice(rows: readonly BoardRow[]): NeedsYouNotice {
  const [only] = rows;
  if (rows.length === 1 && only !== undefined) {
    return { title: `Tandem: ${only.name}`, body: `${only.text} · prefix+t for status` };
  }
  return {
    title: `Tandem: ${rows.length} things need you`,
    body: `${rows.map((row) => row.name).join(", ")} · prefix+t for status`,
  };
}

/** Where the chat board points for the live view; setup.sh binds prefix+t in Herdr. */
const LIVE_VIEW_HINT = "_Live view: `prefix+t` in Herdr, or `tandem status --watch`._";

/** The chat board: Markdown structure that remains readable without terminal colors or columns. */
export function renderBoard(view: BoardView): string {
  const projects = view.projects.length === 0 ? "none yet" : markdownText(view.projects.join(", "));
  const checkedAt =
    view.checkedAt === undefined ? "not checked yet" : `${elapsed(view.checkedAt, view.now)} ago`;
  const header = `**Projects:** ${projects} · **PRs checked:** ${checkedAt}`;
  const sections = [
    [
      `### 🙋 Needs you · ${view.needsYou.length}`,
      ...(view.needsYou.length === 0 ? ["Nothing needs you."] : chatBoardLines(view.needsYou)),
    ].join("\n"),
    ...(view.running.length === 0
      ? []
      : [[`### 🔨 Running · ${view.running.length}`, ...chatBoardLines(view.running)].join("\n")]),
    ...(view.pullRequests.length === 0
      ? []
      : [
          [
            `### 🔀 Pull requests · ${view.pullRequests.length}`,
            ...chatPullRequestLines(view.pullRequests),
          ].join("\n"),
        ]),
    ...(view.week === undefined ? [] : [`### 📈 This week\n${weekLine(view.week)}`]),
    LIVE_VIEW_HINT,
  ];
  return `## Tandem status\n\n${header}\n\n${sections.join("\n\n")}\n`;
}

function chatBoardLines(rows: readonly BoardRow[]): string[] {
  return rows.map(
    (row) =>
      `- ${row.mark} **${markdownText(row.project)}** · **${markdownText(compactBoardName(row))}** — ${markdownText(rowText(row))}`,
  );
}

function chatPullRequestLines(rows: readonly PrWatchViewRow[]): string[] {
  return rows.flatMap((row) => {
    const note =
      row.link === undefined ? row.note : [row.note, row.link].filter(Boolean).join(" → ");
    const details = [row.checks, row.status, note]
      .filter((value) => value.length > 0)
      .map(markdownText)
      .join(" · ");
    return [
      `- ${PR_MARKS[row.color]} **${markdownText(`${row.repo}#${row.number}`)}**${row.branch.length === 0 ? "" : ` — ${markdownText(row.branch)}`}`,
      ...(details.length === 0 ? [] : [`  ${details}`]),
    ];
  });
}

function markdownText(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>");
}

/** Like "7 done · 5 of 7 passed review first time · $14.20". */
function weekLine(week: WeekSummary): string {
  const unpriced = week.unpricedSamples === 0 ? "" : " + unpriced usage";
  return [
    `${week.tasks} done`,
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

function compactBoardName(row: BoardRow): string {
  return isRunningStage(row.cause) ? shorten(row.name, NAME_CHARS) : row.name;
}

function rowText(row: BoardRow): string {
  return row.since === undefined ? row.text : `${row.text} · ${row.since}`;
}

function taskNeedsYou(task: TaskRecord): boolean {
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

/**
 * The routing question that stops a task from starting its next worker: nothing starts until the
 * user answers, so a task still reading "researching" would hide it.
 */
function modelQuestion(
  task: TaskRecord,
  pauses: readonly DurableExecutionRoutingPause[],
): Readonly<{ key: string; text: string }> | undefined {
  const pause = pauses.find(
    (entry) => entry.taskId === task.id && entry.generation === task.generation,
  );
  if (pause === undefined || !raisedRoutingPause(pause)) return undefined;
  return {
    key: `model-question:${pause.decisionId}`,
    text: `model question: keep ${pause.pinnedSelector}? ${routingPauseExplanation(pause)}`,
  };
}

function taskNeedsYouRow(
  task: TaskRecord,
  model: Readonly<{ key: string; text: string }> | undefined,
): BoardRow {
  const question = task.communication?.question;
  const reason: Pick<BoardRow, "key" | "cause" | "text"> =
    question !== undefined
      ? { key: `question:${question.id}`, cause: "question", text: `question: ${question.text}` }
      : task.stage === "blocked"
        ? {
            key: `task:${task.id}:${task.stage}`,
            cause: task.stage,
            text: `blocked: ${task.blockReason ?? "no reason recorded"}`,
          }
        : model !== undefined
          ? { key: model.key, cause: "model-question", text: model.text }
          : {
              key: `task:${task.id}:${task.stage}`,
              cause: task.stage,
              text: NEEDS_YOU_LABELS[task.stage] ?? task.stage,
            };
  return {
    ...reason,
    ...taskIdentity(task),
    name: shorten(task.objective, NAME_CHARS),
    mark: "🙋",
    text: shorten(reason.text, TEXT_CHARS),
  };
}

function runningRow(
  task: RunningTaskRecord,
  now: IsoTimestamp,
  state: Pick<BoardState, "progressAt" | "activities">,
  worker: WorkerPane | undefined,
): RunningBoardRow {
  const { mark, label } = RUNNING_LABELS[task.stage];
  const progressAt = state.progressAt.get(task.id);
  const activity = state.activities.get(task.id);
  return {
    key: `task:${task.id}:${task.stage}`,
    cause: task.stage,
    ...taskIdentity(task),
    ...(worker === undefined ? {} : { worker }),
    name: task.objective,
    mark,
    text: label,
    since:
      progressAt !== undefined && Date.parse(now) - Date.parse(progressAt) > IDLE_MS
        ? `idle ${elapsed(progressAt, now)}`
        : elapsed(task.createdAt, now),
    ...(activity === undefined ? {} : { activity }),
  };
}

function doneWithinDay(task: TaskRecord, now: IsoTimestamp): boolean {
  return (
    (task.stage === "completed" || task.stage === "merged") &&
    Date.parse(now) - Date.parse(task.updatedAt) <= DAY_MS
  );
}

function doneRow(task: TaskRecord): BoardRow {
  return {
    key: `task:${task.id}:${task.stage}`,
    cause: task.stage,
    ...taskIdentity(task),
    mark: "✅",
    name: task.objective,
    text:
      task.stage === "merged" ? "merged" : task.kind === "scout" ? "notes ready in chat" : "done",
  };
}

function taskIdentity(
  task: TaskRecord,
): Readonly<{ repoPath: string; taskId: string; project: string }> {
  return {
    repoPath: task.repoPath,
    taskId: task.id,
    project: basename(task.repoPath),
  };
}

/** A red PR row: it belongs to its task's project, or the checkout it was watched from. */
function pullRequestOwner(
  row: PrWatchViewRow,
  state: BoardState,
): Readonly<{ task?: TaskRecord; repoPath?: string }> {
  const watch = state.watches.find((candidate) => sameRef(candidate.ref, row));
  const task = state.tasks.find((candidate) => candidate.id === watch?.taskId);
  const repoPath = task?.repoPath ?? watch?.repoPath;
  return {
    ...(task === undefined ? {} : { task }),
    ...(repoPath === undefined ? {} : { repoPath }),
  };
}

function pullRequestRow(row: PrWatchViewRow, state: BoardState): BoardRow {
  const { task, repoPath } = pullRequestOwner(row, state);
  const note = row.link === undefined ? row.note : `${row.note} → ${row.link}`;
  return {
    key: `pr:${row.repo}#${row.number}`,
    cause: "pull-request",
    ...(repoPath === undefined ? {} : { repoPath }),
    project:
      repoPath === undefined ? row.repo.slice(row.repo.indexOf("/") + 1) : basename(repoPath),
    ...(task === undefined ? {} : { taskId: task.id }),
    ...(row.url.length === 0 ? {} : { url: row.url }),
    mark: "🔴",
    name: `${row.repo}#${row.number} ${row.branch}`.trimEnd(),
    text: note.length > 0 ? note : row.status,
  };
}

function shorten(text: string, limit: number): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}
