import { expect, test } from "bun:test";
import { chmod, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, CommandRunner, RequestBriefContent } from "../../src/contracts.ts";
import type {
  CoordinatorLaunchDependencies,
  CoordinatorLaunchRequest,
} from "../../src/coordinator/launch.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { restartCoordinator } from "../../src/coordinator/restart.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_POLICY,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

type RehomeCall = Readonly<{ readonly parentWorkspaceId: string }>;

function launchRequest(world: ScenarioWorld): CoordinatorLaunchRequest {
  return {
    cwd: world.repoPath,
    repo: world.repoPath,
    home: world.home,
    poolRoot: world.poolRoot,
    sessionId: world.sessionId,
    model: { model: "scenario/coordinator", thinking: "low" },
    continueSession: true,
    headless: true,
    noAttach: true,
  };
}

function launchDependencies(
  world: ScenarioWorld,
  rehomed: RehomeCall[],
  renestWarnings: readonly string[] = [],
): CoordinatorLaunchDependencies {
  return {
    run: world.run,
    terminal: terminalBackend(world.run, { terminal: "herdr" }),
    startPersistent: async () => undefined,
    runInteractive: async () => 0,
    sleep: async () => undefined,
    processEnvironment: {},
    rehomeTaskWorkspaces: async (input) => {
      rehomed.push({ parentWorkspaceId: input.parentWorkspaceId });
      return renestWarnings;
    },
  };
}

test("a first coordinator launch takes one lease, one pane, and one durable ownership record", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    const launched = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );

    const snapshot = await world.snapshot();
    const record = await readCoordinatorRecord(
      recordPath(world.home, world.sessionId, world.repoPath),
    );
    expect(launched.restarted).toBe(false);
    expect(record?.endpoint.paneId).toBe(launched.paneId ?? "");
    expect(record?.worktree.leaseId).toBe(launched.worktree.leaseId);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.released).toEqual([]);
    expect(
      snapshot.trace.filter((event) => event.action === "herdr workspace create"),
    ).toHaveLength(1);
    expect(rehomed).toEqual([{ parentWorkspaceId: launched.workspaceId ?? "" }]);
  });
});

test("a restart reports why task workspaces could not be re-nested instead of dropping it", async () => {
  await withScenario({}, async (world) => {
    const warning = "could not read Herdr workspaces: no server";
    const launched = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, [], [warning]),
    );
    expect(launched.renestWarnings).toEqual([warning]);
  });
});

test("restarting an owned coordinator replaces only its pane and keeps the same lease", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    const first = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    const second = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );

    const snapshot = await world.snapshot();
    const record = await readCoordinatorRecord(
      recordPath(world.home, world.sessionId, world.repoPath),
    );
    expect(second.restarted).toBe(true);
    expect(second.previousPaneId).toBe(first.paneId ?? "");
    expect(second.worktree.leaseId).toBe(first.worktree.leaseId);
    expect(record?.endpoint.paneId).toBe(second.paneId ?? "");
    expect(world.paneIsPresent(first.paneId ?? "")).toBe(false);
    expect(world.paneIsPresent(second.paneId ?? "")).toBe(true);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
  });
});

test("restart relaunches an exited coordinator beside a pane someone reused, without touching it", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    const first = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    // Ctrl-C exited the coordinator, then a plain `omp` was started by hand in its pane.
    world.replaceForeground(first.paneId ?? "", ["omp"]);

    const second = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );

    const record = await readCoordinatorRecord(
      recordPath(world.home, world.sessionId, world.repoPath),
    );
    expect(second.restarted).toBe(false);
    expect(second.paneId).not.toBe(first.paneId);
    expect(second.command).toContain("--continue");
    expect(record?.endpoint.paneId).toBe(second.paneId ?? "");
    expect(world.paneIsPresent(first.paneId ?? "")).toBe(true);
    expect(world.paneIsPresent(second.paneId ?? "")).toBe(true);
  });
});

test("restart still refuses while the coordinator runs outside its recorded pane", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    const first = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    const other = world.openPane({ paneId: "pane-elsewhere", cwd: world.repoPath });
    world.replaceForeground(other.paneId, first.command);
    world.replaceForeground(first.paneId ?? "", ["omp"]);

    await expect(
      restartCoordinator(launchRequest(world), launchDependencies(world, rehomed)),
    ).rejects.toThrow(/still running elsewhere .* then run `tandem update`/u);
    expect(world.paneIsPresent(first.paneId ?? "")).toBe(true);
  });
});

