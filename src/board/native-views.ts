import { createHash } from "node:crypto";
import type { PullRequestMetadata } from "../contracts.ts";
import type { NativeCatchUpView } from "../memory/native-view.ts";
import type { PrPaneView } from "../pr-review/native-view.ts";
import type { BriefView } from "../requests/native-view.ts";
import type { UsageView } from "../runtime/usage-view.ts";
import type { TaskPageView } from "../tasks/page-view.ts";
import type { NativeBoardView } from "./native.ts";
import type { NativePanelView, NativeProjectRow } from "./panel.ts";

/** One coordinator owns one project's bundle. It is a derived projection, never authority. */
export type NativeViews = Readonly<{
  version: 1;
  project: string;
  writtenAt: string;
  /** Changes in content, excluding elapsed times and provider counters, for automatic catch-up. */
  changeSignature: string;
  panel: NativePanelView;
  projects: readonly NativeProjectRow[];
  tasks: Readonly<Record<string, TaskPageView>>;
  briefs: Readonly<Record<string, BriefView>>;
  pullRequests: Readonly<Record<string, PrPaneView>>;
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
