import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicy } from "../../src/config/policy.ts";
import {
  onboardRepo,
  readMergingSettings,
  saveMergingChoice,
  saveRepositoryCommands,
} from "../../src/config/repositories.ts";
import {
  applySettingsEdit,
  type RepositoryCommandEdit,
  serializeCentralConfig,
} from "../../src/config/repository-settings.ts";

async function withFixture(
  name: string,
  run: (fixture: Readonly<{ repo: string; home: string }>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tandem-settings-"));
  await mkdir(join(root, name));
  try {
    await run({ repo: await realpath(join(root, name)), home: join(root, "home") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("every commented-out setting in a new settings.toml is valid once uncommented", async () => {
  await withFixture("template-repo", async ({ repo, home }) => {
    const written = await onboardRepo({ repoPath: repo, home, write: true });
    const text = await readFile(written.configPath, "utf8");
    // Uncomment only setting lines ("# key = ..." and "# [table]"), not prose comments.
    const enabled = text.replace(/^# (?=[A-Za-z]+ = |\[)/gmu, "");
    const settings = Bun.TOML.parse(enabled) as Record<string, unknown>;
    expect(Object.keys(settings).sort()).toEqual([
      "cleanupCommands",
      "instructionFiles",
      "instructions",
      "maxFixRounds",
      "merging",
      "models",
      "repoPath",
      "setupCommands",
      "standards",
      "validationCommands",
    ]);
    const { repoPath, cleanupCommands, merging, ...policy } = settings;
    expect(repoPath).toBe(repo);
    expect(merging).toEqual({
      mergeWith: "queue-label",
      queueLabel: "mergequeue",
      blockedLabel: "blocked",
      maxCiRetries: 1,
      stuckAfterMinutes: 60,
    });
    await writeFile(written.configPath, enabled, "utf8");
    expect(await readMergingSettings({ repoPath: repo, home })).toEqual(
      merging as Awaited<ReturnType<typeof readMergingSettings>>,
    );
    expect(cleanupCommands).toEqual(["docker compose down"]);
    expect(() => parsePolicy(policy)).not.toThrow();
  });
});

const commandCases: readonly (readonly [string, string, string, RepositoryCommandEdit])[] = [
  [
    "multiline lists",
    'repoPath = "x"\nvalidationCommands = [\n  "echo \\"[x]\\"", # ] ignored\n  \'echo ]\',\n] # keep this\nsetupCommands = ["old"]\n',
    'repoPath = "x"\nvalidationCommands = ["make check"] # keep this\nsetupCommands = ["old"]\n',
    { validationCommands: ["make check"] },
  ],
  [
    "commented examples",
    '# heading\n# setupCommands = ["old"]\n# validationCommands = ["old"]\n\n[instructions]\nvalidationCommands = ["table"]\n',
    '# heading\nsetupCommands = ["deps"]\nvalidationCommands = ["check"]\n\n[instructions]\nvalidationCommands = ["table"]\n',
    { setupCommands: ["deps"], validationCommands: ["check"] },
  ],
  [
    "missing keys before tables",
    'repoPath = "x"\n\n[instructions]\nreview = []\n',
    'repoPath = "x"\n\nsetupCommands = ["deps"]\n\nvalidation = "none"\nvalidationCommands = []\n\n[instructions]\nreview = []\n',
    { setupCommands: ["deps"], validationCommands: [], noChecks: true },
  ],
  [
    "missing keys without a final newline",
    'repoPath = "x"',
    'repoPath = "x"\n\nvalidationCommands = ["check"]\n',
    { validationCommands: ["check"] },
  ],
  [
    "no checks above an example",
    '# validationCommands = ["old"]\n',
    'validation = "none"\n# validationCommands = ["old"]\n',
    { noChecks: true },
  ],
  [
    "no checks without an anchor",
    'repoPath = "x"',
    'repoPath = "x"\n\nvalidation = "none"\n',
    { noChecks: true },
  ],
  [
    "replace the no-checks line",
    'validation = "none" # existing\nvalidationCommands = []\n',
    'validation = "none"\nvalidationCommands = []\n',
    { noChecks: true },
  ],
  [
    "remove only top-level no checks",
    'validation = "none" # existing\nvalidationCommands = []\n[instructions]\nvalidation = []\n',
    "validationCommands = []\n[instructions]\nvalidation = []\n",
    { noChecks: false },
  ],
  ["undefined edits", 'repoPath = "x"\n# unchanged\n', 'repoPath = "x"\n# unchanged\n', {}],
];

test.each(commandCases)(
  "settings text edits preserve bytes around %s",
  (_name, before, after, edit) => {
    expect(applySettingsEdit(before, { ...edit, kind: "commands" })).toBe(after);
  },
);

test("settings text edits retain command-list errors", () => {
  expect(() =>
    applySettingsEdit('setupCommands = "old"', { kind: "commands", setupCommands: [] }),
  ).toThrow("settings.toml has a command setting that is not a list");
  expect(() =>
    applySettingsEdit('setupCommands = ["old"', { kind: "commands", setupCommands: [] }),
  ).toThrow("settings.toml has an unterminated command list");
});

test("merging text edits preserve labels, table ordering, comments, and whitespace", () => {
  const before = 'repoPath = "x"\n\n\n';
  expect(
    applySettingsEdit(before, {
      kind: "merging",
      existingTable: false,
      choice: { mergeWith: "queue-label", queueLabel: 'queue "ready"', blockedLabel: "blocked" },
    }),
  ).toBe(
    'repoPath = "x"\n\n[merging]\nmergeWith = "queue-label"\nqueueLabel = "queue \\"ready\\""\nblockedLabel = "blocked"\n',
  );
  const table =
    'repoPath = "x"\n\n[merging]  \t\n# patience\nmaxCiRetries = 2\n\n[instructions]\nreview = []\n';
  expect(
    applySettingsEdit(table, {
      kind: "merging",
      existingTable: true,
      choice: { mergeWith: "off" },
    }),
  ).toBe(
    'repoPath = "x"\n\n[merging]\nmergeWith = "off"\n# patience\nmaxCiRetries = 2\n\n[instructions]\nreview = []\n',
  );
  const commentedHeader = "[merging] # keep\nmaxCiRetries = 2\n";
  expect(
    applySettingsEdit(commentedHeader, {
      kind: "merging",
      existingTable: true,
      choice: { mergeWith: "auto-merge" },
    }),
  ).toBe(commentedHeader);
});

test("new settings serialize byte for byte like the original template", async () => {
  const expected = await readFile(
    new URL("./fixtures/repository-settings.toml", import.meta.url),
    "utf8",
  );
  expect(
    serializeCentralConfig("/example/repo", {
      validationCommands: ["make check"],
      setupCommands: ["make deps"],
      noChecks: false,
    }),
  ).toBe(expected);
  expect(
    serializeCentralConfig("/example/repo", {
      validationCommands: [],
      setupCommands: ["make deps"],
      noChecks: true,
    }),
  ).toBe(
    expected.replace(
      'validationCommands = ["make check"]',
      'validation = "none"\nvalidationCommands = []',
    ),
  );
});

test.each(["commands", "merging"] as const)(
  "saving %s refuses a concurrently changed file",
  async (kind) => {
    await withFixture("stale", async ({ repo, home }) => {
      const { configPath } = await onboardRepo({ repoPath: repo, home, write: true });
      const before = await readFile(configPath, "utf8");
      const concurrent = `${before}\n# concurrent edit\n`;
      const parse = Bun.TOML.parse;
      let changed = false;
      const parsing = spyOn(Bun.TOML, "parse").mockImplementation((text) => {
        if (text === before && !changed) {
          changed = true;
          writeFileSync(configPath, concurrent);
        }
        return parse(text);
      });
      try {
        const save =
          kind === "commands"
            ? saveRepositoryCommands({ repoPath: repo, home, validationCommands: ["check"] })
            : saveMergingChoice({ repoPath: repo, home, choice: { mergeWith: "off" } });
        await expect(save).rejects.toThrow(
          `${configPath} changed while saving; nothing was written. Try again.`,
        );
        expect(await readFile(configPath, "utf8")).toBe(concurrent);
      } finally {
        parsing.mockRestore();
      }
    });
  },
);

test("command saves skip unchanged writes while merging saves retain their write", async () => {
  await withFixture("unchanged", async ({ repo, home }) => {
    const { configPath } = await onboardRepo({ repoPath: repo, home, write: true });
    const original = await stat(configPath);
    await saveRepositoryCommands({ repoPath: repo, home });
    expect((await stat(configPath)).ino).toBe(original.ino);
    const commentedHeader = `repoPath = ${JSON.stringify(repo)}\n[merging] # keep\nmaxCiRetries = 2\n`;
    await writeFile(configPath, commentedHeader);
    const beforeMerge = await stat(configPath);
    expect(await saveMergingChoice({ repoPath: repo, home, choice: { mergeWith: "off" } })).toEqual(
      { maxCiRetries: 2 },
    );
    expect(await readFile(configPath, "utf8")).toBe(commentedHeader);
    expect((await stat(configPath)).ino).not.toBe(beforeMerge.ino);
  });
});
