/**
 * Tier evidence for one model and the comparison between two of them.
 *
 * Everything here is pure arithmetic over what the OMP catalogue actually published. Catalogue
 * cost is descriptive evidence about a model, never a guarantee about this account's pricing, and
 * an included allowance is quota consumption rather than money. A missing figure is evidence
 * nobody published, so it can never make a move read as comparable: the comparison says so
 * explicitly instead of filling the gap with zero.
 */

import type { OmpIncludedAllowance, OmpModelRecord } from "../adapters/omp.ts";
import type { ModelSpec, ThinkingLevel } from "../contracts.ts";

/** Why one model's catalogue entry cannot supply tier evidence at all. */
export type ModelCatalogueGap =
  | "absent-from-catalogue"
  | "ambiguous-in-catalogue"
  | "thinking-level-unsupported";

/** Why two models cannot be placed on the same tier scale. Bounded so no catalogue text escapes. */
export const MODEL_TIER_EVIDENCE_GAPS = [
  "incumbent-absent-from-catalogue",
  "incumbent-ambiguous-in-catalogue",
  "incumbent-thinking-level-unsupported",
  "candidate-absent-from-catalogue",
  "candidate-ambiguous-in-catalogue",
  "candidate-thinking-level-unsupported",
  "catalogue-cost-unpublished",
  "included-allowance-unpublished",
  "included-allowance-plan-differs",
  "included-allowance-unit-differs",
] as const;

export type ModelTierEvidenceGap = (typeof MODEL_TIER_EVIDENCE_GAPS)[number];

/** How much of one axis a candidate consumes compared with the incumbent. */
export type ModelTierAxisRelation = "lower" | "equal" | "higher";

/** Which axis makes a candidate a premium move. Money is named first when both axes rise. */
export const MODEL_TIER_PREMIUM_AXES = ["monetary-cost", "quota-consumption"] as const;

export type ModelTierPremiumAxis = (typeof MODEL_TIER_PREMIUM_AXES)[number];

/** One model's tier evidence exactly as the catalogue published it for one thinking level. */
export type ModelTierEvidence = Readonly<{
  readonly selector: string;
  readonly provider: string;
  readonly thinking: ThinkingLevel;
  readonly catalogueCost?: Readonly<{ readonly input: number; readonly output: number }>;
  readonly includedAllowance?: OmpIncludedAllowance;
}>;

export type ModelTierEvidenceLookup =
  | Readonly<{ readonly status: "known"; readonly evidence: ModelTierEvidence }>
  | Readonly<{ readonly status: "unknown"; readonly gap: ModelCatalogueGap }>;

/**
 * Where a candidate stands against the incumbent. `premium` names the axis that rose, so a move
 * that bills nothing extra but draws more included allowance is still reported as premium.
 */
export type ModelTierComparison =
  | Readonly<{
      readonly status: "comparable";
      readonly cost: ModelTierAxisRelation;
      readonly quota: ModelTierAxisRelation;
    }>
  | Readonly<{
      readonly status: "premium";
      readonly axis: ModelTierPremiumAxis;
      readonly cost?: ModelTierAxisRelation;
      readonly quota?: ModelTierAxisRelation;
    }>
  | Readonly<{
      readonly status: "indeterminate";
      readonly gaps: readonly ModelTierEvidenceGap[];
    }>;

/** Reads one catalogue entry's tier evidence, or names why the catalogue cannot supply it. */
export function lookupModelTierEvidence(
  catalogue: readonly OmpModelRecord[],
  model: ModelSpec,
): ModelTierEvidenceLookup {
  const matches = catalogue.filter((entry) => entry.selector === model.model);
  if (matches.length === 0) return { status: "unknown", gap: "absent-from-catalogue" };
  if (matches.length > 1) return { status: "unknown", gap: "ambiguous-in-catalogue" };
  const [entry] = matches;
  if (entry === undefined) return { status: "unknown", gap: "absent-from-catalogue" };
  if (!entry.thinking.includes(model.thinking)) {
    return { status: "unknown", gap: "thinking-level-unsupported" };
  }
  return { status: "known", evidence: modelTierEvidence(entry, model.thinking) };
}

