import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../../../src/contracts.ts";
import { reconcileTandemResources } from "../../../src/coordinator/reconcile.ts";
import { ternBackend } from "../../../src/terminal-backend/tern/backend.ts";
import {
  TernOutcomeUnknownError,
  TernQuarantinedError,
} from "../../../src/terminal-backend/tern/protocol.ts";
import { type ScenarioWorld, withScenario } from "../../evals/scenario.ts";

/** A Tern whose first `send` acknowledges another block, so its outcome is unknown. */
function lostAcknowledgement(world: ScenarioWorld): CommandRunner {
  let sends = 0;
  return async (request) => {
    const result = await world.run(request);
    if (request.argv[1] === "send" && sends++ === 0) return { ...result, stdout: '{"block":"99"}' };
    return result;
  };
}

const fix = (world: ScenarioWorld, run: CommandRunner, apply: boolean) =>
  reconcileTandemResources({
    run: async () => ({ code: 1, stdout: "", stderr: "unexpected" }),
    terminal: ternBackend(run, { ...world.tern, home: world.home }),
    home: world.home,
    poolRoot: join(world.home, "pool"),
    repoPaths: [],
    apply,
  });

const records = async (world: ScenarioWorld) =>
  (await readdir(join(world.home, "tern-quarantine")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  );

test("tandem fix lists a quarantined pane, keeps it while busy, and clears it once the pane is gone", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "42", cwd: world.repoPath });
    const run = lostAcknowledgement(world);
    const target = { endpoint, cwd: world.repoPath, keys: ["ctrl+c"] };
    await expect(
      ternBackend(run, { ...world.tern, home: world.home }).sendKeys(target),
    ).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    await expect(
      ternBackend(run, { ...world.tern, home: world.home }).sendKeys(target),
    ).rejects.toBeInstanceOf(TernQuarantinedError);

    world.replaceForeground(endpoint.paneId, ["omp", "--mode", "worker"]);
    const busy = await fix(world, run, true);
    expect(busy.retained).toEqual([
      expect.objectContaining({
        kind: "tern-quarantine",
        sessionId: world.sessionId,
        reason: expect.stringContaining("kept because the pane is still running something"),
      }),
    ]);
    expect(await records(world)).toHaveLength(1);

    world.removePane(endpoint.paneId);
    const planned = await fix(world, run, false);
    expect(planned.cleaned).toEqual([
      expect.objectContaining({
        kind: "tern-quarantine",
        reason: expect.stringMatching(
          /^tern send on pane:\d*:42 at \S+ has an unknown outcome \(acknowledgement names another block\); the pane is gone/u,
        ),
      }),
    ]);
    expect(await records(world)).toHaveLength(1);
    const applied = await fix(world, run, true);
    expect(applied.cleaned.map((entry) => entry.kind)).toEqual(["tern-quarantine"]);
    expect(await records(world)).toEqual([]);

    await ternBackend(run, { ...world.tern, home: world.home }).close({
      endpoint,
      cwd: world.repoPath,
    });
    expect(world.trace().some((event) => event.action === "tern close")).toBe(false);
  });
});

test("closing a quarantined pane proven absent succeeds and drops its record", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "43", cwd: world.repoPath });
    const run = lostAcknowledgement(world);
    await expect(
      ternBackend(run, { ...world.tern, home: world.home }).sendKeys({
        endpoint,
        cwd: world.repoPath,
        keys: ["ctrl+c"],
      }),
    ).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    world.removePane(endpoint.paneId);
    await ternBackend(run, { ...world.tern, home: world.home }).close({
      endpoint,
      cwd: world.repoPath,
    });
    expect(await records(world)).toEqual([]);
  });
});

test("tandem fix clears the record of an idle pane and keeps the pane", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const endpoint = world.openPane({ paneId: "44", cwd: world.repoPath });
    const run = lostAcknowledgement(world);
    const target = { endpoint, cwd: world.repoPath, keys: ["ctrl+c"] };
    await expect(
      ternBackend(run, { ...world.tern, home: world.home }).sendKeys(target),
    ).rejects.toBeInstanceOf(TernOutcomeUnknownError);
    const applied = await fix(world, run, true);
    expect(applied.cleaned.map((entry) => entry.kind)).toEqual(["tern-quarantine"]);
    expect(world.paneIsPresent(endpoint.paneId)).toBe(true);
    await ternBackend(run, { ...world.tern, home: world.home }).sendKeys(target);
    expect(world.trace().filter((event) => event.action === "tern send")).toHaveLength(2);
  });
});
