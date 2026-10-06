import { expect, test } from "bun:test";
import { nativeDetailPath, nativeViewsPath } from "../../src/board/snapshot.ts";
import type { CommandRunner } from "../../src/contracts.ts";
import { launchCoordinator, launchCoordinatorUnlocked } from "../../src/coordinator/launch.ts";
import { listCoordinatorQuarantineRecords } from "../../src/coordinator/quarantine.ts";
import { reconcileTandemResources } from "../../src/coordinator/reconcile.ts";
import {
  listCoordinatorRecords,
  removeCoordinatorRecord,
  saveCoordinatorRecord,
} from "../../src/coordinator/registry.ts";
import { resetCoordinators } from "../../src/coordinator/reset.ts";
import {
  acquireCoordinatorLease,
  applyCoordinatorReplacement,
  releaseCoordinatorLease,
} from "../../src/coordinator/resources.ts";
import { restartCoordinator } from "../../src/coordinator/restart.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { withScenario } from "./scenario.ts";

test("startup rollback retains a quarantined coordinator lease after its conversation tab disappears", async () => {
  await withScenario({ terminal: "tern", retainEmptyTernSessions: true }, async (world) => {
    let usagePaneId: string | undefined;
    let removedTab = false;
    const run: CommandRunner = async (request) => {
      // Ownership verification runs after startup saves the new coordinator record.
      const [owner] = await listCoordinatorRecords(world.home, world.sessionId);
      if (owner !== undefined && usagePaneId === undefined) {
        if (owner.endpoint.terminalSessionId === undefined) throw new Error("missing Tern session");
        usagePaneId = "9903";
        const index = nativeViewsPath(world.home, world.repoPath);
        world.openPane({
          paneId: usagePaneId,
          cwd: owner.worktree.path,
          terminalSessionId: owner.endpoint.terminalSessionId,
          blockProgram: "tandem.usage",
          blockArgs: [index, owner.endpoint.paneId, owner.worktree.path, "", index],
        });
      }
      const result = await world.run(request);
      if (
        owner !== undefined &&
        request.argv[1]?.endsWith("/terminal-backend/tern/process-reader.ts")
      )
        return { ...result, stdout: "[]" }; // Stable native leader disagreement writes quarantine.
      return result;
    };
    const terminal = terminalBackend(run, { home: world.home, terminal: "tern" });
    const startupTerminal = {
      ...terminal,
      inspect: async (target: Parameters<typeof terminal.inspect>[0]) => {
        try {
          return await terminal.inspect(target);
        } catch (error) {
          // The native proof has durably quarantined the recorded owner. Its tab
          // disappears before startup sees the failure and starts rollback.
          const [owner] = await listCoordinatorRecords(world.home, world.sessionId);
          if (
            owner !== undefined &&
            (await listCoordinatorQuarantineRecords(world.home)).length > 0
          ) {
            world.removePane(owner.endpoint.paneId);
            removedTab = true;
          }
          throw error;
        }
      },
    };
    await expect(
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
          terminal: startupTerminal,
          startPersistent: async () => undefined,
          runInteractive: async () => {
            throw new Error("interactive launch forbidden");
          },
          sleep: async () => {},
          processEnvironment: {},
        },
      ),
    ).rejects.toThrow("disagree");
    expect(removedTab).toBe(true);
    const [owner] = await listCoordinatorRecords(world.home, world.sessionId);
    if (owner === undefined || usagePaneId === undefined)
      throw new Error("missing startup owner or Usage view");
    const notes = await listCoordinatorQuarantineRecords(world.home);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.lease).toEqual(owner.worktree);
    expect(notes[0]?.endpoint).toEqual(owner.endpoint);
    expect(world.paneIsPresent(owner.endpoint.paneId)).toBe(false);
    expect(world.paneIsPresent(usagePaneId)).toBe(true);
    const before = (await world.snapshot()).resources;
    expect(before.retained).toContain(`lease:${owner.worktree.leaseId}`);
    expect(before.released).not.toContain(`lease:${owner.worktree.leaseId}`);
    expect(world.trace().some((event) => event.action === "treehouse return")).toBe(false);
    // Call the mutation owners directly, without any launch or retirement preflight.
    for (const attempt of [
      () =>
        releaseCoordinatorLease(run, {
          home: world.home,
          repoPath: world.repoPath,
          lease: owner.worktree,
        }),
      () =>
        acquireCoordinatorLease(run, world.home, {
          repo: world.repoPath,
          root: world.poolRoot,
          tandemId: owner.worktree.leaseHolder,
          taskName: owner.worktree.name,
          sourceHead: owner.worktree.baseHead,
        }),
      () =>
        applyCoordinatorReplacement({
          run,
          home: world.home,
          sessionId: world.sessionId,
          repoPath: world.repoPath,
          decision: { kind: "reuse", lease: owner.worktree, reason: "clean matching lease" },
          clock: world.clock,
          newId: () => "unexpected-note",
        }),
      () =>
        saveCoordinatorRecord(world.home, {
          ...owner,
          endpoint: { ...owner.endpoint, paneId: "replacement" },
        }),
      () => removeCoordinatorRecord(world.home, world.sessionId, world.repoPath),
    ]) {
      await expect(attempt()).rejects.toThrow("quarantine");
      expect(await listCoordinatorRecords(world.home, world.sessionId)).toEqual([owner]);
      expect(await listCoordinatorQuarantineRecords(world.home)).toEqual(notes);
      expect((await world.snapshot()).resources).toEqual(before);
    }
    const fix = await reconcileTandemResources({
      run,
      terminal: terminalBackend(run, { home: world.home, terminal: "tern" }),
      home: world.home,
      poolRoot: world.poolRoot,
      repoPaths: [world.repoPath],
      apply: true,
    });
    expect(fix.quarantined.some((entry) => entry.kind === "coordinator")).toBe(true);
    expect(await listCoordinatorRecords(world.home, world.sessionId)).toEqual([owner]);
    expect(await listCoordinatorQuarantineRecords(world.home)).toEqual(notes);
    expect((await world.snapshot()).resources).toEqual(before);
  });
});

