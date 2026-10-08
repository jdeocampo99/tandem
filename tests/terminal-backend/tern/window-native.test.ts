import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  configureTernPluginSettings,
  restoreTernPluginSettings,
} from "../../../src/terminal-backend/tern/plugin.ts";
import { launchTernWindow, recordedActions, recordingCli } from "./native-window.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";
type ControlNode = {
  text?: string | undefined;
  class?: string | undefined;
  rect?: [number, number, number, number] | undefined;
  children?: ControlNode[] | undefined;
};
const node: z.ZodType<ControlNode> = z.lazy(() =>
  z.object({
    text: z.string().optional(),
    class: z.string().optional(),
    rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    children: z.array(node).optional(),
  }),
);

(enabled ? test : test.skip)(
  "isolated window keeps nine palette commands and consented project keys; real schema accepts tmux",
  async () => {
    const root = await mkdtemp("/tmp/tdm-window-native-");
    const config = join(root, "config");
    const plugin = join(root, "plugin");
    const control = join(root, "w.sock");
    const binary = "/Applications/Tern.app/Contents/MacOS/tern";
    const env = {
      HOME: process.env.HOME,
      USER: process.env.USER ?? "tandem-test",
      PATH: process.env.PATH,
      SHELL: "/bin/zsh",
      LOGNAME: process.env.USER ?? "tandem-test",
      TERM: "xterm-256color",
      ZDOTDIR: join(root, "zdot"),
      TERN_CONFIG_DIR: config,
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: join(root, "home"),
      STENCIL_LOG_DIR: join(root, "logs"),
    };
    await Promise.all([mkdir(config), mkdir(env.ZDOTDIR), mkdir(env.TANDEM_HOME)]);
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    await writeFile(join(plugin, "tandem.sh"), recordingCli(join(root, "actions.log")));
    // Read only schema metadata and the synthetic keymap, never the whole environment/settings tree.
    await writeFile(
      join(plugin, "window.luau"),
      `${await readFile(join(plugin, "window.luau"), "utf8")}\ntern.on("window_start", function()\n tern.timer(50, function(cx)\n  if not cx then return end\n  tern.fs.write("${join(root, "schema.json")}", tern.json.encode({description=cx.settings:describe("keymap"), keymap=cx.settings:get("keymap")}))\n end)\nend)\n`,
    );
    const prefs = join(config, "settings.json");
    // Starting a test window turns auto update off in these settings, so the user's own carry it.
    const original = '{"keybinds":{"cmd+shift+b":"palette"},"auto_update":false}';
    await writeFile(prefs, original);
    const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      env,
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    let window: Bun.Subprocess | undefined;
    const run = async (...args: string[]) => {
      const child = Bun.spawn([binary, ...args], {
        env,
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 5000);
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(timer);
      if (code !== 0) throw new Error(`Tern ${args[0]}: ${stderr}`);
      return stdout;
    };
    const until = async (action: () => Promise<boolean>) => {
      const deadline = Date.now() + 10_000;
      while (!(await action().catch(() => false))) {
        if (Date.now() >= deadline) throw new Error("isolated Tern window check timed out");
        await Bun.sleep(50);
      }
    };
    const open = async () => {
      window = await launchTernWindow({
        binary,
        control,
        args: ["--dir", root],
        env,
        cwd: root,
        log: join(root, "window.log"),
      });
      await until(() => Bun.file(join(root, "schema.json")).exists());
      await Bun.sleep(300);
    };
    const close = async () => {
      await run("ctl", "--control", control, "quit");
      window?.kill();
      await window?.exited;
      window = undefined;
      await rm(join(root, "schema.json"), { force: true });
    };
    try {
      await until(async () => {
        await run("ls", "--json");
        return true;
      });
      await run("plugin", "link", plugin, "--json");
      await run("new", "session", "tandem-window-check", "--cwd", root, "--json");
      await open();
      const schema = z
        .object({
          description: z.object({
            type: z.string(),
            default: z.string(),
            enum: z.array(z.string()),
          }),
          keymap: z.string(),
        })
        .parse(JSON.parse(await readFile(join(root, "schema.json"), "utf8")));
      expect(schema.description).toEqual({
        type: "enum",
        default: "tern",
        enum: ["tern", "ghostty", "kitty", "cmux", "tmux"],
      });
      await run("ctl", "--control", control, "palette");
      const tree = z
        .object({ tree: z.array(node) })
        .parse(JSON.parse(await run("ctl", "--control", control, "tree")));
      const rows: ControlNode[] = [];
      const visit = (nodes: ControlNode[]) => {
        for (const each of nodes) {
          if (
            each.class?.split(" ").includes("ck-item") &&
            each.children?.some((child) => child.text?.startsWith("Tandem:"))
          )
            rows.push(each);
          visit(each.children ?? []);
        }
      };
      visit(tree.tree);
      expect(
        rows
          .flatMap(
            (row) =>
              row.children?.flatMap((child) =>
                child.text?.startsWith("Tandem:") ? [child.text] : [],
              ) ?? [],
          )
          .sort(),
      ).toEqual(
        [
          "Tandem: New request…",
          "Tandem: Quick task…",
          "Tandem: Open task…",
          "Tandem: Show PRs",
          "Tandem: Toggle board",
          "Tandem: Usage",
          "Tandem: Settings",
          "Tandem: Change models",
          "Tandem: Add or edit repositories",
        ].sort(),
      );
      const board = rows.find((row) =>
        row.children?.some((child) => child.text === "Tandem: Toggle board"),
      )?.rect;
      if (!board) throw new Error("board palette row missing");
      await run(
        "ctl",
        "--control",
        control,
        "click",
        String(board[0] + board[2] / 2),
        String(board[1] + board[3] / 2),
      );
      const sent = () => recordedActions(join(root, "actions.log"));
      await until(async () =>
        (await sent()).some(({ action }) => action.verb === "open" && action.ref.kind === "board"),
      );
      expect(await readFile(prefs, "utf8")).toBe(original);
      await close();
      await restoreTernPluginSettings({ path: prefs });
      await configureTernPluginSettings({ path: prefs });
      await open();
      await run("ctl", "--control", control, "key", "cmd+1");
      await until(async () =>
        (await sent()).some(({ action }) => action.verb === "project" && action.target === 1),
      );
      expect(JSON.parse(await readFile(prefs, "utf8")).keybinds["cmd+shift+b"]).toBe("palette");
      await close();
      await restoreTernPluginSettings({ path: prefs });
      expect(JSON.parse(await readFile(prefs, "utf8"))).toEqual(JSON.parse(original));
      await writeFile(prefs, '{"keymap":"tmux"}');
      await open();
      expect(JSON.parse(await readFile(join(root, "schema.json"), "utf8")).keymap).toBe("tmux");
      await close();
    } catch (error) {
      console.error(await readFile(join(root, "window.log"), "utf8").catch(() => ""));
      throw error;
    } finally {
      if (window) {
        await run("ctl", "--control", control, "quit").catch(() => {});
        window.kill();
        await window.exited;
      }
      daemon.kill();
      await daemon.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
