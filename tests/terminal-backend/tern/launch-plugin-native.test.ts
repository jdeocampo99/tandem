import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteShellArgument } from "../../../src/adapters/commands.ts";
import type { CommandRunner } from "../../../src/contracts.ts";
import { findRunningCoordinator } from "../../../src/coordinator/ownership.ts";
import { listCoordinatorRecords } from "../../../src/coordinator/registry.ts";
import { type Action, Outcome, parseBlockArgs } from "../../../src/native/contract.ts";
import { publishViews, recordVisit } from "../../../src/native/store.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { ternCli } from "../../../src/terminal-backend/tern/cli.ts";
import { blocks } from "../../../src/terminal-backend/tern/protocol.ts";
import { openFiles, publishFixture } from "../../native/view-files.ts";
import { nativeScreensFixture } from "../../tern-view/screens-fixture.ts";
import { launchTernWindow } from "./native-window.ts";
import { panelFixture } from "./panel-fixture.ts";

const native = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";
(native ? test : test.skip)(
  "front door and action CLI launch projects and keep panel and catch-up routing available",
  async () => {
    // Refuse overlap before allocating a daemon or a window. Never operate another run's sockets.
    const active = Bun.spawnSync(["pgrep", "-fl", "tern --control"], { stdout: "pipe" });
    if (/^[0-9]+ (?:\S*\/)?tern --control(?: |$)/mu.test(active.stdout.toString()))
      throw new Error("another isolated Tern run is active");
    const root = await realpath(await mkdtemp("/tmp/td55-launch-"));
    const home = join(root, "home");
    const control = join(root, "w.sock");
    const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
    const checkout = fileURLToPath(new URL("../../../", import.meta.url));
    const env = {
      HOME: root,
      USER: "tandem-test",
      LOGNAME: "tandem-test",
      PATH: `${process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin"}`,
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      ZDOTDIR: join(root, "zdot"),
      TERN_CONFIG_DIR: join(root, "config"),
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: home,
      TANDEM_POOL_ROOT: join(root, "pool"),
      TANDEM_SESSION: "native-launch-proof",
      STENCIL_LOG_DIR: join(root, "logs"),
      XDG_CONFIG_HOME: join(root, "xdg"),
      // A non-secret sentinel exposes the real offline catalogue. No model turn is sent.
      ANTHROPIC_API_KEY: "native-proof-unused",
    };
    await Promise.all(
      [home, env.ZDOTDIR, env.TERN_CONFIG_DIR, join(root, "shots")].map((p) => mkdir(p)),
    );
    // Tern panes start the user's login shell; a real profile puts the harness on PATH.
    await writeFile(join(env.ZDOTDIR, ".zshrc"), `export PATH=${quoteShellArgument(env.PATH)}\n`);
    const run: CommandRunner = async (request) => {
      const child = Bun.spawn([...request.argv], {
        cwd: request.cwd,
        env: { ...env, ...request.env },
        stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: request.timeoutMs ?? 30_000,
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const checked = async (argv: string[], cwd = root, stdin?: string) => {
      const result = await run({ argv, cwd, ...(stdin === undefined ? {} : { stdin }) });
      if (result.code !== 0)
        throw new Error(`${argv[1]} failed: ${result.stderr || result.stdout}`);
      return result.stdout;
    };
    const ctl = (...args: string[]) => checked([binary, "ctl", "--control", control, ...args]);
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 20_000;
      while (!(await check().catch(() => false))) {
        if (Date.now() >= deadline) throw new Error(`native proof timed out; evidence: ${root}`);
        await Bun.sleep(100);
      }
    };
    await writeFile(join(home, "settings.toml"), 'terminal = "tern"\n');
    await writeFile(
      join(home, "models.json"),
      JSON.stringify({
        schemaVersion: 1,
        models: Object.fromEntries(
          ["coordinator", "scout", "implementer", "reviewer", "presentation"].map((role) => [
            role,
            { model: "anthropic/claude-sonnet-4-6", thinking: "low" },
          ]),
        ),
        enabledProviders: ["anthropic"],
        jev: "off",
      }),
      { mode: 0o600 },
    );
    await writeFile(join(env.TERN_CONFIG_DIR, "settings.json"), '{"tabs_autohide":true}');
    const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      cwd: root,
      env,
      stdout: "ignore",
      stderr: Bun.file(join(root, "daemon.log")),
    });
    let window: Bun.Subprocess | undefined;
    try {
      await until(
        async () => (await run({ argv: [binary, "ls", "--json"], cwd: root })).code === 0,
      );
      await checked([binary, "plugin", "link", join(checkout, "tern-plugin"), "--json"]);
      window = await launchTernWindow({
        binary,
        control,
        args: ["--dir", root, "--out", join(root, "shots")],
        env,
        cwd: root,
        log: join(root, "window.log"),
      });
      const repos: string[] = [];
      for (const name of ["repo-a", "repo-b", "repo-c"]) {
        const repo = join(root, name);
        await mkdir(repo);
        await checked(["git", "init", "-q", "-b", "main"], repo);
        await writeFile(join(repo, "README.md"), `# ${name}\nNative launch fixture\n`);
        await checked(["git", "add", "README.md"], repo);
        await checked(
          [
            "git",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture",
          ],
          repo,
        );
        await checked(
          [process.execPath, join(checkout, "src/cli.ts"), "setup", repo, "--yes", "--json"],
          repo,
        );
        repos.push(repo);
      }
      const [a, b, c] = repos;
      if (a === undefined || b === undefined || c === undefined)
        throw new Error("missing fixture repo");
      const frontDoor = (repo: string) =>
        checked([process.execPath, join(checkout, "src/main.ts"), repo, "--no-attach"], repo);
      await frontDoor(a);
      const terminal = ternBackend(run, { home, environment: env });
      const commands = ternCli(run, { environment: env });
      const record = (await listCoordinatorRecords(home, env.TANDEM_SESSION)).find(
        (r) => r.repoPath === a,
      );
      if (record === undefined) throw new Error("first coordinator record missing");
      // Launch readiness is proved by coordinator discovery. Let its welcome animation settle
      // before the visual fixture; terminal captures vary with OMP's TSP implementation.
      await Bun.sleep(5000);
      // Authentic coordinator and launch paths, realistic derived view data, no model turn or task mutation.
      const panel = panelFixture(a);
      const writePanelFixture = () =>
        publishFixture(home, a, {
          panel,
          projects: panel.header.projects,
          tasks: {},
          briefs: {},
          pullRequests: {},
          warnings: [],
        });
      await writePanelFixture();
      await terminal.openPanel({
        coordinator: record.endpoint,
        cwd: record.worktree.path,
        project: a,
      });
      await terminal.focusWorkspace({
        sessionId: env.TANDEM_SESSION,
        cwd: a,
        workspaceId: record.endpoint.workspaceId,
      });
      await until(async () => {
        // The authentic coordinator keeps publishing its own empty panel; hold the fixture
        // through a renderer poll until the first panel shows it.
        await writePanelFixture();
        return (await ctl("tree")).includes("Tern backend adapter");
      });
      await ctl("shot", "01-project-a-panel");
      const plugin = blocks(await commands.ls(a)).find((p) => p.block.program === "tandem.panel");
      expect(plugin?.block.live).toBe(true);
      if (plugin === undefined) throw new Error("live panel missing");
      const proc = await checked([binary, "process", plugin.block.id, "--json"]);
      expect(JSON.parse(proc).child).toBeNull();
      await writeFile(join(root, "panel-process.json"), proc);
      await writeFile(join(root, "front-door-b.txt"), await frontDoor(b));
      await writeFile(
        join(root, "action-cli-c.json"),
        await checked(
          [
            process.execPath,
            join(checkout, "src/cli.ts"),
            "launch",
            "--repo",
            c,
            "--headless",
            "--no-attach",
            "--json",
          ],
          c,
        ),
      );
      for (const repoPath of repos) {
        const running = await findRunningCoordinator(run, terminal, {
          home,
          sessionId: env.TANDEM_SESSION,
          repoPath,
        });
        expect(running).toBeDefined();
        if (running === undefined) throw new Error(`coordinator missing: ${repoPath}`);
        await terminal.focusWorkspace({
          sessionId: env.TANDEM_SESSION,
          cwd: repoPath,
          workspaceId: running.endpoint.workspaceId,
        });
        await Bun.sleep(500);
        await ctl("shot", `02-${repoPath.split("/").at(-1)}-launched`);
      }
      expect(blocks(await commands.ls(a)).some((p) => p.block.id === plugin.block.id)).toBe(true);
      const records = (await listCoordinatorRecords(home, env.TANDEM_SESSION)).toSorted((a, b) =>
        a.repoPath.localeCompare(b.repoPath),
      );
      const second = records.find((r) => r.repoPath === b);
      if (second === undefined) throw new Error("second coordinator record missing");
      const initialSecondPanel = blocks(await commands.ls(b)).find(
        (p) =>
          p.block.program === "tandem.panel" &&
          parseBlockArgs(p.block.args)?.ctx.coordinator === second.endpoint.paneId,
      );
      if (initialSecondPanel === undefined) throw new Error("initial second-project panel missing");
      await terminal.closePanel({
        sessionId: second.endpoint.sessionId,
        cwd: second.worktree.path,
        panelPaneId: initialSecondPanel.block.id,
      });
      expect(
        blocks(await commands.ls(b)).some((p) => p.block.id === initialSecondPanel.block.id),
      ).toBe(false);
      const publish = async (project: string) =>
        publishViews(home, project, async () => {
          const fixture = nativeScreensFixture();
          const panel = panelFixture(project);
          const projects = records.map((r, index) => ({
            terminal: "tern" as const,
            repoPath: r.repoPath,
            name: r.repoPath.split("/").at(-1) ?? "fixture",
            current: r.repoPath === project,
            offline: false,
            running: 4,
            needsYou: 1,
            status: "4 running · 1 needs you",
            shortcut: `⌘${index + 1}`,
            sessionId: r.endpoint.sessionId,
          }));
          const writtenAt = new Date().toISOString();
          return {
            bundle: {
              ...fixture,
              project,
              writtenAt,
              summary: {
                ...fixture.summary,
                repoPath: project,
                name: project.split("/").at(-1) ?? "fixture",
                writtenAt,
                sessionId: env.TANDEM_SESSION,
              },
              panel: {
                ...panel,
                header: {
                  ...panel.header,
                  title: project.split("/").at(-1) ?? "fixture",
                  projects,
                },
              },
              projects,
              catchup: { ...fixture.catchup, project },
            },
            details: [],
          };
        });
      // Switch through the actual CLI. An aged, changed visit must automatically open B's catch-up.
      await recordVisit(home, b, {
        kind: "entry",
        now: new Date(Date.now() - 7_200_000).toISOString(),
        signature: "before",
        showCatchUp: async () => {
          throw new Error("baseline visit must not show catch-up");
        },
      });
      await publish(a);
      await publish(b);
      const target = records.findIndex((r) => r.repoPath === b) + 1;
      const nativeAction = async (
        action: Action,
        pane = record.endpoint.paneId,
        cwd = record.worktree.path,
      ) => {
        const text = await checked(
          [process.execPath, join(checkout, "src/main.ts"), "native", "act"],
          cwd,
          JSON.stringify({ v: 1, origin: { pane, cwd }, action }),
        );
        const outcome = Outcome.parse(JSON.parse(text));
        if (outcome.status !== "done") throw new Error(`native act: ${text}`);
        return text;
      };
      await terminal.focusWorkspace({
        sessionId: env.TANDEM_SESSION,
        cwd: a,
        workspaceId: record.endpoint.workspaceId,
      });
      const switched = await nativeAction({ verb: "project", target });
      await writeFile(join(root, "project-switch-b.json"), switched);
      // Force a fresh route open after the switch, rather than reusing B's launch-time panel.
      const secondPanelId = await terminal.openPanel({
        coordinator: second.endpoint,
        cwd: second.worktree.path,
        project: b,
      });
      expect(secondPanelId).not.toBe(initialSecondPanel.block.id);
      const secondPanel = blocks(await commands.ls(b)).find((p) => p.block.id === secondPanelId);
      expect(secondPanel?.session.id).toBe(second.endpoint.terminalSessionId);
      expect(secondPanel?.block.program).toBe("tandem.panel");
      expect(parseBlockArgs(secondPanel?.block.args)?.ctx.coordinator).toBe(second.endpoint.paneId);
      await terminal.focusWorkspace({
        sessionId: env.TANDEM_SESSION,
        cwd: b,
        workspaceId: second.endpoint.workspaceId,
      });
      // B's live coordinator publishes its own empty board, so hold the fixture through a poll.
      await until(async () => {
        await publish(b);
        return (await ctl("tree")).includes("Tern backend adapter");
      });
      await ctl("shot", "03-project-b-panel");
      const catchup = blocks(await commands.ls(b)).find(
        (p) =>
          p.block.program === "tandem.catchup" &&
          parseBlockArgs(p.block.args)?.ctx.coordinator === second.endpoint.paneId,
      );
      expect(catchup).toBeDefined();
      if (catchup === undefined) throw new Error("automatic second-project catch-up missing");
      await checked([binary, "focus", catchup.block.id, "--json"]);
      await until(async () => (await ctl("tree")).includes("Status line summary"));
      await ctl("shot", "04-project-b-automatic-catchup");
      await writeFile(
        join(root, "board-b.json"),
        await nativeAction(
          { verb: "open", ref: { kind: "board" } },
          second.endpoint.paneId,
          second.worktree.path,
        ),
      );
      await publish(b);
      await until(async () => {
        // The authentic coordinator also publishes its empty board; keep the visual fixture
        // present through a renderer poll without changing task state or retrying an open.
        await publish(b);
        return (await ctl("tree")).includes("Terminal port refactor");
      });
      await ctl("shot", "05-project-b-board");
      const listing = await commands.ls(b);
      expect(
        blocks(listing).some(
          (p) =>
            p.block.program === "tandem.board" &&
            parseBlockArgs(p.block.args)?.ctx.coordinator === second.endpoint.paneId,
        ),
      ).toBe(true);
      expect(
        blocks(listing).some((p) => p.block.args?.some((arg) => arg.endsWith(".ticket.json"))),
      ).toBe(false);
      expect(
        (await openFiles(home)).filter((name) => /\.(?:ticket|receipt)\.json$/u.test(name)),
      ).toEqual([]);
      expect(await readFile(join(root, "logs", "tern.log"), "utf8")).not.toContain(
        "hook exceeded its budget",
      );
      await writeFile(
        join(root, "proof.json"),
        JSON.stringify(
          {
            root,
            repos,
            panelPaneId: plugin.block.id,
            coordinators: records,
            initialSecondPanel,
            secondPanel,
            catchup,
            listing,
          },
          null,
          2,
        ),
      );
      console.log(`Native launch proof and screenshots: ${root}`);
    } catch (error) {
      await ctl("shot", "failure").catch(() => undefined);
      console.error(`Native failure evidence: ${root}`);
      throw error;
    } finally {
      if (window !== undefined) {
        await ctl("quit").catch(() => undefined);
        if (window.exitCode === null) window.kill("SIGKILL");
        await window.exited;
      }
      daemon.kill("SIGTERM");
      await daemon.exited;
      // Keep screenshots and logs for review. The entire test home remains isolated.
      expect(await readFile(join(home, "settings.toml"), "utf8")).toContain('terminal = "tern"');
    }
  },
  180_000,
);
