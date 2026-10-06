import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeNativeView } from "../../../src/tern-view/file.ts";
import { taskScreenFixture } from "../../tasks/task-screen-fixture.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE_TEST === "1";
type ControlNode = {
  text?: string;
  rect?: [number, number, number, number];
  children?: ControlNode[];
};
(enabled ? test : test.skip)(
  "task screen draws saved progress and guards native restart/steer in an isolated window",
  async () => {
    const root = await mkdtemp("/tmp/tdm-task-proof-");
    const plugin = join(root, "plugin");
    const control = join(root, "w.sock");
    const env = {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.USER,
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      ZDOTDIR: join(root, "zdot"),
      TERN_CONFIG_DIR: join(root, "config"),
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: join(root, "home"),
      STENCIL_LOG_DIR: join(root, "logs"),
    };
    await Promise.all([mkdir(env.ZDOTDIR), mkdir(env.TERN_CONFIG_DIR), mkdir(env.TANDEM_HOME)]);
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    await writeFile(
      join(plugin, "tandem.sh"),
      `#!/bin/sh\nfor arg do printf '%s\\0' "$arg"; done >> '${join(root, "actions.log")}'\nprintf '\\n' >> '${join(root, "actions.log")}'\n`,
    );
    const file = await writeNativeView(env.TANDEM_HOME, {
      version: 1,
      kind: "task",
      revision: "one",
      model: taskScreenFixture(),
    });
    await writeFile(
      join(plugin, "window.luau"),
      `tern.on("window_start", function(cx) cx:new_block("tandem.task", {${JSON.stringify(file)}, "", "", ${JSON.stringify(root)}}, "tab") end)\n`,
    );
    const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
    const run = async (...args: string[]) => {
      const p = Bun.spawn([binary, ...args], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (code !== 0) throw new Error(`Tern ${args.join(" ")}: ${stderr} ${stdout}`);
      return stdout;
    };
    const until = async (fn: () => Promise<boolean>) => {
      const deadline = Date.now() + 15000;
      while (!(await fn().catch(() => false))) {
        if (Date.now() > deadline) {
          await writeFile(join(root, "timeout-tree.json"), await ctl("tree"));
          throw new Error(`Tern timed out; proof files ${root}`);
        }
        await Bun.sleep(50);
      }
    };
    const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      env,
      cwd: root,
      stdout: "ignore",
      stderr: Bun.file(join(root, "daemon.log")),
    });
    let window: ReturnType<typeof Bun.spawn> | undefined;
    const ctl = (...args: string[]) => run("ctl", "--control", control, ...args);
    const tree = async () => JSON.parse(await ctl("tree")) as { tree: ControlNode[] };
    const nodes = (rows: ControlNode[]): ControlNode[] =>
      rows.flatMap((n) => [n, ...nodes(n.children ?? [])]);
    const click = async (label: string) => {
      const row = nodes((await tree()).tree).find((n) => n.text === label && n.rect);
      if (!row?.rect) throw new Error(`Missing ${label}`);
      const [x, y, w, h] = row.rect;
      await ctl("click", String(x + w / 2), String(y + h / 2));
    };
    try {
      await until(async () => {
        await run("ls", "--json");
        return true;
      });
      await run("plugin", "link", plugin, "--json");
      await run("new", "session", "task-proof", "--cwd", root, "--json");
      window = Bun.spawn([binary, "--control", control, "--out", root, "--dir", root], {
        env,
        cwd: root,
        stdout: "ignore",
        stderr: Bun.file(join(root, "window.log")),
      });
      await until(async () => {
        await ctl("state");
        return true;
      });
      await ctl("size", "1280", "900");
      await until(async () => JSON.stringify(await tree()).includes("Fix the close guard"));
      expect(JSON.stringify(await tree())).toContain("round 1 of 2");
      await ctl("shot", "03-task");
      await click("Progress");
      await until(async () => JSON.stringify(await tree()).includes("PASS"));
      await ctl("shot", "03-task-progress");
      await click("Overview");
      await writeNativeView(env.TANDEM_HOME, {
        version: 1,
        kind: "task",
        revision: "two",
        model: taskScreenFixture(true),
      });
      await until(async () => JSON.stringify(await tree()).includes("Restart"));
      await ctl("shot", "03b-task-stuck");
      await click("Restart");
      await until(async () =>
        (await readFile(join(root, "actions.log"), "utf8")).includes("native\0restart\x00102\0"),
      );
      await click("Steer…");
      await ctl("type", JSON.stringify("Try a safer close guard 😀"));
      await ctl("key", "enter");
      await until(async () =>
        (await readFile(join(root, "actions.log"), "utf8")).includes("Try a safer close guard 😀"),
      );
      const log = await readFile(join(root, "actions.log"), "utf8");
      expect(log).toContain(`--cwd\0${root}\0`);
      expect(log).toContain("steer\0--task\x00102\0--text\0Try a safer close guard 😀");
      await writeFile(file, "broken");
      await until(async () => JSON.stringify(await tree()).includes("Actions are disabled"));
      const before = await readFile(join(root, "actions.log"), "utf8");
      await click("Restart");
      await Bun.sleep(300);
      expect(await readFile(join(root, "actions.log"), "utf8")).toBe(before);
      console.log(`Native task proof: ${root}`);
    } finally {
      if (window) {
        await ctl("quit").catch(() => {});
        window.kill();
        await window.exited;
      }
      daemon.kill();
      await daemon.exited;
    }
  },
  45000,
);
