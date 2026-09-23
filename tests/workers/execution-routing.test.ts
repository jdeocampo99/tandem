import { expect, test } from "bun:test";
import type { OmpIncludedAllowance, OmpModelRecord } from "../../src/adapters/omp.ts";
import type { ModelSpec, ThinkingLevel } from "../../src/contracts.ts";
import type { DurableExecutionRouting, ExecutionRoutingLimits } from "../../src/runtime/schema.ts";
import {
  authorizeExecutionModel,
  describeExecutionRoutingDecision,
  type ExecutionRoutingBoundary,
  type ExecutionRoutingDecision,
  type ExecutionRoutingRequest,
  type ExecutionUsageObservation,
  executionRoutingPauseStands,
  type ModelCatalogueSnapshot,
  type PriorExecutionAttempt,
  type RequestUsageExposure,
  resolvedExecutionModel,
  resolveExecutionRouting,
} from "../../src/workers/execution-routing.ts";
import { expectNoIdentifiers } from "../tasks/question.test.ts";

const PINNED: ModelSpec = { model: "alpha/base", thinking: "high" };

/** A request whose own usage the ledger could fully observe, which is the rare case. */
const MEASURED: RequestUsageExposure = { unaccountedSamples: 0, unmeasuredTokenSamples: 0 };

const OBSERVED: ExecutionUsageObservation = { status: "observed", exposure: MEASURED };

const LIMITS: ExecutionRoutingLimits = {
  maxWorkers: 3,
};

type CatalogueOverrides = Readonly<{
  readonly thinking?: readonly ThinkingLevel[];
  readonly cost?: Readonly<{ readonly input: number; readonly output: number }>;
  readonly includedAllowance?: OmpIncludedAllowance;
}>;

function catalogueEntry(selector: string, overrides: CatalogueOverrides = {}): OmpModelRecord {
  return {
    selector,
    id: selector,
    provider: selector.split("/")[0] ?? selector,
    thinking: overrides.thinking ?? ["medium", "high", "max"],
    ...(overrides.cost === undefined ? {} : { cost: overrides.cost }),
    ...(overrides.includedAllowance === undefined
      ? {}
      : { includedAllowance: overrides.includedAllowance }),
  };
}

function snapshot(
  models: readonly OmpModelRecord[],
  enabledProviders: readonly string[],
): ModelCatalogueSnapshot {
  return { status: "read", models, enabledProviders, readAt: "2030-01-01T00:00:00.000Z" };
}

function safeFailure(selector = PINNED.model): PriorExecutionAttempt {
  return { operationId: "operation-0", selector, outcome: "known-safe-failure" };
}

function routingRequest(overrides: Partial<ExecutionRoutingRequest> = {}): ExecutionRoutingRequest {
  return {
    boundary: { kind: "job-launch" },
    identity: {
      requestId: "request-1",
      taskId: "task-1",
      jobId: "job-1",
      operationId: "operation-1",
      role: "implementer",
      generation: 2,
      attempt: 1,
      policyDigest: "policy-digest",
      inputHead: "head-1",
    },
    pinned: PINNED,
    catalogue: snapshot([catalogueEntry(PINNED.model)], ["alpha"]),
    limits: LIMITS,
    usage: OBSERVED,
    now: "2030-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function replacementBoundary(
  prior: PriorExecutionAttempt = safeFailure(),
): ExecutionRoutingBoundary {
  return { kind: "replacement-attempt", prior };
}

function authorizedRouting(decision: ExecutionRoutingDecision): DurableExecutionRouting {
  if (decision.outcome !== "authorized") {
    throw new Error(`expected an authorized routing, got ${decision.pause.reason}`);
  }
  return decision.routing;
}

function pauseOf(decision: ExecutionRoutingDecision) {
  if (decision.outcome !== "paused") {
    throw new Error(`expected a routing question, got ${decision.routing.basis}`);
  }
  return decision.pause;
}

test("a job launch records the pinned assignment with the identity and limits it ran under", () => {
  const routing = authorizedRouting(resolveExecutionRouting(routingRequest()));

  expect(routing.basis).toBe("pinned-policy");
  expect(routing.selector).toBe(PINNED.model);
  expect(routing.thinking).toBe("high");
  expect(routing.provider).toBe("alpha");
  expect(routing.replaces).toBeUndefined();
  expect(routing.requestId).toBe("request-1");
  expect(routing.taskId).toBe("task-1");
  expect(routing.jobId).toBe("job-1");
  expect(routing.operationId).toBe("operation-1");
  expect(routing.generation).toBe(2);
  expect(routing.attempt).toBe(1);
  expect(routing.limits).toEqual(LIMITS);
  expect(routing.evidence.source).toBe("catalogue-read");
  expect(routing.evidence.enabledProviders).toEqual(["alpha"]);
});

/** The catalogue in which `alpha/thrifty` would otherwise be an automatic comparable reassignment. */
function reassignableCatalogue(): ModelCatalogueSnapshot {
  return snapshot(
    [
      catalogueEntry(PINNED.model, {
        cost: { input: 4, output: 4 },
        includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 2 },
      }),
      catalogueEntry("alpha/thrifty", {
        cost: { input: 1, output: 1 },
        includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
      }),
    ],
    ["alpha"],
  );
}

