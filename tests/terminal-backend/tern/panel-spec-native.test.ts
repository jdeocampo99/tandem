import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NativeAlerts, nativeAlertCounts } from "../../../src/board/native-alerts.ts";
import { nativeViewText } from "../../../src/board/native-views.ts";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import { boardView } from "../../../src/board/view.ts";
import { repositoryKey } from "../../../src/config/repositories.ts";
import type { CommandRunner } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { visitNativeProject } from "../../../src/memory/native-visits.ts";
import { createTaskStore } from "../../../src/tasks/store.ts";
import {
  ternBackend,
  ternNotificationEndpoint,
} from "../../../src/terminal-backend/tern/backend.ts";
import { state } from "../../board/fixtures.ts";
import { policy } from "../../session/fixtures.ts";
import { recordedActions } from "./native-window.ts";
import { panelFixture } from "./panel-fixture.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";
type Node = {
  class?: string | undefined;
  text?: string | undefined;
  rect?: number[] | undefined;
  children?: Node[] | undefined;
};
const node: z.ZodType<Node> = z.lazy(() =>
  z.object({
    class: z.string().optional(),
    text: z.string().optional(),
    rect: z.array(z.number()).optional(),
    children: z.array(node).optional(),
  }),
);
const tree = z.object({ tree: z.array(node) });

