import { expect, test } from "bun:test";
import { nativeDetailPath, nativeViewsPath } from "../../src/board/snapshot.ts";
import type { CommandRunner } from "../../src/contracts.ts";
import { launchCoordinator } from "../../src/coordinator/launch.ts";
import { listCoordinatorRecords } from "../../src/coordinator/registry.ts";
import { resetCoordinators } from "../../src/coordinator/reset.ts";
import { listCoordinatorQuarantineRecords } from "../../src/coordinator/resources.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { withScenario } from "./scenario.ts";

for (const mode of [
  "reset-relaunch",
  "busy-view",
  "changed-args",
  "unknown-close",
  "foreign-file",
] as const) {
  test(`Tern reset ${mode} retires only proven idle coordinator views`, async () => {
    await withScenario({ terminal: "tern", retainEmptyTernSessions: true }, async (world) => {
      let closing = false;
      let viewProcessRead = false;
      const run: CommandRunner = async (request) => {
        if (request.argv[1] === "process" && request.argv[2] === "9001") viewProcessRead = true;
        const result = await world.run(request);
        if (request.argv[1] === "close" && request.argv[2] === "9002" && mode === "unknown-close")
          return { code: 1, stdout: "", stderr: "lost acknowledgement" };
        if (closing && request.argv[1] === "ls" && viewProcessRead && mode === "changed-args")
          return {
            ...result,
            stdout: result.stdout
              .replace('"reset-brief', '"foreign-brief')
              .replace("brief-reset.json", "brief-foreign.json"),
          };
        return result;
      };
      const terminal = terminalBackend(run, { home: world.home, terminal: "tern" });
      const launch = () =>
        launchCoordinator(
          {
            cwd: world.repoPath,
            repo: world.repoPath,
            home: world.home,
            poolRoot: world.poolRoot,
            sessionId: world.sessionId,
            model: undefined,
            continueSession: false,
            headless: true,
            noAttach: true,
          },
          {
            run,
            terminal,
            startPersistent: async () => undefined,
            runInteractive: async () => {
              throw new Error("interactive launch forbidden");
            },
            sleep: async () => {},
            processEnvironment: {},
          },
        );
      await launch();
      const record = (await listCoordinatorRecords(world.home, world.sessionId))[0];
      if (!record || record.endpoint.terminalSessionId === undefined)
        throw new Error("missing coordinator identity");
      const index = nativeViewsPath(world.home, world.repoPath);
      const views = [
        "brief",
        "board",
        "usage",
        "panel",
        "task",
        "pr",
        "welcome",
        "task-picker",
        "prs",
        "catchup",
      ];
      for (const [i, kind] of views.entries()) {
        const file = ["brief", "task", "pr"].includes(kind)
          ? nativeDetailPath(world.home, world.repoPath, `${kind}-reset.json`)
          : index;
        world.openPane({
          paneId: String(9001 + i),
          cwd: record.worktree.path,
          blockProgram: `tandem.${kind}`,
          terminalSessionId: record.endpoint.terminalSessionId,
          blockArgs: [
            mode === "foreign-file" && kind === "brief" ? "/foreign/brief-reset.json" : file,
            record.endpoint.paneId,
            record.worktree.path,
            "",
            index,
          ],
          ...(["board", "usage", "catchup"].includes(kind) ? {} : { anchor: record.endpoint }),
        });
      }
      // Root views get separate tabs, but remain in the recorded native session.
      const unrelated = world.openPane({
        paneId: "9900",
        cwd: record.worktree.path,
        anchor: record.endpoint,
      });
      world.titlePane(unrelated.paneId, "Tandem usage");
      if (mode === "busy-view") world.replaceForeground("9001", ["sh", "foreign-job.sh"]);
      closing = true;
      const reset = () =>
        resetCoordinators(run, terminal, {
          home: world.home,
          sessionId: world.sessionId,
          repoPaths: [world.repoPath],
          force: true,
        });
      if (mode === "reset-relaunch") {
        expect(await reset()).toHaveLength(1);
        for (let i = 0; i < views.length; i++)
          expect(world.paneIsPresent(String(9001 + i))).toBe(false);
        expect(world.paneIsPresent(record.endpoint.paneId)).toBe(false);
        await launch();
        const replacement = (await listCoordinatorRecords(world.home, world.sessionId))[0];
        expect(replacement?.endpoint.paneId).not.toBe(record.endpoint.paneId);
      } else {
        await expect(reset()).rejects.toThrow();
        expect(world.paneIsPresent(record.endpoint.paneId)).toBe(mode !== "unknown-close");
        if (mode === "unknown-close") {
          expect(await listCoordinatorQuarantineRecords(world.home)).toHaveLength(1);
          // A new adapter process must also obey the durable quarantine.
          const fresh = terminalBackend(run, { home: world.home, terminal: "tern" });
          await expect(
            fresh.close({ endpoint: record.endpoint, cwd: record.worktree.path }),
          ).rejects.toThrow("quarantine");
          expect(world.paneIsPresent("9003")).toBe(true);
        } else expect(world.trace().filter((e) => e.action === "tern close")).toHaveLength(0);
      }
      expect(world.paneIsPresent(unrelated.paneId)).toBe(true);
    });
  });
}

for (const evidence of ["changed", "ambiguous"] as const) {
  test(`reset then relaunch ${evidence} leader evidence preserves exact ownership and quarantine`, async () => {
    await withScenario({ terminal: "tern", retainEmptyTernSessions: true }, async (world) => {
      let relaunching = false;
      let staleSnapshot = false;
      const run: CommandRunner = async (request) => {
        const result = await world.run(request);
        if (
          relaunching &&
          (!staleSnapshot || evidence === "ambiguous") &&
          request.argv[1] === "process" &&
          result.stdout.includes("--session-dir")
        ) {
          staleSnapshot = true;
          // The daemon captured the pre-exec leader argv. Native group evidence and
          // the next daemon read expose its completed exec, with the same exact pane.
          return {
            ...result,
            stdout: result.stdout.replace(/("foreground":\{[^}]*"argv":\[)/u, '$1"env",'),
          };
        }
        return result;
      };
      const terminal = terminalBackend(run, { home: world.home, terminal: "tern" });
      const launch = () =>
        launchCoordinator(
          {
            cwd: world.repoPath,
            repo: world.repoPath,
            home: world.home,
            poolRoot: world.poolRoot,
            sessionId: world.sessionId,
            model: undefined,
            continueSession: false,
            headless: true,
            noAttach: true,
          },
          {
            run,
            terminal,
            startPersistent: async () => undefined,
            runInteractive: async () => {
              throw new Error("unexpected interactive launch");
            },
            sleep: async () => {},
            processEnvironment: {},
          },
        );
      const first = await launch();
      await resetCoordinators(run, terminal, {
        home: world.home,
        sessionId: world.sessionId,
        repoPaths: [world.repoPath],
        force: true,
      });
      relaunching = true;
      if (evidence === "changed") {
        const second = await launch();
        expect(second.paneId).not.toBe(first.paneId);
        expect(await listCoordinatorQuarantineRecords(world.home)).toEqual([]);
      } else {
        await expect(launch()).rejects.toThrow("disagree");
        expect(await listCoordinatorQuarantineRecords(world.home)).toHaveLength(1);
      }
      expect(staleSnapshot).toBe(true);
    });
  });
}
