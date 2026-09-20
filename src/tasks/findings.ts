import type {
  Finding,
  FindingLedgerEntry,
  FindingObservation,
  FindingStatus,
  ReviewLens,
  ReviewResult,
  TaskRecord,
} from "../contracts.ts";

export const FINDING_STATUSES: readonly FindingStatus[] = [
  "addressed",
  "unresolved",
  "regressed",
  "disputed",
];

/** How many blockers the exhaustion reason names before it summarises the remainder as a count. */
export const MAX_NAMED_EXHAUSTION_BLOCKERS = 5;

type SeverityAndVerdict = Pick<Finding, "severity" | "verdict">;

/**
 * The recorded rule a review already enforces: a lens may not pass while a confirmed P0, P1, or P2,
 * or a plausible P0 or P1, stands. Anything else is an optional suggestion.
 */
export function isBlockingFinding(finding: SeverityAndVerdict): boolean {
  if (finding.verdict === "confirmed") {
    return finding.severity === "P0" || finding.severity === "P1" || finding.severity === "P2";
  }
  return finding.severity === "P0" || finding.severity === "P1";
}

function identityOf(lens: ReviewLens, id: string): string {
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
  lens: ReviewLens,
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
    const settles =
      entry.lens === review.lens &&
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

/**
 * The durable reason recorded when the configured fix-round budget is spent. It names the exhausted
 * bounded loop, states that the task is neither ready nor accepted, and names the blockers that
 * remain and the decision that is available, so no round is retried silently and no unresolved
 * blocker is quietly downgraded to a suggestion.
 */
export function describeFixRoundExhaustion(task: TaskRecord): string {
  const blockers = ledgerBlockers(task.findingLedger ?? []);
  const named = blockers
    .slice(0, MAX_NAMED_EXHAUSTION_BLOCKERS)
    .map(describeFindingEntry)
    .join("; ");
  const remainder = blockers.length - Math.min(blockers.length, MAX_NAMED_EXHAUSTION_BLOCKERS);
  const remaining =
    blockers.length === 0
      ? "no evidence-backed blocker is recorded on the finding ledger, so the remaining work is whatever the last review round refused"
      : `${blockers.length} evidence-backed blocker(s) remain: ${named}${remainder === 0 ? "" : `; and ${remainder} more on the finding ledger`}`;
  return `Bounded review loop exhausted: fix round budget spent at ${task.reviewRound} of ${task.policy.config.maxFixRounds}; no new fix operation was admitted and the task is not ready and not accepted. ${remaining}. Decide explicitly: stop for a human decision, or revise and re-approve the task scope. No blocker is downgraded to a suggestion and no round is retried automatically.`;
}
