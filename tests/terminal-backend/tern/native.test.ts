import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { EndpointBusyError } from "../../../src/adapters/primitives.ts";
import type { CommandRunner } from "../../../src/contracts.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { decode, Listing, TERN_BINARY } from "../../../src/terminal-backend/tern/protocol.ts";

const nativeTest = process.env.TANDEM_TERN_NATIVE === "1" ? test : test.skip;

nativeTest(
  "isolated Tern daemon proves background tabs, busy close, OSC write and last-tab cleanup",
  async () => {
    const root = await realpath(await mkdtemp("/tmp/tern-backend-"));
    await mkdir(`${root}/zdot`);
    await mkdir(`${root}/home`);
    // Only this explicit, non-secret environment reaches the disposable daemon and its shells.
    const environment = {
      HOME: root,
      USER: process.env.USER ?? "tandem-test",
      LOGNAME: process.env.USER ?? "tandem-test",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SHELL: "/bin/zsh",
      ZDOTDIR: `${root}/zdot`,
      TERM: "xterm-256color",
      TERN_CONFIG_DIR: `${root}/config`,
      TERN_DAEMON_SOCKET: `${root}/d.sock`,
      STENCIL_LOG_DIR: `${root}/logs`,
      TANDEM_HOME: `${root}/home`,
    };
    const run: CommandRunner = async (request) => {
      const child = Bun.spawn([...request.argv], {
        cwd: request.cwd,
        env: { ...environment, ...request.env },
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
    const daemon = Bun.spawn([TERN_BINARY, "daemon", "--socket", environment.TERN_DAEMON_SOCKET], {
      cwd: root,
      env: environment,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const result = await run({ argv: [TERN_BINARY, "ls", "--json"], cwd: root });
        if (result.code === 0) {
          expect(decode(result.stdout, Listing, "isolated daemon").sessions).toEqual([]);
          break;
        }
        if (Date.now() >= deadline) throw new Error("isolated Tern daemon did not start");
        await Bun.sleep(50);
      }
      const terminal = ternBackend(run, { binary: TERN_BINARY });
      const session = { sessionId: "native-check", cwd: root };
      const created = await terminal.createWorkspace({
        ...session,
        label: "coordinator",
        role: "coordinator",
        generation: 0,
      });
      const target = { endpoint: created.endpoint, cwd: root };
      const shellDeadline = Date.now() + 5_000;
      for (;;) {
        try {
          await terminal.inspect(target);
          break;
        } catch (error) {
          if (Date.now() >= shellDeadline) throw error;
          await Bun.sleep(50);
        }
      }
      const split = await terminal.splitBeside({
        anchor: created.endpoint,
        cwd: root,
        role: "scout",
        generation: 0,
      });
      const splitTarget = { endpoint: split, cwd: root };
      await terminal.runCommand({ ...splitTarget, command: ["sh", "-c", "sleep 30; read -r x"] });
      const busyDeadline = Date.now() + 5_000;
      while (!(await terminal.inspect(splitTarget)).activeWorker) {
        if (Date.now() >= busyDeadline) throw new Error("sleep did not start");
        await Bun.sleep(50);
      }
      expect(
        (await terminal.inspect(splitTarget)).processInfo.foregroundProcesses.some(
          (entry) => entry.name === "sleep",
        ),
      ).toBe(true);
      await expect(terminal.close(splitTarget)).rejects.toBeInstanceOf(EndpointBusyError);
      await terminal.interrupt(splitTarget);
      await terminal.close(splitTarget);
      const worker = await terminal.createWorkspace({
        ...session,
        label: "worker",
        role: "implementer",
        generation: 0,
        parentWorkspaceId: created.endpoint.workspaceId,
      });
      const listed = await run({ argv: [TERN_BINARY, "ls", "--json"], cwd: root });
      const shown = JSON.parse(listed.stdout) as { sessions: { tabs: { shown: boolean }[] }[] };
      expect(shown.sessions[0]?.tabs.map((tab) => tab.shown)).toEqual([true, false]);
      await terminal.close({ endpoint: worker.endpoint, cwd: root });
      await terminal.notify({ ...session, title: "Done", body: "Tandem isolated native check" });
      await terminal.close(target);
      expect(await terminal.listPanes(session)).toEqual([]);
      expect(await terminal.listWorkspaces(session)).toEqual([]);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