async function coordinatorScript(world: ScenarioWorld): Promise<string> {
  const directory = join(world.home, "coordinator-scripts");
  const [name] = await readdir(directory);
  if (name === undefined) throw new Error("no coordinator launch script was written");
  return join(directory, name);
}

test("after the coordinator exits, its pane offers to start it again with the saved conversation", async () => {
  await withScenario({}, async (world) => {
    await restartCoordinator(launchRequest(world), launchDependencies(world, []));
    const script = await coordinatorScript(world);
    const bin = join(world.home, "bin");
    const calls = join(world.home, "omp-calls.txt");
    await Bun.write(join(bin, "omp"), `#!/bin/sh\necho "$*" >> '${calls}'\n`);
    await chmod(join(bin, "omp"), 0o755);

    // Enter once (restart), then close stdin (leave).
    const child = Bun.spawn(["/bin/sh", script], {
      stdin: new TextEncoder().encode("\n"),
      stdout: "pipe",
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(await child.exited).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(output.match(/Tandem's coordinator stopped\./gu)).toHaveLength(2);
    const invocations = (await readFile(calls, "utf8")).trim().split("\n");
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toContain("--continue");
  });
});

test("restart closes a pane whose launch script is waiting to start the coordinator again", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    const first = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    world.replaceForeground(first.paneId ?? "", ["/bin/sh", await coordinatorScript(world)]);

    const second = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    expect(second.restarted).toBe(true);
    expect(second.worktree.leaseId).toBe(first.worktree.leaseId);
    expect(world.paneIsPresent(first.paneId ?? "")).toBe(false);
    expect((await world.snapshot()).resources.quarantined).toEqual([]);
  });
});

test("a coordinator started again from its pane is still the owned coordinator", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    const first = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    // Only --continue differs between a first start and a start from the pane's offer.
    world.replaceForeground(
      first.paneId ?? "",
      first.command.filter((value) => value !== "--continue"),
    );
    const second = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    expect(second.restarted).toBe(true);
    expect(second.previousPaneId).toBe(first.paneId ?? "");
  });
});

test("a launch interrupted at the Herdr boundary leaves no owner, no orphan pane, and no stray lease", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    world.failAt({
      boundary: "herdr",
      action: "herdr pane run",
      stderr: "herdr dropped the launch request",
    });

    await expect(
      restartCoordinator(launchRequest(world), launchDependencies(world, rehomed)),
    ).rejects.toThrow(/pane run/);

    const interrupted = await world.snapshot();
    expect(
      await readCoordinatorRecord(recordPath(world.home, world.sessionId, world.repoPath)),
    ).toBeUndefined();
    expect(interrupted.resources.retained).toEqual([]);
    expect(interrupted.resources.quarantined).toEqual([]);
    expect(interrupted.resources.released).toContain("pane:pane-1");
    expect(interrupted.resources.released).toContain("lease:lease-1");

    const recovered = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    const snapshot = await world.snapshot();
    const record = await readCoordinatorRecord(
      recordPath(world.home, world.sessionId, world.repoPath),
    );
    expect(record?.endpoint.paneId).toBe(recovered.paneId ?? "");
    expect(record?.worktree.leaseId).toBe(recovered.worktree.leaseId);
    expect(snapshot.resources.retained).toContain(`lease:${recovered.worktree.leaseId}`);
    expect(snapshot.resources.retained.filter((entry) => entry.startsWith("lease:"))).toHaveLength(
      1,
    );
    expect(snapshot.resources.quarantined).toEqual([]);
  });
});

test("a rollback that cannot retire its new pane quarantines the lease instead of returning it", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    world.failAt({
      boundary: "herdr",
      action: "herdr pane run",
      stderr: "herdr dropped the launch request",
    });
    world.failAt({
      boundary: "herdr",
      action: "herdr pane close",
      stderr: "herdr refused to close the pane",
    });

    await expect(
      restartCoordinator(launchRequest(world), launchDependencies(world, rehomed)),
    ).rejects.toThrow(/pane run/);

    const snapshot = await world.snapshot();
    expect(
      await readCoordinatorRecord(recordPath(world.home, world.sessionId, world.repoPath)),
    ).toBeUndefined();
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain("pane:pane-1");
    expect(snapshot.resources.released).toEqual([]);
    expect(
      snapshot.resources.quarantined.some((entry) => entry.startsWith("coordinator-quarantine:")),
    ).toBe(true);
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
  });
});