test("unmeasured request usage keeps the pinned model instead of reassigning or asking", () => {
  for (const exposure of [
    { unaccountedSamples: 2, unmeasuredTokenSamples: 5 },
    { unaccountedSamples: 0, unmeasuredTokenSamples: 1 },
  ]) {
    const routing = authorizedRouting(
      resolveExecutionRouting(
        routingRequest({
          usage: { status: "observed", exposure },
          boundary: replacementBoundary(),
          catalogue: reassignableCatalogue(),
        }),
      ),
    );

    expect(routing.basis).toBe("pinned-policy");
    expect(routing.selector).toBe("alpha/base");
    expect(routing.evidence.unaccountedSamples).toBe(exposure.unaccountedSamples);
    expect(routing.evidence.unmeasuredTokenSamples).toBe(exposure.unmeasuredTokenSamples);
  }
});

test("a task with no governing request keeps the pinned model on a replacement attempt", () => {
  const routing = authorizedRouting(
    resolveExecutionRouting(
      routingRequest({
        usage: { status: "no-governing-request" },
        boundary: replacementBoundary(),
        catalogue: reassignableCatalogue(),
      }),
    ),
  );

  expect(routing.basis).toBe("pinned-policy");
  expect(routing.evidence.usageSource).toBe("no-governing-request");
});

test("unmeasured usage leaves an unchanged pinned launch alone", () => {
  const routing = authorizedRouting(
    resolveExecutionRouting(
      routingRequest({
        usage: {
          status: "observed",
          exposure: { unaccountedSamples: 4, unmeasuredTokenSamples: 9 },
        },
      }),
    ),
  );

  expect(routing.basis).toBe("pinned-policy");
  expect(routing.evidence.unaccountedSamples).toBe(4);
  expect(routing.evidence.unmeasuredTokenSamples).toBe(9);
});

test("an uncertain prior outcome is never replaced automatically", () => {
  const decision = resolveExecutionRouting(
    routingRequest({
      boundary: replacementBoundary({
        operationId: "operation-0",
        selector: PINNED.model,
        outcome: "uncertain",
      }),
      catalogue: snapshot(
        [
          catalogueEntry(PINNED.model, {
            cost: { input: 2, output: 2 },
            includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
          }),
          catalogueEntry("alpha/twin", {
            cost: { input: 2, output: 2 },
            includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
          }),
        ],
        ["alpha"],
      ),
    }),
  );

  expect(pauseOf(decision).reason).toBe("prior-outcome-uncertain");
});

