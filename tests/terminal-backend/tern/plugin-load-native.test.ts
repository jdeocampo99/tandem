import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeViewText } from "../../../src/board/native-views.ts";
import { nativeViewsPath } from "../../../src/board/snapshot.ts";
import type { CommandRunner } from "../../../src/contracts.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { panelFixture } from "./panel-fixture.ts";

const enabled = process.platform === "darwin" && process.env.TANDEM_TERN_LOAD_NATIVE === "1";
(enabled ? test : test.skip)(
  "cold host/window LOAD has headroom under CPU load and opens a real native panel",
  async () => {
    const root = await realpath(await mkdtemp("/tmp/td69-load-"));
    const home = join(root, "home"),
      plugin = join(root, "plugin"),
      control = join(root, "w.sock");
    const binary = Bun.which("tern") ?? "/Applications/Tern.app/Contents/MacOS/tern";
    const env = {
      HOME: root,
      USER: "tandem-test",
      LOGNAME: "tandem-test",
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      ZDOTDIR: join(root, "zdot"),
      TERN_CONFIG_DIR: join(root, "config"),
      TERN_DAEMON_SOCKET: join(root, "d.sock"),
      TANDEM_HOME: home,
      STENCIL_LOG_DIR: join(root, "logs"),
    };
    await Promise.all(
      [home, env.ZDOTDIR, env.TERN_CONFIG_DIR, join(root, "shots")].map((p) => mkdir(p)),
    );
    await cp(fileURLToPath(new URL("../../../tern-plugin", import.meta.url)), plugin, {
      recursive: true,
    });
    await writeFile(
      join(env.TERN_CONFIG_DIR, "settings.json"),
      '{"tabs_autohide":true,"layout":"rail"}',
    );
    const entries = Object.fromEntries(
      await Promise.all(
        ["host", "window"].map(
          async (name) => [name, await readFile(join(plugin, `${name}.luau`), "utf8")] as const,
        ),
      ),
    );
    const instrument = async (sample: number) => {
      for (const name of ["host", "window"]) {
        // Cold require includes production entrypoint compilation and execution.
        // The small measuring wrapper compilation is excluded; write AFTER LOAD.
        const path = join(root, `${name}-${sample}.json`);
        await writeFile(join(plugin, `measured-${name}.luau`), `${entries[name]}\nreturn true\n`);
        await writeFile(
          join(plugin, `${name}.luau`),
          `local started = os.clock()\nrequire("./measured-${name}")\nlocal elapsed = (os.clock() - started) * 1000\ntern.timer(1, function() tern.fs.write(${JSON.stringify(path)}, tern.json.encode({ms=elapsed})) end)\n`,
        );
      }
    };
    await instrument(0);
    const run: CommandRunner = async (request) => {
      const child = Bun.spawn([...request.argv], {
        cwd: request.cwd,
        env: { ...env, ...request.env },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const checked = async (...args: string[]) => {
      const result = await run({ argv: [binary, ...args], cwd: root });
      if (result.code !== 0) throw new Error(`${args[0]}: ${result.stderr || result.stdout}`);
      return result.stdout;
    };
    const ctl = (...args: string[]) => checked("ctl", "--control", control, ...args);
    const until = async (condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 15000;
      while (!(await condition().catch(() => false))) {
        if (Date.now() > deadline) throw new Error(`Native load proof timed out: ${root}`);
        await Bun.sleep(50);
      }
    };
    const busy = Array.from({ length: 4 }, () =>
      Bun.spawn(["/usr/bin/yes"], { stdout: "ignore", stderr: "ignore" }),
    );
    const daemon = Bun.spawn([binary, "daemon", "--socket", env.TERN_DAEMON_SOCKET], {
      cwd: root,
      env,
      stdout: "ignore",
      stderr: Bun.file(join(root, "daemon.log")),
    });
    let window: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await until(async () => {
        await checked("ls", "--json");
        return true;
      });
      await checked("plugin", "link", plugin, "--json");
      window = Bun.spawn(
        [binary, "--control", control, "--dir", root, "--out", join(root, "shots")],
        { cwd: root, env, stdout: "ignore", stderr: Bun.file(join(root, "window.log")) },
      );
      await until(async () => {
        await ctl("state");
        return true;
      });
      await ctl("account", "signed-in");
      const samples: { host: number[]; window: number[] } = { host: [], window: [] };
      for (let sample = 0; sample < 50; sample++) {
        if (sample > 0) {
          await instrument(sample);
          await checked("plugin", "reload", "--json");
        }
        for (const name of ["host", "window"] as const) {
          const path = join(root, `${name}-${sample}.json`);
          await until(async () => {
            await readFile(path, "utf8");
            return true;
          });
          const value: unknown = JSON.parse(await readFile(path, "utf8"));
          if (
            typeof value !== "object" ||
            value === null ||
            !("ms" in value) ||
            typeof value.ms !== "number"
          )
            throw new Error("Invalid timing sample");
          samples[name].push(value.ms);
        }
      }
      const summarize = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          n: values.length,
          p50: sorted[Math.ceil(values.length * 0.5) - 1],
          p95: sorted[Math.ceil(values.length * 0.95) - 1],
          max: sorted.at(-1),
        };
      };
      const summary = { host: summarize(samples.host), window: summarize(samples.window) };
      await writeFile(
        join(root, "timings.json"),
        JSON.stringify(
          {
            binary: await checked("--version"),
            cpuLoadProcesses: busy.length,
            measurement:
              "cold require wall time including production entrypoint compilation/execution; excludes measuring wrapper compilation; fresh plugin VM on each reload",
            summary,
            samples,
          },
          null,
          2,
        ),
      );
      console.log(`Native load evidence: ${root}\n${JSON.stringify(summary)}`);
      expect(summary.host.p95).toBeLessThan(15);
      expect(summary.window.p95).toBeLessThan(15);
      // Reload the UNINSTRUMENTED production plugin and prove its routes/blocks under the same load.
      for (const name of ["host", "window"])
        await writeFile(join(plugin, `${name}.luau`), entries[name] as string);
      await checked("plugin", "reload", "--json");
      // Verify INITIAL window load of production code, apart from the reload benchmark.
      await ctl("quit");
      if (window.exitCode === null) window.kill();
      await window.exited;
      window = Bun.spawn(
        [binary, "--control", control, "--dir", root, "--out", join(root, "shots")],
        { cwd: root, env, stdout: "ignore", stderr: Bun.file(join(root, "proof-window.log")) },
      );
      await until(async () => {
        await ctl("state");
        return true;
      });
      await ctl("account", "signed-in");
      const terminal = ternBackend(run, { home, environment: env });
      const coordinator = (
        await terminal.createWorkspace({
          sessionId: "fixture",
          cwd: root,
          role: "coordinator",
          generation: 0,
          label: "coordinator · tandem",
        })
      ).endpoint;
      await terminal.focusWorkspace({
        sessionId: "fixture",
        cwd: root,
        workspaceId: coordinator.workspaceId,
      });
      await until(async () => (await ctl("tree")).includes("coordinator · tandem"));
      await mkdir(join(home, "native-views"));
      const panel = panelFixture(root);
      await writeFile(
        nativeViewsPath(home, root),
        nativeViewText("panel", {
          version: 1,
          project: root,
          writtenAt: new Date().toISOString(),
          panel,
          projects: panel.header.projects,
          tasks: {},
          briefs: {},
          pullRequests: {},
          warnings: [],
        }),
      );
      const opened = await terminal.openPanel({ coordinator, cwd: root, project: root });
      await writeFile(join(root, "panel-open.json"), JSON.stringify(opened));
      await writeFile(join(root, "panel-list.json"), await checked("ls", "--json"));
      await writeFile(join(root, "panel-initial-tree.json"), await ctl("tree"));
      await ctl("shot", "panel-initial");
      expect(typeof opened).toBe("string");
      await until(async () => (await ctl("tree")).includes("Tern backend adapter"));
      const tree = await ctl("tree");
      await writeFile(join(root, "panel-tree.json"), tree);
      expect(tree).toContain("Needs you");
      expect(tree).toContain("Ready");
      await ctl("shot", "panel-under-cpu-load");
      await ctl("palette", "Tandem");
      // Search highlights split the matched prefix into nodes; assert the stable suffixes.
      await until(async () => (await ctl("tree")).includes("New request"));
      const palette = await ctl("tree");
      for (const title of ["New request", "Open task", "Toggle board", "Show PRs", "Usage"]) {
        expect(palette).toContain(title);
      }
      await writeFile(join(root, "palette-tree.json"), palette);
      await ctl("shot", "palette-under-cpu-load");
      const logs =
        (await readFile(join(root, "daemon.log"), "utf8")) +
        (await readFile(join(root, "window.log"), "utf8")) +
        (await readFile(join(root, "proof-window.log"), "utf8"));
      expect(logs).not.toContain("exceeded its 50 ms");
    } finally {
      for (const process of busy) process.kill();
      await Promise.all(busy.map((process) => process.exited));
      if (window) {
        await ctl("quit").catch(() => undefined);
        if (window.exitCode === null) window.kill();
        await window.exited;
      }
      daemon.kill();
      await daemon.exited;
      // Keep this isolated home and screenshots for reviewer inspection.
    }
  },
  180000,
);
