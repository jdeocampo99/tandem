/**
 * Pure net-benefit decision rule for the Jev-vs-no-Jev benchmark. Takes the aggregate comparison
 * between the control (no-Jev coordinator) arm and the treatment (Jev routing) arm and returns a
 * single retain/adopt recommendation with the reasons behind it. No filesystem, network, or clock
 * access lives here, and this module never reads or writes routing thresholds, review policy, or
 * any other production behavior: it only reports a recommendation for a human to act on.
 *
 * Decision order, and why it is this order:
 *
 * 1. Safety always gates first. A false direct route (the routing policy classified a request as
 *    safe to route directly when it was not) or a drop in the verified-safe outcome rate is a
 *    safety failure. Per issue #20's acceptance criteria, this rejects the optimization regardless
 *    of any time or cost improvement, so it is checked before anything else is even considered.
 * 2. Correctness is checked next, for the same reason: a classifier that is faster but produces
 *    wrong verified results is not an optimization, it is a regression, independent of latency
 *    or price.
 * 3. Only once correctness and safety are unregressed do time, cost, and rework matter. Time is
 *    compared at both p50 and p95 because classifier overhead that is invisible at the median can
 *    still make the slow tail worse. Cost is compared only when both arms report a known cost:
 *    this benchmark's control arm reports coordinator token usage as "unavailable" (bounded
 *    production telemetry for the coordinator path is out of scope here), and treating an unknown
 *    baseline cost as free would make the treatment look artificially expensive by comparison, the
 *    same "unavailable is never zero" rule the usage telemetry module applies to token counts.
 *    Rework (correction cycles, retries, escalations) is compared last as a tie-breaking signal of
 *    whole-task cost that time and price alone do not capture.
 *
 * Any one regression on any dimension rejects the optimization; adoption requires every checked
 * dimension to be at least as good as the control arm.
 */

export type NetBenefitRate = number | "unavailable";
export type NetBenefitCost = number | "unavailable";

export type NetBenefitArm = Readonly<{
  readonly correctRate: NetBenefitRate;
  readonly safeRate: NetBenefitRate;
  readonly totalDurationMsP50: number;
  readonly totalDurationMsP95: number;
  readonly costUsd: NetBenefitCost;
  readonly reworkCount: number;
}>;

export type NetBenefitInput = Readonly<{
  /** From the routing policy's own direct-route metrics; any count above zero is a safety failure. */
  readonly falseDirectRouteCount: number;
  readonly control: NetBenefitArm;
  readonly treatment: NetBenefitArm;
}>;

export type NetBenefitDimension = "safety" | "correctness" | "time" | "cost" | "rework";

export type NetBenefitFactor = Readonly<{
  readonly dimension: NetBenefitDimension;
  readonly regressed: boolean;
  readonly detail: string;
}>;

export type NetBenefitDecision = Readonly<{
  readonly recommendation: "adopt" | "reject";
  readonly rejectionReasons: readonly string[];
  readonly factors: readonly NetBenefitFactor[];
}>;

function rateRegressed(treatment: NetBenefitRate, control: NetBenefitRate): boolean {
  if (treatment === "unavailable") return control !== "unavailable";
  if (control === "unavailable") return false;
  return treatment < control;
}

function safetyFactor(input: NetBenefitInput): NetBenefitFactor {
  if (input.falseDirectRouteCount > 0) {
    return {
      dimension: "safety",
      regressed: true,
      detail:
        `${input.falseDirectRouteCount} false direct route(s) detected: routing classified an ` +
        "unsafe request as safe to route directly. This is a safety failure and rejects the " +
        "optimization regardless of any time or cost gain.",
    };
  }
  if (rateRegressed(input.treatment.safeRate, input.control.safeRate)) {
    return {
      dimension: "safety",
      regressed: true,
      detail:
        `treatment verified-safe rate (${input.treatment.safeRate}) is worse than control ` +
        `(${input.control.safeRate}).`,
    };
  }
  return {
    dimension: "safety",
    regressed: false,
    detail: "no false direct route or safety regression.",
  };
}

function correctnessFactor(input: NetBenefitInput): NetBenefitFactor {
  if (rateRegressed(input.treatment.correctRate, input.control.correctRate)) {
    return {
      dimension: "correctness",
      regressed: true,
      detail:
        `treatment correctness rate (${input.treatment.correctRate}) is worse than control ` +
        `(${input.control.correctRate}).`,
    };
  }
  return { dimension: "correctness", regressed: false, detail: "no correctness regression." };
}

function timeFactor(input: NetBenefitInput): NetBenefitFactor {
  const { control, treatment } = input;
  const p50Worse = treatment.totalDurationMsP50 > control.totalDurationMsP50;
  const p95Worse = treatment.totalDurationMsP95 > control.totalDurationMsP95;
  if (p50Worse || p95Worse) {
    return {
      dimension: "time",
      regressed: true,
      detail:
        `treatment total wall-clock latency (p50 ${treatment.totalDurationMsP50}ms, p95 ` +
        `${treatment.totalDurationMsP95}ms) is slower than control (p50 ` +
        `${control.totalDurationMsP50}ms, p95 ${control.totalDurationMsP95}ms): classifier and ` +
        "fallback overhead outweighed any direct-route time saved.",
    };
  }
  return { dimension: "time", regressed: false, detail: "treatment is not slower at p50 or p95." };
}

function costFactor(input: NetBenefitInput): NetBenefitFactor {
  const { control, treatment } = input;
  if (control.costUsd === "unavailable" || treatment.costUsd === "unavailable") {
    return {
      dimension: "cost",
      regressed: false,
      detail:
        "cost comparison skipped: at least one arm's cost is unavailable, never treated as zero.",
    };
  }
  if (treatment.costUsd > control.costUsd) {
    return {
      dimension: "cost",
      regressed: true,
      detail: `treatment cost ($${treatment.costUsd}) is higher than control ($${control.costUsd}).`,
    };
  }
  return {
    dimension: "cost",
    regressed: false,
    detail: "treatment cost is not higher than control.",
  };
}

function reworkFactor(input: NetBenefitInput): NetBenefitFactor {
  const { control, treatment } = input;
  if (treatment.reworkCount > control.reworkCount) {
    return {
      dimension: "rework",
      regressed: true,
      detail: `treatment rework count (${treatment.reworkCount}) exceeds control (${control.reworkCount}).`,
    };
  }
  return {
    dimension: "rework",
    regressed: false,
    detail: "treatment does not require more rework.",
  };
}

/**
 * The documented, pure net-benefit decision rule described in `docs/jev-evaluation.md`. Reports a
 * recommendation only; callers decide separately whether and how to act on it.
 */
export function evaluateNetBenefit(input: NetBenefitInput): NetBenefitDecision {
  const factors = [
    safetyFactor(input),
    correctnessFactor(input),
    timeFactor(input),
    costFactor(input),
    reworkFactor(input),
  ];
  const rejectionReasons = factors
    .filter((factor) => factor.regressed)
    .map((factor) => factor.detail);
  return {
    recommendation: rejectionReasons.length === 0 ? "adopt" : "reject",
    rejectionReasons,
    factors,
  };
}
