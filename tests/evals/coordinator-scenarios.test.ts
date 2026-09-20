import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type {
  CoordinatorLaunchDependencies,
  CoordinatorLaunchRequest,
} from "../../src/coordinator/launch.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { restartCoordinator } from "../../src/coordinator/restart.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { SCENARIO_POLICY, type ScenarioWorld, withScenario } from "./scenario.ts";

const EXTENSION_PATH = fileURLToPath(new URL("../../src/extension.ts", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("../../src/worker-config.yml", import.meta.url));

type RehomeCall = Readonly<{ readonly parentWorkspaceId: string }>;

function launchRequest(world: ScenarioWorld): CoordinatorLaunchRequest {
  return {
    cwd: world.repoPath,
    repo: world.repoPath,
    home: world.home,
    poolRoot: world.poolRoot,
    sessionId: world.sessionId,
    model: { model: "scenario/coordinator", thinking: "low" },
    configPath: CONFIG_PATH,
    extensionPath: EXTENSION_PATH,
    continueSession: true,
    headless: true,
    noAttach: true,
  };
}

function launchDependencies(
  world: ScenarioWorld,
  rehomed: RehomeCall[],
): CoordinatorLaunchDependencies {
  return {
    run: world.run,
    startPersistent: async () => undefined,
    runInteractive: async () => 0,
    sleep: async () => undefined,
    processEnvironment: {},
    rehomeTaskWorkspaces: async (input) => {
      rehomed.push({ parentWorkspaceId: input.parentWorkspaceId });
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