for (const mode of [
  "reset-relaunch",
  "busy-view",
  "changed-args",
  "unknown-close",
  "unknown-close-missing-tab",
  "foreign-file",
] as const) {
  test(`Tern reset ${mode} retires only proven idle coordinator views`, async () => {
    await withScenario({ terminal: "tern", retainEmptyTernSessions: true }, async (world) => {
      let closing = false;
      let viewProcessRead = false;
      const run: CommandRunner = async (request) => {
        if (request.argv[1] === "process" && request.argv[2] === "9001") viewProcessRead = true;
        const result = await world.run(request);
        if (
          request.argv[1] === "close" &&
          request.argv[2] === "9002" &&
          mode.startsWith("unknown-close")
        )
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
      const launch = (
        operation = launchCoordinator,
        sessionId = world.sessionId,
        processEnvironment = {},
      ) =>
        operation(
          {
            cwd: world.repoPath,
            repo: world.repoPath,
            home: world.home,
            poolRoot: world.poolRoot,
            sessionId,
            model: undefined,
            continueSession: false,
            headless: true,
            noAttach: true,
          },
          {
            run,
            terminal: terminalBackend(run, { home: world.home, terminal: "tern" }),
            startPersistent: async () => undefined,
            runInteractive: async () => {
              throw new Error("interactive launch forbidden");
            },
            sleep: async () => {},
            processEnvironment,
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
        ...(mode === "unknown-close-missing-tab" ? {} : { anchor: record.endpoint }),
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
        expect(world.paneIsPresent(record.endpoint.paneId)).toBe(!mode.startsWith("unknown-close"));
        if (mode.startsWith("unknown-close")) {
          expect(await listCoordinatorQuarantineRecords(world.home)).toHaveLength(1);
          // A new adapter process must also obey the durable quarantine.
          const fresh = terminalBackend(run, { home: world.home, terminal: "tern" });
          await expect(
            fresh.close({ endpoint: record.endpoint, cwd: record.worktree.path }),
          ).rejects.toThrow("quarantine");
          if (mode === "unknown-close-missing-tab") {
            // Simulate the old conversation tab disappearing after the uncertain close.
            for (const paneId of ["9004", "9005", "9006", "9007", "9008", "9009"])
              world.removePane(paneId);
            expect(
              await fresh.workspaceLabel({
                sessionId: world.sessionId,
                cwd: world.repoPath,
                workspaceId: record.endpoint.workspaceId,
              }),
            ).toBeUndefined();
          }
          const notes = await listCoordinatorQuarantineRecords(world.home);
          const before = (await world.snapshot()).resources;
          expect(before.retained).toContain(`lease:${record.worktree.leaseId}`);
          expect(before.quarantined).toHaveLength(1);
          const effects = world
            .trace()
            .filter((event) =>
              ["tern close", "tern new", "treehouse get", "treehouse return"].includes(
                event.action,
              ),
            );
          // Missing conversation/tab must not bypass the durable close-outcome fence.
          for (const attempt of [
            () => launch(),
            () => launch(restartCoordinator),
            () => launch(launchCoordinatorUnlocked),
            () => launch(launchCoordinator, "replacement-session"),
            () =>
              launch(launchCoordinator, world.sessionId, {
                TANDEM_ALLOW_PARALLEL_COORDINATORS: "1",
              }),
          ]) {
            await expect(attempt()).rejects.toThrow("quarantine");
            expect(await listCoordinatorRecords(world.home, world.sessionId)).toEqual([record]);
            expect(await listCoordinatorQuarantineRecords(world.home)).toEqual(notes);
            expect((await world.snapshot()).resources).toEqual(before);
          }
          expect(
            world
              .trace()
              .filter((event) =>
                ["tern close", "tern new", "treehouse get", "treehouse return"].includes(
                  event.action,
                ),
              ),
          ).toEqual(effects);
          const fix = await reconcileTandemResources({
            run,
            terminal: fresh,
            home: world.home,
            poolRoot: world.poolRoot,
            repoPaths: [world.repoPath],
            apply: true,
          });
          expect(fix.quarantined.some((entry) => entry.kind === "coordinator")).toBe(true);
          expect(fix.quarantined.some((entry) => entry.kind === "quarantine-note")).toBe(true);
          expect(await listCoordinatorRecords(world.home, world.sessionId)).toEqual([record]);
          expect((await world.snapshot()).resources).toEqual(before);
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
