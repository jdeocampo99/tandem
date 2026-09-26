import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { quoteShellArgument, runCommand } from "../adapters/commands.ts";
import type { CommandRunner } from "../contracts.ts";

/** The oldest Herdr with both popup keybindings (0.7.4) and command entries in the tab bar (0.8.2). */
export const MIN_HERDR_VERSION = "0.8.2";

/** The key that opens the live status in a Herdr popup. */
export const STATUS_POPUP_KEY = "prefix+t";

export type HerdrStatusCommands = Readonly<{
  /** Prints the one-line summary for the tab bar. */
  readonly line: string;
  /** Draws the live status until Esc or q. */
  readonly popup: string;
}>;

export type HerdrConfigPlan = Readonly<{
  /** The config after the additions; the same text when nothing is added. */
  readonly text: string;
  /** What will be added, as the lines the user sees before agreeing. */
  readonly added: readonly string[];
  /** What was left alone, and why. */
  readonly skipped: readonly string[];
}>;

/** The version in `herdr --version` output, like "herdr 0.9.1". */
export function parseHerdrVersion(output: string): string | undefined {
  return /herdr\s+v?(\d+\.\d+\.\d+)/u.exec(output)?.[1];
}

/** Whether a dotted version is at least the minimum, comparing each number in turn. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const left = version.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/**
 * Tandem's status commands with absolute paths: Herdr runs them through `/bin/sh -lc`, whose PATH
 * may not include Bun's bin directory.
 */
export function herdrStatusCommands(bun: string, main: string): HerdrStatusCommands {
  const tandem = `${quoteShellArgument(bun)} ${quoteShellArgument(main)}`;
  return { line: `${tandem} status --line`, popup: `${tandem} status --watch` };
}

/** Where Herdr reads its config, as Herdr resolves it on macOS and Linux. */
export function herdrConfigPath(environment: Readonly<Record<string, string | undefined>>): string {
  const configHome = environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), ".config");
  return join(configHome, "herdr", "config.toml");
}

/**
 * Adds the tab-bar summary and the status popup to a Herdr config, leaving everything the user
 * wrote untouched. Anything Tandem cannot add without editing the user's own settings, such as an
 * existing `tab_bar_right` list or another binding on the popup key, is skipped with the line to
 * add by hand.
 */
export function planHerdrConfig(text: string, commands: HerdrStatusCommands): HerdrConfigPlan {
  const added: string[] = [];
  const skipped: string[] = [];
  let next = text;

  const entry = `{ type = "command", command = ${tomlString(commands.line)}, interval_seconds = 5, timeout_seconds = 10 }`;
  if (text.includes("status --line")) {
    skipped.push("The tab bar already shows Tandem's status.");
  } else if (/^\s*tab_bar_right\s*=/mu.test(text)) {
    skipped.push(`You already set ui.tab_bar_right; add this entry to it yourself:\n  ${entry}`);
  } else if (/^\s*ui\s*[.=]/mu.test(text)) {
    skipped.push(
      `Your config sets ui without a [ui] table; add this under ui yourself:\n  tab_bar_right = [${entry}]`,
    );
  } else {
    const line = `tab_bar_right = [${entry}]`;
    const table = /^[ \t]*\[ui\][ \t]*(#.*)?$/mu.exec(next);
    if (table === null) {
      next = `${withBlankLine(next)}[ui]\n${line}\n`;
      added.push("[ui]", line);
    } else {
      const end = table.index + table[0].length;
      next = `${next.slice(0, end)}\n${line}${next.slice(end)}`;
      added.push(`${line}   (under your [ui] table)`);
    }
  }

  const binding = [
    "# Tandem's live status; Esc or q closes it",
    "[[keys.command]]",
    `key = "${STATUS_POPUP_KEY}"`,
    'type = "popup"',
    `command = ${tomlString(commands.popup)}`,
    'description = "Tandem status"',
    'width = "90%"',
    'height = "90%"',
  ];
  if (text.includes("status --watch")) {
    skipped.push(`${STATUS_POPUP_KEY} already opens Tandem's status.`);
  } else if (text.includes(`"${STATUS_POPUP_KEY}"`)) {
    skipped.push(
      `${STATUS_POPUP_KEY} is already bound in your config; to use another key, add this with it:\n${binding.map((line) => `  ${line}`).join("\n")}`,
    );
  } else {
    next = `${withBlankLine(next)}${binding.join("\n")}\n`;
    added.push(...binding);
  }
  return { text: next, added, skipped };
}

function withBlankLine(text: string): string {
  if (text.length === 0) return "";
  return text.endsWith("\n\n") ? text : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
}

/** A TOML basic string; JSON's escapes are all valid TOML escapes. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export type HerdrSetupDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly commands: HerdrStatusCommands;
  /** Asks a yes/no question; undefined when there is no terminal to ask in. */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
  readonly print: (text: string) => void;
  readonly readConfig: (path: string) => Promise<string | undefined>;
  readonly writeConfig: (path: string, text: string) => Promise<void>;
  readonly backupConfig: (path: string) => Promise<string>;
}>;

