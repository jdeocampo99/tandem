import { expect, test } from "bun:test";
import type {
  PinnedValidationEvidence,
  ResolvedPolicy,
  ReviewResult,
  TaskRecord,
  ValidationCommand,
} from "../../src/contracts.ts";
import {
  canSkipValidation,
  finalAcceptanceContract,
  finalAcceptanceStatus,
  isUnvalidatedPolicy,
  iterationScopeFor,
  policyIdentity,
  ValidationConfigurationError,
} from "../../src/tasks/acceptance.ts";

const HEAD = "head-1";

function command(name: string, surfaces: readonly string[]): ValidationCommand {
  return { name, argv: ["bun", "run", name], surfaces, timeoutMs: 10_000 };
}

function policyWith(commands: readonly ValidationCommand[]): ResolvedPolicy {
  return {
    config: {
      version: 1,
      models: {
        coordinator: { model: "test/coordinator", thinking: "low" },
        scout: { model: "test/scout", thinking: "low" },
        implementer: { model: "test/implementer", thinking: "low" },
        reviewer: { model: "test/reviewer", thinking: "low" },
        presentation: { model: "test/presentation", thinking: "low" },
      },
      instructions: { implementation: [], validation: [], review: [] },
      instructionFiles: { implementation: [], validation: [], review: [] },
      validationCommands: commands,
      setupCommands: [],
      maxFixRounds: 3,
    },
    guidance: { implementation: [], validation: [], review: [] },
  };
}

const defaultPolicy = policyWith([
  command("lint", ["service"]),
  command("test", ["service"]),
  command("docs", ["docs"]),
]);

function evidence(
  input: Readonly<{
    name: string;
    contract: PinnedValidationEvidence["contract"];
    exitCode?: number;
    head?: string;
    policyDigest?: string;
  }>,
): PinnedValidationEvidence {
  return {
    name: input.name,
    argv: ["bun", "run", input.name],
    exitCode: input.exitCode ?? 0,
    stdout: "",
    stderr: "",
    head: input.head ?? HEAD,
    contract: input.contract,
    origin: "local",
    policyDigest: input.policyDigest ?? policyIdentity(defaultPolicy),
  };
}

function review(lens: ReviewResult["lens"], pass = true, findingIds: readonly string[] = []) {
  return {
    lens,
    head: HEAD,
    generation: 1,
    pass,
    findings: findingIds.map((id) => ({
      id,
      severity: "P1" as const,
      verdict: "confirmed" as const,
      description: `${id} must be fixed`,
    })),
    summary: `${lens} review recorded`,
  };
}

function task(
  overrides: Partial<TaskRecord> = {},
  policy: ResolvedPolicy = defaultPolicy,
): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 4,
    repoPath: "/repo",
    kind: "implementation",
    objective: "Deliver the change",
    acceptanceCriteria: ["The change is durable"],
    surfaces: ["service"],
    stage: "validating",
    scopeApproved: true,
    policy,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    generation: 1,
    reviewRound: 1,
    reviewHead: HEAD,
    validationEvidence: [],
    reviews: [],
    notifications: [],
    ...overrides,
  };
}

test("the final manifest selects surface-matching, wildcard, and globally-scoped checks", () => {
  const policy = policyWith([
    command("global", []),
    command("lint", ["service"]),
    command("docs", ["docs"]),
    command("wildcard", ["*"]),
  ]);
  const manifest = finalAcceptanceContract(task({}, policy), HEAD);

  expect(manifest.contract).toBe("final");
  expect(manifest.requirements).toEqual([
    { name: "global", origin: "local" },
    { name: "lint", origin: "local" },
    { name: "wildcard", origin: "local" },
  ]);
  expect(manifest.lenses).toEqual(["review"]);
  expect(manifest.criteria).toEqual(["The change is durable"]);
  expect(manifest.identity).toEqual({
    head: HEAD,
    generation: 1,
    policyDigest: policyIdentity(policy),
  });
});

test("a manifest with no matching check is a configuration failure rather than an empty pass", () => {
  expect(() => finalAcceptanceContract(task({ surfaces: ["unmapped"] }), HEAD)).toThrow(
    ValidationConfigurationError,
  );
  // Zero commands without the explicit "no checks" choice is never configured, never a pass.
  expect(() => finalAcceptanceContract(task({}, policyWith([])), HEAD)).toThrow(
    "no validation commands are configured",
  );
});

