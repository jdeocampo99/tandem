import type {
  FindingLedgerEntry,
  IterationScope,
  ReviewLens,
  ReviewLevelRecord,
  ReviewResult,
  TaskRecord,
  ValidationEvidence,
} from "../contracts.ts";
import { CODE_STANDARD_NAMES } from "../instructions.ts";
import type { EscalationReason, FinalAcceptanceStatus, FinalRequirement } from "./acceptance.ts";
import { finalAcceptanceStatus, isPinnedEvidence, planValidation } from "./acceptance.ts";
import {
  describeFindingEntry,
  ledgerBlockers,
  ledgerSuggestions,
  settledFindings,
} from "./findings.ts";
import { deepScrutinyRequirements, recordedReviewLevel } from "./review-levels.ts";

/** Named bounds every review brief is built and rendered within. */
export const REVIEW_BRIEF_LIMITS = {
  maxAcceptanceCriteria: 20,
  maxNonGoals: 12,
  maxFindingEntries: 40,
  maxChangedFiles: 40,
  maxAffectedCallers: 30,
  maxSourceLinks: 30,
  maxAdvisoryLeads: 8,
  maxEvidenceEntries: 20,
  maxUserDecisions: 10,
  maxDescriptionBytes: 400,
  maxCompactDescriptionBytes: 120,
  maxDiffPatchBytes: 256 * 1024,
  maxBriefBytes: 32 * 1024,
} as const;

export type DiffRange = "cumulative" | "since-last-review";

/** A pointer to one immutable patch on disk, never the patch text itself. */
export type ReviewBriefDiffReference = Readonly<{
  readonly range: DiffRange;
  readonly fromRef: string;
  readonly toRef: string;
  readonly patchPath: string;
  readonly changedFiles: readonly string[];
  readonly truncated: boolean;
}>;

/** Git facts read at the reviewed HEAD and injected into the otherwise pure brief. */
export type ReviewBriefObservations = Readonly<{
  readonly cumulative: ReviewBriefDiffReference;
  readonly sinceLastReview?: ReviewBriefDiffReference;
  readonly affectedCallers: readonly string[];
}>;

/**
 * The part of the observations an impact assessment reads. Narrower than the brief's own
 * observations so a caller that has not yet chosen where the patches will be written can still
 * assess impact from the same facts.
 */
export type ReviewImpactObservations = Readonly<{
  readonly sinceLastReview?: Readonly<{
    readonly range: DiffRange;
    readonly changedFiles: readonly string[];
    readonly truncated: boolean;
  }>;
  readonly affectedCallers: readonly string[];
}>;

/**
 * An untrusted classification lead offered by a helper such as Jev. It is rendered with its
 * provenance and can never become a blocker, drop mandatory context, or authorize acceptance.
 */
export type AdvisoryReviewLead = Readonly<{
  readonly id: string;
  readonly summary: string;
  readonly principle?: string;
  readonly provenance: Readonly<{
    readonly source: string;
    readonly question: string;
    readonly requestIdentity: string;
    readonly resultIdentity: string;
  }>;
}>;

export type ReviewBriefInput = Readonly<{
  readonly task: TaskRecord;
  readonly head: string;
  readonly lens: ReviewLens;
  readonly observations: ReviewBriefObservations;
  readonly advisoryLeads?: readonly AdvisoryReviewLead[];
}>;

export type ReviewBriefScope = Readonly<{
  readonly objective: string;
  readonly scopeApproved: boolean;
  /** The approved surfaces, joined and bounded for rendering. */
  readonly surfaces: string;
  readonly acceptanceCriteria: readonly string[];
  readonly principles: readonly string[];
  readonly nonGoals: readonly string[];
}>;

export type ReviewBriefIdentities = Readonly<{
  readonly head: string;
  readonly baseHead: string;
  readonly branch: string;
  readonly generation: number;
  readonly reviewRound: number;
  readonly policyDigest: string;
  readonly instructions: readonly string[];
  readonly configuration: readonly string[];
}>;

