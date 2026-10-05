import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EndpointBusyError } from "../../src/adapters/primitives.ts";
import type { CommandRequest, CommandRunner } from "../../src/contracts.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
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
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const terminal = terminalBackend(world.run, { home: world.home });

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
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const terminal = terminalBackend(world.run, { home: world.home });

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

test("relaunch reuses its durable exact-id empty session after acknowledged cleanup", async () => {
  await withScenario({ terminal: "tern", retainEmptyTernSessions: true }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      return world.run(request);
    };
    const terminal = terminalBackend(run, { home: world.home });
    const target = {
      sessionId: world.sessionId,
      cwd: world.repoPath,
      label: "coordinator",
      role: "coordinator" as const,
      generation: 0,
    };
    const first = await terminal.createWorkspace(target);
    const worktree = await world.grantLease({ name: "coordinator", holder: "coordinator" });
    await saveCoordinatorRecord(world.home, {
      schemaVersion: 1,
      repoPath: world.repoPath,
      endpoint: first.endpoint,
      worktree,
      command: ["omp"],
      harness: DEFAULT_HARNESS,
    });
    await terminal.close({ endpoint: first.endpoint, cwd: world.repoPath });
    await terminal.close({ endpoint: first.endpoint, cwd: world.repoPath });
    expect(await terminal.listWorkspaces(target)).toEqual([]);
    expect(world.trace().filter((event) => event.action === "tern kill")).toHaveLength(1);
    const recorded = await readCoordinatorRecord(
      recordPath(world.home, world.sessionId, world.repoPath),
    );
    if (recorded === undefined) throw new Error("missing durable coordinator");
    const relaunched = await terminalBackend(run, { home: world.home }).createWorkspace({
      ...target,
      previousEndpoint: recorded.endpoint,
    });
    expect(relaunched.endpoint.terminalSessionId).toBe(recorded.endpoint.terminalSessionId);
    expect(relaunched.endpoint.paneId).not.toBe(recorded.endpoint.paneId);
    expect(relaunched.endpoint.notificationPane?.paneId).not.toBe(
      recorded.endpoint.notificationPane?.paneId,
    );
    const creates = calls.filter((request) => request.argv[1] === "new");
    expect(creates.map((event) => event.argv[2])).toEqual(["session", "tab", "tab", "tab"]);
    const relaunchIndex = calls.findLastIndex(
      (event) => event.argv[1] === "new" && event.argv[3] === recorded.endpoint.terminalSessionId,
    );
    expect(calls[relaunchIndex - 1]?.argv[1]).toBe("ls");
    expect((await world.snapshot()).resources.retained).toContain("lease:lease-1");
  });
});

test("an unowned session with the project name gets a unique suffix and is never adopted", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    await writeFile(join(world.home, "settings.toml"), 'terminal = "tern"\n');
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      return world.run(request);
    };
    const terminal = terminalBackend(run, { home: world.home });
    const target = {
      sessionId: world.sessionId,
      cwd: world.repoPath,
      label: "coordinator",
      role: "coordinator" as const,
      generation: 0,
    };
    const first = await terminal.createWorkspace(target);
    const name = calls.find((request) => request.argv[1] === "new")?.argv[3];
    if (name === undefined) throw new Error("missing native project label");
    await terminal.close({ endpoint: first.endpoint, cwd: world.repoPath });
    // This external pane has no Tandem ownership record. The fake keeps native JSON at its boundary.
    await world.run({
      argv: ["tern", "new", "session", name, "--cwd", world.repoPath, "--json"],
      cwd: world.repoPath,
    });
    const unrelated = await terminal.snapshot(target);
    expect(unrelated).toHaveLength(1);
    const before = calls.length;
    const relaunched = await terminalBackend(run, { home: world.home }).createWorkspace({
      ...target,
      previousEndpoint: first.endpoint,
    });
    expect(relaunched.endpoint.terminalSessionId).not.toBe(first.endpoint.terminalSessionId);
    const creates = calls.slice(before).filter((request) => request.argv[1] === "new");
    expect(creates[0]?.argv.slice(1, 4)).toEqual(["new", "session", `${name}-1`]);
    const final = await terminal.snapshot(target);
    expect(final).toHaveLength(3);
    for (const pane of unrelated) {
      expect(world.paneIsPresent(pane.paneId)).toBe(true);
      expect(relaunched.endpoint.paneId).not.toBe(pane.paneId);
      expect(final).toContainEqual(pane);
    }
  });
});
