import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { nativeDetailPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { createRequestBriefRecord, reviseRequestBriefRecord } from "../../../src/requests/brief.ts";
import { briefView } from "../../../src/requests/native-view.ts";
import { createRequestBriefStore } from "../../../src/requests/store.ts";
import { RequestBriefWorkflow } from "../../../src/requests/workflow.ts";
import { createTandemService } from "../../../src/service/controller.ts";
import { executeTandemAction } from "../../../src/session/actions.ts";
import { terminalBackend } from "../../../src/terminal-backend/compose.ts";
import { ternCli } from "../../../src/terminal-backend/tern/cli.ts";
import { NativeViewNotOpenedError } from "../../../src/terminal-backend/tern/host.ts";
import { Created, decode } from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";
import { content, NOW } from "../../board/fixtures.ts";

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
  "native brief waits for publication before enabling bound actions, reuses exact identity, and keeps comments pinned",
  async () => {
    const root = await realpath(await mkdtemp("/tmp/tdm-brief-"));
    const repo = join(root, "repo");
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
    await Promise.all([mkdir(config), mkdir(env.TANDEM_HOME), mkdir(env.ZDOTDIR), mkdir(repo)]);
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    const first = createRequestBriefRecord(
      {
        id: "req-tern",
        repoPath: repo,
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
    // Production request briefs have no Lavish page; this fixture has no browser URL either.
    const model = briefView(second);
    const path = nativeDetailPath(env.TANDEM_HOME, repo, "brief-req-tern.json");
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const publish = async (revision: string, value = model) =>
      writeFile(path, JSON.stringify({ version: 1, kind: "brief", revision, model: value }), {
        mode: 0o600,
      });
    // The shared writer and scoped host close run unchanged; durable action effects use a receipt sink.
    await mkdir(join(root, "src", "terminal"), { recursive: true });
    await cp(
      fileURLToPath(new URL("../../../src/terminal/native-input.ts", import.meta.url)),
      join(root, "src", "terminal", "native-input.ts"),
    );
    await writeFile(
      join(root, "src", "main.ts"),
      `import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ternCli } from ${JSON.stringify(fileURLToPath(new URL("../../../src/terminal-backend/tern/cli.ts", import.meta.url)))};
import { ternViewHost } from ${JSON.stringify(fileURLToPath(new URL("../../../src/terminal-backend/tern/views.ts", import.meta.url)))};
import type { CommandRunner, Endpoint } from ${JSON.stringify(fileURLToPath(new URL("../../../src/contracts.ts", import.meta.url)))};
const root = ${JSON.stringify(root)};
const argv = Bun.argv.slice(2);
const input = argv[argv.indexOf("--input") + 1];
if (!argv.includes("--input") || !input) throw new Error("Receipt sink requires --input");
writeFileSync(join(root, "args.txt"), argv.join("\\n") + "\\n");
writeFileSync(join(root, "received.json"), readFileSync(input));
writeFileSync(join(root, "mode.txt"), (statSync(input).mode & 0o777).toString(8));
writeFileSync(join(root, "input-path.txt"), input);
if (existsSync(join(root, "refuse"))) {
  console.error("Brief revision is stale; review the latest draft.");
  process.exitCode = 1;
} else if (existsSync(join(root, "retain"))) {
  console.log(JSON.stringify({warnings: ["The action completed, but the native brief remains open. Do not resubmit this action."]}));
} else {
  const runner: CommandRunner = async (request) => {
    const child = Bun.spawn([...request.argv], {
      cwd: request.cwd, env: { ...process.env, ...request.env },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return {stdout, stderr, code};
  };
  const host = ternViewHost(ternCli(runner, { binary: ${JSON.stringify(binary)} }));
  const coordinator: Endpoint = JSON.parse(readFileSync(join(root, "coordinator.json"), "utf8"));
  const windowId = argv.includes("--window") ? argv[argv.indexOf("--window") + 1] : undefined;
  const closed = await host.close({
    coordinator, cwd: root, home: join(root, "home"),
    origin: {paneId: argv[argv.indexOf("--pane") + 1]!, ...(windowId === undefined ? {} : {windowId})},
    view: {kind: "brief", requestId: argv[2]!},
  }, ${JSON.stringify(repo)});
  console.log(JSON.stringify({warnings: closed.warnings}));
}
`,
    );
    await writeFile(join(root, "refuse"), "stale");
    await writeFile(
      join(root, "conversation.sh"),
      `#!/bin/sh
printf '%s\\n' 'Coordinator · tandem' '' 'You: Add a Tern terminal backend so Tandem can run its panes and board inside Tern.' '' 'Tandem: I drafted the brief and opened it on the right. Comment on any line, or ask me here.' '' 'You: Why only three alert types?' '' 'Tandem: Needs-you, done and stuck are the events that ask you to act. Progress stays in the panel.'
`,
    );
    await writeFile(join(root, "conversation.sh"), "read -r synthetic_reply\n", { flag: "a" });
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
        await run(
          "new",
          "session",
          "brief-proof",
          "--cwd",
          root,
          "--keep-open",
          "--json",
          "--",
          "/bin/sh",
          join(root, "conversation.sh"),
        ),
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
      await writeFile(join(root, "coordinator.json"), JSON.stringify(coordinator));
      await saveCoordinatorRecord(env.TANDEM_HOME, {
        schemaVersion: 1,
        repoPath: repo,
        endpoint: coordinator,
        worktree: {
          root,
          path: root,
          name: "coordinator",
          baseHead: "fixture-head",
          branch: "fixture-coordinator",
          leaseId: "fixture-lease",
          leaseHolder: "coordinator",
          leasedAt: NOW,
        },
        harness: DEFAULT_HARNESS,
        command: ["omp"],
      });
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
      const commands = ternCli(runner, { binary });
      const paneExists = async (id: string) =>
        (await commands.ls(root)).sessions.some((session) =>
          session.tabs.some((tab) => tab.blocks.some((block) => block.id === id)),
        );
      const host = ternViewHost(commands);
      const terminal = terminalBackend(runner, {
        terminal: "tern",
        home: env.TANDEM_HOME,
        tern: { binary },
      });
      // A brief opened during the window's startup tick either opens or fails cleanly with
      // nothing changed; it never pauses the opens below.
      await terminal
        .openView({
          coordinator,
          cwd: root,
          home: env.TANDEM_HOME,
          view: { kind: "brief", requestId: model.requestId },
        })
        .catch((error: unknown) => {
          if (!(error instanceof NativeViewNotOpenedError)) throw error;
        });
      // Tern exposes no startup-ready signal; settle as panel-native does so the opens below
      // test opening, not startup.
      await Bun.sleep(500);
      // A pane may be hosted before either its index or detail is published.
      const waiting = await terminal.openView({
        coordinator,
        cwd: root,
        home: env.TANDEM_HOME,
        view: { kind: "brief", requestId: model.requestId },
      });
      const waitingPane = waiting.endpoint?.paneId;
      if (waitingPane === undefined) throw new Error("Waiting brief identity missing");
      expect(waiting.endpoint).toEqual({ ...coordinator, terminal: "tern", paneId: waitingPane });
      expect(waitingPane).not.toBe(coordinator.paneId);
      const waitingBlock = (await commands.ls(root)).sessions
        .flatMap((session) => session.tabs.flatMap((tab) => tab.blocks))
        .find((block) => block.id === waitingPane);
      expect(waitingBlock?.program).toBe("tandem.brief");
      await until(async () =>
        (await tree()).some((each) => each.text?.startsWith("Loading brief…") === true),
      );
      expect(
        (await tree()).some(
          (each) => each.text === "Approve" || each.text?.startsWith("Request changes"),
        ),
      ).toBe(false);
      if (process.env.TANDEM_TERN_ARTIFACT_DIR) await ctl("shot", "brief-loading");
      // A partial approval triplet cannot make the unpublished brief actionable.
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          kind: "brief",
          revision: "partial",
          model: {
            ...model,
            approval: {
              briefRevision: model.revision,
              contentDigest: model.approval.contentDigest,
            },
          },
        }),
        { mode: 0o600 },
      );
      await Bun.sleep(1200);
      expect(
        (await tree()).some(
          (each) => each.text === "Approve" || each.text?.startsWith("Request changes"),
        ),
      ).toBe(false);
      expect(await Bun.file(join(root, "received.json")).exists()).toBe(false);
      const workflow = new RequestBriefWorkflow({
        home: env.TANDEM_HOME,
        sessionId: coordinator.sessionId,
        parentWorkspaceId: coordinator.workspaceId,
        coordinatorPaneId: coordinator.paneId,
        terminal,
        clock: () => NOW,
        store: createRequestBriefStore({
          home: env.TANDEM_HOME,
          clock: () => NOW,
          idFactory: () => model.requestId,
        }),
        listTasks: async () => [],
        pauseTask: async () => {
          throw new Error("No native fixture tasks");
        },
        checkLanguage: async () => [],
      });
      const projected = await workflow.draft({
        repoPath: repo,
        content: first.draft.content,
        reviewPane: true,
      });
      expect(projected.record.reviewPane?.endpoint).toEqual(waiting.endpoint);
      await until(async () =>
        (await tree()).some((each) => each.text?.includes("rev 1 ·") === true),
      );
      expect((await tree()).some((each) => each.text === "Approve")).toBe(true);
      const updated = await workflow.draft({
        repoPath: repo,
        requestId: model.requestId,
        content: second.draft.content,
        reviewPane: true,
      });
      const opened = { paneId: updated.record.reviewPane?.endpoint.paneId ?? "" };
      expect(opened.paneId).toBe(projected.record.reviewPane?.endpoint.paneId ?? "");
      expect(opened.paneId).not.toBe("");
      expect(
        (await commands.ls(root)).sessions
          .flatMap((session) => session.tabs.flatMap((tab) => tab.blocks))
          .filter((block) => block.program === "tandem.brief"),
      ).toHaveLength(1);
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
      expect((await readFile(join(root, "args.txt"), "utf8")).trim().split("\n")).toEqual([
        "native",
        "brief-approve",
        model.requestId,
        "--input",
        input,
        "--pane",
        String(opened.paneId),
        "--cwd",
        root,
        "--home",
        env.TANDEM_HOME,
      ]);
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
      await writeFile(join(root, "retain"), "successful action, uncertain closure");
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
      await until(async () =>
        (await tree()).some((each) => each.text?.includes("Do not resubmit this action") === true),
      );
      expect((await tree()).some((each) => each.text === "Approve")).toBe(false);
      expect((await tree()).some((each) => each.text === "Request changes (1)")).toBe(false);
      if (shots) await ctl("shot", "brief-completed");
      await clickText("×");
      await until(async () => !(await paneExists(opened.paneId)));
      expect(await paneExists(coordinator.paneId)).toBe(true);
      await rm(join(root, "retain"));
      await publish("fixture-2");
      const reopened = await host.open(
        {
          coordinator,
          cwd: root,
          home: env.TANDEM_HOME,
          view: { kind: "brief", requestId: model.requestId },
        },
        repo,
        "brief",
        "split",
        path,
      );
      await until(async () => (await tree()).some((each) => each.text === "Approve"));
      // Let the newly opened split finish laying out before using control coordinates.
      await Bun.sleep(500);
      await clickText("Approve");
      await until(async () =>
        (await readFile(join(root, "args.txt"), "utf8")).includes(String(reopened.paneId)),
      );
      await until(async () => !(await paneExists(reopened.paneId)));
      await until(
        async () =>
          !(await Bun.file(await readFile(join(root, "input-path.txt"), "utf8")).exists()),
      );
      expect(await paneExists(coordinator.paneId)).toBe(true);
      if (shots) await ctl("shot", "brief-closed");
      expect(JSON.parse(await readFile(join(root, "received.json"), "utf8"))).toEqual(
        model.approval,
      );
      // Conversation approval uses the same scoped retirement as the native action.
      await writeFile(join(env.TANDEM_HOME, "settings.toml"), 'terminal = "tern"\n');
      const service = createTandemService({
        home: env.TANDEM_HOME,
        sessionId: coordinator.sessionId,
        coordinatorPaneId: coordinator.paneId,
        run: runner,
        clock: () => NOW,
      });
      try {
        // Feedback retirement followed by the real coordinator tool action must host a native
        // brief. Repeating that action refreshes the exact same split instead of launching a pager.
        await service.closeRequestBriefReview(model.requestId, model.revision);
        await executeTandemAction({ action: "brief-review", requestId: model.requestId }, service, {
          confirm: undefined,
        });
        const conversationReview = await service.requestBrief(model.requestId);
        const conversationPane = conversationReview.record.reviewPane?.endpoint.paneId;
        if (conversationPane === undefined) throw new Error("Workflow brief pane missing");
        await until(async () => (await tree()).some((each) => each.text === "Approve"));
        await executeTandemAction({ action: "brief-review", requestId: model.requestId }, service, {
          confirm: undefined,
        });
        expect(
          (await service.requestBrief(model.requestId)).record.reviewPane?.endpoint.paneId,
        ).toBe(conversationPane);
        const briefBlocks = (await commands.ls(root)).sessions
          .flatMap((session) => session.tabs.flatMap((tab) => tab.blocks))
          .filter((block) => block.program === "tandem.brief");
        expect(briefBlocks.map((block) => block.id)).toEqual([conversationPane]);
        if (shots) await ctl("shot", "brief-coordinator-review");
        const approved = await service.approveRequestBrief({
          requestId: model.requestId,
          ...model.approval,
        });
        expect(approved.approvalState).toBe("current");
        expect(approved.record.reviewPane?.status).toBe("closed");
        expect(await paneExists(conversationPane)).toBe(false);
        expect(await paneExists(coordinator.paneId)).toBe(true);
      } finally {
        await service.shutdown();
      }
      if (shots) {
        await Bun.sleep(1000);
        await ctl("shot", "brief-workflow-closed");
      }
    } catch (error) {
      if (process.env.TANDEM_TERN_ARTIFACT_DIR) await ctl("shot", "brief-failed").catch(() => {});
      console.error(
        "Last CLI argv",
        await readFile(join(root, "args.txt"), "utf8").catch(() => "none"),
      );
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