export type ReviewBriefEvidence = Readonly<{
  readonly finalAcceptance: FinalAcceptanceStatus;
  readonly iterationScope?: IterationScope;
  readonly recorded: readonly string[];
  readonly legacyRecords: number;
}>;

/** How wide this round's review must be, expressed with the existing escalation vocabulary. */
export type ReviewBriefImpact = Readonly<{
  readonly assessment: "contained" | "expanded" | "unknown";
  readonly reason: string;
  readonly outsideScopeFiles: readonly string[];
  readonly escalation?: EscalationReason;
}>;

export type ReviewBriefElision = Readonly<{
  readonly findings: number;
  readonly changedFiles: number;
  readonly affectedCallers: number;
  readonly sourceLinks: number;
  readonly advisoryLeads: number;
  readonly userDecisions: number;
}>;

/** An earlier worker question on this task, paired with the user's own answer to it. */
export type ReviewBriefDecision = Readonly<{
  readonly question: string;
  readonly answer: string;
}>;

export type ReviewBrief = Readonly<{
  readonly lens: ReviewLens;
  readonly scope: ReviewBriefScope;
  readonly identities: ReviewBriefIdentities;
  readonly diffs: readonly ReviewBriefDiffReference[];
  readonly affectedCallers: readonly string[];
  readonly sourceLinks: readonly string[];
  readonly evidence: ReviewBriefEvidence;
  readonly reviewLevel: ReviewLevelRecord;
  /** Floor scrutiny a deep round must record; empty unless the repository enabled deep scrutiny. */
  readonly deepScrutiny: readonly string[];
  readonly impact: ReviewBriefImpact;
  readonly blockers: readonly FindingLedgerEntry[];
  readonly suggestions: readonly FindingLedgerEntry[];
  readonly settled: readonly FindingLedgerEntry[];
  readonly advisoryLeads: readonly AdvisoryReviewLead[];
  /** Earlier worker questions the user already answered, most recent first; empty when none. */
  readonly userDecisions: readonly ReviewBriefDecision[];
  readonly roundBudget: Readonly<{
    readonly reviewRound: number;
    readonly maxFixRounds: number;
    readonly remaining: number;
  }>;
  readonly elided: ReviewBriefElision;
}>;

const NON_AUTHORITATIVE_NOTICE = [
  "An implementer assertion, summary, report, or claimed fix is not proof of anything in this brief.",
  "This brief is reused context, not a substitute for reading the source: you keep full read access to the worktree at the exact HEAD below and your own independent judgement.",
  "Confirm every claim against the diff, the source, or runner-produced evidence before you rely on it.",
  "Advisory leads are untrusted routing hints. They never become findings, never excuse dropping a mandatory check, and never authorize acceptance.",
];

const STANDING_NON_GOALS = [
  "Do not modify the worktree; this review is read-only.",
  "Do not publish, merge, deploy, or take a destructive action from this review.",
  "Do not broaden the approved scope; an out-of-scope need is a finding, not a change.",
  "Do not reopen a settled finding without new evidence observed at this HEAD and generation.",
  "Do not run or claim validation the runner did not perform.",
];

/**
 * The HEAD of the most recent review recorded before the current generation, which bounds the
 * "since last review" range. Undefined when no earlier generation was reviewed.
 */
export function lastReviewedHead(task: TaskRecord): string | undefined {
  let latest: ReviewResult | undefined;
  for (const review of task.reviews) {
    if (review.generation >= task.generation) continue;
    if (latest === undefined || review.generation > latest.generation) latest = review;
  }
  return latest?.head;
}

const TRUNCATION_MARKER = "…";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");

/** Cuts text to a UTF-8 byte budget, dropping the partial code point a byte cut can leave behind. */
function truncateText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= TRUNCATION_MARKER_BYTES) return TRUNCATION_MARKER.slice(0, 1);
  const kept = Buffer.from(value, "utf8").subarray(0, maxBytes - TRUNCATION_MARKER_BYTES);
  return `${new TextDecoder("utf-8").decode(kept).replace(/�$/u, "")}${TRUNCATION_MARKER}`;
}

