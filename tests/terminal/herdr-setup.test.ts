import { expect, test } from "bun:test";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import {
  type HerdrSetupDependencies,
  herdrConfigPath,
  herdrStatusCommands,
  parseHerdrVersion,
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
  expect(plan.skipped[0]).toContain("You already set ui.tab_bar_right");
  expect(plan.skipped[0]).toContain(COMMANDS.line);
  expect(plan.skipped[1]).toBe(
    "Herdr notifications are already set up; Tandem's use the same setting.",
  );
  expect(plan.skipped[2]).toContain("prefix+t is already bound");
});

function setup(
  overrides: Partial<HerdrSetupDependencies> & {
    readonly versions?: string[];
    readonly checks?: number[];
    readonly config?: string;
  } = {},
) {
  const versions = [...(overrides.versions ?? ["herdr 0.9.1"])];
  const checks = [...(overrides.checks ?? [0, 0])];
  const ran: string[] = [];
  const printed: string[] = [];
  const writes: string[] = [];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    const command = request.argv.slice(1).join(" ");
    ran.push(command);
    if (command === "--version") return { code: 0, stdout: versions.shift() ?? "", stderr: "" };
    if (command === "config check") return { code: checks.shift() ?? 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps: HerdrSetupDependencies = {
    run,
    environment: { HOME: "/Users/me" },
    commands: COMMANDS,
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

test("setup updates an old Herdr, asks, writes the config, and reloads it", async () => {
  const { deps, ran, printed, writes } = setup({
    versions: ["herdr 0.7.5", "herdr 0.9.1"],
    config: "[ui]\nsidebar_width = 30\n",
  });
  expect(await setUpHerdrStatus(deps)).toBe(true);
  expect(ran).toEqual([
    "--version",
    "update",
    "--version",
    "config check",
    "config check",
    "server reload-config",
  ]);
  expect(writes).toHaveLength(1);
  expect(parsed(writes[0] ?? "").ui?.sidebar_width).toBe(30);
  expect(printed.join("")).toContain("backup: /Users/me/.config/herdr/config.toml.before-tandem");
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
  expect(ran).not.toContain("server reload-config");
  expect(printed.join("")).toContain("the old one is back");
});

test("setup stops when Herdr is missing or still too old after updating", async () => {
  const missing = setup({ versions: [""] });
  expect(await setUpHerdrStatus(missing.deps)).toBe(false);
  expect(missing.ran).toEqual(["--version"]);

  const old = setup({ versions: ["herdr 0.7.5", "herdr 0.7.5"] });
  expect(await setUpHerdrStatus(old.deps)).toBe(false);
  expect(old.printed.join("")).toContain("(you have 0.7.5); update with: herdr update");
  expect(old.writes).toEqual([]);
});
