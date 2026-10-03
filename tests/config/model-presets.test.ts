import { expect, test } from "bun:test";
import { type ModelPreset, modelPresets } from "../../src/config/model-presets.ts";
import type { ModelRecord } from "../../src/harness/contract.ts";

const codex = (id: string, input: number, output: number): ModelRecord => ({
  selector: `openai-codex/${id}`,
  id,
  provider: "openai-codex",
  name: id,
  reasoning: true,
  contextWindow: 272_000,
  thinking: ["low", "medium", "high", "xhigh", "max"],
  cost: { input, output },
});

const omp: readonly ModelRecord[] = [
  codex("gpt-6-luna", 0.1, 0.5),
  codex("gpt-6-astra", 10, 50),
  codex("gpt-6-sol", 2, 10),
];

const byId = (presets: readonly ModelPreset[]) =>
  Object.fromEntries(presets.map((preset) => [preset.id, preset]));

test("Claude coordinates and Codex researches and reviews on the priciest Codex model", () => {
  const preset = byId(modelPresets({ ompCatalogue: omp, claudeCode: "ready" }))["claude-codex"];
  expect(preset).toMatchObject({
    status: "ready",
    models: {
      coordinator: { model: "claude-code/opus", thinking: "high" },
      scout: { model: "openai-codex/gpt-6-astra", thinking: "medium" },
      implementer: { model: "claude-code/opus", thinking: "max" },
      reviewer: { model: "openai-codex/gpt-6-astra", thinking: "max" },
      presentation: { model: "claude-code/sonnet", thinking: "low" },
    },
  });
});

test("All Claude Code fills every role from the Claude Code catalogue", () => {
  const preset = byId(modelPresets({ ompCatalogue: [], claudeCode: "ready" }))["all-claude-code"];
  expect(preset).toMatchObject({
    status: "ready",
    models: {
      coordinator: { model: "claude-code/opus", thinking: "high" },
      scout: { model: "claude-code/sonnet", thinking: "medium" },
      implementer: { model: "claude-code/opus", thinking: "max" },
      reviewer: { model: "claude-code/fable", thinking: "max" },
      presentation: { model: "claude-code/sonnet", thinking: "low" },
    },
  });
});

test("All OMP is the Balanced profile over every listed provider, never Claude Code", () => {
  const preset = byId(modelPresets({ ompCatalogue: omp, claudeCode: "ready" }))["all-omp"];
  if (preset?.status !== "ready") throw new Error("expected All OMP to be ready");
  expect(Object.values(preset.models).every((spec) => spec.model.startsWith("openai-codex/"))).toBe(
    true,
  );
  expect(preset.models.implementer.thinking).toBe("max");
});

test("thinking moves to the nearest level the chosen model supports", () => {
  const narrow = {
    ...codex("gpt-5.5", 5, 30),
    thinking: ["low", "medium", "high", "xhigh"] as const,
  };
  const preset = byId(modelPresets({ ompCatalogue: [narrow], claudeCode: "ready" }))[
    "claude-codex"
  ];
  expect(preset).toMatchObject({
    models: { reviewer: { model: "openai-codex/gpt-5.5", thinking: "xhigh" } },
  });
});

test("a preset whose models aren't available is disabled with a plain reason", () => {
  const reasons = (facts: Parameters<typeof modelPresets>[0]) =>
    modelPresets(facts).map((preset) => (preset.status === "disabled" ? preset.reason : "ready"));
  expect(reasons({ ompCatalogue: omp, claudeCode: "not-installed" })).toEqual([
    "Claude Code isn't installed. Install it, then reopen setup.",
    "Claude Code isn't installed. Install it, then reopen setup.",
    "ready",
  ]);
  expect(
    reasons({
      ompCatalogue: omp,
      claudeCode: { setting: "disableAllHooks", source: "project" },
    })[1],
  ).toBe(
    "The disableAllHooks setting in this project's .claude/settings.json switches off mods, so Tandem can't run in Claude Code.",
  );
  const noCodex: readonly ModelRecord[] = [
    { ...codex("x", 1, 1), selector: "google/gemini", provider: "google" },
  ];
  expect(reasons({ ompCatalogue: noCodex, claudeCode: "ready" })[0]).toBe(
    "OMP lists no Codex or OpenAI model. Sign in to Codex in OMP, then reopen setup.",
  );
  expect(reasons({ ompCatalogue: [], claudeCode: "ready" })[2]).toBe(
    "OMP lists no models. Add a provider in OMP, then reopen setup.",
  );
});

test("plain OpenAI models stand in when OMP has no Codex provider", () => {
  const openai: ModelRecord = {
    ...codex("gpt-6", 3, 15),
    selector: "openai/gpt-6",
    provider: "openai",
  };
  const preset = byId(modelPresets({ ompCatalogue: [openai], claudeCode: "ready" }))[
    "claude-codex"
  ];
  expect(preset).toMatchObject({ models: { scout: { model: "openai/gpt-6" } } });
});
