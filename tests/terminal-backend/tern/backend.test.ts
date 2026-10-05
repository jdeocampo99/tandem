import { expect, test } from "bun:test";
import { EndpointOwnershipError } from "../../../src/adapters/primitives.ts";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
import { assertStoppedCoordinatorShell } from "../../../src/coordinator/ownership.ts";
import { recordPath } from "../../../src/coordinator/record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "../../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../../src/harness/contract.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import {
  Created,
  decode,
  TernOutcomeUnknownError,
  TernUnsupportedOperationError,
} from "../../../src/terminal-backend/tern/protocol.ts";
import {
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "../../evals/scenario.ts";

test("Tern port pins identity and observable outcomes through a pane lifecycle", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const calls: CommandRequest[] = [];
    const terminal = ternBackend(async (request) => {
      calls.push(request);
      return world.run(request);
    });
    const session = { sessionId: world.sessionId, cwd: world.repoPath };
    const root = await terminal.createWorkspace({
      ...session,
      label: "coordinator",
      role: "coordinator",
      generation: 2,
    });
    const target = { endpoint: root.endpoint, cwd: world.repoPath };
    expect(root.endpoint.role).toBe("coordinator");
    expect(root.endpoint.generation).toBe(2);
    expect(root.endpoint.workspaceId).toBe(root.endpoint.tabId);
    expect((await terminal.inspect(target)).activeWorker).toBe(false);
    expect(await terminal.interrupt(target)).toEqual({ wasRunning: false });
    await terminal.renameWorkspace({
      ...session,
      workspaceId: root.endpoint.workspaceId,
      label: "renamed",
    });
    expect(
      await terminal.workspaceLabel({ ...session, workspaceId: root.endpoint.workspaceId }),
    ).toBe("renamed");
    expect(
      await terminal.focusWorkspace({ ...session, workspaceId: root.endpoint.workspaceId }),
    ).toEqual({ focused: true });
    const split = await terminal.splitBeside({
      anchor: root.endpoint,
      cwd: world.repoPath,
      role: "scout",
      generation: 3,
    });
    expect(split.workspaceId).toBe(root.endpoint.workspaceId);
    expect(split.paneId).not.toBe(root.endpoint.paneId);
    await terminal.promptAgent({ ...session, paneId: split.paneId, text: "hello" });
    await terminal.sendKeys({ endpoint: split, cwd: world.repoPath, keys: ["ctrl+c"] });
    await terminal.runCommand({
      endpoint: split,
      cwd: world.repoPath,
      command: ["printf", "literal ' $HOME"],
      env: { TEST_VALUE: "space ' quote" },
    });
    const worker = await terminal.createWorkspace({
      ...session,
      parentWorkspaceId: root.endpoint.workspaceId,
      label: "worker",
      role: "implementer",
      generation: 4,
    });
    expect(worker.warnings[0]).toContain("cannot reorder");
    expect(
      await terminal.listPanes({
        ...session,
        workspaceId: worker.endpoint.workspaceId,
        complete: true,
      }),
    ).toHaveLength(1);
    expect(await terminal.snapshot(session)).toHaveLength(3);
    expect(await terminal.listWorkspaces({ ...session, complete: true })).toHaveLength(2);
    expect(
      (
        await terminal.fitPanel({
          ...session,
          paneId: root.endpoint.paneId,
          columns: 46,
          fittedWidth: 120,
        })
      ).warnings[0],
    ).toContain("cannot resize");
    await expect(
      terminal.openPanel({
        coordinator: root.endpoint,
        cwd: world.repoPath,
        project: world.repoPath,
      }),
    ).rejects.toBeInstanceOf(TernUnsupportedOperationError);
    await terminal.closeOwned({ endpoint: split, cwd: world.repoPath, strictProof: true });
    await terminal.close({ endpoint: worker.endpoint, cwd: world.repoPath });
    await terminal.close(target);
    expect(await terminal.listPanes(session)).toEqual([]);
    expect(world.trace().filter((event) => event.action === "tern kill")).toHaveLength(1);
    const mutations = new Set(["new", "rename", "focus", "split", "run", "send", "close", "kill"]);
    for (let i = 0; i < calls.length; i += 1)
      if (mutations.has(calls[i]?.argv[1] ?? "")) expect(calls[i - 1]?.argv[1]).toBe("ls");
  });
});

