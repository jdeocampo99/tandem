import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readHomeSettings, saveTerminalChoice } from "../../../src/config/home-settings.ts";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
import { createTandemService } from "../../../src/service/controller.ts";
import {
  installTerminalPlugin,
  reloadTerminalPlugin,
} from "../../../src/terminal-backend/compose.ts";
import { ensureTernPlugin, reloadTernPlugin } from "../../../src/terminal-backend/tern/plugin.ts";

function runner(catalogs: readonly string[]) {
  const calls: CommandRequest[] = [];
  let index = 0;
  const run: CommandRunner = async (request) => {
    calls.push(request);
    return {
      code: 0,
      stdout: request.argv.includes("list") ? (catalogs[index++] ?? "") : "{}",
      stderr: "",
    };
  };
  return { run, calls };
}
const missing = JSON.stringify({ plugins: [], problems: [] });
const ready = JSON.stringify({
  plugins: [{ id: "tandem", status: "ready", window: true }],
  problems: [],
});

test("onboarding checks without consent and links only after a yes", async () => {
  const declined = runner([missing]);
  expect(await ensureTernPlugin({ ...declined, cwd: "/tmp", confirm: async () => false })).toBe(
    false,
  );
  expect(declined.calls).toHaveLength(1);
  const approved = runner([missing, ready]);
  const root = await mkdtemp("/tmp/tandem-plugin-");
  try {
    expect(
      await ensureTernPlugin({
        ...approved,
        cwd: "/tmp",
        directory: "/plugin with spaces",
        settingsPath: join(root, "settings.json"),
        confirm: async () => true,
      }),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expect(approved.calls[1]?.argv).toEqual([
    "/Applications/Tern.app/Contents/MacOS/tern",
    "plugin",
    "link",
    "/plugin with spaces",
    "--json",
  ]);
});

test("update reloads an existing integration and refuses a broken reload", async () => {
  const installed = runner([ready, ready]);
  expect(await reloadTernPlugin({ ...installed, cwd: "/tmp" })).toBe(true);
  expect(installed.calls[1]?.argv).toContain("reload");
  const absent = runner([missing]);
  expect(await reloadTernPlugin({ ...absent, cwd: "/tmp" })).toBe(false);
  expect(absent.calls).toHaveLength(1);
  const broken = runner([ready, missing]);
  await expect(reloadTernPlugin({ ...broken, cwd: "/tmp" })).rejects.toThrow("failed to reload");
});

test("malformed catalog fails closed before installation", async () => {
  const invalid = runner(["not JSON"]);
  await expect(
    ensureTernPlugin({ ...invalid, cwd: "/tmp", confirm: async () => true }),
  ).rejects.toThrow("invalid plugin catalog");
  expect(invalid.calls).toHaveLength(1);
});

test("installer and update read the saved choice without contacting unselected terminals", async () => {
  const home = await mkdtemp("/tmp/tandem-plugin-choice-");
  const selected = runner([missing, ready, ready, ready]);
  const deps = {
    ...selected,
    cwd: home,
    settingsPath: join(home, "tern-settings.json"),
    confirm: async () => true,
  };
  try {
    expect(await installTerminalPlugin(home, deps)).toBe(true);
    expect(await reloadTerminalPlugin(home, deps)).toBe(false);
    expect(selected.calls).toHaveLength(0);
    await saveTerminalChoice(home, "tern");
    expect(await installTerminalPlugin(home, deps)).toBe(true);
    expect(await reloadTerminalPlugin(home, deps)).toBe(true);
    expect(selected.calls.map((call) => call.argv[2])).toEqual([
      "list",
      "link",
      "list",
      "list",
      "reload",
      "list",
    ]);
    await saveTerminalChoice(home, "herdr");
    expect(await reloadTerminalPlugin(home, deps)).toBe(false);
    expect(selected.calls).toHaveLength(6);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("chat and setup terminal selection awaits plugin consent after saving the Tern choice", async () => {
  const home = await mkdtemp("/tmp/tandem-plugin-onboarding-");
  const observed: (string | undefined)[] = [];
  const run: CommandRunner = async (request) => ({
    code: 0,
    stdout: request.argv.includes("state") ? JSON.stringify({ gate: { signed_in: true } }) : "{}",
    stderr: "",
  });
  const service = createTandemService({
    home,
    sessionId: "test",
    run,
    installTerminalPlugin: async () => {
      observed.push((await readHomeSettings(home)).terminal);
      return false;
    },
  });
  try {
    await service.configureTerminal("herdr");
    expect(observed).toEqual([]);
    const selected = await service.configureTerminal("tern");
    expect(observed).toEqual(["tern"]);
    expect(selected.terminal).toBe("tern");
    expect(selected.reason).toContain("left unchanged");
  } finally {
    await service.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
