import { expect, test } from "bun:test";
import type { RepoPolicy } from "../../src/contracts.ts";
import type { ModelRecord } from "../../src/harness/contract.ts";
import {
  buildSetupView,
  priceLevel,
  recommend,
  SETUP_ROLE_COPY,
  type SetupModel,
  type SetupView,
  type SetupViewInput,
} from "../../src/onboarding/setup-view.ts";

const catalogue: readonly ModelRecord[] = [
  {
    selector: "anthropic/claude-opus",
    id: "claude-opus",
    provider: "anthropic",
    name: "Claude Opus",
    thinking: ["max", "low", "high"],
    contextWindow: 500_000,
    cost: { input: 12, output: 60 },
  },
  { selector: "openai/gpt", id: "gpt", provider: "openai", thinking: ["high"] },
];

const saved: RepoPolicy["models"] = {
  coordinator: { model: "anthropic/claude-opus", thinking: "high" },
  scout: { model: "openai/gpt", thinking: "high" },
  implementer: { model: "anthropic/claude-opus", thinking: "medium" },
  reviewer: { model: "gone/model", thinking: "high" },
  presentation: { model: "anthropic/claude-opus", thinking: "low" },
};

const input: SetupViewInput = {
  mode: "setup",
  generatedAt: "2026-09-26T12:00:00.000Z",
  homeFolder: "/Users/me",
  ompCatalogue: catalogue,
  claudeCode: "not-installed",
  repos: [
    { path: "/Users/me/code/web", setUp: false },
    {
      path: "/Users/me/code/api",
      repo: "acme/api",
      setUp: false,
      details: {
        validationCommands: ["bun run check", "bun run test"],
        scriptCommands: ["bun run check", "bun run typecheck", "bun run test"],
        setupCommands: ["bun install --frozen-lockfile"],
        lockfile: "bun.lock",
      },
    },
    { path: "/Users/me/code/tandem", setUp: true },
  ],
};

test("every job starts without a saved pick and all catalogue models are available", () => {
  const view = buildSetupView(input);
  expect(view.roles.map((role) => role.name)).toEqual([
    "Planning",
    "Research",
    "Coding",
    "Review",
    "Mockups",
  ]);
  expect(view.roles.every((role) => role.pick === undefined)).toBe(true);
  expect(view.models[0]?.thinking).toEqual(["low", "high", "max"]);
  expect(view.models[1]?.name).toBe("gpt");
  expect(view.selfImprovement).toBe("fix");
});

test("each role shows its hint and the Balanced profile's recommendation with its reason", () => {
  const flagship: ModelRecord = {
    selector: "openai-codex/flagship",
    id: "flagship",
    provider: "openai-codex",
    reasoning: true,
    thinking: ["low", "medium", "high", "max"],
    cost: { input: 10, output: 50 },
  };
  const view = buildSetupView({ ...input, ompCatalogue: [flagship] });
  expect(view.roles.map((role) => role.hint)).toEqual([
    "your smartest model",
    "cheap and fast",
    "strong at code, high effort",
    "smart, and different from Coding",
    "cheap and fast",
  ]);
  expect(view.roles.map((role) => role.recommended?.model)).toEqual([
    { model: flagship.selector, thinking: "high" },
    { model: flagship.selector, thinking: "medium" },
    { model: flagship.selector, thinking: "max" },
    { model: flagship.selector, thinking: "max" },
    { model: flagship.selector, thinking: "low" },
  ]);
  expect(view.roles.every((role) => (role.recommended?.reason.length ?? 0) > 0)).toBe(true);
  for (const role of view.roles) expect(role.hint).toBe(SETUP_ROLE_COPY[role.id].hint);
});

test("a role the Balanced profile cannot fill has no recommendation", () => {
  const view = buildSetupView({ ...input, ompCatalogue: [] });
  expect(view.roles.every((role) => role.recommended === undefined)).toBe(true);
  expect(view.harnesses[1]?.unavailable).toContain("No models yet");
});

test("saved choices remain available across providers while invalid model or thinking choices clear", () => {
  const view = buildSetupView({
    ...input,
    savedModels: saved,
    selfImprovement: "off",
  });
  const picks = Object.fromEntries(view.roles.map((role) => [role.id, role.pick]));
  expect(picks.coordinator).toEqual({ model: "anthropic/claude-opus", thinking: "high" });
  expect(picks.scout).toEqual({ model: "openai/gpt", thinking: "high" });
  expect(picks.implementer).toBeUndefined(); // medium is not supported
  expect(picks.reviewer).toBeUndefined(); // no longer in the catalogue
  expect(view.selfImprovement).toBe("off");
});

test("pickers group Claude Code's models before OMP's, and only offer Claude Code when it is ready", () => {
  const ready = buildSetupView({ ...input, claudeCode: "ready" });
  expect(ready.models.map((model) => `${model.harness} ${model.selector}`)).toEqual([
    "claude-code claude-code/fable",
    "claude-code claude-code/opus",
    "claude-code claude-code/sonnet",
    "claude-code claude-code/haiku",
    "omp anthropic/claude-opus",
    "omp openai/gpt",
  ]);
  expect(ready.models.find((model) => model.selector === "claude-code/haiku")?.thinking).toEqual([
    "off",
  ]);
  expect(ready.harnesses).toEqual([
    { id: "claude-code", name: "Claude Code", note: "Uses your Claude subscription." },
    { id: "omp", name: "OMP", note: "Models from OMP's catalogue, billed by each provider." },
  ]);

  const missing = buildSetupView(input);
  expect(missing.models.map((model) => model.harness)).toEqual(["omp", "omp"]);
  expect(missing.harnesses[0]?.unavailable).toBe("Not installed on this computer.");
});

