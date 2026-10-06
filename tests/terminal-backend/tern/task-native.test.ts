import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeTaskFile, nativeViewText } from "../../../src/board/native-views.ts";
import {
  nativeDetailPath,
  nativeViewsPath,
  publishNativeViews,
} from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import {
  blocks,
  Created,
  decode,
  ternCommands,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";
import { taskScreenFixture, taskScreenPublication } from "../../tasks/task-screen-fixture.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";
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
      `#!/bin/sh\nfor arg do printf '%s\\0' "$arg"; done >> '${join(root, "actions.log")}'\nprintf '\\n' >> '${join(root, "actions.log")}'\nfor arg do if [ "$arg" = 'Reject this direction' ]; then printf 'Direction refused by saved task policy' >&2; exit 7; fi; done\n`,
    );
    const publication = taskScreenPublication(root);
    await publishNativeViews(env.TANDEM_HOME, publication.bundle.project, async () => publication);
    const file = nativeDetailPath(env.TANDEM_HOME, root, nativeTaskFile("102"));
    const index = nativeViewsPath(env.TANDEM_HOME, root);
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
      const created = decode(
        await run("new", "session", "task-proof", "--cwd", root, "--json"),
        Created,
        "isolated test session",
      );
      const endpoint: Endpoint = {
        terminal: "tern",
        sessionId: "task-proof",
        terminalSessionId: created.session,
        workspaceId: created.tab,
        tabId: created.tab,
        paneId: created.block,
        role: "coordinator",
        generation: 0,
      };
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
      await ctl("size", "1500", "950");
      const commandRunner: CommandRunner = async (request) => {
        const child = Bun.spawn([...request.argv], {
          env,
          cwd: request.cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, code };
      };
      const host = ternViewHost(
        ternCommands(commandRunner, {
          binary,
          environment: Object.fromEntries(
            Object.entries(env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        }),
        { clock: Date.now, wait: Bun.sleep, guard: async (_key, fn) => fn() },
      );
      const input = {
        coordinator: endpoint,
        cwd: root,
        home: env.TANDEM_HOME,
        view: { kind: "task" as const, taskId: "102" },
      };
      await host.open(input, root, "panel", "panel", index);
      let opened = await host.open(input, root, "task", "task", file);
      const launched = blocks(await ternCommands(commandRunner, { binary }).ls(root)).find(
        (entry) => entry.block.id === opened.paneId,
      );
      expect(launched?.block.args).toEqual([file, endpoint.paneId, root, "", index]);
      await until(async () => JSON.stringify(await tree()).includes("Fix the close guard"));
      expect(JSON.stringify(await tree())).toContain("round 1 of 2");
      await ctl("shot", "03-task");
      await click("Progress");
      await until(async () => JSON.stringify(await tree()).includes("PASS"));
      expect(JSON.stringify(await tree())).toContain("FAIL");
      expect(JSON.stringify(await tree())).toContain("adapter.ts:12");
      await ctl("shot", "03-task-progress");
      await click("Overview");
      await click("Brief");
      await until(async () =>
        JSON.stringify(await tree()).includes("Preserve the live coordinator"),
      );
      await ctl("shot", "03-task-brief");
      await click("Diff");
      await until(async () => JSON.stringify(await tree()).includes("const terminal = tern();"));
      await ctl("shot", "03-task-diff");
      await click("PR");
      await until(async () => JSON.stringify(await tree()).includes("exact pane ownership"));
      await ctl("shot", "03-task-pr");
      await publishNativeViews(env.TANDEM_HOME, root, async () =>
        taskScreenPublication(root, true),
      );
      await until(async () => JSON.stringify(await tree()).includes("Reopen this PR"));
      expect(JSON.stringify(await tree())).toContain("PR changed or view unavailable");
      opened = await host.open(
        { ...input, origin: { paneId: opened.paneId, cwd: root } },
        root,
        "task",
        "task",
        file,
      );
      await until(async () => JSON.stringify(await tree()).includes("Fix the close guard"));
      await click("PR");
      await until(async () => JSON.stringify(await tree()).includes("Overall review…"));
      expect(JSON.stringify(await tree())).toContain("Post");
      expect(JSON.stringify(await tree())).toContain("Reviewed commit abc123");
      await ctl("shot", "03-task-pr-review");
      await click("Cost");
      await until(async () => JSON.stringify(await tree()).includes("Usage receipt"));
      expect(JSON.stringify(await tree())).toContain("Additional charges · unavailable");
      await ctl("shot", "03-task-cost");
      await click("Overview");
      await writeFile(file, nativeViewText("task", taskScreenFixture(true)));
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
      expect(log).toContain(`--home\0${env.TANDEM_HOME}\0`);
      expect(log).toContain("steer\0--task\x00102\0--text\0Try a safer close guard 😀");
      await click("Steer…");
      await ctl("type", JSON.stringify("Reject this direction"));
      await ctl("key", "enter");
      await until(async () =>
        JSON.stringify(await tree()).includes("Direction refused by saved task policy"),
      );
      await ctl("shot", "03-task-action-error");
      const failed = await readFile(join(root, "actions.log"), "utf8");
      expect(failed.split("Reject this direction")).toHaveLength(2);
      expect(JSON.stringify(await tree())).toContain("Reject this direction");
      await Bun.sleep(300);
      expect(await readFile(join(root, "actions.log"), "utf8")).toBe(failed);
      await writeFile(file, "broken");
      await until(async () => JSON.stringify(await tree()).includes("Actions are disabled"));
      const before = await readFile(join(root, "actions.log"), "utf8");
      await click("Restart");
      await Bun.sleep(300);
      expect(await readFile(join(root, "actions.log"), "utf8")).toBe(before);
      const floatingPicker = await host.open(
        { ...input, origin: { paneId: opened.paneId, cwd: root }, view: { kind: "task-picker" } },
        root,
        "task-picker",
        "split",
        index,
      );
      await until(async () => JSON.stringify(await tree()).includes("Search tasks"));
      await click("Cancel");
      await host.open(
        { ...input, origin: { paneId: floatingPicker.paneId, cwd: root } },
        root,
        "panel",
        "return",
        index,
      );
      const afterCancel = await ternCommands(commandRunner, { binary }).ls(root);
      expect(
        afterCancel.sessions[0]?.tabs[0]?.blocks.some((b) => b.id === floatingPicker.paneId),
      ).toBe(false);
      expect(afterCancel.sessions[0]?.tabs[0]?.blocks.some((b) => b.id === opened.paneId)).toBe(
        true,
      );
      await writeFile(file, nativeViewText("task", taskScreenFixture()));
      const previous = opened;
      opened = await host.open(
        { ...input, origin: { paneId: previous.paneId, cwd: root } },
        root,
        "task",
        "task",
        file,
      );
      const replaced = await ternCommands(commandRunner, { binary }).ls(root);
      expect(replaced.sessions[0]?.tabs[0]?.blocks.some((b) => b.id === previous.paneId)).toBe(
        false,
      );
      expect(replaced.sessions[0]?.tabs[0]?.blocks.some((b) => b.id === endpoint.paneId)).toBe(
        true,
      );
      await until(async () => JSON.stringify(await tree()).includes("Fix the close guard"));
      await click("← Orchestrator");
      await until(async () =>
        (await readFile(join(root, "actions.log"), "utf8")).includes("#orchestrator"),
      );
      await host.open(
        { ...input, origin: { paneId: opened.paneId, cwd: root } },
        root,
        "panel",
        "return",
        index,
      );
      const restored = await ternCommands(commandRunner, { binary }).ls(root);
      expect(restored.sessions[0]?.tabs[0]?.blocks.some((b) => b.id === endpoint.paneId)).toBe(
        true,
      );
      expect(restored.sessions[0]?.tabs[0]?.blocks.some((b) => b.id === opened.paneId)).toBe(false);
      const picker = await host.open(
        { ...input, view: { kind: "task-picker" } },
        root,
        "task-picker",
        "split",
        index,
      );
      await until(async () => JSON.stringify(await tree()).includes("Search tasks"));
      await ctl("type", JSON.stringify("Tern"));
      await ctl("shot", "03-task-picker");
      await ctl("key", "enter");
      await until(async () =>
        (await readFile(join(root, "actions.log"), "utf8")).includes("native\0open\0task\x00102"),
      );
      expect(picker.paneId).not.toBe(endpoint.paneId);
      await until(async () => {
        const all = await ternCommands(commandRunner, { binary }).ls(root);
        return !all.sessions[0]?.tabs[0]?.blocks.some((b) => b.id === picker.paneId);
      });
      const missing = await host.open(
        { ...input, view: { kind: "task", taskId: "103" } },
        root,
        "task",
        "task",
        nativeDetailPath(env.TANDEM_HOME, root, nativeTaskFile("103")),
      );
      await until(async () => JSON.stringify(await tree()).includes("Task unavailable"));
      await click("← Orchestrator");
      await host.open(
        { ...input, origin: { paneId: missing.paneId, cwd: root } },
        root,
        "panel",
        "return",
        index,
      );

      const empty = taskScreenFixture(false, false);
      await publishNativeViews(env.TANDEM_HOME, root, async () => ({
        ...publication,
        bundle: { ...publication.bundle, briefs: {}, pullRequests: {} },
        details: [
          {
            file: nativeTaskFile("102"),
            view: { version: 1, project: root, kind: "task", data: empty },
          },
        ],
      }));
      await host.open(input, root, "task", "task", file);
      await until(async () => JSON.stringify(await tree()).includes("Fix the close guard"));
      const beforeEmpty = await readFile(join(root, "actions.log"), "utf8");
      await click("Brief");
      await until(async () => JSON.stringify(await tree()).includes("No brief is linked"));
      expect(JSON.stringify(await tree())).not.toContain("Open brief");
      await ctl("shot", "03-task-no-brief");
      await click("PR");
      await until(async () =>
        JSON.stringify(await tree()).includes("No pull request is available yet"),
      );
      await ctl("shot", "03-task-no-pr");
      expect(await readFile(join(root, "actions.log"), "utf8")).toBe(beforeEmpty);

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
