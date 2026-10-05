import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { quoteShellArgument, runCommand } from "../../adapters/commands.ts";
import { readBoard } from "../../board/read.ts";
import { resolveTandemEnvironment } from "../../config/environment.ts";
import type { CommandResult, CommandRunner } from "../../contracts.ts";
import { DEFAULT_TERMINAL_SESSION_ID } from "../../terminal/environment.ts";
import { MIN_HERDR_VERSION, parseHerdrVersion, versionAtLeast } from "./install.ts";
import { TANDEM_HERDR_PLUGIN } from "./ui.ts";

/** The key that opens the Tandem panel in a Herdr popup. */
export const STATUS_POPUP_KEY = "prefix+t";

/**
 * Keys for the panel's plugin actions. `prefix+h`, `prefix+1`-`9`, and `prefix+[` are Herdr's own
 * (focus left, switch tab, copy mode), so projects move with `prefix+,` and `prefix+.`.
 */
const PANEL_KEYS = [
  {
    key: "prefix+0",
    action: `${TANDEM_HERDR_PLUGIN}.home`,
    description: "Tandem: this project's chat",
  },
  {
    key: "prefix+comma",
    action: `${TANDEM_HERDR_PLUGIN}.project-prev`,
    description: "Tandem: previous project",
  },
  {
    key: "prefix+period",
    action: `${TANDEM_HERDR_PLUGIN}.project-next`,
    description: "Tandem: next project",
  },
] as const;

export type HerdrStatusCommands = Readonly<{
  /** Prints the one-line summary for the tab bar. */
  readonly line: string;
  /** Draws the panel until Esc. */
  readonly popup: string;
  /**
   * How the `status --watch` popup an earlier Tandem wrote for this checkout ends; Bun's path
   * before it may have changed since.
   */
  readonly earlierPopupEnd: string;
}>;

export type HerdrConfigPlan = Readonly<{
  /** The config after the additions; the same text when nothing is added. */
  readonly text: string;
  /** The lines that will be added. */
  readonly added: readonly string[];
  /** What will be added, in words, for the question before writing. */
  readonly features: readonly string[];
  /** What the user has to add by hand, because Tandem would have to change their own settings. */
  readonly skipped: readonly string[];
}>;

/**
 * Tandem's status commands with absolute paths: Herdr runs them through `/bin/sh -lc`, whose PATH
 * may not include Bun's bin directory.
 */
export function herdrStatusCommands(bun: string, main: string): HerdrStatusCommands {
  const tandem = `${quoteShellArgument(bun)} ${quoteShellArgument(main)}`;
  return {
    line: `${tandem} status --line`,
    popup: `${tandem} panel --popup`,
    earlierPopupEnd: ` ${quoteShellArgument(main)} status --watch`,
  };
}

/**
 * Where the earlier Tandem popup block sits: a `[[keys.command]]` table on `prefix+t` whose
 * command is exactly a quoted Bun followed by this checkout's `status --watch`. Anything else on
 * the key is the user's.
 */
function earlierPopupBlock(
  text: string,
  commands: HerdrStatusCommands,
): Readonly<{ start: number; end: number }> | undefined {
  const blocks = /^[ \t]*\[\[keys\.command\]\][ \t]*\n((?:(?![ \t]*\[).*(?:\n|$))*)/gmu;
  for (const block of text.matchAll(blocks)) {
    let fields: Record<string, unknown>;
    try {
      fields = Bun.TOML.parse(block[1] ?? "") as Record<string, unknown>;
    } catch {
      continue;
    }
    const command = fields.command;
    if (
      fields.key === STATUS_POPUP_KEY &&
      typeof command === "string" &&
      command.endsWith(commands.earlierPopupEnd) &&
      /^'[^']*'$/u.test(command.slice(0, -commands.earlierPopupEnd.length))
    ) {
      return { start: block.index, end: block.index + block[0].length };
    }
  }
  return undefined;
}

