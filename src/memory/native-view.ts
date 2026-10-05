import type { BoardRow } from "../board/view.ts";
import type { CatchUpView, RecentPullRequest } from "./workstream.ts";

export type NativeCatchUpView = Readonly<{
  project: string;
  merged: CatchUpView["recent"];
  needsYou: readonly BoardRow[];
  blocked: readonly Readonly<{ key: string; name: string; reason: string }>[];
  whereWeLeftOff: readonly Readonly<{ workstream: string; text: string }>[];
  workstreams: readonly CatchUpView[];
  actions: readonly ["open-needs-you", "dismiss"];
}>;

/** Clock time or a repaint alone is never a change. Unknown visits require an explicit catch-up. */
export function shouldAutoShowCatchUp(
  input: Readonly<{
    now: string;
    lastOpenedAt?: string;
    previousSignature?: string;
    currentSignature: string;
  }>,
): boolean {
  if (input.lastOpenedAt === undefined || input.previousSignature === undefined) return false;
  const away = Date.parse(input.now) - Date.parse(input.lastOpenedAt);
  return (
    Number.isFinite(away) && away >= 3_600_000 && input.previousSignature !== input.currentSignature
  );
}

export function nativeCatchUpView(
  project: string,
  workstreams: readonly CatchUpView[],
  needsYou: readonly BoardRow[],
  recent: readonly RecentPullRequest[] = [],
): NativeCatchUpView {
  return {
    project,
    merged: [
      ...new Map(
        [...recent, ...workstreams.flatMap((view) => view.recent)]
          .filter((pr) => pr.state === "merged")
          .map((pr) => [pr.url, pr]),
      ).values(),
    ],
    needsYou: needsYou.filter((row) => row.cause !== "blocked"),
    blocked: needsYou
      .filter((row) => row.cause === "blocked")
      .map((row) => ({
        key: row.key,
        name: row.name,
        reason: row.text.replace(/^blocked: /u, ""),
      })),
    whereWeLeftOff: workstreams.flatMap((view) => {
      const text = view.now ?? view.handoff?.text;
      return text === undefined ? [] : [{ workstream: view.name, text }];
    }),
    workstreams,
    actions: ["open-needs-you", "dismiss"],
  };
}
