import { expect, test } from "bun:test";
import {
  compareModelTier,
  lookupModelTierEvidence,
  type ModelTierEvidence,
} from "../../src/config/model-tier.ts";
import type { ThinkingLevel } from "../../src/contracts.ts";
import type { OmpIncludedAllowance, OmpModelRecord } from "../../src/harness/omp/adapter.ts";

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

function evidenceFor(entry: OmpModelRecord): ModelTierEvidence {
  const lookup = lookupModelTierEvidence([entry], { model: entry.selector, thinking: "high" });
  if (lookup.status !== "known") throw new Error(`expected known evidence, got ${lookup.gap}`);
  return lookup.evidence;
}

test("a prepaid candidate that costs more is premium on the monetary axis", () => {
  const incumbent = evidenceFor(catalogueEntry("alpha/base", { cost: { input: 1, output: 2 } }));
  const candidate = evidenceFor(
    catalogueEntry("alpha/deluxe", {
      cost: { input: 4, output: 4 },
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
    }),
  );

  const comparison = compareModelTier(incumbent, candidate);

  expect(comparison.status).toBe("premium");
  if (comparison.status !== "premium") throw new Error("expected a premium comparison");
  expect(comparison.axis).toBe("monetary-cost");
});

test("a candidate drawing more included allowance is premium even at equal cost", () => {
  const incumbent = evidenceFor(
    catalogueEntry("alpha/base", {
      cost: { input: 2, output: 2 },
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
    }),
  );
  const candidate = evidenceFor(
    catalogueEntry("alpha/heavy", {
      cost: { input: 2, output: 2 },
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 5 },
    }),
  );

  const comparison = compareModelTier(incumbent, candidate);

  expect(comparison.status).toBe("premium");
  if (comparison.status !== "premium") throw new Error("expected a premium comparison");
  expect(comparison.axis).toBe("quota-consumption");
  expect(comparison.cost).toBe("equal");
});

test("a candidate drawing more included allowance is premium when no cost is published", () => {
  const incumbent = evidenceFor(
    catalogueEntry("alpha/base", {
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
    }),
  );
  const candidate = evidenceFor(
    catalogueEntry("alpha/heavy", {
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 2 },
    }),
  );

  const comparison = compareModelTier(incumbent, candidate);

  expect(comparison.status).toBe("premium");
  if (comparison.status !== "premium") throw new Error("expected a premium comparison");
  expect(comparison.axis).toBe("quota-consumption");
  expect(comparison.cost).toBeUndefined();
});

test("an unpublished cost leaves the comparison indeterminate rather than comparable", () => {
  const incumbent = evidenceFor(
    catalogueEntry("alpha/base", {
      cost: { input: 2, output: 2 },
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
    }),
  );
  const candidate = evidenceFor(
    catalogueEntry("alpha/quiet", {
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
    }),
  );

  const comparison = compareModelTier(incumbent, candidate);

  expect(comparison).toEqual({
    status: "indeterminate",
    gaps: ["catalogue-cost-unpublished"],
  });
});

test("allowances from different plans conflict rather than compare", () => {
  const incumbent = evidenceFor(
    catalogueEntry("alpha/base", {
      cost: { input: 2, output: 2 },
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
    }),
  );
  const candidate = evidenceFor(
    catalogueEntry("beta/base", {
      cost: { input: 1, output: 1 },
      includedAllowance: { plan: "team", unit: "request", unitsPerRequest: 1 },
    }),
  );

  const comparison = compareModelTier(incumbent, candidate);

  expect(comparison).toEqual({
    status: "indeterminate",
    gaps: ["included-allowance-plan-differs"],
  });
});

test("two models nobody published an allowance for are not therefore equal", () => {
  const incumbent = evidenceFor(catalogueEntry("alpha/base", { cost: { input: 2, output: 2 } }));
  const candidate = evidenceFor(catalogueEntry("alpha/other", { cost: { input: 2, output: 2 } }));

  const comparison = compareModelTier(incumbent, candidate);

  expect(comparison).toEqual({
    status: "indeterminate",
    gaps: ["included-allowance-unpublished"],
  });
});

test("equal published cost and equal included allowance is comparable", () => {
  const incumbent = evidenceFor(
    catalogueEntry("alpha/base", {
      cost: { input: 2, output: 2 },
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
    }),
  );
  const candidate = evidenceFor(
    catalogueEntry("alpha/twin", {
      cost: { input: 1, output: 3 },
      includedAllowance: { plan: "pro", unit: "request", unitsPerRequest: 1 },
    }),
  );

  expect(compareModelTier(incumbent, candidate)).toEqual({
    status: "comparable",
    cost: "equal",
    quota: "equal",
  });
});

test("catalogue lookup names why a model supplies no tier evidence", () => {
  const catalogue = [
    catalogueEntry("alpha/base", { thinking: ["low"] }),
    catalogueEntry("alpha/twin"),
    catalogueEntry("alpha/twin"),
  ];

  expect(lookupModelTierEvidence(catalogue, { model: "alpha/base", thinking: "high" })).toEqual({
    status: "unknown",
    gap: "thinking-level-unsupported",
  });
  expect(lookupModelTierEvidence(catalogue, { model: "alpha/twin", thinking: "high" })).toEqual({
    status: "unknown",
    gap: "ambiguous-in-catalogue",
  });
  expect(lookupModelTierEvidence(catalogue, { model: "alpha/absent", thinking: "high" })).toEqual({
    status: "unknown",
    gap: "absent-from-catalogue",
  });
});
