import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBriefFile, nativeViewText } from "../../../src/board/native-views.ts";
import { nativeDetailPath, nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import {
  ternBackend,
  ternNotificationEndpoint,
} from "../../../src/terminal-backend/tern/backend.ts";
import {
  blocks,
  TernOutcomeUnknownError,
  ternCommands,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { ternViewHost } from "../../../src/terminal-backend/tern/views.ts";
import { nativeScreensFixture } from "../../tern-view/screens-fixture.ts";
import { panelFixture } from "./panel-fixture.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE_TEST === "1";
(enabled ? test : test.skip)(
  "isolated native panel, switcher, preserved task layout and three OSC inbox alerts",
  async () => {
    const root = await realpath(await mkdtemp("/tmp/tandem-panel-proof-"));
    const home = await realpath(await mkdtemp("/tmp/tandem-panel-home-"));
    const config = join(root, "config"),
      plugin = join(root, "plugin"),
      control = join(root, "w.sock");
    const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
    const env = {
      HOME: root,
      USER: "tandem-test",
      LOGNAME: "tandem-test",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      ZDOTDIR: join(root, "zdot"),
      TERN_CONFIG_DIR: config,
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: home,
      STENCIL_LOG_DIR: join(root, "logs"),
    };
    await Promise.all([mkdir(config), mkdir(env.ZDOTDIR), mkdir(join(root, "shots"))]);
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({ tabs_autohide: true, layout: "rail", link_target: "Tern" }),
    );
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    // A synthetic CLI records action argv; this proof never reaches the user's task store or GitHub.
    await writeFile(
      join(plugin, "tandem.sh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${join(root, "actions.log")}'\nif [ "$2" = "usage" ]; then printf 'fixture action refused\\n' >&2; exit 7; fi\n`,
    );
    // Task layout fixture; the registered board renderer is exercised through the real host.
    await writeFile(
      join(plugin, "layout-fixture.luau"),
      'return {init=function(cx,args) return {} end, key=function(state,key,cx) if key.name=="escape" then cx:exit(0); return true end; return false end, title=function() return "Layout fixture" end, view=function() return {main=tern.ui.col({tern.ui.text({tern.ui.span("Layout fixture")})})} end}',
    );
    await writeFile(
      join(plugin, "host.luau"),
      (await readFile(join(plugin, "host.luau"), "utf8"))
        .replace('require("./task")', 'require("./layout-fixture")')
        .replace('require("./brief")', 'require("./layout-fixture")'),
    );
    const run: CommandRunner = async (request) => {
      const child = Bun.spawn([...request.argv], {
        cwd: request.cwd,
        env: { ...env, ...request.env },
        timeout: request.timeoutMs ?? 8000,
        killSignal: "SIGKILL",
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
    const ctl = async (...args: string[]) => {
      const result = await run({ argv: [binary, "ctl", "--control", control, ...args], cwd: root });
      if (result.code !== 0) throw new Error(result.stderr);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 15000;
      while (!(await check().catch(() => false))) {
        if (Date.now() > deadline) throw new Error("native proof timed out");
        await Bun.sleep(100);
      }
    };
    const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      env,
      cwd: root,
      stdout: "ignore",
      stderr: Bun.file(join(root, "daemon.log")),
    });
    // The native-slot wrapper can stop only these exact owned processes on abort.
    console.log(
      `Native proof process: ${JSON.stringify({ pid: daemon.pid, argv: [binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET] })}`,
    );
    let window: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await until(
        async () => (await run({ argv: [binary, "ls", "--json"], cwd: root })).code === 0,
      );
      const linked = await run({ argv: [binary, "plugin", "link", plugin, "--json"], cwd: root });
      expect(linked.stderr).toBe("");
      const terminal = ternBackend(run, { home, environment: env });
      const created = await terminal.createWorkspace({
        sessionId: "fixture",
        cwd: root,
        role: "coordinator",
        generation: 0,
        label: "coordinator · tandem",
      });
      const coordinator = created.endpoint;
      window = Bun.spawn(
        [binary, "--control", control, "--dir", root, "--out", join(root, "shots")],
        { env, cwd: root, stdout: "ignore", stderr: Bun.file(join(root, "window.log")) },
      );
      console.log(
        `Native proof process: ${JSON.stringify({ pid: window.pid, argv: [binary, "--control", control, "--dir", root, "--out", join(root, "shots")] })}`,
      );
      await until(async () => {
        await ctl("state");
        return true;
      });
      await ctl("account", "signed-in");
      await Bun.sleep(500);
      await mkdir(join(home, "native-views"));
      const path = nativeViewsPath(home, root);
      const panel = panelFixture(root);
      await writeFile(
        path,
        nativeViewText("panel", {
          version: 1,
          project: root,
          writtenAt: new Date().toISOString(),
          summary: {},
          panel,
          projects: panel.header.projects,
          tasks: {},
          briefs: {},
          pullRequests: {},
          board: nativeScreensFixture().board,
          usage: nativeScreensFixture().usage,
          catchup: nativeScreensFixture().catchup,
          warnings: [],
        }),
      );
      await terminal.runCommand({
        endpoint: coordinator,
        cwd: root,
        command: [
          "/bin/sh",
          "-c",
          'clear; printf "%s\\n" "You: Add a Tern terminal backend so Tandem can run its panes and board inside Tern." "" "Orchestrator: I drafted a brief covering the adapter, pane launch, and the board." "Nothing starts until you approve it." "" "You: Looks right, I will read the brief."; while IFS= read -r answer; do :; done',
        ],
      });
      let mutationCount = 0;
      let failListing = false;
      const uncertain = ternBackend(
        async (request) => {
          if (failListing && request.argv[1] === "ls") {
            failListing = false;
            return { code: 1, stdout: "", stderr: "injected post-open verification failure" };
          }
          const result = await run(request);
          if (request.argv[1] === "open") {
            mutationCount++;
            failListing = true;
          }
          return result;
        },
        { home, environment: env },
      );
      const panelInput = { coordinator, cwd: root, project: root };
      await expect(uncertain.openPanel(panelInput)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
      expect(await uncertain.openPanel(panelInput)).toBeDefined();
      expect(mutationCount).toBe(1);
      const pane = await terminal.openPanel(panelInput);
      const fresh = ternBackend(run, { home, environment: env });
      expect(await fresh.openPanel(panelInput)).toBe(pane);
      expect(
        blocks(await ternCommands(run, { environment: env }).ls(root)).filter(
          (entry) =>
            entry.block.program === "tandem.panel" && entry.block.args?.[1] === coordinator.paneId,
        ),
      ).toHaveLength(1);
      expect(await terminal.isPanelOpen({ coordinator, cwd: root, panelPaneId: pane })).toBe(true);
      await until(async () => JSON.stringify(await ctl("tree")).includes("Tern backend adapter"));
      await ctl("shot", "01-panel");
      const tree = await ctl("tree");
      type Node = { class?: string; rect?: number[]; children?: Node[] };
      const visit = (nodes: Node[], className = "tdp-switch"): Node | undefined => {
        for (const node of nodes) {
          if (node.class?.split(" ").includes(className)) return node;
          const found = visit(node.children ?? [], className);
          if (found) return found;
        }
        return undefined;
      };
      const switcher = visit(tree.tree as Node[])?.rect;
      if (!switcher) throw new Error("switcher missing");
      await ctl("click", String((switcher[0] ?? 0) + 10), String((switcher[1] ?? 0) + 7));
      await until(async () => JSON.stringify(await ctl("tree")).includes("+ Open another project"));
      await ctl("shot", "02-projects");
      await ctl("key", "escape");
      const envelope = JSON.parse(await readFile(path, "utf8")) as {
        model: Record<string, unknown>;
      };
      await writeFile(
        path,
        nativeViewText("panel", {
          ...envelope.model,
          panel: { ...panel, footer: undefined },
        }),
      );
      await until(async () => !JSON.stringify(await ctl("tree")).includes("⌘⇧B board"));
      const declined = JSON.stringify(await ctl("tree"));
      expect(declined).toContain("⎇");
      expect(declined).toContain("▦");
      const row = visit((await ctl("tree")).tree as Node[], "tdp-row")?.rect;
      if (!row) throw new Error("task row missing");
      await ctl("click", String((row[0] ?? 0) + 80), String((row[1] ?? 0) + 12));
      await until(async () =>
        (await readFile(join(root, "actions.log"), "utf8")).includes("brief\ntern"),
      );
      const argv = await readFile(join(root, "actions.log"), "utf8");
      expect(argv).toContain(
        `native\nopen\nbrief\ntern\n--home\n${home}\n--pane\n${pane}\n--cwd\n${root}`,
      );
      await ctl("key", "down");
      await ctl("key", "enter");
      await until(async () =>
        (await readFile(join(root, "actions.log"), "utf8")).includes("open\ntask\nadapter"),
      );
      expect(await readFile(join(root, "actions.log"), "utf8")).toContain(
        "native\nopen\ntask\nadapter",
      );

      const limit = visit((await ctl("tree")).tree as Node[], "tdp-limit")?.rect;
      if (!limit) throw new Error("usage button missing");
      await ctl("click", String((limit[0] ?? 0) + 30), String((limit[1] ?? 0) + 5));
      await until(async () => JSON.stringify(await ctl("tree")).includes("fixture action refused"));
      expect(JSON.stringify(await ctl("tree"))).toContain("Tandem couldn't run that action");
      // Busy conversation must survive task replacement and return with exactly the same endpoint.
      const host = ternViewHost(ternCommands(run, { environment: env }), {
        clock: Date.now,
        wait: Bun.sleep,
        guard: async (_key, operation) => operation(),
      });
      const brief = await host.open(
        { coordinator, cwd: root, home, view: { kind: "brief", requestId: "req-native" } },
        root,
        "brief",
        "split",
        nativeDetailPath(home, root, nativeBriefFile("req-native")),
      );
      await ctl("key", "escape");
      await Bun.sleep(200);
      const exited = blocks(await ternCommands(run, { environment: env }).ls(root)).find(
        (entry) => entry.block.id === brief.paneId,
      );
      expect(exited).toBeUndefined();
      expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
        true,
      );
      await ctl("shot", "04-exited-brief");
      expect(
        await host.close(
          {
            coordinator,
            cwd: root,
            home,
            origin: { paneId: brief.paneId },
            view: { kind: "brief", requestId: "req-native" },
          },
          root,
        ),
      ).toEqual({ closed: true, warnings: [] });
      const reopened = await host.open(
        { coordinator, cwd: root, home, view: { kind: "brief", requestId: "req-native" } },
        root,
        "brief",
        "split",
        nativeDetailPath(home, root, nativeBriefFile("req-native")),
      );
      expect(
        await host.close(
          {
            coordinator,
            cwd: root,
            home,
            origin: { paneId: reopened.paneId },
            view: { kind: "brief", requestId: "req-native" },
          },
          root,
        ),
      ).toEqual({ closed: true, warnings: [] });
      expect(
        blocks(await ternCommands(run, { environment: env }).ls(root)).some(
          (entry) => entry.block.id === reopened.paneId,
        ),
      ).toBe(false);
      expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
        true,
      );
      const task = await host.open(
        { coordinator, cwd: root, home, view: { kind: "task", taskId: "adapter" } },
        root,
        "task",
        "task",
        path,
      );
      expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
        true,
      );
      const replaced = await host.open(
        {
          coordinator,
          cwd: root,
          home,
          view: { kind: "task", taskId: "another" },
          origin: { paneId: task.paneId, cwd: root },
        },
        root,
        "task",
        "task",
        path,
      );
      expect(
        blocks(await ternCommands(run, { environment: env }).ls(root)).some(
          (entry) => entry.block.id === task.paneId,
        ),
      ).toBe(false);
      expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
        true,
      );
      await host.open(
        {
          coordinator,
          cwd: root,
          home,
          view: { kind: "orchestrator" },
          origin: { paneId: replaced.paneId, cwd: root },
        },
        root,
        "panel",
        "return",
        path,
      );
      expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
        true,
      );
      const behindBoard = await host.open(
        { coordinator, cwd: root, home, view: { kind: "task", taskId: "behind-board" } },
        root,
        "task",
        "task",
        path,
      );
      const board = await host.open(
        { coordinator, cwd: root, home, view: { kind: "board" } },
        root,
        "board",
        "window",
        path,
      );
      expect(
        blocks(await ternCommands(run, { environment: env }).ls(root)).find(
          (entry) => entry.block.id === board.paneId,
        )?.tab.id,
      ).not.toBe(coordinator.tabId);
      expect(
        await host.toggleBoard(
          {
            coordinator,
            cwd: root,
            home,
            view: { kind: "board" },
            origin: { paneId: board.paneId, cwd: root },
          },
          root,
        ),
      ).toBe(true);
      expect(
        blocks(await ternCommands(run, { environment: env }).ls(root)).some(
          (entry) => entry.block.id === behindBoard.paneId,
        ),
      ).toBe(false);
      expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
        true,
      );
      expect(
        blocks(await ternCommands(run, { environment: env }).ls(root)).some(
          (entry) => entry.block.id === board.paneId,
        ),
      ).toBe(false);
      for (const kind of ["usage", "catchup"] as const) {
        const repeated = await Promise.all(
          Array.from({ length: 4 }, () =>
            host.open({ coordinator, cwd: root, home, view: { kind } }, root, kind, "window", path),
          ),
        );
        const full = repeated[0];
        if (full === undefined) throw new Error("missing repeated root result");
        expect(new Set(repeated.map((result) => result.paneId)).size).toBe(1);
        expect(
          blocks(await ternCommands(run, { environment: env }).ls(root)).filter(
            (entry) => entry.block.program === `tandem.${kind}`,
          ),
        ).toHaveLength(1);
        if (kind === "usage") {
          await Bun.sleep(500);
          await ctl("shot", "12-usage-reused");
          expect(JSON.stringify(await ctl("tree"))).toContain("Opus");
          const originalCli = await readFile(join(plugin, "tandem.sh"), "utf8");
          const warningFile = join(root, "safe-return.json");
          await writeFile(
            warningFile,
            JSON.stringify({
              opened: true,
              warnings: [
                "Returned to your conversation. The uncertain view and recovery record were kept. Use Tern's tab switcher to continue.",
              ],
            }),
          );
          await writeFile(
            join(plugin, "tandem.sh"),
            `#!/bin/sh\nif [ "$2" = "view-file" ]; then cat '${warningFile}'; exit 0; fi\n${originalCli.replace("#!/bin/sh\n", "")}`,
          );
          await ctl("key", "escape");
          await until(async () =>
            JSON.stringify(await ctl("tree")).includes("Tandem kept an uncertain view"),
          );
          expect(
            blocks(await ternCommands(run, { environment: env }).ls(root)).some(
              (entry) => entry.block.id === full.paneId,
            ),
          ).toBe(true);
          await ctl("shot", "14-return-warning-keeps-view");
          await writeFile(join(plugin, "tandem.sh"), originalCli);
        }
        await host.open(
          {
            coordinator,
            cwd: root,
            home,
            view: { kind: "orchestrator" },
            origin: { paneId: full.paneId },
          },
          root,
          "panel",
          "return",
          path,
        );
        expect(
          blocks(await ternCommands(run, { environment: env }).ls(root)).some(
            (entry) => entry.block.id === full.paneId,
          ),
        ).toBe(false);
        expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
          true,
        );
      }
      const other = await terminal.createWorkspace({
        sessionId: "other",
        cwd: root,
        role: "coordinator",
        generation: 0,
        label: "other coordinator",
      });
      expect(
        await terminal.focusAgent({
          sessionId: "other",
          cwd: root,
          paneId: other.endpoint.paneId,
          originCoordinator: coordinator,
          origin: { paneId: pane, cwd: root },
          home,
        }),
      ).toBe(true);
      await until(async () => JSON.stringify(await ctl("tree")).includes("other coordinator"));
      expect(
        await terminal.focusAgent({ sessionId: "fixture", cwd: root, paneId: coordinator.paneId }),
      ).toBe(true);
      const notify = ternBackend(run, {
        environment: env,
        notificationEndpoint: async () => ternNotificationEndpoint(coordinator),
      });
      let count = 0;
      for (const [title, body, name] of [
        ["Tandem: Needs you", "Approve brief: Tern backend", "09-needs-you"],
        ["Tandem: Done", "Terminal port refactor · draft PR is open", "09-done"],
        ["Tandem: Stuck", "Fix panel width", "09-stuck"],
      ]) {
        await notify.notify({
          sessionId: "fixture",
          cwd: root,
          title: title ?? "",
          body: body ?? "",
        });
        count++;
        await until(async () => JSON.stringify(await ctl("state")).includes(title ?? "missing"));
        if (count === 1) await ctl("inbox");
        const state = JSON.stringify(await ctl("state"));
        expect(state).toContain(title ?? "missing");
        expect(state).toContain(`"count":${count}`);
        expect(state).toContain('"alert":"waiting"');
        await ctl("shot", name ?? "09-alerts");
      }
      // Native safety audit: retain an uncertain browser across independent CLI backends.
      await saveCoordinatorRecord(home, {
        schemaVersion: 1,
        repoPath: root,
        endpoint: coordinator,
        harness: DEFAULT_HARNESS,
        command: ["omp"],
        worktree: {
          root,
          path: root,
          name: "fixture",
          branch: "fixture",
          baseHead: "a".repeat(40),
          leaseId: "fixture",
          leaseHolder: "fixture",
          leasedAt: new Date().toISOString(),
        },
      });
      let browserOpens = 0;
      let loseBrowserListing = false;
      const browserRunner: CommandRunner = async (request) => {
        if (loseBrowserListing && request.argv[1] === "ls") {
          loseBrowserListing = false;
          return { code: 1, stdout: "", stderr: "injected native browser verification loss" };
        }
        const result = await run(request);
        if (request.argv[1] === "browser") {
          browserOpens++;
          expect(result.code).toBe(0);
          loseBrowserListing = true;
        }
        return result;
      };
      const browserInput = {
        home,
        coordinator,
        cwd: root,
        view: { kind: "browser", url: "https://example.invalid/pull/281" } as const,
      };
      await expect(
        ternBackend(browserRunner, { home, environment: env }).openView(browserInput),
      ).rejects.toBeInstanceOf(TernOutcomeUnknownError);
      await expect(
        ternBackend(browserRunner, { home, environment: env }).openView(browserInput),
      ).rejects.toBeInstanceOf(TernOutcomeUnknownError);
      expect(browserOpens).toBe(1);
      await ctl("shot", "10-browser-quarantined");
      const safeReturn = await fresh.openView({
        coordinator,
        cwd: root,
        home,
        view: { kind: "orchestrator" },
      });
      expect(safeReturn.opened).toBe(true);
      expect(safeReturn.warnings[0]).toContain("Returned to your conversation");
      expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
        true,
      );
      await Bun.sleep(200);
      await ctl("shot", "13-safe-return-quarantined");

      let panelCloses = 0;
      let loseCloseListing = false;
      const uncertainClose = ternBackend(
        async (request) => {
          if (loseCloseListing && request.argv[1] === "ls") {
            loseCloseListing = false;
            return { code: 1, stdout: "", stderr: "injected native panel close verification loss" };
          }
          const result = await run(request);
          if (request.argv[1] === "close") {
            panelCloses++;
            loseCloseListing = true;
          }
          return result;
        },
        { home, environment: env },
      );
      const closeInput = { sessionId: "fixture", cwd: root, panelPaneId: pane };
      await expect(uncertainClose.closePanel(closeInput)).rejects.toBeInstanceOf(
        TernOutcomeUnknownError,
      );
      await expect(uncertainClose.closePanel(closeInput)).rejects.toBeInstanceOf(
        TernOutcomeUnknownError,
      );
      expect(panelCloses).toBe(1);
      expect(await terminal.isPanelOpen({ coordinator, cwd: root, panelPaneId: pane })).toBe(false);
      expect((await terminal.inspect({ endpoint: coordinator, cwd: root })).activeWorker).toBe(
        true,
      );
      await ctl("shot", "11-panel-close-quarantined");
      console.log(
        `Native quarantine artifacts: ${root}/shots/live/10-browser-quarantined.png ${root}/shots/live/11-panel-close-quarantined.png`,
      );
      console.log(
        `Native proof artifacts: ${root}/shots/live/01-panel.png ${root}/shots/live/02-projects.png ${root}/shots/live/04-exited-brief.png ${root}/shots/live/09-needs-you.png ${root}/shots/live/09-done.png ${root}/shots/live/09-stuck.png`,
      );
    } finally {
      if (window) {
        await ctl("quit").catch(() => {});
        window.kill();
        await window.exited;
      }
      daemon.kill();
      await daemon.exited;
      // Retain only this isolated proof directory for review and screenshot artifacts.
    }
  },
  45000,
);
