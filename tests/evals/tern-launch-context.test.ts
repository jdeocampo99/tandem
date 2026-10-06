import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeViewText } from "../../src/board/native-views.ts";
import { nativeViewsPath } from "../../src/board/snapshot.ts";
import { repositoryKey } from "../../src/config/repositories.ts";
import { launchCoordinator } from "../../src/coordinator/launch.ts";
import { visitNativeProject } from "../../src/memory/native-visits.ts";
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

    // A background open must leave the visit intact until its caller brings the project forward.
    const path = nativeViewsPath(world.home, world.repoPath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      nativeViewText("panel", {
        version: 1,
        project: world.repoPath,
        writtenAt: world.clock(),
        changeSignature: "after",
        tasks: {},
        briefs: {},
        pullRequests: {},
        projects: [],
      }),
    );
    await visitNativeProject(
      { home: world.home, project: world.repoPath, now: world.clock(), signature: "before" },
      async () => {},
    );
    world.advanceClock(60);
    let opened = 0;
    const terminal = {
      ...terminalBackend(world.run, { home: world.home }),
      openView: async () => {
        opened++;
        return { opened: true, warnings: [] };
      },
    };
    const reconnect = (background: boolean) =>
      launchCoordinator(
        {
          cwd: world.repoPath,
          repo: world.repoPath,
          home: world.home,
          poolRoot: world.poolRoot,
          sessionId: world.sessionId,
          model: undefined,
          continueSession: true,
          headless: background,
          noAttach: background,
        },
        {
          run: world.run,
          terminal,
          startPersistent: async () => undefined,
          runInteractive: async () => {
            throw new Error("must reconnect the existing pane");
          },
          sleep: async () => {},
          clock: world.clock,
          processEnvironment: {},
        },
      );
    await reconnect(true);
    expect(opened).toBe(0);
    const visitPath = join(world.home, "native-visits", `${repositoryKey(world.repoPath)}.json`);
    expect(JSON.parse(await readFile(visitPath, "utf8")).previousSignature).toBe("before");
    await reconnect(false);
    expect(opened).toBe(1);
    expect(JSON.parse(await readFile(visitPath, "utf8")).previousSignature).toBe("after");
  });
});
