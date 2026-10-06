import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePrFile } from "../../../src/board/native-views.ts";
import {
  nativeDetailPath,
  nativeViewsPath,
  publishNativeViews,
} from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { Created, decode, ternCommands } from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";
import { followupsFixture } from "../../pr-review/followups-fixture.ts";
import { taskScreenPublication } from "../../tasks/task-screen-fixture.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";
type ControlNode = {
  text?: string;
  rect?: [number, number, number, number];
  children?: ControlNode[];
};
(enabled ? test : test.skip)(
  "PR replies select exact threads and taskless watched PRs remain read-only in an isolated window",
  async () => {
    const otherWindows = Bun.spawn(["pgrep", "-f", "^(/[^ ]*/)?tern --control "], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const processes = await new Response(otherWindows.stdout).text();
    await otherWindows.exited;
    if (processes.trim())
      throw new Error("Another Tern control window is active; wait for the native proof slot");
    const root = await mkdtemp("/tmp/tdm-pr-followups-");
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
      join(plugin, "native-input.sh"),
      `#!/bin/sh
cat >> '${join(root, "actions.jsonl")}'
printf '\n' >> '${join(root, "actions.jsonl")}'
printf '{"posted":true,"url":"https://github.com/owner/repo/pull/281#review-1"}'
`,
    );
    const publication = taskScreenPublication(root, true);
    const review = followupsFixture();
    const taskless = followupsFixture(true);
    const index = nativeViewsPath(env.TANDEM_HOME, root);
    const file = nativeDetailPath(env.TANDEM_HOME, root, nativePrFile("owner/repo", 281));
    const tasklessFile = nativeDetailPath(env.TANDEM_HOME, root, nativePrFile("owner/repo", 282));
    await publishNativeViews(env.TANDEM_HOME, root, async () => ({
      ...publication,
      bundle: {
        ...publication.bundle,
        pullRequests: Object.fromEntries(
          [review, taskless].map((model) => [
            `${model.header.repo}#${model.header.number}`,
            {
              header: model.header,
              readAt: model.readAt,
              detailFile: nativePrFile(model.header.repo, model.header.number),
            },
          ]),
        ),
      },
      details: [
        ...publication.details.filter((d) => d.view.kind !== "pr"),
        ...[review, taskless].map((data) => ({
          file: nativePrFile(data.header.repo, data.header.number),
          view: { version: 1 as const, project: root, kind: "pr" as const, data },
        })),
      ],
    }));
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
    const click = async (label: string, index = 0) => {
      const row = nodes((await tree()).tree).filter((n) => n.text === label && n.rect)[index];
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
        view: { kind: "pr" as const, repo: "owner/repo", number: 281 },
      };
      await host.open(input, root, "panel", "panel", index);
      let opened = await host.open(input, root, "pr", "split", file);
      await writeFile(
        join(root, "opened.json"),
        JSON.stringify({
          opened,
          listing: JSON.parse(await run("ls", "--json")),
          plugins: JSON.parse(await run("plugin", "list", "--json")),
        }),
      );
      await until(async () => JSON.stringify(await tree()).includes("Tern backend adapter"));
      await click("Diff");
      await until(async () =>
        JSON.stringify(await tree()).includes("Keep the exact pane ownership guard"),
      );
      await ctl("shot", "05-pr-threads");
      await click("Reply", 1);
      await ctl("type", JSON.stringify("I will retain this exact guard."));
      await ctl("shot", "05-pr-reply-editor");
      await click("Comment");
      await click("Reply", 2);
      await ctl("type", JSON.stringify("I will cover the removed path too."));
      await ctl("key", "pagedown");
      await click("Comment");
      await ctl("shot", "05-pr-replies-drafted");
      await click("Post");
      await until(async () => {
        try {
          return (await readFile(join(root, "actions.jsonl"), "utf8")).includes("thread-outdated");
        } catch {
          return false;
        }
      });
      const sent = JSON.parse((await readFile(join(root, "actions.jsonl"), "utf8")).trim());
      expect(sent.yours).toEqual([]);
      expect(sent.replies).toEqual([
        {
          threadId: "thread-second",
          commentId: "node-22",
          replyTo: 22,
          body: "I will retain this exact guard.",
        },
        {
          threadId: "thread-outdated",
          commentId: "node-33",
          replyTo: 33,
          body: "I will cover the removed path too.",
        },
      ]);
      opened = await host.open(
        { ...input, view: { kind: "pr", repo: "owner/repo", number: 282 } },
        root,
        "pr",
        "split",
        tasklessFile,
      );
      await until(async () =>
        JSON.stringify(await tree()).includes("Read-only: this watched PR has no Tandem task"),
      );
      await ctl("shot", "05-pr-taskless-description");
      await click("Diff");
      await until(async () =>
        JSON.stringify(await tree()).includes("Keep the exact pane ownership guard"),
      );
      const readonly = nodes((await tree()).tree)
        .map((n) => n.text)
        .filter(Boolean);
      expect(readonly).not.toContain("Reply");
      expect(readonly).not.toContain("Post");
      await ctl("shot", "05-pr-taskless-diff");
      await click("#282 ▾");
      await until(async () => JSON.stringify(await tree()).includes("#282 Watched external PR"));
      await ctl("shot", "05-pr-taskless-switcher");
      expect((await readFile(join(root, "actions.jsonl"), "utf8")).trim()).toBe(
        JSON.stringify(sent),
      );
      console.log(`Native PR followups proof: ${root}`);
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
  60000,
);
