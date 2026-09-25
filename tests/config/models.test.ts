import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelSettings, writeModelSettings } from "../../src/config/models.ts";

const MODELS = {
  coordinator: { model: "acme/coordinator", thinking: "high" },
  scout: { model: "acme/scout", thinking: "medium" },
  implementer: { model: "acme/implementer", thinking: "max" },
  reviewer: { model: "acme/reviewer", thinking: "max" },
  presentation: { model: "acme/presentation", thinking: "low" },
} as const;

async function withFixture(
  run: (fixture: { repo: string; home: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tandem-models-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true });
  try {
    await run({ repo, home });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("unconfigured settings report no enabled providers", async () => {
  await withFixture(async ({ repo, home }) => {
    const settings = await readModelSettings({ repoPath: repo, home });
    expect(settings.configured).toBe(false);
    expect(settings.enabledProviders).toEqual([]);
  });
});

test("writeModelSettings persists enabled providers deduplicated and sorted", async () => {
  await withFixture(async ({ repo, home }) => {
    const written = await writeModelSettings({
      repoPath: repo,
      home,
      models: MODELS,
      enabledProviders: ["globex", "acme", "acme"],
    });
    expect(written.enabledProviders).toEqual(["acme", "globex"]);

    const reread = await readModelSettings({ repoPath: repo, home });
    expect(reread.enabledProviders).toEqual(["acme", "globex"]);
    const raw = JSON.parse(await readFile(join(home, "models.json"), "utf8"));
    expect(raw.enabledProviders).toEqual(["acme", "globex"]);
  });
});

test("omitting enabledProviders on a rewrite preserves the previously saved set", async () => {
  await withFixture(async ({ repo, home }) => {
    await writeModelSettings({ repoPath: repo, home, models: MODELS, enabledProviders: ["acme"] });
    const rewritten = await writeModelSettings({
      repoPath: repo,
      home,
      models: { ...MODELS, coordinator: { model: "acme/coordinator-2", thinking: "high" } },
    });
    expect(rewritten.enabledProviders).toEqual(["acme"]);
  });
});

test("an explicit empty array clears previously enabled providers", async () => {
  await withFixture(async ({ repo, home }) => {
    await writeModelSettings({ repoPath: repo, home, models: MODELS, enabledProviders: ["acme"] });
    const cleared = await writeModelSettings({
      repoPath: repo,
      home,
      models: MODELS,
      enabledProviders: [],
    });
    expect(cleared.enabledProviders).toEqual([]);
  });
});

test("a models.json written before this feature existed is read with no enabled providers", async () => {
  await withFixture(async ({ repo, home }) => {
    await writeModelSettings({ repoPath: repo, home, models: MODELS });
    const settings = await readModelSettings({ repoPath: repo, home });
    expect(settings.enabledProviders).toEqual([]);
    expect(settings.models).toEqual(MODELS);
  });
});

test("a models.json saved before the verifier role was removed still loads, ignoring it", async () => {
  await withFixture(async ({ repo, home }) => {
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "models.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        models: { ...MODELS, verifier: { model: "acme/verifier", thinking: "high" } },
        enabledProviders: [],
      })}\n`,
      "utf8",
    );
    const settings = await readModelSettings({ repoPath: repo, home });
    expect(settings.configured).toBe(true);
    expect(settings.models).toEqual(MODELS);
  });
});

test("rejects a non-string entry in enabledProviders", async () => {
  await withFixture(async ({ repo, home }) => {
    await expect(
      writeModelSettings({
        repoPath: repo,
        home,
        models: MODELS,
        enabledProviders: [42] as unknown as readonly string[],
      }),
    ).rejects.toThrow(TypeError);
  });
});

test("Jev is on until turned off, and a rewrite that omits it keeps the saved choice", async () => {
  await withFixture(async ({ repo, home }) => {
    expect((await readModelSettings({ repoPath: repo, home })).jev).toBe("on");
    await writeModelSettings({ repoPath: repo, home, models: MODELS, jev: "off" });
    const rewritten = await writeModelSettings({ repoPath: repo, home, models: MODELS });
    expect(rewritten.jev).toBe("off");
  });
});
