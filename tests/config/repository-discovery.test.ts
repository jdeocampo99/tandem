import { expect, test } from "bun:test";
import {
  detectEcosystemChecks,
  discoverRepositoryCommands,
} from "../../src/config/repository-discovery.ts";

test("Go, Rust, and uv Python projects suggest their usual checks, named by their files", () => {
  expect(
    detectEcosystemChecks({
      "go.mod": "module example.com/x\n",
      "Cargo.toml": "[package]\n",
      "pyproject.toml": "[project]\n",
      "uv.lock": "version = 1\n",
    }),
  ).toEqual([
    { command: "go vet ./...", from: "go.mod" },
    { command: "go test ./...", from: "go.mod" },
    { command: "cargo clippy", from: "Cargo.toml" },
    { command: "cargo test", from: "Cargo.toml" },
    { command: "uv run pytest", from: "pyproject.toml and uv.lock" },
  ]);
  // pytest through uv needs both the project and its lockfile.
  expect(detectEcosystemChecks({ "pyproject.toml": "[project]\n" })).toEqual([]);
});

test("Makefile and justfile check, lint, and test targets are read as text, never run", () => {
  const makefile = [
    "VERSION := 1",
    "test: build",
    "\tgo test ./...",
    "lint fmt: deps",
    "\tgolangci-lint run",
    "deploy:",
    "\t./deploy",
    "check:= not a rule",
  ].join("\n");
  expect(detectEcosystemChecks({ Makefile: makefile })).toEqual([
    { command: "make lint", from: "Makefile" },
    { command: "make test", from: "Makefile" },
  ]);
  const justfile = ["set shell := ['bash']", "check:", "  cargo check", "@test *args:", "  x"].join(
    "\n",
  );
  expect(detectEcosystemChecks({ justfile })).toEqual([
    { command: "just check", from: "justfile" },
    { command: "just test", from: "justfile" },
  ]);
  expect(detectEcosystemChecks({})).toEqual([]);
});

test.each([
  [undefined, "package.json is missing; no validation commands were proposed"],
  ["{", "package.json is invalid JSON; no validation commands were proposed"],
  ["[]", "package.json must be an object; no validation commands were proposed"],
  ["{}", "package.json has no scripts; no validation commands were proposed"],
  [
    '{"scripts":[]}',
    "package.json.scripts must be an object; no validation commands were proposed",
  ],
])("package discovery preserves unresolved reasons for %s", (packageText, reason) => {
  const result = discoverRepositoryCommands({
    ...(packageText === undefined ? {} : { packageText }),
    ecosystemFiles: { "go.mod": "" },
  });
  expect(result.proposal).toEqual({ commands: [], unresolved: [reason], approvalRequired: false });
  expect(result.setupCommands).toEqual([]);
  expect(result.discovery).toEqual({
    commands: ["go vet ./...", "go test ./..."],
    sources: ["go.mod"],
  });
});

test.each([
  ["bun.lock", "bun install --frozen-lockfile", "bun"],
  ["bun.lockb", "bun install --frozen-lockfile", "bun"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile", "pnpm"],
  ["yarn.lock", "yarn install --immutable", "yarn"],
  ["package-lock.json", "npm ci", "npm"],
  ["uv.lock", "uv sync --frozen", "npm"],
])("package discovery uses %s for installs and scripts", (lockfile, install, runner) => {
  const result = discoverRepositoryCommands({
    lockfile,
    packageText: JSON.stringify({
      scripts: { test: "test", "ci:local": "ci", build: "build", blank: " " },
    }),
    ecosystemFiles: {},
  });
  expect(result.setupCommands).toEqual([install]);
  expect(result.proposal).toEqual({
    commands: [`${runner} run ci:local`],
    unresolved: [],
    approvalRequired: true,
  });
  expect(result.discovery).toEqual({
    commands: [`${runner} run test`, `${runner} run ci:local`, `${runner} run build`],
    sources: ["package.json scripts"],
    lockfile,
  });
});

test("package discovery orders fallback checks and de-duplicates ecosystem suggestions", () => {
  const result = discoverRepositoryCommands({
    packageText: JSON.stringify({
      scripts: { test: "x", lint: "x", check: "x", typecheck: "x", "ci:local": " " },
    }),
    ecosystemFiles: {
      Makefile: "test:\n",
      makefile: "check:\n",
      justfile: "check:\n",
      Justfile: "test:\n",
    },
  });
  expect(result.proposal).toEqual({
    commands: ["bun run check", "bun run typecheck", "bun run lint", "bun run test"],
    unresolved: [
      "package.json has no ci:local script; review the validation proposal before approval",
    ],
    approvalRequired: true,
  });
  expect(result.discovery.commands).toEqual([
    "bun run test",
    "bun run lint",
    "bun run check",
    "bun run typecheck",
    "make test",
    "just check",
  ]);
  expect(result.discovery.sources).toEqual(["package.json scripts", "Makefile", "justfile"]);
  expect(
    discoverRepositoryCommands({ packageText: '{"scripts":{}}', ecosystemFiles: {} }).proposal,
  ).toEqual({
    commands: [],
    approvalRequired: false,
    unresolved: [
      "package.json has no ci:local script; review the validation proposal before approval",
      "package.json has no discovered validation scripts; no commands were proposed",
    ],
  });
});
