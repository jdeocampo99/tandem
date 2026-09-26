import {
  type IsoTimestamp,
  type PullRequestMetadata,
  type TaskRecord,
  WORKSTREAM_NAME_PATTERN,
} from "../contracts.ts";
import { isMerged, type PrWatch } from "../pr-watch/store.ts";
import { taskName } from "../tasks/question.ts";

/** The saved sections, in file order. Recent work is never saved; it is built from records. */
export const MEMORY_SECTIONS = ["brief", "now", "follow-ups", "last-handoff", "decisions"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

/** A save that would make the file longer than this is refused until old decisions are merged. */
export const MEMORY_MAX_LINES = 150;
export const MEMORY_MAX_CHARS = 10_000;
/** A catch-up handed to the coordinator stays under this many characters. */
export const CATCH_UP_MAX_CHARS = 10_000;
const RECENT_WORK_MAX_ITEMS = 5;

const SECTION_HEADINGS: Readonly<Record<MemorySection, string>> = {
  brief: "Brief",
  now: "Now",
  "follow-ups": "Follow-ups",
  "last-handoff": "Last handoff",
  decisions: "Decisions",
};

/** One workstream's MEMORY.md. Sections the user added by hand are kept as they are. */
export type WorkstreamMemory = Readonly<{
  readonly name: string;
  readonly sections: Readonly<Partial<Record<MemorySection, string>>>;
  /** Headings the user added themselves, with their text, kept in file order. */
  readonly extra: readonly Readonly<{ heading: string; text: string }>[];
}>;

export type SectionChanges = Readonly<Partial<Record<MemorySection, string>>>;

export type ReplaceResult =
  | Readonly<{ kind: "saved"; memory: WorkstreamMemory; text: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** A follow-up line: `check <what> on <YYYY-MM-DD> because <why>`. */
export type FollowUp = Readonly<{ readonly text: string; readonly due: string }>;

/** The user's name for a workstream, trimmed and lowercased; anything else is refused. */
export function workstreamName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!WORKSTREAM_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `"${value}" is not a workstream name; use up to 40 lowercase letters, digits, and hyphens, like "billing" or "test-impact"`,
    );
  }
  return name;
}

export function emptyMemory(name: string): WorkstreamMemory {
  return { name: workstreamName(name), sections: {}, extra: [] };
}

/** Reads MEMORY.md. Text before the first `## ` heading (the `# name` title) is not kept. */
export function parseMemory(name: string, text: string): WorkstreamMemory {
  const sections: Partial<Record<MemorySection, string>> = {};
  const extra: { heading: string; text: string }[] = [];
  let heading: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (heading === undefined) return;
    const content = body.join("\n").trim();
    const section = sectionFor(heading);
    if (section === undefined) extra.push({ heading, text: content });
    else if (content.length > 0) sections[section] = content;
  };
  for (const line of text.split(/\r?\n/u)) {
    const match = /^##\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      heading = match[1];
      body = [];
    } else if (heading !== undefined) {
      body.push(line);
    }
  }
  flush();
  return { name: workstreamName(name), sections, extra };
}

export function renderMemory(memory: WorkstreamMemory): string {
  const parts = [`# ${memory.name}`];
  for (const section of MEMORY_SECTIONS) {
    const content = memory.sections[section];
    if (content !== undefined) parts.push(`## ${SECTION_HEADINGS[section]}\n\n${content}`);
  }
  for (const { heading, text } of memory.extra) parts.push(`## ${heading}\n\n${text}`.trimEnd());
  return `${parts.join("\n\n")}\n`;
}

/**
 * Replaces the named sections; an empty text removes one. A result over the size cap is refused
 * so the coordinator merges or drops old decisions instead of the file growing without end.
 */
export function replaceSections(memory: WorkstreamMemory, changes: SectionChanges): ReplaceResult {
  const sections: Partial<Record<MemorySection, string>> = { ...memory.sections };
  for (const section of MEMORY_SECTIONS) {
    const content = changes[section];
    if (content === undefined) continue;
    const trimmed = content.trim();
    if (trimmed.length === 0) delete sections[section];
    else sections[section] = trimmed;
  }
  const next = { ...memory, sections };
  const text = renderMemory(next);
  const lines = text.split("\n").length - 1;
  if (lines > MEMORY_MAX_LINES || text.length > MEMORY_MAX_CHARS) {
    return {
      kind: "refused",
      reason: `${memory.name} would be ${lines} lines and ${text.length} characters, over the ${MEMORY_MAX_LINES}-line, ${MEMORY_MAX_CHARS}-character cap. Merge or drop old decisions, then save again.`,
    };
  }
  return { kind: "saved", memory: next, text };
}

export function followUps(memory: WorkstreamMemory): readonly FollowUp[] {
  const found: FollowUp[] = [];
  for (const line of (memory.sections["follow-ups"] ?? "").split("\n")) {
    const text = line.replace(/^\s*[-*•]\s*/u, "").trim();
    const due = /\bon (\d{4}-\d{2}-\d{2})\b/u.exec(text)?.[1];
    if (text.length > 0 && due !== undefined) found.push({ text, due });
  }
  return found;
}

/** Follow-ups due on or before `today` (`YYYY-MM-DD`). */
export function dueFollowUps(memory: WorkstreamMemory, today: string): readonly FollowUp[] {
  return followUps(memory).filter((followUp) => followUp.due <= today);
}

/** The local calendar date of a timestamp, `YYYY-MM-DD`. */
export function calendarDate(timestamp: IsoTimestamp): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type PullRequestState = "merged" | "open" | "draft" | "closed";

