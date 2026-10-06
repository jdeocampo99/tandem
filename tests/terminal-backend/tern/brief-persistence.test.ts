import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint } from "../../../src/contracts.ts";
import {
  listCoordinatorRecords,
  saveCoordinatorRecord,
} from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { createRequestBriefStore } from "../../../src/requests/store.ts";
import { createTandemService } from "../../../src/service/controller.ts";
import { decode, Listing } from "../../../src/terminal-backend/tern/protocol.ts";
import { content } from "../../board/fixtures.ts";
import { withScenario } from "../../evals/scenario.ts";

test("production Tern brief drafting persists and reloads a split without coordinator alert metadata", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const helper = world.openPane({ paneId: "2002", cwd: world.repoPath });
    const notificationPane = {
      workspaceId: helper.workspaceId,
      tabId: helper.tabId,
      paneId: helper.paneId,
    };
    const coordinator: Endpoint = {
      ...world.openPane({ paneId: "2001", cwd: world.repoPath }),
      terminalSessionId: "100",
      notificationPane,
      role: "coordinator",
    };
    const worktree = await world.grantLease({ name: "coordinator", holder: "coordinator" });
    await saveCoordinatorRecord(world.home, {
      schemaVersion: 1,
      repoPath: world.repoPath,
      endpoint: coordinator,
      worktree,
      harness: DEFAULT_HARNESS,
      command: ["omp"],
    });
    let briefArgs: string[] | undefined;
    let openings = 0;
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      coordinatorPaneId: coordinator.paneId,
      clock: world.clock,
      idFactory: world.idFactory,
      checkBriefLanguage: async () => [],
      run: async (request) => {
        if (request.argv[0]?.endsWith("/tern") || request.argv[0] === "tern") {
          const ok = (value: unknown) => ({ code: 0, stderr: "", stdout: JSON.stringify(value) });
          if (request.argv[1] === "inspect") return ok({ clients: [{ kind: "window" }] });
          if (request.argv[1] === "open") {
            const ticket = JSON.parse(await readFile(request.argv[2] ?? "", "utf8"));
            expect(ticket.kind).toBe("brief");
            expect(ticket.placement).toBe("split");
            briefArgs = ticket.args;
            openings++;
            await writeFile(
              ticket.receipt,
              JSON.stringify({
                paneId: "3001",
                tabId: coordinator.tabId,
                sessionId: coordinator.terminalSessionId,
              }),
            );
            return ok({ blocks: ["3001"], discarded: false });
          }
          if (request.argv[1] === "ls") {
            const result = await world.run(request);
            const listing = decode(result.stdout, Listing, "scenario native brief listing");
            if (briefArgs !== undefined) {
              const tab = listing.sessions
                .find((session) => session.id === coordinator.terminalSessionId)
                ?.tabs.find((tab) => tab.id === coordinator.tabId);
              if (tab === undefined) throw new Error("Coordinator tab disappeared");
              tab.blocks.push({
                id: "3001",
                title: "Tandem brief",
                cwd: worktree.path,
                live: false,
                program: "tandem.brief",
                args: briefArgs,
              });
            }
            return ok(listing);
          }
        }
        return world.run(request);
      },
    });
    try {
      const first = await service.draftRequestBrief({
        repoPath: world.repoPath,
        content: content("Review a brief from a real Tern launch"),
        reviewPane: true,
      });
      const expectedEndpoint: Endpoint = {
        terminal: "tern",
        sessionId: coordinator.sessionId,
        terminalSessionId: "100",
        workspaceId: coordinator.workspaceId,
        tabId: coordinator.tabId,
        paneId: "3001",
        role: "coordinator",
        generation: 0,
      };
      const reloaded = createRequestBriefStore({
        home: world.home,
        clock: world.clock,
        idFactory: world.idFactory,
      });
      expect(first.record.reviewPane?.endpoint).toEqual(expectedEndpoint);
      expect((await reloaded.read(first.record.id))?.reviewPane).toEqual(first.record.reviewPane);
      expect(
        JSON.parse(await readFile(first.record.reviewPane?.renderedPath ?? "", "utf8")),
      ).toMatchObject({ kind: "brief", model: { revision: 1 } });
      const revised = await service.draftRequestBrief({
        repoPath: world.repoPath,
        requestId: first.record.id,
        content: content("Review the updated brief in the existing Tern split"),
        reviewPane: true,
      });
      expect(revised.record.reviewPane?.endpoint).toEqual(expectedEndpoint);
      expect(revised.record.reviewPane?.renderedRevision).toBe(2);
      expect((await reloaded.read(first.record.id))?.reviewPane).toEqual(revised.record.reviewPane);
      expect(openings).toBe(1);
      const [savedOwner] = await listCoordinatorRecords(world.home, world.sessionId);
      expect(savedOwner?.endpoint.notificationPane).toEqual(notificationPane);
    } finally {
      await service.shutdown();
    }
  });
});
