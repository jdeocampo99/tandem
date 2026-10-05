import { expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchCoordinator } from "../../src/coordinator/launch.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { withScenario } from "./scenario.ts";

test("a coordinator launched into Tern carries its new workspace and namespace through bootstrap", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const launched = await launchCoordinator(
      {
        cwd: world.repoPath,
        repo: world.repoPath,
        home: world.home,
        poolRoot: world.poolRoot,
        sessionId: world.sessionId,
        model: undefined,
        continueSession: true,
        headless: true,
        noAttach: true,
      },
      {
        run: world.run,
        terminal: terminalBackend(world.run, { home: world.home }),
        startPersistent: async () => undefined,
        runInteractive: async () => {
          throw new Error("must launch in a Tern pane");
        },
        sleep: async () => {},
        processEnvironment: {
          HERDR_ENV: "1",
          HERDR_SESSION: "foreign",
          HERDR_WORKSPACE_ID: "foreign-tab",
          HERDR_PANE_ID: "foreign-pane",
        },
      },
    );
    const [script] = await readdir(join(world.home, "coordinator-scripts"));
    if (script === undefined) throw new Error("coordinator bootstrap is missing");
    const bootstrap = await readFile(join(world.home, "coordinator-scripts", script), "utf8");
    expect(bootstrap).toContain(`'TANDEM_SESSION=${world.sessionId}'`);
    expect(bootstrap).toContain(`'TANDEM_TERN_WORKSPACE_ID=${launched.workspaceId}'`);
    const writes = world.trace().filter((event) => event.action === "tern run");
    expect(writes.length).toBeGreaterThan(0);
    expect(JSON.stringify(writes)).not.toContain("foreign-pane");
  });
});
