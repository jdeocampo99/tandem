import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicy, parsePolicyOverride } from "../../src/config/policy.ts";
import {
  onboardRepo,
  resolveRepoPolicy,
  saveRepositoryCommands,
} from "../../src/config/repositories.ts";

async function withRepo(run: (repo: string, home: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tandem-discovery-"));
  await mkdir(join(root, "repo"));
  try {
    await run(await realpath(join(root, "repo")), join(root, "home"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("onboarding offers ecosystem checks as suggestions only, never as proposed commands", async () => {
  await withRepo(async (repo, home) => {
    await writeFile(join(repo, "go.mod"), "module example.com/x\n", "utf8");
    await writeFile(join(repo, "Makefile"), "test:\n\tgo test ./...\n", "utf8");
    const proposal = await onboardRepo({ repoPath: repo, home });
    expect(proposal.validationCommands).toEqual([]);
    expect(proposal.noChecks).toBe(false);
    expect(proposal.discovery).toEqual({
      commands: ["go vet ./...", "go test ./...", "make test"],
      sources: ["go.mod", "Makefile"],
    });
    expect(proposal.unresolved).toContain(
      "no validation commands are configured; validation remains unresolved",
    );
  });
});

test("a uv.lock repository installs with uv and never gets a bun script runner", async () => {
  await withRepo(async (repo, home) => {
    await writeFile(join(repo, "uv.lock"), "version = 1\n", "utf8");
    await writeFile(join(repo, "pyproject.toml"), "[project]\nname = 'x'\n", "utf8");
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
      "utf8",
    );
    const proposal = await onboardRepo({ repoPath: repo, home });
    expect(proposal.setupCommands.map((command) => command.name)).toEqual(["uv sync --frozen"]);
    expect(proposal.validationCommands.map((command) => command.name)).toEqual(["npm run lint"]);
    expect(proposal.discovery.commands).toEqual(["npm run lint", "uv run pytest"]);
    expect(proposal.discovery.commands.some((command) => command.startsWith("bun "))).toBe(false);
    expect(proposal.discovery.lockfile).toBe("uv.lock");
  });
});

test("no checks is a deliberate setting, saved explicitly and never beside commands", async () => {
  await withRepo(async (repo, home) => {
    await expect(
      onboardRepo({ repoPath: repo, home, noChecks: true, validationCommands: ["make check"] }),
    ).rejects.toThrow("No checks can't be saved together with validation commands");

    const written = await onboardRepo({ repoPath: repo, home, write: true, noChecks: true });
    expect(written.noChecks).toBe(true);
    expect(written.unresolved).toEqual([]);
    const text = await readFile(written.configPath, "utf8");
    expect(text).toContain('validation = "none"\nvalidationCommands = []');
    const resolved = await resolveRepoPolicy({ repoPath: repo, home });
    expect(resolved.config.validation).toBe("none");
    expect(resolved.config.validationCommands).toEqual([]);

    // Saving commands clears the choice; choosing no checks again restores it.
    await saveRepositoryCommands({
      repoPath: repo,
      home,
      validationCommands: ["make check"],
      noChecks: false,
    });
    const withCommands = await resolveRepoPolicy({ repoPath: repo, home });
    expect(withCommands.config.validation).toBeUndefined();
    expect(withCommands.config.validationCommands.map((command) => command.name)).toEqual([
      "make check",
    ]);
    expect(await readFile(written.configPath, "utf8")).not.toContain('\nvalidation = "none"');

    await saveRepositoryCommands({ repoPath: repo, home, validationCommands: [], noChecks: true });
    expect(await readFile(written.configPath, "utf8")).toBe(text);
    // No checks beside the commands still in the file is refused, and nothing is written.
    await saveRepositoryCommands({
      repoPath: repo,
      home,
      validationCommands: ["make check"],
      noChecks: false,
    });
    const before = await readFile(written.configPath, "utf8");
    await expect(saveRepositoryCommands({ repoPath: repo, home, noChecks: true })).rejects.toThrow(
      "means no checks",
    );
    expect(await readFile(written.configPath, "utf8")).toBe(before);
  });
});

test("a project never set up with checks is not the same as one that chose none", async () => {
  await withRepo(async (repo, home) => {
    await onboardRepo({ repoPath: repo, home, write: true });
    const resolved = await resolveRepoPolicy({ repoPath: repo, home });
    expect(resolved.config.validationCommands).toEqual([]);
    expect(resolved.config.validation).toBeUndefined();
  });
});

test('validation = "none" holds only while no validation command is configured', () => {
  expect(parsePolicy({ validation: "none" }).validation).toBe("none");
  expect(() => parsePolicy({ validation: "none", validationCommands: ["make check"] })).toThrow(
    "means no checks",
  );
  expect(() => parsePolicy({ validation: "required" })).toThrow(TypeError);
  // Commands a later layer adds replace an inherited "none".
  const global = parsePolicy({ validation: "none" });
  const layered = parsePolicyOverride({ validationCommands: ["make check"] }, global);
  expect(layered.validation).toBeUndefined();
  expect(parsePolicyOverride({}, global).validation).toBe("none");
});

test("onboarding keeps lockfile selection separate from the later ecosystem snapshot", async () => {
  await withRepo(async (repo, home) => {
    const reads: string[] = [];
    const snapshots = new Map<string, (string | undefined)[]>([
      [join(repo, "uv.lock"), ["", undefined]],
      [join(repo, "package.json"), ['{"scripts":{"test":"test"}}']],
      [join(repo, "pyproject.toml"), ["[project]"]],
    ]);
    const result = await onboardRepo({
      repoPath: repo,
      home,
      readText: (file) => {
        reads.push(file);
        return snapshots.get(file)?.shift();
      },
    });
    expect(result.setupCommands.map((command) => command.name)).toEqual(["uv sync --frozen"]);
    expect(result.discovery).toEqual({
      commands: ["npm run test"],
      sources: ["package.json scripts"],
      lockfile: "uv.lock",
    });
    expect(
      reads
        .filter((file) => file.startsWith(`${repo}/`))
        .map((file) => file.slice(repo.length + 1)),
    ).toEqual([
      "package.json",
      "bun.lock",
      "bun.lockb",
      "pnpm-lock.yaml",
      "yarn.lock",
      "package-lock.json",
      "uv.lock",
      "go.mod",
      "Cargo.toml",
      "pyproject.toml",
      "uv.lock",
      "Makefile",
      "makefile",
      "justfile",
      "Justfile",
    ]);
  });
});