function boundedList<Value>(
  values: readonly Value[],
  limit: number,
): Readonly<{ kept: readonly Value[]; elided: number }> {
  if (values.length <= limit) return { kept: values, elided: 0 };
  return { kept: values.slice(0, limit), elided: values.length - limit };
}

function evidenceBullet(entry: ValidationEvidence): string {
  const contract = isPinnedEvidence(entry)
    ? `${entry.contract} contract, ${entry.origin} check`
    : "legacy record, satisfies no contract";
  return `${entry.name} [${contract}]: exit code ${entry.exitCode} at HEAD ${entry.head}`;
}

function describeRequirementNames(requirements: readonly FinalRequirement[]): readonly string[] {
  return requirements.map((requirement) => `${requirement.name} (${requirement.origin})`);
}

/**
 * The files the admitted fix round was authorized to touch: the files its findings name, plus the
 * files observed to reference a changed file. Empty when the round names no file, which no caller
 * may read as an unrestricted surface.
 */
function authorizedSurface(
  input: Readonly<{
    readonly scope: IterationScope | undefined;
    readonly ledger: readonly FindingLedgerEntry[];
    readonly affectedCallers: readonly string[];
  }>,
): readonly string[] {
  const scope = input.scope;
  if (scope === undefined) return [];
  const files: string[] = [];
  for (const entry of input.ledger) {
    if (!scope.findingIds.includes(entry.id) || entry.file === undefined) continue;
    if (!files.includes(entry.file)) files.push(entry.file);
  }
  if (files.length === 0) return [];
  return [...files, ...input.affectedCallers.filter((file) => !files.includes(file))];
}

/**
 * How wide this round's review must be. Exported so the review-level classifier reads the same
 * assessment the brief renders instead of deriving a second, possibly different one.
 */
export function assessReviewImpact(
  input: Readonly<{
    readonly task: TaskRecord;
    readonly ledger: readonly FindingLedgerEntry[];
    readonly observations: ReviewImpactObservations;
    readonly escalation: EscalationReason | undefined;
  }>,
): ReviewBriefImpact {
  const { escalation, observations, task } = input;
  if (escalation !== undefined) {
    return {
      assessment: escalation === "unknown-impact" ? "unknown" : "expanded",
      reason: `the next validation contract escalated with ${escalation}, so review the cumulative diff and the affected callers in full`,
      outsideScopeFiles: [],
      escalation,
    };
  }
  const incremental = observations.sinceLastReview;
  if (incremental === undefined) {
    return task.reviewRound === 0
      ? {
          assessment: "contained",
          reason: "this is the first review round, so the cumulative diff is the whole change",
          outsideScopeFiles: [],
        }
      : {
          assessment: "unknown",
          reason:
            "a fix round was admitted but no prior reviewed HEAD is recorded, so the change since the last review cannot be bounded",
          outsideScopeFiles: [],
          escalation: "unknown-impact",
        };
  }
  if (incremental.truncated) {
    return {
      assessment: "unknown",
      reason: `the ${incremental.range} patch exceeded ${REVIEW_BRIEF_LIMITS.maxDiffPatchBytes} bytes and was truncated, so its impact cannot be bounded from this brief`,
      outsideScopeFiles: [],
      escalation: "unknown-impact",
    };
  }
  const authorized = authorizedSurface({
    scope: task.iterationScope,
    ledger: input.ledger,
    affectedCallers: observations.affectedCallers,
  });
  if (authorized.length === 0) {
    return {
      assessment: "unknown",
      reason:
        "the admitted fix round names no finding with a file, so the surface the fix was authorized to touch cannot be bounded",
      outsideScopeFiles: [],
      escalation: "unknown-impact",
    };
  }
  const outside = incremental.changedFiles.filter((file) => !authorized.includes(file));
  if (outside.length === 0) {
    return {
      assessment: "contained",
      reason:
        "the change since the last review stays inside the surface the fix round was authorized to touch",
      outsideScopeFiles: [],
    };
  }
  return {
    assessment: "expanded",
    reason:
      "the fix reached files outside the surface the round was authorized to touch, so review the cumulative diff and the affected callers in full",
    outsideScopeFiles: boundedList(outside, REVIEW_BRIEF_LIMITS.maxChangedFiles).kept,
    escalation: "broad-impact",
  };
}

