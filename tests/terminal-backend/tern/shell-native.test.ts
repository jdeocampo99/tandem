import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { quoteShellArgument } from "../../../src/adapters/commands.ts";
import type { CommandRunner, Endpoint } from "../../../src/contracts.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import { TERN_BINARY } from "../../../src/terminal-backend/tern/cli.ts";
import { launchTernWindow } from "./native-window.ts";

const nativeTest = process.env.TANDEM_TERN_NATIVE === "1" ? test : test.skip;

for (const { startupDelay, attachedWindow } of [
  { startupDelay: 0, attachedWindow: false },
  { startupDelay: 0.3, attachedWindow: false },
  { startupDelay: 0.3, attachedWindow: true },
]) {
  nativeTest(
    `fresh Tern shells retain exact context across 20 tabs and 20 splits (startup delay ${startupDelay}s, window ${attachedWindow})`,
    async () => {
      const root = await realpath(await mkdtemp("/tmp/tern-shell-"));
      await mkdir(`${root}/zdot`);
      await mkdir(`${root}/home`);
      await writeFile(
        `${root}/zdot/.zshrc`,
        `/bin/sleep ${startupDelay}\nprintf ready > ${quoteShellArgument(root)}/"$TERN_PANE".ready\n`,
      );
      const environment = {
        HOME: root,
        USER: "tandem-test",
        LOGNAME: "tandem-test",
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
        const timeout = setTimeout(() => child.kill("SIGKILL"), request.timeoutMs ?? 5_000);
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { stdout, stderr, code };
        } finally {
          clearTimeout(timeout);
        }
      };
      const daemon = Bun.spawn(
        [TERN_BINARY, "daemon", "--socket", environment.TERN_DAEMON_SOCKET],
        {
          cwd: root,
          env: environment,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      let window: Bun.Subprocess | undefined;
      const control = `${root}/w.sock`;
      try {
        const deadline = Date.now() + 10_000;
        while ((await run({ argv: [TERN_BINARY, "ls", "--json"], cwd: root })).code !== 0) {
          if (Date.now() >= deadline) throw new Error("isolated daemon did not start");
          await Bun.sleep(50);
        }
        const terminal = ternBackend(run, { binary: TERN_BINARY });
        const session = { sessionId: "synthetic-shell-check", cwd: root };
        const coordinator = await terminal.createWorkspace({
          ...session,
          label: "coordinator",
          role: "coordinator",
          generation: 0,
        });
        if (attachedWindow)
          window = await launchTernWindow({
            binary: TERN_BINARY,
            control,
            args: ["--dir", root],
            env: environment,
            cwd: root,
          });
        const endpoints: Endpoint[] = [];
        for (let index = 0; index < 20; index += 1) {
          const tab = await terminal.createWorkspace({
            ...session,
            label: `tab-${index}`,
            parentWorkspaceId: coordinator.endpoint.workspaceId,
            role: "implementer",
            generation: 0,
          });
          endpoints.push(tab.endpoint);
          endpoints.push(
            await terminal.splitBeside({
              anchor: tab.endpoint,
              cwd: root,
              role: "scout",
              generation: 0,
            }),
          );
          for (const endpoint of endpoints.slice(-2)) {
            // Read only synthetic Tandem context, bypassing runCommand's environment injection.
            const command = `printf '%s\\n' "$TANDEM_SESSION" "$TANDEM_TERN_WORKSPACE_ID" "$TERN_PANE" > ${quoteShellArgument(`${root}/${endpoint.paneId}.context`)}`;
            await run({
              argv: [TERN_BINARY, "run", endpoint.paneId, command, "--json"],
              cwd: root,
            });
          }
        }
        const proofDeadline = Date.now() + 10_000;
        const pending = new Set(endpoints);
        const failures: string[] = [];
        while (pending.size > 0 && Date.now() < proofDeadline) {
          for (const endpoint of pending) {
            let actual: string;
            try {
              actual = await readFile(`${root}/${endpoint.paneId}.context`, "utf8");
            } catch {
              continue;
            }
            if (actual !== `${endpoint.sessionId}\n${endpoint.workspaceId}\n${endpoint.paneId}\n`)
              failures.push(`pane ${endpoint.paneId}: context mismatch`);
            pending.delete(endpoint);
          }
          if (pending.size > 0) await Bun.sleep(50);
        }
        for (const endpoint of pending) failures.push(`pane ${endpoint.paneId}: no context proof`);
        expect(failures).toEqual([]);
        // Prove this profile's controlled startup ran, rather than assuming Tern loads .zshrc.
        for (const endpoint of endpoints)
          expect(await readFile(`${root}/${endpoint.paneId}.ready`, "utf8")).toBe("ready");
      } finally {
        if (window !== undefined) {
          await run({
            argv: [TERN_BINARY, "ctl", "--control", control, "quit"],
            cwd: root,
            timeoutMs: 1_000,
          }).catch(() => undefined);
          window.kill("SIGKILL");
          await window.exited;
        }
        daemon.kill("SIGTERM");
        await daemon.exited;
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
}
