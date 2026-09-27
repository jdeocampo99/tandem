import { readDiffRange, readReferencingFiles } from "../adapters/git.ts";
import type { CommandRunner, TaskRecord } from "../contracts.ts";
import {
  type DiffRange,
  lastReviewedHead,
  REVIEW_BRIEF_LIMITS,
  type ReviewBriefDiffReference,
  type ReviewBriefObservations,
} from "../tasks/review-brief.ts";

/** One observed diff range, before a caller has chosen where its patch will be written. */
type ReviewDiffFact = Readonly<{
  readonly range: DiffRange;
  readonly fromRef: string;
  readonly toRef: string;
  readonly changedFiles: readonly string[];
  readonly truncated: boolean;
  readonly patch: string;
}>;

/** The git facts one review round is classified and briefed from. */
export type ReviewDiffFacts = Readonly<{
  readonly cumulative: ReviewDiffFact;
  readonly sinceLastReview?: ReviewDiffFact;
  readonly affectedCallers: readonly string[];
}>;

function diffReference(fact: ReviewDiffFact, patchPath: string): ReviewBriefDiffReference {
  return {
    range: fact.range,
    fromRef: fact.fromRef,
    toRef: fact.toRef,
    patchPath,
    changedFiles: fact.changedFiles,
    truncated: fact.truncated,
  };
}

/** Names where each observed patch was written, which is all the brief adds to the raw facts. */
export function reviewBriefObservations(
  facts: ReviewDiffFacts,
  paths: Readonly<{
    readonly cumulativePatchPath: string;
    readonly incrementalPatchPath: string;
  }>,
): ReviewBriefObservations {
  return {
    cumulative: diffReference(facts.cumulative, paths.cumulativePatchPath),
    ...(facts.sinceLastReview === undefined
      ? {}
      : {
          sinceLastReview: diffReference(facts.sinceLastReview, paths.incrementalPatchPath),
        }),
    affectedCallers: facts.affectedCallers,
  };
}

/**
 * Reads the git facts both the review-level classifier and the review brief need: the cumulative
 * range from the worktree base, the range since the last reviewed HEAD, and the files at HEAD
 * that reference a changed file. The patches are returned with the facts because neither caller
 * has chosen where they will be written yet.
 */
export async function readReviewDiffFacts(
  run: CommandRunner,
  input: Readonly<{
    readonly task: TaskRecord;
    readonly head: string;
    readonly repo: string;
    readonly baseHead: string;
  }>,
): Promise<ReviewDiffFacts> {
  const maxBytes = REVIEW_BRIEF_LIMITS.maxDiffPatchBytes;
  const cumulative = await readDiffRange(run, {
    repo: input.repo,
    fromRef: input.baseHead,
    toRef: input.head,
    maxBytes,
  });
  const affectedCallers = await readReferencingFiles(run, {
    repo: input.repo,
    ref: input.head,
    files: cumulative.files.slice(0, REVIEW_BRIEF_LIMITS.maxChangedFiles),
    maxResults: REVIEW_BRIEF_LIMITS.maxAffectedCallers,
  });
  const cumulativeFact: ReviewDiffFact = {
    range: "cumulative",
    fromRef: input.baseHead,
    toRef: input.head,
    changedFiles: cumulative.files,
    truncated: cumulative.truncated,
    patch: cumulative.patch,
  };
  const previousHead = lastReviewedHead(input.task);
  if (previousHead === undefined || previousHead === input.head) {
    return { cumulative: cumulativeFact, affectedCallers };
  }
  const incremental = await readDiffRange(run, {
    repo: input.repo,
    fromRef: previousHead,
    toRef: input.head,
    maxBytes,
  });
  return {
    cumulative: cumulativeFact,
    sinceLastReview: {
      range: "since-last-review",
      fromRef: previousHead,
      toRef: input.head,
      changedFiles: incremental.files,
      truncated: incremental.truncated,
      patch: incremental.patch,
    },
    affectedCallers,
  };
}
