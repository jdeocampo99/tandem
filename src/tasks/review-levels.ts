import type { ReviewLevelRecord, TaskRecord } from "../contracts.ts";

/** The most a change may touch and still be reviewed light. */
export const LIGHT_REVIEW_LIMITS = {
  maxChangedFiles: 5,
  maxChangedLines: 200,
} as const;

/** Dependency manifests and lockfiles, build config, CI and infrastructure, and migrations. */
const SENSITIVE_PATHS: readonly RegExp[] = [
  /(^|\/)(package\.json|package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|Dockerfile|Makefile|tsconfig(\.[\w-]+)?\.json|biome\.json|\.npmrc)$/u,
  /(^|\/)(\.github|\.circleci|\.gitlab-ci\.yml|infra|deploy|terraform|helm|k8s)(\/|$)/u,
  /(^|\/)migrations?(\/|$)/u,
];

/**
 * The level a task is reviewed at. A record written before review levels existed carries none, so
 * it reads as `standard`.
 */
export function recordedReviewLevel(task: TaskRecord): ReviewLevelRecord {
  return (
    task.reviewLevel ?? {
      level: "standard",
      reason: "no review level is recorded for this task",
    }
  );
}

/**
 * Classifies the task's cumulative diff at the reviewed HEAD, fresh every round. A change is light
 * when it touches at most 5 files and 200 changed lines and no sensitive path; a larger, sensitive,
 * or truncated diff is standard.
 */
export function classifyReviewLevel(
  diff: Readonly<{
    readonly changedFiles: readonly string[];
    readonly patch: string;
    readonly truncated: boolean;
  }>,
): ReviewLevelRecord {
  const files = diff.changedFiles.length;
  const lines = changedLineCount(diff.patch);
  const sensitive = diff.changedFiles.filter((path) =>
    SENSITIVE_PATHS.some((pattern) => pattern.test(path)),
  );
  const reason = diff.truncated
    ? "the diff was too large to read in full"
    : sensitive.length > 0
      ? `it changes ${sensitive.join(", ")}`
      : files > LIGHT_REVIEW_LIMITS.maxChangedFiles
        ? `${files} changed files exceed ${LIGHT_REVIEW_LIMITS.maxChangedFiles}`
        : lines > LIGHT_REVIEW_LIMITS.maxChangedLines
          ? `${lines} changed lines exceed ${LIGHT_REVIEW_LIMITS.maxChangedLines}`
          : undefined;
  return reason === undefined
    ? {
        level: "light",
        reason: `${files} changed file(s) and ${lines} changed line(s), so only P0 findings block`,
      }
    : { level: "standard", reason: `${reason}, so P0 and P1 findings block` };
}

/** Added plus removed lines inside the patch's hunks. */
function changedLineCount(patch: string): number {
  let inHunk = false;
  let count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) count += 1;
  }
  return count;
}
