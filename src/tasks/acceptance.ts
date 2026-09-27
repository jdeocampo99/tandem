import { createHash } from "node:crypto";
import type {
  CheckOrigin,
  ContractIdentity,
  IterationScope,
  PinnedValidationEvidence,
  ResolvedPolicy,
  ReviewLens,
  TaskRecord,
  ValidationCommand,
  ValidationEvidence,
} from "../contracts.ts";
import { LEGACY_EVIDENCE_CONTRACT } from "../contracts.ts";
import { failedChecks } from "./findings.ts";

/** The one reviewer session the final acceptance manifest requires per round. */
export const FINAL_REVIEW_LENSES: readonly ReviewLens[] = ["review"];

/** One item the final manifest requires, named together with the check runner that owns it. */
export type FinalRequirement = Readonly<{
  readonly name: string;
  readonly origin: CheckOrigin;
}>;

/** The complete manifest a candidate must satisfy before it can be delivered. */
export type FinalAcceptanceContract = Readonly<{
  readonly contract: "final";
  readonly identity: ContractIdentity;
  readonly surfaces: readonly string[];
  readonly commands: readonly ValidationCommand[];
  readonly requirements: readonly FinalRequirement[];
  readonly lenses: readonly ReviewLens[];
  readonly criteria: readonly string[];
}>;

/** The targeted reproduction and affected checks authorized between fix rounds. */
export type IterationContract = Readonly<{
  readonly contract: "iteration";
  readonly identity: ContractIdentity;
  readonly surfaces: readonly string[];
  readonly commands: readonly ValidationCommand[];
  readonly scope: IterationScope;
}>;

export type ValidationPlan = IterationContract | FinalAcceptanceContract;

/** Why targeted checks were refused in favour of the complete manifest. */
export type EscalationReason =
  | "unknown-impact"
  | "broad-impact"
  | "stale-identity"
  | "disputed-result";

export type PlannedValidation = Readonly<{
  readonly plan: ValidationPlan;
  readonly escalation?: EscalationReason;
}>;

/** What the final manifest still needs before the candidate can be accepted. */
export type FinalAcceptanceStatus = Readonly<{
  readonly satisfied: boolean;
  readonly identity: ContractIdentity;
  readonly missing: readonly FinalRequirement[];
  readonly failed: readonly FinalRequirement[];
  readonly stale: readonly FinalRequirement[];
  readonly pendingLenses: readonly ReviewLens[];
}>;

export class ValidationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ValidationConfigurationError";
  }
}

function readHead(head: string): string {
  if (typeof head !== "string" || head.trim().length === 0) {
    throw new TypeError("contract head must be a non-empty string");
  }
  return head;
}

