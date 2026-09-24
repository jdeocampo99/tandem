import type {
  Finding,
  FindingLedgerEntry,
  FindingObservation,
  FindingStatus,
  FixRoundGrant,
  ReviewResult,
  StoredReviewLens,
  TaskQuestion,
  TaskRecord,
} from "../contracts.ts";
import { formatDecisionQuestion, shortNote, taskName } from "./question.ts";

const FINDING_SUMMARY_MAX_CHARS = 160;

/** The first sentence of a finding, capped so each finding stays one readable line. */
export function findingHeadline(description: string): string {
  const sentence = description.trim().split(/(?<=[.!?])\s/, 1)[0] ?? "";
  return sentence.length <= FINDING_SUMMARY_MAX_CHARS
    ? sentence
    : `${sentence.slice(0, FINDING_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

export const FINDING_STATUSES: readonly FindingStatus[] = [
  "addressed",
  "unresolved",
  "regressed",
  "disputed",
];

/** How many blockers the "Keep fixing?" details name before summarising the remainder as a count. */
const MAX_NAMED_OPEN_BLOCKERS = 5;

/**
 * A review fails only on a P0 or P1, confirmed or plausible. A P2 or P3 is a known issue: it is
 * reported to the user with the ready task and never costs a fix round on its own.
 */
export function isBlockingFinding(finding: Pick<Finding, "severity">): boolean {
  return finding.severity === "P0" || finding.severity === "P1";
}

function identityOf(lens: StoredReviewLens, id: string): string {
  return `${lens}:${id}`;
}

function sameObservation(left: FindingObservation, right: FindingObservation): boolean {
  return (
    left.head === right.head &&
    left.generation === right.generation &&
    left.reviewRound === right.reviewRound
  );
}

function nextStatus(previous: FindingLedgerEntry, reported: Finding): FindingStatus {
  if (previous.status === "addressed") return "regressed";
  if (previous.verdict !== reported.verdict) return "disputed";
  if (previous.status === "disputed" || previous.status === "regressed") return previous.status;
  return "unresolved";
}

function reportedEntry(
  previous: FindingLedgerEntry | undefined,
  reported: Finding,
  lens: StoredReviewLens,
  observation: FindingObservation,
): FindingLedgerEntry {
  const status = previous === undefined ? "unresolved" : nextStatus(previous, reported);
  return {
    id: reported.id,
    lens,
    severity: reported.severity,
    verdict: reported.verdict,
    description: reported.description,
    ...(reported.file === undefined ? {} : { file: reported.file }),
    ...(reported.line === undefined ? {} : { line: reported.line }),
    status,
    raisedAt: previous?.raisedAt ?? observation,
    statusAt: observation,
  };
}

/**
 * Folds one recorded review into the durable finding ledger. An identity the review still reports
 * keeps or escalates its status; an identity of the same lens that a later code identity no longer
 * reports becomes `addressed`, and only a later review that reports it again can reopen it.
 */
export function recordReviewFindings(
  input: Readonly<{
    readonly ledger: readonly FindingLedgerEntry[];
    readonly review: ReviewResult;
    readonly reviewRound: number;
  }>,
): readonly FindingLedgerEntry[] {
  const { ledger, review } = input;
  const observation: FindingObservation = {
    head: review.head,
    generation: review.generation,
    reviewRound: input.reviewRound,
  };
  const reported = new Map<string, Finding>();
  for (const finding of review.findings) reported.set(identityOf(review.lens, finding.id), finding);

  const updated: FindingLedgerEntry[] = [];
  const carried = new Set<string>();
  for (const entry of ledger) {
    const identity = identityOf(entry.lens, entry.id);
    const match = reported.get(identity);
    if (match !== undefined) {
      updated.push(reportedEntry(entry, match, review.lens, observation));
      carried.add(identity);
      continue;
    }
    // One reviewer session now covers everything a round reviews, including a legacy lens's
    // ground (behavior, design, coverage, verification); an entry from any of them settles once
    // the current round's single review no longer reports it.
    const settles =
      entry.status !== "addressed" &&
      !sameObservation(entry.statusAt, observation) &&
      entry.statusAt.generation < review.generation;
    updated.push(settles ? { ...entry, status: "addressed", statusAt: observation } : entry);
  }
  for (const [identity, finding] of reported) {
    if (carried.has(identity)) continue;
    updated.push(reportedEntry(undefined, finding, review.lens, observation));
  }
  return updated;
}

/** Ledger entries that still stand and that a review may not pass over. */
export function ledgerBlockers(
  ledger: readonly FindingLedgerEntry[],
): readonly FindingLedgerEntry[] {
  return ledger.filter((entry) => entry.status !== "addressed" && isBlockingFinding(entry));
}

/** Ledger entries that still stand but do not block acceptance on their own. */
export function ledgerSuggestions(
  ledger: readonly FindingLedgerEntry[],
): readonly FindingLedgerEntry[] {
  return ledger.filter((entry) => entry.status !== "addressed" && !isBlockingFinding(entry));
}

/** Ledger entries a later review stopped reporting; they reopen only on new reported evidence. */
export function settledFindings(
  ledger: readonly FindingLedgerEntry[],
): readonly FindingLedgerEntry[] {
  return ledger.filter((entry) => entry.status === "addressed");
}

export function describeFindingEntry(entry: FindingLedgerEntry): string {
  const where =
    entry.file === undefined
      ? ""
      : ` ${entry.file}${entry.line === undefined ? "" : `:${entry.line}`}`;
  return `${entry.lens}/${entry.id} (${entry.verdict} ${entry.severity}, ${entry.status}${where}) since round ${entry.raisedAt.reviewRound}, status set at round ${entry.statusAt.reviewRound} HEAD ${entry.statusAt.head}`;
}

/** The fix rounds a task may spend: the pinned `maxFixRounds` plus every recorded grant. */
export function fixRoundBudget(task: TaskRecord): number {
  return (task.fixRoundGrants ?? []).reduce(
    (total, grant) => total + grant.rounds,
    task.policy.config.maxFixRounds,
  );
}

function sameText(left: string, right: string): boolean {
  const normalize = (text: string) => text.trim().replace(/\s+/gu, " ").toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * Blocking findings the current review reports unchanged from the round before: the same identity
 * at the same file with the same description. When the fix round left HEAD where it was, every
 * blocker the review still reports counts, since the code it describes did not change.
 */
export function repeatedFindings(task: TaskRecord): readonly Finding[] {
  const current = task.reviews.filter(
    (review) => review.generation === task.generation && review.head === task.reviewHead,
  );
  const earlier = task.reviews.filter((review) => review.generation < task.generation);
  const priorGeneration = Math.max(-1, ...earlier.map((review) => review.generation));
  const prior = earlier.filter((review) => review.generation === priorGeneration);
  if (prior.some((review) => review.head === task.reviewHead)) {
    return current.flatMap((review) => review.findings.filter(isBlockingFinding));
  }
  const before = new Map<string, Finding>();
  for (const review of prior) {
    for (const finding of review.findings) before.set(identityOf(review.lens, finding.id), finding);
  }
  return current.flatMap((review) =>
    review.findings.filter((finding) => {
      const previous = before.get(identityOf(review.lens, finding.id));
      return (
        isBlockingFinding(finding) &&
        previous !== undefined &&
        previous.file === finding.file &&
        sameText(previous.description, finding.description)
      );
    }),
  );
}

/** Every "Keep fixing?" question id starts with this, so the answer path can route to it. */
export const KEEP_FIXING_QUESTION_ID_PREFIX = "keep-fixing-";

/**
 * The "Keep fixing?" question a task in `awaiting-fixes` must ask before another fix round: once
 * the fix-round budget is spent, or earlier when the review repeats a finding unchanged. A "yes"
 * already recorded at this generation settles the repeat; nothing is asked otherwise.
 */
export function keepFixingQuestion(task: TaskRecord): TaskQuestion | undefined {
  const budget = fixRoundBudget(task);
  const approved = (task.fixRoundGrants ?? []).some(
    (grant) => grant.reason === "user" && grant.generation === task.generation,
  );
  const repeated = approved ? undefined : repeatedFindings(task)[0];
  if (task.reviewRound < budget && repeated === undefined) return undefined;
  const note =
    repeated === undefined
      ? `It used all ${budget} fix rounds`
      : `The same finding came back: ${repeated.description}`;
  return {
    id: `${KEEP_FIXING_QUESTION_ID_PREFIX}${task.generation}`,
    text: formatDecisionQuestion({
      ask: `Keep fixing ${taskName(task.objective)}?`,
      note: shortNote(note),
    }),
    recommendation: `Reply "yes" to allow more fix rounds on this same task and worktree, or "no" to leave it blocked. ${describeOpenFindings(task)}`,
  };
}

/**
 * What a "yes" to "Keep fixing?" records: another full pinned budget when the rounds are spent, or
 * no extra round when the question came early, which only settles the repeat at this generation.
 */
export function keepFixingGrant(task: TaskRecord): FixRoundGrant {
  return {
    generation: task.generation,
    rounds:
      task.reviewRound >= fixRoundBudget(task) ? Math.max(1, task.policy.config.maxFixRounds) : 0,
    reason: "user",
  };
}

/** The open blockers a "Keep fixing?" question carries in its details. */
export function describeOpenFindings(task: TaskRecord): string {
  const blockers = ledgerBlockers(task.findingLedger ?? []);
  const named = blockers.slice(0, MAX_NAMED_OPEN_BLOCKERS).map(describeFindingEntry).join("; ");
  const remainder = blockers.length - Math.min(blockers.length, MAX_NAMED_OPEN_BLOCKERS);
  const open =
    blockers.length === 0
      ? "No open blocker is recorded; the last review or validation refused the work."
      : `${blockers.length} open blocker(s): ${named}${remainder === 0 ? "" : `; and ${remainder} more`}.`;
  return `Fix round ${task.reviewRound} of ${fixRoundBudget(task)}. ${open} Never start a new task to get more rounds.`;
}
