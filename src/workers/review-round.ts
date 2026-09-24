import { readDiffRange, readReferencingFiles } from "../adapters/git.ts";
import type {
  Clock,
  CommandRunner,
  IsoTimestamp,
  ReviewLevelRecord,
  TaskRecord,
} from "../contracts.ts";
import type { RequestUsageEvent } from "../runtime/usage.ts";
import { providerSampleEvent } from "../runtime/usage-events.ts";
import { planValidation, policyIdentity } from "../tasks/acceptance.ts";
import type {
  ReviewAssistanceOutcome,
  ReviewAssistanceRuntime,
} from "../tasks/review-assistance.ts";
import { requestReviewAssistance } from "../tasks/review-assistance.ts";
import {
  type AdvisoryReviewLead,
  assessReviewImpact,
  type DiffRange,
  lastReviewedHead,
  REVIEW_BRIEF_LIMITS,
  type ReviewBriefDiffReference,
  type ReviewBriefObservations,
} from "../tasks/review-brief.ts";
import {
  assistedReviewLevel,
  classifyReviewLevel,
  observeChangedFiles,
  reclassifyReviewLevel,
} from "../tasks/review-levels.ts";

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

/** The round's persisted classification and the untrusted leads passed to the brief. */
export type ClassifiedReviewRound = Readonly<{
  readonly record: ReviewLevelRecord;
  readonly leads: readonly AdvisoryReviewLead[];
}>;

/** What classifying a round needs: the review helper, a clock, and the usage ledger's writer. */
export type ReviewClassificationDependencies = Readonly<{
  readonly reviewAssistance: ReviewAssistanceRuntime;
  readonly clock: Clock;
  readonly recordRequestUsage: (events: readonly RequestUsageEvent[]) => Promise<void>;
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

/**
 * Classifies the round from the observed diff, merges it into the recorded classification so a
 * level never drops, and asks the configured helper for a shadow depth recommendation and focus
 * flags.
 */
export async function classifyReviewRound(
  deps: ReviewClassificationDependencies,
  input: Readonly<{
    readonly task: TaskRecord;
    readonly head: string;
    readonly facts: ReviewDiffFacts;
  }>,
): Promise<ClassifiedReviewRound> {
  const { facts, head, task } = input;
  const files = observeChangedFiles({
    changedFiles: facts.cumulative.changedFiles,
    patch: facts.cumulative.patch,
    truncated: facts.cumulative.truncated,
  });
  const impact = assessReviewImpact({
    task,
    ledger: task.findingLedger ?? [],
    observations: facts,
    escalation: planValidation(task, head).escalation,
  });
  const deterministic = reclassifyReviewLevel(
    task.reviewLevel,
    classifyReviewLevel({ files, affectedCallers: facts.affectedCallers, impact }),
  );
  const startedAt = deps.clock();
  const assistance = await requestReviewAssistance(
    deps.reviewAssistance,
    task.policy.config.reviewLevels,
    {
      files,
      affectedCallers: facts.affectedCallers,
      deterministic,
      impact: impact.assessment,
      policyDigest: policyIdentity(task.policy),
      source: `${facts.cumulative.range} diff ${facts.cumulative.fromRef}..${facts.cumulative.toRef}`,
    },
  );
  await recordAssistanceSample(deps, task, assistance, startedAt, deps.clock());
  if (assistance.identity === undefined) return { record: deterministic, leads: [] };
  const assisted: ReviewLevelRecord = {
    ...deterministic,
    assistance: {
      mode: "shadow",
      recommendation: assistance.recommendation,
      reason: assistance.reason,
      requestIdentity: assistance.identity.request,
      resultIdentity: assistance.resultIdentity ?? "unavailable",
    },
  };
  return {
    record: {
      ...assisted,
      level: assistedReviewLevel(assisted, task.policy.config.reviewLevels),
    },
    leads: assistance.leads,
  };
}

/**
 * Accounts for the one provider call this review round may have made, under the request that
 * governs the task. A disabled, refused, or exactly cached round reached no provider and so has
 * nothing to account for; a repeated call under the same provider identity records once.
 */
async function recordAssistanceSample(
  deps: ReviewClassificationDependencies,
  task: TaskRecord,
  assistance: ReviewAssistanceOutcome,
  startedAt: IsoTimestamp,
  endedAt: IsoTimestamp,
): Promise<void> {
  const requestId = task.requestId;
  if (requestId === undefined || assistance.usage === undefined) return;
  if (assistance.identity === undefined) return;
  const event = providerSampleEvent({
    requestId,
    workKind: "review",
    usage: assistance.usage,
    startedAt,
    endedAt,
    sampleIdentity: assistance.identity.request,
    taskId: task.id,
    generation: task.generation,
    role: "reviewer",
  });
  if (event !== undefined) await deps.recordRequestUsage([event]);
}
