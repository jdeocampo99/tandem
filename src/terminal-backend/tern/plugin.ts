import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AdapterCommandError, AdapterProtocolError } from "../../adapters/primitives.ts";
import type { CommandRunner } from "../../contracts.ts";
import { configureTernPluginKeys } from "./plugin-keys.ts";

export const TANDEM_TERN_PLUGIN = "tandem";
export const TERN_PLUGIN_DIRECTORY = fileURLToPath(
  new URL("../../../tern-plugin", import.meta.url),
);
export const TERN_APP_BINARY = "/Applications/Tern.app/Contents/MacOS/tern";

const catalogSchema = z.object({
  plugins: z.array(z.object({ id: z.string(), status: z.string(), window: z.boolean() })),
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
  const request = {
    argv: [deps.binary ?? TERN_APP_BINARY, "plugin", ...args, "--json"],
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

/** Onboarding consent links the package and adds shortcuts; existing custom keys are retained. */
export async function ensureTernPlugin(deps: TernPluginDependencies): Promise<boolean> {
  const before = await catalog(deps);
  const existing = before.plugins.find((plugin) => plugin.id === TANDEM_TERN_PLUGIN);
  if (existing !== undefined) {
    if (existing.status !== "ready" || !existing.window) return false;
    return configureKeys(deps);
  }
  if (deps.confirm === undefined || !(await deps.confirm("Add Tandem's views and keys to Tern?"))) {
    return false;
  }
  await command(deps, ["link", deps.directory ?? TERN_PLUGIN_DIRECTORY]);
  const after = await catalog(deps);
  const ready = after.plugins.some(
    (plugin) => plugin.id === TANDEM_TERN_PLUGIN && plugin.status === "ready" && plugin.window,
  );
  return ready && configureKeys(deps, true);
}

async function configureKeys(deps: TernPluginDependencies, approved = false): Promise<boolean> {
  const result = await configureTernPluginKeys({
    approved,
    ...(deps.settingsPath === undefined ? {} : { path: deps.settingsPath }),
    ...(deps.env?.TERN_CONFIG_DIR === undefined
      ? {}
      : { configDirectory: deps.env.TERN_CONFIG_DIR }),
    ...(deps.confirm === undefined ? {} : { confirm: deps.confirm }),
  });
  if (result.skipped.length > 0)
    deps.print?.(`Tandem kept your custom Tern shortcuts: ${result.skipped.join(", ")}\n`);
  return result.configured;
}

/** Update reloads an already installed integration. It never installs one without consent. */
export async function reloadTernPlugin(deps: TernPluginDependencies): Promise<boolean> {
  const before = await catalog(deps);
  if (!before.plugins.some((plugin) => plugin.id === TANDEM_TERN_PLUGIN)) return false;
  await command(deps, ["reload"]);
  const after = await catalog(deps);
  if (
    !after.plugins.some(
      (plugin) => plugin.id === TANDEM_TERN_PLUGIN && plugin.status === "ready" && plugin.window,
    )
  )
    throw new Error("Tandem's Tern plugin failed to reload");
  return true;
}
