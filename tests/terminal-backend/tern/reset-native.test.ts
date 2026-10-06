import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeViewText } from "../../../src/board/native-views.ts";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner } from "../../../src/contracts.ts";
import { listCoordinatorRecords } from "../../../src/coordinator/registry.ts";
import { runTerminal } from "../../../src/main.ts";
import { parseBlockArgs } from "../../../src/native/contract.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { blocks, Processes, ternCommands } from "../../../src/terminal-backend/tern/protocol.ts";
import { nativeScreensFixture } from "../../tern-view/screens-fixture.ts";

const native = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE === "1";
(native ? test : test.skip)(
  "isolated native reset retires all owned views and relaunches the same project",
  async () => {
    const root = await realpath(await mkdtemp("/tmp/tern-reset-"));
    const home = join(root, "home"),
      repo = join(root, "repo"),
      control = join(root, "w.sock");
    const checkout = fileURLToPath(new URL("../../../", import.meta.url));
    const binary = "/Applications/Tern.app/Contents/MacOS/tern";
    const env = {
      HOME: root,
      USER: "tandem-test",
      LOGNAME: "tandem-test",
      PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      ZDOTDIR: join(root, "zdot"),
      TERN_CONFIG_DIR: join(root, "config"),
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: home,
      TANDEM_POOL_ROOT: join(root, "pool"),
      TANDEM_SESSION: "reset-proof",
      STENCIL_LOG_DIR: join(root, "logs"),
      XDG_CONFIG_HOME: join(root, "xdg"),
      ANTHROPIC_API_KEY: "native-proof-unused",
    };
    await Promise.all(
      [home, repo, env.ZDOTDIR, env.TERN_CONFIG_DIR, join(root, "shots")].map((p) => mkdir(p)),
    );
    let sample = 0;
    let transitionGroup: string | undefined;
    let transitionInjected = false;
    const run: CommandRunner = async (request) => {
      if (
        !transitionInjected &&
        transitionGroup !== undefined &&
        request.argv[1]?.endsWith("process-reader.ts") &&
        request.argv[2] === transitionGroup
      ) {
        transitionInjected = true;
        await writeFile(join(root, "exec-go"), "go");
        await Bun.sleep(300);
      }
      const child = Bun.spawn([...request.argv], {
        cwd: request.cwd,
        env: { ...env, ...request.env },
        stdout: "pipe",
        stderr: "pipe",
        timeout: request.timeoutMs ?? 30000,
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (request.argv[1] === "process" || request.argv[1]?.endsWith("process-reader.ts"))
        await writeFile(
          join(root, `process-${++sample}.json`),
          JSON.stringify({ argv: request.argv, code, stdout, stderr }),
        );
      return { code, stdout, stderr };
    };
    const checked = async (argv: string[], cwd = root) => {
      const result = await run({ argv, cwd });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout;
    };
    const ctl = (...args: string[]) => checked([binary, "ctl", "--control", control, ...args]);
    const shot = async (name: string) => {
      await ctl("account", "signed-in");
      await Bun.sleep(300);
      await ctl("shot", name);
    };
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 20000;
      while (!(await check().catch(() => false))) {
        if (Date.now() > deadline) throw new Error(`native proof timed out: ${root}`);
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
    await checked(["git", "init", "-q", "-b", "main"], repo);
    await writeFile(join(repo, "README.md"), "# Isolated reset fixture\n");
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
        { cwd: root, env, stdout: "ignore", stderr: Bun.file(join(root, "window.log")) },
      );
      await until(async () => {
        await ctl("state");
        return true;
      });
      await ctl("account", "signed-in");
      const terminal = ternBackend(run, { home, environment: env });
      const commands = ternCommands(run, { environment: env });
      // Reproduce B independently of any native views: exec between Tern's process
      // snapshot and the native group read. Both observations come from real processes.
      const race = await terminal.createWorkspace({
        sessionId: env.TANDEM_SESSION,
        cwd: root,
        label: "Process transition proof",
        role: "implementer",
        generation: 0,
      });
      const script = join(root, "exec-transition.sh");
      await writeFile(
        script,
        `while [ ! -f '${root}/exec-go' ]; do /bin/sleep 0.05; done
exec /bin/sleep 30
`,
      );
      await terminal.runCommand({
        endpoint: race.endpoint,
        cwd: root,
        command: ["/bin/sh", script],
      });
      await until(async () => {
        const proc = await commands.read(root, ["process", race.endpoint.paneId], Processes);
        if (proc.foreground?.argv[1] !== script) return false;
        transitionGroup = String(proc.group);
        return true;
      });
      const transitioned = await terminal.inspect({ endpoint: race.endpoint, cwd: root });
      expect(transitionInjected).toBe(true);
      expect(
        transitioned.processInfo.foregroundProcesses.some((p) => p.argv[0] === "/bin/sleep"),
      ).toBe(true);
      await terminal.closeOwned({ endpoint: race.endpoint, cwd: root });
      const front = async (args: string[], file: string) => {
        let output = "";
        const result = await runTerminal(args, {
          cwd: repo,
          tandemCheckout: repo,
          processEnvironment: env,
          run,
          terminal,
          isTTY: false,
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            output += text;
          },
        });
        await writeFile(join(root, file), JSON.stringify({ result, output }, null, 2));
        expect(result.exitCode).toBe(0);
      };
      await front([repo, "--no-attach"], "launch.json");
      const record = (await listCoordinatorRecords(home, env.TANDEM_SESSION))[0];
      if (!record) throw new Error("coordinator record missing");
      const fixture = nativeScreensFixture();
      await mkdir(join(home, "native-views"), { recursive: true });
      const path = nativeViewsPath(home, repo);
      await writeFile(
        path,
        nativeViewText("panel", { ...fixture, project: repo, writtenAt: new Date().toISOString() }),
      );
      for (const view of [
        { kind: "brief", requestId: "reset-brief" },
        { kind: "board" },
        { kind: "usage" },
      ] as const) {
        await terminal.openView({
          home,
          cwd: record.worktree.path,
          coordinator: record.endpoint,
          view,
        });
        await Bun.sleep(300);
        await shot(`01-before-reset-${view.kind}`);
      }
      const before = await commands.ls(repo);
      const owned = blocks(before).filter(
        (p) => parseBlockArgs(p.block.args)?.ctx.coordinator === record.endpoint.paneId,
      );
      expect(owned.map((p) => p.block.program)).toEqual(
        expect.arrayContaining(["tandem.brief", "tandem.board", "tandem.usage"]),
      );
      await writeFile(join(root, "before.json"), JSON.stringify(before, null, 2));
      await front(["reset", "--yes", "--no-attach"], "reset.json");
      const after = await commands.ls(repo);
      await writeFile(join(root, "after.json"), JSON.stringify(after, null, 2));
      await shot("02-after-reset-relaunch");
      expect(
        blocks(after).some(
          (p) =>
            p.block.id === record.endpoint.paneId || owned.some((o) => o.block.id === p.block.id),
        ),
      ).toBe(false);
      const replacement = (await listCoordinatorRecords(home, env.TANDEM_SESSION))[0];
      expect(replacement?.endpoint.paneId).not.toBe(record.endpoint.paneId);
      await front([repo, "--no-attach"], "reconnect.json");
      await shot("03-reconnected");
      console.log(`Native reset evidence: ${root}`);
    } catch (error) {
      await shot("failure").catch(() => undefined);
      console.error(`Native reset evidence: ${root}`);
      throw error;
    } finally {
      if (window) {
        await ctl("quit").catch(() => undefined);
        if (window.exitCode === null) window.kill("SIGKILL");
        await window.exited;
      }
      daemon.kill("SIGTERM");
      await daemon.exited;
      expect(await readFile(join(home, "settings.toml"), "utf8")).toContain('terminal = "tern"');
    }
  },
  180000,
);
