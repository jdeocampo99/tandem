import { expect, test } from "bun:test";
import {
  type ClaudeCodeProbe,
  claudeCodeAvailability,
  modsOffReason,
  probeClaudeCode,
  type SettingsFile,
} from "../../../src/harness/claude-code/availability.ts";

const managed = (text: string): SettingsFile => ({ source: "managed", text });
const project = (text: string): SettingsFile => ({ source: "project", text });
const local = (text: string): SettingsFile => ({ source: "local", text });

test("Claude Code is ready when it runs and no settings file a launch reads switches mods off", () => {
  expect(claudeCodeAvailability(0, [])).toBe("ready");
  expect(claudeCodeAvailability(0, [{ source: "managed", text: undefined }])).toBe("ready");
  expect(claudeCodeAvailability(0, [managed('{"disableAllHooks":false}')])).toBe("ready");
  expect(claudeCodeAvailability(0, [managed("not json"), project("[]")])).toBe("ready");
  expect(claudeCodeAvailability(127, [])).toBe("not-installed");
  expect(claudeCodeAvailability(undefined, [managed('{"disableAllHooks":true}')])).toBe(
    "not-installed",
  );
});

test("disableAllHooks switches mods off from managed, project, or local settings", () => {
  const on = '{"disableAllHooks":true}';
  expect(claudeCodeAvailability(0, [managed(on)])).toEqual({
    setting: "disableAllHooks",
    source: "managed",
  });
  expect(claudeCodeAvailability(0, [managed("{}"), project(on)])).toEqual({
    setting: "disableAllHooks",
    source: "project",
  });
  expect(claudeCodeAvailability(0, [managed("{}"), project("{}"), local(on)])).toEqual({
    setting: "disableAllHooks",
    source: "local",
  });
});

test("the managed-only settings count only in managed settings", () => {
  const modsOnly = JSON.stringify({
    pluginConfigs: { "cc-plugin-sec-default@builtin": { options: { allowManagedModsOnly: true } } },
  });
  for (const [setting, text] of [
    ["allowManagedHooksOnly", '{"allowManagedHooksOnly":true}'],
    ["allowManagedModsOnly", modsOnly],
    ["disableSideloadFlags", '{"disableSideloadFlags":true}'],
  ] as const) {
    expect(claudeCodeAvailability(0, [managed(text)])).toEqual({ setting, source: "managed" });
    expect(claudeCodeAvailability(0, [project(text), local(text)])).toBe("ready");
  }
  expect(claudeCodeAvailability(0, [managed('{"allowManagedModsOnly":true}')])).toBe("ready");
});

test("the reason names the setting and the file that sets it", () => {
  expect(modsOffReason({ setting: "disableAllHooks", source: "local" })).toBe(
    "The disableAllHooks setting in this project's .claude/settings.local.json switches off mods, so Tandem can't run in Claude Code.",
  );
  expect(modsOffReason({ setting: "disableSideloadFlags", source: "managed" })).toBe(
    "The disableSideloadFlags setting in Claude Code's managed settings blocks the --plugin-dir flag Tandem loads its plugin with, so Tandem can't run in Claude Code.",
  );
});

test("the probe reads managed settings, their drop-ins, and the project's files, never user settings", async () => {
  const files: Readonly<Record<string, string>> = {
    "/Library/Application Support/ClaudeCode/managed-settings.d/10-team.json":
      '{"disableSideloadFlags":true}',
    "/Users/me/.claude/settings.json": '{"disableAllHooks":true}',
  };
  const read: string[] = [];
  const probe: ClaudeCodeProbe = {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    cwd: "/repo",
    readText: async (path) => {
      read.push(path);
      return files[path];
    },
    listDirectory: async () => ["10-team.json", "README.md"],
  };
  expect(await probeClaudeCode(probe)).toEqual({
    setting: "disableSideloadFlags",
    source: "managed",
  });
  expect(read).toEqual([
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/Library/Application Support/ClaudeCode/managed-settings.d/10-team.json",
    "/repo/.claude/settings.json",
    "/repo/.claude/settings.local.json",
  ]);
});
