import { basename } from "node:path";
import { runChecked } from "../adapters/primitives.ts";
import type { CommandRunner } from "../contracts.ts";

/** The part of a PR a reviewer reads, with the noise set aside. */
export type ReviewDiff = Readonly<{
  from: string;
  to: string;
  files: readonly string[];
  skipped: readonly string[];
  patch: string;
  /** New-side line numbers GitHub accepts an inline comment on, per file. */
  commentable: ReadonlyMap<string, ReadonlySet<number>>;
}>;

/** ponytail: common lockfiles by name; extend when a repo's lockfile slips through. */
const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "Podfile.lock",
  "Package.resolved",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
]);

/**
 * Diffs `from...to` in the worktree. `from` is the merge base for a first review, so changes that
 * landed on the base branch after the PR branched never show up.
 */
export async function readReviewDiff(
  run: CommandRunner,
  worktree: string,
  from: string,
  to: string,
): Promise<ReviewDiff> {
  const names = (
    await runChecked(
      run,
      { argv: ["git", "-C", worktree, "diff", "--name-only", "-z", from, to], cwd: worktree },
      "git diff",
    )
  ).stdout;
  const changed = names.split("\0").filter((name) => name.length > 0);
  const generated = await generatedFiles(run, worktree, changed);
  const files = changed.filter((file) => !LOCKFILES.has(basename(file)) && !generated.has(file));
  const skipped = changed.filter((file) => !files.includes(file));
  const patch =
    files.length === 0
      ? ""
      : (
          await runChecked(
            run,
            {
              argv: [
                "git",
                "-C",
                worktree,
                "diff",
                "--no-ext-diff",
                "--no-color",
                from,
                to,
                "--",
                ...files,
              ],
              cwd: worktree,
            },
            "git diff",
          )
        ).stdout;
  return { from, to, files, skipped, patch, commentable: commentableLines(patch) };
}

/** Files the repository marks `linguist-generated` in `.gitattributes` at the PR head. */
async function generatedFiles(
  run: CommandRunner,
  worktree: string,
  files: readonly string[],
): Promise<ReadonlySet<string>> {
  if (files.length === 0) return new Set();
  const output = (
    await runChecked(
      run,
      {
        argv: ["git", "-C", worktree, "check-attr", "-z", "linguist-generated", "--", ...files],
        cwd: worktree,
      },
      "git check-attr",
    )
  ).stdout;
  const fields = output.split("\0");
  const generated = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [file, , value] = fields.slice(index, index + 3);
    if (file !== undefined && (value === "set" || value === "true")) generated.add(file);
  }
  return generated;
}

/** New-side lines inside each hunk, added or context, which is where GitHub anchors comments. */
export function commentableLines(patch: string): ReadonlyMap<string, ReadonlySet<number>> {
  const lines = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let next = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target === "/dev/null") {
        current = undefined;
      } else {
        current = new Set();
        lines.set(target.replace(/^b\//, ""), current);
      }
    } else if (line.startsWith("@@")) {
      next = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (current !== undefined && next > 0) {
      if (line.startsWith("+") || line.startsWith(" ")) {
        current.add(next);
        next += 1;
      }
    }
  }
  return lines;
}

/**
 * The patch with each line's new-file number in front, so a reviewer reads the exact line to anchor
 * a comment on instead of working it out from hunk headers. Removed lines have no new number.
 */
export function numberedDiff(patch: string): string {
  const out: string[] = [];
  let next = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      out.push(line);
    } else if (line.startsWith("@@")) {
      next = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
      inHunk = true;
      out.push(line);
    } else if (inHunk && (line.startsWith("+") || line.startsWith(" "))) {
      out.push(`${String(next).padStart(6)} ${line}`);
      next += 1;
    } else if (inHunk && line.startsWith("-")) {
      out.push(`${" ".repeat(6)} ${line}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Line numbers as compact ranges, e.g. `10-15, 40`, for telling a reviewer where it can comment. */
export function lineRanges(lines: ReadonlySet<number>): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index] ?? 0;
    let end = start;
    while (sorted[index + 1] === end + 1) {
      end += 1;
      index += 1;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(", ");
}
