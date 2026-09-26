import { expect, test } from "bun:test";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import {
  type HerdrSetupDependencies,
  herdrConfigPath,
  herdrStatusCommands,
  herdrUpdateCommand,
  parseHerdrVersion,
  parseServerStatus,
  planHerdrConfig,
  setUpHerdrStatus,
  versionAtLeast,
} from "../../src/terminal/herdr-setup.ts";

const COMMANDS = herdrStatusCommands("/Users/me/.bun/bin/bun", "/Users/me/tandem/src/main.ts");

type TabBarEntry = {
  type: string;
  command: string;
  interval_seconds: number;
  timeout_seconds: number;
};
type KeyCommand = {
  key: string;
  type: string;
  command: string;
  description?: string;
  width?: string;
  height?: string;
};
type HerdrConfig = {
  ui?: { tab_bar_right?: TabBarEntry[]; sidebar_width?: number; toast?: { delivery?: string } };
  keys?: { command?: KeyCommand[] };
};

function parsed(text: string): HerdrConfig {
  return Bun.TOML.parse(text) as HerdrConfig;
}

test("reads Herdr's version and compares it number by number", () => {
  expect(parseHerdrVersion("herdr 0.9.1\n")).toBe("0.9.1");
  expect(parseHerdrVersion("command not found")).toBeUndefined();
  expect(versionAtLeast("0.9.1", "0.8.2")).toBe(true);
  expect(versionAtLeast("0.8.2", "0.8.2")).toBe(true);
  expect(versionAtLeast("0.8.10", "0.8.2")).toBe(true);
  expect(versionAtLeast("0.7.5", "0.8.2")).toBe(false);
  expect(versionAtLeast("1.0.0", "0.8.2")).toBe(true);
});

test("the status commands use absolute paths, because Herdr's login shell may not find bun", () => {
  expect(COMMANDS).toEqual({
    line: "'/Users/me/.bun/bin/bun' '/Users/me/tandem/src/main.ts' status --line",
    popup: "'/Users/me/.bun/bin/bun' '/Users/me/tandem/src/main.ts' status --watch",
  });
  expect(herdrConfigPath({ HOME: "/Users/me" })).toBe("/Users/me/.config/herdr/config.toml");
  expect(herdrConfigPath({ HOME: "/Users/me", XDG_CONFIG_HOME: "/cfg" })).toBe(
    "/cfg/herdr/config.toml",
  );
});

test("an empty config gets the tab-bar entry and the prefix+t popup, as valid TOML", () => {
  const plan = planHerdrConfig("", COMMANDS);
  const config = parsed(plan.text);
  expect(config.ui?.tab_bar_right).toEqual([
    { type: "command", command: COMMANDS.line, interval_seconds: 5, timeout_seconds: 10 },
  ] satisfies TabBarEntry[]);
  expect(config.ui?.toast?.delivery).toBe("herdr");
  expect(config.keys?.command).toEqual([
    {
      key: "prefix+t",
      type: "popup",
      command: COMMANDS.popup,
      description: "Tandem status",
      width: "90%",
      height: "90%",
    },
  ] satisfies KeyCommand[]);
  expect(plan.skipped).toEqual([]);
  // Running it again adds nothing.
  const again = planHerdrConfig(plan.text, COMMANDS);
  expect(again.text).toBe(plan.text);
  expect(again.added).toEqual([]);
});

test("an existing [ui] table gets the entry inside it, and the user's settings stay", () => {
  const text = [
    "[ui]",
    "sidebar_width = 30",
    "",
    "[[keys.command]]",
    'key = "prefix+alt+g"',
    'type = "popup"',
    'command = "lazygit"',
    "",
  ].join("\n");
  const plan = planHerdrConfig(text, COMMANDS);
  const config = parsed(plan.text);
  expect(config.ui?.sidebar_width).toBe(30);
  expect(config.ui?.tab_bar_right?.[0]?.command).toBe(COMMANDS.line);
  expect(config.keys?.command?.map((binding) => binding.key)).toEqual(["prefix+alt+g", "prefix+t"]);
  expect(plan.text.startsWith(text.split("\n")[0] ?? "")).toBe(true);
});

test("an existing tab_bar_right or prefix+t binding is left alone, with the line to add by hand", () => {
  const text = [
    "[ui]",
    'tab_bar_right = [{ type = "hostname" }]',
    "",
    "[ui.toast]",
    'delivery = "off"',
    "",
    "[[keys.command]]",
    'key = "prefix+t"',
    'type = "popup"',
    'command = "exec $SHELL"',
    "",
  ].join("\n");
  const plan = planHerdrConfig(text, COMMANDS);
  expect(plan.text).toBe(text);
  expect(plan.added).toEqual([]);
  // The user's toast choice needs nothing; the other two are theirs to add by hand.
  expect(plan.skipped).toEqual([
    expect.stringContaining(`Add to your ui.tab_bar_right: { type = "command"`),
    `prefix+t is taken; bind another key to: ${COMMANDS.popup}`,
  ]);
});

