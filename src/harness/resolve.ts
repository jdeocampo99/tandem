import type { AgentRole, ModelSpec } from "../contracts.ts";
import { claudeCodeHarness } from "./claude-code/launch.ts";
import { type Harness, type HarnessName, harnessOf, type KnownHarness } from "./contract.ts";
import { ompHarness } from "./omp/launch.ts";

/** Thrown when a role's model runs in a harness Tandem knows but cannot run that role on yet. */
export class HarnessUnavailableError extends Error {}

/** Each known harness and the roles Tandem can run on it: Claude Code workers come in step 6. */
const RUNNABLE: Readonly<
  Record<KnownHarness, Readonly<{ harness: Harness; roles: "all" | "coordinator" }>>
> = {
  omp: { harness: ompHarness, roles: "all" },
  "claude-code": { harness: claudeCodeHarness, roles: "coordinator" },
};

function runnable(name: HarnessName, role: AgentRole): Harness | undefined {
  const known: KnownHarness = name;
  const entry = RUNNABLE[known];
  return entry.roles === "all" || role === entry.roles ? entry.harness : undefined;
}

/**
 * The one place a recorded harness name becomes the harness that launches and recognizes `role`:
 * a coordinator record or a worker job spec.
 */
export function harnessFor(name: HarnessName, role: AgentRole): Harness {
  const harness = runnable(name, role);
  if (harness === undefined) {
    throw new HarnessUnavailableError(
      `This ${role}'s model runs in Claude Code, where Tandem can run only the coordinator so far. Pick a model from another provider for the ${role} with \`tandem configure\`.`,
    );
  }
  return harness;
}

/** The harness that runs `role` on `model`, refusing in plain English when Tandem can't run it. */
export function harnessForRole(role: AgentRole, model: ModelSpec | undefined): Harness {
  const harness = runnable(harnessOf(model), role);
  if (harness === undefined) {
    throw new HarnessUnavailableError(
      `The ${role}'s model is ${model?.model}, which runs in Claude Code. Tandem can run only the coordinator in Claude Code so far. Pick a model from another provider for this role with \`tandem configure\`.`,
    );
  }
  return harness;
}

/** Every harness a coordinator may run in, for recognizing one Tandem launched without a record. */
export function coordinatorHarnesses(): readonly Harness[] {
  return Object.values(RUNNABLE).map((entry) => entry.harness);
}

/**
 * OMP lists the models Tandem offers and picks on its own, and the MCP servers, for every role.
 * Claude Code models are never offered or picked automatically.
 */
export function catalogueHarness(): Harness {
  return ompHarness;
}
