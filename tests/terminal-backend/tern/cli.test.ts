import { expect, test } from "bun:test";
import { writeCoordinatorQuarantineRecord } from "../../../src/coordinator/quarantine.ts";
import { ternEndpoint } from "../../../src/terminal-backend/identity.ts";
import { ternCli } from "../../../src/terminal-backend/tern/cli.ts";
import {
  TernOutcomeUnknownError,
  TernQuarantinedError,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { listTernQuarantine } from "../../../src/terminal-backend/tern/quarantine.ts";
import { withScenario } from "../../evals/scenario.ts";

test("a coordinator quarantine note refuses every effect on that coordinator before Tern runs", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const coordinator = ternEndpoint({
      ...world.openPane({ paneId: "42", cwd: world.repoPath }),
      role: "coordinator",
    });
    const worktree = await world.grantLease({ name: "coordinator", holder: "coordinator" });
    await writeCoordinatorQuarantineRecord(world.home, {
      schemaVersion: 1,
      quarantineId: "note",
      quarantinedAt: "2026-10-07T00:00:00.000Z",
      stage: "replacement",
      repoPath: world.repoPath,
      sessionId: world.sessionId,
      reason: "view retirement outcome is unknown",
      lease: worktree,
      endpoint: coordinator,
    });
    const cli = ternCli(world.run, { ...world.tern, home: world.home });
    const target = { endpoint: coordinator, cwd: world.repoPath };
    await expect(
      cli.mutate({ ...target, verb: "run", line: { command: ["true"] } }),
    ).rejects.toBeInstanceOf(TernQuarantinedError);
    await expect(cli.mutate({ ...target, verb: "close", force: true })).rejects.toBeInstanceOf(
      TernQuarantinedError,
    );
    expect(world.trace().some((event) => ["tern run", "tern close"].includes(event.action))).toBe(
      false,
    );
    expect(world.paneIsPresent(coordinator.paneId)).toBe(true);
  });
});

test("an uncertain focus is not quarantined because repeating it converges", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "43", cwd: world.repoPath }));
    world.failAt({ boundary: "tern", action: "tern focus" });
    const target = { endpoint, cwd: world.repoPath };
    await expect(
      ternCli(world.run, { ...world.tern, home: world.home }).mutate({ ...target, verb: "focus" }),
    ).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    await ternCli(world.run, { ...world.tern, home: world.home }).mutate({
      ...target,
      verb: "focus",
    });
    await ternCli(world.run, { ...world.tern, home: world.home }).mutate({
      ...target,
      verb: "send",
      input: { keys: ["ctrl+c"] },
    });
    expect(world.trace().filter((event) => event.action === "tern send")).toHaveLength(1);
  });
});

test("scoping a Tern CLI binds its pane quarantine to that home and keeps its clock", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = ternEndpoint(world.openPane({ paneId: "44", cwd: world.repoPath }));
    const cli = ternCli(world.run, { ...world.tern, clock: () => 1_700_000_000_000 });
    const scoped = cli.scope({ home: world.home });
    const op = {
      verb: "send",
      endpoint,
      cwd: world.repoPath,
      input: { keys: ["ctrl+c"] },
    } as const;
    world.failAt({ boundary: "tern", action: "tern send" });
    await expect(scoped.mutate(op)).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    expect(await listTernQuarantine(world.home)).toEqual([
      expect.objectContaining({ at: "2023-11-14T22:13:20.000Z", endpoint }),
    ]);
    await cli.mutate(op);
    await expect(scoped.unscoped().mutate(op)).rejects.toBeInstanceOf(TernQuarantinedError);
  });
});
