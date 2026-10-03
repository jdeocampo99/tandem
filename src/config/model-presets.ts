import {
  type AgentRole,
  MODEL_ROLE_ORDER,
  type ModelSpec,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../contracts.ts";
import type { ClaudeCodeAvailability } from "../harness/claude-code/availability.ts";
import { CLAUDE_CODE_MODELS } from "../harness/claude-code/models.ts";
import type { ModelRecord } from "../harness/contract.ts";
import {
  BALANCED_ROLE_THINKING,
  discoveredProviders,
  resolveBalancedProfile,
} from "./operating-profile.ts";

/**
 * One-click model choices for all five roles, offered by the setup page and chat onboarding. A
 * preset only fills the choices; the user still sees and approves every role in the recap, and
 * may change any role first. Every model comes from the live OMP listing or the Claude Code
 * catalogue, never from a fixed name.
 */
export type ModelPresetId = "claude-codex" | "all-claude-code" | "all-omp";

export type ModelPreset = Readonly<{ id: ModelPresetId; name: string; summary: string }> &
  (
    | Readonly<{ status: "ready"; models: Readonly<Record<AgentRole, ModelSpec>> }>
    | Readonly<{ status: "disabled"; reason: string }>
  );

export type ModelPresetFacts = Readonly<{
  ompCatalogue: readonly ModelRecord[];
  claudeCode: ClaudeCodeAvailability;
}>;

type ClaudeCodeAlias = "fable" | "opus" | "sonnet" | "haiku";

/** Where a preset takes one role's model from. */
type RoleSource =
  | Readonly<{ kind: "claude-code"; alias: ClaudeCodeAlias }>
  | Readonly<{ kind: "best-codex" }>
  | Readonly<{ kind: "balanced-omp" }>;

const claudeCode = (alias: ClaudeCodeAlias): RoleSource => ({ kind: "claude-code", alias });
const BEST_CODEX: RoleSource = { kind: "best-codex" };
const BALANCED_OMP: RoleSource = { kind: "balanced-omp" };

type PresetDefinition = Readonly<{
  id: ModelPresetId;
  name: string;
  summary: string;
  roles: Readonly<Record<AgentRole, RoleSource>>;
}>;

const PRESETS: readonly PresetDefinition[] = [
  {
    id: "claude-codex",
    name: "Claude coordinates, Codex researches and reviews",
    summary:
      "Planning, coding, and mockups in Claude Code; research and review on OMP's top Codex model.",
    roles: {
      coordinator: claudeCode("opus"),
      scout: BEST_CODEX,
      implementer: claudeCode("opus"),
      reviewer: BEST_CODEX,
      presentation: claudeCode("sonnet"),
    },
  },
  {
    id: "all-claude-code",
    name: "All Claude Code",
    summary: "Every job in Claude Code, on your Claude subscription.",
    roles: {
      coordinator: claudeCode("opus"),
      scout: claudeCode("sonnet"),
      implementer: claudeCode("opus"),
      reviewer: claudeCode("fable"),
      presentation: claudeCode("sonnet"),
    },
  },
  {
    id: "all-omp",
    name: "All OMP",
    summary: "Every job in OMP: the Balanced profile over every provider OMP lists.",
    roles: {
      coordinator: BALANCED_OMP,
      scout: BALANCED_OMP,
      implementer: BALANCED_OMP,
      reviewer: BALANCED_OMP,
      presentation: BALANCED_OMP,
    },
  },
];

/** OMP providers serving OpenAI's models, most preferred first. */
const CODEX_PROVIDERS = ["openai-codex", "openai"] as const;

const CLAUDE_CODE_UNAVAILABLE: Readonly<Record<Exclude<ClaudeCodeAvailability, "ready">, string>> =
  {
    "not-installed": "Claude Code isn't installed. Install it, then reopen setup.",
    "mods-off":
      "Claude Code's managed settings switch off mods (disableAllHooks), so Tandem can't run in it.",
  };

type RoleOutcome =
  | Readonly<{ ok: true; spec: ModelSpec }>
  | Readonly<{ ok: false; reason: string }>;

export function modelPresets(facts: ModelPresetFacts): readonly ModelPreset[] {
  const balanced = resolveBalancedProfile({
    catalogue: facts.ompCatalogue,
    enabledProviders: new Set(discoveredProviders(facts.ompCatalogue)),
  });
  const codex = bestCodexModel(facts.ompCatalogue);
  const resolveRole = (role: AgentRole, source: RoleSource): RoleOutcome => {
    switch (source.kind) {
      case "claude-code": {
        if (facts.claudeCode !== "ready") {
          return { ok: false, reason: CLAUDE_CODE_UNAVAILABLE[facts.claudeCode] };
        }
        const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === source.alias);
        if (model === undefined) {
          return { ok: false, reason: `Claude Code has no ${source.alias} model.` };
        }
        return { ok: true, spec: specFor(model, role) };
      }
      case "best-codex":
        return codex === undefined
          ? {
              ok: false,
              reason:
                "OMP lists no Codex or OpenAI model. Sign in to Codex in OMP, then reopen setup.",
            }
          : { ok: true, spec: specFor(codex, role) };
      case "balanced-omp": {
        if (facts.ompCatalogue.length === 0) {
          return {
            ok: false,
            reason: "OMP lists no models. Add a provider in OMP, then reopen setup.",
          };
        }
        const proposal = balanced.roles[role];
        if (proposal !== undefined) return { ok: true, spec: proposal.model };
        const gap =
          balanced.status === "unresolved" ? balanced.gaps.find((g) => g.role === role) : undefined;
        return {
          ok: false,
          reason: `OMP has no model for ${role}: ${gap?.reason ?? "none fits"}.`,
        };
      }
    }
  };
  return PRESETS.map((preset) => presetFrom(preset, resolveRole));
}

