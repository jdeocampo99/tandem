import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeViewText } from "../../../src/board/native-views.ts";
import { nativeScreensFixture } from "../../tern-view/screens-fixture.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE_TEST === "1";
(enabled ? test : test.skip)(
  "native board, usage and catch-up draw live files and shell out once with their exact context",
  async () => {
    const root = await mkdtemp("/tmp/tdm-screens-");
    const plugin = join(root, "plugin");
    const config = join(root, "config");
    const control = join(root, "w.sock");
    const home = join(root, "home");
    const path = join(home, "views.json");
    const log = join(root, "actions.log");
    const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
    const env = {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.USER,
      PATH: process.env.PATH,
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      ZDOTDIR: join(root, "zdot"),
      TERN_CONFIG_DIR: config,
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: home,
      STENCIL_LOG_DIR: join(root, "logs"),
    };
    await Promise.all([mkdir(config), mkdir(home), mkdir(env.ZDOTDIR)]);
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    await writeFile(path, nativeViewText("panel", nativeScreensFixture()), { mode: 0o600 });
    await writeFile(join(plugin, "tandem.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`);
    // Only the isolated copy gains fixture launch commands. Production block implementations stay intact.
    await writeFile(
      join(plugin, "window.luau"),
      `${await readFile(join(plugin, "window.luau"), "utf8")}\n${["board", "usage", "catchup"].map((kind, i) => `tern.bind("ctrl+alt+shift+${["b", "u", "c"][i]}", function(cx)\n cx:new_block("tandem.${kind}", {${JSON.stringify(path)}, "0", ${JSON.stringify(root)}}, "tab")\nend)`).join("\n")}\n`,
    );
    const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      env,
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    let window: ReturnType<typeof Bun.spawn> | undefined;
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
      if (code !== 0) throw new Error(`Tern ${args.join(" ")}: ${stderr}`);
      return stdout;
    };
    const until = async (action: () => Promise<boolean>) => {
      const deadline = Date.now() + 10000;
      while (!(await action().catch(() => false))) {
        if (Date.now() >= deadline) throw new Error("native screens check timed out");
        await Bun.sleep(50);
      }
    };
    const ctl = (...args: string[]) => run("ctl", "--control", control, ...args);
    try {
      await until(async () => {
        await run("ls", "--json");
        return true;
      });
      await run("plugin", "link", plugin, "--json");
      const catalog = JSON.parse(await run("plugin", "list", "--json"));
      expect(
        catalog.plugins.find((p: { id: string }) => p.id === "tandem")?.status,
        JSON.stringify(catalog),
      ).toBe("ready");
      await run("new", "session", "native-screens-check", "--cwd", root, "--json");
      window = Bun.spawn(
        [
          binary,
          "--control",
          control,
          "--dir",
          root,
          "--out",
          process.env.TANDEM_TERN_SHOTS ?? join(root, "shots"),
        ],
        {
          env,
          cwd: root,
          stdout: "ignore",
          stderr: Bun.file(join(root, "window.log")),
        },
      );
      await until(async () => {
        await ctl("state");
        return true;
      });
      const shots = process.env.TANDEM_TERN_SHOTS;
      if (shots) await mkdir(shots, { recursive: true });
      for (const [kind, key, expected] of [
        ["board", "b", "Ready to merge"],
        ["usage", "u", "cost today"],
        ["catchup", "c", "Where we left off"],
      ] as const) {
        await ctl("key", `ctrl+alt+shift+${key}`);
        await until(async () => (await ctl("tree")).includes(expected));
        const tree = await ctl("tree");
        if (kind === "board") {
          expect(tree).toContain("stuck");
          expect(tree).toContain("#281 draft");
          expect(tree).toContain("same 2 problems twice");
        }
        if (kind === "usage") {
          expect(tree).toContain("62% left");
          expect(tree).toContain("2h 14m");
          expect(tree).toContain("$21.40");
        }
        if (shots) {
          await Bun.sleep(200);
          console.log(await ctl("shot", kind));
        }
        await ctl("key", "escape");
        await until(async () =>
          (await readFile(log, "utf8")).includes(
            kind === "catchup" ? "catchup-dismiss" : `${kind}\nback`,
          ),
        );
      }
      const actions = await readFile(log, "utf8");
      expect(actions.match(/--pane/g)?.length).toBe(3);
      expect(actions).toContain(`--cwd\n${root}`);
      // Malformed publication keeps the last good model visible while disabling its actions.
      await writeFile(
        path,
        '{"version":1,"kind":"panel","revision":"broken","model":{"catchup":{"merged":[{}]}}}',
      );
      await until(async () => (await ctl("tree")).includes("View unavailable"));
      expect(await ctl("tree")).toContain("Fix panel width");
      expect(await ctl("tree")).not.toContain("Open what needs me");
    } catch (error) {
      console.error(await readFile(join(root, "window.log"), "utf8").catch(() => ""));
      throw error;
    } finally {
      if (window) {
        await ctl("quit").catch(() => {});
        window.kill();
        await window.exited;
      }
      daemon.kill();
      await daemon.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