const RUNNING = (version: string) => `status: running\nversion: ${version}\nsocket: /s\n`;

function setup(
  overrides: Partial<HerdrSetupDependencies> & {
    readonly versions?: string[];
    readonly checks?: number[];
    readonly config?: string;
    readonly server?: string;
  } = {},
) {
  const versions = [...(overrides.versions ?? ["herdr 0.9.1"])];
  const checks = [...(overrides.checks ?? [0, 0])];
  const ran: string[] = [];
  const printed: string[] = [];
  const writes: string[] = [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    const command = request.argv.join(" ");
    ran.push(command);
    if (command === "herdr --version") {
      return { code: 0, stdout: versions.shift() ?? "", stderr: "" };
    }
    if (command === "herdr config check") {
      return { code: checks.shift() ?? 0, stdout: "", stderr: "" };
    }
    if (command === "herdr --session tandem status server") {
      return { code: 0, stdout: overrides.server ?? RUNNING("0.9.1"), stderr: "" };
    }
    if (command === "brew upgrade herdr") {
      return { code: 0, stdout: "==> Upgrading herdr 0.8.0 -> 0.9.1", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps: HerdrSetupDependencies = {
    run,
    environment: { HOME: "/Users/me" },
    commands: COMMANDS,
    sessionId: "tandem",
    herdrBinary: "/Users/me/.local/bin/herdr",
    runningTasks: async () => 0,
    confirm: async () => true,
    print: (text) => printed.push(text),
    readConfig: async () => overrides.config,
    writeConfig: async (_path, text) => {
      writes.push(text);
    },
    backupConfig: async (path) => `${path}.before-tandem`,
    ...overrides,
  };
  return { deps, ran, printed, writes };
}

test("Herdr is updated the way it was installed, and a running server's version is read", () => {
  expect(herdrUpdateCommand("/opt/homebrew/Cellar/herdr/0.8.0/bin/herdr")).toEqual([
    "brew",
    "upgrade",
    "herdr",
  ]);
  expect(herdrUpdateCommand("/Users/me/.local/bin/herdr")).toEqual(["herdr", "update"]);
  expect(
    herdrUpdateCommand("/Users/me/.local/share/mise/installs/herdr/bin/herdr"),
  ).toBeUndefined();
  expect(parseServerStatus(RUNNING("0.8.0"))).toEqual({ running: true, version: "0.8.0" });
  expect(parseServerStatus("status: not running\nsocket: /s\n")).toEqual({ running: false });
});

test("setup updates an old Herdr, asks, writes the config, and reloads Tandem's session", async () => {
  const { deps, ran, printed, writes } = setup({
    versions: ["herdr 0.7.5", "herdr 0.9.1"],
    config: "[ui]\nsidebar_width = 30\n",
  });
  expect(await setUpHerdrStatus(deps)).toBe(true);
  expect(ran).toEqual([
    "herdr --version",
    "herdr update",
    "herdr --version",
    "herdr config check",
    "herdr config check",
    "herdr --session tandem status server",
    "herdr --session tandem server reload-config",
  ]);
  expect(writes).toHaveLength(1);
  expect(parsed(writes[0] ?? "").ui?.sidebar_width).toBe(30);
  expect(printed.join("")).toBe(
    [
      "→ updating Herdr 0.7.5",
      "✓ Herdr 0.9.1",
      "✓ Herdr config updated (backup: config.toml.before-tandem)",
      "✓ Herdr reloaded; prefix+t shows Tandem's status",
      "",
    ].join("\n"),
  );
});

test("a Homebrew Herdr is upgraded with brew, and a failed update shows its output", async () => {
  const { deps, ran, printed } = setup({
    versions: ["herdr 0.8.0", "herdr 0.9.1"],
    herdrBinary: "/opt/homebrew/Cellar/herdr/0.8.0/bin/herdr",
  });
  expect(await setUpHerdrStatus(deps)).toBe(true);
  expect(ran.slice(0, 3)).toEqual(["herdr --version", "brew upgrade herdr", "herdr --version"]);
  expect(printed.join("")).not.toContain("==> Upgrading");

  const failed = setup({
    versions: ["herdr 0.8.0", "herdr 0.8.0"],
    herdrBinary: "/opt/homebrew/Cellar/herdr/0.8.0/bin/herdr",
  });
  expect(await setUpHerdrStatus(failed.deps)).toBe(false);
  expect(failed.printed.join("")).toContain("  ==> Upgrading herdr 0.8.0 -> 0.9.1");
});

test("re-running with the config already there still applies it to Tandem's session", async () => {
  const done = planHerdrConfig("", COMMANDS).text;
  const { deps, ran, writes } = setup({ config: done });
  expect(await setUpHerdrStatus(deps)).toBe(true);
  expect(writes).toEqual([]);
  expect(ran.at(-1)).toBe("herdr --session tandem server reload-config");
});

test("a session still on an old Herdr is restarted only when idle, asked, and not from inside it", async () => {
  const done = planHerdrConfig("", COMMANDS).text;
  const stale = RUNNING("0.8.0");

  const restarted = setup({ config: done, server: stale });
  expect(await setUpHerdrStatus(restarted.deps)).toBe(true);
  expect(restarted.ran.at(-1)).toBe("herdr session stop tandem");
  expect(restarted.printed.join("")).toContain("run tandem to reopen your projects");

  const busy = setup({ config: done, server: stale, runningTasks: async () => 2 });
  expect(await setUpHerdrStatus(busy.deps)).toBe(false);
  expect(busy.ran).not.toContain("herdr session stop tandem");
  expect(busy.printed.join("")).toBe(
    "! Herdr's tandem session still runs 0.8.0 and needs a restart (2 running); when idle, run: herdr session stop tandem && tandem\n",
  );

  const unknown = setup({
    config: done,
    server: stale,
    runningTasks: async () => {
      throw new Error("state locked");
    },
  });
  expect(await setUpHerdrStatus(unknown.deps)).toBe(false);
  expect(unknown.ran).not.toContain("herdr session stop tandem");

  const declined = setup({ config: done, server: stale, confirm: async () => false });
  expect(await setUpHerdrStatus(declined.deps)).toBe(false);
  expect(declined.ran).not.toContain("herdr session stop tandem");

  const inside = setup({
    config: done,
    server: stale,
    environment: { HOME: "/Users/me", HERDR_SESSION: "tandem" },
  });
  expect(await setUpHerdrStatus(inside.deps)).toBe(false);
  expect(inside.ran).not.toContain("herdr session stop tandem");
  expect(inside.printed.join("")).toContain("from outside Herdr");
});

test("a session that isn't running picks the config up when it starts", async () => {
  const { deps, ran } = setup({ server: "status: not running\nsocket: /s\n" });
  expect(await setUpHerdrStatus(deps)).toBe(true);
  expect(ran).not.toContain("herdr --session tandem server reload-config");
});

test("setup changes nothing when the user says no or there is no terminal", async () => {
  const declined = setup({ confirm: async () => false });
  expect(await setUpHerdrStatus(declined.deps)).toBe(false);
  expect(declined.writes).toEqual([]);

  const headless = setup({ confirm: undefined });
  expect(await setUpHerdrStatus(headless.deps)).toBe(false);
  expect(headless.writes).toEqual([]);
  expect(headless.printed.join("")).toContain("no terminal to ask in");
});

test("setup puts the old config back when Herdr rejects the new one", async () => {
  const original = "[ui]\nsidebar_width = 30\n";
  const { deps, writes, ran, printed } = setup({ config: original, checks: [0, 1] });
  expect(await setUpHerdrStatus(deps)).toBe(false);
  expect(writes.at(-1)).toBe(original);
  expect(ran).not.toContain("herdr --session tandem server reload-config");
  expect(printed.join("")).toContain("the old config is back");
});

test("setup stops when Herdr is missing, still too old after updating, or needs its package manager", async () => {
  const missing = setup({ versions: [""] });
  expect(await setUpHerdrStatus(missing.deps)).toBe(false);
  expect(missing.ran).toEqual(["herdr --version"]);

  const old = setup({ versions: ["herdr 0.7.5", "herdr 0.7.5"] });
  expect(await setUpHerdrStatus(old.deps)).toBe(false);
  expect(old.printed.join("")).toContain("needs Herdr 0.8.2+ (you have 0.7.5)");
  expect(old.writes).toEqual([]);

  const mise = setup({
    versions: ["herdr 0.7.5"],
    herdrBinary: "/Users/me/.local/share/mise/installs/herdr/bin/herdr",
  });
  expect(await setUpHerdrStatus(mise.deps)).toBe(false);
  expect(mise.ran).toEqual(["herdr --version"]);
  expect(mise.printed.join("")).toContain("package manager that installed it");
});
