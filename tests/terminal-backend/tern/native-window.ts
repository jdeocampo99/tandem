import { appendFile, cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { terminalBackend } from "../../../src/terminal-backend/compose.ts";
import type { TerminalBackend } from "../../../src/terminal-backend/contract.ts";
import { configureTernPluginSettings } from "../../../src/terminal-backend/tern/plugin.ts";

/** Every real-Tern test runs only on macOS with this one opt-in. */
export const ternNativeEnabled =
  process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";

export type ControlNode = Readonly<{
  class?: string | undefined;
  text?: string | undefined;
  rect?: readonly number[] | undefined;
  children?: readonly ControlNode[] | undefined;
}>;
const ControlNode: z.ZodType<ControlNode> = z.lazy(() =>
  z.object({
    class: z.string().optional(),
    text: z.string().optional(),
    rect: z.array(z.number()).optional(),
    children: z.array(ControlNode).optional(),
  }),
);
const ControlTree = z.object({ tree: z.array(ControlNode) });
const ControlState = z.object({ focused: z.object({ id: z.number() }).nullable().optional() });

export type TernWindow = Readonly<{
  root: string;
  home: string;
  plugin: string;
  binary: string;
  env: Readonly<Record<string, string>>;
  /** Runs any command with the isolated environment; Tern's commands reach only this daemon. */
  run: CommandRunner;
  tern: (...args: string[]) => Promise<string>;
  ctl: (...args: string[]) => Promise<string>;
  terminal: TerminalBackend;
  /** Every drawn node, depth first. */
  nodes: () => Promise<readonly ControlNode[]>;
  /** The visible text, one node per line. */
  screen: () => Promise<string>;
  focusedPane: () => Promise<string | undefined>;
  click: (target: string | ControlNode | undefined) => Promise<void>;
  /** Clicks a control that focuses a text field, types `text`, and waits until the field shows it. */
  typeInto: (target: string | ControlNode | undefined, text: string) => Promise<void>;
  shot: (name: string) => Promise<string>;
  until: (label: string, check: () => Promise<boolean>, timeoutMs?: number) => Promise<void>;
}>;

export type TernWindowOptions = Readonly<{
  /** Names the temporary root, `/tmp/tdm-<name>-…`, which is kept as evidence. */
  name: string;
  /** Tandem home; defaults to `<root>/home`. */
  home?: string;
  /**
   * A bun script that answers the plugin's `tandem.sh` and `native-input.sh` in the copied plugin,
   * so clicks reach a test boundary. `native-input.sh` calls it with `--stdin-input` first.
   */
  driver?: string;
  size?: readonly [number, number];
}>;

export function flatten(nodes: readonly ControlNode[]): readonly ControlNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

export function hasClass(node: ControlNode, name: string): boolean {
  return node.class?.split(" ").includes(name) === true;
}

/**
 * Lets Tern, Git, `ps` and Tern's process reader through `run` and refuses every other program, so
 * Tandem code under test cannot reach GitHub, a model or a worktree tool. Git only ever sees the
 * test's own repositories under its root. Refusals go to `log`.
 */
export function isolatedRunner(run: CommandRunner, log: string): CommandRunner {
  const allowed: Readonly<Record<string, true>> = { tern: true, git: true, ps: true };
  return async (request) => {
    const program = basename(request.argv[0] ?? "");
    const processReader = request.argv[1]?.endsWith("/terminal-backend/tern/process-reader.ts");
    if (allowed[program] === true || (program === "bun" && processReader)) return run(request);
    await appendFile(log, `refused ${JSON.stringify(request.argv)}\n`);
    return { code: 127, stdout: "", stderr: `isolated Tern test refuses ${program}` };
  };
}

/**
 * Starts an isolated Tern daemon and control window with a private config dir, plugin copy and
 * Tandem home, runs `body`, then quits the window and stops the daemon, also on failure.
 */
export async function withTernWindow(
  options: TernWindowOptions,
  body: (window: TernWindow) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(`/tmp/tdm-${options.name}-`));
  const home = options.home ?? join(root, "home");
  const plugin = join(root, "plugin");
  const control = join(root, "w.sock");
  const shots = join(root, "shots");
  const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
  const env = {
    HOME: root,
    USER: "tandem-test",
    LOGNAME: "tandem-test",
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
    SHELL: "/bin/zsh",
    TERM: "xterm-256color",
    ZDOTDIR: join(root, "zdot"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    TERN_CONFIG_DIR: join(root, "config"),
    TERN_DAEMON_SOCKET: join(root, "d.sock"),
    STENCIL_LOG_DIR: join(root, "logs"),
    TANDEM_HOME: home,
  };
  await Promise.all(
    [home, env.ZDOTDIR, env.TERN_CONFIG_DIR, shots].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(
    join(env.TERN_CONFIG_DIR, "settings.json"),
    JSON.stringify({ tabs_autohide: true, layout: "rail", link_target: "Tern" }),
  );
  // The shortcuts a user gets by accepting Tandem's Tern preferences during setup.
  await configureTernPluginSettings({ configDirectory: env.TERN_CONFIG_DIR, approved: true });
  await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
    recursive: true,
  });
  if (options.driver !== undefined) {
    const exec = `#!/bin/sh\nTANDEM_WORKFLOW_ROOT='${root}' exec '${process.execPath}' '${options.driver}'`;
    await writeFile(join(plugin, "tandem.sh"), `${exec} "$@"\n`, { mode: 0o755 });
    await writeFile(join(plugin, "native-input.sh"), `${exec} --stdin-input "$@"\n`, {
      mode: 0o755,
    });
  }

  const run: CommandRunner = async (request) => {
    const child = Bun.spawn([...request.argv], {
      cwd: request.cwd,
      env: { ...env, ...request.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: request.timeoutMs ?? 15_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  const tern = async (...args: string[]) => {
    const result = await run({ argv: [binary, ...args], cwd: root });
    if (result.code !== 0)
      throw new Error(`tern ${args.join(" ")}: ${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  const ctl = (...args: string[]) => tern("ctl", "--control", control, ...args);
  const nodes = async () => flatten(ControlTree.parse(JSON.parse(await ctl("tree"))).tree);
  const screen = async () =>
    (await nodes()).flatMap((node) => (node.text === undefined ? [] : [node.text])).join("\n");
  const shot = async (name: string) => {
    await ctl("shot", name);
    return join(shots, "live", `${name}.png`);
  };
  const until = async (label: string, check: () => Promise<boolean>, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check().catch(() => false))) {
      if (Date.now() > deadline) {
        const evidence = `timeout-${label.replace(/[^a-z0-9]+/giu, "-")}`;
        await writeFile(join(root, `${evidence}.tree.json`), await ctl("tree")).catch(() => {});
        const path = await shot(evidence).catch(() => "no screenshot");
        throw new Error(`Timed out waiting for ${label}; screen ${path}; evidence ${root}`);
      }
      await Bun.sleep(100);
    }
  };
  const click = async (target: string | ControlNode | undefined) => {
    const node =
      typeof target === "string"
        ? (await nodes()).find((candidate) => candidate.text === target && candidate.rect)
        : target;
    const rect = node?.rect;
    if (rect === undefined)
      throw new Error(`Nothing to click for ${typeof target === "string" ? target : "node"}`);
    const [x = 0, y = 0, width = 0, height = 0] = rect;
    await ctl("click", String(x + width / 2), String(y + height / 2));
  };
  const typeInto = async (target: string | ControlNode | undefined, text: string) => {
    // A plugin block moves focus into its field on a later frame, and the control tree exposes
    // no editor focus, so text typed too soon is dropped by the block. Only an empty field retries.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await click(target);
      await ctl("type", JSON.stringify(text));
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        if ((await screen()).includes(text)) return;
        await Bun.sleep(100);
      }
    }
    await until(`typed text ${JSON.stringify(text)}`, async () => (await screen()).includes(text));
  };
  const focusedPane = async () => {
    const id = ControlState.parse(JSON.parse(await ctl("state"))).focused?.id;
    return id === undefined ? undefined : String(id);
  };

  const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
    env,
    cwd: root,
    stdout: "ignore",
    stderr: Bun.file(join(root, "daemon.log")),
  });
  let window: Bun.Subprocess | undefined;
  const pending: TernWindow = {
    root,
    home,
    plugin,
    binary,
    env,
    run,
    tern,
    ctl,
    terminal: terminalBackend(run, { terminal: "tern", home, tern: { environment: env } }),
    nodes,
    screen,
    focusedPane,
    click,
    typeInto,
    shot,
    until,
  };
  try {
    await until(
      "Tern daemon",
      async () => (await run({ argv: [binary, "ls", "--json"], cwd: root })).code === 0,
    );
    await tern("plugin", "link", plugin, "--json");
    window = Bun.spawn([binary, "--control", control, "--dir", root, "--out", shots], {
      env,
      cwd: root,
      stdout: "ignore",
      stderr: Bun.file(join(root, "window.log")),
    });
    await until("Tern window", async () => {
      await ctl("state");
      return true;
    });
    await ctl("account", "signed-in");
    const [width, height] = options.size ?? [1500, 950];
    await ctl("size", String(width), String(height));
    // `ctl state` answers before the plugin host finishes starting; a route opened in that window
    // never writes its receipt.
    await Bun.sleep(500);
    await body(pending);
    console.log(`Native evidence: ${root}`);
  } catch (error) {
    await shot("failure").catch(() => {});
    console.error(`Native failure evidence: ${root}`);
    throw error;
  } finally {
    if (window !== undefined) {
      await ctl("quit").catch(() => {});
      if (window.exitCode === null) window.kill("SIGKILL");
      await window.exited;
    }
    daemon.kill("SIGTERM");
    await daemon.exited;
  }
}

export type SeededCoordinator = Readonly<{
  repo: string;
  checkout: string;
  endpoint: Endpoint;
  /** Every line typed into the conversation, so prompts Tandem delivers are observable. */
  transcript: string;
}>;

/**
 * A project at `<root>/<name>`: a Git repository with one commit, the coordinator's own worktree
 * beside it, a coordinator conversation in its own Tern tab and its saved registry record. The
 * pane runs a shell that prints a short transcript and keeps reading, in place of the harness.
 */
export async function seedCoordinator(
  window: TernWindow,
  input: Readonly<{ name: string; sessionId: string }>,
): Promise<SeededCoordinator> {
  const repo = join(window.root, input.name);
  const checkout = join(window.root, `${input.name}-coordinator`);
  const branch = `tandem/coordinator-${input.name}`;
  const transcript = join(window.root, `${input.name}-transcript.txt`);
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), `# ${input.name}\n`);
  const git = async (...args: string[]) => {
    const result = await window.run({
      argv: ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      cwd: repo,
    });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await git("init", "-q", "-b", "main");
  await git("add", "README.md");
  await git("commit", "-qm", "fixture");
  await git("worktree", "add", "-q", "-b", branch, checkout);
  const { endpoint } = await window.terminal.createWorkspace({
    sessionId: input.sessionId,
    cwd: checkout,
    role: "coordinator",
    generation: 0,
    label: input.name,
  });
  await saveCoordinatorRecord(window.home, {
    schemaVersion: 1,
    repoPath: repo,
    endpoint,
    harness: DEFAULT_HARNESS,
    command: ["omp", "--cwd", checkout, "--session-dir", join(window.home, input.name)],
    worktree: {
      root: window.root,
      path: checkout,
      name: basename(checkout),
      baseHead: await git("rev-parse", "HEAD"),
      branch,
      leaseId: input.name,
      leaseHolder: `coordinator:${input.name}`,
      leasedAt: new Date().toISOString(),
    },
  });
  await window.terminal.runCommand({
    endpoint,
    cwd: checkout,
    command: [
      "/bin/sh",
      "-c",
      `clear; printf '%s\\n' 'You: Build Tern support.' 'Orchestrator: ${input.name} conversation is ready.'; while IFS= read -r line; do printf 'You: %s\\n' "$line"; printf '%s\\n' "$line" >> '${transcript}'; done`,
    ],
  });
  return { repo, checkout, endpoint, transcript };
}
