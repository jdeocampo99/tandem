import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  configureTernPluginKeys,
  planTernPluginKeys,
} from "../../../src/terminal-backend/tern/plugin-keys.ts";

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
  expect(settings.keybinds["cmd+1"]).toBe("plugin.tandem.bind.0");
  expect(settings.keybinds["cmd+digit_1"]).toBe("plugin.tandem.bind.0");
  const upgraded = JSON.parse(
    planTernPluginKeys('{"keybinds":{"cmd+1":"plugin.tandem.bind.0"}}').text,
  );
  expect(upgraded.keybinds["cmd+digit_1"]).toBe("plugin.tandem.bind.0");
});

test("declining keys leaves settings byte-identical and a concurrent edit is refused", async () => {
  const root = await mkdtemp("/tmp/tandem-keys-");
  const path = join(root, "settings.json");
  try {
    await writeFile(path, '{"opacity":42}\n');
    expect((await configureTernPluginKeys({ path, confirm: async () => false })).configured).toBe(
      false,
    );
    expect(await readFile(path, "utf8")).toBe('{"opacity":42}\n');
    await expect(
      configureTernPluginKeys({
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
