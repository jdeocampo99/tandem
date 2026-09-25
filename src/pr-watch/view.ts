import type { IsoTimestamp } from "../contracts.ts";
import type { PrWatchColor } from "./decide.ts";
import type { AuthoredPullRequest } from "./github.ts";
import { type PrWatch, type PrWatchPoll, sameRef } from "./store.ts";

/** What `tandem watch`, `tandem status`, and the coordinator show about watched pull requests. */
export type PrWatchView = Readonly<{
  /** When this view was made; the header says how old the data is from here. */
  readonly now: IsoTimestamp;
  /** When GitHub was last read. */
  readonly readAt?: IsoTimestamp;
  readonly rateLimitedUntil?: IsoTimestamp;
  readonly rows: readonly PrWatchViewRow[];
}>;

export type PrWatchViewRow = Readonly<{
  readonly repo: string;
  readonly number: number;
  readonly branch: string;
  readonly url: string;
  /** `unwatched` is one of the user's pull requests the watcher leaves alone. */
  readonly color: PrWatchColor | "unwatched";
  /** Like `✅ 16/16`: passed checks out of all of them, marked by the worst. */
  readonly checks: string;
  readonly status: string;
  readonly note: string;
  readonly link?: string;
}>;

const COLOR_MARKS: Readonly<Record<PrWatchViewRow["color"], string>> = {
  red: "🔴",
  yellow: "🟡",
  green: "🟢",
  done: "⚪",
  unwatched: "⚪",
};
const COLOR_ORDER: readonly PrWatchViewRow["color"][] = [
  "red",
  "yellow",
  "green",
  "done",
  "unwatched",
];
const TITLE_CHARS = 30;

/**
 * The rows worth showing: every watch still running, ones that merged or closed today, then the
 * user's other open pull requests, which the watcher leaves alone. Rows that need the user come
 * first.
 */
export function prWatchView(
  watches: readonly PrWatch[],
  poll: PrWatchPoll,
  now: IsoTimestamp,
  authored: readonly AuthoredPullRequest[],
): PrWatchView {
  const watched = watches
    .filter((watch) => watch.stoppedAt === undefined)
    .filter((watch) => watch.finishedAt === undefined || sameDay(watch.finishedAt, now));
  const unwatched = authored
    .filter((mine) => !watched.some((watch) => sameRef(watch.ref, mine.ref)))
    .map(unwatchedRow);
  const rows = [...watched.map(viewRow), ...unwatched].toSorted(
    (left, right) =>
      COLOR_ORDER.indexOf(left.color) - COLOR_ORDER.indexOf(right.color) ||
      left.repo.localeCompare(right.repo) ||
      left.number - right.number,
  );
  return {
    now,
    ...(poll.readAt === undefined ? {} : { readAt: poll.readAt }),
    ...(poll.rateLimitedUntil === undefined || poll.rateLimitedUntil <= now
      ? {}
      : { rateLimitedUntil: poll.rateLimitedUntil }),
    rows,
  };
}

export function renderPrWatchView(view: PrWatchView): string {
  const open = view.rows.filter((row) => row.color !== "done" && row.color !== "unwatched").length;
  const header = [
    "PR watch",
    `${open} open`,
    view.readAt === undefined ? "not checked yet" : `checked ${ago(view.readAt, view.now)}`,
    ...(view.rateLimitedUntil === undefined
      ? []
      : [`GitHub rate limit, next check after ${clockTime(view.rateLimitedUntil)}`]),
  ].join(" · ");
  if (view.rows.length === 0) return `${header}\n\nNo pull requests are watched.\n`;
  const repos = new Set(view.rows.map((row) => row.repo));
  return `${header}\n\n${prWatchLines(view.rows, repos.size > 1).join("\n")}\n`;
}

/** One aligned line per row; `nameRepo` names each pull request `owner/repo#N` instead of `#N`. */
export function prWatchLines(rows: readonly PrWatchViewRow[], nameRepo: boolean): string[] {
  const names = rows.map((row) => (nameRepo ? `${row.repo}#${row.number}` : `#${row.number}`));
  const width = (values: readonly string[]) =>
    Math.max(...values.map((value) => [...value].length));
  const nameWidth = width(names);
  const branchWidth = width(rows.map((row) => row.branch));
  const checksWidth = width(rows.map((row) => row.checks));
  const statusWidth = width(rows.map((row) => row.status));
  return rows.map((row, index) =>
    [
      COLOR_MARKS[row.color],
      pad(names[index] ?? "", nameWidth),
      pad(row.branch, branchWidth),
      pad(row.checks, checksWidth),
      pad(row.status, statusWidth),
      row.link === undefined ? row.note : `${row.note} → ${row.link}`,
    ]
      .join(" ")
      .trimEnd(),
  );
}

function unwatchedRow(mine: AuthoredPullRequest): PrWatchViewRow {
  const title =
    mine.title.length <= TITLE_CHARS ? mine.title : `${mine.title.slice(0, TITLE_CHARS - 1)}…`;
  return {
    repo: mine.ref.repo,
    number: mine.ref.number,
    branch: title,
    url: mine.url,
    color: "unwatched",
    checks: "",
    status: mine.draft ? "📝 draft" : "🟢 open",
    note: `not watched; "watch #${mine.ref.number}" hands it over`,
  };
}

function viewRow(watch: PrWatch): PrWatchViewRow {
  const row = watch.row ?? { color: "green" as const, status: "⏳ not checked yet", note: "" };
  return {
    repo: watch.ref.repo,
    number: watch.ref.number,
    branch: watch.summary?.branch ?? "",
    url: watch.summary?.url ?? "",
    color: row.color,
    checks: checksColumn(watch),
    status: row.status,
    note: row.note,
    ...(row.link === undefined ? {} : { link: row.link }),
  };
}

function checksColumn(watch: PrWatch): string {
  if (watch.row?.status.startsWith("⚠") === true) return "⚠";
  const checks = watch.summary?.checks;
  if (checks === undefined) return "";
  const total = checks.passed + checks.failed + checks.pending;
  if (watch.row?.color === "done") return total === 0 ? "" : "✅";
  if (total === 0) return "no CI";
  const mark = checks.failed > 0 ? "❌" : checks.pending > 0 ? "⏳" : "✅";
  return `${mark} ${checks.passed}/${total}`;
}

export function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - [...value].length));
}

function ago(from: IsoTimestamp, to: IsoTimestamp): string {
  return `${elapsed(from, to)} ago`;
}

/** How long from one time to another, in its largest whole unit: 5s, 12m, 3h, 2d. */
export function elapsed(from: IsoTimestamp, to: IsoTimestamp): string {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Hours and minutes in local time, like 11:02. */
export function clockTime(timestamp: IsoTimestamp): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sameDay(left: IsoTimestamp, right: IsoTimestamp): boolean {
  return new Date(left).toDateString() === new Date(right).toDateString();
}
