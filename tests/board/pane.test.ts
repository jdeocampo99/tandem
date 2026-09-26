import { expect, test } from "bun:test";
import { quoteShellCommand } from "../../src/adapters/commands.ts";
import { closeEndpoint } from "../../src/adapters/herdr.ts";
import { liveStatusCommand, showBoardPane } from "../../src/board/pane.ts";
import type { CommandRequest } from "../../src/contracts.ts";
import { withScenario } from "../evals/scenario.ts";

test("the board opens once beside the coordinator and again only after its pane is gone", async () => {
  await withScenario({}, async (world) => {
    const coordinator = world.openPane({ paneId: "pane-coordinator", cwd: world.repoPath });
    const calls: CommandRequest[] = [];
    const deps = {
      run: async (request: CommandRequest) => {
        calls.push(request);
        return world.run(request);
      },
      home: world.home,
      sessionId: world.sessionId,
      coordinatorPaneId: coordinator.paneId,
    };
    const herdr = (verb: string) =>
      calls.filter((call) => call.argv[0] === "herdr" && call.argv[4] === verb);

    const shown = await showBoardPane(deps, world.repoPath, undefined);
    expect(shown.paneId).not.toBe(coordinator.paneId);
    expect(shown.workspaceId).toBe(coordinator.workspaceId);
    expect(herdr("run").map((call) => call.argv.slice(5))).toEqual([
      [shown.paneId, quoteShellCommand(liveStatusCommand(world.home))],
    ]);

    expect(await showBoardPane(deps, world.repoPath, shown)).toEqual(shown);
    expect(herdr("split")).toHaveLength(1);

    await closeEndpoint(world.run, { endpoint: shown, cwd: world.repoPath, force: true });
    const reopened = await showBoardPane(deps, world.repoPath, shown);
    expect(reopened.paneId).not.toBe(shown.paneId);
    expect(herdr("split")).toHaveLength(2);
    expect(world.paneIsPresent(coordinator.paneId)).toBe(true);
  });
});
