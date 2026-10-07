import { expect, test } from "bun:test";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NativeAlerts } from "../../src/board/native-alerts.ts";
import { boardView } from "../../src/board/view.ts";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runTerminal } from "../../src/main.ts";
import { Outcome } from "../../src/native/envelope.ts";
import {
  nativeAlertCounts,
  projectStoreDirectory,
  recordVisit,
  viewIndexPath,
} from "../../src/native/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend } from "../../src/terminal-backend/contract.ts";
import { state } from "../board/fixtures.ts";
import { publishFixture, savedState } from "../native/view-files.ts";
import { viewsWith } from "../terminal-backend/views.ts";
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
      await publishFixture(world.home, world.repoPath, { changeSignature: "after" });
      const baseline = {
        kind: "entry" as const,
        signature: "before",
        now: new Date(Date.now() - 2 * 3600000).toISOString(),
        showCatchUp: async () => {},
      };
      await recordVisit(world.home, world.repoPath, baseline);
      const focused: string[] = [];
      let opens = 0;
      const base = terminalBackend(world.run, { terminal: "tern", home: world.home });
      const terminal: TerminalBackend = {
        ...base,
        notify: async () => {},
        focusAgent: async (input) => {
          focused.push(input.paneId);
          expect(input.origin?.paneId).toBe("102");
          expect(input.origin?.windowId).toBe("isolated-window");
          expect(input.originCoordinator).toEqual(endpoint);
          return failure !== "focus";
        },
        views: viewsWith(base, {
          open: async (input) => {
            expect(input.view).toEqual({ kind: "catchup" });
            opens++;
            return { opened: failure !== "catchup", warnings: ["fixture catch-up failure"] };
          },
        }),
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
      const output: string[] = [];
      const result = await runTerminal(["native", "act"], {
        input: Readable.from([
          JSON.stringify({
            v: 1,
            origin: { pane: "102", cwd: lease.path, window: "isolated-window" },
            action: { verb: "visit", event: "entry" },
          }),
        ]),
        cwd: world.repoPath,
        processEnvironment: {
          TANDEM_HOME: world.home,
          TANDEM_SESSION: world.sessionId,
          TANDEM_POOL_ROOT: world.poolRoot,
        },
        terminal,
        run: world.run,
        stdout: (text) => output.push(text),
        stderr: () => {},
      });
      expect(result.exitCode).toBe(0);
      const outcome = Outcome.parse(JSON.parse(output.join("")));
      expect(outcome.status).toBe(
        failure === "focus" || failure === "helper-moved" ? "refused" : "done",
      );
      expect(focused).toEqual(failure === "helper-moved" ? [] : ["101"]);
      expect(opens).toBe(failure === "focus" || failure === "helper-moved" ? 0 : 1);
      if (failure === "catchup")
        expect(outcome.notice).toEqual({
          code: "catch-up-unavailable",
          text: "Project opened, but catch-up is unavailable: fixture catch-up failure",
        });
      expect((await nativeAlertCounts(world.home, world.repoPath)).unread).toBe(
        failure === "focus" || failure === "helper-moved" ? 1 : 0,
      );
      const visit = (await savedState(world.home, world.repoPath))?.visit;
      expect(visit?.previousSignature).toBe(failure === "none" ? "after" : "before");
      if (failure === "none") {
        const lastVisibleAt = new Date(Date.now() - 120_000).toISOString();
        await recordVisit(world.home, world.repoPath, {
          ...baseline,
          signature: "after",
          now: lastVisibleAt,
        });
        const path = join(projectStoreDirectory(world.home, world.repoPath), "state.json");
        let saved = await readFile(path, "utf8");
        let inode = (await lstat(path)).ino;
        const viewPath = viewIndexPath(world.home, world.repoPath);
        const view = await readFile(viewPath, "utf8");
        const viewInode = (await lstat(viewPath)).ino;
        for (let heartbeat = 0; heartbeat < 2; heartbeat++) {
          const pulsed: string[] = [];
          const pulse = await runTerminal(["native", "act"], {
            input: Readable.from([
              JSON.stringify({
                v: 1,
                origin: { pane: "101", cwd: lease.path },
                action: { verb: "visit", event: "visible" },
              }),
            ]),
            cwd: world.repoPath,
            processEnvironment: {
              TANDEM_HOME: world.home,
              TANDEM_SESSION: world.sessionId,
              TANDEM_POOL_ROOT: world.poolRoot,
            },
            terminal,
            run: world.run,
            stdout: (text) => pulsed.push(text),
            stderr: () => {},
          });
          expect(pulse.exitCode).toBe(0);
          expect(Outcome.parse(JSON.parse(pulsed.join(""))).status).toBe("done");
          if (heartbeat === 0) {
            const advanced = await readFile(path, "utf8");
            expect(Date.parse(JSON.parse(advanced).visit.lastVisibleAt)).toBeGreaterThan(
              Date.parse(lastVisibleAt),
            );
            expect(JSON.parse(advanced).visit.previousSignature).toBe("after");
            saved = advanced;
            inode = (await lstat(path)).ino;
          }
          expect(await readFile(path, "utf8")).toBe(saved);
          expect((await lstat(path)).ino).toBe(inode);
          expect(await readFile(viewPath, "utf8")).toBe(view);
          expect((await lstat(viewPath)).ino).toBe(viewInode);
        }
      }
    });
  });
}
