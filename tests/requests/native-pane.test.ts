import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { withRequestReviewPane } from "../../src/requests/brief.ts";
import { projectRequestBriefPane } from "../../src/requests/review-pane.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import { RequestBriefWorkflow } from "../../src/requests/workflow.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { executeTandemAction } from "../../src/session/actions.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend } from "../../src/terminal-backend/contract.ts";
import { content } from "../board/fixtures.ts";
import { type ScenarioWorld, withScenario } from "../evals/scenario.ts";

async function fixture(world: ScenarioWorld, terminal: TerminalBackend) {
  const coordinator = {
    ...world.openPane({ paneId: "2001", cwd: world.repoPath }),
    terminalSessionId: "100",
    role: "coordinator" as const,
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
  const store = createRequestBriefStore({
    home: world.home,
    clock: world.clock,
    idFactory: () => "req-native",
  });
  const workflow = new RequestBriefWorkflow({
    home: world.home,
    sessionId: world.sessionId,
    parentWorkspaceId: coordinator.workspaceId,
    coordinatorPaneId: coordinator.paneId,
    terminal,
    clock: world.clock,
    store,
    listTasks: async () => [],
    pauseTask: async () => {
      throw new Error("No task to pause");
    },
    checkLanguage: async () => [],
  });
  return { workflow, coordinator, worktree, store };
}

for (const action of ["approve", "abandon", "closeReview"] as const) {
  test(`${action} under Tern quarantines a foreign Herdr receipt without closing any pane`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      let closes = 0;
      const { workflow, coordinator, store } = await fixture(world, {
        ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
        closeView: async () => {
          closes++;
          return { closed: true, warnings: [] };
        },
      });
      const drafted = await workflow.draft({
        repoPath: world.repoPath,
        content: content("Review the brief after switching terminals"),
        reviewPane: false,
      });
      const receipt = {
        status: "open" as const,
        endpoint: { ...coordinator, terminal: "herdr" as const, paneId: "3001" },
        renderedRevision: 1,
        renderedPath: join(world.home, "request-briefs", "req-native.md"),
        observedAt: world.clock(),
      };
      await store.update(drafted.record.id, drafted.record.revision, (record) =>
        withRequestReviewPane(record, receipt, world.clock()),
      );
      const finished =
        action === "approve"
          ? await workflow.approve({
              requestId: drafted.record.id,
              briefRevision: 1,
              contentDigest: drafted.record.draft.contentDigest,
              agreementDigest: drafted.record.draft.agreementDigest,
            })
          : action === "abandon"
            ? await workflow.abandon(drafted.record.id)
            : await workflow.closeReview(drafted.record.id, 1);
      expect(finished.record.reviewPane).toEqual({
        ...receipt,
        status: "quarantined",
        reason: "Brief pane belongs to herdr; kept open because the active terminal is tern",
      });
      expect((await store.read(drafted.record.id))?.reviewPane).toEqual(finished.record.reviewPane);
      if (action === "approve") expect(finished.approvalState).toBe("current");
      if (action === "abandon") expect(finished.record.abandonedAt).toBe(world.clock());
      await workflow.closeReview(drafted.record.id, 1);
      expect(closes).toBe(0);
      expect(
        world.trace().filter((each) => each.boundary === "tern" || each.boundary === "herdr"),
      ).toEqual([]);
    });
  });
}

test("every direct brief projector caller uses native hosting in Tern", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const opens: Parameters<TerminalBackend["openView"]>[0][] = [];
    const terminal: TerminalBackend = {
      ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
      openView: async (input) => {
        opens.push(input);
        return { opened: true, warnings: [], endpoint: { ...input.coordinator, paneId: "3001" } };
      },
    };
    const { workflow, coordinator } = await fixture(world, terminal);
    const draft = await workflow.draft({
      repoPath: world.repoPath,
      content: content("Review the brief after native feedback"),
      reviewPane: false,
    });
    const pane = await projectRequestBriefPane(
      {
        terminal,
        home: world.home,
        sessionId: world.sessionId,
        parentWorkspaceId: coordinator.workspaceId,
        coordinatorPaneId: coordinator.paneId,
        clock: world.clock,
      },
      draft.record,
    );
    expect(pane.endpoint.paneId).toBe("3001");
    expect(opens).toHaveLength(1);
    expect(opens[0]?.view).toEqual({ kind: "brief", requestId: draft.record.id });
    expect(
      world.trace().filter((each) => each.boundary === "tern" || each.boundary === "herdr"),
    ).toEqual([]);
  });
});

test("coordinator reviewRequestBrief action after feedback enters native hosting and never falls back to a pager", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const { workflow, coordinator } = await fixture(world, {
      ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
      openView: async (input) => ({
        opened: true,
        warnings: [],
        endpoint: { ...input.coordinator, paneId: "3001" },
      }),
      closeView: async () => ({ closed: true, warnings: [] }),
    });
    const draft = await workflow.draft({
      repoPath: world.repoPath,
      content: content("Review the brief after native feedback"),
      reviewPane: true,
    });
    await workflow.closeReview(draft.record.id, draft.record.draft.revision);
    let nativeHosting = 0;
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      coordinatorPaneId: coordinator.paneId,
      clock: world.clock,
      idFactory: world.idFactory,
      run: async (request) => {
        // An unavailable native owner must stop the action instead of opening a shell split.
        expect(request.argv.slice(1)).toEqual(["inspect", "--json"]);
        nativeHosting++;
        throw new Error("native hosting unavailable; retain the request");
      },
    });
    try {
      await expect(
        executeTandemAction({ action: "brief-review", requestId: draft.record.id }, service, {
          confirm: undefined,
        }),
      ).rejects.toThrow("native hosting unavailable");
      expect(nativeHosting).toBe(1);
      expect((await service.requestBrief(draft.record.id)).record.reviewPane?.status).toBe(
        "closed",
      );
    } finally {
      await service.shutdown();
    }
  });
});