test("a refused branch preparation keeps the acquired lease instead of discarding it", async () => {
  await withScenario({}, async (world) => {
    const rehomed: RehomeCall[] = [];
    world.failAt({
      boundary: "git",
      action: "git switch",
      stderr: "fatal: unable to create the task branch",
    });

    await expect(
      restartCoordinator(launchRequest(world), launchDependencies(world, rehomed)),
    ).rejects.toThrow(/lease preserved/);

    const interrupted = await world.snapshot();
    expect(interrupted.resources.retained).toContain("lease:lease-1");
    expect(interrupted.resources.released).toEqual([]);
    expect(interrupted.trace.some((event) => event.action === "herdr workspace create")).toBe(
      false,
    );

    const recovered = await restartCoordinator(
      launchRequest(world),
      launchDependencies(world, rehomed),
    );
    expect(recovered.worktree.leaseId).toBe("lease-1");
    const snapshot = await world.snapshot();
    expect(snapshot.resources.retained.filter((entry) => entry.startsWith("lease:"))).toHaveLength(
      1,
    );
  });
});

test("an unavailable OMP catalogue refuses a model change and leaves policy untouched", async () => {
  await withScenario({ ompModels: [] }, async (world) => {
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    world.failAt({ boundary: "omp", action: "omp models", stderr: "omp catalogue unavailable" });

    await expect(
      service.configureModels({
        repoPath: world.repoPath,
        models: SCENARIO_POLICY.config.models,
      }),
    ).rejects.toThrow(/omp model listing/i);

    expect(
      world.trace().some((event) => event.boundary === "omp" && event.outcome === "refused"),
    ).toBe(true);
    expect((await world.snapshot()).tasks).toEqual([]);
    await service.shutdown();
  });
});

const BRIEF: RequestBriefContent = {
  goal: "Keep one durable agreement for this request",
  scope: ["src/requests"],
  constraints: ["SQLite stays authoritative"],
  nonGoals: ["no second ledger"],
  acceptanceCriteria: ["dispatch is blocked while the brief is superseded"],
  manualVerification: [],
  recommendedApproach: "One record with monotonic draft revisions",
  keyDecisions: ["the pane is a projection the coordinator owns"],
  openQuestions: [],
  researchLinks: [],
};

test("a request brief gates dispatch, retires only its own pane, and pauses superseded work", async () => {
  await withScenario({}, async (world) => {
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    const bystander = world.openPane({ paneId: "pane-bystander", cwd: world.repoPath });
    const drafted = await service.draftRequestBrief({
      repoPath: world.repoPath,
      content: BRIEF,
      reviewPane: true,
    });
    const requestId = drafted.record.id;
    const reviewPaneId = drafted.record.reviewPane?.endpoint.paneId ?? "";
    const task = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "awaiting-approval",
      requestId,
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask());

    expect(drafted.record.reviewPane?.status).toBe("open");
    expect(drafted.approvalState).toBe("unapproved");
    await expect(service.approve(task.id)).rejects.toThrow(/has no approved brief/u);

    const approved = await service.approveRequestBrief({
      requestId,
      briefRevision: drafted.record.draft.revision,
      contentDigest: drafted.record.draft.contentDigest,
    });
    expect(approved.approvalState).toBe("current");
    expect(approved.record.reviewPane?.status).toBe("closed");
    expect(world.paneIsPresent(reviewPaneId)).toBe(false);
    expect(world.paneIsPresent(bystander.paneId)).toBe(true);

    const dispatched = await service.approve(task.id);
    expect(dispatched.stage).toBe("queued");
    expect(dispatched.scopeApproved).toBe(true);

    const annotated = await service.draftRequestBrief({
      repoPath: world.repoPath,
      requestId,
      content: { ...BRIEF, openQuestions: ["does the pane need a keybinding?"] },
      reviewPane: false,
    });
    expect(annotated.record.draft.revision).toBe(2);
    expect(annotated.approvalState).toBe("current");
    expect(annotated.pausedTaskIds).toEqual([]);

    const rescoped = await service.draftRequestBrief({
      repoPath: world.repoPath,
      requestId,
      content: { ...BRIEF, scope: ["src/requests", "src/coordinator"] },
      reviewPane: true,
    });
    expect(rescoped.record.draft.revision).toBe(3);
    expect(rescoped.approvalState).toBe("superseded");
    expect(rescoped.pausedTaskIds).toEqual([task.id]);
    expect((await service.get(task.id)).stage).toBe("paused");
    expect(rescoped.record.reviewPane?.status).toBe("open");
    expect(rescoped.record.reviewPane?.renderedRevision).toBe(3);
    expect(rescoped.record.reviewPane?.endpoint.paneId).not.toBe(reviewPaneId);

    const reread = await service.requestBrief(requestId);
    expect(reread.record.approval?.briefRevision).toBe(1);
    expect(reread.record.history.map((entry) => entry.revision)).toEqual([1, 2]);
    await service.shutdown();
  });
});

