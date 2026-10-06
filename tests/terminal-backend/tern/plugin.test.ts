import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readHomeSettings, saveTerminalChoice } from "../../../src/config/home-settings.ts";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
import { createTandemService } from "../../../src/service/controller.ts";
import {
  installTerminalPlugin,
  reloadTerminalPlugin,
} from "../../../src/terminal-backend/compose.ts";
import { TERN_BINARY } from "../../../src/terminal-backend/tern/cli.ts";
import {
  configureTernPluginSettings,
  ensureTernPlugin,
  reloadTernPlugin,
} from "../../../src/terminal-backend/tern/plugin.ts";

const scratch = await mkdtemp("/tmp/tandem-plugin-scratch-");
afterAll(() => rm(scratch, { recursive: true, force: true }));
// Keeps the setup lock and settings out of the user's real Tern config directory.
const settingsPath = join(scratch, "settings.json");

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
  plugins: [{ id: "tandem", status: "ready", host: true, window: true }],
  problems: [],
});

test("onboarding links palette actions even when global preferences are declined", async () => {
  const declined = runner([missing, ready]);
  const approved = runner([missing, ready]);
  const root = await mkdtemp("/tmp/tandem-plugin-");
  try {
    expect(
      await ensureTernPlugin({
        ...declined,
        cwd: root,
        settingsPath: join(root, "declined.json"),
        confirm: async () => false,
      }),
    ).toBe(true);
    expect(declined.calls.map((call) => call.argv[2])).toEqual(["list", "link", "list"]);
    expect(await Bun.file(join(root, "declined.json")).exists()).toBe(false);
    expect(
      await ensureTernPlugin({
        ...approved,
        binary: TERN_BINARY,
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

test("first-time setup links and configures Tern before its config directory exists", async () => {
  const root = await mkdtemp("/tmp/tandem-plugin-fresh-");
  const config = join(root, "Tern");
  const fresh = runner([missing, ready]);
  try {
    expect(
      await ensureTernPlugin({
        ...fresh,
        cwd: root,
        env: { TERN_CONFIG_DIR: config },
        confirm: async () => true,
      }),
    ).toBe(true);
    expect(fresh.calls.map((call) => call.argv[2])).toEqual(["list", "link", "list"]);
    const applied = JSON.parse(await readFile(join(config, "settings.json"), "utf8"));
    expect(applied.tabs_autohide).toBe(true);
    expect(applied.keybinds["cmd+shift+b"]).toBe("plugin.tandem.board");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const selection of ["injected-path", "explicit-binary", "app-fallback"] as const) {
  test(`plugin list, link and reload resolve the executable with ${selection}`, async () => {
    const root = await mkdtemp("/tmp/tandem-plugin-binary-");
    const executable = join(root, "tern");
    const selected = runner([missing, ready, ready, ready]);
    try {
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const env = { PATH: selection === "app-fallback" ? "" : root };
      const deps = {
        ...selected,
        cwd: root,
        env,
        ...(selection === "explicit-binary" ? { binary: "/explicit/tern" } : {}),
        settingsPath: join(root, "settings.json"),
        confirm: async () => false,
      };
      expect(await ensureTernPlugin(deps)).toBe(true);
      expect(await reloadTernPlugin(deps)).toBe(true);
      const expected =
        selection === "explicit-binary"
          ? "/explicit/tern"
          : selection === "app-fallback"
            ? TERN_BINARY
            : executable;
      expect(selected.calls.map((call) => call.argv.slice(0, 3))).toEqual([
        [expected, "plugin", "list"],
        [expected, "plugin", "link"],
        [expected, "plugin", "list"],
        [expected, "plugin", "list"],
        [expected, "plugin", "reload"],
        [expected, "plugin", "list"],
      ]);
      expect(selected.calls.every((call) => call.env === env)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("update reloads an existing integration and refuses a broken reload", async () => {
  const installed = runner([ready, ready]);
  expect(await reloadTernPlugin({ ...installed, cwd: "/tmp", settingsPath })).toBe(true);
  expect(installed.calls[1]?.argv).toContain("reload");
  const absent = runner([missing]);
  expect(await reloadTernPlugin({ ...absent, cwd: "/tmp", settingsPath })).toBe(false);
  expect(absent.calls).toHaveLength(1);
  const broken = runner([ready, missing]);
  await expect(reloadTernPlugin({ ...broken, cwd: "/tmp", settingsPath })).rejects.toThrow(
    "failed to reload",
  );
});

test("malformed catalog fails closed before installation", async () => {
  const invalid = runner(["not JSON"]);
  await expect(
    ensureTernPlugin({ ...invalid, cwd: "/tmp", settingsPath, confirm: async () => true }),
  ).rejects.toThrow("invalid plugin catalog");
  expect(invalid.calls).toHaveLength(1);
});

test("window bindings alone do not count as a ready native view integration", async () => {
  const incomplete = runner([
    JSON.stringify({
      plugins: [{ id: "tandem", status: "ready", host: false, window: true }],
      problems: [],
    }),
  ]);
  expect(await ensureTernPlugin({ ...incomplete, cwd: "/tmp", settingsPath })).toBe(false);
  expect(incomplete.calls).toHaveLength(1);
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
    expect(await installTerminalPlugin(home, deps, { status: "ready" })).toBe(true);
    expect(await reloadTerminalPlugin(home, deps)).toBe(false);
    expect(selected.calls).toHaveLength(0);
    await saveTerminalChoice(home, "tern");
    expect(await installTerminalPlugin(home, deps, { status: "ready" })).toBe(true);
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
    expect(await installTerminalPlugin(home, deps)).toBe(true);
    expect(await reloadTerminalPlugin(home, deps)).toBe(false);
    expect(selected.calls).toHaveLength(6);
    expect(JSON.parse(await readFile(deps.settingsPath, "utf8"))).toEqual({});
    expect(await Bun.file(`${deps.settingsPath}.tandem.json`).exists()).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("chat and setup terminal selection awaits plugin preferences after saving either choice", async () => {
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
      const selected = (await readHomeSettings(home)).terminal;
      observed.push(selected);
      return selected === "herdr";
    },
  });
  try {
    await service.configureTerminal("herdr");
    expect(observed).toEqual(["herdr"]);
    const selected = await service.configureTerminal("tern");
    expect(observed).toEqual(["herdr", "tern"]);
    expect(selected.terminal).toBe("tern");
    expect(selected.reason).toContain("left unchanged");
  } finally {
    await service.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

for (const readiness of [
  { status: "missing" },
  { status: "signedOut" },
  { status: "unknown", reason: "Tern could not start." },
] as const) {
  test(`${readiness.status} readiness refuses plugin linking before commands or consent`, async () => {
    const home = await mkdtemp("/tmp/tandem-plugin-not-ready-");
    const selected = runner([missing, ready]);
    let consent = 0;
    try {
      await saveTerminalChoice(home, "tern");
      expect(
        await installTerminalPlugin(
          home,
          {
            ...selected,
            cwd: home,
            settingsPath: join(home, "tern-settings.json"),
            confirm: async () => {
              consent += 1;
              return true;
            },
          },
          readiness,
        ),
      ).toBe(false);
      expect(selected.calls).toHaveLength(0);
      expect(consent).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("missing Tern skips the onboarding plugin hook and saves Herdr", async () => {
  const home = await mkdtemp("/tmp/tandem-plugin-fallback-");
  let linked = false;
  const service = createTandemService({
    home,
    sessionId: "test",
    run: async () => ({ code: 127, stdout: "", stderr: "missing" }),
    installTerminalPlugin: async () => {
      linked = true;
      return true;
    },
  });
  try {
    expect((await service.configureTerminal("tern")).terminal).toBe("herdr");
    expect(linked).toBe(false);
  } finally {
    await service.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("invalid Tern preferences never block Herdr launch or update and warn only once", async () => {
  const home = await mkdtemp("/tmp/tandem-plugin-invalid-restore-");
  const path = join(home, "settings.json");
  const selected = runner([]);
  const notices: string[] = [];
  try {
    await configureTernPluginSettings({ path, approved: true });
    await writeFile(path, '{"tabs_autohide":"yes"}');
    await saveTerminalChoice(home, "herdr");
    const deps = {
      ...selected,
      cwd: home,
      settingsPath: path,
      print: (text: string) => notices.push(text),
    };
    expect(await installTerminalPlugin(home, deps)).toBe(true);
    expect(await reloadTerminalPlugin(home, deps)).toBe(false);
    expect(await installTerminalPlugin(home, deps)).toBe(true);
    expect(selected.calls).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Herdr will still open");
    expect(await readFile(path, "utf8")).toBe('{"tabs_autohide":"yes"}');
    expect(await Bun.file(`${path}.tandem.json`).exists()).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("declined global preferences print once and explain how to change the decision later", async () => {
  const home = await mkdtemp("/tmp/tandem-plugin-notices-");
  const path = join(home, "settings.json");
  const selected = runner([ready, ready]);
  const notices: string[] = [];
  let prompts = 0;
  try {
    await writeFile(path, '{"keybinds":{"cmd+shift+b":"palette"}}');
    const deps = {
      ...selected,
      cwd: home,
      settingsPath: path,
      print: (text: string) => notices.push(text),
      confirm: async () => {
        prompts++;
        return false;
      },
    };
    expect(await ensureTernPlugin(deps)).toBe(true);
    expect(await ensureTernPlugin(deps)).toBe(true);
    expect(prompts).toBe(1);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("custom Tern shortcuts: Command+Shift+B");
    expect(notices[1]).toContain("switch to Herdr and select Tern again");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("two projects starting together link Tern once and ask the consent question once", async () => {
  const root = await mkdtemp("/tmp/tandem-plugin-concurrent-");
  const settings = join(root, "settings.json");
  let linked = false;
  let links = 0;
  let prompts = 0;
  const run: CommandRunner = async (request) => {
    // A caller waiting on the real file lock polls silently, so there is no event to await. Real
    // delays keep each Tern command and the consent answer slow enough that callers overlap.
    await Bun.sleep(10);
    if (request.argv.includes("link")) {
      links += 1;
      linked = true;
    }
    return {
      code: 0,
      stdout: request.argv.includes("list") ? (linked ? ready : missing) : "{}",
      stderr: "",
    };
  };
  const project = async (name: string) => {
    const home = join(root, name);
    await mkdir(home);
    await saveTerminalChoice(home, "tern");
    return installTerminalPlugin(
      home,
      {
        run,
        cwd: home,
        settingsPath: settings,
        confirm: async () => {
          prompts += 1;
          await Bun.sleep(50);
          return true;
        },
      },
      { status: "ready" },
    );
  };
  try {
    await writeFile(settings, "{}");
    expect(await Promise.all([project("first"), project("second")])).toEqual([true, true]);
    expect(links).toBe(1);
    expect(prompts).toBe(1);
    const applied = JSON.parse(await readFile(settings, "utf8"));
    expect(applied.tabs_autohide).toBe(true);
    expect(applied.keybinds["cmd+shift+b"]).toBe("plugin.tandem.board");
    expect(JSON.parse(await readFile(`${settings}.tandem.json`, "utf8")).approved).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