/** One of the workstream's pull requests, as task records and PR watch know it right now. */
export type RecentPullRequest = Readonly<{
  readonly number: number;
  readonly title: string;
  readonly state: PullRequestState;
}>;

/** Everything a catch-up shows or hands the coordinator, decided from the notes and records. */
export type CatchUpView = Readonly<{
  readonly name: string;
  /** Where MEMORY.md is, so the user can open it. */
  readonly path: string;
  /** The day the notes were saved, `YYYY-MM-DD`, and how long ago that is in words. */
  readonly savedOn: string;
  readonly age: string;
  readonly today: string;
  readonly due: readonly FollowUp[];
  readonly later: readonly FollowUp[];
  readonly now?: string;
  /** The last handoff without its `Saved` line, and that line's date. */
  readonly handoff?: Readonly<{ readonly date?: string; readonly text: string }>;
  readonly brief?: string;
  readonly decisions?: string;
  readonly extra: WorkstreamMemory["extra"];
  readonly recent: readonly RecentPullRequest[];
}>;

/**
 * The workstream's pull requests, newest first. Built from task records and PR watch every time,
 * so it is never stale and never written to the file.
 */
export function recentWork(
  tasks: readonly TaskRecord[],
  watches: readonly PrWatch[],
  workstream: string,
): readonly RecentPullRequest[] {
  return tasks
    .flatMap((task) =>
      task.workstream === workstream && task.pullRequest !== undefined
        ? [{ task, pullRequest: task.pullRequest }]
        : [],
    )
    .toSorted((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt))
    .slice(0, RECENT_WORK_MAX_ITEMS)
    .map(({ task, pullRequest }) => {
      const watch = watches.find(
        (candidate) =>
          candidate.taskId === task.id ||
          (candidate.ref.repo === pullRequest.repository.toLowerCase() &&
            candidate.ref.number === pullRequest.number),
      );
      return {
        number: pullRequest.number,
        title: pullRequest.title ?? watch?.summary?.title ?? taskName(task.objective),
        state: pullRequestState(task, pullRequest, watch),
      };
    });
}

/** How old the notes are, in words: "today", "yesterday", or "3 days ago". */
export function notesAge(savedAt: IsoTimestamp, now: IsoTimestamp): string {
  const days = Math.round(
    (Date.parse(`${calendarDate(now)}T00:00:00Z`) -
      Date.parse(`${calendarDate(savedAt)}T00:00:00Z`)) /
      86_400_000,
  );
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function catchUpView(
  input: Readonly<{
    memory: WorkstreamMemory;
    path: string;
    savedAt: IsoTimestamp;
    now: IsoTimestamp;
    recent: readonly RecentPullRequest[];
  }>,
): CatchUpView {
  const { memory, savedAt, now } = input;
  const today = calendarDate(now);
  const { brief, now: focus, decisions } = memory.sections;
  const handoff = memory.sections["last-handoff"];
  const date = handoffDate(memory);
  const handoffText = handoff?.replace(/^Saved \d{4}-\d{2}-\d{2}\.?[^\S\n]*\n?/u, "").trim();
  return {
    name: memory.name,
    path: input.path,
    savedOn: calendarDate(savedAt),
    age: notesAge(savedAt, now),
    today,
    due: dueFollowUps(memory, today),
    later: followUps(memory).filter((followUp) => followUp.due > today),
    ...(focus === undefined ? {} : { now: focus }),
    ...(handoffText === undefined || handoffText.length === 0
      ? {}
      : { handoff: { text: handoffText, ...(date === undefined ? {} : { date }) } }),
    ...(brief === undefined ? {} : { brief }),
    ...(decisions === undefined ? {} : { decisions }),
    extra: memory.extra,
    recent: input.recent,
  };
}

/** One line per workstream, for "where was I?" and the coordinator's standing context. */
export function workstreamLine(memory: WorkstreamMemory, now: IsoTimestamp): string {
  const due = dueFollowUps(memory, calendarDate(now)).length;
  return `${memory.name}: ${due === 0 ? "nothing due" : `${due} follow-up${due === 1 ? "" : "s"} due`}`;
}

/** The last handoff's own date from its `Saved YYYY-MM-DD` line, for naming its archive file. */
export function handoffDate(memory: WorkstreamMemory): string | undefined {
  return /^Saved (\d{4}-\d{2}-\d{2})\b/mu.exec(memory.sections["last-handoff"] ?? "")?.[1];
}

/** A new handoff starts with the day it was saved, so its age shows when it is read or archived. */
export function datedHandoff(text: string, now: IsoTimestamp): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /^Saved \d{4}-\d{2}-\d{2}\b/u.test(trimmed)) return trimmed;
  return `Saved ${calendarDate(now)}.\n${trimmed}`;
}

function sectionFor(heading: string): MemorySection | undefined {
  const wanted = heading.trim().toLowerCase();
  return MEMORY_SECTIONS.find((section) => SECTION_HEADINGS[section].toLowerCase() === wanted);
}

function pullRequestState(
  task: TaskRecord,
  pullRequest: PullRequestMetadata,
  watch: PrWatch | undefined,
): PullRequestState {
  if (task.stage === "merged" || pullRequest.state === "merged") return "merged";
  if (watch !== undefined && isMerged(watch)) return "merged";
  if (pullRequest.state === "closed" || watch?.row?.status.startsWith("🚪") === true)
    return "closed";
  return pullRequest.state === "draft" ? "draft" : "open";
}