type Observed = { readonly argv: readonly string[] };

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

/** The world's runner, recording every command it is given in order. */
function recordingRun(world: ScenarioWorld, calls: Observed[]): CommandRunner {
  return async (request) => {
    calls.push({ argv: request.argv });
    return world.run(request);
  };
}

function gitCalls(calls: readonly Observed[], path: string): readonly (readonly string[])[] {
  return calls
    .filter((call) => call.argv[0] === "git" && call.argv[2] === path)
    .map((call) => call.argv.slice(3));
}

test("an update proves the coordinator checkout without rereading evidence it never uses", async () => {
  await withScenario({}, async (world) => {
    const first = await restartCoordinator(launchRequest(world), launchDependencies(world, []));
    const calls: Observed[] = [];
    const run = recordingRun(world, calls);
    await restartCoordinator(launchRequest(world), {
      ...launchDependencies(world, []),
      run,
      terminal: terminalBackend(run, { terminal: "herdr" }),
    });

    const reads = gitCalls(calls, first.worktree.path);
    // A checkpoint's full binary diff is evidence for tasks; a launch only needs clean and pinned.
    expect(reads.some((argv) => argv.includes("--binary"))).toBe(false);
    // The previous checkout is observed once, and the lease acquire proves it once more.
    expect(reads.filter((argv) => argv[0] === "status")).toHaveLength(2);
  });
});

test("an update fetches origin while it checks the new coordinator", async () => {
  await withScenario({}, async (world) => {
    let fetching!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      fetching = resolve;
    });
    const run: CommandRunner = async (request) => {
      const [program, , , verb] = request.argv;
      if (program === "git" && verb === "remote") return ok("origin\n");
      if (program === "git" && verb === "fetch") {
        fetching();
        return ok();
      }
      if (program === "git" && request.argv.includes("refs/remotes/origin/main^{commit}")) {
        return ok(`${SCENARIO_HEAD}\n`);
      }
      return world.run(request);
    };
    await restartCoordinator(launchRequest(world), {
      ...launchDependencies(world, []),
      run,
      terminal: terminalBackend(run, { terminal: "herdr" }),
      // Never returns unless the fetch was already running: a serial update would hang here.
      checkNewCoordinator: () => fetchStarted,
    });
  });
});

test("a new coordinator's panel opens while the coordinator starts, not after it is proven", async () => {
  await withScenario({}, async (world) => {
    const calls: Observed[] = [];
    const run = recordingRun(world, calls);
    await restartCoordinator(launchRequest(world), {
      ...launchDependencies(world, []),
      run,
      terminal: terminalBackend(run, { terminal: "herdr" }),
    });

    const words = calls.map((call) => call.argv.join(" "));
    const panelOpen = words.findIndex((line) => line.includes("plugin pane open"));
    const bootstrap = words.findIndex((line) => line.includes("pane run"));
    const firstProof = words.findIndex(
      (line, index) => index > bootstrap && line.includes("process-info"),
    );
    expect(panelOpen).toBeGreaterThan(bootstrap);
    expect(panelOpen).toBeLessThan(firstProof);
  });
});
