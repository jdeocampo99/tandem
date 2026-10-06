import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { Created, decode, ternCommands } from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";
import { nativeDetailPath } from "../../../src/board/snapshot.ts";
import { createRequestBriefRecord, reviseRequestBriefRecord } from "../../../src/requests/brief.ts";
import { briefView } from "../../../src/requests/native-view.ts";
import { content, NOW } from "../../board/fixtures.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE_TEST === "1";
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
  "native brief comments stay pinned, stale approval toasts, and action files are private and removed",
  async () => {
    const root = await mkdtemp("/tmp/tdm-brief-");
    const config = join(root, "config");
    const plugin = join(root, "plugin");
    const control = join(root, "w.sock");
    const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
    const env = {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.USER,
      PATH: process.env.PATH,
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      TERN_CONFIG_DIR: config,
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: join(root, "home"),
      ZDOTDIR: join(root, "zdot"),
      STENCIL_LOG_DIR: join(root, "logs"),
    };
    await Promise.all([mkdir(config), mkdir(env.TANDEM_HOME), mkdir(env.ZDOTDIR)]);
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    const first = createRequestBriefRecord(
      {
        id: "req-tern",
        repoPath: root,
        content: {
          ...content(
            "Let Tandem launch and manage its coordinator and worker panes in Tern, with the task board shown natively.",
          ),
          summary: {
            title: "Tern terminal backend",
            beforeAfter: [
              {
                moment: "Open a project",
                before: "Tandem opens Herdr.",
                after: "You can choose Tern.",
              },
            ],
            size: { level: "medium", reason: "One new terminal adapter." },
            risk: { level: "low", reason: "Herdr keeps its current behavior." },
          },
          scope: [
            "Tern adapter next to the Herdr adapter",
            "Launch, close and focus panes by task",
            "Raise inbox alerts for needs-you events",
          ],
          nonGoals: ["Removing the Herdr adapter"],
          recommendedApproach: [
            "Add the Tern adapter behind the terminal port",
            "Build native views from saved task data",
          ],
          acceptanceCriteria: [
            "Herdr behavior is unchanged",
            "Brief approval refuses a stale revision",
          ],
          manualVerification: ["A task opens a worker tab in the project session"],
        },
      },
      NOW,
    );
    const second = reviseRequestBriefRecord(
      first,
      {
        ...first.draft.content,
        scope: [
          ...first.draft.content.scope,
          "One Tern session per project; coordinator and workers are tabs",
        ],
      },
      NOW,
    );
    const model = briefView(second, [], "http://127.0.0.1:4387/review");
    const path = nativeDetailPath(env.TANDEM_HOME, root, "brief-req-tern.json");
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const publish = async (revision: string, value = model) =>
      writeFile(path, JSON.stringify({ version: 1, kind: "brief", revision, model: value }), {
        mode: 0o600,
      });
    await publish("fixture-2");
    // Test only: the real renderer shells out to a receipt sink with a scripted stale refusal.
    await writeFile(
      join(plugin, "tandem.sh"),
      `#!/bin/sh
printf '%s\\n' "$@" > '${root}/args.txt'
while [ "$#" -gt 0 ]; do
 if [ "$1" = --input ]; then shift; input=$1; fi
 shift
done
cat "$input" > '${root}/received.json'
stat -f '%Lp' "$input" > '${root}/mode.txt'
printf '%s' "$input" > '${root}/input-path.txt'
if [ -f '${root}/refuse' ]; then echo 'Brief revision is stale; review the latest draft.' >&2; exit 1; fi
`,
    );
    await writeFile(join(root, "refuse"), "stale");
    await writeFile(
      join(root, "conversation.sh"),
      `#!/bin/sh
printf '%s\\n' 'Coordinator · tandem' '' 'You: Add a Tern terminal backend so Tandem can run its panes and board inside Tern.' '' 'Tandem: I drafted the brief and opened it on the right. Comment on any line, or ask me here.' '' 'You: Why only three alert types?' '' 'Tandem: Needs-you, done and stuck are the events that ask you to act. Progress stays in the panel.'
`,
    );
    const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      env,
      cwd: root,
      stdout: "ignore",
      stderr: Bun.file(join(root, "daemon.log")),
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
      if (code !== 0) throw new Error(`Tern ${args.join(" ")}: ${stderr} ${stdout}`);
      return stdout;
    };
    const ctl = (...args: string[]) => run("ctl", "--control", control, ...args);
    const until = async (action: () => Promise<boolean>) => {
      const deadline = Date.now() + 10000;
      while (!(await action().catch(() => false))) {
        if (Date.now() > deadline) throw new Error("isolated brief check timed out");
        await Bun.sleep(70);
      }
    };
    const tree = async () => {
      const parsed = z.object({ tree: z.array(node) }).parse(JSON.parse(await ctl("tree")));
      const flat: ControlNode[] = [];
      const visit = (nodes: ControlNode[]) => {
        for (const each of nodes) {
          flat.push(each);
          visit(each.children ?? []);
        }
      };
      visit(parsed.tree);
      return flat;
    };
    const click = async (target: ControlNode | undefined) => {
      if (!target?.rect) throw new Error("click target missing");
      const [x, y, width, height] = target.rect;
      await ctl("click", String(x + width / 2), String(y + height / 2));
    };
    const clickText = async (text: string) =>
      click((await tree()).find((each) => each.text === text && each.rect));
    try {
      await until(async () => {
        await run("ls", "--json");
        return true;
      });
      await run("plugin", "link", plugin, "--json");
      const created = decode(
        await run("new", "session", "brief-proof", "--cwd", root, "--json"),
        Created,
        "create isolated session",
      );
      window = Bun.spawn(
        [
          binary,
          "--control",
          control,
          "--out",
          process.env.TANDEM_TERN_ARTIFACT_DIR ?? join(root, "shots"),
          "--dir",
          root,
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
      await ctl("resize", "1500", "940");
      await ctl("tabs", "autohide", "on");
      await run("run", created.block, `/bin/sh ${join(root, "conversation.sh")}`);
      const coordinator: Endpoint = {
        terminal: "tern",
        sessionId: "brief-proof",
        terminalSessionId: created.session,
        workspaceId: created.tab,
        tabId: created.tab,
        paneId: created.block,
        role: "coordinator",
        generation: 0,
      };
      const runner: CommandRunner = async (request) => {
        const child = Bun.spawn([...request.argv], {
          env: { ...env, ...request.env },
          cwd: request.cwd,
          stdin: "ignore",
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
      const host = ternViewHost(ternCommands(runner, { binary }), {
        clock: Date.now,
        wait: (ms) => Bun.sleep(ms),
        guard: async (_key, operation) => operation(),
      });
      const opened = await host.open(
        {
          coordinator,
          cwd: root,
          home: env.TANDEM_HOME,
          view: { kind: "brief", requestId: model.requestId },
        },
        root,
        "brief",
        "split",
        path,
      );
      expect(opened.paneId).not.toBe(coordinator.paneId);
      await until(async () =>
        (await tree()).some((each) => each.text?.includes("rev 2 · 1 changes") === true),
      );
      await Bun.sleep(500);
      const lines = (await tree()).filter(
        (each) => each.class?.includes("brief-row") && !each.class.includes("brief-heading"),
      );
      const target = lines[0];
      const plus = target?.children
        ?.flatMap((each) => each.children ?? [])
        .find((each) => each.text === "+");
      if (!plus?.rect) throw new Error("comment gutter missing");
      if (process.env.TANDEM_TERN_ARTIFACT_DIR) {
        await mkdir(process.env.TANDEM_TERN_ARTIFACT_DIR, { recursive: true });
        await ctl("shot", "brief-before");
      }
      await ctl(
        "move",
        String(plus.rect[0] + plus.rect[2] / 2),
        String(plus.rect[1] + plus.rect[3] / 2),
      );
      const freshPlus = (await tree()).find(
        (each) => each.class?.split(" ").includes("tdm-plus") && each.rect && each.rect[1] > 140,
      );
      await click(freshPlus);
      await until(async () => (await tree()).some((each) => each.text === "Comment"));
      await ctl("type", JSON.stringify("Keep Herdr tests unchanged too."));
      await clickText("Comment");
      await until(async () =>
        (await tree()).some((each) => each.text?.includes("Keep Herdr tests") === true),
      );
      await until(async () => (await tree()).some((each) => each.text === "you · pending"));
      await Bun.sleep(400);
      const shots = process.env.TANDEM_TERN_ARTIFACT_DIR;
      if (shots) {
        await mkdir(shots, { recursive: true });
        await ctl("shot", "brief-comment");
      }
      await clickText("Overall comment (optional)");
      await ctl("type", JSON.stringify("Please keep Herdr as an option."));
      await writeFile(
        path,
        JSON.stringify({ version: 999, kind: "brief", revision: "bad", model }),
      );
      await until(async () =>
        (await tree()).some((each) => each.text?.startsWith("Brief unavailable. Actions") === true),
      );
      expect((await tree()).some((each) => each.text === "Approve")).toBe(false);
      await publish("fixture-2");
      await until(async () => (await tree()).some((each) => each.text === "Approve"));
      // A newer model cannot quietly move the pending comment or approval intent to rev 3.
      await publish("fixture-3", {
        ...model,
        revision: 3,
        approval: { ...model.approval, briefRevision: 3 },
      });
      await until(async () =>
        (await tree()).some((each) => each.text?.startsWith("A newer revision") === true),
      );
      await clickText("Approve");
      await until(async () => await Bun.file(join(root, "received.json")).exists());
      expect(JSON.parse(await readFile(join(root, "received.json"), "utf8"))).toEqual(
        model.approval,
      );
      expect((await readFile(join(root, "mode.txt"), "utf8")).trim()).toBe("400");
      const input = await readFile(join(root, "input-path.txt"), "utf8");
      await until(async () => !(await Bun.file(input).exists()));
      await until(async () =>
        (await tree()).some((each) => each.text?.includes("Brief revision is stale") === true),
      );
      if (shots) {
        await Bun.sleep(300);
        await ctl("shot", "brief-stale");
      }
      expect((await tree()).some((each) => each.text?.includes("rev 2 · 1 changes") === true)).toBe(
        true,
      );
      await rm(join(root, "refuse"));
      await clickText("Request changes (1)");
      await until(async () =>
        (await readFile(join(root, "args.txt"), "utf8")).includes("brief-request-changes"),
      );
      expect(JSON.parse(await readFile(join(root, "received.json"), "utf8"))).toEqual({
        ...model.approval,
        text: "Please keep Herdr as an option.",
        comments: [
          {
            lineId: model.lines.find((each) => each.kind !== "heading")?.id,
            text: "Keep Herdr tests unchanged too.",
          },
        ],
      });
      await until(
        async () =>
          !(await Bun.file(await readFile(join(root, "input-path.txt"), "utf8")).exists()),
      );
      await until(
        async () =>
          !(await tree()).some((each) => each.text?.includes("rev 2 · 1 changes") === true),
      );
    } catch (error) {
      console.error(
        (await tree().catch(() => [])).filter((each) => each.text).map((each) => each.text),
      );
      console.error(await readFile(join(root, "daemon.log"), "utf8").catch(() => "no daemon log"));

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
