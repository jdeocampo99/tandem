import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchCoordinator } from "../../src/coordinator/launch.ts";
import { findRunningCoordinator } from "../../src/coordinator/ownership.ts";
import { visitNativeProject } from "../../src/memory/native-visits.ts";
import { readProjectState } from "../../src/native/store.ts";
import { catchUpWarningNotice } from "../../src/terminal/launch.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { publishFixture } from "../native/view-files.ts";
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
    await publishFixture(world.home, world.repoPath, {
      writtenAt: world.clock(),
      changeSignature: "after",
    });
    await visitNativeProject(
      { home: world.home, project: world.repoPath, now: world.clock(), signature: "before" },
      async () => {},
    );
    world.advanceClock(60);
    let opened = 0;
    let catchUpFails = true;
    const terminal = {
      ...terminalBackend(world.run, { home: world.home }),
      openView: async () => {
        opened++;
        return catchUpFails
          ? { opened: false, warnings: ["fixture optional catch-up failure"] }
          : { opened: true, warnings: [] };
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
    const visit = async () =>
      JSON.stringify((await readProjectState(world.home, world.repoPath))?.visit);
    expect(JSON.parse(await visit()).previousSignature).toBe("before");
    const unacknowledged = await visit();
    const warned = await reconnect(false);
    expect(warned.reused).toBe(true);
    expect(warned.catchUpWarning).toBe(
      "Project opened, but catch-up is unavailable: fixture optional catch-up failure",
    );
    expect(warned.panelFailure ?? "").not.toContain("fixture optional catch-up failure");
    expect(await visit()).toBe(unacknowledged);
    catchUpFails = false;
    await reconnect(false);
    expect(opened).toBe(2);
    expect(JSON.parse(await visit()).previousSignature).toBe("after");
  });
});

test("a fresh Tern launch preserves its coordinator and visit when optional catch-up throws", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    await publishFixture(world.home, world.repoPath, {
      writtenAt: world.clock(),
      changeSignature: "after",
    });
    await visitNativeProject(
      { home: world.home, project: world.repoPath, now: world.clock(), signature: "before" },
      async () => {},
    );
    const visit = async () =>
      JSON.stringify((await readProjectState(world.home, world.repoPath))?.visit);
    const previous = await visit();
    world.advanceClock(60);
    let opens = 0;
    const terminal = {
      ...terminalBackend(world.run, { home: world.home }),
      openView: async () => {
        opens++;
        throw new Error("fixture catch-up exception");
      },
    };
    const launched = await launchCoordinator(
      {
        cwd: world.repoPath,
        repo: world.repoPath,
        home: world.home,
        poolRoot: world.poolRoot,
        sessionId: world.sessionId,
        model: undefined,
        continueSession: true,
        headless: false,
        noAttach: false,
      },
      {
        run: world.run,
        terminal,
        startPersistent: async () => undefined,
        runInteractive: async () => {
          throw new Error("must launch in a Tern pane");
        },
        sleep: async () => {},
        clock: world.clock,
        processEnvironment: {},
      },
    );
    expect(launched.reused).toBeUndefined();
    expect(opens).toBe(1);
    expect(launched.catchUpWarning).toBe(
      "Project opened, but catch-up is unavailable: fixture catch-up exception",
    );
    expect(catchUpWarningNotice(world.repoPath, launched)).toBe(
      `${world.repoPath}: ${launched.catchUpWarning}\n`,
    );
    expect(await visit()).toBe(previous);
    expect(
      await findRunningCoordinator(world.run, terminal, {
        home: world.home,
        sessionId: world.sessionId,
        repoPath: world.repoPath,
      }),
    ).toBeDefined();
  });
});

test("a second project launches beside the first project's live native panel", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const terminal = terminalBackend(world.run, { home: world.home });
    const launch = (repo: string) =>
      launchCoordinator(
        {
          cwd: repo,
          repo,
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
          terminal,
          startPersistent: async () => undefined,
          runInteractive: async () => {
            throw new Error("must launch in a Tern pane");
          },
          sleep: async () => {},
          processEnvironment: {},
        },
      );
    const first = await launch(world.repoPath);
    const panel = world.openPane({
      paneId: "48",
      cwd: world.repoPath,
      blockProgram: "tandem.panel",
    });
    const secondRepo = join(world.home, "..", "repo-b");
    await mkdir(join(secondRepo, ".git"), { recursive: true });
    const second = await launch(secondRepo);
    expect(second.paneId).not.toBe(first.paneId);
    expect(second.worktree.leaseId).not.toBe(first.worktree.leaseId);
    for (const [repoPath, launched] of [
      [world.repoPath, first],
      [secondRepo, second],
    ] as const) {
      const record = await findRunningCoordinator(world.run, terminal, {
        home: world.home,
        sessionId: world.sessionId,
        repoPath,
      });
      expect(record?.endpoint.paneId).toBe(launched.paneId);
      expect(world.paneIsPresent(launched.paneId ?? "")).toBe(true);
    }
    expect(world.paneIsPresent(panel.paneId)).toBe(true);
    expect(world.trace().some((event) => event.action === "tern close")).toBe(false);
    expect((await world.snapshot()).resources.failed).toEqual([]);
  });
});
