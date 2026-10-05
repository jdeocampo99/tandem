import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
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