function boundedEntries(
  entries: readonly FindingLedgerEntry[],
  limit: number,
): Readonly<{ kept: readonly FindingLedgerEntry[]; elided: number }> {
  const bounded = boundedList(entries, limit);
  return {
    kept: bounded.kept.map((entry) => ({
      ...entry,
      description: truncateText(entry.description, REVIEW_BRIEF_LIMITS.maxDescriptionBytes),
    })),
    elided: bounded.elided,
  };
}

/**
 * Earlier worker questions on this task the user already answered, most recent first. An answer
 * message's `replyTo` names the question id; the question's own wording survives only as the
 * acknowledged notification `appendAnswer` records under that same id, since answering clears the
 * live `communication.question`. A question whose notification is missing (a legacy record from
 * before this pairing existed) is skipped rather than shown without its wording.
 */
function pastDecisions(task: TaskRecord): readonly ReviewBriefDecision[] {
  const messages = task.communication?.messages ?? [];
  const decisions: ReviewBriefDecision[] = [];
  for (const message of messages) {
    if (message.kind !== "answer" || message.replyTo === undefined) continue;
    const record = task.notifications.find((entry) => entry.id === message.replyTo);
    if (record === undefined) continue;
    decisions.push({
      question: truncateText(record.message, REVIEW_BRIEF_LIMITS.maxDescriptionBytes),
      answer: truncateText(message.text, REVIEW_BRIEF_LIMITS.maxDescriptionBytes),
    });
  }
  return decisions.reverse();
}

/**
 * Builds the round's review brief from durable task state and the injected git observations. The
 * result is a pure function of those inputs, so the same task and HEAD always produce the same
 * brief. Blockers are never elided; suggestions, settled findings, and leads are bounded first.
 */