test("a known safe failure reassigns to the comparable candidate with a known included allowance", () => {
  const routing = authorizedRouting(
    resolveExecutionRouting(
      routingRequest({
        boundary: replacementBoundary(),
        catalogue: snapshot(
          [
            catalogueEntry(PINNED.model, {
              cost: { input: 2, output: 2 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 2 },
            }),
            catalogueEntry("alpha/included", {
              cost: { input: 2, output: 2 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
            catalogueEntry("alpha/unpriced", {
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
          ],
          ["alpha"],
        ),
      }),
    ),
  );

  expect(routing.basis).toBe("comparable-reassignment");
  expect(routing.selector).toBe("alpha/included");
  expect(routing.replaces).toEqual({ selector: PINNED.model, thinking: "high" });
  expect(routing.evidence.costRelation).toBe("equal");
  expect(routing.evidence.quotaRelation).toBe("lower");
  expect(routing.evidence.includedAllowancePlan).toBe("pro");
});

test("a candidate from a discovered but unenabled provider never authorizes a move", () => {
  const routing = authorizedRouting(
    resolveExecutionRouting(
      routingRequest({
        boundary: replacementBoundary(),
        catalogue: snapshot(
          [
            catalogueEntry(PINNED.model, {
              cost: { input: 2, output: 2 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 2 },
            }),
            catalogueEntry("beta/included", {
              cost: { input: 1, output: 1 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
          ],
          ["alpha"],
        ),
      }),
    ),
  );

  expect(routing.basis).toBe("pinned-policy");
  expect(routing.selector).toBe(PINNED.model);
});

test("a prepaid higher-cost replacement asks instead of moving", () => {
  const pause = pauseOf(
    resolveExecutionRouting(
      routingRequest({
        boundary: replacementBoundary(),
        catalogue: snapshot(
          [
            catalogueEntry(PINNED.model, {
              cost: { input: 1, output: 1 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
            catalogueEntry("alpha/deluxe", {
              cost: { input: 5, output: 5 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
          ],
          ["alpha"],
        ),
      }),
    ),
  );

  expect(pause.reason).toBe("premium-tier-requires-approval");
  expect(pause.premiumAxis).toBe("monetary-cost");
  expect(pause.candidateSelector).toBe("alpha/deluxe");
  expect(describeExecutionRoutingDecision(pause)).toBe(
    "Keep this task on alpha/base? The only alternative, alpha/deluxe, costs more.",
  );
});

test("a replacement drawing more included allowance asks even at equal cost", () => {
  const pause = pauseOf(
    resolveExecutionRouting(
      routingRequest({
        boundary: replacementBoundary(),
        catalogue: snapshot(
          [
            catalogueEntry(PINNED.model, {
              cost: { input: 2, output: 2 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
            catalogueEntry("alpha/heavy", {
              cost: { input: 2, output: 2 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 4 },
            }),
          ],
          ["alpha"],
        ),
      }),
    ),
  );

  expect(pause.reason).toBe("premium-tier-requires-approval");
  expect(pause.premiumAxis).toBe("quota-consumption");
});

test("unknown tier evidence pauses rather than classifying the move as comparable", () => {
  const pause = pauseOf(
    resolveExecutionRouting(
      routingRequest({
        boundary: replacementBoundary(),
        catalogue: snapshot(
          [
            catalogueEntry(PINNED.model, {
              cost: { input: 2, output: 2 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
            catalogueEntry("alpha/quiet", {
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
          ],
          ["alpha"],
        ),
      }),
    ),
  );

  expect(pause.reason).toBe("tier-evidence-indeterminate");
  expect(pause.evidenceGaps).toEqual(["catalogue-cost-unpublished"]);
  expect(describeExecutionRoutingDecision(pause)).toBe(
    "Keep this task on alpha/base? I can't get clear pricing for the alternatives.",
  );
  expect(describeExecutionRoutingDecision(pause)).not.toContain("catalogue-cost-unpublished");
});

test("the rendered routing prompt never names a task, decision, generation, or attempt id", () => {
  const pause = pauseOf(
    resolveExecutionRouting(
      routingRequest({
        boundary: replacementBoundary({
          operationId: "operation-0",
          selector: PINNED.model,
          outcome: "uncertain",
        }),
        catalogue: reassignableCatalogue(),
      }),
    ),
  );
  const withoutObjective = describeExecutionRoutingDecision(pause);
  expectNoIdentifiers(withoutObjective, [
    pause.decisionId,
    pause.taskId,
    pause.jobId,
    pause.operationId,
  ]);
  expect(withoutObjective).toContain("this task");

  // A caller that has the task's own words for it names the task that way instead of "this task".
  const withObjective = describeExecutionRoutingDecision(pause, "Add dark mode to settings");
  expect(withObjective).toContain('"Add dark mode to settings"');
  expectNoIdentifiers(withObjective, [pause.taskId, pause.decisionId]);
});

test("a catalogue contradicting the pinned model pauses rather than falling back silently", () => {
  const pause = pauseOf(
    resolveExecutionRouting(
      routingRequest({ catalogue: snapshot([catalogueEntry("alpha/other")], ["alpha"]) }),
    ),
  );

  expect(pause.reason).toBe("pinned-model-absent-from-catalogue");
  expect(pause.evidenceGaps).toEqual(["incumbent-absent-from-catalogue"]);
});

test("an unread catalogue keeps the pinned model and claims no comparison", () => {
  const routing = authorizedRouting(
    resolveExecutionRouting(
      routingRequest({
        boundary: replacementBoundary(),
        catalogue: { status: "unavailable", reason: "catalogue-unreadable" },
      }),
    ),
  );

  expect(routing.basis).toBe("pinned-policy");
  expect(routing.evidence).toEqual({
    source: "catalogue-unavailable",
    enabledProviders: [],
    usageSource: "request-ledger",
    unaccountedSamples: 0,
    unmeasuredTokenSamples: 0,
  });
});

test("the same question re-resolves to the same decision instead of asking twice", () => {
  const request = routingRequest({
    catalogue: snapshot([catalogueEntry("alpha/other")], ["alpha"]),
  });

  expect(pauseOf(resolveExecutionRouting(request)).decisionId).toBe(
    pauseOf(resolveExecutionRouting(request)).decisionId,
  );
});

test("a recorded question stops speaking once the pinned policy moves under it", () => {
  const pause = pauseOf(
    resolveExecutionRouting(
      routingRequest({ catalogue: snapshot([catalogueEntry("alpha/other")], ["alpha"]) }),
    ),
  );
  const identity = {
    role: "implementer" as const,
    generation: 2,
    policyDigest: "policy-digest",
    inputHead: "head-1",
  };

  expect(executionRoutingPauseStands(pause, identity)).toBe(true);
  expect(executionRoutingPauseStands(pause, { ...identity, policyDigest: "repinned" })).toBe(false);
  expect(executionRoutingPauseStands(pause, { ...identity, generation: 3 })).toBe(false);
  expect(executionRoutingPauseStands(pause, { ...identity, inputHead: "head-2" })).toBe(false);
});

test("an audit record alone never authorizes a model the pinned assignment does not name", () => {
  const fence = {
    operationId: "operation-1",
    jobId: "job-1",
    generation: 2,
    inputHead: "head-1",
    policyDigest: "policy-digest",
  };

  expect(
    authorizeExecutionModel({
      claimed: { model: "alpha/other", thinking: "high" },
      pinned: PINNED,
      routing: undefined,
      fence,
    }),
  ).toEqual({
    authorized: false,
    reason: "resolved model is not the pinned assignment and no execution transition authorizes it",
  });
  expect(
    authorizeExecutionModel({ claimed: PINNED, pinned: PINNED, routing: undefined, fence }),
  ).toEqual({ authorized: true, model: PINNED });
});

test("a recorded transition authorizes exactly its own model and only under its own fence", () => {
  const routing = authorizedRouting(
    resolveExecutionRouting(
      routingRequest({
        boundary: replacementBoundary(),
        catalogue: snapshot(
          [
            catalogueEntry(PINNED.model, {
              cost: { input: 2, output: 2 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 2 },
            }),
            catalogueEntry("alpha/included", {
              cost: { input: 2, output: 2 },
              includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
            }),
          ],
          ["alpha"],
        ),
      }),
    ),
  );
  const fence = {
    operationId: routing.operationId,
    jobId: routing.jobId,
    generation: routing.generation,
    inputHead: routing.inputHead,
    policyDigest: routing.policyDigest,
  };
  const reassigned = resolvedExecutionModel(routing, PINNED);

  expect(authorizeExecutionModel({ claimed: reassigned, pinned: PINNED, routing, fence })).toEqual({
    authorized: true,
    model: reassigned,
  });
  expect(authorizeExecutionModel({ claimed: PINNED, pinned: PINNED, routing, fence })).toEqual({
    authorized: false,
    reason: "resolved model does not match the recorded execution transition",
  });
  for (const stale of [
    { ...fence, generation: routing.generation + 1 },
    { ...fence, inputHead: "head-2" },
    { ...fence, policyDigest: "repinned" },
    { ...fence, operationId: "operation-9" },
  ]) {
    expect(
      authorizeExecutionModel({ claimed: reassigned, pinned: PINNED, routing, fence: stale }),
    ).toEqual({ authorized: false, reason: "execution routing evidence is stale" });
  }
});
