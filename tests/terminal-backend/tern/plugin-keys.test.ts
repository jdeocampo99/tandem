import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  describeTernPluginKeys,
  planTernPluginKeys,
} from "../../../src/terminal-backend/tern/plugin-keys.ts";
import {
  configureTernPluginSettings,
  restoreTernPluginSettings,
} from "../../../src/terminal-backend/tern/plugin-settings.ts";

test("Tandem shortcuts override presets while preserving custom chord aliases and sequences", () => {
  const plan = planTernPluginKeys(
    JSON.stringify({
      opacity: 42,
      keybinds: { "super+shift+B": "my-board", "cmd+1>x": "custom-sequence" },
    }),
  );
  const settings = JSON.parse(plan.text);
  expect(settings.opacity).toBe(42);
  expect(settings.keybinds["super+shift+B"]).toBe("my-board");
  expect(settings.keybinds["cmd+shift+b"]).toBeUndefined();
  expect(settings.keybinds["cmd+1"]).toBeUndefined();
  expect(settings.keybinds["cmd+shift+p"]).toBe("plugin.tandem.prs");
  expect(plan.skipped).toEqual(["cmd+shift+b", "cmd+1", "cmd+digit_1"]);
  expect(planTernPluginKeys(plan.text).changed).toBe(false);
});

test("both Tern character and physical digit shortcuts route to the same project action", () => {
  const settings = JSON.parse(planTernPluginKeys("{}").text);
  expect(settings.keybinds["cmd+1"]).toBe("plugin.tandem.project-1");
  expect(settings.keybinds["cmd+digit_1"]).toBe("plugin.tandem.project-1");
  const upgraded = JSON.parse(
    planTernPluginKeys('{"keybinds":{"cmd+1":"plugin.tandem.project-1"}}').text,
  );
  expect(upgraded.keybinds["cmd+digit_1"]).toBe("plugin.tandem.project-1");
});

test("declining keys leaves settings byte-identical and a concurrent edit is refused", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-");
  const path = join(root, "settings.json");
  try {
    await writeFile(path, '{"opacity":42}\n');
    expect(
      (await configureTernPluginSettings({ path, confirm: async () => false })).configured,
    ).toBe(false);
    expect(await readFile(path, "utf8")).toBe('{"opacity":42}\n');
    await rm(`${path}.tandem.json`);
    await expect(
      configureTernPluginSettings({
        path,
        confirm: async () => {
          await writeFile(path, '{"opacity":60}\n');
          return true;
        },
      }),
    ).rejects.toThrow("changed while configuring");
    expect(await readFile(path, "utf8")).toBe('{"opacity":60}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one global consent records exact changes and restoration preserves later customizations", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-restore-");
  const path = join(root, "settings.json");
  const questions: string[] = [];
  try {
    await writeFile(
      path,
      JSON.stringify({
        opacity: 42,
        tabs_autohide: false,
        keybinds: { "super+shift+B": "my-board" },
      }),
    );
    const configured = await configureTernPluginSettings({
      path,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    });
    expect(configured.skipped).toEqual(["cmd+shift+b"]);
    expect(describeTernPluginKeys(configured.skipped)).toBe("Command+Shift+B");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("sidebar");
    expect(questions[0]).toContain("shortcuts");
    const installed = JSON.parse(await readFile(path, "utf8"));
    expect(installed.tabs_autohide).toBe(true);
    const receipt = JSON.parse(await readFile(`${path}.tandem.json`, "utf8"));
    expect(receipt.sidebar).toEqual({ previous: false, installed: true });
    expect(receipt.keys.some((entry: { key: string }) => entry.key === "cmd+shift+b")).toBe(false);
    // A later preferences edit belongs to the user, even if the remaining mappings are Tandem's.
    installed.keybinds["cmd+shift+p"] = "my-prs";
    installed.tabs_autohide = false;
    installed.opacity = 60;
    await writeFile(path, JSON.stringify(installed));
    const restored = await restoreTernPluginSettings({ path });
    expect(restored.preserved).toEqual(["cmd+shift+p", "sidebar"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      opacity: 60,
      tabs_autohide: false,
      keybinds: { "super+shift+B": "my-board", "cmd+shift+p": "my-prs" },
    });
    expect(await Bun.file(`${path}.tandem.json`).exists()).toBe(false);
    expect(await restoreTernPluginSettings({ path })).toEqual({ restored: [], preserved: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restoring an inherited sidebar default removes only Tandem's additions", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-default-");
  const path = join(root, "settings.json");
  try {
    await writeFile(path, '{"opacity":42}');
    await configureTernPluginSettings({ path, approved: true });
    await restoreTernPluginSettings({ path });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ opacity: 42 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declining global preferences is remembered without changing preferences or asking again", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-decline-");
  const path = join(root, "settings.json");
  let prompts = 0;
  try {
    await writeFile(path, '{"opacity":42}\n');
    const input = {
      path,
      confirm: async () => {
        prompts++;
        return false;
      },
    };
    expect((await configureTernPluginSettings(input)).configured).toBe(false);
    expect((await configureTernPluginSettings(input)).configured).toBe(false);
    expect(prompts).toBe(1);
    expect(await readFile(path, "utf8")).toBe('{"opacity":42}\n');
    const record = JSON.parse(await readFile(`${path}.tandem.json`, "utf8"));
    expect(record.keys).toEqual([]);
    expect(record.sidebar).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an alternate keymap and explicit custom bindings are never overridden", () => {
  const alternate = planTernPluginKeys('{"keymap":"tmux"}');
  expect(alternate.changed).toBe(false);
  expect(alternate.added).toEqual([]);
  const explicit = planTernPluginKeys('{"keybinds":{"cmd+shift+p":"palette"}}');
  expect(explicit.skipped).toEqual(["cmd+shift+p"]);
  expect(JSON.parse(explicit.text).keybinds["cmd+shift+p"]).toBe("palette");
  expect(describeTernPluginKeys(["cmd+1", "cmd+digit_1"])).toBe("Command+1");
  const mixedAliases = planTernPluginKeys(
    '{"keybinds":{"cmd+1":"plugin.tandem.project-1","cmd+digit_1":"my-custom-project"}}',
  );
  expect(mixedAliases.skipped).toEqual(["cmd+1", "cmd+digit_1"]);
  expect(JSON.parse(mixedAliases.text).keybinds["cmd+digit_1"]).toBe("my-custom-project");
});
