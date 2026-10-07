import type { ModelRecord } from "../../src/harness/contract.ts";
import { buildSetupView, type SetupMode, type SetupView } from "../../src/onboarding/setup-view.ts";
import type { SpecialistFile, SpecialistRegistry } from "../../src/specialists/registry.ts";
import { readSpecialistMarkdown } from "../../src/specialists/specialist.ts";

const TEAM = "/Users/me/.tandem/sources/tandem/.tandem/specialists";
const HOME = "/Users/me/.tandem/specialists";

function file(
  origin: SpecialistFile["origin"],
  name: string,
  text: string,
  revision?: string,
): SpecialistFile {
  const path = `${origin === "home" ? HOME : TEAM}/${name}.md`;
  return {
    origin,
    name,
    path,
    result: readSpecialistMarkdown(text, { origin, path }),
    ...(revision === undefined ? {} : { revision }),
  };
}

/**
 * A team blog writer and a broken team file, a Just-me file used only when named, and a Just-me
 * bug-fix that replaces the built-in. `entries` stays empty: Settings draws `files`.
 */
export function specialistsFixture(): SpecialistRegistry {
  const files = [
    file(
      "repository",
      "blog-writer",
      "---\nname: blog-writer\nlabel: Blog writer\ndescription: A post about a shipped feature\n---\nWrite for developers.\n\n## Steps\n- Read the PR\n- Outline\n- Draft\n",
    ),
    file("repository", "seo", "---\nname: seo\nmodel: opus\n---\nBody\n"),
    file(
      "home",
      "release-notes",
      "---\nname: release-notes\nlabel: Release notes\n---\nShort and user-facing.\n\n## Steps\n- Collect merged PRs\n",
      "a".repeat(64),
    ),
    file(
      "home",
      "bug-fix",
      "---\nname: bug-fix\nlabel: Bug fix\ndescription: Fix a reported bug, test first\n---\nTest first.\n",
      "b".repeat(64),
    ),
  ];
  return {
    folders: { repository: TEAM, home: HOME },
    entries: [],
    problems: [
      { path: `${TEAM}/seo.md`, problem: 'line 3: unknown key "model"' },
      { path: `${HOME}/Notes.md`, problem: '"Notes" is not a specialist name' },
    ],
    files,
  };
}

/** A computer with one OMP model, one saved repository and two checkouts to add. */
const CATALOGUE: readonly ModelRecord[] = [
  {
    selector: "openai-codex/flagship",
    id: "flagship",
    provider: "openai-codex",
    name: "Flagship",
    reasoning: true,
    thinking: ["low", "medium", "high", "max"],
    contextWindow: 400_000,
    cost: { input: 10, output: 50 },
  },
];

export function setupViewFixture(mode: SetupMode): SetupView {
  return buildSetupView({
    mode,
    generatedAt: "2030-01-01T00:00:00.000Z",
    homeFolder: "/Users/me",
    ompCatalogue: CATALOGUE,
    claudeCode: "ready",
    repos: [
      {
        path: "/Users/me/code/tandem",
        setUp: true,
        details: {
          validationCommands: ["bun run check", "bun test"],
          scriptCommands: ["bun run check", "bun test", "bun run lint"],
          setupCommands: ["bun install --frozen-lockfile"],
          lockfile: "bun.lock",
        },
      },
      {
        path: "/Users/me/code/web-app",
        setUp: false,
        details: {
          validationCommands: ["pnpm typecheck"],
          scriptCommands: ["pnpm typecheck", "pnpm lint"],
          setupCommands: ["pnpm install --frozen-lockfile"],
          lockfile: "pnpm-lock.yaml",
        },
      },
      { path: "/Users/me/code/dotfiles", setUp: false },
    ],
    ...(mode === "settings"
      ? { specialists: { registry: specialistsFixture(), project: "tandem" } }
      : {}),
  });
}
