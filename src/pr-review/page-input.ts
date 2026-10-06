import type { CommandRunner } from "../contracts.ts";
import type { ReviewPageInput } from "./page.ts";
import { reviewPostNotes } from "./render.ts";
import type { PrReviewRound, PrReviewState } from "./state.ts";

export type PageSources = ReviewPageInput["sources"];

/** One file section of a unified diff; a side is absent when the file does not exist there. */
type PatchFile = Readonly<{ oldPath?: string; newPath?: string }>;

/** The page's one input, from the round and the diff it reviewed. */
export function reviewPageInput(
  state: PrReviewState,
  round: PrReviewRound,
  patch: string,
  sources: PageSources,
): ReviewPageInput {
  const { review } = round;
  return {
    pr: {
      repo: state.ref.repo,
      number: state.ref.number,
      title: state.title,
      url: state.url,
      author: state.author,
      baseRef: state.baseRef,
      head: round.head,
    },
    intent: review.intent,
    ...(review.verdict === undefined ? {} : { verdict: review.verdict }),
    summaryComment: review.summaryComment,
    chapters: review.tour,
    drafts: review.comments,
    concerns: review.concerns,
    notes: reviewPostNotes(state.url, round),
    patch,
    sources,
  };
}

/**
 * Each changed file's full text at the reviewed head and at the diff's start, read from the user's
 * checkout, which holds both commits because the run fetched them into `refs/tandem/pr-review`.
 * A file missing on one side (added, deleted, or unreadable) leaves that side out.
 */
export async function readPageSources(
  run: CommandRunner,
  checkout: string,
  round: Pick<PrReviewRound, "head" | "from">,
  patch: string,
): Promise<PageSources> {
  const sources: Record<string, { head?: string; base?: string }> = {};
  for (const file of patchFiles(patch)) {
    const key = file.newPath ?? file.oldPath;
    if (key === undefined) continue;
    const head =
      file.newPath === undefined ? undefined : await show(run, checkout, round.head, file.newPath);
    const base =
      file.oldPath === undefined ? undefined : await show(run, checkout, round.from, file.oldPath);
    sources[key] = {
      ...(head === undefined ? {} : { head }),
      ...(base === undefined ? {} : { base }),
    };
  }
  return sources;
}

/**
 * The old and new path of each file in a unified diff, from the `---` and `+++` lines of its header.
 * Inside a hunk, a removed `-- x` line also starts with `---`, so only headers are read.
 */
export function patchFiles(patch: string): readonly PatchFile[] {
  const files: PatchFile[] = [];
  let oldPath: string | undefined;
  let inHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
    } else if (line.startsWith("@@")) {
      inHeader = false;
    } else if (inHeader && line.startsWith("--- ")) {
      oldPath = sidePath(line.slice(4), "a/");
    } else if (inHeader && line.startsWith("+++ ")) {
      const newPath = sidePath(line.slice(4), "b/");
      files.push({
        ...(oldPath === undefined ? {} : { oldPath }),
        ...(newPath === undefined ? {} : { newPath }),
      });
      oldPath = undefined;
    }
  }
  return files;
}

function sidePath(target: string, prefix: string): string | undefined {
  if (target === "/dev/null") return undefined;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

async function show(
  run: CommandRunner,
  checkout: string,
  sha: string,
  path: string,
): Promise<string | undefined> {
  const result = await run({
    argv: ["git", "-C", checkout, "show", `${sha}:${path}`],
    cwd: checkout,
  });
  return result.code === 0 ? result.stdout : undefined;
}