/** Builds tier evidence from a catalogue entry already known to support `thinking`. */
export function modelTierEvidence(
  entry: OmpModelRecord,
  thinking: ThinkingLevel,
): ModelTierEvidence {
  return {
    selector: entry.selector,
    provider: entry.provider,
    thinking,
    ...(entry.cost === undefined ? {} : { catalogueCost: entry.cost }),
    ...(entry.includedAllowance === undefined
      ? {}
      : { includedAllowance: entry.includedAllowance }),
  };
}

/**
 * Places a candidate against the incumbent on both axes at once. A known rise on either axis is a
 * premium move whatever the other axis says, which is what keeps a prepaid or bundled model from
 * reading as comparable; anything the catalogue left unpublished is reported as a gap instead.
 */
export function compareModelTier(
  incumbent: ModelTierEvidence,
  candidate: ModelTierEvidence,
): ModelTierComparison {
  const cost = compareCatalogueCost(incumbent, candidate);
  const quota = compareIncludedAllowance(incumbent, candidate);
  if (cost.status === "known" && cost.relation === "higher") {
    return {
      status: "premium",
      axis: "monetary-cost",
      cost: "higher",
      ...(quota.status === "known" ? { quota: quota.relation } : {}),
    };
  }
  if (quota.status === "known" && quota.relation === "higher") {
    return {
      status: "premium",
      axis: "quota-consumption",
      ...(cost.status === "known" ? { cost: cost.relation } : {}),
      quota: "higher",
    };
  }
  if (cost.status === "unknown" || quota.status === "unknown") {
    return {
      status: "indeterminate",
      gaps: [
        ...(cost.status === "unknown" ? [cost.gap] : []),
        ...(quota.status === "unknown" ? [quota.gap] : []),
      ],
    };
  }
  return { status: "comparable", cost: cost.relation, quota: quota.relation };
}

/** The catalogue's own cost figure for one model, or nothing when it published none. */
export function catalogueCostTotal(evidence: ModelTierEvidence): number | undefined {
  const cost = evidence.catalogueCost;
  return cost === undefined ? undefined : cost.input + cost.output;
}

type ModelTierAxis =
  | Readonly<{ readonly status: "known"; readonly relation: ModelTierAxisRelation }>
  | Readonly<{ readonly status: "unknown"; readonly gap: ModelTierEvidenceGap }>;

function relationOf(incumbent: number, candidate: number): ModelTierAxisRelation {
  if (candidate > incumbent) return "higher";
  return candidate < incumbent ? "lower" : "equal";
}

function compareCatalogueCost(
  incumbent: ModelTierEvidence,
  candidate: ModelTierEvidence,
): ModelTierAxis {
  const incumbentCost = catalogueCostTotal(incumbent);
  const candidateCost = catalogueCostTotal(candidate);
  if (incumbentCost === undefined || candidateCost === undefined) {
    return { status: "unknown", gap: "catalogue-cost-unpublished" };
  }
  return { status: "known", relation: relationOf(incumbentCost, candidateCost) };
}

/**
 * Included allowances compare only within one plan and one unit. Two models nobody published an
 * allowance for are not therefore equal: an unpublished draw is unknown consumption, not none.
 */
function compareIncludedAllowance(
  incumbent: ModelTierEvidence,
  candidate: ModelTierEvidence,
): ModelTierAxis {
  const incumbentAllowance = incumbent.includedAllowance;
  const candidateAllowance = candidate.includedAllowance;
  if (incumbentAllowance === undefined || candidateAllowance === undefined) {
    return { status: "unknown", gap: "included-allowance-unpublished" };
  }
  if (incumbentAllowance.plan !== candidateAllowance.plan) {
    return { status: "unknown", gap: "included-allowance-plan-differs" };
  }
  if (incumbentAllowance.unit !== candidateAllowance.unit) {
    return { status: "unknown", gap: "included-allowance-unit-differs" };
  }
  return {
    status: "known",
    relation: relationOf(incumbentAllowance.unitsPerRequest, candidateAllowance.unitsPerRequest),
  };
}