(enabled ? test : test.skip)(
  "isolated panel selects project ten by identity; unread bell clears and inbox returns to real conversation",
  async () => {
    const root = await realpath(
      process.env.TANDEM_TERN_PROOF_ROOT ?? (await mkdtemp("/tmp/tdm-panel-spec-")),
    );
    if (!root.startsWith("/private/tmp/tdm-panel-spec-"))
      throw new Error("Isolated proof root required");
    const config = join(root, "config"),
      home = join(root, "home"),
      plugin = join(root, "plugin"),
      control = join(root, "w.sock");
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
      TANDEM_SESSION: "fixture",
      STENCIL_LOG_DIR: join(root, "logs"),
    };
    await Promise.all([mkdir(config), mkdir(home), mkdir(env.ZDOTDIR), mkdir(join(root, "shots"))]);
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({ tabs_autohide: true, layout: "rail", link_target: "Tern" }),
    );
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    const driver = fileURLToPath(new URL("./panel-spec-driver.ts", import.meta.url));
    await writeFile(
      join(plugin, "tandem.sh"),
      `#!/bin/sh\nexec /opt/homebrew/bin/bun '${driver}' "$@"\n`,
    );
    const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
    const run: CommandRunner = async (request) => {
      const process = Bun.spawn([...request.argv], {
        cwd: request.cwd,
        env: { ...env, ...request.env },
        timeout: request.timeoutMs ?? 8000,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { stdout, stderr, code };
    };
    const ctl = async (...args: string[]) => {
      const result = await run({ argv: [binary, "ctl", "--control", control, ...args], cwd: root });
      if (result.code !== 0) throw new Error(result.stderr);
      return JSON.parse(result.stdout) as unknown;
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
    let window: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await until(
        async () => (await run({ argv: [binary, "ls", "--json"], cwd: root })).code === 0,
      );
      const linked = await run({ argv: [binary, "plugin", "link", plugin, "--json"], cwd: root });
      expect(linked.code).toBe(0);
      const terminal = ternBackend(run, { home, environment: env });
      const projects = [];
      for (const [index, name] of ["tandem", "project-ten"].entries()) {
        const repo = join(root, name);
        await mkdir(repo);
        const { endpoint } = await terminal.createWorkspace({
          sessionId: "fixture",
          cwd: repo,
          role: "coordinator",
          generation: 0,
          label: name,
        });
        await saveCoordinatorRecord(home, {
          schemaVersion: 1,
          repoPath: repo,
          endpoint,
          harness: DEFAULT_HARNESS,
          command: ["omp", "--cwd", repo, "--session-dir", join(home, name)],
          worktree: {
            root,
            path: repo,
            name,
            baseHead: "a".repeat(40),
            branch: "fixture",
            leaseId: name,
            leaseHolder: `coordinator:${name}`,
            leasedAt: new Date().toISOString(),
          },
        });
        await terminal.runCommand({
          endpoint,
          cwd: repo,
          command: [
            "/bin/sh",
            "-c",
            `clear; printf '%s\\n' 'You: Build Tern support.' 'Orchestrator: ${name} conversation is ready. Read the brief in the panel.'; while IFS= read -r line; do :; done`,
          ],
        });
        projects.push({ repo, endpoint, index });
      }
      const first = projects[0],
        tenth = projects[1];
      if (!first || !tenth) throw new Error("fixture projects missing");
      await mkdir(join(home, "native-views"));
      for (const project of projects) {
        const base = panelFixture(project.repo);
        const firstRow = base.header.projects[0];
        if (!firstRow) throw new Error("fixture switcher missing");
        const switcher = [
          { ...firstRow, repoPath: first.repo, name: "tandem", current: project === first },
          ...Array.from({ length: 8 }, (_, index) => ({
            terminal: "tern" as const,
            repoPath: join(root, `project-${index + 2}`),
            name: `project-${index + 2}`,
            current: false,
            offline: false,
            running: 0,
            needsYou: 0,
            status: "idle",
            shortcut: `⌘${index + 2}`,
            sessionId: "fixture",
          })),
          {
            terminal: "tern" as const,
            repoPath: tenth.repo,
            name: "project-ten",
            current: project === tenth,
            offline: false,
            running: 2,
            needsYou: 1,
            status: "2 running · 1 needs you",
            sessionId: "fixture",
          },
        ];
        const panel = {
          ...base,
          header: {
            ...base.header,
            title: project === tenth ? "project-ten ▾" : "tandem ▾",
            projects: switcher,
          },
        };
        await writeFile(
          nativeViewsPath(home, project.repo),
          nativeViewText("panel", {
            version: 1,
            project: project.repo,
            writtenAt: new Date().toISOString(),
            summary: {},
            panel,
            projects: panel.header.projects,
            changeSignature: "fixture",
            tasks: {},
            briefs: {},
            pullRequests: {},
            board: {},
            usage: {},
            catchup: {},
            warnings: [],
          }),
        );
      }
      window = Bun.spawn(
        [binary, "--control", control, "--dir", first.repo, "--out", join(root, "shots")],
        { env, cwd: root, stdout: "ignore", stderr: Bun.file(join(root, "window.log")) },
      );
      await until(async () => {
        await ctl("state");
        return true;
      });
      await ctl("account", "signed-in");
      await Bun.sleep(500);
      const firstPanel = await terminal.openPanel({
        coordinator: first.endpoint,
        cwd: first.repo,
        project: first.repo,
      });
      await terminal.openPanel({
        coordinator: tenth.endpoint,
        cwd: tenth.repo,
        project: tenth.repo,
      });
      await terminal.focusAgent({
        sessionId: "fixture",
        cwd: first.repo,
        paneId: first.endpoint.paneId,
      });
      const find = (nodes: Node[], className: string): Node[] =>
        nodes.flatMap((item) => [
          ...(item.class?.split(" ").includes(className) ? [item] : []),
          ...find(item.children ?? [], className),
        ]);
      const click = async (item: Node | undefined) => {
        const rect = item?.rect;
        if (!rect) throw new Error("missing click target");
        await ctl("click", String((rect[0] ?? 0) + 10), String((rect[1] ?? 0) + 10));
      };
      await until(async () => JSON.stringify(await ctl("tree")).includes("Tern backend adapter"));
      await ctl("shot", "01-panel");
      await click(find(tree.parse(await ctl("tree")).tree, "tdp-switch")[0]);
      await until(async () => JSON.stringify(await ctl("tree")).includes("project-ten"));
      await writeFile(join(root, "projects-tree.json"), JSON.stringify(await ctl("tree")));
      const rows = find(tree.parse(await ctl("tree")).tree, "tdp-project-row");
      expect(rows).toHaveLength(10);
      await ctl("shot", "02-ten-projects");
      await click(rows[9]);
      await until(
        async () =>
          z.object({ focused: z.object({ id: z.number() }) }).parse(await ctl("state")).focused
            .id === Number(tenth.endpoint.paneId),
      );
      await writeFile(join(root, "selected-state.json"), JSON.stringify(await ctl("state")));
      expect(
        (await recordedActions(join(home, "actions.log"))).some(
          ({ action }) =>
            action.verb === "project" &&
            typeof action.target === "object" &&
            action.target.repoPath === tenth.repo,
        ),
      ).toBe(true);
      await ctl("shot", "03-tenth-selected");
      await terminal.focusAgent({
        sessionId: "fixture",
        cwd: first.repo,
        paneId: first.endpoint.paneId,
      });
      const notify = ternBackend(run, {
        environment: env,
        notificationEndpoint: async () => ternNotificationEndpoint(first.endpoint),
      });
      const clock = () => new Date().toISOString();
      const store = createTaskStore({
        directory: join(home, "tasks"),
        clock,
        idFactory: () => "fixture-task",
      });
      const task = await store.create({
        repoPath: first.repo,
        kind: "implementation",
        objective: "Fix panel width",
        acceptanceCriteria: ["native fixture"],
        surfaces: ["panel"],
        policy,
      });
      let saved = await store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        stage: "implementing",
        scopeApproved: true,
      }));
      const alerts = new NativeAlerts({
        home,
        clock,
        run,
        terminal: { ...terminal, notify: notify.notify },
      });
      const snapshot = {
        version: 1 as const,
        writtenAt: clock(),
        coordinators: [],
        board: boardView(state({ projects: [first.repo] }), clock()),
      };
      await alerts.observe(snapshot, first.repo, "fixture");
      const brief = {
        ...snapshot,
        board: {
          ...snapshot.board,
          needsYou: [
            {
              key: "brief:fixture",
              cause: "brief" as const,
              repoPath: first.repo,
              project: "tandem",
              mark: "?",
              name: "Approve brief: Tern support",
              text: "approval needed",
            },
          ],
        },
      };
      await alerts.observe(brief, first.repo, "fixture");
      saved = await store.update(saved.id, saved.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        pullRequest: {
          repository: "fixture/tandem",
          number: 281,
          state: "draft",
          head: "fixture-head",
          base: "main",
        },
      }));
      await alerts.observe(brief, first.repo, "fixture");
      await store.update(saved.id, saved.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        stage: "blocked",
        previousStage: "implementing",
        blockReason: "same 2 problems twice",
      }));
      await alerts.observe(brief, first.repo, "fixture");
      expect(await nativeAlertCounts(home, first.repo)).toEqual({ delivered: 3, unread: 3 });
      const path = nativeViewsPath(home, first.repo);
      const envelope = JSON.parse(await readFile(path, "utf8"));
      envelope.model.panel.header.bellCount = 3;
      await writeFile(path, nativeViewText("panel", envelope.model));
      await until(async () => JSON.stringify(await ctl("tree")).includes("🔔︎ 3"));
      await ctl("shot", "04-three-unread");
      await ctl("inbox");
      await until(async () => JSON.stringify(await ctl("state")).includes("Tandem: Stuck"));
      await ctl("shot", "05-inbox");
      await writeFile(join(root, "inbox-tree.json"), JSON.stringify(await ctl("tree")));
      // The inbox activation key selects its recorded helper; the production focus hook redirects.
      await ctl("key", "enter");
      await until(async () => {
        const saved = JSON.parse(
          await readFile(join(home, "native-alerts", `${repositoryKey(first.repo)}.json`), "utf8"),
        );
        return saved.read === 3;
      });
      await until(async () => JSON.stringify(await ctl("tree")).includes("🔔︎ 0"));
      expect(
        z.object({ focused: z.object({ id: z.number() }) }).parse(await ctl("state")).focused.id,
      ).toBe(Number(first.endpoint.paneId));
      await ctl("shot", "06-inbox-project-return");
      expect(
        await terminal.isPanelOpen({
          coordinator: first.endpoint,
          cwd: first.repo,
          panelPaneId: firstPanel,
        }),
      ).toBe(true);
      // The production catch-up boundary preserves entry and surfaces a warning in the native panel.
      await visitNativeProject(
        {
          home,
          project: tenth.repo,
          signature: "before",
          now: new Date(Date.now() - 2 * 3600000).toISOString(),
        },
        async () => {},
      );
      const visitPath = join(home, "native-visits", `${repositoryKey(tenth.repo)}.json`);
      const visit = await readFile(visitPath, "utf8");
      const destinationPath = nativeViewsPath(home, tenth.repo);
      const latest = JSON.parse(await readFile(destinationPath, "utf8"));
      await writeFile(
        destinationPath,
        nativeViewText("panel", { ...latest.model, changeSignature: "after" }),
      );
      await writeFile(join(home, "fixture-catchup-failure"), "fixture", {
        flag: "wx",
        mode: 0o600,
      });
      await click(find(tree.parse(await ctl("tree")).tree, "tdp-switch")[0]);
      await until(
        async () => find(tree.parse(await ctl("tree")).tree, "tdp-project-row").length === 10,
      );
      await click(find(tree.parse(await ctl("tree")).tree, "tdp-project-row")[9]);
      await until(async () =>
        JSON.stringify(await ctl("tree")).includes("Fixture catch-up unavailable"),
      );
      expect(await readFile(visitPath, "utf8")).toBe(visit);
      expect(
        z.object({ focused: z.object({ id: z.number() }) }).parse(await ctl("state")).focused.id,
      ).toBe(Number(tenth.endpoint.paneId));
      await ctl("shot", "07-catchup-warning");
      console.log(
        `Native panel spec proof artifacts: ${root}/shots/live/01-panel.png ${root}/shots/live/02-ten-projects.png ${root}/shots/live/03-tenth-selected.png ${root}/shots/live/04-three-unread.png ${root}/shots/live/05-inbox.png ${root}/shots/live/06-inbox-project-return.png ${root}/shots/live/07-catchup-warning.png`,
      );
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
