import { basename } from "node:path";
import type { IsoTimestamp, RequestBriefRecord, TaskRecord, TaskStage } from "../contracts.ts";
import { type PrWatch, type PrWatchPoll, sameRef } from "../pr-watch/store.ts";
import { elapsed, type PrWatchViewRow, pad, prWatchLines, prWatchView } from "../pr-watch/view.ts";
import { requestApprovalState } from "../requests/brief.ts";
import { isTerminalTask } from "../service/records.ts";

/** Task stages that wait on the user. */
export const NEEDS_YOU_STAGES: readonly TaskStage[] = [
  "awaiting-approval",
  "blocked",
  "paused",
  "ready",
];
/** Task stages where Tandem is working on its own. */
export const RUNNING_STAGES: readonly TaskStage[] = [
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
}>;

export type BoardRow = Readonly<{
  /** Stays the same while the row stands for the same thing, so a new arrival can be noticed. */
  readonly key: string;
  /** The project the row belongs to; absent for a pull request no project claims. */
  readonly repoPath?: string;
  readonly project: string;
  readonly mark: string;
  readonly name: string;
  readonly text: string;
}>;

const NAME_CHARS = 30;
const TEXT_CHARS = 80;

const RUNNING_LABELS: Readonly<Record<string, Readonly<{ mark: string; label: string }>>> = {
  queued: { mark: "⏳", label: "waiting to start" },
  scouting: { mark: "🔍", label: "researching" },
  implementing: { mark: "🔨", label: "implementing" },
  validating: { mark: "🧪", label: "checking" },
  reviewing: { mark: "👀", label: "in review" },
  "awaiting-fixes": { mark: "🔨", label: "fixing review findings" },
};

const NEEDS_YOU_LABELS: Readonly<Record<string, string>> = {
  "awaiting-approval": "waiting for approval",
  paused: "paused",
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
  };
}

export function renderBoard(view: BoardView): string {
  const header = [
    "Tandem",
    ...(view.projects.length === 0 ? [] : [view.projects.join(", ")]),
    view.checkedAt === undefined
      ? "PRs not checked yet"
      : `checked ${elapsed(view.checkedAt, view.now)} ago`,
  ].join(" · ");
  const rows = [...view.needsYou, ...view.running];
  const width = (values: readonly string[]) =>
    Math.max(0, ...values.map((value) => [...value].length));
  const projectWidth = width(rows.map((row) => row.project));
  const nameWidth = width(rows.map((row) => row.name));
  const line = (row: BoardRow) =>
    [row.mark, pad(row.project, projectWidth), pad(row.name, nameWidth), row.text]
      .join(" ")
      .trimEnd();
  const sections = [
    ["Needs you", ...(view.needsYou.length === 0 ? ["Nothing needs you."] : [])]
      .concat(view.needsYou.map(line))
      .join("\n"),
    ...(view.running.length === 0 ? [] : [["Running", ...view.running.map(line)].join("\n")]),
    ...(view.pullRequests.length === 0
      ? []
      : [["PRs", ...prWatchLines(view.pullRequests, true)].join("\n")]),
  ];
  return `${[header, ...sections].join("\n\n")}\n`;
}

function needsYou(task: TaskRecord): boolean {
  return task.communication?.question !== undefined || NEEDS_YOU_STAGES.includes(task.stage);
}

/** A brief whose current draft nobody approved: new, or changed after approval. */
function awaitsApproval(brief: RequestBriefRecord): boolean {
  return requestApprovalState(brief) !== "current";
}

function briefRow(brief: RequestBriefRecord): BoardRow {
  return {
    key: `brief:${brief.id}`,
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
      ? `asks: ${question.text}`
      : task.stage === "blocked"
        ? `blocked: ${task.blockReason ?? "no reason recorded"}`
        : (NEEDS_YOU_LABELS[task.stage] ?? task.stage);
  return {
    key: question === undefined ? `task:${task.id}:${task.stage}` : `question:${question.id}`,
    ...taskIdentity(task),
    mark: "🙋",
    text: shorten(text, TEXT_CHARS),
  };
}

function runningRow(task: TaskRecord, now: IsoTimestamp): BoardRow {
  const { mark, label } = RUNNING_LABELS[task.stage] ?? { mark: "🔨", label: task.stage };
  return {
    key: `task:${task.id}:${task.stage}`,
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
    ...(repoPath === undefined ? {} : { repoPath }),
    project: row.repo.slice(row.repo.indexOf("/") + 1),
    mark: "🙋",
    name: shorten(`#${row.number} ${row.branch}`, NAME_CHARS),
    text: [row.status, note].filter((part) => part.length > 0).join(" "),
  };
}

function shorten(text: string, limit: number): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}
