import { expect, test } from "bun:test";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeViewText } from "../../src/board/native-views.ts";
import { prPaneView } from "../../src/pr-review/native-view.ts";

const TERN_BINARY = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";

// Opt in on a machine with Tern. No window or user's daemon is needed for the host VM checks.
(enabled ? test : test.skip)(
  "PR comments, review submission and stale display guards in Tern's Luau VM",
  async () => {
    const root = await mkdtemp("/tmp/tdm-view-");
    const config = join(root, "config");
    const plugin = join(root, "plugin");
    const env = {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.USER,
      PATH: process.env.PATH,
      SHELL: "/bin/zsh",
      TERN_CONFIG_DIR: config,
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      STENCIL_LOG_DIR: join(root, "logs"),
      ZDOTDIR: join(root, "zdot"),
      TANDEM_HOME: join(root, "home"),
    };
    await mkdir(join(config, "plugins"), { recursive: true });
    await mkdir(plugin);
    await mkdir(env.ZDOTDIR);
    await mkdir(env.TANDEM_HOME);
    for (const name of [
      "text-field",
      "view-file",
      "diff-row",
      "components",
      "pr-model",
      "pr-diff",
      "pr-content",
    ]) {
      await copyFile(
        fileURLToPath(new URL(`../../tern-plugin/${name}.luau`, import.meta.url)),
        join(plugin, `${name}.luau`),
      );
    }
    await copyFile(
      fileURLToPath(new URL("./tern-pr.luau", import.meta.url)),
      join(plugin, "host.luau"),
    );
    await writeFile(
      join(plugin, "plugin.toml"),
      'schema = 1\nid = "tandem-view-test"\nname = "Tandem view helper checks"\nversion = "0.0.1"\nhost = "host.luau"\n',
    );
    await writeFile(
      join(plugin, "fixture.json"),
      nativeViewText(
        "pr",
        prPaneView({
          taskId: "task-98",
          cached: {
            repo: "acme/app",
            number: 281,
            title: "Port",
            url: "https://github.com/acme/app/pull/281",
            head: "abc123",
            draft: true,
            body: "## What\n\nPort",
            commits: 1,
            additions: 2,
            deletions: 0,
            readAt: "2030-01-01T12:00:00Z",
            checks: [],
            threads: [],
            conversation: [],
            tour: [],
            patch:
              "diff --git a/port.ts b/port.ts\n--- a/port.ts\n+++ b/port.ts\n@@ -1,0 +1,2 @@\n+const port = true;\n+export { port };\n",
          },
        }),
      ),
    );
    await copyFile(join(plugin, "fixture.json"), join(plugin, "pr-fixture.json"));
    await writeFile(join(plugin, "task-path.txt"), join(plugin, "task-task-98.json"));
    const daemon = Bun.spawn([TERN_BINARY, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      env,
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
    });
    const run = async (...args: string[]) => {
      const child = Bun.spawn([TERN_BINARY, ...args], {
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
      return { stdout, stderr, code };
    };
    try {
      const start = Date.now();
      while ((await run("ls", "--json")).code !== 0) {
        if (Date.now() - start > 10000) throw new Error("isolated Tern daemon did not start");
        await Bun.sleep(50);
      }
      const linked = await run("plugin", "link", plugin, "--json");
      expect(linked.code, linked.stderr).toBe(0);
      const listed = await run("plugin", "list", "--json");
      expect(JSON.parse(listed.stdout).plugins[0].status).toBe("ready");
      expect(JSON.parse(await readFile(join(plugin, "results.json"), "utf8"))).toEqual({
        comment: true,
        review: true,
        stale: true,
        reuse: true,
      });
      const production = join(root, "tandem-plugin");
      await cp(fileURLToPath(new URL("../../tern-plugin", import.meta.url)), production, {
        recursive: true,
      });
      const installed = await run("plugin", "link", production, "--json");
      expect(installed.code, installed.stderr).toBe(0);
      const catalog = await run("plugin", "list", "--json");
      const shared = JSON.parse(catalog.stdout).plugins.find(
        (entry: { id: string }) => entry.id === "tandem",
      );
      expect(shared).toMatchObject({ status: "ready", host: true, window: true });
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
