import { expect, test } from "bun:test";
import type { OmpModelRecord } from "../../src/adapters/omp.ts";
import type { RepoPolicy } from "../../src/contracts.ts";
import { renderSetupHtml } from "../../src/onboarding/setup-render.ts";
import { buildSetupView, type SetupViewInput } from "../../src/onboarding/setup-view.ts";

const catalogue: readonly OmpModelRecord[] = [
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
  catalogue,
  enabledProviders: ["anthropic", "retired"],
  searchedFolders: ["/Users/me/code", "/srv/git"],
  repos: [
    {
      path: "/Users/me/code/web",
      setUp: false,
      details: { validationCommands: [], scripts: [], setupCommands: [], mcpServers: [] },
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
        mcpServers: ["linear"],
      },
    },
    { path: "/Users/me/code/tandem", setUp: true },
  ],
  skills: [
    { name: "tdd", source: "~/.agents/skills", description: "Write the failing test first" },
    { name: "buildkite", source: "plugin: ci", description: "" },
  ],
};

test("every job starts empty on a first run, and providers start from the saved ones", () => {
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
  expect(view.providers).toEqual([
    { id: "anthropic", models: 1, enabled: true },
    { id: "openai", models: 1, enabled: false },
  ]);
  expect(view.models[0]?.thinking).toEqual(["low", "high", "max"]);
  expect(view.models[1]?.name).toBe("gpt");
  expect(view.selfImprovement).toBe("fix");
  expect(view.pickedSkills).toEqual([]);
});

test("saved choices come back only while their model, provider, and thinking still hold", () => {
  const view = buildSetupView({
    ...input,
    savedModels: saved,
    savedSkills: ["tdd", "uninstalled"],
    selfImprovement: "off",
  });
  const picks = Object.fromEntries(view.roles.map((role) => [role.id, role.pick]));
  expect(picks.coordinator).toEqual({ model: "anthropic/claude-opus", thinking: "high" });
  expect(picks.scout).toBeUndefined(); // openai is not enabled
  expect(picks.implementer).toBeUndefined(); // medium is not supported
  expect(picks.reviewer).toBeUndefined(); // no longer in the catalogue
  expect(view.pickedSkills).toEqual(["tdd"]);
  expect(view.selfImprovement).toBe("off");
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
    mcpServers: ["linear"],
  });
  expect(api?.validationSource).toBe(
    "Found in package.json scripts: check, test. Edit if these aren't what you run before merging.",
  );
  expect(api?.installSource).toBe("Picked from bun.lock.");
  expect(tandem?.setUp).toBe(true);
  expect(web?.validationSource).toStartWith("None found in package.json.");
  expect(web?.installSource).toStartWith("No lockfile found");
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
    buildSetupView({ ...input, skills: [{ name: hostile, source: hostile, description: "" }] }),
  );
  expect(html).not.toContain("<img");
  expect(html.toLowerCase().match(/<\/script>/g)).toHaveLength(3);
});
