import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { quoteShellCommand } from "../../../src/adapters/commands.ts";
import { EndpointBusyError } from "../../../src/adapters/primitives.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import {
  probeTern,
  ternBackend,
  ternNotificationEndpoint,
} from "../../../src/terminal-backend/tern/backend.ts";
import { paneMutation } from "../../../src/terminal-backend/tern/endpoints.ts";
import {
  decode,
  Listing,
  TERN_BINARY,
  TernOutcomeUnknownError,
  ternCommands,
} from "../../../src/terminal-backend/tern/protocol.ts";

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
      expect(await probeTern(run, { binary: TERN_BINARY, cwd: root })).toEqual({ status: "ready" });
      const commands = ternCommands(run, { binary: TERN_BINARY });
      const assertCreatedContext = async (endpoint: Endpoint) => {
        const contextTarget = { endpoint, cwd: root };
        // Let the created shell expand only these synthetic identity variables into exact argv.
        // This bypasses runCommand's env injection and writes no environments to fixtures.
        const command = `${quoteShellCommand(["/bin/sh", "-c", "read -r x"])} "$TANDEM_SESSION" "$TANDEM_TERN_WORKSPACE_ID" "$TERN_PANE"`;
        await paneMutation(commands, contextTarget, ["run", endpoint.paneId, command]);
        const deadline = Date.now() + 5_000;
        for (;;) {
          const process = (
            await terminal.inspect(contextTarget)
          ).processInfo.foregroundProcesses.find((entry) => entry.argv.includes("read -r x"));
          if (process !== undefined) {
            expect(process.argv.slice(-3)).toEqual([
              endpoint.sessionId,
              endpoint.workspaceId,
              endpoint.paneId,
            ]);
            break;
          }
          if (Date.now() >= deadline) throw new Error("created-shell context proof did not start");
          await Bun.sleep(50);
        }
        await terminal.interrupt(contextTarget);
      };
      const session = { sessionId: "native-check", cwd: root };
      const created = await terminal.createWorkspace({
        ...session,
        label: "coordinator",
        role: "coordinator",
        generation: 0,
        env: {
          TANDEM_SESSION: "stale-daemon",
          TANDEM_TERN_WORKSPACE_ID: "stale-tab",
          TERN_PANE: "stale-pane",
        },
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
      await assertCreatedContext(created.endpoint);
      const split = await terminal.splitBeside({
        anchor: created.endpoint,
        cwd: root,
        role: "scout",
        generation: 0,
      });
      const splitTarget = { endpoint: split, cwd: root };
      await assertCreatedContext(split);
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
      expect(shown.sessions[0]?.tabs.map((tab) => tab.shown)).toEqual([true, false, false]);
      await assertCreatedContext(worker.endpoint);
      await terminal.close({ endpoint: worker.endpoint, cwd: root });
      await ternBackend(run, {
        binary: TERN_BINARY,
        notificationEndpoint: async () => ternNotificationEndpoint(created.endpoint),
      }).notify({ ...session, title: "Done", body: "Tandem isolated native check" });
      await expect(terminal.close(target)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
      await expect(terminal.close(target)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
      expect(await terminal.listPanes(session)).toEqual([]);
      expect(await terminal.listWorkspaces(session)).toEqual([]);
      const relaunched = await ternBackend(run, { binary: TERN_BINARY }).createWorkspace({
        ...session,
        label: "coordinator relaunched",
        role: "coordinator",
        generation: 0,
        previousEndpoint: created.endpoint,
      });
      expect(relaunched.endpoint.terminalSessionId).toBe(created.endpoint.terminalSessionId);
      await expect(
        terminal.close({ endpoint: relaunched.endpoint, cwd: root }),
      ).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
