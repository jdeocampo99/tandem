import {
  type AgentRole,
  MODEL_ROLE_ORDER,
  type ModelSpec,
  type ThinkingLevel,
} from "../contracts.ts";
import type { ModelRecord } from "../harness/contract.ts";

/**
 * Target thinking level per role for the Balanced profile. This mirrors the intent behind the
 * built-in role pins in `policy.ts` (planning/review favor deeper reasoning, research and
 * presentation favor speed) without reusing their fixed provider/model selectors, since Balanced
 * must resolve an exact selector dynamically from whichever providers the user has enabled.
 */
export const BALANCED_ROLE_THINKING: Readonly<Record<AgentRole, ThinkingLevel>> = {
  coordinator: "high",
  scout: "medium",
  implementer: "max",
  reviewer: "max",
  presentation: "low",
};

/** Roles whose work depends on strong reasoning; a candidate without explicit reasoning support is excluded. */
const BALANCED_ROLE_REQUIRES_REASONING: Readonly<Record<AgentRole, boolean>> = {
  coordinator: true,
  scout: false,
  implementer: true,
  reviewer: true,
  presentation: false,
};

export type BalancedRoleEvidence = Readonly<{
  readonly reasoning: boolean;
  readonly contextWindow?: number;
  readonly cost?: Readonly<{ readonly input: number; readonly output: number }>;
}>;

export type BalancedRoleProposal = Readonly<{
  readonly role: AgentRole;
  readonly provider: string;
  readonly model: ModelSpec;
  readonly evidence: BalancedRoleEvidence;
  readonly reason: string;
}>;

export type BalancedRoleGap = Readonly<{
  readonly role: AgentRole;
  readonly reason: string;
}>;

/**
 * The Balanced profile's resolution of every role. `resolved` carries a ready-to-save
 * `assignments` map alongside the per-role evidence and reasons; `unresolved` never carries partial
 * assignments so a caller cannot accidentally save an incomplete configuration.
 */
export type BalancedProfileProposal =
  | Readonly<{
      readonly status: "resolved";
      readonly roles: Readonly<Record<AgentRole, BalancedRoleProposal>>;
      readonly assignments: Readonly<Record<AgentRole, ModelSpec>>;
    }>
  | Readonly<{
      readonly status: "unresolved";
      readonly roles: Readonly<Partial<Record<AgentRole, BalancedRoleProposal>>>;
      readonly gaps: readonly BalancedRoleGap[];
    }>;

export type ResolveBalancedProfileInput = Readonly<{
  readonly catalogue: readonly ModelRecord[];
  /** Providers explicitly approved for spending; catalogue presence alone never authorizes selection. */
  readonly enabledProviders: ReadonlySet<string>;
}>;

/** Returns the distinct providers an OMP catalogue listing discovered, sorted for stable display. */
export function discoveredProviders(catalogue: readonly ModelRecord[]): readonly string[] {
  return [...new Set(catalogue.map((entry) => entry.provider))].sort();
}

/** Resolves the Balanced profile's exact selector and thinking level for every role, or fails closed. */
export function resolveBalancedProfile(
  input: ResolveBalancedProfileInput,
): BalancedProfileProposal {
  const roles: Partial<Record<AgentRole, BalancedRoleProposal>> = {};
  const gaps: BalancedRoleGap[] = [];
  for (const role of MODEL_ROLE_ORDER) {
    const outcome = resolveBalancedRole(role, input.catalogue, input.enabledProviders);
    if (outcome.status === "eligible") {
      roles[role] = outcome.proposal;
    } else {
      gaps.push({ role, reason: outcome.reason });
    }
  }
  if (gaps.length > 0) return { status: "unresolved", roles, gaps };
  const resolvedRoles = roles as Readonly<Record<AgentRole, BalancedRoleProposal>>;
  return { status: "resolved", roles: resolvedRoles, assignments: buildAssignments(resolvedRoles) };
}

function buildAssignments(
  roles: Readonly<Record<AgentRole, BalancedRoleProposal>>,
): Readonly<Record<AgentRole, ModelSpec>> {
  const assignments = {} as Record<AgentRole, ModelSpec>;
  for (const role of MODEL_ROLE_ORDER) assignments[role] = roles[role].model;
  return assignments;
}

