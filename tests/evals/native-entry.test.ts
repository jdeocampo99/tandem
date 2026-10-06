import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeAlerts, nativeAlertCounts } from "../../src/board/native-alerts.ts";
import { nativeViewText } from "../../src/board/native-views.ts";
import { nativeViewsPath } from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
import { repositoryKey } from "../../src/config/repositories.ts";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runTerminal } from "../../src/main.ts";
import { visitNativeProject } from "../../src/memory/native-visits.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend } from "../../src/terminal-backend/contract.ts";
import { state } from "../board/fixtures.ts";
import { withScenario } from "./scenario.ts";

for (const failure of ["none", "focus", "catchup", "helper-moved"] as const) {
  test(`inbox helper entry proves and focuses its coordinator, reads alerts and runs nonfatal catch-up: ${failure}`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      const lease = await world.grantLease({ name: "coordinator", holder: "coordinator:test" });
      const root = world.openPane({ paneId: "101", cwd: lease.path });
      const helper = world.openPane({ paneId: "102", cwd: lease.path });
      const endpoint = {
        ...root,
        terminalSessionId: "100",
        role: "coordinator" as const,
        notificationPane: {
          paneId: helper.paneId,
          tabId: failure === "helper-moved" ? "9999" : helper.tabId,
          workspaceId: failure === "helper-moved" ? "9999" : helper.workspaceId,
        },
      };
      const command = [
        "omp",
        "--cwd",
        lease.path,
        "--session-dir",
        join(world.home, "conversation"),
      ];
      world.replaceForeground("101", command);
      await saveCoordinatorRecord(world.home, {
        schemaVersion: 1,
        repoPath: world.repoPath,
        endpoint,
        command,
        harness: DEFAULT_HARNESS,
        worktree: lease,
      });
      await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
      await mkdir(join(world.home, "native-views"));
      await writeFile(
        nativeViewsPath(world.home, world.repoPath),
        nativeViewText("panel", {
          version: 1,
          project: world.repoPath,
          writtenAt: new Date().toISOString(),
          changeSignature: "after",
          tasks: {},
          briefs: {},
          pullRequests: {},
          projects: [],
        }),
      );
      const baseline = {
        home: world.home,
        project: world.repoPath,
        signature: "before",
        now: new Date(Date.now() - 2 * 3600000).toISOString(),
      };
      await visitNativeProject(baseline, async () => {});
      const focused: string[] = [];
      let opens = 0;
      const terminal: TerminalBackend = {
        ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
        notify: async () => {},
        focusAgent: async (input) => {
          focused.push(input.paneId);
          expect(input.origin?.paneId).toBe("102");
          expect(input.origin?.windowId).toBe("isolated-window");
          expect(input.originCoordinator).toEqual(endpoint);
          return failure !== "focus";
        },
        openView: async (input) => {
          expect(input.view).toEqual({ kind: "catchup" });
          opens++;
          return { opened: failure !== "catchup", warnings: ["fixture catch-up failure"] };
        },
      };
      const alerts = new NativeAlerts({
        home: world.home,
        clock: world.clock,
        run: world.run,
        terminal,
      });
      const snapshot = {
        version: 1 as const,
        writtenAt: world.clock(),
        coordinators: [],
        board: boardView(state({ projects: [world.repoPath] }), world.clock()),
      };
      await alerts.observe(snapshot, world.repoPath, world.sessionId);
      await alerts.observe(
        {
          ...snapshot,
          board: {
            ...snapshot.board,
            needsYou: [
              {
                key: "brief:1",
                cause: "brief",
                repoPath: world.repoPath,
                project: "fixture",
                mark: "?",
                name: "Approve brief",
                text: "approval needed",
              },
            ],
          },
        },
        world.repoPath,
        world.sessionId,
      );
      const result = await runTerminal(
        [
          "native",
          "project",
          "entry",
          "--pane",
          "102",
          "--cwd",
          lease.path,
          "--window",
          "isolated-window",
        ],
        {
          cwd: world.repoPath,
          processEnvironment: {
            TANDEM_HOME: world.home,
            TANDEM_SESSION: world.sessionId,
            TANDEM_POOL_ROOT: world.poolRoot,
          },
          terminal,
          run: world.run,
          stdout: () => {},
          stderr: () => {},
        },
      );
      expect(result.exitCode).toBe(failure === "focus" || failure === "helper-moved" ? 1 : 0);
      expect(focused).toEqual(failure === "helper-moved" ? [] : ["101"]);
      expect(opens).toBe(failure === "focus" || failure === "helper-moved" ? 0 : 1);
      expect((await nativeAlertCounts(world.home, world.repoPath)).unread).toBe(
        failure === "focus" || failure === "helper-moved" ? 1 : 0,
      );
      const visit = JSON.parse(
        await readFile(
          join(world.home, "native-visits", `${repositoryKey(world.repoPath)}.json`),
          "utf8",
        ),
      );
      expect(visit.previousSignature).toBe(failure === "none" ? "after" : "before");
      if (failure === "none") {
        const path = join(world.home, "native-visits", `${repositoryKey(world.repoPath)}.json`);
        const saved = await readFile(path, "utf8");
        const inode = (await lstat(path)).ino;
        const viewPath = nativeViewsPath(world.home, world.repoPath);
        const view = await readFile(viewPath, "utf8");
        const viewInode = (await lstat(viewPath)).ino;
        for (let heartbeat = 0; heartbeat < 2; heartbeat++) {
          const pulse = await runTerminal(
            ["native", "project", "visible", "--pane", "101", "--cwd", lease.path],
            {
              cwd: world.repoPath,
              processEnvironment: {
                TANDEM_HOME: world.home,
                TANDEM_SESSION: world.sessionId,
                TANDEM_POOL_ROOT: world.poolRoot,
              },
              terminal,
              run: world.run,
              stdout: () => {},
              stderr: () => {},
            },
          );
          expect(pulse.exitCode).toBe(0);
          expect(await readFile(path, "utf8")).toBe(saved);
          expect((await lstat(path)).ino).toBe(inode);
          expect(await readFile(viewPath, "utf8")).toBe(view);
          expect((await lstat(viewPath)).ino).toBe(viewInode);
        }
      }
    });
  });
}
