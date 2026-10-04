import { expect, test } from "bun:test";
import type { RepoPolicy } from "../../src/contracts.ts";
import type { ModelRecord } from "../../src/harness/contract.ts";
import { renderSetupHtml } from "../../src/onboarding/setup-render.ts";
import { buildSetupView, type SetupViewInput } from "../../src/onboarding/setup-view.ts";

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
  generatedAt: "2026-09-26T12:00:00.000Z",
  homeFolder: "/Users/me",
  ompCatalogue: catalogue,
  claudeCode: "not-installed",
  searchedFolders: ["/Users/me/code", "/srv/git"],
  repos: [
    {
      path: "/Users/me/code/web",
      setUp: false,
    },
    {
      path: "/Users/me/code/api",
      repo: "acme/api",
      setUp: false,
      details: {
        validationCommands: ["bun run check", "bun run test"],
        scripts: ["check", "test"],
        setupCommands: ["bun install --frozen-lockfile"],
        lockfile: "bun.lock",
      },
    },
    { path: "/Users/me/code/tandem", setUp: true },
  ],
};

test("every job starts empty on a first run and all catalogue models are available", () => {
  const view = buildSetupView(input);
  expect(view.roles.map((role) => role.name)).toEqual([
    "Planning",
    "Research",
    "Coding",
    "Review",
    "Visual mockups",
  ]);
  expect(view.roles.every((role) => role.pick === undefined)).toBe(true);
  expect(view.roles[0]?.example).toBe("Claude Fable 5.1 on high");
  expect(view.models[0]?.thinking).toEqual(["low", "high", "max"]);
  expect(view.models[1]?.name).toBe("gpt");
  expect(view.selfImprovement).toBe("fix");
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
  expect(missing.presets.map((preset) => [preset.id, preset.status])).toEqual([
    ["claude-codex", "disabled"],
    ["all-claude-code", "disabled"],
    ["all-omp", "disabled"],
  ]);
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

test("repositories say where their commands came from, with the home folder as ~", () => {
  const view = buildSetupView(input);
  expect(view.searchedFolders).toEqual(["~/code", "/srv/git"]);
  const [api, tandem, web] = view.repos;
  expect(api).toMatchObject({
    name: "api",
    shownPath: "~/code/api",
    repo: "acme/api",
    validationCommands: ["bun run check", "bun run test"],
    install: "bun install --frozen-lockfile",
  });
  expect(api?.validationSource).toBe(
    "Found in package.json scripts: check, test. Edit if these aren't what you run before merging.",
  );
  expect(api?.installSource).toBe("Picked from bun.lock.");
  expect(tandem?.setUp).toBe(true);
  expect(web?.validationSource).toStartWith("Could not inspect this repository:");
  expect(web?.installSource).toStartWith("Could not inspect this repository:");
});

test("the page is one self-contained document with the shared components inlined", () => {
  const html = renderSetupHtml(buildSetupView(input));
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain("<title>Tandem setup</title>");
  expect(html).toContain("--sunk: #23232e;");
  expect(html).not.toContain("/*{{");
  expect(html).toContain("window.TandemUI");
  expect(html).not.toContain("{{");
  const data = /<script type="application\/json" id="setup-data">([\s\S]*?)<\/script>/.exec(html);
  expect(JSON.parse(data?.[1] ?? "null")).toEqual(buildSetupView(input));
});

test("names from disk cannot close the data script", () => {
  const hostile = "</script><img src=x onerror=alert(1)>";
  const html = renderSetupHtml(
    buildSetupView({
      ...input,
      repos: [...input.repos, { path: hostile, setUp: false }],
    }),
  );
  expect(html).not.toContain("<img");
  expect(html.toLowerCase().match(/<\/script>/g)).toHaveLength(3);
});