export function buildReviewBrief(input: ReviewBriefInput): ReviewBrief {
  const { head, lens, observations, task } = input;
  const worktree = task.worktree;
  if (worktree === undefined) throw new TypeError("a review brief requires a task worktree lease");
  const acceptance = finalAcceptanceStatus(task, head);
  const escalation = planValidation(task, head).escalation;
  const ledger = task.findingLedger ?? [];

  const surfaces = truncateText(task.surfaces.join(", "), REVIEW_BRIEF_LIMITS.maxDescriptionBytes);
  const criteria = boundedList(
    task.acceptanceCriteria,
    REVIEW_BRIEF_LIMITS.maxAcceptanceCriteria,
  ).kept.map((entry) => truncateText(entry, REVIEW_BRIEF_LIMITS.maxDescriptionBytes));
  const nonGoals = boundedList(
    [`Do not change files outside the approved surfaces: ${surfaces}.`, ...STANDING_NON_GOALS],
    REVIEW_BRIEF_LIMITS.maxNonGoals,
  ).kept;

  const blockers = boundedEntries(ledgerBlockers(ledger), REVIEW_BRIEF_LIMITS.maxFindingEntries);
  const suggestionBudget = Math.max(
    0,
    REVIEW_BRIEF_LIMITS.maxFindingEntries - blockers.kept.length,
  );
  const suggestions = boundedEntries(ledgerSuggestions(ledger), suggestionBudget);
  const settled = boundedEntries(
    settledFindings(ledger),
    Math.max(0, suggestionBudget - suggestions.kept.length),
  );

  const callers = boundedList(observations.affectedCallers, REVIEW_BRIEF_LIMITS.maxAffectedCallers);
  const links = boundedList(
    observations.cumulative.changedFiles.map((file) =>
      truncateText(`${worktree.path}/${file} @ ${head}`, REVIEW_BRIEF_LIMITS.maxDescriptionBytes),
    ),
    REVIEW_BRIEF_LIMITS.maxSourceLinks,
  );
  const leads = boundedList(input.advisoryLeads ?? [], REVIEW_BRIEF_LIMITS.maxAdvisoryLeads);
  const decisions = boundedList(pastDecisions(task), REVIEW_BRIEF_LIMITS.maxUserDecisions);
  const evidence = boundedList(task.validationEvidence, REVIEW_BRIEF_LIMITS.maxEvidenceEntries);
  const changedFiles = boundedList(
    observations.cumulative.changedFiles,
    REVIEW_BRIEF_LIMITS.maxChangedFiles,
  );

  const diffs: ReviewBriefDiffReference[] = [
    { ...observations.cumulative, changedFiles: changedFiles.kept },
  ];
  if (observations.sinceLastReview !== undefined) {
    const incremental = observations.sinceLastReview;
    diffs.push({
      ...incremental,
      changedFiles: boundedList(incremental.changedFiles, REVIEW_BRIEF_LIMITS.maxChangedFiles).kept,
    });
  }

  return {
    lens,
    scope: {
      objective: truncateText(task.objective, REVIEW_BRIEF_LIMITS.maxDescriptionBytes),
      scopeApproved: task.scopeApproved,
      surfaces,
      acceptanceCriteria: criteria,
      principles: CODE_STANDARD_NAMES,
      nonGoals,
    },
    identities: {
      head,
      baseHead: worktree.baseHead,
      branch: worktree.branch,
      generation: task.generation,
      reviewRound: task.reviewRound,
      policyDigest: acceptance.identity.policyDigest,
      instructions: task.policy.guidance.review.map(
        (entry) => `${entry.provenance.channel}: ${entry.provenance.source}`,
      ),
      configuration: [
        `maxFixRounds=${task.policy.config.maxFixRounds}`,
        `maxWorkers=${task.policy.config.maxWorkers}`,
        `validation commands: ${task.policy.config.validationCommands.map((command) => command.name).join(", ")}`,
      ],
    },
    diffs,
    affectedCallers: callers.kept,
    sourceLinks: links.kept,
    evidence: {
      finalAcceptance: acceptance,
      ...(task.iterationScope === undefined ? {} : { iterationScope: task.iterationScope }),
      recorded: evidence.kept.map(evidenceBullet),
      legacyRecords: task.validationEvidence.filter((entry) => !isPinnedEvidence(entry)).length,
    },
    reviewLevel: recordedReviewLevel(task),
    deepScrutiny: deepScrutinyRequirements(task.reviewLevel, task.policy.config.reviewLevels),
    impact: assessReviewImpact({ task, ledger, observations, escalation }),
    blockers: blockers.kept,
    suggestions: suggestions.kept,
    settled: settled.kept,
    advisoryLeads: leads.kept,
    userDecisions: decisions.kept,
    roundBudget: {
      reviewRound: task.reviewRound,
      maxFixRounds: task.policy.config.maxFixRounds,
      remaining: Math.max(0, task.policy.config.maxFixRounds - task.reviewRound),
    },
    elided: {
      findings: blockers.elided + suggestions.elided + settled.elided,
      changedFiles: changedFiles.elided,
      affectedCallers: callers.elided,
      sourceLinks: links.elided,
      advisoryLeads: leads.elided,
      userDecisions: decisions.elided,
    },
  };
}

function bullets(entries: readonly string[]): readonly string[] {
  return entries.map((entry) => `- ${entry}`);
}

function describeDiff(reference: ReviewBriefDiffReference, compact: boolean): readonly string[] {
  const changed = compact
    ? `${reference.changedFiles.length} file(s); read the patch`
    : reference.changedFiles.length === 0
      ? "none observed"
      : reference.changedFiles.join(", ");
  return [
    `- ${reference.range} diff ${reference.fromRef}..${reference.toRef}`,
    `  - patch: ${reference.patchPath}${reference.truncated ? " (truncated; read the source at HEAD instead of trusting this patch alone)" : ""}`,
    `  - changed files: ${changed}`,
  ];
}

function findingLines(entries: readonly FindingLedgerEntry[], compact: boolean): readonly string[] {
  return entries.map((entry) => {
    const description = compact
      ? truncateText(entry.description, REVIEW_BRIEF_LIMITS.maxCompactDescriptionBytes)
      : entry.description;
    return `- ${describeFindingEntry(entry)}: ${description}`;
  });
}