/**
 * Updates Herdr when it is older than {@link MIN_HERDR_VERSION}, then offers to add Tandem's status to its config. Changes nothing
 * without a yes, keeps a backup, and puts the old config back if `herdr config check` rejects the
 * new one. Returns whether Herdr is ready for the status popup and tab bar.
 */
export async function setUpHerdrStatus(deps: HerdrSetupDependencies): Promise<boolean> {
  const cwd = deps.environment.HOME ?? homedir();
  const herdr = (argv: readonly string[]) =>
    deps.run({ argv: ["herdr", ...argv], cwd }).catch(() => undefined);

  const installed = async () => parseHerdrVersion((await herdr(["--version"]))?.stdout ?? "");
  let version = await installed();
  if (version !== undefined && !versionAtLeast(version, MIN_HERDR_VERSION)) {
    deps.print(`→ updating Herdr ${version}; Tandem needs ${MIN_HERDR_VERSION} or newer\n`);
    await herdr(["update"]);
    version = await installed();
  }
  if (version === undefined || !versionAtLeast(version, MIN_HERDR_VERSION)) {
    deps.print(
      `! Tandem's status popup and tab bar need Herdr ${MIN_HERDR_VERSION} or newer${version === undefined ? "" : ` (you have ${version})`}; update with: herdr update\n`,
    );
    return false;
  }
  deps.print(`✓ herdr ${version}\n`);

  const path = herdrConfigPath(deps.environment);
  const original = await deps.readConfig(path);
  const plan = planHerdrConfig(original ?? "", deps.commands);
  for (const reason of plan.skipped) deps.print(`✓ ${reason}\n`);
  if (plan.added.length === 0) return true;

  deps.print(
    `\nTandem can show its status in Herdr: a one-line summary in the tab bar, and the full view with ${STATUS_POPUP_KEY}.\nIt would add to ${path}:\n\n${plan.added.map((line) => `  ${line}`).join("\n")}\n\n`,
  );
  if (deps.confirm === undefined) {
    deps.print("! Skipped: no terminal to ask in. Run ./setup.sh in a terminal to add it.\n");
    return false;
  }
  if (!(await deps.confirm(`Add this to ${path}?`))) {
    deps.print("Skipped; your Herdr config is unchanged.\n");
    return false;
  }

  const valid = async () => (await herdr(["config", "check"]))?.code === 0;
  const validBefore = original !== undefined && (await valid());
  const backup = original === undefined ? undefined : await deps.backupConfig(path);
  await deps.writeConfig(path, plan.text);
  if (validBefore && !(await valid())) {
    await deps.writeConfig(path, original);
    deps.print(
      `! Herdr rejected the new config, so the old one is back. Run herdr config check to see why.\n`,
    );
    return false;
  }
  deps.print(`✓ Added to ${path}${backup === undefined ? "" : ` (backup: ${backup})`}\n`);
  const reloaded = (await herdr(["server", "reload-config"]))?.code === 0;
  deps.print(
    reloaded
      ? `✓ Herdr reloaded its config; press ${STATUS_POPUP_KEY} for the live status\n`
      : `Herdr picks it up the next time it starts, or run: herdr server reload-config\n`,
  );
  return true;
}

async function main(): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const tandemMain = fileURLToPath(new URL("../main.ts", import.meta.url));
  await setUpHerdrStatus({
    run: runCommand,
    environment: process.env,
    commands: herdrStatusCommands(process.execPath, tandemMain),
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