function presetFrom(
  preset: PresetDefinition,
  resolveRole: (role: AgentRole, source: RoleSource) => RoleOutcome,
): ModelPreset {
  const { id, name, summary } = preset;
  const models: Partial<Record<AgentRole, ModelSpec>> = {};
  for (const role of MODEL_ROLE_ORDER) {
    const outcome = resolveRole(role, preset.roles[role]);
    if (!outcome.ok) return { id, name, summary, status: "disabled", reason: outcome.reason };
    models[role] = outcome.spec;
  }
  return {
    id,
    name,
    summary,
    status: "ready",
    models: models as Readonly<Record<AgentRole, ModelSpec>>,
  };
}

/**
 * The top Codex model: from the most preferred OpenAI provider OMP lists, the reasoning model
 * with the highest published price, which is how the catalogue marks a flagship.
 */
function bestCodexModel(catalogue: readonly ModelRecord[]): ModelRecord | undefined {
  for (const provider of CODEX_PROVIDERS) {
    const [best] = catalogue
      .filter((model) => model.provider === provider && model.reasoning === true)
      .filter((model) => model.thinking.length > 0)
      .sort(byPriceThenSelector);
    if (best !== undefined) return best;
  }
  return undefined;
}

function byPriceThenSelector(a: ModelRecord, b: ModelRecord): number {
  const price = (model: ModelRecord) => model.cost?.output ?? Number.NEGATIVE_INFINITY;
  const input = (model: ModelRecord) => model.cost?.input ?? Number.NEGATIVE_INFINITY;
  return price(b) - price(a) || input(b) - input(a) || a.selector.localeCompare(b.selector);
}

function specFor(model: ModelRecord, role: AgentRole): ModelSpec {
  return {
    model: model.selector,
    thinking: nearestThinking(model.thinking, BALANCED_ROLE_THINKING[role]),
  };
}

/** The supported level closest to the one wanted, preferring the lower one on a tie. */
export function nearestThinking(
  levels: readonly ThinkingLevel[],
  want: ThinkingLevel,
): ThinkingLevel {
  if (levels.includes(want)) return want;
  const rank = (level: ThinkingLevel) => THINKING_LEVELS.indexOf(level);
  const [closest] = [...levels].sort(
    (a, b) => Math.abs(rank(a) - rank(want)) - Math.abs(rank(b) - rank(want)) || rank(a) - rank(b),
  );
  if (closest === undefined) throw new Error("nearestThinking needs at least one level");
  return closest;
}
