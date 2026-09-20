import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultPolicy, parsePolicy } from "../../src/config/policy.ts";
import { onboardRepo, resolveRepoPolicy } from "../../src/config/repositories.ts";

type PolicyFixture = Readonly<{
  root: string;
  repo: string;
  home: string;
}>;

async function withFixture(
  name: string,
  run: (fixture: PolicyFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tandem-policy-"));
  const repoPath = join(root, name);
  const home = join(root, "tandem-home");
  await mkdir(repoPath);
  const repo = await realpath(repoPath);
  try {
    await run({ root, repo, home });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function writeCentralEnvelope(
  configPath: string,
  repoPath: string,
  policy: unknown,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ schemaVersion: 1, repoPath, policy }, null, 2)}\n`,
    "utf8",
  );
}

test("defaultPolicy exposes the exact configured role pins", () => {
  const policy = defaultPolicy();

  expect(policy.models).toEqual({
    coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
    scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
    implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
    reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
    verifier: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
    presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
  });
  expect(policy.maxWorkers).toBe(3);
  expect(policy.maxFixRounds).toBe(3);
});

test("resolveRepoPolicy inherits global values, appends guidance, and snapshots file content", async () => {
  await withFixture("tandem-repo", async ({ repo, home }) => {
    const instructionPath = join(repo, "docs", "implementation.md");
    await mkdir(dirname(instructionPath), { recursive: true });
    await writeFile(join(repo, "AGENTS.md"), "root guidance", "utf8");
    await writeFile(instructionPath, "pinned file guidance", "utf8");

    const preview = await onboardRepo({ repoPath: repo, home });
    await writeCentralEnvelope(preview.configPath, repo, {
      models: { reviewer: { thinking: "high" } },
      instructions: { implementation: ["repository instruction"] },
      instructionFiles: { implementation: ["docs/implementation.md"] },
    });

    const resolved = await resolveRepoPolicy({
      repoPath: repo,
      home,
      globalPolicy: {
        models: { implementer: { thinking: "low" } },
        instructions: { implementation: ["global instruction"] },
        maxWorkers: 4,
      },
    });

    expect(resolved.config.models.implementer.thinking).toBe("low");
    expect(resolved.config.models.reviewer.thinking).toBe("high");
    expect(resolved.config.maxWorkers).toBe(4);
    expect(resolved.config.instructions.implementation).toEqual([
      "global instruction",
      "repository instruction",
    ]);
    expect(resolved.guidance.implementation.map((entry) => entry.text)).toEqual([
      "global instruction",
      "repository instruction",
      "root guidance",
      "pinned file guidance",
    ]);
    expect(resolved.guidance.implementation[3]?.provenance.source).toBe("docs/implementation.md");

    await writeFile(instructionPath, "mutated after resolution", "utf8");
    expect(resolved.guidance.implementation[3]?.text).toBe("pinned file guidance");
  });
});
test("clean-bound policy reads guidance and onboarding metadata from the checkout", async () => {
  await withFixture("clean-bound-repo", async ({ root, repo, home }) => {
    const clean = join(root, "clean-source");
    await mkdir(join(clean, "docs"), { recursive: true });
    await writeFile(join(repo, "AGENTS.md"), "dirty original guidance", "utf8");
    await writeFile(join(clean, "AGENTS.md"), "committed clean guidance", "utf8");
    await writeFile(join(clean, "docs", "implementation.md"), "clean file guidance", "utf8");
    await writeFile(
      join(clean, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
      "utf8",
    );

    const preview = await onboardRepo({ repoPath: repo, checkoutPath: clean, home });
    expect(preview.validationCommands.map((command) => command.argv)).toEqual([
      ["bun", "run", "test"],
    ]);
    await writeCentralEnvelope(preview.configPath, repo, {
      instructionFiles: { implementation: ["docs/implementation.md"] },
    });

    const resolved = await resolveRepoPolicy({
      repoPath: repo,
      checkoutPath: clean,
      home,
    });
    expect(resolved.guidance.implementation.map((entry) => entry.text)).toEqual([
      "committed clean guidance",
      "clean file guidance",
    ]);
  });
});

test("parsePolicy accepts exact custom provider selectors but rejects fuzzy aliases", () => {
  const parsed = parsePolicy({
    models: { implementer: { model: "custom-provider/custom-model-v1" } },
  });

  expect(parsed.models.implementer.model).toBe("custom-provider/custom-model-v1");
  expect(() => parsePolicy({ models: { implementer: { model: "custom-model-v1" } } })).toThrow(
    TypeError,
  );
  expect(() =>
    parsePolicy({ models: { implementer: { model: "custom-provider/custom model" } } }),
  ).toThrow(TypeError);
});

test("parsePolicy rejects unknown keys, invalid pins, invalid limits, and unsafe file references", () => {
  expect(() => parsePolicy({ unexpected: true })).toThrow(TypeError);
  expect(() => parsePolicy({ models: { scout: { model: "gpt-5.6-luna" } } })).toThrow(TypeError);
  expect(() => parsePolicy({ models: { scout: { thinking: "turbo" } } })).toThrow(TypeError);
  expect(() => parsePolicy({ maxWorkers: 0 })).toThrow(TypeError);
  expect(() => parsePolicy({ maxFixRounds: -1 })).toThrow(TypeError);
  expect(() => parsePolicy({ instructionFiles: { review: ["../outside.md"] } })).toThrow(TypeError);
  expect(() =>
    parsePolicy({
      validationCommands: [{ name: "empty", argv: [], surfaces: [], timeoutMs: 1000 }],
    }),
  ).toThrow(TypeError);
});

test("resolveRepoPolicy refuses missing configured guidance files", async () => {
  await withFixture("missing-guidance-repo", async ({ repo, home }) => {
    const preview = await onboardRepo({ repoPath: repo, home });
    await writeCentralEnvelope(preview.configPath, repo, {
      instructionFiles: { validation: ["docs/missing.md"] },
    });

    await expect(resolveRepoPolicy({ repoPath: repo, home })).rejects.toThrow(Error);
  });
});

test("read-only onboarding leaves the target and absent Tandem home untouched", async () => {
  await withFixture("onboard-repo", async ({ repo, home }) => {
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "bun test", lint: "bun lint", start: "bun start" } }),
      "utf8",
    );
    await writeFile(join(repo, ".tandem.json"), JSON.stringify({ maxWorkers: 1 }), "utf8");

    const first = await onboardRepo({ repoPath: repo, home });

    expect(first.existingConfig).toBe(false);
    expect(first.written).toBe(false);
    expect(first.approvalRequired).toBe(true);
    expect(first.modelSettings.configured).toBe(false);
    expect(first.validationCommands.map((command) => command.argv)).toEqual([
      ["bun", "run", "lint"],
      ["bun", "run", "test"],
    ]);
    expect(await pathExists(home)).toBe(false);
    expect(await pathExists(first.configPath)).toBe(false);
    expect(await readFile(join(repo, ".tandem.json"), "utf8")).toBe(
      JSON.stringify({ maxWorkers: 1 }),
    );

    const written = await onboardRepo({ repoPath: repo, home, write: true });
    expect(written.modelSettings.configured).toBe(false);
    expect(written.written).toBe(true);
    const resolved = await resolveRepoPolicy({ repoPath: repo, home });
    expect(resolved.config.maxWorkers).toBe(3);
    await expect(onboardRepo({ repoPath: repo, home, write: true })).rejects.toThrow(Error);
  });
});

test("onboardRepo prefers an explicit ci:local proposal when discovered", async () => {
  await withFixture("ci-local-repo", async ({ repo, home }) => {
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { "ci:local": "bun run check", test: "bun test" } }),
      "utf8",
    );

    const proposal = await onboardRepo({ repoPath: repo, home });

    expect(proposal.unresolved).toEqual([]);
    expect(proposal.approvalRequired).toBe(true);
    expect(proposal.validationCommands.map((entry) => entry.argv)).toEqual([
      ["bun", "run", "ci:local"],
    ]);
  });
});

test("setup writes a private central policy and never creates a child-repository policy", async () => {
  await withFixture("empty-onboard-repo", async ({ repo, home }) => {
    const result = await onboardRepo({ repoPath: repo, home, write: true });

    expect(result.written).toBe(true);
    expect(result.configPath.startsWith(`${repo}/`)).toBe(false);
    expect(await pathExists(result.configPath)).toBe(true);
    expect(await pathExists(join(repo, ".tandem.json"))).toBe(false);
    expect(result.validationCommands).toEqual([]);
    expect(result.unresolved.length).toBeGreaterThan(0);

    const homeMode = (await stat(home)).mode & 0o777;
    const repositoriesMode = (await stat(join(home, "repositories"))).mode & 0o777;
    const configMode = (await stat(result.configPath)).mode & 0o777;
    expect(homeMode).toBe(0o700);
    expect(repositoriesMode).toBe(0o700);
    expect(configMode).toBe(0o600);

    const resolved = await resolveRepoPolicy({ repoPath: repo, home });
    expect(resolved.config.validationCommands).toEqual([]);
  });
});

test("canonical repository aliases share central policy while distinct roots and homes stay isolated", async () => {
  await withFixture("same-name-repo", async ({ root, repo, home }) => {
    const alias = join(root, "repo-alias");
    await symlink(repo, alias, "dir");
    const aliasPreview = await onboardRepo({ repoPath: alias, home });
    const rootPreview = await onboardRepo({ repoPath: repo, home });
    expect(aliasPreview.configPath).toBe(rootPreview.configPath);

    await onboardRepo({ repoPath: alias, home, write: true });
    const resolvedThroughRoot = await resolveRepoPolicy({ repoPath: repo, home });
    expect(resolvedThroughRoot.config.validationCommands).toEqual([]);

    const otherParent = await mkdtemp(join(tmpdir(), "tandem-policy-other-"));
    try {
      const otherRepo = join(otherParent, "same-name-repo");
      await mkdir(otherRepo);
      const otherPreview = await onboardRepo({ repoPath: otherRepo, home });
      expect(otherPreview.configPath).not.toBe(rootPreview.configPath);
      await writeCentralEnvelope(rootPreview.configPath, repo, {
        maxWorkers: 1,
      });
      const otherResolved = await resolveRepoPolicy({ repoPath: otherRepo, home });
      expect(otherResolved.config.maxWorkers).toBe(3);

      const separateHome = join(root, "separate-home");
      const separatePreview = await onboardRepo({ repoPath: repo, home: separateHome });
      expect(separatePreview.configPath).not.toBe(rootPreview.configPath);
      const separateResolved = await resolveRepoPolicy({ repoPath: repo, home: separateHome });
      expect(separateResolved.config.maxWorkers).toBe(3);
    } finally {
      await rm(otherParent, { recursive: true, force: true });
    }
  });
});

test("central policy validation rejects malformed and mismatched repository identity", async () => {
  await withFixture("identity-repo", async ({ repo, home }) => {
    const preview = await onboardRepo({ repoPath: repo, home });
    await mkdir(dirname(preview.configPath), { recursive: true });
    await writeFile(preview.configPath, "{not-json", "utf8");
    await expect(resolveRepoPolicy({ repoPath: repo, home })).rejects.toThrow(TypeError);
    await expect(onboardRepo({ repoPath: repo, home, write: true })).rejects.toThrow(TypeError);

    await rm(preview.configPath);
    await writeCentralEnvelope(preview.configPath, `${repo}-different`, {});
    await expect(resolveRepoPolicy({ repoPath: repo, home })).rejects.toThrow(TypeError);
  });
});

test("central symlink escapes are rejected before setup writes outside Tandem home", async () => {
  await withFixture("symlink-repo", async ({ repo, home }) => {
    const outside = join(home, "..", "outside-policy");
    await mkdir(outside);
    await mkdir(home);
    await symlink(outside, join(home, "repositories"), "dir");
    await expect(onboardRepo({ repoPath: repo, home, write: true })).rejects.toThrow(Error);
    expect(await readdir(outside)).toEqual([]);
  });
});
test("central setup rejects a home namespace symlink into the target repository", async () => {
  await withFixture("internal-symlink-repo", async ({ root, repo }) => {
    const home = root;
    await symlink(repo, join(home, "repositories"), "dir");

    await expect(onboardRepo({ repoPath: repo, home, write: true })).rejects.toThrow(Error);
    expect(await readdir(repo)).toEqual([]);
  });
});

test("a configured home inside the target repository fails closed without creating it", async () => {
  await withFixture("home-inside-repo", async ({ repo }) => {
    const home = join(repo, ".tandem-home");
    await expect(onboardRepo({ repoPath: repo, home, write: true })).rejects.toThrow(Error);
    expect(await pathExists(home)).toBe(false);
  });
});

test("every review-level opt-in is off by default", () => {
  expect(defaultPolicy().reviewLevels).toEqual({
    reducedRouting: false,
    deepScrutiny: false,
    jevAssistance: "off",
    sourceTransmission: false,
  });
  expect(parsePolicy({}).reviewLevels).toEqual(defaultPolicy().reviewLevels);
});

test("a repository can opt into each review-level setting explicitly", () => {
  const parsed = parsePolicy({
    reviewLevels: {
      reducedRouting: true,
      deepScrutiny: true,
      jevAssistance: "shadow",
      sourceTransmission: true,
    },
  });
  expect(parsed.reviewLevels).toEqual({
    reducedRouting: true,
    deepScrutiny: true,
    jevAssistance: "shadow",
    sourceTransmission: true,
  });
  expect(parsePolicy({ reviewLevels: { deepScrutiny: true } }).reviewLevels).toEqual({
    reducedRouting: false,
    deepScrutiny: true,
    jevAssistance: "off",
    sourceTransmission: false,
  });
});

test("review-level settings reject unknown keys, wrong types, and unsupported modes", () => {
  expect(() => parsePolicy({ reviewLevels: { reduceEverything: true } })).toThrow(TypeError);
  expect(() => parsePolicy({ reviewLevels: { reducedRouting: "yes" } })).toThrow(TypeError);
  expect(() => parsePolicy({ reviewLevels: { jevAssistance: "active" } })).toThrow(TypeError);
  expect(() => parsePolicy({ reviewLevels: [] })).toThrow(TypeError);
});