test("a project that chose no checks accepts on review alone, labeled unvalidated", () => {
  const base = policyWith([]);
  const noChecks: ResolvedPolicy = { ...base, config: { ...base.config, validation: "none" } };
  const manifest = finalAcceptanceContract(task({}, noChecks), HEAD);
  expect(manifest).toMatchObject({ commands: [], requirements: [], unvalidated: true });
  expect(manifest.lenses).toEqual(["review"]);
  expect(isUnvalidatedPolicy(noChecks.config)).toBe(true);
  expect(isUnvalidatedPolicy(base.config)).toBe(false);

  const unreviewed = finalAcceptanceStatus(task({}, noChecks), HEAD);
  expect(unreviewed).toMatchObject({
    satisfied: false,
    pendingLenses: ["review"],
    unvalidated: true,
  });
  expect(canSkipValidation(task({}, noChecks), HEAD)).toBe(true);
  const reviewed = finalAcceptanceStatus(task({ reviews: [review("review")] }, noChecks), HEAD);
  expect(reviewed).toMatchObject({ satisfied: true, missing: [], unvalidated: true });
  // Configured commands keep the manifest validated.
  expect(finalAcceptanceContract(task(), HEAD).unvalidated).toBe(false);
});

test("an iteration scope records the checks that reported the failure and the findings to resolve", () => {
  const scope = iterationScopeFor(
    task({
      validationEvidence: [
        evidence({ name: "lint", contract: "final", exitCode: 1 }),
        evidence({ name: "test", contract: "final" }),
      ],
      reviews: [review("review", false, ["finding-1"])],
    }),
  );

  expect(scope).toEqual({
    head: HEAD,
    generation: 1,
    policyDigest: policyIdentity(defaultPolicy),
    reproduces: ["lint"],
    surfaces: ["service"],
    findingIds: ["finding-1"],
  });
});

test("an iteration scope lists only the blocking findings, leaving P2 and P3 as known issues", () => {
  const failed = review("review", false, ["blocker"]);
  const scope = iterationScopeFor(
    task({
      reviews: [
        {
          ...failed,
          findings: [
            ...failed.findings,
            { id: "nit", severity: "P2", verdict: "confirmed", description: "nit is minor" },
            { id: "style", severity: "P3", verdict: "plausible", description: "style is minor" },
          ],
        },
      ],
    }),
  );

  expect(scope?.findingIds).toEqual(["blocker"]);
});

test("a finished fix round skips validation only when every check already passed at its HEAD", () => {
  const reviewOnlyScope = {
    head: "head-0",
    generation: 0,
    policyDigest: policyIdentity(defaultPolicy),
    reproduces: [],
    surfaces: [],
    findingIds: ["finding-1"],
  };

  expect(canSkipValidation(task({ iterationScope: reviewOnlyScope }), HEAD)).toBe(false);
  expect(
    canSkipValidation(
      task({
        iterationScope: reviewOnlyScope,
        validationEvidence: [evidence({ name: "lint", contract: "final" })],
      }),
      HEAD,
    ),
  ).toBe(false);
  expect(
    canSkipValidation(
      task({
        iterationScope: reviewOnlyScope,
        validationEvidence: [
          evidence({ name: "lint", contract: "final" }),
          evidence({ name: "test", contract: "final" }),
        ],
      }),
      HEAD,
    ),
  ).toBe(true);
});

test("passing iteration evidence never satisfies the final manifest", () => {
  const status = finalAcceptanceStatus(
    task({
      validationEvidence: [
        evidence({ name: "lint", contract: "iteration" }),
        evidence({ name: "test", contract: "iteration" }),
      ],
      reviews: [review("review")],
    }),
    HEAD,
  );

  expect(status.satisfied).toBe(false);
  expect(status.missing.map((entry) => entry.name)).toEqual(["lint", "test"]);
});

test("final evidence recorded under a superseded policy identity reads as stale, not passing", () => {
  const status = finalAcceptanceStatus(
    task({
      validationEvidence: [
        evidence({ name: "lint", contract: "final", policyDigest: "superseded" }),
        evidence({ name: "test", contract: "final" }),
      ],
      reviews: [review("review")],
    }),
    HEAD,
  );

  expect(status.satisfied).toBe(false);
  expect(status.stale.map((entry) => entry.name)).toEqual(["lint"]);
  expect(status.missing).toHaveLength(0);
});

test("a complete final run at the delivered identity with passing lenses satisfies acceptance", () => {
  const status = finalAcceptanceStatus(
    task({
      validationEvidence: [
        evidence({ name: "lint", contract: "iteration" }),
        evidence({ name: "lint", contract: "final" }),
        evidence({ name: "test", contract: "final" }),
      ],
      reviews: [review("review")],
    }),
    HEAD,
  );

  expect(status.satisfied).toBe(true);
});

test("a final check recorded at another HEAD leaves the manifest unsatisfied", () => {
  const status = finalAcceptanceStatus(
    task({
      validationEvidence: [
        evidence({ name: "lint", contract: "final", head: "head-0" }),
        evidence({ name: "test", contract: "final" }),
      ],
      reviews: [review("review")],
    }),
    HEAD,
  );

  expect(status.satisfied).toBe(false);
  expect(status.stale.map((entry) => entry.name)).toEqual(["lint"]);
});
