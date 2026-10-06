import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeViewText } from "../../../src/board/native-views.ts";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner } from "../../../src/contracts.ts";
import { findRunningCoordinator } from "../../../src/coordinator/ownership.ts";
import { listCoordinatorRecords } from "../../../src/coordinator/registry.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { blocks, ternCommands } from "../../../src/terminal-backend/tern/protocol.ts";
import { panelFixture } from "./panel-fixture.ts";

const native = process.platform === "darwin" && process.env.TANDEM_TERN_LAUNCH_NATIVE === "1";
(native ? test : test.skip)(
  "front door and action CLI launch other projects with a live native panel",
  async () => {
    // Refuse overlap before allocating a daemon or a window. Never operate another run's sockets.
    const active = Bun.spawnSync(["pgrep", "-fl", "tern --control"], { stdout: "pipe" });
    if (active.stdout.toString().trim()) throw new Error("another isolated Tern run is active");
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
    const run: CommandRunner = async (request) => {
      const child = Bun.spawn([...request.argv], {
        cwd: request.cwd,
        env: { ...env, ...request.env },
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
    const checked = async (argv: string[], cwd = root) => {
      const result = await run({ argv, cwd });
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
    let window: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await until(
        async () => (await run({ argv: [binary, "ls", "--json"], cwd: root })).code === 0,
      );
      await checked([binary, "plugin", "link", join(checkout, "tern-plugin"), "--json"]);
      window = Bun.spawn(
        [binary, "--control", control, "--dir", root, "--out", join(root, "shots")],
        {
          cwd: root,
          env,
          stdout: "ignore",
          stderr: Bun.file(join(root, "window.log")),
        },
      );
      await until(async () => {
        await ctl("state");
        return true;
      });
      await ctl("account", "signed-in");
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
      const commands = ternCommands(run, { environment: env });
      const record = (await listCoordinatorRecords(home, env.TANDEM_SESSION)).find(
        (r) => r.repoPath === a,
      );
      if (record === undefined) throw new Error("first coordinator record missing");
      // Authentic coordinator and launch paths, realistic derived view data, no model turn or task mutation.
      const panel = panelFixture(a);
      await mkdir(join(home, "native-views"), { recursive: true });
      await writeFile(
        nativeViewsPath(home, a),
        nativeViewText("panel", {
          version: 1,
          project: a,
          writtenAt: new Date().toISOString(),
          panel,
          projects: panel.header.projects,
          tasks: {},
          briefs: {},
          pullRequests: {},
          warnings: [],
        }),
      );
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
      await until(async () => (await ctl("tree")).includes("Tern backend adapter"));
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
      await writeFile(
        join(root, "proof.json"),
        JSON.stringify(
          {
            root,
            repos,
            panelPaneId: plugin.block.id,
            coordinators: await listCoordinatorRecords(home, env.TANDEM_SESSION),
          },
          null,
          2,
        ),
      );
      console.log(`Native launch proof and screenshots: ${root}`);
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
