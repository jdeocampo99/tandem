import type { IsoTimestamp } from "../contracts.ts";
import type { PrWatch } from "../pr-watch/store.ts";
import type { ChapterInput, TourStopInput } from "./page.ts";
import { type DiffRow, parsePatch } from "./patch.ts";
import type { DraftComment, ReviewConcern } from "./review.ts";

export type PrComment = Readonly<{
  id: string;
  author: string;
  at: IsoTimestamp;
  body: string;
  url?: string;
}>;
export type PrThread = Readonly<{
  id: string;
  file: string;
  line?: number;
  side: "LEFT" | "RIGHT";
  resolved: boolean;
  outdated: boolean;
  comments: readonly PrComment[];
}>;
export type PrCheck = Readonly<{
  name: string;
  state: "passed" | "running" | "failed" | "pending";
  startedAt?: IsoTimestamp;
  completedAt?: IsoTimestamp;
  logUrl?: string;
}>;
/** Tandem caches this data; renderers never fetch GitHub. Every diff/thread belongs to this head. */
export type CachedPullRequest = Readonly<{
  repo: string;
  number: number;
  title: string;
  url: string;
  head: string;
  draft: boolean;
  body: string;
  commits: number;
  additions: number;
  deletions: number;
  readAt: IsoTimestamp;
  checks: readonly PrCheck[];
  threads: readonly PrThread[];
  conversation: readonly PrComment[];
  patch: string;
  tour: readonly ChapterInput[];
}>;
export type PrDiffRow = Readonly<{
  id: string;
  row: DiffRow;
  threads: readonly PrThread[];
  drafts: readonly DraftComment[];
}>;
export type PrPaneView = Readonly<{
  header: Readonly<{
    repo: string;
    number: number;
    title: string;
    url: string;
    head: string;
    draft: boolean;
    next: string;
    taskId?: string;
    commits: number;
    additions: number;
    deletions: number;
    unresolved: number;
    firstThreadId?: string;
  }>;
  readAt: IsoTimestamp;
  tabs: readonly string[];
  checks: readonly (PrCheck & Readonly<{ duration?: string; startedAtMs?: number }>)[];
  description: Readonly<{
    markdown: string;
    blocks: readonly string[];
    conversation: readonly PrComment[];
  }>;
  tour: readonly Readonly<{
    title: string;
    why: string;
    stops: readonly (TourStopInput & Readonly<{ rowIds: readonly string[] }>)[];
  }>[];
  files: readonly Readonly<{
    path: string;
    additions: number;
    deletions: number;
    commentCount: number;
    rows: readonly PrDiffRow[];
  }>[];
  /** Outdated, deleted-file, or non-hunk threads remain readable instead of silently disappearing. */
  unanchoredThreads: readonly PrThread[];
  commentDestination: "worker" | "review";
  review?: Readonly<{
    taskId: string;
    generation: number;
    head: string;
    currentHead: string;
    posted: boolean;
    verdict?: string;
    intent: string;
    summary: string;
    drafts: readonly DraftComment[];
    concerns: readonly ReviewConcern[];
    notes: readonly string[];
  }>;
}>;

