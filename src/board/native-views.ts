import { createHash } from "node:crypto";
import type { PullRequestMetadata } from "../contracts.ts";
import type { NativeCatchUpView } from "../memory/native-view.ts";
import type { PrPaneView } from "../pr-review/native-view.ts";
import type { BriefView } from "../requests/native-view.ts";
import type { UsageView } from "../runtime/usage-view.ts";
import type { TaskPageView } from "../tasks/page-view.ts";
import type { NativeBoardView } from "./native.ts";
import type { NativePanelView, NativeProjectRow, NativeTaskSummary } from "./panel.ts";

export type NativeProjectSummary = Readonly<{
  repoPath: string;
  name: string;
  writtenAt: string;
  running: number;
  needsYou: number;
  ready: number;
  done: number;
  sessionId?: string;
}>;
export type NativeTaskIndex = NativeTaskSummary & Readonly<{ detailFile: string }>;
export type NativeBriefIndex = Pick<
  BriefView,
  "requestId" | "title" | "revision" | "changes" | "approvalState" | "abandoned" | "commentCount"
> &
  Readonly<{ detailFile: string }>;
export type NativePrIndex = Readonly<{
  header: PrPaneView["header"];
  readAt: string;
  detailFile: string;
}>;
export type NativeDetail =
  | Readonly<{ version: 1; project: string; kind: "task"; data: TaskPageView }>
  | Readonly<{ version: 1; project: string; kind: "brief"; data: BriefView }>
  | Readonly<{ version: 1; project: string; kind: "pr"; data: PrPaneView }>;
export type NativeViewsPublication = Readonly<{
  bundle: NativeViews;
  details: readonly Readonly<{ file: string; view: NativeDetail }>[];
}>;

/** Relative to the project's detail directory. Encoding keeps opaque ids in one path segment. */
export function nativeTaskFile(id: string): string {
  return `task-${encodeURIComponent(id)}.json`;
}
export function nativeBriefFile(id: string): string {
  return `brief-${encodeURIComponent(id)}.json`;
}
export function nativePrFile(repo: string, number: number): string {
  return `pr-${encodeURIComponent(repo)}-${number}.json`;
}

/** Only published project summaries supply other projects' counts and session identities. */
export function nativeSummaryProjects(
  summaries: readonly NativeProjectSummary[],
  project: string,
  now: string,
): readonly NativeProjectRow[] {
  return summaries
    .toSorted((a, b) => a.repoPath.localeCompare(b.repoPath))
    .map((summary, index) => {
      const age = Date.parse(now) - Date.parse(summary.writtenAt);
      const offline = !Number.isFinite(age) || age < 0 || age > 10_000;
      return {
        repoPath: summary.repoPath,
        name: summary.name,
        current: summary.repoPath === project,
        offline,
        running: summary.running,
        needsYou: summary.needsYou,
        status: offline
          ? "offline"
          : summary.running === 0 && summary.needsYou === 0
            ? "all quiet"
            : `${summary.running} running · ${summary.needsYou} needs you`,
        ...(index >= 9 ? {} : { shortcut: `⌘${index + 1}` }),
        ...(offline || summary.sessionId === undefined ? {} : { sessionId: summary.sessionId }),
      };
    });
}

/** One coordinator owns one project's bundle. It is a derived projection, never authority. */
export type NativeViews = Readonly<{
  version: 1;
  project: string;
  writtenAt: string;
  summary: NativeProjectSummary;
  /** Changes in content, excluding elapsed times and provider counters, for automatic catch-up. */
  changeSignature: string;
  panel: NativePanelView;
  projects: readonly NativeProjectRow[];
  tasks: Readonly<Record<string, NativeTaskIndex>>;
  briefs: Readonly<Record<string, NativeBriefIndex>>;
  pullRequests: Readonly<Record<string, NativePrIndex>>;
  board: NativeBoardView;
  usage: UsageView;
  catchup: NativeCatchUpView;
  warnings: readonly string[];
}>;

export function nativeChangeSignature(
  input: Readonly<{
    tasks: readonly Readonly<{
      id: string;
      stage: string;
      generation: number;
      reviewRound: number;
      blockReason?: string;
      pullRequest?: PullRequestMetadata;
      questionId?: string;
    }>[];
    briefs: readonly Readonly<{
      id: string;
      revision: number;
      contentDigest: string;
      approvalState: string;
    }>[];
    workstreams: readonly Readonly<{ name: string; savedAt: string }>[];
    pullRequests: readonly Readonly<{
      key: string;
      head?: string;
      status?: string;
      note?: string;
    }>[];
  }>,
): string {
  const sorted = {
    tasks: input.tasks.toSorted((a, b) => a.id.localeCompare(b.id)),
    briefs: input.briefs.toSorted((a, b) => a.id.localeCompare(b.id)),
    workstreams: input.workstreams.toSorted((a, b) => a.name.localeCompare(b.name)),
    pullRequests: input.pullRequests.toSorted((a, b) => a.key.localeCompare(b.key)),
  };
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