test("a relaunched backend reuses the exact session from durable coordinator, task and runtime records", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      return world.run(request);
    };
    const target = {
      sessionId: world.sessionId,
      cwd: world.repoPath,
      label: "coordinator",
      role: "coordinator" as const,
      generation: 0,
    };
    const first = await ternBackend(run).createWorkspace(target);
    const worktree = await world.grantLease({ name: "coordinator", holder: "coordinator" });
    await saveCoordinatorRecord(world.home, {
      schemaVersion: 1,
      repoPath: world.repoPath,
      endpoint: first.endpoint,
      worktree,
      command: ["omp"],
      harness: DEFAULT_HARNESS,
    });
    await seedScenarioTask(world, {
      kind: "implementation",
      endpoints: [first.endpoint],
      stage: "paused",
    });
    await seedScenarioRuntime(world, scenarioRuntimeTask({ endpoints: [first.endpoint] }));
    const snapshot = await world.snapshot();
    expect(snapshot.tasks[0]?.endpoints?.[0]?.terminalSessionId).toBe(
      first.endpoint.terminalSessionId,
    );
    expect(snapshot.runtime.tasks[0]?.endpoints[0]?.terminalSessionId).toBe(
      first.endpoint.terminalSessionId,
    );
    const recorded = await readCoordinatorRecord(
      recordPath(world.home, world.sessionId, world.repoPath),
    );
    if (recorded === undefined) throw new Error("missing durable coordinator");
    expect(recorded.endpoint.terminalSessionId).toBe(first.endpoint.terminalSessionId);
    // An empty native session may survive terminal restoration or Tern's acknowledged last close.
    world.removePane(first.endpoint.paneId);
    const relaunched = await ternBackend(run).createWorkspace({
      ...target,
      previousEndpoint: recorded.endpoint,
    });
    expect(relaunched.endpoint.terminalSessionId).toBe(recorded.endpoint.terminalSessionId);
    expect(relaunched.endpoint.paneId).not.toBe(recorded.endpoint.paneId);
    const nativeCreates = calls.filter((request) => request.argv[1] === "new");
    expect(nativeCreates.map((request) => request.argv[2])).toEqual(["session", "tab"]);
    const index = calls.findLastIndex((request) => request.argv[1] === "new");
    expect(calls[index - 1]?.argv[1]).toBe("ls");
    expect(calls[index]?.argv[3]).toBe(recorded.endpoint.terminalSessionId);
  });
});

test("an absent stored session creates a new session without adopting a matching name", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const calls: CommandRequest[] = [];
    const run: CommandRunner = async (request) => {
      calls.push(request);
      return world.run(request);
    };
    const target = {
      sessionId: world.sessionId,
      cwd: world.repoPath,
      label: "coordinator",
      role: "coordinator" as const,
      generation: 0,
    };
    const first = await ternBackend(run).createWorkspace(target);
    const name = calls.find((request) => request.argv[1] === "new")?.argv[3];
    if (name === undefined) throw new Error("missing native session name");
    await ternBackend(run).close({ endpoint: first.endpoint, cwd: world.repoPath });
    const impostor = decode(
      (
        await world.run({
          argv: ["tern", "new", "session", name, "--cwd", world.repoPath, "--json"],
          cwd: world.repoPath,
        })
      ).stdout,
      Created,
      "test session",
    );
    const relaunched = await ternBackend(run).createWorkspace({
      ...target,
      previousEndpoint: first.endpoint,
    });
    expect(relaunched.endpoint.terminalSessionId).not.toBe(first.endpoint.terminalSessionId);
    expect(relaunched.endpoint.terminalSessionId).not.toBe(impostor.session);
    expect(
      calls.filter((request) => request.argv[1] === "new").map((request) => request.argv[2]),
    ).toEqual(["session", "session"]);
    expect(world.paneIsPresent(impostor.block)).toBe(true);
  });
});

test("notifications require the injected durable endpoint even after a backend created a coordinator", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const session = { sessionId: world.sessionId, cwd: world.repoPath };
    const terminal = ternBackend(world.run);
    const created = await terminal.createWorkspace({
      ...session,
      label: "coordinator",
      role: "coordinator",
      generation: 0,
    });
    const alert = { ...session, title: "Done", body: "Task complete" };
    await expect(terminal.notify(alert)).rejects.toThrow("recorded Tandem-owned pane");
    world.removePane(created.endpoint.paneId);
    await expect(
      ternBackend(world.run, { notificationEndpoint: async () => created.endpoint }).notify(alert),
    ).rejects.toBeInstanceOf(EndpointOwnershipError);
    expect(world.trace().some((event) => event.action === "tern close")).toBe(false);
  });
});

test("wrong block acknowledgement quarantines resources and prevents blind retries", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "90071992547409933", cwd: world.repoPath });
    let writes = 0;
    const run: CommandRunner = async (request) => {
      const result = await world.run(request);
      if (request.argv[1] === "send") {
        writes += 1;
        return { ...result, stdout: '{"block":90071992547409934}' };
      }
      return result;
    };
    const terminal = ternBackend(run);
    const target = { endpoint, cwd: world.repoPath, keys: ["ctrl+c"] };
    await expect(terminal.sendKeys(target)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    await expect(terminal.sendKeys(target)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    await expect(terminal.close({ endpoint, cwd: world.repoPath })).rejects.toBeInstanceOf(
      TernOutcomeUnknownError,
    );
    expect(writes).toBe(1);
    expect(world.paneIsPresent(endpoint.paneId)).toBe(true);
  });
});