export function prPaneView(
  input: Readonly<{
    cached: CachedPullRequest;
    watch?: PrWatch;
    review?: PrPaneView["review"];
    taskId?: string;
  }>,
): PrPaneView {
  const { cached, watch } = input;
  const taskId = input.taskId ?? input.review?.taskId ?? watch?.taskId;
  if (watch !== undefined && (watch.ref.repo !== cached.repo || watch.ref.number !== cached.number))
    throw new TypeError("PR watch must match cached PR");
  const files = parsePatch(cached.patch).map((file) => ({
    path: file.path,
    additions: file.adds,
    deletions: file.dels,
    commentCount: cached.threads.filter((thread) => thread.file === file.path).length,
    rows: file.rows.map((row, index) => ({
      id: `${file.path}:${index}`,
      row,
      drafts:
        input.review?.drafts.filter(
          (draft) =>
            draft.file === file.path &&
            row.kind !== "hunk" &&
            row.kind !== "del" &&
            row.new === draft.line,
        ) ?? [],
      threads: cached.threads.filter((thread) => {
        if (
          thread.file !== file.path ||
          thread.outdated ||
          row.kind === "hunk" ||
          thread.line === undefined
        )
          return false;
        return thread.side === "LEFT"
          ? row.kind !== "add" && row.old === thread.line
          : row.kind !== "del" && row.new === thread.line;
      }),
    })),
  }));
  const anchored = new Set(
    files.flatMap((file) => file.rows.flatMap((row) => row.threads.map((thread) => thread.id))),
  );
  const unresolved = cached.threads.filter((thread) => !thread.resolved);
  return {
    header: {
      repo: cached.repo,
      number: cached.number,
      title: cached.title,
      url: cached.url,
      head: cached.head,
      draft: cached.draft,
      next:
        (input.review === undefined
          ? undefined
          : input.review.posted
            ? "You posted this review"
            : input.review.head !== input.review.currentHead
              ? "The PR changed. Re-review before posting"
              : "Waiting on you: choose comments and post your review") ||
        watch?.row?.note ||
        (cached.draft ? "Waiting on you: publish it (draft → ready)" : "Waiting for PR watch"),
      ...(taskId === undefined ? {} : { taskId }),
      commits: cached.commits,
      additions: cached.additions,
      deletions: cached.deletions,
      unresolved: unresolved.length,
      ...(unresolved[0] === undefined ? {} : { firstThreadId: unresolved[0].id }),
    },
    readAt: cached.readAt,
    tabs: ["Description", ...(cached.tour.length === 0 ? [] : ["Tour"]), "Diff"],
    checks: cached.checks.map(presentCheck),
    description: {
      markdown: cached.body,
      blocks: prMarkdownBlocks(cached.body),
      conversation: cached.conversation,
    },
    files,
    unanchoredThreads: cached.threads.filter((thread) => !anchored.has(thread.id)),
    tour: cached.tour.map((chapter) => ({
      ...chapter,
      stops: chapter.stops.map((stop) => ({
        ...stop,
        rowIds:
          files
            .find((file) => file.path === stop.file)
            ?.rows.filter(
              ({ row }) =>
                row.kind !== "hunk" &&
                row.kind !== "del" &&
                row.new >= stop.from &&
                row.new <= stop.to,
            )
            .map((row) => row.id) ?? [],
      })),
    })),
    commentDestination: input.review === undefined ? "worker" : "review",
    ...(input.review === undefined ? {} : { review: input.review }),
  };
}

/** Keep fenced code together, including blank lines, when drawing one Markdown node per block. */
export function prMarkdownBlocks(markdown: string): readonly string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  const flush = () => {
    if (lines.length > 0) blocks.push(lines.join("\n"));
    lines = [];
  };
  for (const line of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== undefined) {
      lines.push(line);
      if (
        marker?.[1]?.[0] === fence.marker &&
        marker[1].length >= fence.length &&
        marker[2]?.trim() === ""
      ) {
        fence = undefined;
        flush();
      }
    } else if (marker?.[1] !== undefined) {
      flush();
      fence = { marker: marker[1][0] ?? "`", length: marker[1].length };
      lines.push(line);
    } else if (line.trim() === "") flush();
    else if (/^ {0,3}#{1,6}\s/u.test(line)) {
      flush();
      blocks.push(line);
    } else lines.push(line);
  }
  flush();
  return blocks;
}

function presentCheck(check: PrCheck): PrPaneView["checks"][number] {
  const start = Date.parse(check.startedAt ?? "");
  const end = Date.parse(check.completedAt ?? "");
  if (check.state === "running" && Number.isFinite(start)) return { ...check, startedAtMs: start };
  if (check.state === "passed" && Number.isFinite(start) && Number.isFinite(end)) {
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    return {
      ...check,
      duration: seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
    };
  }
  return check;
}
