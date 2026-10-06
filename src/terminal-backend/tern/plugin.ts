import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AdapterCommandError, AdapterProtocolError } from "../../adapters/primitives.ts";
import type { CommandRunner } from "../../contracts.ts";
import { describeTernPluginKeys } from "./plugin-keys.ts";
import { configureTernPluginSettings, restoreTernPluginSettings } from "./plugin-settings.ts";

export const TANDEM_TERN_PLUGIN = "tandem";
export const TERN_PLUGIN_DIRECTORY = fileURLToPath(
  new URL("../../../tern-plugin", import.meta.url),
);
export const TERN_APP_BINARY = "/Applications/Tern.app/Contents/MacOS/tern";

const catalogSchema = z.object({
  plugins: z.array(
    z.object({ id: z.string(), status: z.string(), host: z.boolean(), window: z.boolean() }),
  ),
  problems: z.array(z.unknown()),
});

export type TernPluginDependencies = Readonly<{
  run: CommandRunner;
  cwd: string;
  binary?: string;
  directory?: string;
  env?: Readonly<Record<string, string>>;
  confirm?: (question: string) => Promise<boolean>;
  settingsPath?: string;
  print?: (text: string) => void;
}>;

async function command(deps: TernPluginDependencies, args: readonly string[]) {
  const binary =
    deps.binary ??
    Bun.which("tern", { PATH: deps.env?.PATH ?? process.env.PATH ?? "" }) ??
    TERN_APP_BINARY;
  const request = {
    argv: [binary, "plugin", ...args, "--json"],
    cwd: deps.cwd,
    ...(deps.env === undefined ? {} : { env: deps.env }),
  };
  const result = await deps.run(request);
  if (result.code !== 0) throw new AdapterCommandError("Tern plugin", request, result);
  return result.stdout;
}

async function catalog(deps: TernPluginDependencies) {
  const raw = await command(deps, ["list"]);
  try {
    return catalogSchema.parse(JSON.parse(raw));
  } catch {
    throw new AdapterProtocolError("Tern plugin list", "invalid plugin catalog", raw);
  }
}

/** Selecting Tern links its view package; one separate consent controls global preferences. */
export async function ensureTernPlugin(deps: TernPluginDependencies): Promise<boolean> {
  const before = await catalog(deps);
  const existing = before.plugins.find((plugin) => plugin.id === TANDEM_TERN_PLUGIN);
  if (existing !== undefined) {
    if (existing.status !== "ready" || !existing.host || !existing.window) return false;
    await configureSettings(deps);
    return true;
  }
  await command(deps, ["link", deps.directory ?? TERN_PLUGIN_DIRECTORY]);
  const after = await catalog(deps);
  const ready = after.plugins.some(
    (plugin) =>
      plugin.id === TANDEM_TERN_PLUGIN && plugin.status === "ready" && plugin.host && plugin.window,
  );
  if (ready) await configureSettings(deps);
  return ready;
}

async function configureSettings(deps: TernPluginDependencies): Promise<void> {
  const result = await configureTernPluginSettings({
    ...(deps.settingsPath === undefined ? {} : { path: deps.settingsPath }),
    ...(deps.env?.TERN_CONFIG_DIR === undefined
      ? {}
      : { configDirectory: deps.env.TERN_CONFIG_DIR }),
    ...(deps.confirm === undefined ? {} : { confirm: deps.confirm }),
  });
  if (!result.notice) return;
  if (result.preset)
    deps.print?.(
      `Tandem kept Tern's ${result.preset} keymap preset; Tandem shortcuts were not added.\n`,
    );
  if (result.skipped.length > 0)
    deps.print?.(
      `Tandem kept your custom Tern shortcuts: ${describeTernPluginKeys(result.skipped)}.\n`,
    );
  if (!result.configured)
    deps.print?.(
      "Tern's sidebar and shortcuts are unchanged. Tandem is available from the palette and panel buttons. To change this later, switch to Herdr and select Tern again in setup.\n",
    );
}

const restorationWarnings = new Set<string>();

/** Preference cleanup is best-effort: it must never prevent using the selected Herdr terminal. */
export async function restoreTernPluginPreferences(deps: TernPluginDependencies): Promise<void> {
  try {
    const result = await restoreTernPluginSettings({
      ...(deps.settingsPath === undefined ? {} : { path: deps.settingsPath }),
      ...(deps.env?.TERN_CONFIG_DIR === undefined
        ? {}
        : { configDirectory: deps.env.TERN_CONFIG_DIR }),
    });
    if (result.restored.length > 0)
      deps.print?.("Restored Tern's previous sidebar and Tandem shortcuts.\n");
    if (result.preserved.length > 0)
      deps.print?.("Kept Tern settings you changed after Tandem setup.\n");
  } catch (error) {
    const key = deps.settingsPath ?? deps.env?.TERN_CONFIG_DIR ?? "default";
    if (restorationWarnings.has(key)) return;
    restorationWarnings.add(key);
    const message = error instanceof Error ? error.message : String(error);
    const warning = `Tandem couldn't restore Tern preferences; Herdr will still open. Fix Tern's settings and try again: ${message}\n`;
    if (deps.print) deps.print(warning);
    else process.stderr.write(warning);
  }
}

/** Update reloads an already installed integration. It never installs one without consent. */
export async function reloadTernPlugin(deps: TernPluginDependencies): Promise<boolean> {
  const before = await catalog(deps);
  if (!before.plugins.some((plugin) => plugin.id === TANDEM_TERN_PLUGIN)) return false;
  await command(deps, ["reload"]);
  const after = await catalog(deps);
  if (
    !after.plugins.some(
      (plugin) =>
        plugin.id === TANDEM_TERN_PLUGIN &&
        plugin.status === "ready" &&
        plugin.host &&
        plugin.window,
    )
  )
    throw new Error("Tandem's Tern plugin failed to reload");
  return true;
}