function deduplicate(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function commandCoversSurfaces(command: ValidationCommand, surfaces: readonly string[]): boolean {
  if (command.surfaces.length === 0 || command.surfaces.includes("*") || surfaces.includes("*")) {
    return true;
  }
  return command.surfaces.some((surface) => surfaces.includes(surface));
}

/** Narrows to evidence that names a contract and identity; legacy records never qualify. */
export function isPinnedEvidence(entry: ValidationEvidence): entry is PinnedValidationEvidence {
  return entry.contract !== LEGACY_EVIDENCE_CONTRACT;
}

/** Digests the pinned policy so evidence recorded under a different policy is detectable. */
export function policyIdentity(policy: ResolvedPolicy): string {
  const serialized = JSON.stringify(policy);
  if (serialized === undefined) throw new TypeError("policy could not be serialized");
  return createHash("sha256").update(serialized).digest("hex");
}

/** Pins a contract to the delivered code, generation, and policy. */
export function contractIdentity(task: TaskRecord, head: string): ContractIdentity {
  return {
    head: readHead(head),
    generation: task.generation,
    policyDigest: policyIdentity(task.policy),
  };
}

/** Builds the complete command and criterion manifest for the candidate at `head`. */
export function finalAcceptanceContract(task: TaskRecord, head: string): FinalAcceptanceContract {
  const identity = contractIdentity(task, head);
  const surfaces = [...task.surfaces];
  const commands = task.policy.config.validationCommands.filter((command) =>
    commandCoversSurfaces(command, surfaces),
  );
  if (commands.length === 0) {
    throw new ValidationConfigurationError(
      surfaces.length === 0
        ? "no validation commands are configured"
        : `no validation commands match surfaces: ${surfaces.join(", ")}`,
    );
  }
  return {
    contract: "final",
    identity,
    surfaces,
    commands: commands.map((command) => ({ ...command, argv: [...command.argv] })),
    requirements: commands.map((command) => ({ name: command.name, origin: "local" as const })),
    lenses: FINAL_REVIEW_LENSES,
    criteria: [...task.acceptanceCriteria],
  };
}

function failingFindingIds(task: TaskRecord): readonly string[] {
  const ids: string[] = [];
  for (const review of task.reviews) {
    if (review.head !== task.reviewHead || review.generation !== task.generation || review.pass) {
      continue;
    }
    for (const finding of review.findings) ids.push(finding.id);
  }
  return deduplicate(ids);
}

/**
 * Records what the next fix round targets, taken from the checks that reported the failure and the
 * findings that must be resolved. Returns undefined when the candidate failed nothing observable.
 */
export function iterationScopeFor(task: TaskRecord): IterationScope | undefined {
  const head = task.reviewHead;
  if (head === undefined) return undefined;
  const reproduces = failedChecks(task);
  const findingIds = failingFindingIds(task);
  if (reproduces.length === 0 && findingIds.length === 0) return undefined;
  const targeted = task.policy.config.validationCommands.filter((command) =>
    reproduces.includes(command.name),
  );
  const surfaces = deduplicate(targeted.flatMap((command) => command.surfaces));
  return {
    head,
    generation: task.generation,
    policyDigest: policyIdentity(task.policy),
    reproduces,
    surfaces,
    findingIds,
  };
}

/** Reports which manifest items and lenses the recorded evidence and reviews still leave open. */
export function finalAcceptanceStatus(task: TaskRecord, head: string): FinalAcceptanceStatus {
  const manifest = finalAcceptanceContract(task, head);
  const identity = manifest.identity;
  const missing: FinalRequirement[] = [];
  const failed: FinalRequirement[] = [];
  const stale: FinalRequirement[] = [];

  const pinned = task.validationEvidence.filter(isPinnedEvidence);
  for (const requirement of manifest.requirements) {
    const recorded = pinned.filter(
      (entry) =>
        entry.contract === "final" &&
        entry.name === requirement.name &&
        entry.origin === requirement.origin,
    );
    const current = recorded.filter(
      (entry) => entry.head === identity.head && entry.policyDigest === identity.policyDigest,
    );
    if (current.length === 0) {
      (recorded.length === 0 ? missing : stale).push(requirement);
      continue;
    }
    if (current.some((entry) => entry.exitCode !== 0)) failed.push(requirement);
  }

  const pendingLenses = manifest.lenses.filter(
    (lens) =>
      !task.reviews.some(
        (review) =>
          review.lens === lens &&
          review.head === identity.head &&
          review.generation === identity.generation &&
          review.pass,
      ),
  );

  return {
    satisfied:
      missing.length === 0 &&
      failed.length === 0 &&
      stale.length === 0 &&
      pendingLenses.length === 0,
    identity,
    missing,
    failed,
    stale,
    pendingLenses,
  };
}

/**
 * Whether a finished round at `head` can go straight to review. It can when the complete manifest
 * already passed at this HEAD and policy, or when the round only answered review findings after
 * every check passed; that round's checks then run once, as the final manifest, after review passes.
 */
export function canSkipValidation(task: TaskRecord, head: string): boolean {
  const scope = task.iterationScope;
  if (
    scope !== undefined &&
    scope.reproduces.length === 0 &&
    scope.policyDigest === policyIdentity(task.policy)
  ) {
    return true;
  }
  try {
    const status = finalAcceptanceStatus(task, head);
    return status.missing.length === 0 && status.failed.length === 0 && status.stale.length === 0;
  } catch (error) {
    // Validation runs anyway so the configuration refusal reaches the user through the runner.
    if (error instanceof ValidationConfigurationError) return false;
    throw error;
  }
}

/**
 * Chooses the contract for the next validation run: targeted iteration checks when the recorded
 * scope is contained and current, and the complete final manifest otherwise. A targeted plan is
 * never returned once every required lens passes, so a final run always precedes acceptance.
 */
export function planValidation(task: TaskRecord, head: string): PlannedValidation {
  const manifest = finalAcceptanceContract(task, head);
  const identity = manifest.identity;
  const scope = task.iterationScope;
  if (scope === undefined) return { plan: manifest };
  if (scope.policyDigest !== identity.policyDigest) {
    return { plan: manifest, escalation: "stale-identity" };
  }
  if (scope.reproduces.length === 0) {
    return { plan: manifest, escalation: "disputed-result" };
  }
  const commands = manifest.commands.filter((command) => scope.reproduces.includes(command.name));
  if (commands.length !== scope.reproduces.length) {
    return { plan: manifest, escalation: "unknown-impact" };
  }
  if (commands.length === manifest.commands.length) {
    return { plan: manifest, escalation: "broad-impact" };
  }
  if (finalAcceptanceStatus(task, head).pendingLenses.length === 0) {
    return { plan: manifest };
  }
  return {
    plan: {
      contract: "iteration",
      identity,
      surfaces: [...scope.surfaces],
      commands,
      scope,
    },
  };
}