for (const action of ["approve", "request-changes", "abandon"] as const) {
  test(`automatic Tern brief projection binds revisions and retires its native split on ${action}`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      const opens: Parameters<TerminalBackend["openView"]>[0][] = [];
      const closes: Parameters<TerminalBackend["closeView"]>[0][] = [];
      const terminal: TerminalBackend = {
        ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
        openView: async (input) => {
          opens.push(input);
          return { opened: true, warnings: [], endpoint: { ...input.coordinator, paneId: "3001" } };
        },
        closeView: async (input) => {
          closes.push(input);
          return { closed: true, warnings: [] };
        },
      };
      const { workflow, coordinator, worktree } = await fixture(world, terminal);
      const first = await workflow.draft({
        repoPath: world.repoPath,
        content: content("Let users review their brief in Tern"),
        reviewPane: true,
      });
      const next = await workflow.draft({
        repoPath: world.repoPath,
        requestId: first.record.id,
        content: content("Let users review their updated brief in Tern"),
        reviewPane: true,
      });
      expect(next.record.draft.revision).toBe(2);
      expect(next.record.reviewPane?.endpoint.paneId).toBe(
        first.record.reviewPane?.endpoint.paneId,
      );
      expect(next.record.reviewPane?.renderedRevision).toBe(2);
      const file = JSON.parse(await readFile(next.record.reviewPane?.renderedPath ?? "", "utf8"));
      expect(file).toMatchObject({
        version: 1,
        kind: "brief",
        model: {
          revision: 2,
          approval: {
            briefRevision: 2,
            contentDigest: next.record.draft.contentDigest,
            agreementDigest: next.record.draft.agreementDigest,
          },
        },
      });
      expect(opens).toHaveLength(2);
      expect(opens[0]).toEqual({
        coordinator,
        cwd: worktree.path,
        home: world.home,
        view: { kind: "brief", requestId: first.record.id },
        origin: { paneId: coordinator.paneId, cwd: worktree.path },
      });
      const stale = await workflow.closeReview(first.record.id, 1);
      expect(stale.record.reviewPane?.status).toBe("open");
      expect(closes).toHaveLength(0);
      const finished =
        action === "approve"
          ? await workflow.approve({
              requestId: next.record.id,
              briefRevision: 2,
              contentDigest: next.record.draft.contentDigest,
              agreementDigest: next.record.draft.agreementDigest,
            })
          : action === "abandon"
            ? await workflow.abandon(next.record.id)
            : await workflow.closeReview(next.record.id, 2);
      expect(finished.record.reviewPane?.status).toBe("closed");
      expect(closes).toEqual([
        {
          coordinator,
          cwd: worktree.path,
          home: world.home,
          view: { kind: "brief", requestId: next.record.id },
          origin: { paneId: "3001" },
        },
      ]);
      expect(
        world.trace().filter((each) => each.boundary === "tern" || each.boundary === "herdr"),
      ).toEqual([]);
    });
  });
}

test("Herdr workflow keeps projecting through the legacy shell pane", async () => {
  await withScenario({}, async (world) => {
    const { workflow } = await fixture(world, {
      ...terminalBackend(world.run),
      openView: async () => {
        throw new Error("Herdr must not open native views");
      },
      closeView: async () => {
        throw new Error("Herdr must not close native views");
      },
    });
    const drafted = await workflow.draft({
      repoPath: world.repoPath,
      content: content("Let users review their brief in Tern"),
      reviewPane: true,
    });
    expect(drafted.record.reviewPane?.status).toBe("open");
    expect(drafted.record.reviewPane?.renderedPath).toEndWith("req-native.md");
    expect(world.trace().some((each) => each.action === "herdr pane run")).toBe(true);
  });
});

test("uncertain native close preserves approval and quarantines the projection without retry", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    let opens = 0;
    let closes = 0;
    const { workflow } = await fixture(world, {
      ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
      openView: async (input) => {
        opens++;
        return { opened: true, warnings: [], endpoint: { ...input.coordinator, paneId: "3001" } };
      },
      closeView: async () => {
        closes++;
        throw new Error("close outcome unknown; quarantine");
      },
    });
    const drafted = await workflow.draft({
      repoPath: world.repoPath,
      content: content("Let users review their brief in Tern"),
      reviewPane: true,
    });
    const approved = await workflow.approve({
      requestId: drafted.record.id,
      briefRevision: 1,
      contentDigest: drafted.record.draft.contentDigest,
    });
    expect(approved.approvalState).toBe("current");
    expect(approved.record.reviewPane?.status).toBe("quarantined");
    await workflow.review(drafted.record.id);
    await workflow.closeReview(drafted.record.id, 1);
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });
});

test("an unknown native opening propagates once and leaves the exact draft durable", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    let opens = 0;
    const { workflow } = await fixture(world, {
      ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
      openView: async () => {
        opens++;
        throw new Error("open outcome unknown; quarantine and keep resources");
      },
    });
    await expect(
      workflow.draft({
        repoPath: world.repoPath,
        content: content("Let users review their brief in Tern"),
        reviewPane: true,
      }),
    ).rejects.toThrow("quarantine");
    expect(opens).toBe(1);
    expect((await workflow.read("req-native")).record.draft.revision).toBe(1);
    expect(
      world.trace().filter((each) => each.boundary === "tern" || each.boundary === "herdr"),
    ).toEqual([]);
  });
});
