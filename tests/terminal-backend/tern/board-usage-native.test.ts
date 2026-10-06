import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeViewText } from "../../../src/board/native-views.ts";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { maybeShowCatchUp, visitNativeProject } from "../../../src/memory/native-visits.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { blocks, Created, decode, Listing } from "../../../src/terminal-backend/tern/protocol.ts";
import { nativeScreensFixture } from "../../tern-view/screens-fixture.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_NATIVE_TEST === "1";
(enabled ? test : test.skip)(
  "native board, usage and catch-up draw live files and shell out once with their exact context",
  async () => {
    const root = await realpath(await mkdtemp("/tmp/tdm-screens-"));
    const plugin = join(root, "plugin");
    const config = join(root, "config");
    const control = join(root, "w.sock");
    const home = join(root, "home");
    const project = join(root, "repo");
    const path = nativeViewsPath(home, project);
    const log = join(root, "actions.log");
    const fail = join(root, "fail-action");
    const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
    const env = {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.USER,
      PATH: process.env.PATH,
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      ZDOTDIR: join(root, "zdot"),
      TERN_CONFIG_DIR: config,
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: home,
      STENCIL_LOG_DIR: join(root, "logs"),
    };
    await Promise.all([mkdir(config), mkdir(home), mkdir(project), mkdir(env.ZDOTDIR)]);
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    await mkdir(join(home, "native-views"));
    await writeFile(path, nativeViewText("panel", { ...nativeScreensFixture(), project }), {
      mode: 0o600,
    });
    await writeFile(
      join(plugin, "tandem.sh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nif [ -f '${fail}' ]; then printf 'isolated action failure\\n' >&2; exit 1; fi\n`,
    );
    const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      env,
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    let window: ReturnType<typeof Bun.spawn> | undefined;
    const runner: CommandRunner = async (request) => {
      const child = Bun.spawn([...request.argv], {
        env,
        cwd: request.cwd ?? root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 6000);
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(timer);
      return { stdout, stderr, code };
    };
    const run = async (...args: string[]) => {
      const result = await runner({ argv: [binary, ...args], cwd: project });
      if (result.code !== 0) throw new Error(`Tern ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    const backend = ternBackend(runner, { binary, home });
    const until = async (action: () => Promise<boolean>) => {
      const deadline = Date.now() + 10000;
      while (!(await action().catch(() => false))) {
        if (Date.now() >= deadline) throw new Error("native screens check timed out");
        await Bun.sleep(50);
      }
    };
    const ctl = (...args: string[]) => run("ctl", "--control", control, ...args);
    try {
      await until(async () => {
        await run("ls", "--json");
        return true;
      });
      await run("plugin", "link", plugin, "--json");
      const catalog = JSON.parse(await run("plugin", "list", "--json"));
      expect(
        catalog.plugins.find((p: { id: string }) => p.id === "tandem")?.status,
        JSON.stringify(catalog),
      ).toBe("ready");
      const created = decode(
        await run("new", "session", "native-screens-check", "--cwd", project, "--json"),
        Created,
        "fixture session",
      );
      const coordinator: Endpoint = {
        terminal: "tern",
        sessionId: "isolated",
        terminalSessionId: created.session,
        workspaceId: created.tab,
        tabId: created.tab,
        paneId: created.block,
        role: "coordinator",
        generation: 0,
      };
      await saveCoordinatorRecord(home, {
        schemaVersion: 1,
        repoPath: project,
        endpoint: coordinator,
        command: ["omp", "--cwd", project, "--session-dir", join(home, "conversation")],
        harness: DEFAULT_HARNESS,
        worktree: {
          root: project,
          path: project,
          name: "coordinator",
          baseHead: "a".repeat(40),
          branch: "fixture",
          leaseId: "fixture-lease",
          leaseHolder: "fixture",
          leasedAt: "2030-01-02T12:00:00Z",
        },
      });
      const origin = { paneId: coordinator.paneId, cwd: project };
      window = Bun.spawn(
        [
          binary,
          "--control",
          control,
          "--dir",
          root,
          "--out",
          process.env.TANDEM_TERN_SHOTS ?? join(root, "shots"),
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
      const shots = process.env.TANDEM_TERN_SHOTS;
      if (shots) await mkdir(shots, { recursive: true });
      let actionCount = 0;
      for (const [kind, expected] of [
        ["board", "Ready to merge"],
        ["usage", "cost today"],
        ["catchup", "Where we left off"],
      ] as const) {
        expect(
          (await backend.openView({ coordinator, cwd: project, home, origin, view: { kind } }))
            .opened,
        ).toBe(true);
        const viewPane = blocks(decode(await run("ls", "--json"), Listing, "fixture listing")).find(
          (entry) => entry.block.program === `tandem.${kind}`,
        )?.block.id;
        if (!viewPane) throw new Error("native view pane missing");
        await until(async () => (await ctl("tree")).includes(expected));
        const tree = await ctl("tree");
        if (kind === "board") {
          expect(tree).toContain("stuck");
          expect(tree).toContain("#281 draft");
          expect(tree).toContain("same 2 problems twice");
        }
        if (kind === "usage") {
          expect(tree).toContain("62% left");
          expect(tree).toContain("2h 14m");
          expect(tree).toContain("$21.40");
        }
        if (shots) {
          await Bun.sleep(200);
          console.log(await ctl("shot", kind));
        }
        if (kind === "catchup") await writeFile(fail, "fail");
        await ctl("key", "escape");
        actionCount += 1;
        await until(
          async () => (await readFile(log, "utf8")).match(/--pane/g)?.length === actionCount,
        );
        if (kind === "catchup") {
          await until(async () => (await ctl("tree")).includes("isolated action failure"));
          await Bun.sleep(100);
          expect((await readFile(log, "utf8")).match(/--pane/g)?.length).toBe(actionCount);
          await rm(fail);
        }
        await until(async () =>
          (await readFile(log, "utf8")).includes(
            kind === "catchup" ? "catchup-dismiss" : `${path}#orchestrator`,
          ),
        );
        if (kind === "catchup") {
          await writeFile(
            path,
            '{"version":1,"kind":"panel","revision":"broken","model":{"catchup":{"merged":[{}]}}}',
          );
          await until(async () => (await ctl("tree")).includes("View unavailable"));
          expect(await ctl("tree")).toContain("Fix panel width");
          expect(await ctl("tree")).not.toContain("Open what needs me");
        }
        // Real hosting proves toggle/return close only the exact view and preserve the coordinator.
        expect(
          (
            await backend.openView({
              coordinator,
              cwd: project,
              home,
              origin: { paneId: viewPane, cwd: project },
              view: { kind: kind === "board" ? "board" : "orchestrator" },
            })
          ).opened,
        ).toBe(true);
        const remaining = blocks(decode(await run("ls", "--json"), Listing, "fixture return"));
        expect(remaining.some((entry) => entry.block.id === viewPane)).toBe(false);
        expect(remaining.some((entry) => entry.block.id === coordinator.paneId)).toBe(true);
      }
      await writeFile(path, nativeViewText("panel", { ...nativeScreensFixture(), project }));
      await visitNativeProject(
        {
          home,
          project,
          now: new Date(Date.now() - 2 * 3600000).toISOString(),
          signature: "before-changes",
        },
        async () => {
          throw new Error("First visit cannot show catch-up");
        },
      );
      expect(
        await maybeShowCatchUp(backend, {
          home,
          record: { repoPath: project, endpoint: coordinator, worktree: { path: project } },
        }),
      ).toBe(true);
      await until(async () => (await ctl("tree")).includes("Where we left off"));
      const catchupPane = blocks(
        decode(await run("ls", "--json"), Listing, "automatic catch-up"),
      ).find((entry) => entry.block.program === "tandem.catchup")?.block.id;
      if (!catchupPane) throw new Error("Automatic catch-up did not create its view");
      expect(
        (
          await backend.openView({
            coordinator,
            cwd: project,
            home,
            origin: { paneId: catchupPane, cwd: project },
            view: { kind: "orchestrator" },
          })
        ).opened,
      ).toBe(true);
      expect(
        await maybeShowCatchUp(backend, {
          home,
          record: { repoPath: project, endpoint: coordinator, worktree: { path: project } },
        }),
      ).toBe(false);
      expect(
        blocks(decode(await run("ls", "--json"), Listing, "quiet reopen")).some(
          (entry) => entry.block.program === "tandem.catchup",
        ),
      ).toBe(false);
      const browser = await backend.openView({
        coordinator,
        cwd: project,
        home,
        origin,
        view: { kind: "browser", url: "https://example.invalid/pull/281" },
      });
      expect(browser.opened).toBe(true);
      const actions = await readFile(log, "utf8");
      expect(actions.match(/--pane/g)?.length).toBe(3);
      expect(actions).toContain(`--cwd\n${project}`);
    } catch (error) {
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