type BalancedRoleOutcome =
  | Readonly<{ readonly status: "eligible"; readonly proposal: BalancedRoleProposal }>
  | Readonly<{ readonly status: "unresolved"; readonly reason: string }>;

function resolveBalancedRole(
  role: AgentRole,
  catalogue: readonly ModelRecord[],
  enabledProviders: ReadonlySet<string>,
): BalancedRoleOutcome {
  if (enabledProviders.size === 0) {
    return unresolvedRole("no provider is explicitly enabled for spending yet");
  }
  const fromEnabledProviders = catalogue.filter((candidate) =>
    enabledProviders.has(candidate.provider),
  );
  if (fromEnabledProviders.length === 0) {
    return unresolvedRole(
      `no models from the enabled provider(s) (${[...enabledProviders].sort().join(", ")}) were found in the OMP catalogue`,
    );
  }
  const targetThinking = BALANCED_ROLE_THINKING[role];
  const withThinking = fromEnabledProviders.filter((candidate) =>
    candidate.thinking.includes(targetThinking),
  );
  if (withThinking.length === 0) {
    return unresolvedRole(
      `no enabled-provider model supports the required '${targetThinking}' thinking level for this role`,
    );
  }
  const withEvidence = withThinking.filter(hasExplicitReasoningEvidence);
  if (withEvidence.length === 0) {
    return unresolvedRole(
      `enabled-provider models supporting '${targetThinking}' thinking have no explicit reasoning-capability evidence`,
    );
  }
  const eligible = BALANCED_ROLE_REQUIRES_REASONING[role]
    ? withEvidence.filter((candidate) => candidate.reasoning)
    : withEvidence;
  if (eligible.length === 0) {
    return unresolvedRole("no enabled-provider model has the reasoning support this role requires");
  }
  const chosen = pickBestCandidate(eligible);
  return { status: "eligible", proposal: buildRoleProposal(role, chosen, targetThinking) };
}

function unresolvedRole(
  reason: string,
): Readonly<{ readonly status: "unresolved"; readonly reason: string }> {
  return { status: "unresolved", reason };
}

function hasExplicitReasoningEvidence(
  candidate: ModelRecord,
): candidate is ModelRecord & Readonly<{ reasoning: boolean }> {
  return candidate.reasoning !== undefined;
}

/**
 * Deterministic tie-break among equally eligible candidates: broader context first, then lower
 * reported cost, then selector text, so the same catalogue always yields the same choice.
 */
function pickBestCandidate(
  candidates: readonly (ModelRecord & Readonly<{ reasoning: boolean }>)[],
): ModelRecord & Readonly<{ reasoning: boolean }> {
  const [best] = [...candidates].sort(compareBalancedCandidates);
  if (best === undefined) throw new Error("pickBestCandidate requires at least one candidate");
  return best;
}

function compareBalancedCandidates(a: ModelRecord, b: ModelRecord): number {
  const contextDelta = (b.contextWindow ?? -1) - (a.contextWindow ?? -1);
  if (contextDelta !== 0) return contextDelta;
  const costDelta = totalCost(a) - totalCost(b);
  if (costDelta !== 0) return costDelta;
  return a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0;
}

function totalCost(candidate: ModelRecord): number {
  return candidate.cost === undefined
    ? Number.POSITIVE_INFINITY
    : candidate.cost.input + candidate.cost.output;
}

function buildRoleProposal(
  role: AgentRole,
  candidate: ModelRecord & Readonly<{ reasoning: boolean }>,
  thinking: ThinkingLevel,
): BalancedRoleProposal {
  const evidence: BalancedRoleEvidence = {
    reasoning: candidate.reasoning,
    ...(candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow }),
    ...(candidate.cost === undefined ? {} : { cost: candidate.cost }),
  };
  const contextNote =
    evidence.contextWindow === undefined ? "" : `; context window ${evidence.contextWindow}`;
  return {
    role,
    provider: candidate.provider,
    model: { model: candidate.selector, thinking },
    evidence,
    reason: `provider ${candidate.provider} is enabled; ${candidate.selector} supports thinking '${thinking}' with explicit reasoning=${String(evidence.reasoning)}${contextNote}`,
  };
}