/** Where Herdr reads its config, as Herdr resolves it on macOS and Linux. */
export function herdrConfigPath(environment: Readonly<Record<string, string | undefined>>): string {
  const configHome = environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), ".config");
  return join(configHome, "herdr", "config.toml");
}

/**
 * Adds the tab-bar summary, in-app notifications (off in Herdr by default), the panel popup and
 * keys, and a hidden sidebar to a Herdr config, leaving everything the user wrote untouched.
 * Anything Tandem cannot add without editing the user's own settings, such as an existing
 * `tab_bar_right` list or another binding on one of its keys, is skipped with the line to add by
 * hand. The `status --watch` popup an earlier Tandem wrote becomes the panel popup.
 */
export function planHerdrConfig(text: string, commands: HerdrStatusCommands): HerdrConfigPlan {
  const added: string[] = [];
  const features: string[] = [];
  const skipped: string[] = [];
  let next = text;
  const dottedUi = /^\s*ui\s*[.=]/mu.test(text);
  const addUnderUi = (lines: readonly string[]) => {
    const table = /^[ \t]*\[ui\][ \t]*(#.*)?$/mu.exec(next);
    if (table === null) {
      next = `${withBlankLine(next)}[ui]\n${lines.join("\n")}\n`;
      added.push("[ui]", ...lines);
    } else {
      const end = table.index + table[0].length;
      next = `${next.slice(0, end)}\n${lines.join("\n")}${next.slice(end)}`;
      added.push(...lines);
    }
  };

  const entry = `{ type = "command", command = ${tomlString(commands.line)}, interval_seconds = 5, timeout_seconds = 10 }`;
  if (text.includes("status --line")) {
    // Already there.
  } else if (/^\s*tab_bar_right\s*=/mu.test(text)) {
    skipped.push(`Add to your ui.tab_bar_right: ${entry}`);
  } else if (dottedUi) {
    skipped.push(`Add under ui: tab_bar_right = [${entry}]`);
  } else {
    addUnderUi([`tab_bar_right = [${entry}]`]);
    features.push("tab bar");
  }

  // The panel replaces the sidebar; prefix+b still shows it.
  const sidebar = ["sidebar_start_collapsed = true", 'sidebar_collapsed_mode = "hidden"'];
  if (/^\s*sidebar_(start_collapsed|collapsed_mode)\s*=/mu.test(text)) {
    // The user chose how the sidebar starts.
  } else if (dottedUi) {
    skipped.push(`To hide the sidebar, add under ui: ${sidebar.join(", ")}`);
  } else {
    addUnderUi(sidebar);
    features.push("hidden sidebar");
  }

  // Herdr's toasts are off by default; Tandem's "needs you" notifications use them.
  if (/^\s*delivery\s*=/mu.test(text) && /toast/u.test(text)) {
    // The user chose how notifications arrive, including off.
  } else if (/toast/u.test(text)) {
    skipped.push('For notifications, set delivery = "herdr" under [ui.toast]');
  } else {
    const toast = [
      "# Herdr notifications, used when something new needs you",
      "[ui.toast]",
      'delivery = "herdr"',
    ];
    next = `${withBlankLine(next)}${toast.join("\n")}\n`;
    added.push(...toast);
    features.push("notifications");
  }

  const popupCommand = `command = ${tomlString(commands.popup)}`;
  const binding = [
    "# Tandem's panel; Esc closes it",
    "[[keys.command]]",
    `key = "${STATUS_POPUP_KEY}"`,
    'type = "popup"',
    popupCommand,
    'description = "Tandem panel"',
    'width = "90%"',
    'height = "90%"',
  ];
  const earlier = earlierPopupBlock(next, commands);
  if (text.includes("panel --popup")) {
    // Already there.
  } else if (earlier !== undefined) {
    const block = next
      .slice(earlier.start, earlier.end)
      .replace(/^[ \t]*command[ \t]*=.*$/mu, popupCommand)
      .replace(
        /^[ \t]*description[ \t]*=[ \t]*"Tandem status"[ \t]*$/mu,
        'description = "Tandem panel"',
      );
    next = `${next.slice(0, earlier.start)}${block}${next.slice(earlier.end)}`;
    added.push(popupCommand);
    features.push(`${STATUS_POPUP_KEY} panel`);
  } else if (text.includes(`"${STATUS_POPUP_KEY}"`)) {
    skipped.push(`${STATUS_POPUP_KEY} is taken; bind another key to: ${commands.popup}`);
  } else {
    next = `${withBlankLine(next)}${binding.join("\n")}\n`;
    added.push(...binding);
    features.push(`${STATUS_POPUP_KEY} panel`);
  }

  const keys: string[] = [];
  for (const { key, action, description } of PANEL_KEYS) {
    if (text.includes(`"${action}"`)) continue;
    if (text.includes(`"${key}"`)) {
      skipped.push(`${key} is taken; bind another key to the plugin action ${action}`);
      continue;
    }
    const lines = [
      "[[keys.command]]",
      `key = "${key}"`,
      'type = "plugin_action"',
      `command = "${action}"`,
      `description = "${description}"`,
    ];
    next = `${withBlankLine(next)}${lines.join("\n")}\n`;
    added.push(...lines);
    keys.push(key);
  }
  if (keys.length > 0) features.push(`${keys.join(" ")} keys`);
  return { text: next, added, features, skipped };
}

function withBlankLine(text: string): string {
  if (text.length === 0) return "";
  return text.endsWith("\n\n") ? text : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
}

/** A TOML basic string; JSON's escapes are all valid TOML escapes. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** How to update Herdr, from where its binary lives; undefined when only its package manager can. */
export function herdrUpdateCommand(binary: string | undefined): readonly string[] | undefined {
  if (binary === undefined) return ["herdr", "update"];
  if (/\/(Cellar|homebrew|linuxbrew)\//u.test(binary)) return ["brew", "upgrade", "herdr"];
  if (/\/(mise|nix)\//u.test(binary) || binary.startsWith("/nix/")) return undefined;
  return ["herdr", "update"];
}

/** The running server of a Herdr session: its version, or undefined when it is not running. */
export function parseServerStatus(
  output: string,
): Readonly<{ running: boolean; version?: string }> {
  const running = /^status:\s*running\s*$/mu.test(output);
  const version = /^version:\s*v?(\d+\.\d+\.\d+)/mu.exec(output)?.[1];
  return { running, ...(version === undefined ? {} : { version }) };
}

export type HerdrSetupDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly commands: HerdrStatusCommands;
  /** Tandem's Herdr plugin (`herdr-plugin/`), which holds the welcome popup, the panel, and its key actions. */
  readonly pluginDirectory: string;
  /** The Herdr session Tandem's panes run in; its server is the one to reload or restart. */
  readonly sessionId: string;
  /** Where the `herdr` binary resolves to, which says how it was installed. */
  readonly herdrBinary: string | undefined;
  /** Tasks Tandem is working on; restarting the session would stop them. Throws when unknown. */
  readonly runningTasks: () => Promise<number>;
  /** Asks a yes/no question; undefined when there is no terminal to ask in. */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
  readonly print: (text: string) => void;
  readonly readConfig: (path: string) => Promise<string | undefined>;
  readonly writeConfig: (path: string, text: string) => Promise<void>;
  readonly backupConfig: (path: string) => Promise<string>;
}>;

/**
 * Gets Herdr ready for Tandem's status: updates an older Herdr with its own installer or Homebrew,
 * offers to add Tandem's settings to its config (nothing changes without a yes; a backup is kept,
 * and the old config comes back if `herdr config check` rejects the new one), then makes Tandem's
 * Herdr session use them: a reload when its server is current, or, when the server still runs an
 * older Herdr and no task is running, a restart after asking. Returns whether everything is in
 * place.
 */
export async function setUpHerdrStatus(deps: HerdrSetupDependencies): Promise<boolean> {
  const cwd = deps.environment.HOME ?? homedir();
  const run = (argv: readonly string[]) => deps.run({ argv, cwd }).catch(() => undefined);
  const herdr = (argv: readonly string[]) => run(["herdr", ...argv]);

  const installed = async () => parseHerdrVersion((await herdr(["--version"]))?.stdout ?? "");
  let version = await installed();
  if (version !== undefined && !versionAtLeast(version, MIN_HERDR_VERSION)) {
    const update = herdrUpdateCommand(deps.herdrBinary);
    if (update === undefined) {
      deps.print(
        `! Update Herdr ${version} to ${MIN_HERDR_VERSION}+ with the package manager that installed it, then re-run ./setup.sh\n`,
      );
      return false;
    }
    deps.print(`→ updating Herdr ${version}\n`);
    const result = await run(update);
    const updated = await installed();
    if (updated !== undefined && versionAtLeast(updated, MIN_HERDR_VERSION)) {
      deps.print(`✓ Herdr ${updated}\n`);
    } else {
      // Only a failed update is worth its output.
      const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim();
      if (output.length > 0) deps.print(`${output.replace(/^/gmu, "  ")}\n`);
    }
    version = updated;
  }
  if (version === undefined || !versionAtLeast(version, MIN_HERDR_VERSION)) {
    deps.print(
      `! Tandem's Herdr status needs Herdr ${MIN_HERDR_VERSION}+${version === undefined ? "" : ` (you have ${version})`}\n`,
    );
    return false;
  }

  const configured = (await writeHerdrConfig(deps, herdr)) && (await applyToSession(deps, herdr));
  const linked = await linkTandemPlugin(deps, herdr);
  return configured && linked;
}

/** Links Tandem's Herdr plugin after asking, so the Tandem coordinator can open its welcome popup and panel. */
async function linkTandemPlugin(deps: HerdrSetupDependencies, herdr: Herdr): Promise<boolean> {
  const plugins = await herdr(["plugin", "list"]);
  if (plugins?.stdout.includes(`- ${TANDEM_HERDR_PLUGIN} (`) === true) return true;
  if (deps.confirm === undefined) {
    deps.print("! Skipped Tandem's welcome popup and panel: no terminal to ask in\n");
    return false;
  }
  if (!(await deps.confirm("Add Tandem's welcome popup and panel to Herdr?"))) {
    deps.print("Skipped Tandem's welcome popup and panel\n");
    return false;
  }
  const linked = await herdr(["--session", deps.sessionId, "plugin", "link", deps.pluginDirectory]);
  if (linked?.code === 0) {
    deps.print("✓ Tandem's welcome popup and panel added to Herdr\n");
    return true;
  }
  deps.print(`! Add it by hand: herdr plugin link ${deps.pluginDirectory}\n`);
  return false;
}

type Herdr = (argv: readonly string[]) => Promise<CommandResult | undefined>;

/** Adds Tandem's settings to Herdr's config after asking; true when they are there. */
async function writeHerdrConfig(deps: HerdrSetupDependencies, herdr: Herdr): Promise<boolean> {
  const path = herdrConfigPath(deps.environment);
  const original = await deps.readConfig(path);
  const plan = planHerdrConfig(original ?? "", deps.commands);
  for (const reason of plan.skipped) deps.print(`! ${reason}\n`);
  if (plan.added.length === 0) return true;

  if (deps.confirm === undefined) {
    deps.print("! Skipped Herdr config: no terminal to ask in\n");
    return false;
  }
  if (!(await deps.confirm(`Add Tandem's ${listed(plan.features)} to Herdr?`))) {
    deps.print("Skipped Herdr config\n");
    return false;
  }

  const valid = async () => (await herdr(["config", "check"]))?.code === 0;
  const validBefore = original !== undefined && (await valid());
  const backup = original === undefined ? undefined : await deps.backupConfig(path);
  await deps.writeConfig(path, plan.text);
  if (validBefore && !(await valid())) {
    await deps.writeConfig(path, original);
    deps.print(
      "! Herdr rejected the change, so the old config is back (see: herdr config check)\n",
    );
    return false;
  }
  deps.print(
    `✓ Herdr config updated${backup === undefined ? "" : ` (backup: ${basename(backup)})`}\n`,
  );
  return true;
}

/** "a", "a and b", "a, b, and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/**
 * Makes Tandem's Herdr session use the config. Plain `herdr server reload-config` would reach only
 * the default session. A server still on an older Herdr cannot run the tab-bar entry, and only a
 * restart updates it; that closes the session's panes, so it waits for idle tasks and a yes.
 */
async function applyToSession(deps: HerdrSetupDependencies, herdr: Herdr): Promise<boolean> {
  const session = deps.sessionId;
  const server = parseServerStatus(
    (await herdr(["--session", session, "status", "server"]))?.stdout ?? "",
  );
  const later = `herdr session stop ${session} && tandem`;
  if (!server.running) return true;
  if (server.version === undefined || versionAtLeast(server.version, MIN_HERDR_VERSION)) {
    const reloaded = (await herdr(["--session", session, "server", "reload-config"]))?.code === 0;
    deps.print(
      reloaded
        ? `✓ Herdr reloaded; ${STATUS_POPUP_KEY} opens Tandem's panel\n`
        : `! Reload Herdr: herdr --session ${session} server reload-config\n`,
    );
    return reloaded;
  }

  const stale = `Herdr's ${session} session still runs ${server.version} and needs a restart`;
  const inside =
    (deps.environment.HERDR_SESSION ?? deps.environment.HERDR_SESSION_NAME) === session;
  if (inside) {
    deps.print(`! ${stale}; from outside Herdr, run: ${later}\n`);
    return false;
  }
  const running = await deps.runningTasks().catch(() => undefined);
  if (running === undefined || running > 0) {
    const why = running === undefined ? "tasks may be running" : `${running} running`;
    deps.print(`! ${stale} (${why}); when idle, run: ${later}\n`);
    return false;
  }
  const question = `${stale}. Restart it? Its panes close; tandem reopens your projects.`;
  if (deps.confirm === undefined || !(await deps.confirm(question))) {
    deps.print(`Later, run: ${later}\n`);
    return false;
  }
  if ((await herdr(["session", "stop", session]))?.code !== 0) {
    deps.print(`! Could not stop it; run: ${later}\n`);
    return false;
  }
  deps.print(`✓ Stopped Herdr's ${session} session; run tandem to reopen your projects\n`);
  return true;
}

async function main(): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const tandemMain = fileURLToPath(new URL("../../main.ts", import.meta.url));
  const tandem = resolveTandemEnvironment(process.env, {
    cwd: process.cwd(),
    sessionId: DEFAULT_TERMINAL_SESSION_ID,
  });
  const binary = Bun.which("herdr");
  await setUpHerdrStatus({
    run: runCommand,
    environment: process.env,
    commands: herdrStatusCommands(process.execPath, tandemMain),
    pluginDirectory: fileURLToPath(new URL("../../../herdr-plugin", import.meta.url)),
    sessionId: tandem.sessionId,
    herdrBinary: binary === null ? undefined : await realpath(binary).catch(() => binary),
    runningTasks: async () => {
      const board = await readBoard(tandem.home, () => new Date().toISOString());
      return board.running.filter((row) => row.cause !== "paused").length;
    },
    confirm: interactive
      ? async (question) => {
          const readline = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return /^y(es)?$/iu.test((await readline.question(`${question} [y/N] `)).trim());
          } finally {
            readline.close();
          }
        }
      : undefined,
    print: (text) => process.stdout.write(text),
    readConfig: (path) =>
      readFile(path, "utf8").catch((error: unknown) => {
        // Only a missing file counts as an empty config; anything else must not be overwritten.
        if ((error as { readonly code?: unknown }).code === "ENOENT") return undefined;
        throw error;
      }),
    writeConfig: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },
    backupConfig: async (path) => {
      const backup = `${path}.before-tandem`;
      await copyFile(path, backup);
      return backup;
    },
  });
}

if (import.meta.main) await main();
