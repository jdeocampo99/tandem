import { expect, test } from "bun:test";
import type { OmpModelRecord } from "../../src/adapters/omp.ts";
import { discoveredProviders, resolveBalancedProfile } from "../../src/config/operating-profile.ts";
import { MODEL_ROLE_ORDER } from "../../src/contracts.ts";

function model(
  overrides: Partial<OmpModelRecord> & Pick<OmpModelRecord, "selector">,
): OmpModelRecord {
  return {
    id: overrides.selector,
    provider: overrides.selector.split("/")[0] ?? "unknown",
    thinking: ["low", "medium", "high", "max"],
    reasoning: true,
    ...overrides,
  };
}

const RICH_CATALOGUE: readonly OmpModelRecord[] = [
  model({
    selector: "acme/frontier",
    provider: "acme",
    reasoning: true,
    contextWindow: 200_000,
    cost: { input: 3, output: 15 },
  }),
  model({
    selector: "acme/fast",
    provider: "acme",
    reasoning: false,
    thinking: ["low", "medium"],
    contextWindow: 32_000,
    cost: { input: 0.1, output: 0.3 },
  }),
  model({
    selector: "globex/frontier",
    provider: "globex",
    reasoning: true,
    contextWindow: 400_000,
    cost: { input: 5, output: 20 },
  }),
];

test("discoveredProviders returns the distinct catalogue providers sorted for stable display", () => {
  expect(discoveredProviders(RICH_CATALOGUE)).toEqual(["acme", "globex"]);
  expect(discoveredProviders([])).toEqual([]);
});

test("resolveBalancedProfile fails closed with no eligible role when no provider is enabled", () => {
  const proposal = resolveBalancedProfile({
    catalogue: RICH_CATALOGUE,
    enabledProviders: new Set(),
  });
  expect(proposal.status).toBe("unresolved");
  if (proposal.status !== "unresolved") throw new Error("expected unresolved");
  expect(proposal.gaps).toHaveLength(MODEL_ROLE_ORDER.length);
  for (const gap of proposal.gaps) {
    expect(gap.reason).toContain("no provider is explicitly enabled");
  }
});

test("a discovered but unenabled provider is never selected even though the catalogue lists it", () => {
  const proposal = resolveBalancedProfile({
    catalogue: RICH_CATALOGUE,
    enabledProviders: new Set(["globex"]),
  });
  expect(proposal.status).toBe("resolved");
  if (proposal.status !== "resolved") throw new Error("expected resolved");
  for (const role of MODEL_ROLE_ORDER) {
    expect(proposal.assignments[role].model).toBe("globex/frontier");
    expect(proposal.roles[role].provider).toBe("globex");
  }
});

test("resolveBalancedProfile picks the highest-context, lowest-cost eligible candidate deterministically", () => {
  const proposal = resolveBalancedProfile({
    catalogue: RICH_CATALOGUE,
    enabledProviders: new Set(["acme", "globex"]),
  });
  expect(proposal.status).toBe("resolved");
  if (proposal.status !== "resolved") throw new Error("expected resolved");
  // Every role in this fixture targets a thinking level only "frontier" models support (acme/fast
  // tops out at "medium"), so both roles that allow non-reasoning models still land on a frontier
  // selector, and the higher-context globex/frontier wins the tie-break over acme/frontier.
  for (const role of MODEL_ROLE_ORDER) {
    expect(proposal.assignments[role].model).toBe("globex/frontier");
  }
  expect(proposal.roles.coordinator.evidence.contextWindow).toBe(400_000);
  expect(proposal.roles.coordinator.reason).toContain("globex/frontier");
});

test("roles that do not require reasoning may still select a non-reasoning candidate", () => {
  const catalogue: readonly OmpModelRecord[] = [
    model({
      selector: "acme/scout-model",
      provider: "acme",
      reasoning: false,
      thinking: ["medium"],
    }),
  ];
  const proposal = resolveBalancedProfile({ catalogue, enabledProviders: new Set(["acme"]) });
  expect(proposal.status).toBe("unresolved");
  if (proposal.status !== "unresolved") throw new Error("expected unresolved");
  const scoutGap = proposal.gaps.find((gap) => gap.role === "scout");
  expect(scoutGap).toBeUndefined();
  expect(proposal.roles.scout?.model).toEqual({ model: "acme/scout-model", thinking: "medium" });
  // Roles that require reasoning (e.g. coordinator) stay unresolved against this candidate.
  expect(proposal.gaps.some((gap) => gap.role === "coordinator")).toBe(true);
});

test("a candidate with undefined reasoning is excluded as ambiguous capability evidence", () => {
  const catalogue: readonly OmpModelRecord[] = [
    { id: "m", selector: "acme/no-evidence", provider: "acme", thinking: ["medium"] },
  ];
  const proposal = resolveBalancedProfile({ catalogue, enabledProviders: new Set(["acme"]) });
  expect(proposal.status).toBe("unresolved");
  if (proposal.status !== "unresolved") throw new Error("expected unresolved");
  const scoutGap = proposal.gaps.find((gap) => gap.role === "scout");
  expect(scoutGap?.reason).toContain("no explicit reasoning-capability evidence");
});

test("an unsupported thinking level for a role fails closed with an actionable reason", () => {
  const catalogue: readonly OmpModelRecord[] = [
    model({ selector: "acme/only-low", provider: "acme", thinking: ["low"] }),
  ];
  const proposal = resolveBalancedProfile({ catalogue, enabledProviders: new Set(["acme"]) });
  expect(proposal.status).toBe("unresolved");
  if (proposal.status !== "unresolved") throw new Error("expected unresolved");
  const coordinatorGap = proposal.gaps.find((gap) => gap.role === "coordinator");
  expect(coordinatorGap?.reason).toContain("'high' thinking level");
});

test("an empty catalogue leaves every role unresolved even when a provider is enabled", () => {
  const proposal = resolveBalancedProfile({ catalogue: [], enabledProviders: new Set(["acme"]) });
  expect(proposal.status).toBe("unresolved");
  if (proposal.status !== "unresolved") throw new Error("expected unresolved");
  for (const gap of proposal.gaps) {
    expect(gap.reason).toContain("no models from the enabled provider(s)");
  }
});