test("a saved Claude Code choice is kept only while Claude Code is ready", () => {
  const savedModels = {
    ...saved,
    scout: { model: "claude-code/sonnet", thinking: "medium" },
  } as const;
  const scoutPick = (claudeCode: SetupViewInput["claudeCode"]) =>
    buildSetupView({ ...input, claudeCode, savedModels }).roles.find((role) => role.id === "scout")
      ?.pick;
  expect(scoutPick("ready")).toEqual({ model: "claude-code/sonnet", thinking: "medium" });
  expect(scoutPick({ setting: "disableAllHooks", source: "managed" })).toBeUndefined();
});

test("price levels come from one table of output-price ceilings", () => {
  expect(priceLevel({ output: 3 })).toBe("$");
  expect(priceLevel({ output: 20 })).toBe("$");
  expect(priceLevel({ output: 20.01 })).toBe("$$");
  expect(priceLevel({ output: 60 })).toBe("$$");
  expect(priceLevel({ output: 75 })).toBe("$$$");
  const view = buildSetupView(input);
  expect(view.models.map((model) => model.priceLevel)).toEqual(["$$", undefined]);
});

test("set-up repositories and candidates list their commands, suggestions, and sources", () => {
  const view = buildSetupView(input);
  expect(view.repos.map((repo) => repo.name)).toEqual(["tandem"]);
  const [api, web] = view.candidates;
  expect(api).toMatchObject({
    name: "api",
    shownPath: "~/code/api",
    repo: "acme/api",
    validationCommands: ["bun run check", "bun run test"],
    setupCommands: ["bun install --frozen-lockfile"],
    suggestions: ["bun run typecheck"],
    detectedFrom: "package.json scripts and bun.lock",
  });
  expect(web).toMatchObject({
    name: "web",
    validationCommands: [],
    setupCommands: [],
    suggestions: [],
  });
  expect(web?.detectedFrom).toBeUndefined();
});

test("a repository with nothing to suggest or detect names no source", () => {
  const view = buildSetupView({
    ...input,
    repos: [
      {
        path: "/Users/me/code/plain",
        setUp: false,
        details: { validationCommands: ["make check"], scriptCommands: [], setupCommands: [] },
      },
    ],
  });
  expect(view.candidates[0]?.suggestions).toEqual([]);
  expect(view.candidates[0]?.detectedFrom).toBeUndefined();
});

const flagship: ModelRecord = {
  selector: "openai-codex/flagship",
  id: "flagship",
  provider: "openai-codex",
  reasoning: true,
  thinking: ["low", "medium", "high", "max"],
  cost: { input: 10, output: 50 },
};

const recommendedModels = (view: SetupView) =>
  Object.fromEntries(
    view.roles.map((role) => [role.id, `${role.recommended?.model.model} ${role.recommended?.model.thinking}`]),
  );

test("with Claude Code ready, Coding follows the Balanced profile and Review is Opus", () => {
  const view = buildSetupView({ ...input, claudeCode: "ready", ompCatalogue: [flagship] });
  expect(recommendedModels(view)).toEqual({
    coordinator: "claude-code/fable high",
    scout: "claude-code/sonnet medium",
    implementer: "openai-codex/flagship max",
    reviewer: "claude-code/opus high",
    presentation: "claude-code/sonnet low",
  });
  expect(view.roles.map((role) => role.recommended?.reason)).toEqual([
    "Its plans steer every other role.",
    "Research is mostly reading, so speed matters more than depth.",
    "Most of the time and cost is here.",
    "A second model catches mistakes the first one misses.",
    "Drawing a page needs little reasoning.",
  ]);
});

test("with Claude Code ready and no Balanced Coding pick, Coding is Opus and Review is Fable", () => {
  const view = buildSetupView({ ...input, claudeCode: "ready", ompCatalogue: [] });
  expect(recommendedModels(view)).toEqual({
    coordinator: "claude-code/fable high",
    scout: "claude-code/sonnet medium",
    implementer: "claude-code/opus high",
    reviewer: "claude-code/fable high",
    presentation: "claude-code/sonnet low",
  });
});

test("without Claude Code, every role takes the Balanced profile's pick with the same reasons", () => {
  const view = buildSetupView({ ...input, claudeCode: "not-installed", ompCatalogue: [flagship] });
  expect(recommendedModels(view)).toEqual({
    coordinator: "openai-codex/flagship high",
    scout: "openai-codex/flagship medium",
    implementer: "openai-codex/flagship max",
    reviewer: "openai-codex/flagship max",
    presentation: "openai-codex/flagship low",
  });
  expect(view.roles.map((role) => role.recommended?.reason)).toEqual([
    "Its plans steer every other role.",
    "Research is mostly reading, so speed matters more than depth.",
    "Most of the time and cost is here.",
    "A second model catches mistakes the first one misses.",
    "Drawing a page needs little reasoning.",
  ]);
});

test("a recommended thinking level the model lacks moves to the nearest one it supports", () => {
  const lowOrHigh = ["claude-code/fable", "claude-code/opus", "claude-code/sonnet"].map(
    (selector): SetupModel => ({
      selector,
      harness: "claude-code",
      name: selector,
      provider: "claude-code",
      thinking: ["low", "high"],
    }),
  );
  const recommended = recommend(true, { status: "unresolved", roles: {}, gaps: [] }, lowOrHigh);
  // Medium sits one step from both; the lighter level wins the tie.
  expect(recommended.scout?.model).toEqual({ model: "claude-code/sonnet", thinking: "low" });
  expect(recommended.coordinator?.model).toEqual({ model: "claude-code/fable", thinking: "high" });
});