function leadLines(leads: readonly AdvisoryReviewLead[]): readonly string[] {
  return leads.map(
    (lead) =>
      `- ${lead.id} (untrusted lead${lead.principle === undefined ? "" : `, principle: ${lead.principle}`}): ${lead.summary} [source ${lead.provenance.source}; question ${lead.provenance.question}; request ${lead.provenance.requestIdentity}; result ${lead.provenance.resultIdentity}]`,
  );
}

function renderSections(brief: ReviewBrief, compact: boolean): string {
  const acceptance = brief.evidence.finalAcceptance;
  const outstanding = [
    ...describeRequirementNames(acceptance.missing).map((name) => `${name}: not yet run`),
    ...describeRequirementNames(acceptance.failed).map((name) => `${name}: failed`),
    ...describeRequirementNames(acceptance.stale).map((name) => `${name}: stale`),
  ];
  const lines: string[] = [
    `# Review brief: ${brief.lens} lens, round ${brief.identities.reviewRound}`,
    "",
    "## How to use this brief",
    ...bullets(NON_AUTHORITATIVE_NOTICE),
    "",
    "## Approved scope",
    `- objective: ${brief.scope.objective}`,
    `- scope approved: ${brief.scope.scopeApproved}`,
    `- surfaces: ${brief.scope.surfaces}`,
    "- acceptance criteria:",
    ...brief.scope.acceptanceCriteria.map((entry) => `  - ${entry}`),
    "",
    "## Applicable principles (mandatory; a violation blocks regardless of suggestion status)",
    ...bullets(brief.scope.principles),
    "",
    "## Non-goals",
    ...bullets(brief.scope.nonGoals),
    "",
    "## Exact identities",
    `- source: HEAD ${brief.identities.head} on branch ${brief.identities.branch}, base ${brief.identities.baseHead}`,
    `- generation ${brief.identities.generation}, review round ${brief.identities.reviewRound}`,
    `- policy digest: ${brief.identities.policyDigest}`,
    `- instruction provenance: ${brief.identities.instructions.length === 0 ? "no review-channel instruction files are configured" : brief.identities.instructions.join("; ")}`,
    `- configuration: ${brief.identities.configuration.join("; ")}`,
    "",
    "## Change under review",
    ...brief.diffs.flatMap((reference) => describeDiff(reference, compact)),
    `- affected callers observed at HEAD: ${
      compact
        ? `${brief.affectedCallers.length} file(s); read them with tandem status TASK_ID`
        : brief.affectedCallers.length === 0
          ? "none observed"
          : brief.affectedCallers.join(", ")
    }`,
    ...(compact
      ? [`- ${brief.sourceLinks.length} source link(s); read the patch at the paths above.`]
      : ["- source links:", ...brief.sourceLinks.map((entry) => `  - ${entry}`)]),
    ...(brief.identities.reviewRound === 0 || brief.impact.assessment !== "contained"
      ? []
      : [
          "",
          "## Fix-round focus",
          `- This is fix round ${brief.identities.reviewRound}; review the since-last-review diff above, not the whole change from scratch.`,
          "- Confirm each evidence-backed blocker below is resolved at this HEAD before passing; do not reopen a settled finding without new evidence.",
        ]),
    "",
    "## Review breadth",
    `- review level: ${brief.reviewLevel.level}`,
    `- level reason: ${brief.reviewLevel.reason}`,
    `- safety floors in force: ${brief.reviewLevel.floors.length === 0 ? "none" : brief.reviewLevel.floors.join(", ")}`,
    ...(brief.reviewLevel.assistance === undefined
      ? []
      : [
          `- shadow helper recommendation (recorded only; it did not change the level): ${brief.reviewLevel.assistance.recommendation}; ${brief.reviewLevel.assistance.reason}`,
        ]),
    ...(brief.deepScrutiny.length === 0
      ? []
      : [
          "- deep scrutiny required for this round; record an explicit disposition for each:",
          ...brief.deepScrutiny.map((entry) => `  - ${entry}`),
        ]),
    `- impact: ${brief.impact.assessment}${brief.impact.escalation === undefined ? "" : ` (${brief.impact.escalation})`}`,
    `- reason: ${brief.impact.reason}`,
    ...(brief.impact.outsideScopeFiles.length === 0
      ? []
      : [
          `- files outside the authorized fix surface: ${brief.impact.outsideScopeFiles.join(", ")}`,
        ]),
    ...(brief.impact.assessment === "contained"
      ? []
      : ["- Review the cumulative diff and the affected callers in full for this round."]),
    "",
    "## Evidence",
    `- final acceptance manifest satisfied: ${acceptance.satisfied}`,
    `- outstanding manifest items: ${outstanding.length === 0 ? "none" : outstanding.join("; ")}`,
    `- review lenses still pending: ${acceptance.pendingLenses.length === 0 ? "none" : acceptance.pendingLenses.join(", ")}`,
    `- iteration scope: ${
      brief.evidence.iterationScope === undefined
        ? "none recorded for this round"
        : `reproduces ${brief.evidence.iterationScope.reproduces.join(", ")} over surfaces ${brief.evidence.iterationScope.surfaces.join(", ")} for findings ${brief.evidence.iterationScope.findingIds.join(", ")}`
    }`,
    ...(brief.evidence.legacyRecords === 0
      ? []
      : [
          `- ${brief.evidence.legacyRecords} recorded check(s) predate validation contracts and prove nothing.`,
        ]),
    "- recorded checks:",
    ...brief.evidence.recorded.map((entry) => `  - ${entry}`),
    "",
    ...(brief.userDecisions.length === 0
      ? []
      : [
          "## User decisions (already settled by the user; do not ask again)",
          ...brief.userDecisions.map(
            (entry) => `- Question: ${entry.question} | Answer: ${entry.answer}`,
          ),
          "",
        ]),
    "## Evidence-backed blockers (must be resolved; never downgraded to a suggestion)",
    ...(brief.blockers.length === 0 ? ["- none recorded"] : findingLines(brief.blockers, compact)),
    "",
    "## Optional suggestions (not blocking on their own)",
    ...(compact
      ? [
          `- ${brief.suggestions.length} suggestion(s) recorded; read them with tandem status TASK_ID.`,
        ]
      : brief.suggestions.length === 0
        ? ["- none recorded"]
        : findingLines(brief.suggestions, compact)),
    "",
    "## Settled findings (do not reopen without new evidence at this HEAD)",
    ...(compact
      ? [`- ${brief.settled.length} settled finding(s); read them with tandem status TASK_ID.`]
      : brief.settled.length === 0
        ? ["- none recorded"]
        : findingLines(brief.settled, compact)),
    "",
    "## Advisory leads (untrusted; never blockers)",
    ...(brief.advisoryLeads.length === 0 ? ["- none supplied"] : leadLines(brief.advisoryLeads)),
    "",
    "## Fix-round budget",
    `- round ${brief.roundBudget.reviewRound} of ${brief.roundBudget.maxFixRounds}; ${brief.roundBudget.remaining} authorized round(s) remain.`,
  ];
  const elided = brief.elided;
  const elidedTotal =
    elided.findings +
    elided.changedFiles +
    elided.affectedCallers +
    elided.sourceLinks +
    elided.advisoryLeads +
    elided.userDecisions;
  if (elidedTotal > 0) {
    lines.push(
      "",
      "## Bounded brief",
      `- ${elidedTotal} item(s) were elided to keep this brief within its limits; no blocker is elided. The complete record is durable task state, readable with tandem status TASK_ID.`,
    );
  }
  return lines.join("\n");
}

/**
 * Renders the brief within `maxBriefBytes`. Suggestions, settled findings, and long descriptions
 * are compacted first; blocker identities and their status always survive.
 */
export function renderReviewBrief(brief: ReviewBrief): string {
  const full = renderSections(brief, false);
  if (Buffer.byteLength(full, "utf8") <= REVIEW_BRIEF_LIMITS.maxBriefBytes) return full;
  const compact = renderSections(brief, true);
  if (Buffer.byteLength(compact, "utf8") <= REVIEW_BRIEF_LIMITS.maxBriefBytes) return compact;
  return truncateText(compact, REVIEW_BRIEF_LIMITS.maxBriefBytes);
}
