import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyPreferences,
  configureTernPluginSettings,
  describeTernPluginKeys,
  PreferenceWriteNotCommittedError,
  planPreferences,
  planTernPluginKeys,
  restoreTernPluginSettings,
} from "../../../src/terminal-backend/tern/preferences.ts";

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

test("first link records exact changes and restoration preserves later customizations", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-restore-");
  const path = join(root, "settings.json");
  let ids = 0;
  const input = { path, newId: () => `preference-${++ids}` };
  try {
    await writeFile(
      path,
      JSON.stringify({
        opacity: 42,
        tabs_autohide: false,
        keybinds: { "super+shift+B": "my-board" },
      }),
    );
    const configured = await configureTernPluginSettings(input);
    expect(ids).toBe(2);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.tandem.json`)).mode & 0o777).toBe(0o600);
    expect(configured.applied).toEqual({ sidebar: true, keys: true });
    expect(configured.skipped).toEqual(["cmd+shift+b"]);
    expect(describeTernPluginKeys(configured.skipped)).toBe("Command+Shift+B");
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
    const restored = await restoreTernPluginSettings(input);
    expect(ids).toBe(3);
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
    await configureTernPluginSettings({ path });
    await restoreTernPluginSettings({ path });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ opacity: 42 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an alternate keymap and explicit custom bindings are never overridden", () => {
  const alternate = planTernPluginKeys('{"keymap":"tmux"}');
  expect(alternate.changed).toBe(false);
  expect(alternate.added).toEqual([]);
  expect(alternate.skipped).toEqual([]);
  expect(alternate.preset).toBe("tmux");
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

test("a settings-write failure removes its record so the next attempt really applies", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-failure-");
  const path = join(root, "settings.json");
  const original = '{"tabs_autohide":false}';
  try {
    await writeFile(path, original);
    await expect(
      configureTernPluginSettings(
        { path },
        {
          replaceFile: async (destination, _before, text) => {
            if (destination === path)
              throw new PreferenceWriteNotCommittedError("settings disk write failed");
            await writeFile(destination, text, { flag: "wx", mode: 0o600 });
          },
        },
      ),
    ).rejects.toThrow("settings disk write failed");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await Bun.file(`${path}.tandem.json`).exists()).toBe(false);
    expect((await configureTernPluginSettings({ path })).configured).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).keybinds["cmd+shift+b"]).toBe(
      "plugin.tandem.board",
    );
    expect(JSON.parse(await readFile(path, "utf8")).tabs_autohide).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a committed write with a later failure retains the exact record for restoration", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-uncertain-");
  const path = join(root, "settings.json");
  try {
    await writeFile(path, '{"tabs_autohide":false}');
    await expect(
      configureTernPluginSettings(
        { path },
        {
          replaceFile: async (destination, _before, text) => {
            await writeFile(destination, text, { mode: 0o600 });
            if (destination === path) throw new Error("post-commit cleanup failed");
          },
        },
      ),
    ).rejects.toThrow("post-commit cleanup failed");
    expect(await Bun.file(`${path}.tandem.json`).exists()).toBe(true);
    await restoreTernPluginSettings({ path });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ tabs_autohide: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted pre-settings write never reports the saved record as applied", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-interrupted-");
  const path = join(root, "settings.json");
  try {
    await writeFile(path, '{"tabs_autohide":false}');
    await configureTernPluginSettings({ path });
    // The receipt is durable but its settings were never committed, as after abrupt termination.
    await writeFile(path, '{"tabs_autohide":false}');
    expect((await configureTernPluginSettings({ path })).configured).toBe(false);
    expect(await readFile(path, "utf8")).toBe('{"tabs_autohide":false}');
    await restoreTernPluginSettings({ path });
    expect((await configureTernPluginSettings({ path })).configured).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-commit formatting and unrelated edits keep restoration ownership after failure", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-edited-commit-");
  const path = join(root, "settings.json");
  try {
    await writeFile(path, '{"tabs_autohide":false,"opacity":42}');
    await expect(
      configureTernPluginSettings(
        { path },
        {
          replaceFile: async (destination, _before, text) => {
            await writeFile(destination, text, { mode: 0o600 });
            if (destination === path) {
              const committed = JSON.parse(await readFile(path, "utf8"));
              await writeFile(path, JSON.stringify({ ...committed, opacity: 60 }));
              throw new Error("post-commit cleanup failed after edit");
            }
          },
        },
      ),
    ).rejects.toThrow("post-commit cleanup failed after edit");
    expect(await Bun.file(`${path}.tandem.json`).exists()).toBe(true);
    const restored = await restoreTernPluginSettings({ path });
    expect(restored.restored).toContain("cmd+shift+b");
    expect(restored.restored).toContain("sidebar");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ tabs_autohide: false, opacity: 60 });
    expect(await Bun.file(`${path}.tandem.json`).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unclassified write failure preserves its receipt without claiming configuration", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-unknown-write-");
  const path = join(root, "settings.json");
  try {
    await writeFile(path, '{"tabs_autohide":false}');
    await expect(
      configureTernPluginSettings(
        { path },
        {
          replaceFile: async (destination, _before, text) => {
            if (destination === path) throw new Error("write outcome unknown");
            await writeFile(destination, text, { flag: "wx", mode: 0o600 });
          },
        },
      ),
    ).rejects.toThrow("write outcome unknown");
    expect(await Bun.file(`${path}.tandem.json`).exists()).toBe(true);
    expect((await configureTernPluginSettings({ path })).configured).toBe(false);
    await restoreTernPluginSettings({ path });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ tabs_autohide: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preference plans preserve exact settings and record bytes for an alternate preset", () => {
  const input = '{"opacity":42,"keymap":"tmux","tabs_autohide":false}';
  expect(planPreferences(input, undefined)).toEqual({
    status: "apply",
    record:
      '{\n  "version": 1,\n  "keybindsExisted": false,\n  "keys": [],\n  "sidebar": {\n    "previous": false,\n    "installed": true\n  }\n}\n',
    settings: '{\n  "tabs_autohide": true,\n  "keymap": "tmux",\n  "opacity": 42\n}\n',
    applied: { sidebar: true, keys: false },
    preset: "tmux",
    skipped: [],
  });
});

test("an existing preference record never reapplies settings the user removed", () => {
  const record =
    '{"version":1,"keybindsExisted":false,"keys":[{"key":"cmd+shift+b","installed":"plugin.tandem.board"}],"sidebar":{"installed":true}}';
  expect(
    planPreferences('{"tabs_autohide":false,"keybinds":{"super+shift+B":"my-board"}}', record),
  ).toEqual({
    status: "configured",
    configured: false,
    skipped: ["cmd+shift+b"],
  });
  expect(
    planPreferences(
      '{"tabs_autohide":true,"keybinds":{"cmd+shift+b":"plugin.tandem.board"}}',
      record,
    ),
  ).toEqual({
    status: "configured",
    configured: true,
    skipped: [],
  });
});

test("fully configured preferences need no new record and malformed records fail closed", () => {
  expect(planPreferences('{"tabs_autohide":true,"keymap":"tmux"}', undefined)).toEqual({
    status: "configured",
    configured: true,
    skipped: [],
  });
  expect(() => planPreferences("{}", "{}")).toThrow();
});

test("preference application saves its record before changing settings", async () => {
  const plan = planPreferences('{"keymap":"tmux"}', undefined);
  if (plan.status !== "apply") throw new Error("expected an apply plan");
  const writes: string[] = [];
  await applyPreferences(plan, {
    saveRecord: async (text) => void writes.push(`record:${text}`),
    saveSettings: async (text) => void writes.push(`settings:${text}`),
    discardRecord: async (text) => void writes.push(`discard:${text}`),
  });
  expect(writes).toEqual([`record:${plan.record}`, `settings:${plan.settings}`]);
});
