import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AdapterProtocolError } from "../../adapters/primitives.ts";
import { type TernRunner, ternPlugin } from "./cli.ts";
import {
  configureTernPluginSettingsLocked,
  describeTernPluginKeys,
  settingsInput,
  type TernPreferenceDependencies,
  withSetupLock,
} from "./preferences.ts";

const TANDEM_TERN_PLUGIN = "tandem";
const TERN_PLUGIN_DIRECTORY = fileURLToPath(new URL("../../../tern-plugin", import.meta.url));

const catalogSchema = z.object({
  plugins: z.array(
    z.object({ id: z.string(), status: z.string(), host: z.boolean(), window: z.boolean() }),
  ),
  problems: z.array(z.unknown()),
});

export type TernPluginDependencies = TernPreferenceDependencies &
  Readonly<{
    run: TernRunner;
    cwd: string;
    binary?: string;
    directory?: string;
  }>;

/** Tandem cannot run without Tern, so a missing app and a failed link end in this one message. */
export class TernRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Tandem needs Tern, which could not be used. Install Tern at /Applications/Tern.app, then try again.",
      options,
    );
    this.name = "TernRequiredError";
  }
}

async function pluginCommand(deps: TernPluginDependencies, args: readonly string[]) {
  try {
    return await ternPlugin(deps, args);
  } catch (error) {
    throw new TernRequiredError({ cause: error });
  }
}

async function catalog(deps: TernPluginDependencies) {
  const raw = await pluginCommand(deps, ["list"]);
  try {
    return catalogSchema.parse(JSON.parse(raw));
  } catch {
    throw new AdapterProtocolError("Tern plugin list", "invalid plugin catalog", raw);
  }
}

function readyIn(plugins: z.infer<typeof catalogSchema>["plugins"]): boolean {
  return plugins.some(
    (plugin) =>
      plugin.id === TANDEM_TERN_PLUGIN && plugin.status === "ready" && plugin.host && plugin.window,
  );
}

/**
 * Selecting Tern links its view package and sets Tern's sidebar and shortcuts. The whole sequence
 * holds the setup lock, so concurrent starts link and configure once.
 */
export async function ensureTernPlugin(deps: TernPluginDependencies): Promise<boolean> {
  const input = settingsInput(deps);
  return withSetupLock(input, async () => {
    const before = await catalog(deps);
    if (before.plugins.some((plugin) => plugin.id === TANDEM_TERN_PLUGIN)) {
      if (!readyIn(before.plugins)) return false;
    } else {
      await pluginCommand(deps, ["link", deps.directory ?? TERN_PLUGIN_DIRECTORY]);
      if (!readyIn((await catalog(deps)).plugins)) return false;
    }
    printConfigureNotices(deps, await configureTernPluginSettingsLocked(input));
    return true;
  });
}

function printConfigureNotices(
  deps: TernPluginDependencies,
  result: Awaited<ReturnType<typeof configureTernPluginSettingsLocked>>,
): void {
  const { applied } = result;
  if (applied === undefined) return;
  if (applied.sidebar) deps.print?.("Tandem hid Tern's sidebar; the panel replaces it.\n");
  if (applied.keys)
    deps.print?.(
      "Tandem added Tern shortcuts: ⌘⇧B board, ⌘⇧P PRs, ⌘⇧U usage, ⌘⇧, settings, ⌘1–9 projects.\n",
    );
  if (result.preset)
    deps.print?.(`Tandem kept Tern's ${result.preset} keymap preset, so it added no shortcuts.\n`);
  if (result.skipped.length > 0)
    deps.print?.(
      `Tandem kept your custom Tern shortcuts: ${describeTernPluginKeys(result.skipped)}.\n`,
    );
}

/** Update reloads an already installed integration. It never installs one without consent. */
export function reloadTernPlugin(deps: TernPluginDependencies): Promise<boolean> {
  return withSetupLock(settingsInput(deps), async () => {
    const before = await catalog(deps);
    if (!before.plugins.some((plugin) => plugin.id === TANDEM_TERN_PLUGIN)) return false;
    await ternPlugin(deps, ["reload"]);
    if (!readyIn((await catalog(deps)).plugins))
      throw new Error("Tandem's Tern plugin failed to reload");
    return true;
  });
}
