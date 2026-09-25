import type { IsoTimestamp } from "../contracts.ts";
import type { PrWatchColor } from "./decide.ts";
import type { PrWatch, PrWatchPoll } from "./store.ts";

/** What `tandem watch`, `tandem status`, and the coordinator show about watched pull requests. */
export type PrWatchView = Readonly<{
  /** When this view was made; the header says how old the data is from here. */
  readonly now: IsoTimestamp;
  readonly polledAt?: IsoTimestamp;
  readonly rateLimitedUntil?: IsoTimestamp;
  readonly rows: readonly PrWatchViewRow[];
}>;

export type PrWatchViewRow = Readonly<{
  readonly repo: string;
  readonly number: number;
  readonly branch: string;
  readonly url: string;
  readonly color: PrWatchColor;
  /** Like `✅ 16/16`: passed checks out of all of them, marked by the worst. */
  readonly checks: string;
  readonly status: string;
  readonly note: string;
  readonly link?: string;
}>;

const COLOR_MARKS: Readonly<Record<PrWatchColor, string>> = {
  red: "🔴",
  yellow: "🟡",
  green: "🟢",
  done: "⚪",
};
const COLOR_ORDER: readonly PrWatchColor[] = ["red", "yellow", "green", "done"];

/**
 * The rows worth showing: every watch still running, and ones that merged or closed today. Rows
 * that need the user come first.
 */
export function prWatchView(
  watches: readonly PrWatch[],
  poll: PrWatchPoll,
  now: IsoTimestamp,
): PrWatchView {
  const rows = watches
    .filter((watch) => watch.stoppedAt === undefined)
    .filter((watch) => watch.finishedAt === undefined || sameDay(watch.finishedAt, now))
    .map(viewRow)
    .toSorted(
      (left, right) =>
        COLOR_ORDER.indexOf(left.color) - COLOR_ORDER.indexOf(right.color) ||
        left.repo.localeCompare(right.repo) ||
        left.number - right.number,
    );
  return {
    now,
    ...(poll.polledAt === undefined ? {} : { polledAt: poll.polledAt }),
    ...(poll.rateLimitedUntil === undefined || poll.rateLimitedUntil <= now
      ? {}
      : { rateLimitedUntil: poll.rateLimitedUntil }),
    rows,
  };
}

export function renderPrWatchView(view: PrWatchView): string {
  const open = view.rows.filter((row) => row.color !== "done").length;
  const header = [
    "PR watch",
    `${open} open`,
    view.polledAt === undefined ? "not checked yet" : `checked ${ago(view.polledAt, view.now)}`,
    ...(view.rateLimitedUntil === undefined
      ? []
      : [`GitHub rate limit, next check after ${clockTime(view.rateLimitedUntil)}`]),
  ].join(" · ");
  if (view.rows.length === 0) return `${header}\n\nNo pull requests are watched.\n`;
  const repos = new Set(view.rows.map((row) => row.repo));
  const names = view.rows.map((row) =>
    repos.size > 1 ? `${row.repo}#${row.number}` : `#${row.number}`,
  );
  const width = (values: readonly string[]) =>
    Math.max(...values.map((value) => [...value].length));
  const nameWidth = width(names);
  const branchWidth = width(view.rows.map((row) => row.branch));
  const checksWidth = width(view.rows.map((row) => row.checks));
  const statusWidth = width(view.rows.map((row) => row.status));
  const lines = view.rows.map((row, index) =>
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
  return `${header}\n\n${lines.join("\n")}\n`;
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

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - [...value].length));
}

function ago(from: IsoTimestamp, to: IsoTimestamp): string {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Hours and minutes in local time, like 11:02. */
export function clockTime(timestamp: IsoTimestamp): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sameDay(left: IsoTimestamp, right: IsoTimestamp): boolean {
  return new Date(left).toDateString() === new Date(right).toDateString();
}
