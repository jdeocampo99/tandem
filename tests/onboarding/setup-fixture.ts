import type { ModelRecord } from "../../src/harness/contract.ts";
import { buildSetupView, type SetupMode, type SetupView } from "../../src/onboarding/setup-view.ts";

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
          noChecks: false,
          discoveredCommands: ["bun run check", "bun test", "bun run lint"],
          sources: ["package.json scripts"],
          setupCommands: ["bun install --frozen-lockfile"],
          lockfile: "bun.lock",
        },
      },
      {
        path: "/Users/me/code/web-app",
        setUp: false,
        details: {
          validationCommands: ["pnpm typecheck"],
          noChecks: false,
          discoveredCommands: ["pnpm typecheck", "pnpm lint"],
          sources: ["package.json scripts"],
          setupCommands: ["pnpm install --frozen-lockfile"],
          lockfile: "pnpm-lock.yaml",
        },
      },
      { path: "/Users/me/code/dotfiles", setUp: false },
    ],
  });
}