test("u64 identity parsing preserves exact ids and refuses a changed tab or native session", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "18446744073709551614", cwd: world.repoPath });
    const run: CommandRunner = async (request) => {
      if (request.argv[0]?.endsWith("/tern"))
        expect(request.argv.slice(-3)).toEqual(["--window", "owned-window", "--json"]);
      const result = await world.run(request);
      return {
        ...result,
        stdout: result.stdout.replace(
          /("(?:id|pane)":)"18446744073709551614"/gu,
          "$118446744073709551614",
        ),
      };
    };
    const terminal = ternBackend(run, { windowKey: "owned-window" });
    expect((await terminal.inspect({ endpoint, cwd: world.repoPath })).pane.paneId).toBe(
      endpoint.paneId,
    );
    await expect(
      terminal.close({ endpoint: { ...endpoint, tabId: "999" }, cwd: world.repoPath }),
    ).rejects.toBeInstanceOf(EndpointOwnershipError);
    await expect(
      terminal.close({ endpoint: { ...endpoint, terminalSessionId: "999" }, cwd: world.repoPath }),
    ).rejects.toBeInstanceOf(EndpointOwnershipError);
    expect(world.paneIsPresent(endpoint.paneId)).toBe(true);
    expect(world.trace().some((event) => event.action === "tern close")).toBe(false);
  });
});

test("a failed mutation retains its pane and is never retried", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "42", cwd: world.repoPath });
    world.failAt({ boundary: "tern", action: "tern close" });
    const terminal = ternBackend(world.run);
    await expect(terminal.close({ endpoint, cwd: world.repoPath })).rejects.toBeInstanceOf(
      TernOutcomeUnknownError,
    );
    expect(world.paneIsPresent(endpoint.paneId)).toBe(true);
    await expect(terminal.close({ endpoint, cwd: world.repoPath })).rejects.toBeInstanceOf(
      TernOutcomeUnknownError,
    );
    expect(world.trace().filter((event) => event.action === "tern close")).toHaveLength(1);
  });
});

test("a foreground shell script is busy even though its process is named sh", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "43", cwd: world.repoPath });
    world.replaceForeground(endpoint.paneId, ["sh", "/work/long-running-script.sh"]);
    const terminal = ternBackend(world.run);
    expect((await terminal.inspect({ endpoint, cwd: world.repoPath })).activeWorker).toBe(true);
    await expect(terminal.close({ endpoint, cwd: world.repoPath })).rejects.toThrow(
      "active foreground worker",
    );
    expect(world.paneIsPresent(endpoint.paneId)).toBe(true);
  });
});

test("a stopped daemon is reported as stopped without treating an ambiguous failure as absence", async () => {
  const cwd = "/work/repo";
  const target = { sessionId: "tandem", cwd };
  const stopped = ternBackend(async () => ({
    code: 1,
    stdout: "",
    stderr:
      "tern ls: no Tern is running (no session daemon on /tmp/isolated.sock: No such file or directory); start Tern",
  }));
  expect(await stopped.sessionRunning(target)).toBe(false);
  expect(await stopped.snapshot({ ...target, allowMissingSession: true })).toEqual([]);
  const broken = ternBackend(async () => ({ code: 1, stdout: "", stderr: "permission denied" }));
  await expect(broken.sessionRunning(target)).rejects.toThrow("permission denied");
  await expect(broken.snapshot({ ...target, allowMissingSession: true })).rejects.toThrow(
    "permission denied",
  );
});

test("Tern's stopped coordinator bootstrap remains eligible for retirement with exact argv", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "44", cwd: world.repoPath });
    const digest = "a".repeat(16);
    world.replaceForeground(endpoint.paneId, [
      "sh",
      `${world.home}/coordinator-scripts/coordinator-${digest}-${digest}-${digest}.sh`,
    ]);
    const inspection = await ternBackend(world.run).inspect({ endpoint, cwd: world.repoPath });
    expect(inspection.activeWorker).toBe(true);
    expect(() => assertStoppedCoordinatorShell(inspection)).not.toThrow();
  });
});

test("detached blocks never turn an unknown pane placement into absence proof", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "45", cwd: world.repoPath });
    world.removePane(endpoint.paneId);
    const terminal = ternBackend(async (request) => {
      const result = await world.run(request);
      return request.argv[1] === "ls"
        ? { ...result, stdout: result.stdout.replace('"detached":[]', '"detached":[{}]') }
        : result;
    });
    try {
      await terminal.close({ endpoint, cwd: world.repoPath });
      throw new Error("absence incorrectly accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(EndpointOwnershipError);
      expect(terminal.isPaneGone(error)).toBe(false);
    }
    expect(world.trace().some((event) => event.action === "tern close")).toBe(false);
  });
});
