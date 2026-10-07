import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { NativeViewsPublisher } from "../../src/board/native-read.ts";
import { boardView } from "../../src/board/view.ts";
import { maybeShowCatchUp } from "../../src/memory/native-visits.ts";
import { readProjectState, viewIndexPath } from "../../src/native/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend, TerminalView } from "../../src/terminal-backend/contract.ts";
import { state } from "../board/fixtures.ts";
import { viewsWith } from "../terminal-backend/views.ts";
import { seedScenarioTask, withScenario } from "./scenario.ts";

for (const changed of [true, false]) {
  test(`visit before first publication, publish, ${changed ? "change" : "repaint"}, return two hours later ${changed ? "shows catch-up" : "stays quiet"}`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      const endpoint = world.openPane({ paneId: "2001", cwd: world.repoPath });
      const record = {
        repoPath: world.repoPath,
        endpoint: { ...endpoint, role: "coordinator" as const },
        worktree: { path: world.repoPath },
      };
      const opened: TerminalView[] = [];
      const base = terminalBackend(world.run, { terminal: "tern", home: world.home });
      const terminal: TerminalBackend = {
        ...base,
        views: viewsWith(base, {
          open: async (input) => {
            opened.push(input.view);
            return { opened: true, warnings: [] };
          },
        }),
      };
      const input = () => ({ home: world.home, record, now: world.clock() });
      const visitedAt = world.clock();
      const savedVisit = async () => {
        const visit = (await readProjectState(world.home, world.repoPath))?.visit;
        return visit === undefined
          ? undefined
          : {
              lastOpenedAt: visit.lastOpenedAt,
              ...(visit.previousSignature === undefined
                ? {}
                : { previousSignature: visit.previousSignature }),
            };
      };
      const publish = async () => {
        const publisher = new NativeViewsPublisher({
          home: world.home,
          clock: world.clock,
          run: world.run,
          terminal,
        });
        publisher.schedule({
          project: world.repoPath,
          snapshot: {
            version: 1,
            writtenAt: world.clock(),
            board: boardView(state({ projects: [world.repoPath] }), world.clock()),
            coordinators: [],
          },
          sessions: new Map(),
        });
        await publisher.settle();
        const shown = (await readProjectState(world.home, world.repoPath))?.published;
        if (shown === undefined) throw new Error("the publisher stored no publication");
        return shown;
      };

      await expect(stat(viewIndexPath(world.home, world.repoPath))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
      expect(await maybeShowCatchUp(terminal, input())).toBe(false);
      expect(await savedVisit()).toEqual({ lastOpenedAt: visitedAt });
      world.advanceClock(10);
      const first = await publish();
      expect(await savedVisit()).toEqual({
        lastOpenedAt: visitedAt,
        previousSignature: first.changeSignature,
      });
      if (changed) await seedScenarioTask(world, { kind: "scout", stage: "completed" });
      world.advanceClock(10);
      const next = await publish();
      expect(next.changeSignature === first.changeSignature).toBe(!changed);
      expect(await savedVisit()).toEqual({
        lastOpenedAt: visitedAt,
        previousSignature: first.changeSignature,
      });
      world.advanceClock(100);
      expect(await maybeShowCatchUp(terminal, input())).toBe(changed);
      expect(opened).toEqual(changed ? [{ kind: "catchup" }] : []);
    });
  });
}
