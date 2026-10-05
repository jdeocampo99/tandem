import { expect, test } from "bun:test";
import { EndpointBusyError } from "../../src/adapters/primitives.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import {
  scenarioReservation,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

test("a stale Tern id never closes a different pane whose title equals that id", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const stale = world.openPane({ paneId: "90071992547409931", cwd: world.repoPath });
    const other = world.openPane({ paneId: "90071992547409932", cwd: world.repoPath });
    world.titlePane(other.paneId, stale.paneId);
    world.removePane(stale.paneId);
    const lease = await world.grantLease({ name: "tern-stale", holder: "holder" });
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "paused",
      endpoints: [stale],
      worktree: lease,
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask({ endpoints: [stale], worktree: lease }));
    const terminal = terminalBackend(world.run, { terminal: "tern" });

    await terminal.close({ endpoint: stale, cwd: world.repoPath });
    await expect(terminal.closeOwned({ endpoint: stale, cwd: world.repoPath })).rejects.toThrow(
      "exact Tern id absent",
    );

    const snapshot = await world.snapshot();
    expect(world.paneIsPresent(other.paneId)).toBe(true);
    expect(snapshot.resources.retained).toContain(`pane:${other.paneId}`);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain(`endpoint:${stale.paneId}`);
    expect(snapshot.trace.some((event) => event.action === "tern close")).toBe(false);
  });
});

test("busy Tern close preserves the worker, reservation, endpoint and lease", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "90071992547409933", cwd: world.repoPath });
    const lease = await world.grantLease({ name: "tern-busy", holder: "holder" });
    world.replaceForeground(endpoint.paneId, ["omp", "--mode", "worker"]);
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "implementing",
      endpoints: [endpoint],
      worktree: lease,
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        endpoints: [endpoint],
        worktree: lease,
        reservation: scenarioReservation({ id: "r1" }),
      }),
    );
    const terminal = terminalBackend(world.run, { terminal: "tern" });

    await expect(terminal.close({ endpoint, cwd: world.repoPath })).rejects.toBeInstanceOf(
      EndpointBusyError,
    );

    const snapshot = await world.snapshot();
    expect(snapshot.resources.retained).toContain(`pane:${endpoint.paneId}`);
    expect(snapshot.resources.retained).toContain(`endpoint:${endpoint.paneId}`);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain("reservation:r1");
    expect(snapshot.trace.some((event) => event.action === "tern close")).toBe(false);
    await terminal.interrupt({ endpoint, cwd: world.repoPath });
    await terminal.close({ endpoint, cwd: world.repoPath });
    expect(world.paneIsPresent(endpoint.paneId)).toBe(false);
    expect(world.trace().some((event) => event.action === "tern kill")).toBe(true);
  });
});
